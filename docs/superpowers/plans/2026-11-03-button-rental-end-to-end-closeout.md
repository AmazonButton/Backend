# Kế hoạch đóng tính năng thuê nút từ đầu đến cuối

Ngày: 2026-11-03. Trạng thái: **ĐÃ TRIỂN KHAI BỔ SUNG SOURCE/REGRESSION; CHƯA ĐÓNG R7 POSTGRESQL/LIVE**.

Tài liệu này là checklist thực thi/đóng lỗi tiếp theo cho kế hoạch cash collection ngày 2026-11-02.
Không thay thế lịch sử kiểm chứng, không tuyên bố runtime hoặc PostgreSQL acceptance đã hoàn thành.
Các checkbox bên dưới giữ nguyên như checklist nghiệm thu; không suy ra đã đạt nếu chưa có bằng chứng tương ứng.
Kết quả thực hiện mới nhất: `2026-11-03-rental-closeout-verification.md`. Các pass offline/HTTP fixture không thay thế PostgreSQL/provider acceptance.

## 0. Mục tiêu và giới hạn

Hoàn thiện một chuỗi thống nhất:
tạo rental + charge → thanh toán online hoặc cash offset → nhận đủ thiết bị → sử dụng/gia hạn → hết hạn/điều chỉnh quyền → trả từng nút → hoàn đủ cọc bằng payout đã đối soát.

- Không viết lại toàn bộ module hoặc tiếp tục vòng brainstorm nghiệp vụ.
- Giữ code/migration hiện có nếu đúng; thêm migration tiến tới khi cần. Không sửa migration đã áp dụng.
- Giá chuẩn đã thống nhất: 30.000đ/nút/tháng, cọc 200.000đ/nút. Một tháng thuê là 30 ngày theo code hiện tại; bắt đầu tại bàn giao, không phải lúc tạo hợp đồng.
- Store thu tiền mặt thì bị trừ số dư KHẢ DỤNG; tiền cọc/phí thuê thuộc Platform. Không trừ frozenBalance lần nữa.
- Store thu hộ, Store giữ nút vật lý và Store nhận đơn mua hàng là các vai trò khác nhau; không tự ghi đè các liên kết này.
- Admin được điều chỉnh quyền sử dụng có lý do/audit, không cần tạo thanh toán giả. Không tạo tiền cọc hoặc doanh thu giả.
- Không thêm PIN v2, không làm lại toàn bộ subscription 60k, không mở chuyển khoản thủ công để bỏ qua provider.
- Khoản PayOS chuyển thừa đi vào nghĩa vụ PENDING_RECONCILIATION. V1 chưa giải ngân tự động khoản này: không coi tài khoản VERIFIED của người thuê là bằng chứng nhận tiền của người thanh toán hộ.
- Hoàn cọc thuê nút là luồng khác: nhận lại thiết bị → duyệt snapshot tài khoản hợp lệ → payout → xác minh provider → REFUNDED.
- Không tự bật cờ, chạy migration production, giao dịch tiền thật, commit/push hoặc deploy trong bước lập kế hoạch.

## 1. Baseline cần giữ, không mở lại tùy ý

Source hiện có 4 model cash/receipt/overpayment, token helper, StoreCashModule, shared initial settlement, shared handover,
HTTP endpoints, expiry cron, rental returns, deposit payout verifier và outbox worker.

Các lỗi trước đã có sửa ở source: userId → CustomerProfile.customerId, bỏ charge.customer_id không tồn tại,
destructure rentalId khỏi cash body trước strict parse, kiểm tra actor khi đọc receipt, đổi charge lock trước rental khi cấp voucher.
Phải giữ các regression test này; chỉ mở lại nếu một test tái hiện được lỗi thực tế.

Giới hạn còn phải đóng: preview chưa ràng buộc rental với Store, tính giá có hai đường đi,
customer cache chưa invalidation đầy đủ, pagination có thể thành Infinity, và thiếu nghiệm thu cash trên PostgreSQL thật.
Những đường đời thuê khác bên dưới là phạm vi kiểm chứng/tích hợp; không mặc định mọi mục đều đang có lỗi.

## 2. Thứ tự triển khai để tiết kiệm thời gian

