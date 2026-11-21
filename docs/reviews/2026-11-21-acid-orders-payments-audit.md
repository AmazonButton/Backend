# Rà soát ACID: đặt hàng, tồn kho, thanh toán và tiền ví

Ngày kiểm tra: **2026-11-21**. Branch: `feat/system-staff-role-transition`; base commit `fdef8b5`. Đối tượng kiểm tra là **working tree hiện tại**, bao gồm các thay đổi ACID chưa commit từ trước, không chỉ nội dung commit này.

## Kết luận và phạm vi

Đã tái hiện **5 lỗi riêng biệt**: **4 P1** trong xử lý thanh toán/idempotency và **1 P2** ở cập nhật kho. Các transaction hiện tại bảo vệ được nhiều thao tác ghi đồng thời, nhưng vẫn có thể commit một trạng thái nghiệp vụ sai hoặc thực hiện lại nghiệp vụ đã commit.

Đã đọc các đường đi đặt hàng web, nút bấm/quick reorder, giữ và giải phóng tồn kho, giao hàng/hoàn tất, thanh toán PayOS, đổi phương thức thanh toán, ví/withdrawal, subscription, billing/rental settlement và outbox hoàn cọc. Mức kiểm chứng của từng phần được phân biệt bên dưới; không phải mọi đường đi đều đã chạy HTTP E2E hay tranh chấp trên DB thật.

Chỉ sử dụng DB test `smart_order_test` qua `getSafeTestPrismaService` và allowlist host. Không tác động Production, không chạy migration/DDL, không gọi PayOS thật, không chuyển tiền thật. Không sửa code nghiệp vụ trong lần audit này.

## 1. [P1] Nhận tiền hợp lệ khi đơn đã CONFIRMED/PREPARING lại chuyển sang chờ hoàn

**Code:** [payments.repository.ts](../../src/payments/payments.repository.ts), `confirmPaymentAtomicTx`, dòng **191–226**. API tiếp nhận: `POST /api/v1/payments/payos/webhook`.

Điều kiện hiện tại:

```ts
const canConfirmOrder = order.order_status === 'PENDING' && order.payment_method === 'PAYOS';
```

Nhánh `else` đặt `order.paymentStatus = 'REFUND_PENDING'` cho mọi trạng thái còn lại. Vì vậy nó gộp cả đơn đã được xác nhận/chuẩn bị hàng với đơn đã hủy hoặc đổi sang COD.

**Tái hiện:** tạo đơn PayOS `CONFIRMED/UNPAID`, có payment transaction `PENDING`; gọi repository xác nhận tiền. Transaction thành `PAID` nhưng đơn thành `REFUND_PENDING`. Test L1 chạy trên PostgreSQL thật xác nhận kết quả này; M1 kiểm tra thêm `PREPARING` bằng mock I/O.

**Ảnh hưởng:** một khoản thu hợp lệ bị phân loại nhầm là cần hoàn; trạng thái đơn và chứng từ thanh toán không thống nhất. Đây là lỗi **Consistency** dù mọi lệnh ghi nằm trong cùng transaction.

**Cần sửa:** tách hai quyết định: ghi nhận tiền và chuyển tiến trình giao hàng. Với đơn PayOS ở trạng thái còn được nhận tiền, ghi `paymentStatus = PAID`; chỉ chuyển `PENDING → CONFIRMED` khi phù hợp, giữ nguyên các trạng thái tiến triển khác. Liệt kê riêng trạng thái kết thúc/hủy và trường hợp đổi COD cần đối soát. Test toàn bộ ma trận trạng thái đơn, không chỉ PENDING và CANCELLED.

## 2. [P1] Tiền đến từ link cũ làm mất trạng thái PAID của đơn đã thanh toán bằng link mới

**Code:** [payments.repository.ts](../../src/payments/payments.repository.ts), `confirmPaymentAtomicTx`, dòng **143–179**. Cùng API webhook nêu trên.

