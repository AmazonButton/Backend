# TÀI LIỆU MÔ TẢ 20 SƠ ĐỒ HOẠT ĐỘNG (ACTIVITY DIAGRAMS)

> Tài liệu chuẩn hóa đồng bộ 100% mã, tên trang và luồng nghiệp vụ với file [`ERD_Level_3_Editable.drawio`](./ERD_Level_3_Editable.drawio) (`20` trang Activity: `17` luồng nghiệp vụ chính `[ACT01]..[ACT15]` gồm `ACT07A/B` & `ACT08A/B`, và `3` luồng bổ trợ `[ACT-SUP1]..[ACT-SUP3]`).

---

## Bảng Đối chiếu Danh mục Activity Diagrams

| STT | Mã & Tên trang trong Draw.io | Diagram ID | Nhóm |
|---|---|---|---|
| 1 | `[ACT01] Register Verify & Login` | `page_act01_auth_register_login` | Chính |
| 2 | `[ACT02] Store Registration & Approval` | `page_act02_store_onboarding_approval` | Chính |
| 3 | `[ACT15] Store Subscription Purchase & Renewal` | `page_act15_store_subscription` | Chính |
| 4 | `[ACT03] Prepare Store for Selling` | `page_act03_store_preparation` | Chính |
| 5 | `[ACT04] Warehouse Intake & Button Allocation` | `page_act04_warehouse_allocate_buttons` | Chính |
| 6 | `[ACT05] Rent IoT Button & Handover` | `page_act05_rental_and_handover` | Chính |
| 7 | `[ACT06] Button Pairing & Configuration` | `page_act06_pairing_and_config` | Chính |
| 8 | `[ACT07A] Customer Bank Verification` | `page_act07a_customer_bank_verify` | Chính |
| 9 | `[ACT07B] Store Bank Verification` | `page_act07b_store_bank_verify` | Chính |
| 10 | `[ACT08A] Website Storefront Order & Checkout` | `page_act08a_web_storefront_order` | Chính |
| 11 | `[ACT08B] IoT Button Order Placement` | `page_act08b_iot_button_order` | Chính |
| 12 | `[ACT09] Order Processing & Delivery POD` | `page_act09_order_process_deliver_pod` | Chính |
| 13 | `[ACT14] Order Cancellation, Payment Switch & Late Receipt` | `page_act14_order_cancel_switch_late_receipt` | Chính |
| 14 | `[ACT10] Store Withdrawal & PayOS Payout` | `page_act10_store_withdrawal_payout` | Chính |
| 15 | `[ACT11] Rental Contract Extension` | `page_act11_rental_extension` | Chính |
| 16 | `[ACT12] Warranty Intake & Handling` | `page_act12_warranty_handling` | Chính |
| 17 | `[ACT13] Button Return & Deposit Refund` | `page_act13_return_and_deposit_refund` | Chính |
| 18 | `[ACT-SUP1] Didit eKYC Verification` | `page_act_sup1_didit_ekyc` | Bổ trợ |
| 19 | `[ACT-SUP2] Store Cash Voucher Collection` | `page_act_sup2_store_cash_collection` | Bổ trợ |
| 20 | `[ACT-SUP3] Admin RBAC Grant/Revoke & Account Lock` | `page_act_sup3_admin_rbac_lock` | Bổ trợ |

---

### [ACT01] Đăng ký, Xác minh Email & Đăng nhập (`[ACT01] Register Verify & Login`)
* **Swimlanes**: `User (Customer / Store Owner)` | `System`
* **Luồng chạy**:
  1. Người dùng gửi thông tin đăng ký (`POST /api/v1/auth/register`). Hệ thống kiểm tra DTO, băm mật khẩu bằng Argon2id và khởi tạo bản ghi `users(is_verified=false)`, đồng thời gửi email OTP xác minh bất đồng bộ.
  2. Người dùng gửi mã OTP (`POST /api/v1/auth/verify-email`). Nếu hợp lệ và còn hạn, hệ thống đánh dấu `users.is_verified = true`; ngược lại trả `400 Invalid Token`.
  3. Khi đăng nhập bằng mật khẩu (`POST /api/v1/auth/login`) hoặc Google OAuth (`POST /api/v1/auth/google`), hệ thống xác thực thông tin và kiểm tra `user.status === 'ACTIVE'`.
  4. Hệ thống phân giải quyền thông qua `resolveAuthority` (`authority.policy`), cấp cặp JWT + Refresh Token (`AuthSession`) và điều hướng về Workspace tương ứng (`Marketplace`, `/store/me`, hoặc cổng quản trị `SYSTEM_STAFF / ADMIN / SUPER_ADMIN`).

---

### [ACT02] Đăng ký Cửa hàng & Duyệt Hồ sơ (`[ACT02] Store Registration & Approval`)
* **Swimlanes**: `Store Owner` | `ADMIN` | `System`
* **Luồng chạy**:
  1. Chủ cửa hàng gửi hồ sơ đăng ký Store (tên, địa chỉ, số điện thoại). System tạo bản ghi `Store`: mặc định luồng đăng ký tự động tạo ở trạng thái `'ACTIVE'`, hoặc vào `'INACTIVE'` nếu qua hàng đợi duyệt.
  2. Nếu Store vào hàng đợi duyệt (`GET /admin/stores/pending` truy vấn `status = 'INACTIVE'`), `SUPER_ADMIN` xem xét hồ sơ pháp lý:
     * **Từ chối (`POST /admin/stores/:id/reject`)**: bắt buộc có lý do, cập nhật `Store.status = 'SUSPENDED'` và gửi thông báo từ chối.
     * **Phê duyệt (`POST /admin/stores/:id/approve`)**: kích hoạt `Store.status = 'ACTIVE'` và `User.status = 'ACTIVE'`, thông báo cho chủ Store để bắt đầu chuẩn bị bán hàng (`ACT15` / `ACT03`).