| Gói việc | Đầu ra | Phụ thuộc |
| --- | --- | --- |
| R1 | Một hợp đồng giá/snapshot và một đường tạo rental + charge | Bắt đầu |
| R2 | Preview BOLA, quyền Store, validation, DTO/response | Có thể thực hiện sau khi chốt R1 contract |
| R3 | Cash/PayOS/voucher/ledger và bàn giao thống nhất | R1 + R2 |
| R4 | Gia hạn, hết hạn, admin adjustment, chặn bấm nút | R3 |
| R5 | Trả từng nút, hoàn cọc, payout retry/reconcile | R3; kiểm tra tương tác R4 |
| R6 | Cache, notification/outbox, tài liệu tích hợp | Thực hiện cùng R3–R5, không để cuối mới nối |
| R7 | HTTP + PostgreSQL acceptance, migration rehearsal, bàn giao | Kiểm thử tích lũy từ R1; gate cuối sau R1–R6 |

Mỗi gói: test tái hiện → xác nhận fail đúng lý do → sửa → regression.
Không chờ một lượt review chat mới giữa từng task. Chỉ dừng khi thiếu quyết định làm đổi phạm vi hoặc cần quyền thao tác bên ngoài.
Đây không phải chỉ thị tự động commit/push hay ủy quyền subagent.

## R1. Một nguồn giá và snapshot trên luồng thật

### File/hàm

- `src/rentals/rentals.service.ts`: `createRentalContract`, `extendRentalContract`.
- `src/rentals/rentals.repository.ts`: `createRental`, `createRentalExtensionCharge`.
- `src/billing-charges/billing-charges.service.ts`: `createInitialRentalCharge`, `createRenewalRentalCharge`.
- Thêm pure domain helper, ví dụ `src/rentals/rental-pricing.ts`; không đặt truy vấn DB trong helper.
- `prisma/schema.prisma` và migration mới CHỈ khi snapshot hiện tại không đủ biểu diễn hợp đồng rõ ràng.

### Cách sửa cụ thể

1. Định nghĩa rõ đầu vào giá. Giữ tương thích hiện tại: `RentalPackage.monthlyPrice` và `depositFee` là TỔNG giá của kit.
   Kit chuẩn 3 nút có giá tháng 90.000đ, cọc 600.000đ. Không nhân tổng kit với 3 thêm một lần.
2. Trong pure helper, dùng Decimal và tên không mơ hồ:
   - `quantity`, `months`, `monthlyPackageAmount`, `packageDepositAmount`.
   - `rentTotal = monthlyPackageAmount × months`.
   - `depositTotal = packageDepositAmount`.
   - `chargeTotal = rentTotal + depositTotal`.
   - Giá mỗi nút phải chia chính xác, không `Math.floor` để che mất phần dư.
3. Với catalog dùng biểu phí chuẩn, cấu hình/validate tổng kit từ 30k × quantity và 200k × quantity.
   Nếu phát hiện gói lịch sử khác giá chuẩn, báo cáo và xử lý có chủ đích; không tự sửa giá hợp đồng/ledger cũ.
4. Snapshot quantity, giá cọc từng nút, giá tháng và thời hạn đã mua lúc tạo hợp đồng; client không gửi amount đáng tin cậy.
   `rentPerButton` hiện được tạo theo cả kỳ đầu, KHÔNG tự đổi nghĩa thành đơn giá tháng trên dữ liệu cũ.
   Nếu cần snapshot tháng riêng cho gia hạn, thêm trường rõ nghĩa, nullable cho lịch sử; backfill chỉ khi đủ dữ liệu charge/lines để suy ra chính xác.
5. `createRentalContract` gọi helper; repository tạo rental + charge + lines trong CÙNG transaction.
   Không tạo rental xong mới tạo charge ngoài transaction; không gọi thêm một hàm tạo charge gây nhân đôi.
6. Hàm `BillingChargesService.createInitialRentalCharge` phải dùng cùng contract/helper nếu còn caller cần nó.
   Không để một hàm dùng per-button, hàm khác hiểu totals; không dùng `amount || default` cho giá tài chính.
7. Quy ước line: quantity = số nút, durationCount = số tháng, RENT.amount = tổng phí cả kỳ,
   RENT.unitPrice = phí kỳ trên mỗi nút (để quantity × unitPrice = amount); dùng helper rõ tên nếu cần giá tháng riêng.
8. Hợp đồng đã tạo không thay đổi giá/quantity khi admin sửa RentalPackage.

### Nghiệm thu