Khi tìm được payment khác của cùng đơn đang `PENDING` hoặc `PAID`, code đưa payment cũ sang `REFUND_PENDING` để tránh vi phạm partial unique index. Tuy nhiên, nó đồng thời đặt **paymentStatus của cả đơn** thành `REFUND_PENDING`.

**Tái hiện L2, PostgreSQL thật:** đơn `CONFIRMED/PAID`, payment thay thế `PAID`, payment cũ `CANCELLED`; xác nhận tiền đến từ payment cũ. Đơn đang được bảo đảm bởi payment thay thế vẫn bị đổi thành `REFUND_PENDING`. M2 cũng tái hiện bằng mock.

**Ảnh hưởng:** nghĩa vụ hoàn khoản nhận thừa bị trộn với khoản thanh toán hợp lệ của đơn. Đây là lỗi **Consistency**, không phải unique index bị hỏng.

**Cần sửa:** ghi nhận nghĩa vụ hoàn **theo khoản thu/payment cụ thể**, giữ trạng thái PAID khi đơn còn một payment hợp lệ đã trả đủ. Quy trình hoàn chỉ được tất toán nghĩa vụ tương ứng. Cần rà tiếp `OrdersRepository.refundOrderAtomicTx` (dòng 926 trở đi), hiện cập nhật các payment `PAID/REFUND_PENDING` của đơn theo tập, để tránh đánh dấu khoản thu hợp lệ là đã hoàn khi chỉ xử lý tiền nhận thừa.

## 3. [P1] Callback đọc snapshot cũ có thể ghi FAILED đè lên PAID

**Code:** [payments.service.ts](../../src/payments/payments.service.ts), `handlePayosWebhook`, dòng **574**; [payments.repository.ts](../../src/payments/payments.repository.ts), `updateTransactionStatus`, dòng **51–62**.

`updateTransactionStatus` cập nhật theo ID, không có điều kiện trạng thái kỳ vọng. Việc service bỏ qua payment đã PAID dựa trên snapshot đọc trước đó không bảo vệ được khoảng thời gian giữa đọc và ghi.

**Tái hiện L3, PostgreSQL thật:**

1. Callback A đọc payment đang PENDING rồi bị giữ ở một barrier trong test.
2. Callback B xác nhận thành công, commit payment PAID và order PAID.
3. Cho callback A tiếp tục nhánh lỗi; payment bị ghi thành FAILED.

Test dùng `data.code = '00'` và chữ ký hợp lệ trên cùng dữ liệu thành công cho cả hai callback. Chỉ `code` ở envelope ngoài chữ ký đổi thành `'99'` ở A để chọn nhánh lỗi. Đây là cách tái hiện ranh giới tin cậy và race; **không khẳng định PayOS thực tế sẽ gửi callback thất bại kiểu này**. Test ký bằng checksum giả trong process, không gọi provider.

**Ảnh hưởng:** order PAID nhưng payment FAILED; các bước đối soát/ghi ví dựa trên chứng từ PAID có thể bỏ sót. Đây là lỗi **Isolation + Consistency** trong đường ghi không tuân theo lock/CAS của đường xác nhận thành công.

**Cần sửa:** quyết định từ dữ liệu đã xác thực, từ chối hoặc bỏ qua envelope mâu thuẫn. Chuyển trạng thái bằng row lock/CAS với tập trạng thái nguồn cụ thể; không cho FAILED ghi đè PAID/REFUNDED. Áp dụng cả các chỗ gọi `updateTransactionStatus(..., 'FAILED')` trong tạo link. Duy trì cùng thứ tự khóa `orders → payment_transaction`.

## 4. [P1] Cùng idempotency key vẫn tạo đơn thứ hai sau khoảng trống commit

