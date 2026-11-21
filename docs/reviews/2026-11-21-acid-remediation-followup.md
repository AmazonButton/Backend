# Review tiếp nhận bản vá ACID F1–F5

Ngày: 2026-11-21. Đối tượng: working tree `feat/system-staff-role-transition`, gồm các bản vá người dùng vừa báo cáo. Đây là review tiếp nối [audit gốc](2026-11-21-acid-orders-payments-audit.md), không thay đổi kết quả lịch sử của lần audit trước.

## Kết luận

Các kịch bản regression hiện có đã xanh trên DB test. F1/F3/F4/F5 có thay đổi đúng hướng trong implementation; riêng **F2 chưa thể đóng hoàn toàn** vì hai lỗi trong quy trình hoàn khoản dư đã tái hiện trên PostgreSQL thật. Ngoài ra, test L3 chưa kiểm chứng độc lập hàm CAS mới.

Không sửa source nghiệp vụ, test hoặc migration trong lần review này. Chỉ bổ sung báo cáo và context. Không tác động Production hoặc chuyển tiền thật.

## R1 — [P1] API có thể đóng nghĩa vụ hoàn khoản dư khi chưa có bằng chứng hoàn tiền

- API: `POST /api/v1/payments/transactions/:id/refund-excess`.
- [DTO](../../src/payments/dto/refund-excess-payment.dto.ts): `refundReference` và `adminNote` đều optional.
- [Service](../../src/payments/payments.service.ts), dòng 617–647: cho STORE_OWNER cùng store gọi; reference chỉ được ghép vào note. Không có bước dispatch hoặc xác thực giao dịch hoàn tiền.
- [Repository](../../src/payments/payments.repository.ts), dòng 759–774: chỉ cần payment REFUND_PENDING và còn sibling PAID rồi ghi ngay REFUNDED.

**Diagnostic trên DB test:** tạo order PAID, một payment PAID và một payment dư REFUND_PENDING; gọi service với DTO `{}` và actor STORE_OWNER đúng store. Kết quả thực tế:

```json
{"success":true,"status":"REFUNDED","orderStatus":"PAID"}
```

Service/repository thật đã chạy, không có provider payout hay xác thực receipt hoàn tiền. Diagnostic này không gọi HTTP; controller có RolesGuard cho phép chính role STORE_OWNER nên ranh giới role không chặn trường hợp này.

**Tác động:** hệ thống báo đã hoàn tất và xóa nghĩa vụ đang chờ, dù chưa có bằng chứng khách nhận lại tiền. Việc giữ nguyên payment PAID của đơn là đúng nhưng chưa đủ để xác nhận khoản dư đã hoàn.

**Cần sửa:** tách yêu cầu/xét duyệt hoàn với xác nhận chi thành công. Chỉ ghi REFUNDED khi có chứng từ hoàn đã xác thực, khớp khoản tiền, người nhận và định danh payout/refund; xử lý trạng thái chưa rõ bằng đối soát. STORE_OWNER không nên tự xác nhận một khoản tiền nền tảng đang giữ đã chi xong. Nếu đây chỉ là chức năng ghi nhận hoàn thủ công, cần contract rõ, quyền tài chính phù hợp và bước xác minh chứng từ; một chuỗi reference tùy ý không phải bằng chứng ngân hàng.

## R2 — [P1] Hoàn đơn chính trước làm khoản dư bị kẹt

- [refundExcessTransactionAtomicTx](../../src/payments/payments.repository.ts), dòng 759–769: bắt buộc còn sibling có status PAID.
- [refundOrderAtomicTx](../../src/orders/orders.repository.ts), dòng 937 và 963–978: hoàn payment PAID trước, giữ các khoản dư REFUND_PENDING; khi order đã REFUNDED, lần gọi lại trả về sớm.

**Diagnostic trên PostgreSQL thật:**

1. Order PAID có payment A PAID và payment B dư REFUND_PENDING.
2. Gọi `cancelOrderAtomicTx` rồi `refundOrderAtomicTx`: order và A thành REFUNDED; B giữ REFUND_PENDING.
3. Gọi `refundExcessTransaction` cho B: bị từ chối vì không còn sibling PAID.
4. Gọi lại `refundOrderAtomicTx`: trả về sớm, B vẫn REFUND_PENDING.

Kết quả:

```json
{
  "orderStatus":"REFUNDED",
  "payments":[{"status":"REFUND_PENDING"},{"status":"REFUNDED"}],
  "excessRefundRejected":"Đơn hàng không có giao dịch PAID hợp lệ thay thế; vui lòng hoàn tiền toàn đơn qua /orders/:id/refund"
}
```

**Tác động:** cả hai API hoàn hiện tại không xử lý được nghĩa vụ B trong trạng thái này. Việc A đã hoàn không làm mất nghĩa vụ hoàn B.