- [ ] 1 nút × 1 tháng: rent 30k, cọc 200k, tổng 230k.
- [ ] 3 nút × 1 tháng: rent 90k, cọc 600k, tổng 690k.
- [ ] 3 nút × 3 tháng: rent 270k, cọc 600k, tổng 870k.
- [ ] Test đi qua `createRentalContract` và repository thật, không nạp sẵn charge 690k.
- [ ] Sửa giá catalog sau tạo hợp đồng không sửa charge/snapshot cũ.
- [ ] Lỗi khi ghi charge rollback luôn rental; không có hợp đồng tài chính mồ côi.

## R2. Đóng preview BOLA, validation và hợp đồng HTTP

### File/hàm

- `src/store-cash/store-cash.repository.ts`: `getHandoverPreview`, authority checks.
- `src/store-cash/store-cash.service.ts`, `store-cash.controller.ts`, `dto/store-cash.dto.ts`.
- Dùng chung eligibility helper cho preview và cash/handover, tránh hai bộ điều kiện lệch nhau.

### A. Hai tầng quyền của preview

1. Tầng actor: user ACTIVE, Store ACTIVE, owner đúng Store hoặc staff ACTIVE với role phù hợp lấy từ DB.
   Không tin mỗi `req.user.storeId`; không mở rộng quyền admin mutation do RolesGuard bypass.
2. Tầng resource: với tài khoản Store thông thường, rental phải thuộc phạm vi sau:
   - `fulfillmentStoreId == storeId`; HOẶC
   - customer đã cấp voucher ACTIVE chưa hết hạn, đúng rental/customer/charge/collectingStoreId;
     charge còn PENDING, target là chính rental đó.
3. Không thỏa điều kiện trên: trả 404 chung cho resource ngoài phạm vi, không trả tiền cọc/trạng thái/thiết bị của rental đó.
4. Store thu hộ khác fulfillment Store vẫn được xử lý thu tiền bằng voucher, nhưng không được tự bàn giao thay Store khác.
5. Truy vấn rental trong scope; không fetch rental bất kỳ rồi trả dữ liệu trước khi kiểm tra liên kết.
6. Chính sách platform-admin read phải tách rõ, dựa role đã xác thực từ server; không tạo admin bypass cho thu tiền.

### B. `canFulfillImmediately` phải khớp mutation

```text
canFulfillImmediately =
  authorizedForRental
  AND rentalStateAllowsPickup
  AND fulfillmentIsUnsetOrThisStoreAsAllowedByTheFlow
  AND completeEligibleDeviceSetExists
```

- PENDING_PAYMENT: chỉ preview thu tiền + giao ngay khi có consent/voucher hợp lệ; chưa bật quyền đặt hàng.
- PENDING_HANDOVER: chỉ Store fulfillment hợp lệ mới được bàn giao sau thanh toán.
- CANCELLED/TERMINATED/RETURNED/ACTIVE/EXPIRED: không coi là lượt bàn giao đầu mới.
- Xét thiết bị đã ASSIGNED_TO_RENTAL cho chính rental, không chỉ thiết bị chưa gán.
- Loại thiết bị của khách/rental khác. Không cho preview một điều kiện mà mutation lại từ chối theo điều kiện khác.
- Preview không giữ chỗ, không đảm bảo tồn kho tới lúc submit. Mutation luôn recheck dưới lock và có thể trả 409.
- Không trả toàn kho không giới hạn: count riêng, danh sách có pageSize <= 100 và thứ tự ổn định; không ép UI quét toàn bộ kho để chọn đủ nút.

### C. Pagination/input

- Validate path ID trước BigInt; body strict; Zod/DTO errors trả 400, không 500.
- Query page/pageSize chỉ nhận chuỗi số nguyên dương hữu hạn, safe integer, có độ dài/giới hạn cụ thể.
- Đề xuất giới hạn vận hành `MAX_OFFSET = 1_000_000`; reject nếu `(page - 1) × pageSize` vượt giới hạn, không chỉ check page.
- pageSize > 100 trả 400 theo contract hiện tại. Status dùng allowlist thật của endpoint.
- Order by createdAt + id để pagination ổn định.
- Canonical cash API: POST `/api/v1/stores/:storeId/cash-receipts`; destructure rentalId trước repository parse.
- Alias động từ đã thêm không cần viết lại toàn bộ router: nếu chưa có consumer thì bỏ; nếu đã có consumer thì deprecate/document thay vì âm thầm phá vỡ.
- DTO mapper cho mọi response, gồm receipt/return/refund; không trả nguyên ORM entity hoặc snapshot encrypted/hash ra HTTP.