**Code:** [idempotency.interceptor.ts](../../src/common/idempotency/idempotency.interceptor.ts), dòng **113–134**; [idempotency.repository.ts](../../src/common/idempotency/idempotency.repository.ts), nhánh lease hết hạn khoảng **116–142**; [orders.repository.ts](../../src/orders/orders.repository.ts), `createStorefrontOrderTx`, dòng **1566**; [storefront.controller.ts](../../src/orders/storefront.controller.ts), dòng **17–27**.

**API:** `POST /api/v1/storefront/orders`.

Transaction tạo đơn/giữ kho commit trước; interceptor mới lưu response vào bảng idempotency. Nếu process chết giữa hai bước, record idempotency còn PROCESSING. Khi lease hết hạn, retry được cấp quyền chạy lại; order web chưa có khóa nghiệp vụ bền vững tương ứng key để tìm lại đơn đã tạo.

**Tái hiện L4, PostgreSQL thật:** acquire key → tạo đơn và commit → không finalize response → làm hết hạn lease của chính fixture để mô phỏng crash → acquire lại cùng key/body → repository tạo đơn với ID khác và giữ thêm kho.

Đây là mô phỏng cửa sổ lỗi bằng expiry, không phải test kill process thật. Nó xác nhận rõ khoảng trống giữa hai commit. Nếu finalize response lỗi sau business commit, luồng `finalizeFailure` cũng cần tránh cho phép thực thi lại nghiệp vụ đã hoàn tất.

**Ảnh hưởng:** người dùng retry cùng yêu cầu có thể có hai đơn và hai lần giữ kho; thanh toán tiếp theo có thể dẫn tới xử lý hai đơn. Chưa có bằng chứng test này tự trừ tiền hai lần. Đây là lỗi **Atomicity của ranh giới nghiệp vụ/idempotency và khả năng phục hồi**, không phải PostgreSQL làm mất dữ liệu đã commit.

**Cần sửa:** lưu định danh checkout bền vững với unique `(actor, key)` và request hash, liên kết order/result **trong cùng transaction** tạo đơn và giữ kho. Khi lease được nhận lại, đối chiếu định danh này để trả đơn cũ. Response cache của interceptor chỉ hỗ trợ replay; không thay thế ràng buộc nghiệp vụ trong DB. Có thể tham khảo withdrawal đang có unique store + idempotency key.

## 5. [P2] PATCH tồn kho vẫn kiểm tra trước khóa; tranh chấp trả lỗi DB

**Code:** [products.controller.ts](../../src/products/products.controller.ts), dòng **129**; [products.repository.ts](../../src/products/products.repository.ts), `updateInventoryStock`, dòng **293–323**.

**API:** `PATCH /api/v1/products/:id/inventory`. Đường `PUT /products/:id` đã có xử lý khóa khác; sửa đường PUT chưa bảo vệ đường PATCH này.

**Tái hiện L5, PostgreSQL thật:**

1. PATCH đọc kho `quantityOnHand=5, reservedQuantity=0`, dự định sửa tổng kho còn 2.
2. Checkout commit giữ 3 sản phẩm.
3. PATCH tiếp tục upsert tổng kho thành 2 dựa trên snapshot cũ.

CHECK `reserved_quantity <= quantity_on_hand` chặn lệnh ghi. Repository phát sinh `PrismaClientUnknownRequestError` thay vì lỗi nghiệp vụ 400/409. Test gọi repository thật, chỉ đặt barrier tại lần đọc để điều khiển lịch xen kẽ; chưa chạy race qua HTTP.

**Ảnh hưởng:** DB vẫn nhất quán nhờ CHECK; **không kết luận oversell hoặc tồn âm** trong ca này. Người dùng nhận lỗi server thay vì thông báo xung đột tồn kho. Đây là thiếu đồng bộ **Isolation**, được DB constraint chặn ở lớp cuối.

**Cần sửa:** dùng chung transaction và thứ tự khóa product/inventory với checkout; đọc lại reserved sau khóa rồi kiểm tra trước cập nhật. Ánh xạ vi phạm dự kiến thành business conflict và test đúng endpoint PATCH.