---

### [ACT15] Mua & Gia hạn Gói Dịch vụ Cửa hàng (`[ACT15] Store Subscription Purchase & Renewal`)
* **Swimlanes**: `Store Owner` | `System (Subscriptions & Billing)` | `PayOS & Cron Worker`
* **Luồng chạy**:
  1. Chủ Store chọn gói dịch vụ và hình thức đăng ký qua `POST /store/subscriptions/subscribe` (Ví/Trial) hoặc `POST /store/subscriptions/renew-charge` (PayOS/Trial).
  2. **Nhánh Gói dùng thử (Trial — `price == 0` hoặc `planCode` chứa `'TRIAL'`)**: System khóa tư vấn `pg_advisory_xact_lock('trial_sub_owner:' || ownerUserId)` và kiểm tra `hasUsedTrialSubscription()` trên toàn bộ Store của chủ sở hữu (mỗi `ownerUserId` chỉ được dùng 1 lần). Nếu hợp lệ thì cấp mới dòng `StoreSubscription`.
  3. **Nhánh Ví Store (`Store Wallet` — `/subscribe`)**: Lock `store` -> `store_wallets` (`FOR UPDATE`), đối chiếu `SubscriptionIdempotencyKey` (409 nếu sai payload, Replay nếu trùng key/hash), kiểm tra số dư ví. Nếu đủ dư thì trừ ví, ghi sổ `WalletTransaction (SUBSCRIPTION_PAYMENT)` và lưu khóa idempotency `'COMPLETED'`.
  4. **Nhánh PayOS (`/renew-charge`)**: System tạo `BillingCharge (purpose='STORE_SUBSCRIPTION', status='PENDING')` và sinh link PayOS. Khi PayOS bắn webhook `POST /payments/payos/webhook` với chữ ký HMAC hợp lệ, `code == '00'`, đúng tiền tệ `VND` và đúng số tiền, `settleChargeAtomicTx()` cập nhật `BillingCharge -> 'PAID'` và xuất `OutboxEvent (BILLING_CHARGE_SETTLED)`.
  5. **Cộng nối thời hạn (`Stacking`)**: Không sửa đổi dòng `StoreSubscription` đang chạy; hệ thống **INSERT một bản ghi `StoreSubscription` mới** (`status='ACTIVE'`) với `startDate = max(now, activeSub.end_date)`.
  6. **Cron Hết hạn & Chặn Đăng bán**: `RentalExpiryCronService (@Cron '*/10 * * * *')` quét các gói hết hạn (`FOR UPDATE SKIP LOCKED`), chuyển sang `'EXPIRED'`. Khi không còn gói `ACTIVE` hiệu lực, hàm `validateStoreCanListProducts()` chặn `403` các thao tác đăng/bật sản phẩm mới cho tới khi gia hạn lại.

---

### [ACT03] Chuẩn bị Cửa hàng để Bán hàng (`[ACT03] Prepare Store for Selling`)
* **Swimlanes**: `Store Owner` | `System (Stores & Products)`
* **Luồng chạy**:
  1. Song song (Fork/Join): Chủ cửa hàng cập nhật hồ sơ địa chỉ/tọa độ (`PATCH /store/me`) và đảm bảo có gói dịch vụ hiệu lực thông qua quy trình con `«callBehavior» ACT15`.
  2. Chủ cửa hàng tạo danh mục, sản phẩm và tồn kho (`POST /store/categories`, `POST /store/products`, `PATCH /products/:id`).
  3. System chạy `validateStoreCanListProducts()` (bỏ qua chỉ khi `SUPER_ADMIN / SYSTEM_ADMIN` tạo hộ). Nếu gói không hiệu lực hoặc đang `Upcoming`/`EXPIRED`, trả lỗi `403` (`Flow Final`); ngược lại lưu sản phẩm + tồn kho vào DB và đưa Catalog lên trạng thái sẵn sàng nhận đơn Web/IoT.

---

### [ACT04] Nhập kho Nút bấm & Cấp phát Về Cửa hàng (`[ACT04] Warehouse Intake & Button Allocation`)
* **Swimlanes**: `SYSTEM_STAFF / ADMIN` | `Store Owner` | `System`
* **Luồng chạy**:
  1. `SYSTEM_STAFF / ADMIN` nhập lô thiết bị, cấu hình mẫu nút bấm và kiểm tra chất lượng phần cứng/firmware (`QC`).
  2. Nút lỗi QC chuyển `status = 'MAINTENANCE'`; nút đạt được cấp khóa bí mật và đưa vào `IN_PLATFORM_WAREHOUSE`.
  3. `SYSTEM_STAFF / ADMIN` thực hiện cấp phát cho Store mục tiêu (`allocate-store`) -> `inventoryState = 'ALLOCATED_TO_STORE'`.
  4. Chủ Store nhận hàng vật lý và gọi `confirm-receipt`, chốt quyền quản lý tại Store ở trạng thái `ALLOCATED_TO_STORE`, `status = 'INACTIVE'`, `canOrder = false`.

---

