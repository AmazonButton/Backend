# Review sơ đồ BRD — 2026-11-02

## Phạm vi và kết quả

- File: [ERD_Level_3_Editable.drawio](./ERD_Level_3_Editable.drawio).
- Đã kiểm tra nội dung XML/đồ thị của đủ 20 trang, đối chiếu với Prisma schema và các module nguồn được ghi bên dưới.
- ERD: CHỈ BÁO CÁO, KHÔNG CHỈNH SỬA. 56 bảng hiện có so với 60 model trong schema workspace.
- Đã sửa 19 trang activity/state: 8 trang viết lại cấu trúc luồng, 11 trang sửa nhãn/điều kiện/phạm vi. Giữ nguyên ID và thứ tự 20 trang.
- Sửa trực tiếp file theo sự đồng ý của người dùng; KHÔNG dùng MCP (phiên không có MCP Draw.io).
- Đây là đối chiếu tài liệu với source đang có, gồm thay đổi chưa commit; không phải xác nhận source không còn lỗi hay DB production đã triển khai.
- Không sửa source backend, migration, cấu hình, không gọi PayOS hoặc database.

## I. ERD — quan hệ sai / thiếu, chỉ báo cáo

### 1. Thiếu 4 bảng và các liên kết nghiệp vụ tương ứng

| Bảng thiếu | Quan hệ cần thể hiện |
|---|---|
| customer_bank_verification_proofs | customer_profile → proofs; customer_bank_accounts → proofs; con trỏ verified_by_transaction_id đến inbound cùng proof |
| customer_bank_inbound_transactions | proof → nhiều inbound (proof có thể NULL); self-reference merged_into_inbound_id cho observation đã ghép |
| customer_bank_refund_obligations | inbound → tối đa một obligation; obligation → nhiều payout attempts; con trỏ active_payout_attempt_id thuộc chính obligation |
| customer_bank_refund_payout_attempts | obligation → nhiều attempts; UNIQUE(obligation_id, attempt_number); tối đa một attempt đang xử lý |

Nguồn: [Prisma schema](../prisma/schema.prisma), migration [four entities](../prisma/migrations/20261101130000_customer_bank_penny_deposit_four_entities/migration.sql).

Cần thể hiện thêm:
- UNIQUE(provider, channel, provider_transaction_ref), không coi reference độc lập là duy nhất toàn hệ thống.
- Inbound chưa đủ reference chỉ là observation: không mặc định mọi inbound đều có obligation.
- Composite FK (proof.id, verified_by_transaction_id) → inbound(proof_id, id).
- Composite FK (obligation.id, active_payout_attempt_id) → attempt(obligation_id, id).
- Đây là ràng buộc trong file schema/migration; không suy ra đã áp dụng trên production.

### 2. Có 10 đường quan hệ chưa gắn đầy đủ đầu mút

Kiểm tra source/target và chuỗi parent trong XML. Đường có thể nhìn như chạm bảng do tọa độ, nhưng không có liên kết cấu trúc đầy đủ; đây không phải bằng chứng đường đang nối vào một bảng khác.

| Edge ID | Quan hệ dự kiến / xử lý đề xuất |
|---|---|
| 30A9bzpUEQ7j0Tngwrvw-1206 | STORE → INVENTORY (storeId); đã có edge_inv_store, cần kiểm tra đường dư khi sửa sau |
| 30A9bzpUEQ7j0Tngwrvw-1207 | PRODUCT → INVENTORY (productId) |
| 30A9bzpUEQ7j0Tngwrvw-1209 | CUSTOMER_PROFILE → IOT_BUTTON (customerId) |
| 30A9bzpUEQ7j0Tngwrvw-1213 | PRODUCT → BUTTON_PRODUCT (productId) |
| 30A9bzpUEQ7j0Tngwrvw-1219 | ORDERS → ORDER_STATUS_HISTORY (orderId) |
| 30A9bzpUEQ7j0Tngwrvw-1455 | STORE_SUBSCRIPTIONS → SUBSCRIPTION_IDEMPOTENCY_KEYS; đã có edge_sik_sub |
| edge_users_notifications | USERS → NOTIFICATIONS (userId) |
| edge_users_fcm | USERS → USER_FCM_TOKENS (userId) |
| edge_sw_wallet | STORE_WALLETS → STORE_WITHDRAWALS (walletId) |
| edge_br_deposit | BUTTON_RENTALS → RENTAL_DEPOSITS (rentalId) |

Không có đường nào được tự sửa trong lượt này.

### 3. Sai cardinality hoặc thiếu tính tùy chọn

Các đường dưới đang dùng endArrow=ERmany nhưng unique key quy định tối đa một bản ghi con:

| Quan hệ | Cardinality theo schema |
|---|---|
| USERS → CUSTOMER_PROFILE | một user có 0..1 profile; mỗi profile thuộc đúng một user (userId unique) |
| STORE → STORE_WALLETS | một store có 0..1 wallet; mỗi wallet thuộc một store (storeId unique) |
| USERS → DRIVER_DUTIES | một user có 0..1 duty (driverId unique) |
| BUTTON_RENTALS → RENTAL_DEPOSITS | một rental có 0..1 deposit ledger (rentalId unique); cạnh hiện còn bị rời đầu mút |
| RENTAL_RETURNS → DEPOSIT_REFUNDS | tối đa một refund mỗi return (returnId unique); refund.returnId nullable; nhãn 1:1 hiện mâu thuẫn ký hiệu many |

Các FK nullable cần ký hiệu 0..1 phía cha thay vì mặc định bắt buộc 1: ví dụ product.categoryId, iot_button.customerId/addressId/rentalId/custodyStoreId, orders.customerId/buttonId/assignedDriverId, payment_transaction.orderId/rentalId và deposit_refunds.bankAccountId/returnId. Chọn ký hiệu theo đúng từng field, không thay toàn bộ quan hệ thành optional.

### 4. Thiếu quan hệ giữa các bảng đã có

Ngoài các cạnh bị rời đầu mút ở mục 2:
- STORE → IOT_BUTTON qua custodyStoreId: tách khỏi storeId phục vụ đơn hàng.
- STORE → BUTTON_RENTALS qua fulfillmentStoreId.
- USERS → DRIVER_SHIFTS qua confirmedByUserId: tách khỏi driverId.
- IOT_BUTTON → RENTAL_RETURNS qua buttonId.
- BUTTON_RENTALS → DEPOSIT_REFUNDS qua rentalId.
- CUSTOMER_PROFILE → DEPOSIT_REFUNDS qua customerId.
- CATEGORY self-reference phải ghi cặp (storeId, parentCategoryId), không chỉ parentCategoryId.

Không tự biến mọi cột có hậu tố _id thành FK vật lý. Các liên kết polymorphic target_type/target_id và các cột audit actor cần phân biệt quan hệ logic với constraint thật. Chẳng hạn DeviceNonce/PairingToken/ProvisioningSession không khai báo Prisma @relation tương ứng trong schema hiện tại; nếu muốn vẽ như FK vật lý cần đối chiếu migration/catalog DB thay vì chỉ dựa trên tên cột.

### 5. Thiếu field phục vụ biểu diễn quan hệ/luồng hiện tại

| Bảng | Field có trong schema nhưng thiếu ở sơ đồ |
|---|---|
| device_movements | movement_id, source_type, source_store_id, dest_type, dest_store_id, rental_id |
| billing_charges | charge_code, target_type, target_id, payment_method, qr_code, payment_link_id, checkout_url, provider_transaction_code |
| billing_charge_lines | duration_unit, duration_count |

Đặc biệt target_type/target_id của billing_charges là liên kết đa hình: nên ghi rõ loại đối tượng được phép, không vẽ một FK giả đến đồng thời rental và subscription.
device_movements đang dùng tên trường khác source; báo cáo này chỉ liệt kê phần thiếu, không chỉnh ERD.

## II. Activity / State — các chỉnh sửa đã thực hiện