## 6. Schema test đang lệch migration: giới hạn bằng chứng cần xử lý

Truy vấn metadata READ ONLY trên `smart_order_test` cho thấy không có:

- `sp_create_order_from_button`.
- `fn_validate_order_status_transition` và `fn_sync_inventory_on_order_status_change`.
- Trigger không nội bộ trên bảng `public.orders`.

Trong khi chúng được định nghĩa ở [baseline migration](../../prisma/migrations/20261012000000_init_baseline/migration.sql), dòng **879, 921, 959, 1104–1113**, và được cập nhật ở migration `20261024170000_standardize_bank_account_and_withdrawal` / `20261030190000_rental_backfill_and_lease_hardening`.

Đây là **drift được xác nhận của DB test**, chưa kiểm tra Production. Các test repository/constraint trên DB này vẫn có giá trị trong phạm vi đã nêu, nhưng không thay thế kiểm thử schema dựng đầy đủ từ migration, nhất là luồng stored procedure của nút bấm và quy tắc chuyển trạng thái.

**Cần làm:** dựng DB test dùng riêng từ migration, kiểm kê function/trigger/index/constraint rồi chạy lại đường web/nút bấm và các race. Không dùng `db push` để bỏ qua đối chiếu function/trigger; không vô hiệu guard để chạy nhầm DB thật.

## 7. Hai khoảng trống phục hồi cần kiểm thử tiếp

Đây là kết quả đọc code, **không gộp vào 5 lỗi đã tái hiện**:

1. **Tạo PayOS link bị gián đoạn:** [payments.service.ts](../../src/payments/payments.service.ts), nhánh P2002 ở dòng 70 và `PAYMENT_LINK_CREATING` dòng 111. PENDING được ghi trước HTTP tạo link; nếu mất response hoặc process chết trước khi lưu ID, lần sau chỉ chờ record local. Chưa thấy đường phục hồi đầy đủ bằng truy vấn PayOS với orderCode đã cố định. `getPaymentLinkInformation` dòng 688 trả dữ liệu provider, không tự nối lại toàn bộ nghiệp vụ xác nhận đơn. Cần test timeout-before-send, timeout-after-provider-accept và crash-before-local-save; recover trước khi cân nhắc tạo mới.
2. **Hoàn cọc rental thiếu theo dõi tự động sau payout chưa có bằng chứng kết thúc:** [outbox-consumer.service.ts](../../src/rentals/outbox-consumer.service.ts), dòng 438–457 lưu provider ID rồi chỉ log khi verifier chưa xác nhận; handler thoát và consumer có thể đánh dấu event COMPLETED ở dòng 109–113. Refund vẫn PENDING_PAYOUT. Có đường admin `RentalsService.reconcileDepositRefundPayout` (dòng 586), nên vẫn đối soát thủ công được; chưa tìm thấy worker tự theo dõi tiếp cho đường này. Cần bổ sung lịch reconcile riêng hoặc trạng thái outbox phân biệt đã gửi với đã tất toán, không gửi payout mới để thay cho truy vấn kết quả cũ.

## 8. Những cơ chế đã có tác dụng

| Phạm vi | Cơ chế quan sát được | Bằng chứng trong lần audit |
| --- | --- | --- |
| Đặt web/đường repository nút bấm | Khóa sản phẩm/kho, sắp xếp productId; kiểm tra on-hand trừ reserved; tạo đơn và giữ kho cùng transaction | Suite 86 và control L0; chưa chứng minh đường stored procedure trên DB thiếu procedure |
| Tồn kho | CHECK `quantity_on_hand >= 0`, `reserved_quantity >= 0`, `reserved_quantity <= quantity_on_hand` | Metadata DB và L5 chặn ghi sai |
| Ví store | Shared lock helper, Decimal, unique ledger `(wallet_id,type,reference_id)` | Đọc code, metadata DB, nhóm concurrent wallet của Suite 86 |
| Withdrawal | Giữ/freeze tiền dưới khóa, unique store + key, claim/CAS, snapshot người nhận; trạng thái chưa rõ giữ tiền để đối soát | Đọc code; không chạy payout thật |
| Giao hàng/hoàn tất | Inventory, wallet, order/history trong transaction; dấu INV_SETTLED và ledger chống ghi lại | Đọc repository; chưa chạy lại mọi HTTP flow |
| Subscription | Thứ tự store → wallet → subscription; owner trial có advisory lock | Đọc code và Suite 86 |
| Billing/rental | Có receipt ledger, nghĩa vụ tiền nhận thừa, transaction approval/reservation + outbox | Đọc code; suite tiền mặt riêng hiện lỗi mock, không coi đã kiểm chứng toàn phần |

