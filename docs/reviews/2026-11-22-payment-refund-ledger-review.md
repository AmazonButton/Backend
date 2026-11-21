# Review bản vá F2: receipt ledger, refund obligation và payout recovery

Ngày: **2026-11-22**. Đối tượng: working tree `feat/system-staff-role-transition`, gồm module hoàn tiền và migration `20261121235900_payment_receipt_refund_obligations` người dùng vừa bổ sung.

## Kết luận

Kiến trúc mới đã khắc phục các đường chốt tay cũ và bổ sung nhiều invariant quan trọng. Suite hardening mới PASS 9/9 và ACID regression PASS 10/10 trong lần review này. Tuy nhiên, **4 tình huống nối tiếp đã tái hiện lỗi trên PostgreSQL test**, gồm 3 P1 và 1 P2. Chưa nên chốt triển khai Production.

Không sửa implementation hoặc migration. Bổ sung [regression audit](../../tests/payment-refund-followup-2026-11-22.spec.ts), báo cáo này và handoff. Test mới cố ý giữ assertion theo hành vi đúng, hiện exit 1 và chưa đăng ký vào CI runner.

Toàn bộ kiểm thử dùng `smart_order_test` qua test DB guard/host allowlist, chữ ký webhook bằng checksum giả trong process và provider payout in-memory. Không gọi PayOS thật, không phát lệnh chi thật, không DDL/Production.

## N1 — [P1] Replay sau backfill bị tính thành khoản thu dư mới và đủ điều kiện chi hoàn

**Vị trí:**

- [migration.sql](../../prisma/migrations/20261121235900_payment_receipt_refund_obligations/migration.sql), dòng 303–342: PAID cũ được backfill với `channel='LEGACY_BACKFILL'`, `provider_transaction_ref='LEGACY_PT_' + paymentTransactionId`.
- [payments.repository.ts](../../src/payments/payments.repository.ts), dòng 197–229: khi payment đã PAID/REFUND_PENDING/REFUNDED, webhook reference chưa thấy trong `ORDER_PAYMENT_LINK` được ghi thành EXCESS_DUPLICATE.

**Tái hiện R1:** tạo fixture PAID cùng một receipt đúng hình dạng backfill 6a; gửi lại webhook hợp lệ của chính khoản thanh toán đầu tiên với reference ngân hàng thật của fixture. Không chạy lại migration hoặc DDL.

```json
{"receipts":2,"ledgerAmount":200000,"newObligations":1,"mockPayouts":1}
```

Đơn chỉ giả định có một khoản thu 100.000đ từ trước migration. Replay tạo thêm receipt 100.000đ và một nghĩa vụ READY_FOR_PAYOUT. Với bank VERIFIED khớp nguồn, service đã chi qua mock provider và đóng nghĩa vụ. Không có khoản chuyển thứ hai trong kịch bản.

**Tác động:** ngân sách hoàn bị phình vì cùng khoản tiền được biểu diễn bởi hai danh tính. Trigger bảo toàn vẫn PASS do nó tính theo ledger đã bị ghi trùng, không chứng minh được tiền thực nhận.

**Cần sửa:** đưa việc đối soát placeholder legacy với chứng từ thật thành bước bắt buộc. Khi chưa xác minh được reference mới là khoản thu độc lập với khoản backfill, giữ chờ đối soát, không tự tạo nghĩa vụ excess có thể chi. Khi đã xác minh qua dữ liệu provider, liên kết/merge nguồn một cách nguyên tử, không cộng cả placeholder và receipt thật vào ngân sách. Thêm test replay legacy rồi hủy đơn/hoàn chính để kiểm tra cả hai hướng.

## N2 — [P1] Snapshot PENDING trước khóa làm rơi khoản chuyển dư đến đồng thời

**Vị trí:** [payments.service.ts](../../src/payments/payments.service.ts), dòng 491 và 533–543.

`wasAlreadySettled` được tính từ transaction snapshot service đọc trước khi repository giữ khóa. Amount khác giá trị dự kiến bị từ chối ngay ở service nếu snapshot đó vẫn PENDING.

**Tái hiện R2:**

1. Webhook khoản dư 30.000đ đọc snapshot PENDING và được giữ tại barrier.
2. Webhook khoản chính 100.000đ chạy xong, commit payment PAID cùng receipt chính.
3. Cho webhook khoản dư tiếp tục: service vẫn dùng snapshot PENDING và trả `Amount mismatch`.

```json
{"success":false,"message":"Amount mismatch"}
```

Receipt 30.000đ không được ghi. Cùng webhook này được implementation cho phép nếu service đọc PAID sau bước 2; lỗi nằm ở lịch xen kẽ, không phải nội dung chữ ký.

**Cần sửa:** chỉ kiểm tra các điều kiện độc lập trạng thái ở service, như chữ ký/link/currency/amount nguyên dương. Quyết định khoản chính hay khoản dư và kiểm tra số tiền phụ thuộc trạng thái phải dựa trên lần đọc sau khóa trong transaction. Luôn lưu bằng chứng tiền nhận hợp lệ, không đánh đồng từ chối tất toán đơn với bỏ qua khoản thu.

## N3 — [P2] Lỗi tra cứu trước POST làm nghĩa vụ rơi vào đối soát mà không có lệnh để đối soát

**Vị trí:**

- [payment-refunds.service.ts](../../src/payments/payment-refunds.service.ts), dòng 254, 310–320, 372–407.
- [payment-refunds.repository.ts](../../src/payments/payment-refunds.repository.ts), `authorizeAttemptDispatchTx`, dòng 689–770.