**Cần sửa:** lưu phân loại khoản thu/obligation riêng tại thời điểm nhận tiền, liên kết khoản hoàn với receipt/payment cụ thể. Quyền xử lý B dựa trên nghĩa vụ B còn mở và bằng chứng nhận/hoàn của B, không dựa vào A hiện còn PAID hay không. Test cả hai thứ tự: hoàn dư trước → hoàn chính; hoàn chính trước → hoàn dư; thêm retry đồng thời để không hoàn B hai lần.

## C1 — [P2, khoảng trống kiểm thử] L3 chưa đi vào CAS mới

[L3 trong regression suite](../../tests/acid-audit-regressions-2026-11-21.spec.ts), dòng 194–238:

- Callback đọc snapshot cũ có `data.code='00'`, outer `code='99'`: bị từ chối bởi guard envelope mới trước khi gọi `markTransactionFailedIfPendingAtomicTx`.
- Callback signed failure bổ sung được gửi sau khi payment đã PAID: service trả `Already processed` trước khi gọi CAS.

Vì vậy L3 PASS xác nhận guard/envelope và early-return hoạt động; chưa chứng minh độc lập row lock/CAS chống stale FAILED write. Đây là thiếu coverage, không phải bằng chứng hàm CAS hiện tại sai.

**Cần thêm test:** gọi thẳng failure transition sau PAID/REFUND_PENDING/REFUNDED/CANCELLED, và dựng barrier cho failure path đã đọc PENDING trước khi success commit rồi tiếp tục tới chính helper CAS. Đồng thời kiểm tra PENDING thực sự có thể chuyển FAILED để tránh test luôn no-op.

L1b cũng mang tên có COD nhưng phần thân hiện chỉ kiểm tra các trạng thái tiến triển và CANCELLED; nên bổ sung COD, REJECTED, DELIVERY_FAILED, COMPLETED nếu muốn gọi là kiểm chứng toàn bộ ma trận F1.

## Những phần đã đối chiếu đúng hướng

- F1: ma trận payable PayOS ghi PAID và giữ orderStatus ở tiến trình hợp lệ, không chỉ xử lý PENDING.
- F3: helper khóa orders → payment_transaction, chỉ chuyển PENDING → FAILED; các chỗ update FAILED đã được định tuyến qua helper. Nhận xét coverage C1 vẫn áp dụng.
- F4: context idempotency truyền từ controller vào repository; advisory lock, request hash và unique checkout identity được lưu trong cùng transaction tạo order/giữ kho. Recovery trả order cũ và bỏ phát WS trùng. Interceptor không finalizeFailure khi finalizeSuccess lỗi sau khi handler emit.
- F5: PATCH khóa product → inventory và kiểm tra reserved sau khóa, có transaction retry và kiểm tra ownership store.
- F2: bảo toàn đơn đã được PAID bảo chứng và chặn hoàn toàn đơn PAID đã có tác dụng; phần thực thi/đóng nghĩa vụ hoàn dư cần xử lý R1–R2.

## Kiểm chứng trực tiếp trong lần review

| Kiểm tra | Kết quả |
| --- | --- |
| `node node_modules/typescript/bin/tsc --noEmit` | PASS, exit 0 |
| `npm run build` | PASS, exit 0 |
| `tests/acid-audit-regressions-2026-11-21.spec.ts --live` qua tsx, host test allowlisted | PASS, 10/10 |
| `tests/acid-wallet-order-inventory-hardening.spec.ts` qua tsx, host test allowlisted | PASS, 5/5 nhóm |
| `tests/phase2-idempotency-platform.spec.ts` qua tsx, host test allowlisted | PASS, 22/22 |
| `tests/audit-run6-payos-fixes.spec.ts` qua tsx | PASS, 20/20 |
| Hai diagnostic service/repository bổ sung | Tái hiện R1 và R2; không phải acceptance PASS |
| READ ONLY kiểm tra cleanup fixture của regression và diagnostic | Users = 0, stores = 0, idempotency rows = 0 |

Guard DB từ chối một lần gọi suite idempotency chưa có allowlist trước khi kết nối; lần chạy có allowlist ở bảng trên đã PASS. Diagnostic ban đầu thiếu trường bắt buộc của fixture, đã cleanup; diagnostic sửa fixture chạy hoàn tất và cho kết quả R1–R2 nêu trên.

Không chạy lại toàn bộ danh sách suite trong bản bàn giao của người dùng. Không xác nhận lại migration deploy bằng DDL. Giới hạn schema test thiếu stored procedure/trigger của nút bấm vẫn chưa được khắc phục trong review này; cần DB dựng từ đầy đủ migration để đóng phần đó.