Metadata xác nhận partial unique index payment theo order/rental, unique transactionCode, wallet ledger unique và idempotency unique đang có. Isolation mặc định `read committed` **không tự nó là lỗi**; cần lock/CAS và invariant phù hợp theo nghiệp vụ.

## 9. Kiểm thử và giới hạn

| Lệnh/kiểm tra chạy trong lần audit | Kết quả |
| --- | --- |
| `node node_modules/tsx/dist/cli.mjs tests/acid-wallet-order-inventory-hardening.spec.ts` với host test được allowlist | PASS **5/5 nhóm**, PostgreSQL thật, provider I/O được mock |
| `node node_modules/tsx/dist/cli.mjs tests/acid-audit-regressions-2026-11-21.spec.ts` | Exit 1: **1 pass, 2 fail**, mock DB I/O |
| Lệnh trên thêm `--live`, host test được allowlist | Exit 1: **2 pass, 7 fail**, tương ứng **5 lỗi riêng**, không phải 7 lỗi riêng |
| `node node_modules/typescript/bin/tsc --noEmit` | PASS, exit 0 |
| `npm run build` | PASS, exit 0 |
| `node node_modules/tsx/dist/cli.mjs tests/store-cash-contract.spec.ts` | PASS; offline contract only |
| `node node_modules/tsx/dist/cli.mjs tests/store-cash-settlement.spec.ts` | FAIL trước các assertion chính: mock thiếu `buttonRental.findUnique`, tại `billing-charges.repository.ts:150`; chưa kết luận lỗi settlement thật từ failure này |
| Kiểm tra READ ONLY sau hai lần live regression | Fixture stores/users/idempotency của hai run đều 0; số row inventory/wallet vi phạm điều kiện không âm đều 0 |

Test mới [acid-audit-regressions-2026-11-21.spec.ts](../../tests/acid-audit-regressions-2026-11-21.spec.ts) cố ý giữ assertion theo hành vi mong muốn và đang đỏ để làm bằng chứng. **Chưa đăng ký vào CI runner**; chưa sửa implementation để biến test xanh. Cleanup chỉ xóa fixture của chính lần chạy.

Không chạy lại toàn bộ suite dự án; không tuyên bố toàn bộ dự án đạt ACID. Durability của hạ tầng DB (fsync/replica/failover/backup/restore) chưa được thử nghiệm. Một PostgreSQL transaction cũng không bao trùm được giao dịch PayOS bên ngoài; phần này cần idempotency bền vững, receipt ledger và cơ chế phục hồi/đối soát.

## 10. Thứ tự khắc phục đề nghị

1. Sửa F3 để trạng thái PAID không bị hạ xuống bởi callback cũ; khóa chặt ranh giới dữ liệu đã ký.
2. Sửa F1–F2 bằng ma trận trạng thái đơn/payment và nghĩa vụ hoàn theo khoản thu.
3. Sửa F4 bằng checkout identity gắn cùng transaction với order; thêm crash/retry regression.
4. Sửa F5 bằng dùng chung khóa kho, sau đó bổ sung HTTP contract test.
5. Làm sạch schema drift trên DB test dựng từ migration; kiểm chứng thêm recovery provider và worker đối soát trước khi chốt triển khai.