### Nghiệm thu

- [ ] Owner Store 5 gọi URL Store 5 nhưng rental của Store 99: 404, không có dữ liệu rental.
- [ ] Staff Store 99 đổi URL thành Store 5: 403 trước khi đọc dữ liệu.
- [ ] Voucher đúng Store nhưng sai khách/charge/rental, hết hạn hoặc REVOKED: không cấp quyền preview thu hộ.
- [ ] CANCELLED không trả `canFulfillImmediately=true`; fulfillment khác Store không giao ngay.
- [ ] Kho thiếu nút trả false; đủ một phần đã assigned + phần rảnh được xét nhất quán với mutation.
- [ ] page rất dài, Infinity, NaN, số thập phân, pageSize 101 và unknown fields: 400 trước DB.
- [ ] Các lỗi cũ về đọc receipt và userId/profileId vẫn có regression tests PASS.

## R3. Thu tiền, receipt, voucher và bàn giao chung transaction

### File/hàm

- `src/store-cash/store-cash.repository.ts`: `issueVoucher`, `collect`.
- `src/store-cash/store-cash-settlement.transaction.ts`.
- `src/billing-charges/billing-charges.repository.ts`, `billing-charges.service.ts`.
- `src/payments/payments.service.ts`: webhook và đối soát server-side.
- `src/rentals/rental-handover.transaction.ts`, `rentals.repository.ts`.

### Công việc

1. Giữ CAS PENDING → PAID và cùng transaction: available wallet debit, wallet ledger, voucher consumption,
   receipt, deposit, rental state, device movements, audit và outbox.
2. Không reset ledger cọc đã có hoạt động. Kiểm tra line sum/currency/target/quantity/duration với snapshot.
3. Unique charge receipt chống hai cash thu cùng charge; requestHash chống retry đổi payload.
   Cùng request được retry an toàn; khác Store/token/thiết bị/chế độ thì conflict, không lấy kết quả cũ tùy tiện.
4. Cấp lại/đổi collecting Store/charge phải revoke voucher cũ nguyên tử. Dùng thời gian DB để kiểm tra hạn QR.
   Không lưu raw token vào log, cache response/idempotency DB hoặc audit.
5. Giữ một helper handover nhận TransactionClient; tuyệt đối không mở nested transaction.
6. IMMEDIATE: đủ đúng snapshot quantity, đúng custody, đúng assignment, không chiếm thiết bị của rental khác.
   Ghi DeviceMovement, customer/rental binding, inventory state, canOrder, startDate/endDate/paidThrough/effectiveExpiresAt đồng bộ.
7. DEFERRED: PENDING_HANDOVER; không bắt đầu hạn thuê, không tự đổi fulfillmentStoreId sang collecting Store.
8. Ma trận PayOS:
   - Cash trước → receipt mới + đúng một obligation tiền thừa; không tăng cọc/kỳ thuê.
   - PayOS trước → cash không debit, không receipt thành công, có thông báo trả lại tiền mặt đã nhận.
   - Replay cùng provider/channel/reference → không ghi thêm liability.
   - Polling và webhook dùng cùng money channel; một giao dịch không đổi danh tính vì hai cách nhận dữ liệu.
   - Receipt conflict về charge/amount/currency phải fail-closed, không rebind.
9. Giữ kiểm tra signature/provider identity/link. Không dùng orderCode thay bank transaction reference trong path mới.
   Với tiền thật lệch amount hoặc thiếu reference, phải có cách ghi nhận/chuyển đối soát bền vững hoặc từ chối để retry;
   không trả ACK như đã xử lý khi thực tế chưa lưu được tiền.
10. Kiểm tra replay trên charge lịch sử. Chỉ backfill receipt khi có bằng chứng provider; không đoán giao dịch cũ thành tiền thừa.
11. Rà cả lock graph thực tế của issue/reissue/cash/PayOS/assignment/handover/expiry/return/withdrawal;
    ghi thứ tự lock từng path, kể cả FK và trigger. Không tuyên bố sơ đồ lock một path chứng minh toàn hệ thống không deadlock.
    Bounded whole-transaction retry cho lỗi DB retryable; không tự retry provider payout bằng ID mới.