Authorize chuyển PREPARING → DISPATCHING trước cả pre-dispatch GET. Nếu GET timeout, service chuyển PENDING_RECONCILIATION dù chưa từng gọi createPayout. Lần dispatch sau gặp RECOVER_PRIOR nên chỉ lookup; lookup rỗng vẫn quay lại PENDING_RECONCILIATION.

**Tái hiện R3:** GET đầu tiên ném lỗi giả; mọi GET sau đều khỏe và trả danh sách rỗng. Gọi lại cùng attempt/reference:

```json
{"status":"PENDING_RECONCILIATION","mockPayouts":0,"attemptStatus":"PENDING_RECONCILIATION"}
```

**Tác động:** đường phục hồi tự động không thể hoàn nghĩa vụ khi chưa có POST nào được gửi. Claim mới bị chặn do còn active attempt; sync chỉ truy vấn một lệnh chưa tồn tại.

**Cần sửa:** phân biệt chắc chắn chưa gọi POST với có thể đã gọi POST. Lỗi lookup trước send cần giữ khả năng retry preflight/dispatch cùng attempt một cách có lease/CAS. Chỉ chuyển trạng thái “có thể đã gửi” ở ranh giới thực sự chuẩn bị POST. Sau một POST có kết quả chưa rõ vẫn phải giữ nguyên reference và đối soát; không dùng lỗi này làm lý do gửi một reference mới.

## N4 — [P1] Source CONFLICTING sau claim không chặn payout dù chưa dispatch

**Vị trí:**

- [payment-refunds.repository.ts](../../src/payments/payment-refunds.repository.ts), dòng 343–365: phát hiện replay mâu thuẫn nhưng chỉ quarantine obligation chưa snapshot-lock.
- Cùng file, `authorizeAttemptDispatchTx`, dòng 689–770: kiểm tra snapshot có tồn tại, không đọc lại receipt/source conflict.
- [payment-refunds.service.ts](../../src/payments/payment-refunds.service.ts), `dispatchClaimedAttempt`, dòng 253 trở đi.

**Tái hiện R4:** tạo receipt dư có nguồn khớp → claim và snapshot-lock nhưng chưa dispatch → nhận replay đã ký với cùng bank reference nhưng nguồn mâu thuẫn → xác nhận DB receipt đã CONFLICTING → gọi dispatch.

```json
{"evidence":"CONFLICTING","status":"REFUNDED","mockPayouts":1}
```

**Tác động:** tiêu chí giữ nguồn mâu thuẫn chờ xác minh chỉ được áp dụng trước claim. Nếu conflict được biết sau claim nhưng trước dispatch, hệ thống vẫn chi tự động và tất toán.

**Cần sửa:** trong pre-dispatch authorization, khóa/đọc lại receipt theo thứ tự khóa thống nhất; chặn nguồn CONFLICTING hoặc nghĩa vụ đã bị quarantine trước khi cho phép POST. Không cần đổi snapshot để chặn chi. Nếu conflict chỉ được phát hiện khi POST đã có thể gửi, phải giữ attempt để đối soát, không mở một lần chi khác.

## Những phần có bằng chứng đã hoạt động

- SUPER_ADMIN-only trên đường tài chính; repository chốt tay cũ bị vô hiệu.
- Guest và nguồn thiếu/che/chưa map được giữ chờ xác minh ở lúc tạo/claim nghĩa vụ.
- Khoản dư và khoản chính không còn phụ thuộc paidSibling tại thời điểm hoàn; hai thứ tự trong suite hiện hữu PASS.
- Có attempt, outbox, reference ổn định, kiểm chứng payout detail và voucher uniqueness.
- Outbox consumer rental loại trừ PAYMENT_REFUND_PAYOUT.
- CAS failure và ma trận F1 đã được mở rộng trong ACID regression.

Những điểm này không thay thế kiểm tra receipt provenance/backfill, TOCTOU trước khóa, preflight recovery và conflict xuất hiện sau claim.

## Kiểm chứng hiện tại

| Lệnh | Kết quả |
| --- | --- |
| `node node_modules/tsx/dist/cli.mjs tests/payment-refund-obligations-hardening.spec.ts` | PASS, 9/9, PostgreSQL test + provider mock |
| `node node_modules/tsx/dist/cli.mjs tests/acid-audit-regressions-2026-11-21.spec.ts --live` | PASS, 10/10 |
| `node node_modules/tsx/dist/cli.mjs tests/payment-refund-followup-2026-11-22.spec.ts` | Expected FAIL, exit 1, 0 pass / 4 fail; mỗi ca đi tới assertion nghiệp vụ và ghi nhận kết quả nêu trên |
| `node node_modules/typescript/bin/tsc --noEmit` sau khi thêm test | PASS, exit 0 |
| `npm run build` sau khi thêm test | PASS, exit 0 |
| READ ONLY kiểm tra fixture của test nối tiếp | Users/stores/orders/receipts/obligations/vouchers/outbox đều 0 |

Hai suite DB phải chạy với host test được allowlist trong `TEST_DB_ALLOWED_HOSTS`; test nối tiếp cũng áp dụng guard như vậy. Không bypass guard, không in connection string/secret. Các checksum và dữ liệu ngân hàng trong fixture là giả.

Không chạy lại toàn bộ suite được liệt kê trong báo cáo người dùng; không thử PayOS thật, database failover hoặc Production migration. Báo cáo này không đưa ra kết luận mới về bố cục GUI draw.io. Ưu tiên xử lý N1, N2, N4 rồi hoàn thiện recovery N3 trước khi nghiệm thu F2.