### [ACT05] Thuê Nút bấm IoT & Bàn giao Khách hàng (`[ACT05] Rent IoT Button & Handover`)
* **Swimlanes**: `Customer` | `ADMIN / Store Owner` | `System`
* **Luồng chạy**:
  1. Khách chọn gói thuê nút, số lượng và cửa hàng đại lý. System tạo đơn thuê nháp `ButtonRental ('PENDING_PAYMENT')` và `BillingCharge ('PENDING')`.
  2. Khách thanh toán tiền cọc/phí qua PayOS (`settleInitialRentalInTx()` -> `PENDING_HANDOVER`) hoặc thu tiền mặt tại quầy qua `StoreCashVoucher` (`ACT-SUP2`, `STORE_CASH_OFFSET`).
  3. `ADMIN / Store Owner` gán thiết bị vào hợp đồng (`assign-fulfillment` -> `ASSIGNED_TO_RENTAL`) và xác nhận bàn giao vật lý (`handoverRentalButtonsInTx()`), đưa nút sang `IN_CUSTOMER_CUSTODY`, `status = 'ACTIVE'`, `canOrder = true`, ghi sổ tiền cọc và thời hạn hợp đồng (`startDate`, `endDate`).

---

### [ACT06] Ghép nối Wi-Fi & Cấu hình Sản phẩm Nút bấm (`[ACT06] Button Pairing & Configuration`)
* **Swimlanes**: `Customer` | `System`
* **Luồng chạy**:
  1. Khách đánh thức chế độ AP của nút bấm, quét mã QR/serial để Claim (`confirmPairingAtomicTx()`). Hệ thống kiểm tra phiên, quyền sở hữu, hợp đồng `ACTIVE` và chuyển quyền nắm giữ `IN_CUSTOMER_CUSTODY`.
  2. Khách cấu hình Store, sản phẩm, số lượng mặc định, địa chỉ giao và cửa sổ hủy (`cancelWindowSeconds` mặc định 60 giây).
  3. Hệ thống kiểm tra gói Store + tồn kho sản phẩm hợp lệ, tăng `configVersion`, lưu cấu hình binding và đồng bộ profile runtime Wi-Fi/MQTT; nút đạt trạng thái sẵn sàng bấm đặt hàng (`ACT08B`).

---

### [ACT07A] Xác minh Tài khoản Ngân hàng Khách hàng 2.000đ (`[ACT07A] Customer Bank Verification`)
* **Swimlanes**: `Customer` | `System`
* **Luồng chạy**:
  1. Khách gửi BIN ngân hàng và số tài khoản nhận hoàn cọc. System mã hóa AES-256-GCM, băm SHA-256, lưu mask `******1234` ở trạng thái `PENDING` và mở phiên `CustomerBankVerificationProof (ACTIVE, TTL 15 phút)`.
  2. Khách chuyển khoản 2.000đ kèm mã tham chiếu (`memo ref`).
  3. Khi nhận webhook hoặc poll (với grace period webhook 5m vs `/verify` 0m), hệ thống đối chiếu số tiền, mã BIN, hash STK nguồn và mức độ che dấu (`unmasked sender`). Nếu thiếu dữ liệu đánh dấu `PENDING_SOURCE_EVIDENCE` / `FAILED_MISMATCH`.
  4. Khi khớp hợp lệ, CAS phiên chứng minh sang `CONSUMED / VERIFIED`, nâng `CustomerBankAccount` sang `'VERIFIED'` và tạo `CustomerBankRefundObligation ('PENDING_REFUND')` kèm thời gian chờ 12h (cool-off) để hoàn trả lại 2.000đ cho khách.

---

### [ACT07B] Xác minh Tài khoản Ngân hàng Cửa hàng (`[ACT07B] Store Bank Verification`)
* **Swimlanes**: `Store Owner` | `System`
* **Luồng chạy**:
  1. Chủ Store khai báo tài khoản nhận tiền (`PUT /store/wallet/bank-account`). System mã hóa AES-256-GCM + hash + mask, đặt `StoreBankAccount = 'PENDING'` và khởi tạo `BankAccountVerificationTransaction ('PENDING', TTL 30 phút)`.
  2. Chủ quán có thể hủy phiên (`USER_CANCELLED -> EXPIRED`) hoặc chuyển 2.000đ để xác minh.
  3. Khi nhận webhook trong cửa sổ 30 phút, unmasked và khớp toàn phần BIN/STK/số tiền, hệ thống cập nhật tài khoản Store sang `'OWNERSHIP_VERIFIED'` (mở khóa rút tiền ở `ACT10`), ghi nhận giao dịch `'VERIFIED'` và kích hoạt hoàn 2.000đ thông qua `StoreBankRefundObligation` (60s lease -> `PENDING_RECONCILIATION -> REFUNDED`).

---

### [ACT08A] Đặt hàng Website Storefront (`[ACT08A] Website Storefront Order & Checkout`)
* **Swimlanes**: `Buyer (Web / Guest)` | `System (API, Idempotency & DB TX)` | `PayOS & Lifecycle Worker`
* **Luồng chạy**:
  1. Khách gửi yêu cầu tạo đơn Web (`POST /api/v1/storefront/orders` kèm `Idempotency-Key`).
  2. `IdempotencyInterceptor` kiểm tra khóa 30s (`IdempotencyKey`): nếu đã `COMPLETED` trả lại kết quả cached; nếu còn lease đang xử lý trả `409 Conflict` (`Flow Final`).
  3. Trong giao dịch `createStorefrontOrderTx`: System khóa tư vấn `pg_advisory_xact_lock` và kiểm tra cột định danh bền vững trên bảng `orders(checkout_actor_scope, checkout_idempotency_key)` (bản vá **F4**):
     * Khác `SHA-256 checkout_request_hash` -> trả `422 IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD`.
     * Trùng hash (khởi động lại sau crash sau khi đã commit đơn) -> phục hồi và trả đúng `Order` cũ, **không giữ kho lần thứ hai**.
  4. Khóa đúng thứ tự `Store (FOR SHARE) -> Product ASC -> Inventory ASC (FOR UPDATE)`, áp `ProductDiscount`, kiểm tra tồn khả dụng và tổng đơn `>= 2,000 VND`. Chèn `Order ('WEB-...', PENDING, UNPAID)`, cộng `reserved_quantity`, commit và bắn `ORDER_CREATED`.
  5. Chọn phương thức *(tách hai nhánh xử lý `COD` và `PAYOS`, hội tụ qua nút UML Merge trước khi kiểm tra 15 phút)*:
     * **`COD`**: Chờ chủ Store xác nhận (`CONFIRMED` trong `ACT09`), hoặc `OrdersLifecycleWorker (@Interval 5s)` theo dõi đơn COD quá 15 phút vẫn `PENDING & UNPAID` để tự hủy (`CANCELLED`) và hoàn lại `reserved_quantity`.
     * **`PAYOS`**: Tạo `PaymentTransaction (PENDING)` + link PayOS. Khi nhận webhook `'00'` hợp lệ trong 15 phút, `confirmPaymentAtomicTx()` chuyển đơn sang `CONFIRMED / PAID` để đi tiếp sang `ACT09`; quá hạn 15 phút chưa trả -> Worker tự hủy giải phóng kho.