### Nghiệm thu

- [ ] Bộ kit 3 nút đi từ R1 qua voucher, cash và handover; total 690k, deposit 600k, đúng 3 movements.
- [ ] Ví 1 triệu, frozen 100k → sau offset 690k: available 310k, frozen vẫn 100k.
- [ ] Hai request cash đồng thời chỉ debit một lần; rollback ở mọi checkpoint phục hồi voucher/ledger.
- [ ] Cash/PayOS ở cả hai thứ tự và webhook/polling replay không tăng cọc hoặc duration lần hai.
- [ ] Thiếu 1 nút, thiết bị Store khác, expiry QR giữa chừng: toàn transaction rollback.

## R4. Gia hạn, hết hạn và quyền sử dụng

### File/hàm

- `RentalsService.extendRentalContract`, `adjustRentalDurationAdmin`, `updateRentalStatusAdmin`.
- Repository extension/adjustment, BillingCharges settlement extension.
- `src/rentals/rental-expiry-cron.service.ts`.
- `src/rentals/dto/rental-response.dto.ts`.
- Các handler bấm nút trong `src/orders/orders.service.ts`.

### Công việc/nghiệm thu

- [ ] Mỗi gia hạn tạo charge riêng; chưa trả tiền không cộng paidThrough hoặc quyền sử dụng.
- [ ] Phí gia hạn theo snapshot đã chốt; không đọc giá catalog mới để thay đổi âm thầm hợp đồng cũ.
- [ ] Theo biểu phí từng nút, kỳ gia hạn mới chỉ tính số thiết bị còn thuê, không RETURN_IN_TRANSIT/đã nhận trả;
  ví dụ kit ban đầu 3 nút đã trả xong 1 nút thì kỳ mới của 2 nút là 60k/tháng, không thu cọc lần nữa.
  Snapshot quantity ban đầu và lịch sử kỳ đã trả vẫn giữ nguyên. Snapshot quantity của charge gia hạn được chốt dưới lock;
  kiểm tra return/extension race trước settlement, không sửa hồi tố phí kỳ cũ hoặc tự hoàn phí thuê theo ngày chưa được chốt.
- [ ] Chưa bàn giao: thanh toán thêm vẫn PENDING_HANDOVER; thời hạn bắt đầu khi bàn giao thật.
- [ ] Đã ACTIVE: cộng kỳ từ max(paidThrough, now) theo quy tắc financial term; tính effective entitlement kết hợp admin adjustments có audit, không xóa phần tặng hoặc giảm hạn một cách vô tình.
- [ ] Gia hạn sau EXPIRED: chỉ bật lại thiết bị còn thuộc khách/rental và không RETURN_IN_TRANSIT; không bật lại nút đã trả.
- [ ] Ở đúng mốc effectiveExpiresAt <= serverNow: handler bấm nút từ chối ngay, dù cron 10 phút chưa chạy.
- [ ] DTO pending/unpaid/returned/cancelled không báo canOrder=true vì fallback endDate. paidThrough chưa có phải giữ null.
- [ ] Admin adjustment có actor thật, lý do và lịch sử trước/sau. Không dùng fallback userId=1 hoặc đánh dấu charge đã trả tiền.
- [ ] Điều chỉnh hạn qua now phải đồng bộ entitlement + thiết bị; không hồi sinh rental đã RETURNED/TERMINATED bằng API đổi ngày.
- [ ] Không cho generic status endpoint nhảy qua thanh toán/bàn giao/hoàn cọc.
- [ ] Expiry chạy nhiều instance an toàn, notification/outbox không nhân đôi; cache phản ánh trạng thái mới.

## R5. Trả từng nút và hoàn cọc thật

### File/hàm

- `RentalsService.createReturnRequest`, `confirmReturnReceipt`, `approveDepositRefund`, `reconcileDepositRefundPayout`.
- `RentalsRepository.createReturnRequestTx`, `confirmReturnReceiptTx`, `approveDepositRefundTx`, `confirmDepositRefundPayoutTx`.
- `src/rentals/outbox-consumer.service.ts`, `deposit-payout-verifier.ts`.
- Bank-account onboarding/verification hiện có là dependency, không giả lập VERIFIED để vượt gate.

### Công việc