| Trang | Điều chỉnh và căn cứ |
|---|---|
| STATE 1 — Order | POD + assigned driver cho DELIVERED; bỏ khẳng định auto-complete 24h/loyalty; completion là thao tác riêng. orders.service.ts, orders.repository.ts, dto/update-order-status.dto.ts |
| STATE 2 — IoT | Ghi rõ conceptual lifecycle không phải một DB enum; HMAC thay ED25519; canOrder + expiry; replay bị từ chối không đồng nghĩa tự đổi status; maintenance/retirement ghi proposed. devices.service.ts, provisioning.service.ts |
| STATE 3 — Withdrawal | Viết lại PENDING → PROCESSING; nhánh đối soát giữ frozen; chỉ terminal evidence mới success/fail. APPROVED là hành động, không ép thành status. admin.service.ts, store-wallet.service.ts |
| STATE 4 — Rental | PENDING_PAYMENT → PENDING_HANDOVER → ACTIVE; bàn giao mới bắt đầu hạn; EXPIRED, trả từng nút và refund tách biệt; bỏ grace 7 ngày. billing-charges.repository.ts, rentals.repository.ts, rental-expiry-cron.service.ts |
| STATE 5 — eKYC | users.kyc_status=APPROVED; không ngưỡng sinh trắc 95% tự đặt; expiry theo provider; endpoint identity-verifications/sessions. identity-verifications service/repository |
| STATE 6 — Shift | OPEN → CLOSED → HANDED_OVER; Duty ONLINE/OFFLINE độc lập; ghi cả direct handover hiện được source cho phép, không coi đây là khuyến nghị nghiệp vụ. driver-shifts.service.ts, drivers.service.ts |
| STATE 7 — Bank | Tách session/account/receipt/obligation/attempt; late receipt không tự xác minh; observation không sinh tiền; refund theo amount thực; thiếu nguồn thì manual hold; ambiguity không terminal. customers.repository.ts, customer-bank-penny-verification.service.ts |
| STATE 8 — Subscription | 60k/tháng; hết hạn chặn listing; bỏ Free tier/grace 7 ngày; ghi đường mua bằng ví và billing riêng. store-subscriptions service/repository, rental-expiry-cron.service.ts |
| STATE 9 — Payment | Phân biệt trạng thái link provider và PaymentTransaction local; chữ ký+binding+amount; không coi timeout là FAILED; trả tiền chưa bật nút. payments.service.ts/repository.ts |
| ACT 1 — Zero-touch | devices/bootstrap + HMAC trước nonce; customer confirmation có ownership; không khẳng định đo đạc firmware pin/deep-sleep. provisioning.controller.ts/service.ts |
| ACT 2 — Order | Thêm entitlement, tenant mapping; cancel window cấu hình; bỏ tự động GPS/settlement sau POD. orders.service.ts |
| ACT 3 — PayOS payment | Canonical signed data + idempotency + amount/target; redirect UI không là bằng chứng; rental chờ handover. payments.service.ts, billing-charges.repository.ts |
| ACT 4 — Store payout | Viết lại nhánh unknown/timeout giữ frozen và quay lại reconcile; tách verified success/failure. admin.service.ts, store-wallet.service.ts |
| ACT 5 — Rental | Đủ payment → allocation → handover → expiry/renewal/return → receive → approve → payout; cọc không đi vào StoreWallet. rentals.repository.ts |
| ACT 6 — Dispatch | Ca do driver start; duty tách shift; POD chỉ DELIVERED; chốt CLOSED rồi HANDED_OVER; không giả định GPS streaming. driver-shifts.service.ts, orders.service.ts |
| ACT 7 — Phone auth | Firebase SDK quản lý OTP; backend xác minh Firebase ID token, không dùng email auth_otps cho SMS; bỏ ngưỡng khóa tự đặt. auth.service.ts, firebase-phone.service.ts |
| ACT 8 — Product/discount | Thêm subscription gate; product_discount đúng tên; không suy diễn minimum-order-value của campaign; mutual exclusivity. store-subscriptions.service.ts, product-discounts module |
| ACT 9 — Dispute | Giữ bản đề xuất nhưng đánh dấu PROPOSED ONLY; không khẳng định có policy 72h, PayOS reversal, Order.REFUNDED hay refund_transactions. OrderStatus/schema và tìm kiếm orders/payments |
| ACT 10 — Bank | Viết lại reference missing vs receipt mismatch; activation độc lập refund; actual amount; Nest cron 2 phút; thiếu evidence/ambiguous phải chờ. customer-bank-refund.worker.ts và penny service |

Đọc các trang mới theo tên bảng/trạng thái cụ thể: chữ EXPIRED, PENDING hay FAILED có thể thuộc các entity khác nhau, không phải một enum dùng chung.

## III. Kiểm chứng và giới hạn

- XML parse toàn file: PASS.
- 20 trang, giữ nguyên ID/thứ tự: PASS.
- ID mxCell không trùng trong từng trang: PASS.
- 19 trang activity/state: parent, source/target và edge geometry hợp lệ: PASS.
- ERD SHA-256 trước/sau trùng: E72CE7D5255178EEB4D68ACB0C64E5404636A7822CE2988311882C989EC3D976.
- git diff --check: PASS, chỉ cảnh báo LF/CRLF.
- Các cạnh ERD rời vẫn giữ nguyên đúng yêu cầu.
- Chưa kiểm chứng hình ảnh render trong Draw.io Desktop; không tìm được executable qua PATH/các đường dẫn dò được và truy vấn registry gặp lỗi cast. Không tuyên bố đã kiểm tra trực quan từng connector.
- Sơ đồ là tổng quan nghiệp vụ, không thay thế full API contract hay test FSM. Các nhánh lỗi chi tiết chưa được vẽ hết; không chứng nhận backend production.
- Không thay đổi những file source/config đang dirty từ trước. Không commit/push.

## IV. Bước tiếp theo

1. Mở file bằng Draw.io để kiểm tra bố cục 8 trang đã viết lại; nếu cần, điều chỉnh đường đi cạnh nhưng giữ nguyên guard/nhãn.
2. Chủ dự án duyệt riêng các đề xuất ERD ở mục I trước khi cho phép sửa.
3. Chốt có triển khai order dispute hay không; hiện trang ACT 9 chỉ là đề xuất, không dùng làm hợp đồng frontend.