---

### [ACT08B] Đặt hàng Một chạm Bằng Nút Bấm IoT (`[ACT08B] IoT Button Order Placement`)
* **Swimlanes**: `IoT Button (ESP32-S3)` | `System (HmacAuth, Iot & Orders)` | `Goong Map / Customer App`
* **Luồng chạy**:
  1. Nút ESP32-S3 gửi `POST /iot/events` kèm các header chữ ký `x-device-id`, `x-timestamp`, `x-nonce`, `x-signature`.
  2. `HmacAuthGuard` kiểm tra độ lệch thời gian (`|now - ts| <= 300s`), kiểm tra `button.status === 'ACTIVE'`, xác thực HMAC-SHA256 (`crypto.timingSafeEqual`) trước rồi mới ghi `device_nonces` (TTL 5 phút chống replay -> `409 REPLAY_DETECTED`).
  3. Phân nhánh `eventType`: `HEARTBEAT` trả `DEVICE_HEARTBEAT_ACK` + kiểm tra pin yếu `< 20%`; `CANCEL` kiểm tra cửa sổ hủy `cancelWindowSeconds (60s)` và gọi quy trình hủy `ACT14`.
  4. Với nhấn đặt hàng (`SINGLE_PRESS` / `DOUBLE_PRESS` / `LONG_PRESS`): kiểm tra `debounce 2,500ms` và giành lease 30s trên `iot_idempotency_keys`; nếu trùng `COMPLETED` trả `isDuplicate: true`.
  5. Xác nhận trạng thái nút (`status='ACTIVE'`, `inventoryState='IN_CUSTOMER_CUSTODY'`, `canOrder != false`, `ButtonRental ACTIVE` chưa hết hạn, tổng tiền `>= 2,000 VND`) và kiểm tra khoảng cách giao hàng qua **Goong Distance Matrix <= 5,000m** (nếu ngoài phạm vi giao: gửi thông báo `DELIVERY_INELIGIBLE` và **xóa sạch** cooldown + `iot_idempotency_keys` để không kẹt nút).
  6. Chạy `sp_create_order_from_button` (hoặc fallback TX `createOrderFallbackTx`) khóa `iot_button -> button_rentals -> product -> inventory`, tăng `reserved_quantity`, tạo đơn `PENDING / UNPAID`, đánh dấu lease `COMPLETED`, phát WebSocket `BUTTON_PRESSING` / `ORDER_CREATED` + FCM Push và trả JSON ACK (backend không trả payload điều khiển LED phần cứng).
  7. Hết cửa sổ hủy `cancelWindowSeconds` (mặc định 60s), `OrdersLifecycleWorker (5s)` tự động chuyển `PENDING -> CONFIRMED` để sang `ACT09`.

---

### [ACT09] Xử lý Đơn hàng & Giao hàng Kèm Chứng từ POD (`[ACT09] Order Processing & Delivery POD`)
* **Swimlanes**: `Store Owner / Admin` | `Customer` | `System (Orders, Inventory & StoreWallet)`
* **Luồng chạy**:
  1. `Store Owner / Admin` nhận đơn `PENDING (COD)` hoặc `CONFIRMED (PayOS/IoT)` hoặc từ chối (`POST /orders/:id/reject`, hoàn lại tồn kho giữ chỗ + đặt `Order.paymentStatus = REFUND_PENDING` nếu đơn đã `PAID`).
  2. `Store Owner / Admin` chuyển trạng thái tuần tự `CONFIRMED -> PREPARING -> READY_FOR_DELIVERY` (qua `PATCH /orders/:id/status`) rồi nhận giao `POST /orders/:id/claim` (`-> SHIPPING`, kiểm tra DB trigger `fn_validate_order_status_transition`).
  3. Khi giao hàng:
     * **Thất bại (`POST /orders/:id/fail`)**: bắt buộc ảnh chứng cứ -> `DELIVERY_FAILED` + giải phóng `reserved_quantity` *(lưu ý: API hiện chưa hỗ trợ giao lại `DELIVERY_FAILED -> SHIPPING`)*.
     * **Thành công (`POST /orders/:id/deliver`)**: bắt buộc ảnh POD (`stores/{storeId}/pod/`). Hệ thống thực thi **một transaction nguyên tử duy nhất `completeDeliveryAtomicTx()`** *(không tách Fork/Join)*: trừ kho thực `quantity_on_hand` & `reserved_quantity` (`[INV_SETTLED]`), cập nhật `Order -> DELIVERED & PAID` + POD URL, và **chỉ cộng doanh thu `ORDER_REVENUE` vào `StoreWallet` nếu `effectivePaymentMethod === 'PAYOS'`** (`COD` không cộng ví Store).
  4. Khách nhận hàng vật lý (thanh toán COD nếu có) và xem ảnh POD. Sau đó `Store Owner / Admin` gọi `PATCH /orders/:id/status { status: 'COMPLETED' }` để chốt đơn (`OrdersController` hiện chỉ mở cho `STORE_OWNER`, `SYSTEM_ADMIN`, `SUPER_ADMIN`; chức năng Customer tự xác nhận nhận hàng chưa có endpoint triển khai).