1. Yêu cầu trả gắn button/rental/customer; khóa nút đó, chuyển RETURN_IN_TRANSIT, canOrder=false.
   Retry không sinh nhiều pending return cho cùng thiết bị/lượt thuê.
2. Store nhận trả phải là đơn vị được phép theo fulfillment/return routing hiện có; kiểm tra membership ACTIVE trong DB.
   Không chỉ tin storeId có trong JWT; không nhầm Store nhận đơn tiêu dùng với Store nhận thiết bị.
3. Nhận nút: ghi inspection/movement, tách customer/rental/address, về custody Store đúng.
   Nút trong kho không được đặt hàng cho khách cũ; dùng eligibility chung, không suy ra chỉ từ một flag.
4. Kit 3 nút: tạo tối đa một refund claim theo từng return đã nhận; cọc mỗi nút lấy snapshot 200k của hợp đồng.
   Không fallback giá package đã sửa, không chia heldAmount hiện còn lại để tính cọc lần trả thứ hai.
5. Chỉ đánh dấu toàn rental RETURNED khi không còn nút của hợp đồng đang ở khách/chờ nhận trả theo lifecycle đã thống nhất.
6. Duyệt refund: khóa refund/ledger/account; recipient VERIFIED thuộc đúng khách, snapshot encrypted/hash/masked bất biến.
   Không có ngân hàng hợp lệ: tiếp tục chờ xử lý, không tạo payout giả hoặc đổi status thành REFUNDED.
7. Khi duyệt: held -= amount, reserved += amount; không trừ StoreWallet và không tăng refundedAmount trước provider success.
8. Worker dùng payout reference/idempotency ổn định. Timeout/kết quả chưa rõ: giữ reserved để tra cứu lại cùng giao dịch,
   không gửi lệnh mới vô điều kiện và không giải phóng tiền khi chưa biết chi trả đã xảy ra hay chưa.
9. Chỉ xác minh đúng reference, transaction detail, amount, bank BIN, account hash/snapshot và terminal success mới:
   reserved -= amount, refunded += amount, refund.status = REFUNDED.
10. Admin reconcile không được nhập một payout bất kỳ rồi gán cho refund: giữ binding nội bộ/provider và snapshot hiện có.
    Terminal callback/reconcile replay không đảo trạng thái hay hoàn hai lần.
11. Quét response/log của toàn đường return/refund/reconcile: không plaintext/ciphertext/hash/raw provider payload ngoài DTO.

### Bất biến và nghiệm thu

```text
collectedAmount = heldAmount + refundReservedAmount + refundedAmount
mọi thành phần >= 0
```

- [ ] Kit thu 600k cọc, nhận/duyệt nút 1: held 400k, reserved 200k, refunded 0.
- [ ] Provider xác nhận nút 1: held 400k, reserved 0, refunded 200k.
- [ ] Hoàn nút 2 và 3: tổng refunded 600k, held/reserved 0; không còn dư hoặc hoàn quá cọc.
- [ ] Hai lần confirm/approve/reconcile cùng refund: chỉ một dịch chuyển tiền ở mỗi stage.
- [ ] Đổi tài khoản mặc định sau approve không đổi recipient snapshot payout.
- [ ] Timeout rồi retry/DLQ/reconcile không tạo payout thứ hai; thiếu evidence không REFUNDED.
- [ ] Trả một nút không vô hiệu hóa nhầm mọi nút còn lại ngoài chính sách expiry đã chốt.

## R6. Cache, outbox, giao diện và vận hành

### Cách sửa cache cụ thể

- Repository mutation trả thêm context tối thiểu từ DB: customer USER ID, collecting Store ID,
  fulfillment Store ID và các button IDs bị ảnh hưởng. Không lấy customer ID từ người nhân viên thao tác.
- Service sau COMMIT dùng helper chung:
  - invalidateKey(customer:dashboard:<userId>).
  - invalidateKey(customer:rentals:<userId>).
  - invalidateKey(customer:devices:<userId>) nếu thay đổi thiết bị, sau khi đối chiếu key reader thực tế.
  - invalidatePrefix(dash:store:<storeId>:), staff:dashboard:store:<storeId>: cho các Store bị ảnh hưởng.
  - Admin dashboard/operations/revenue và các key thực sự bị mutation tác động.