---

### [ACT14] Hủy Đơn, Đổi Phương thức Thanh toán & Tiền Đến Muộn (`[ACT14] Order Cancellation, Payment Switch & Late Receipt`)
* **Swimlanes**: `Customer` | `Owner / Admin / SUPER_ADMIN` | `System (Orders, Payments & Refunds)` | `PayOS Gateway` *(toàn bộ nhánh hội tụ đều đi qua nút UML Merge tương ứng trước action/decision kế tiếp)*
* **Luồng chạy**:
  1. **Nhánh A — Đổi Phương thức Thanh toán (`POST /payments/orders/:id/payment-method`)**: Chỉ cho phép Khách sở hữu đơn hoặc Admin (Chủ Store bị cấm `403`). Yêu cầu `orderStatus == 'PENDING'` và `paymentStatus != 'PAID'`. Transaction `changePaymentMethodTx()` chuyển các `PaymentTransaction` đang `PENDING -> CANCELLED`, đổi `Order.paymentMethod (PAYOS <-> COD)`, và hợp lưu với nhánh hủy đơn qua Merge để gọi PayOS hủy link QR cũ hậu commit.
  2. **Nhánh B — Hủy Đơn (`POST /orders/:id/cancel` hoặc IoT `CANCEL`)**: Phân nhánh tác nhân (`Customer` vs `Store Owner / SystemAdmin / SuperAdmin`) rồi hội tụ qua Merge trước kiểm tra BOLA/idempotency/state (`ADMIN` bị áp giới hạn cửa sổ không đặc quyền; chặn hủy khi `SHIPPING`, `DELIVERED`, `COMPLETED`; kiểm tra 60s với IoT & `PENDING|CONFIRMED` với Web của Khách). Khi hợp lệ, `cancelOrderAtomicTx()` trả lại `reserved_quantity`, hợp lưu hủy link PayOS nếu còn `PENDING`, và nếu đơn đã `PAID` thì đặt `Order.paymentStatus -> REFUND_PENDING` đồng thời gọi `ensureOrderRefundObligationsForCancelledOrderInTx()` tạo sẵn `PaymentRefundObligation ('ORDER_REFUND')` từ sổ cái `PaymentOrderReceipt`.
  3. **Nhánh C — Xử lý PayOS Webhook Muộn / Trùng Chuyển Khoản / Lỗi & Hoàn Tiền Xác Thực (F1, F2 Full, F3)**:
     * Xác thực chữ ký HMAC, kiểm tra `data.code` đã ký (**F3**; không `00` thì CAS `WHERE status = 'PENDING'` sang `FAILED`) và trích xuất chứng từ nguồn (`extractInboundPaymentSourceEvidence` + `normalizeBankBin`; nếu thiếu/che/unmapped hoặc xung đột thì vẫn ghi nhận khoản thu `PaymentOrderReceipt` bình thường, tuyệt đối không làm rơi tiền, nhưng đánh dấu `sourceEvidenceStatus`).
     * `confirmPaymentAtomicTx()` thực hiện **dưới row lock theo thứ tự chuẩn** (`orders -> payment_transaction -> receipts -> obligations -> attempts`) để phân loại đúng trạng thái và số tiền kể cả khi các webhook đến đồng thời (**N2**). Khi giao dịch gốc còn placeholder `LEGACY_BACKFILL`, `PaymentsService.resolveProviderLegacyLinkEvidence()` kiểm tra bằng chứng trực tiếp từ PayOS `GET /v2/payment-requests/{id}`: chỉ hợp nhất qua `reconcileLegacyBackfillReceiptInTx()` khi provider xác nhận duy nhất giao dịch khớp (**PROVEN_REPLAY**, **N1**); nếu provider chứng minh có >= 2 giao dịch (`PROVEN_INDEPENDENT_EXCESS`) thì ghi `EXCESS_DUPLICATE` tách biệt khỏi `LEGACY_BACKFILL`; nếu chưa đủ bằng chứng (`UNVERIFIED`, kể cả khi trùng số tiền), tuyệt đối không ghi đè `LEGACY_BACKFILL` chỉ dựa theo `amount` mà giữ chứng từ đến mới ở trạng thái `LEGACY_UNCLASSIFIED` chờ đối soát, chưa nâng nguồn hay tự động tạo lệnh chi. Lưu `PaymentOrderReceipt` duy nhất theo `(provider, channel, providerTransactionRef)`: đơn PayOS đang tiến triển (`CONFIRMED`, `PREPARING`, ...) -> `PAID` (**F1**); chuyển khoản thứ 2+ trên **cùng `paymentLinkId`** hoặc link cũ có sibling `PAID` -> sinh `PaymentOrderReceipt` + `PaymentRefundObligation ('EXCESS_DUPLICATE')` độc lập trong khi **giữ `Order.paymentStatus = 'PAID'`**; đơn đã `CANCELLED/REJECTED/DELIVERY_FAILED` hoặc đổi `COD` -> `Order.paymentStatus = REFUND_PENDING` + `ORDER_REFUND`.
     * **Quy trình Chi Hoàn Tiền (`PaymentRefundsService`, chỉ `SUPER_ADMIN`)**: cả `POST /orders/:id/refund`, `POST /payments/transactions/:id/refund-excess`, lẫn `POST /admin/payment-refunds/obligations/:id/payout` (cấm `STORE_OWNER`, `ADMIN`, `SYSTEM_ADMIN` -> `403`, vô hiệu hóa chốt tay `MANUAL_*_REFUND_DEPRECATED`) đều hội tụ qua kiểm tra `evaluateRecipientEligibilityInTx()` (Guest, thiếu/che/unmapped nguồn, xung đột hoặc chưa có TK `VERIFIED` khớp nguồn bị giữ ở `PENDING_RECIPIENT_VERIFICATION` và chặn auto-payout) + ràng buộc bảo toàn DB (`fn_enforce_payment_refund_budget`), khóa snapshot thụ hưởng + tạo `PaymentRefundPayoutAttempt ('PREPARING')` cố định `payoutReference` + `OutboxEvent ('PAYMENT_REFUND_PAYOUT')`. Trước khi gọi PayOS `POST /v1/payouts`: thực thi `authorizeAttemptPreflightTx()` giữ `PREPARING` kèm lease ngắn để tra cứu `GET` (nếu `GET` lỗi tạm thời thì trả `PREFLIGHT_RETRY_PENDING` qua `releaseAttemptPreflightRetryableTx()` để worker hồi phục mà không kẹt vào `PENDING_RECONCILIATION` — **N3**), rồi mới tái khóa canonical trong `commitAttemptDispatchingTx()` để chặn tức thì mọi attempt chưa gửi nếu nguồn vừa bị replay đánh dấu `CONFLICTING` (**N4**, hạ nghĩa vụ về `PENDING_RECIPIENT_VERIFICATION` mà không sửa cột snapshot đã khóa) trước khi chuyển `DISPATCHING` và gửi `POST`. Chỉ các attempt đã vượt qua ngưỡng `POST` (`dispatchedAt != null` / timeout) mới giữ `PENDING_RECONCILIATION` cho `PaymentRefundWorkerService` / `POST /webhooks/payos/payout` đối soát bằng chính `payoutReference` cũ; chỉ đóng `REFUNDED` khi `verifyPayosPayoutEvidence` xác thực và chèn `PaymentRefundVerifiedVoucher` duy nhất toàn cục. *(Cả 2 chiều hoàn đơn chính trước / hoàn khoản dư trước hay đồng thời đều chạy độc lập.)*

---

### [ACT10] Rút tiền Cửa hàng & Đối soát PayOS Payout (`[ACT10] Store Withdrawal & PayOS Payout`)
* **Swimlanes**: `Store Owner` | `SUPER_ADMIN` | `System (Wallet & PayOS)`
* **Luồng chạy**:
  1. Chủ Store tạo lệnh rút (`>= 50,000 VND`, `Idempotency-Key`, TK `OWNERSHIP_VERIFIED`). System giải mã + đối chiếu hash TK, khóa `store_wallets FOR UPDATE`, chuyển `balance -> frozenBalance`, tạo `StoreWithdrawal ('PENDING')` và sổ cái `WITHDRAWAL_DEBIT`.
  2. `SUPER_ADMIN` xét duyệt (`POST /admin/withdrawals/:id/reject` vs `/payout`; đường `/transfer` thủ công bị vô hiệu hóa vĩnh viễn `MANUAL_TRANSFER_DEPRECATED`):
     * Nếu từ chối (`/reject`): nhả `frozenBalance -> balance`, ghi `WITHDRAWAL_REFUND`, đặt `'REJECTED'`.
     * Nếu phát lệnh (`/payout`) — **thực thi tuần tự tuyệt đối**:
       * **Bước 1 (`CAS Claim`)**: chạy `UPDATE store_withdrawals SET status='PROCESSING' WHERE id=$1 AND status='PENDING'`. Nếu `count === 0` (worker khác đã giành quyền), dừng ngay trả `409/400` (`Flow Final`), ngăn chặn tuyệt đối 2 worker cùng phát lệnh chuyển khoản.
       * **Bước 2 (`PayOS createPayout`)**: chỉ gọi `POST /v1/payouts` (`x-idempotency-key`, timeout 10s) **sau khi CAS Claim thành công**.
  3. **Xử lý kết quả gọi PayOS**:
     * Nếu API lỗi / timeout / chưa rõ (`catch`): chuyển sang **`PENDING_RECONCILIATION`** và **giữ nguyên `frozenBalance` bị phong tỏa** (tuyệt đối không hoàn tiền ngay khi chưa rõ kết quả ngân hàng).
     * Nếu API trả `code == '00'`: lưu `providerPayoutId` và giữ `'PROCESSING'`.
  4. **Bước 3 — Đối soát Cuối**: Thông qua webhook `POST /webhooks/payos/payout` hoặc sync (`POST /admin/withdrawals/:id/sync-payout` / `/store/wallet/withdrawals/:id/sync-status`), chạy trình xác thực đóng-lỗi `verifyPayosPayoutEvidence` / `RejectionEvidence`:
     * Chưa xác định rõ -> giữ trạng thái chờ (`Flow Final`).
     * Xác nhận `FAILED/REJECTED` -> mở phong tỏa hoàn tiền ví (`WITHDRAWAL_REFUND`), set `'FAILED'`.
     * Xác nhận `SUCCEEDED` -> trừ vĩnh viễn `frozenBalance`, set `'SUCCEEDED'`.
     * Hai nhánh kết thúc (`FAILED` và `SUCCEEDED`) hội tụ qua nút **Merge** trước khi Chủ Store xem biến động số dư và sổ cái cập nhật.

---