- Không dùng prefix customer:dashboard:7 để xóa nhầm user 77; không xóa cache Store unrelated.
- Áp dụng cho cash, online settlement, deferred handover, expiry, return, approve, payout và admin adjustments — không chỉ cash.
- Worker/cron không đi qua Service vẫn phải có cơ chế post-commit invalidation hoặc consumer bền vững tương ứng.
- Cache lỗi không rollback nghiệp vụ đã commit; log an toàn và có retry/invalidation event nếu cần.

### Công việc khác

- [ ] Outbox chỉ ghi trong transaction nghiệp vụ; worker retry không spam notification.
- [ ] FE nhận DTO gồm serverNow, paidThrough, effectiveExpiresAt, remainingSeconds và canOrder đúng state.
- [ ] POS preview là thông tin tại thời điểm đọc; hiển thị 409 stock race rõ ràng, không nhận cash như đã tất toán nếu backend từ chối.
- [ ] Màn hình refund phân biệt pending approval, pending payout và refunded; không coi approved là đã chuyển tiền.
- [ ] Admin overpayment queue có receipt identity/amount, trạng thái pending reconciliation và quy trình tiếp nhận chứng từ; không có nút chuyển tiền tùy ý.
- [ ] Swagger/contract thể hiện canonical APIs thực sự, ví dụ kit 1/3 nút, money fields, errors và pagination envelope.

## R7. Nghiệm thu cố định và release gate

### A. Kiểm thử không DB

- Pure pricing/snapshot, DTO/path/pagination, state eligibility, mapper/leakage, payout verifier.
- Suite 66, 67 và settlement replay giữ nhãn unit/mock; bổ sung test từ R1 thay vì chỉ fixture charge có sẵn.
- Không coi 10/10 scenario là toàn bộ assertions hoặc coi mock transaction chứng minh rollback.

### B. HTTP integration

- Chạy Nest HTTP pipeline thật: route, guards, validation, interceptor, mapper và filter.
- Kiểm tra 401, 403/404 tenant, 400 malformed input, 409 financial/state conflict, 503 flag disabled.
- Header Idempotency-Key bắt buộc cho mutations tài chính; đổi payload/cross-user/cross-route không chia sẻ response sai.
- Voucher response no-store, không lưu raw token vào idempotency response table/log.
- Login giả lập trong test pipeline phải ghi rõ; có test JWT/role hiện hành riêng trước release.
- Hiện workspace thiếu @nestjs/testing/supertest theo lượt review trước; nếu chọn thêm dependency thì thực hiện có chủ đích.
  Có thể dùng NestFactory + HTTP loopback/fetch để kiểm thử pipeline mà không thêm hai package này.

### C. PostgreSQL integration (bắt buộc để đóng giao dịch tài chính)

- Dùng explicit TEST_DATABASE_URL đã qua guard. Không fallback production DATABASE_URL.
- Migrate schema mới trên DB test riêng, hoặc isolated database branch được chỉ định; không fault-injection production.
- Hai Prisma clients/connections độc lập; dùng synchronization/barrier hoặc DB observation để chứng minh giao dịch thực sự chồng lấn,
  không chỉ Promise.all hai lời gọi có thể vô tình chạy tuần tự.
- Ma trận bắt buộc:
  1. cash/cash cùng charge; hai charge tranh một ví không đủ tiền; cash/withdrawal cùng ví.
  2. cash/PayOS cả hai thứ tự; webhook/webhook; webhook/polling cùng bank reference.
  3. issue/reissue/consume voucher, đổi collecting Store, expiry lúc chờ lock.
  4. Hai nhân viên chọn cùng thiết bị; assignment/handover/expiry/return cạnh tranh.
  5. Gia hạn/expiry/admin adjustment; hai return hoặc hai approve cùng refund; hai payout-reconcile cùng kết quả.
- Fault injection sau wallet debit, voucher consume, charge CAS, deposit write, receipt, device update và outbox insert.
  Kiểm tra trực tiếp DB sau rollback: không mất tiền, không receipt/ledger mồ côi, voucher dùng lại được nếu transaction chưa commit.
- Kiểm tra UNIQUE/FK/CHECK bằng dữ liệu cố ý sai; cleanup chỉ fixtures do run đó tạo, không wildcard xóa dữ liệu chung.

### D. Một kịch bản end-to-end chuẩn để chốt