### [ACT11] Gia hạn Hợp đồng Thuê Nút (`[ACT11] Rental Contract Extension`)
* **Swimlanes**: `Customer` | `System`
* **Luồng chạy**:
  1. Khách yêu cầu gia hạn hợp đồng thuê nút trong tập trạng thái cho phép (`RENEWABLE_RENTAL_STATES`).
  2. System tính phí gia hạn (`BillingCharge` `purpose='RENTAL_EXTENSION'`), khóa hợp đồng bằng `extendRentalAtomicTx()`, hủy link/chứng từ cũ nếu cần và phát sinh thanh toán qua PayOS hoặc đối trừ chính sách.
  3. Khi nhận webhook thanh toán đủ tiền (`settleRentalRenewalInTx()`), hệ thống cộng dồn thời hạn (`effectiveExpiresAt`/`endDate`), kích hoạt lại `ButtonRental` từ `EXPIRED -> ACTIVE`, khôi phục `IoTButton.canOrder = (status === 'ACTIVE')` và xuất `OutboxEvent (BILLING_CHARGE_SETTLED)`.

---

### [ACT12] Tiếp nhận & Xử lý Bảo hành Nút bấm (`[ACT12] Warranty Intake & Handling`)
* **Swimlanes**: `Owner / Customer` | `ADMIN / SYSTEM_STAFF` | `System`
* **Luồng chạy**:
  1. Chủ Store hoặc Nhân viên/Admin tạo phiếu bảo hành `WarrantyTicket ('PENDING')` cho nút hỏng (mỗi nút tối đa 1 phiếu `PENDING`).
  2. `SYSTEM_STAFF / ADMIN` đánh giá nhóm lỗi (`GROUP_A/B`: 0% khấu trừ, `GROUP_C`: 30%, `GROUP_D`: 70–100%):
     * **Đổi 1-1 (`approveSwapAtomicTx()`, chỉ `GROUP_A`)**: Đưa nút cũ sang `DEFECTIVE_RETURN / INACTIVE`, gắn nút mới cùng cấu hình sản phẩm vào hợp đồng hiện tại (`APPROVED_SWAP`, tác động tiền cọc = 0đ), tự động `REJECTED` các phiếu `PENDING` khác trên nút cũ.
     * **Khóa nút hỏng (`lockDeviceAtomicTx()`)**: Chuyển nút sang `DISABLED / DEFECTIVE_RETURN`, tách khỏi hợp đồng, tạo bản ghi `DepositRefund ('PENDING_APPROVAL')` theo tỷ lệ khấu trừ tính từ `rental_deposits.held_amount`, đóng phiếu sang `'RESOLVED'`. (Nếu chỉ từ chối/đóng không đổi: `PATCH /reject` hoặc `/resolve`).

---

### [ACT13] Trả Nút, Kiểm tra Thiết bị & Hoàn Tiền Cọc (`[ACT13] Button Return & Deposit Refund`)
* **Swimlanes**: `Customer` | `Store Owner / SYSTEM_STAFF` | `ADMIN / SUPER_ADMIN` | `System & Outbox Worker`
* **Luồng chạy**:
  1. Khách gửi yêu cầu trả nút (`POST /rentals/:id/return-requests`, chưa bắt buộc có TK NH xác minh ngay lúc gửi) -> `createReturnRequestTx()` tạo `RentalReturn ('PENDING_RECEIPT')` và khóa đặt hàng (`RETURN_IN_TRANSIT`, `canOrder=false`).
  2. Chủ Store / `SYSTEM_STAFF` nhận nút vật lý, kiểm tra và xác nhận (`confirmReturnReceiptTx()`) -> `RentalReturn = 'RECEIVED'`, nút về `ALLOCATED_TO_STORE / INACTIVE`, khởi tạo `DepositRefund ('PENDING_APPROVAL')` (hoặc đến từ nhánh khóa bảo hành ở `ACT12`).
  3. **Kiểm tra điều kiện TK NH trước duyệt hoàn tiền**: Nếu `refundAmount > 0` mà Khách chưa có TK NH `VERIFIED`, giữ `DepositRefund` ở `PENDING_APPROVAL` và nhắc khách hoàn tất `«callBehavior» ACT07A` (`Flow Final`).
  4. **Duyệt Tài chính qua `ADMIN / SUPER_ADMIN` (`POST /rentals/refunds/:refundId/approve` — `SYSTEM_STAFF` bị chặn `403`)**:
     * Hệ thống thực hiện **một giao dịch nguyên tử duy nhất `approveDepositRefundTx()`**: khóa `deposit_refunds` & `rental_deposits FOR UPDATE`, chuyển `held_amount -> refund_reserved_amount`, rồi rẽ nhánh theo số tiền hoàn ròng:
       * **Nhánh khấu trừ 100% (`refundAmount == 0`)**: Vẫn **bắt buộc đi qua bước Admin duyệt ở trên**, nhưng bỏ qua kiểm tra TK ngân hàng và bỏ qua bước Outbox chuyển khoản; gán `status = 'REFUNDED'`, `providerReferenceId = 'WARRANTY_DEDUCTION_{id}'` ngay khi commit transaction!
       * **Nhánh hoàn tiền (`refundAmount > 0`)**: Khóa TK NH `VERIFIED`, chụp cứng 5 cột thông tin nhận tiền lên `deposit_refunds`, CAS `PENDING_APPROVAL -> PENDING_PAYOUT` và ghi `OutboxEvent ('DEPOSIT_REFUND_APPROVED')` trong **cùng transaction** rồi `COMMIT`.
  5. **Worker Hậu Commit (`OutboxConsumerService @Interval 5s`)**: Dùng `FOR UPDATE SKIP LOCKED` đọc outbox, kiểm tra `getPayouts()` chống bắn trùng, gọi PayOS `createPayout` và kiểm chứng qua `verifyDepositRefundPayoutEvidence`:
     * Xác thực thành công -> `confirmDepositRefundPayoutTx()` chuyển `PENDING_PAYOUT -> REFUNDED` (`refund_reserved -> refunded_amount`).
     * Lỗi/chưa rõ -> retry backoff tối đa 3 lần (quá 3 lần đẩy vào `DeadLetterJob 'DEAD'`, chờ `SUPER_ADMIN` xử lý thủ công qua `/admin/rentals/refunds/:id/confirm-payout`).

---

### [ACT-SUP1] Định danh Điện tử Didit eKYC (`[ACT-SUP1] Didit eKYC Verification`)
* **Swimlanes**: `User (Customer / Store Owner)` | `System`
* **Luồng chạy**:
  1. Người dùng yêu cầu mở phiên eKYC (`POST /identity-verifications/sessions`); hệ thống tạo (hoặc tái sử dụng phiên `PENDING` còn hạn) trên Didit và chuyển `User.kycStatus = 'PENDING'`.
  2. Khách chụp giấy tờ và quét sinh trắc học liveness trên Hosted URL của Didit.
  3. Khi nhận webhook `POST /webhooks/didit` (đã xác thực chữ ký HMAC-SHA256 + bảng chống trùng `didit_webhook_events`), hệ thống áp dụng luật chống hạ cấp (`anti-downgrade`):
     * Nếu `APPROVED` -> khóa `IdentityVerificationSession = 'APPROVED'` và `User.kycStatus = 'APPROVED'`.
     * Nếu `DECLINED / EXPIRED / IN_REVIEW` -> cập nhật trạng thái phiên tương ứng; riêng `User.kycStatus` chỉ chuyển `'DECLINED'` khi user **không có** bất kỳ phiên `'APPROVED'` còn hiệu lực nào khác.

---

### [ACT-SUP2] Thu Tiền mặt Tại Quầy Bằng StoreCashVoucher (`[ACT-SUP2] Store Cash Voucher Collection`)
* **Swimlanes**: `Customer` | `Store Owner` | `System`
* **Luồng chạy**:
  1. Khách đang có đơn thuê `PENDING_PAYMENT` tạo mã phiếu thu tại quầy (`POST /rentals/:id/cash-vouchers`). Hệ thống thu hồi các voucher `ACTIVE` cũ của hợp đồng đó sang `REVOKED` và tạo một mã mới `ACTIVE` (TTL 120 phút, lưu `tokenHash`).
  2. Khách trình mã và thanh toán tiền mặt trực tiếp tại quầy cho Chủ Store.
  3. Chủ Store bấm thu tiền (`StoreCash.collect`). Hệ thống kiểm tra voucher còn `ACTIVE`, `expires_at > NOW()` và số dư ví `StoreWallet` đủ đối trừ; trong cùng transaction, trừ ví Store (`RENTAL_CASH_COLLECTION_OFFSET`), tiêu dùng voucher sang `CONSUMED`, thanh toán `BillingCharge -> 'PAID'` và bàn giao/kích hoạt thiết bị (`ACT05`).

---

### [ACT-SUP3] Admin Cấp/Thu hồi Quyền Platform & Khóa Tài khoản Realtime (`[ACT-SUP3] Admin RBAC Grant/Revoke & Account Lock`)
* **Swimlanes**: `SUPER_ADMIN` | `System (AdminService & PostgreSQL)` | `EventsGateway & Redis PubSub` | `Target User (API & WS)`
* **Luồng chạy**:
  1. `SUPER_ADMIN` thực hiện cấp vai trò platform (`POST /admin/users/:id/platform-role`), thu hồi vai trò (`DELETE /admin/users/:id/platform-role`), hoặc khóa/mở khóa tài khoản (`POST /admin/users/:id/toggle-status`).
  2. Hệ thống khóa dòng user (`lockUserForWatermark` `FOR UPDATE`) và kiểm tra xung đột bắt buộc:
     * Chặn sửa/thu hồi đối với **Bootstrap SuperAdmin** (`403 BOOTSTRAP_SUPER_ADMIN_PROTECTED`).
     * Chặn gán `SYSTEM_STAFF` cho người đang sở hữu Store (`409 ROLE_CONFLICT_STORE_OWNER`).
  3. Cập nhật bảng `PlatformMembership` theo cơ chế append-only (cấp mới = `REVOKED` dòng cũ + `INSERT` dòng `ACTIVE` mới) hoặc đảo `User.status ('ACTIVE' <-> 'INACTIVE')`; hai nhánh cập nhật hội tụ qua nút **Merge** trước khi kiểm tra thu hồi phiên.
  4. **Thu hồi Phiên & Ngắt Socket Realtime (khi Grant / Revoke / Lock -> `INACTIVE`)**:
     * Trong cùng transaction DB: nâng cột `users.tokens_invalid_before = GREATEST(...)` và đánh dấu `refresh_tokens.is_revoked = true`, sau đó `COMMIT`.
     * Hậu commit: `EventsGateway.disconnectUserSockets(userId)` gửi sự kiện `'auth:revoked'` tới các kết nối hiện tại trên node cục bộ đồng thời phát qua Redis PubSub `'ws:auth:revoke'` để tất cả các instance backend khác đồng loạt ngắt WebSocket của người dùng đó.
  5. Lần gọi API / Refresh Token / kết nối WebSocket tiếp theo bị `JwtStrategy` và `AuthService.refresh` chặn `401 Unauthorized` (do `iat <= tokensInvalidBefore` hoặc `status != ACTIVE`), buộc Target User phải đăng nhập lại (`ACT01`) để nhận đúng quyền mới (nếu tài khoản đang mở).