1. Tạo kit 3 nút từ catalog chuẩn → rental + charge 690k, cọc 600k.
2. Customer chọn Store → issue QR; staff preview đúng scope; thu cash + giao đủ 3 nút.
3. Kiểm tra ví/deposit/receipts/devices/duration/dashboard sau commit.
4. Retry cash và nhận PayOS tiền thừa → không thêm rent/deposit, đúng một liability.
5. Gia hạn một tháng → chỉ thêm 90k tiền thuê, không thêm 600k cọc; chưa trả tiền chưa tăng quyền.
6. Admin điều chỉnh hạn có audit → không thay paidThrough/financial receipt.
7. Tới expiry → bấm nút bị chặn ngay, rồi kiểm tra phục hồi quyền theo gia hạn hợp lệ.
8. Trả lần lượt 3 nút → nhận kho → approve → provider evidence → hoàn tổng 600k, sổ cọc về 0 held/reserved.
9. Lặp webhook/payout kết quả → số liệu cuối không thay đổi.
10. Lặp lại đường online + DEFERRED để chứng minh cùng settlement/handover invariants, không chỉ happy path cash.

### E. Gate phát hành

- [ ] Unit, HTTP và PostgreSQL matrix bắt buộc có log PASS; không bỏ qua test rồi ghi hoàn tất.
- [ ] `npx tsc --noEmit --incremental false`, `npm run build`, `prisma validate`, client generate, diff check.
- [ ] Migration rehearsal trên DB riêng: thứ tự đúng, giữ dữ liệu lịch sử, không sửa migration đã chạy.
- [ ] Không gọi migrations status của production để thay bằng bằng chứng concurrency test.
- [ ] Provider contract tests và live controlled acceptance được phân biệt; payout credentials/quyền/IP/số dư được xác nhận khi thật sự release.
- [ ] Nếu chưa có điều kiện provider, ghi CODE ACCEPTED / LIVE PAYOUT NOT VERIFIED, không ghi production-ready.
- [ ] Handoff giữ cả lỗi đã đóng lẫn giới hạn còn lại; không xóa lịch sử và thay bằng câu 'mọi thứ 100%'.
- [ ] Chỉ sau user cho phép: commit có phạm vi, PR/CI, migration deploy, deploy tương thích ngược, bật cờ từng bước và giám sát.
- [ ] Có cách tắt tiếp nhận cash MỚI nhưng tiếp tục ghi nhận/đối soát tiền PayOS đang tới và nghĩa vụ refund đã có.
  Không dùng một cờ disable intake làm mất luôn khả năng xử lý late payment của charge đã cash-settled.
  `STORE_CASH_COLLECTION_ENABLED` chỉ chặn cấp voucher/thu cash mới. Receipt processing phải dựa vào ledger đã triển khai
  và dấu vết charge/receipt trong DB, không quay về PAID early-return chỉ vì tắt intake. Kiểm thử riêng case cash đã commit → tắt flag → late PayOS.
- [ ] Rollback ứng dụng không DROP các bảng receipt/obligation/ledger hoặc xóa giao dịch đã ghi nhận.

## 3. Định nghĩa hoàn thành và quy tắc review

1. CODE COMPLETE: R1–R6 có implementation và test liên quan; không đồng nghĩa đã kiểm chứng live.
2. FINANCIAL ACCEPTANCE: HTTP + PostgreSQL concurrency/rollback và sổ cái E2E đạt.
3. PRODUCTION ACCEPTANCE: provider/deployment acceptance có quyền và evidence thật; chưa có thì ghi pending.

Đóng lỗi bằng case tái hiện + assertion DB/HTTP cụ thể, không bằng số lượng test hoặc build sạch.
Checklist này là tập tiêu chí cố định để thực thi trọn gói. Không thể hứa phần mềm tuyệt đối không còn lỗi;
lỗi phát sinh ngoài checklist chỉ được thêm khi có bằng chứng tái hiện và chỉ rõ tác động, không refactor tùy hứng.

## 4. Bước bắt đầu ngay khi triển khai

Viết regression cho preview ngoại Store/CANCELLED và pricing qua luồng createRentalContract trước;
sửa R1/R2 trong cùng đợt, đồng thời dựng DB fixture/HTTP harness cho R7.
Sau đó hoàn thiện R3–R6 và chạy ma trận cuối một lần trên cùng revision.
Không cần một vòng chốt nghiệp vụ mới cho các mục đã được thống nhất ở tài liệu này.
