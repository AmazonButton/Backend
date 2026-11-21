# TÀI LIỆU MÔ TẢ 17 SƠ ĐỒ TRẠNG THÁI (STATE MACHINE DIAGRAMS)

> Tài liệu chuẩn hóa đồng bộ 100% mã, tên trang, enum database và rule chuyển trạng thái với file [`ERD_Level_3_Editable.drawio`](./ERD_Level_3_Editable.drawio) (`17` trang State Machine: `12` sơ đồ chính `[ST01]..[ST11]` gồm `ST04A/B`, và `5` sơ đồ bổ trợ `[ST-SUP1]..[ST-SUP4]` gồm `ST-SUP2A/B`).
>
> *Ghi chú di sản (`driver_shifts`)*: Vòng đời ca trực shipper cũ (`OPEN -> CLOSED -> HANDED_OVER`) đã ngừng cấp role mới và được xử lý đối soát bàn giao như quy trình di sản trong `ACT06` (`POST /legacy-handover/settle`), không còn nằm trong 17 sơ đồ trạng thái đối tượng cốt lõi hiện hành.

---

## Bảng Đối chiếu Danh mục State Diagrams

| STT | Mã & Tên trang trong Draw.io | Diagram ID | Bảng / Đối tượng Mô hình hóa |
|---|---|---|---|
| 1 | `[ST01] StoreSubscription State` | `page_st01_store_subscription` | `store_subscriptions.status` (+ `isUpcoming`/`isExpired`) |
| 2 | `[ST02] IoTButton State` | `page_st02_iot_button` | `iot_button` (`inventory_state \|\| status \|\| can_order`) |
| 3 | `[ST03] ButtonRental State` | `page_st03_button_rental` | `button_rentals.status` |
| 4 | `[ST04A] PaymentTransaction State` | `page_st04a_payment_transaction` | `payment_transactions.status` |
| 5 | `[ST04B] BillingCharge State` | `page_st04b_billing_charge` | `billing_charges.status` (+ v1 `BillingOverpaymentObligation`) |
| 6 | `[ST05] Order Status & Payment` | `page_st05_order` | `orders.order_status` (10) & `orders.payment_status` (4) |
| 7 | `[ST06] Customer Bank Verification` | `page_st06_customer_bank_verify` | `CustomerBankVerificationProof` & `CustomerBankAccount` |
| 8 | `[ST07] Store Bank Verification` | `page_st07_store_bank_verify` | `BankAccountVerificationTransaction` & `StoreBankAccount` |
| 9 | `[ST08] WarrantyTicket State` | `page_st08_warranty_ticket` | `warranty_tickets.status` |
| 10 | `[ST09] DepositRefund State` | `page_st09_deposit_refund` | `deposit_refunds.status` |
| 11 | `[ST10] StoreWithdrawal State` | `page_st10_store_withdrawal` | `store_withdrawals.status` |
| 12 | `[ST11] Store Lifecycle State` | `page_st11_store_lifecycle` | `store.status` |
| 13 | `[ST-SUP1] Didit eKYC Lifecycles` | `page_st_sup1_didit_ekyc` | `IdentityVerificationSession.status` & `User.kycStatus` |
| 14 | `[ST-SUP2A] StoreCashVoucher State` | `page_st_sup2a_store_cash_voucher` | `store_cash_vouchers.status` |
| 15 | `[ST-SUP2B] RentalReturn State` | `page_st_sup2b_rental_return` | `rental_returns.status` |
| 16 | `[ST-SUP3] Bank Refund Obligations` | `page_st_sup3_bank_refund_obligations` | `CustomerBankRefundObligation` & `StoreBankRefundObligation` |
| 17 | `[ST-SUP4] User Account & PlatformMembership Lifecycles` | `page_st_sup4_user_platform_membership` | `users.status` & `platform_memberships.status` |

---

### [ST01] Vòng đời Một Bản ghi Gói Dịch vụ Cửa hàng (`[ST01] StoreSubscription State`)
* **Bảng / Phạm vi**: 1 dòng bản ghi `store_subscriptions`.
* **Trạng thái lưu DB**: Chỉ `'ACTIVE'` và `'EXPIRED'`. Các cờ `isUpcoming` (`start_date > now`) và `isExpired` (`end_date < now`) được tính động khi đọc.
* **Chuyển trạng thái hợp lệ**:
  * Khi mua mới hoặc gia hạn (`subscribe()` / `renew-charge [BillingCharge='PAID']`), Choice ban đầu kiểm tra `activeSub.end_date > now`:
    * Nếu chưa có gói active -> vào thẳng `ACTIVE [Effective: start <= now <= end]` (mở khóa `validateStoreCanListProducts()`).
    * Nếu đang có gói active -> dòng **mới** vào `ACTIVE [isUpcoming = true]` với `start_date = activeSub.end_date`.
  * `ACTIVE [isUpcoming]` $\xrightarrow{\text{when(now >= startDate)}}$ `ACTIVE [Effective]`.
  * Trên `ACTIVE [Effective]`: lệnh `renew()` chỉ phát sinh **internal transition** (`INSERT` dòng `StoreSubscription` mới ở trạng thái queued) chứ **không** quay ngược bản ghi hiện tại về `isUpcoming`.
  * `ACTIVE [Effective]` $\xrightarrow{\text{@Cron('*/10 * * * *') [end\_date <= now]}}$ `EXPIRED` (kèm `OutboxEvent STORE_SUBSCRIPTION_EXPIRED`) $\rightarrow$ Kết thúc.

---

### [ST02] Vòng đời Thiết bị Nút bấm IoT (`[ST02] IoTButton State`)
* **Bảng**: `iot_button` (mô hình 3 trục trực giao độc lập đồng thời trên cùng thiết bị).
* **Trục 1 — `inventoryState` (Vị trí & Quyền quản lý vật lý)**:
  $$\text{IN\_PLATFORM\_WAREHOUSE} \longrightarrow \text{ALLOCATED\_TO\_STORE} \longrightarrow \text{ASSIGNED\_TO\_RENTAL} \longrightarrow \text{IN\_CUSTOMER\_CUSTODY}$$
  * Có thêm nhánh kho đổi trả `IN_STORE`, vòng thu hồi `RETURN_IN_TRANSIT` $\rightarrow$ `ALLOCATED_TO_STORE`, và nhánh hỏng/khóa `DEFECTIVE_RETURN`.
* **Trục 2 — `status` (Trạng thái vận hành / bảo hành)**:
  * `UNASSIGNED | MAINTENANCE` $\rightarrow$ `INACTIVE` $\longleftrightarrow$ `ACTIVE` $\rightarrow$ `DISABLED | LOCKED | RETIRED | SUSPENDED`.
  * *(Lưu ý DB: `iot_button_status_check` baseline liệt kê 6 giá trị `ACTIVE, INACTIVE, LOCKED, SUSPENDED, UNASSIGNED, MAINTENANCE`, trong khi `WarrantyRepository.lockDeviceAtomicTx` ghi trực tiếp `'DISABLED'` và DTO hỗ trợ `'RETIRED'`.)*
* **Trục 3 — `canOrder` (Cổng quyền bấm đặt hàng / khóa trẻ em — tách khỏi `status`)**:
  * `canOrder = false` $\longleftrightarrow$ `canOrder = true`.
  * Chuyển sang `true` khi bàn giao (`handoverRentalButtonsInTx`), gia hạn hợp đồng (`settleRentalRenewalInTx` nếu `status == 'ACTIVE'`), hoặc mở khóa thủ công thỏa toàn bộ ràng buộc. Chuyển về `false` khi khách gạt khóa trẻ em (`PATCH`), trả nút, khóa bảo hành, hoặc `RentalExpiryCron` hết hạn thuê (cron chỉ đặt `canOrder = false`, giữ nguyên `status='ACTIVE'`).
* **Điều kiện Bấm Nút Đặt hàng**: `status=='ACTIVE' ∧ inventoryState=='IN_CUSTOMER_CUSTODY' ∧ canOrder!=false ∧ buttonRental.status=='ACTIVE' ∧ effective_expires_at > NOW()`.

---

### [ST03] Vòng đời Hợp đồng Thuê Nút (`[ST03] ButtonRental State`)
* **Bảng**: `button_rentals`.
* **Chuỗi chuyển trạng thái**:
  $$\text{PENDING\_PAYMENT} \xrightarrow{\text{PayOS paid}} \text{PENDING\_HANDOVER} \xrightarrow{\text{handover}} \text{ACTIVE} \xrightarrow{\text{RentalExpiryCron}} \text{EXPIRED}$$
  * Nhánh thu tiền mặt tại quầy (`StoreCash.collect` với `handover='IMMEDIATE'`): có thể chuyển thẳng `PENDING_PAYMENT` $\rightarrow$ `ACTIVE`.
  * Nhánh hủy / kết thúc: `PENDING_PAYMENT` $\rightarrow$ `CANCELLED`; `ACTIVE | EXPIRED` $\rightarrow$ `RETURNED` (khi nhận lại toàn bộ nút); `EXPIRED` $\rightarrow$ `TERMINATED` (`PATCH /admin/rentals/:id/status`); `EXPIRED` $\xrightarrow{\text{settleRentalRenewalInTx()}}$ `ACTIVE`.

---

### [ST04A] Vòng đời Giao dịch Thanh toán & Nghĩa vụ Hoàn tiền Đơn hàng (`[ST04A] PaymentTransaction State`)
* **Cấu trúc**: 2 máy trạng thái **độc lập hoàn toàn** (không dùng Fork/Join giả) trên `payment_transaction` và `payment_refund_obligations`, liên kết với `payment_order_receipts`, `payment_refund_payout_attempts` và `payment_refund_verified_vouchers`.
* **Máy 1 — `PaymentTransaction.status` (`payment_transaction`)**:
  * Index `uq_payment_active_per_order` đảm bảo tối đa 1 giao dịch `'PENDING' | 'PAID'` trên mỗi đơn.
  * `PENDING` $\rightarrow$ `FAILED` (CAS `WHERE status = 'PENDING'` — **F3**) | `CANCELLED` | `PAID` (`webhook('00')` không sibling; chuyển khoản bổ sung trên **cùng link đã `PAID`** giữ nguyên `PAID` và sinh `PaymentOrderReceipt` + `PaymentRefundObligation 'EXCESS_DUPLICATE'` độc lập).
  * `FAILED | CANCELLED` vẫn phục hồi qua `webhook('00')` (`NV-11`) thành `PAID` (không sibling) hoặc `REFUND_PENDING` (khi đã có active sibling `PENDING | PAID`, giữ `Order.paymentStatus = 'PAID'` nếu đơn đã được giao dịch `PAID` bảo chứng).
  * `PAID | REFUND_PENDING` $\rightarrow$ `REFUNDED` **chỉ qua `settleRefundSuccessAtomicTx()`** khi có `PaymentRefundVerifiedVoucher` xác thực và toàn bộ nghĩa vụ không hủy gắn trên giao dịch đó đã hoàn tất.
* **Máy 2 — `PaymentRefundObligation.status` (`payment_refund_obligations`)**:
  * Choice khởi tạo từ `evaluateRecipientEligibilityInTx()`:
    * Đủ ĐK (`VERIFIED_MATCHED_SOURCE` — khách sở hữu đơn có TK `VERIFIED` khớp `sourceBankBin + sourceAccountHash` đã chuẩn hóa) $\rightarrow$ `READY_FOR_PAYOUT`.
    * Thiếu điều kiện (`GUEST_UNVERIFIED`, `SOURCE_INSUFFICIENT`, `SOURCE_CONFLICTING`, `CUSTOMER_NO_VERIFIED_BANK`, `LEGACY_UNCLASSIFIED`) $\rightarrow$ `PENDING_RECIPIENT_VERIFICATION` *(quarantined; cấm auto-payout)*.
  * `READY_FOR_PAYOUT` $\xrightarrow{\text{SUPER\_ADMIN claim atomic (khóa snapshot + Attempt PREPARING + Outbox)}}$ `PROCESSING_PAYOUT`.
  * `PROCESSING_PAYOUT` $\rightarrow$ `READY_FOR_PAYOUT` (PayOS từ chối pre-dispatch, `Attempt = FAILED`) | `PENDING_RECIPIENT_VERIFICATION` *(khi tái kiểm tra canonical trước POST phát hiện `sourceEvidenceStatus = CONFLICTING` trong lúc attempt còn `PREPARING` với `dispatchedAt = NULL`: hủy attempt thành `FAILED` và giữ nguyên snapshot đã khóa — **N4**)* | `PENDING_RECONCILIATION` *(chỉ sau ngưỡng POST `commitAttemptDispatchingTx()` khi timeout/indeterminate — còn lỗi `GET` trong preflight `authorizeAttemptPreflightTx()` giữ nguyên `Attempt = PREPARING` kèm `releaseAttemptPreflightRetryableTx()` để worker chạy lại an toàn — **N3**)* | `REFUNDED` (chứng từ chi hộ khớp qua `verifyPayosPayoutEvidence` + chèn `PaymentRefundVerifiedVoucher` duy nhất toàn cục).
  * Bản ghi `LEGACY_BACKFILL` chỉ được đối soát/hợp nhất khi bằng chứng PayOS API (`resolveProviderLegacyLinkEvidence`) xác nhận `PROVEN_REPLAY` (giao dịch duy nhất); nếu chưa đủ bằng chứng (`UNVERIFIED`) thì tuyệt đối không gộp chỉ dựa trên `amount` mà giữ bản ghi đến mới ở `LEGACY_UNCLASSIFIED` chờ đối soát (chưa nâng nguồn hay tự chi), và phân loại giao dịch dư đồng thời luôn đọc trạng thái `PaymentTransaction` dưới lock thay vì snapshot pre-lock (**N1/N2**).
  * Ràng buộc DB trigger `fn_enforce_payment_refund_budget()` bảo đảm tổng đã hoàn + đang dành cho hoàn $\le$ tổng `PaymentOrderReceipt` hợp lệ trên toàn đơn xuyên suốt `ORDER_REFUND` và `EXCESS_DUPLICATE`.
---

### [ST04B] Vòng đời Hóa đơn Thu phí Hệ thống (`[ST04B] BillingCharge State`)
* **Bảng**: `billing_charges` (tách riêng khỏi `PaymentTransaction`) cho 3 mục đích `RENTAL_INITIAL`, `RENTAL_EXTENSION`, `STORE_SUBSCRIPTION`.
* **Chuyển trạng thái hợp lệ**:
  * Khởi tạo: `PENDING`.
  * `PENDING` $\xrightarrow{\text{PayOS /settle hoặc StoreCash.collect [khớp totalAmount]}}$ `PAID`.
  * `PENDING` $\xrightarrow{\text{newRentalSupersedes()}}$ `CANCELLED` (khi khách tạo nháp thuê mới đè bản nháp `PENDING_PAYMENT` cũ).
* **Liên kết V1 `BillingOverpaymentObligation`**: Nếu webhook tiền thuê bị sai số / hóa đơn đã `PAID` / đã tất toán tiền mặt tại quầy, `recordRentalPayosReceiptInTx()` ghi nhận `BillingPaymentReceipt('OVERPAYMENT_RECEIPT')` và bản ghi `BillingOverpaymentObligation ('PENDING_RECONCILIATION')` (chỉ có API đọc `GET /admin/billing-overpayments`, ràng buộc `ck_billing_overpayment_status`, chưa có cơ chế tự hoàn trong v1) mà **không** thay đổi trạng thái `BillingCharge`.

---

### [ST05] Vòng đời Đơn hàng & Trạng thái Thanh toán (`[ST05] Order Status & Payment`)
* **Bảng**: `orders` — gồm **2 máy trạng thái độc lập** đặt cạnh nhau (đã bỏ Fork/Join sai ở trạng thái `PAID`).
* **Máy 1 — `Order.orderStatus` (10 trạng thái tách rời đúng DB trigger `fn_validate_order_status_transition`)**:
  $$\text{PENDING} \longrightarrow \text{CONFIRMED} \longrightarrow \text{PREPARING} \longrightarrow \text{READY\_FOR\_DELIVERY} \longrightarrow \text{SHIPPING} \longrightarrow \text{DELIVERED} \longrightarrow \text{COMPLETED}$$
  * `PENDING | CONFIRMED` $\rightarrow$ `REJECTED` (Store từ chối + trả kho).
  * `SHIPPING` $\longrightarrow$ `DELIVERY_FAILED` $\longrightarrow$ `CANCELLED` *(Ghi chú phạm vi thực tế: DB trigger `fn_validate_order_status_transition` có liệt kê `DELIVERY_FAILED -> SHIPPING`, nhưng ở tầng backend API `PATCH /status` chặn gán `SHIPPING`, `POST /claim` chỉ nhận đơn `READY_FOR_DELIVERY`, và `/fail` đã giải phóng `reserved_quantity`; do đó không mô hình hóa luồng giao lại hoạt động mà chỉ ghi nhận giới hạn trigger trong chú thích)*.
  * `PENDING | CONFIRMED | PREPARING | READY_FOR_DELIVERY | DELIVERY_FAILED` (và `SHIPPING` ở mức trigger DB) $\rightarrow$ `CANCELLED`.
  * Lưu ý DTO & quyền: `PATCH /status` cho phép `OUT_FOR_DELIVERY` map về `READY_FOR_DELIVERY` nhưng chặn gán trực tiếp `SHIPPING`, `DELIVERED`, `DELIVERY_FAILED` (phải qua `/claim`, `/deliver`, `/fail`). Hiện chỉ `STORE_OWNER`, `SYSTEM_ADMIN`, `SUPER_ADMIN` được gọi `PATCH /orders/:id/status` để chốt `COMPLETED` (`Customer` chưa có endpoint tự xác nhận hoàn tất).
* **Máy 2 — `Order.paymentStatus` (4 trạng thái tài chính độc lập)**:
  * `UNPAID` $\xrightarrow{\text{PayOS webhook('00') | COD /deliver}}$ `PAID` $\xrightarrow{\text{hủy/từ chối đơn đã trả}}$ `REFUND_PENDING` $\xrightarrow{\text{POST /orders/:id/refund}}$ `REFUNDED`.
  * `UNPAID` $\xrightarrow{\text{tiền PayOS đến muộn sau khi đơn đã hủy / đổi COD (không có sibling PAID)}}$ `REFUND_PENDING` *(khi đó `PaymentTransaction` chuyển `'PAID'`)* $\xrightarrow{\text{POST /orders/:id/refund}}$ `REFUNDED` *(hợp đồng khoản nhận thừa có sibling PAID dùng `PaymentTransaction.status = REFUND_PENDING` và giữ `Order.paymentStatus = PAID`, hiện còn mở R1/R2 về xác thực payout & thứ tự hoàn)*.
  * `PAID` chỉ là kết thúc khi đơn đã giao thành công (`DELIVERED/COMPLETED`); khi hủy đơn hoặc tiền thừa trên link cũ (F2), `Order.paymentStatus` giữ nhất quán với bản chất thanh toán của đơn.

---

### [ST06] Vòng đời Phiên Chứng minh & Tài khoản NH Khách (`[ST06] Customer Bank Verification`)
* **Cấu trúc**: 2 máy trạng thái **độc lập hoàn toàn** (không dùng Fork/Join kết thúc chung).
* **Máy 1 — `CustomerBankVerificationProof` (mỗi phiên xác minh 2.000đ, TTL 15 phút)**:
  * `ACTIVE / PENDING` $\rightarrow$ `CONSUMED / VERIFIED` (khớp giao dịch -> kích hoạt `CustomerBankAccount` -> Kết thúc phiên) | `ACTIVE / PENDING_SOURCE_EVIDENCE` (thiếu/masked sender) | `ACTIVE / FAILED_MISMATCH` (sai BIN/STK) | `EXPIRED | ABANDONED` (quá hạn 15 phút hoặc tạo phiên mới -> Kết thúc phiên).
* **Máy 2 — `CustomerBankAccount.verificationStatus` (thực thể dài hạn)**:
  * `PENDING` $\xrightarrow{\text{khi Proof đạt CONSUMED / VERIFIED}}$ `VERIFIED` (mở khóa đặt mặc định & nhận hoàn cọc `ACT13`; chỉ kết thúc khi khách xóa tài khoản không còn `DepositRefund` đang mở).

---

### [ST07] Vòng đời Giao dịch Xác minh & Tài khoản NH Store (`[ST07] Store Bank Verification`)
* **Cấu trúc**: 2 máy trạng thái **độc lập hoàn toàn** (không dùng Fork/Join kết thúc chung).
* **Máy 1 — `BankAccountVerificationTransaction` (mỗi phiên xác minh, TTL 30 phút)**:
  * `PENDING` $\rightarrow$ `EXPIRED` (`/cancel [USER_CANCELLED]` hoặc quá 30 phút) | `FAILED` (sai số tiền / BIN / STK / masked / trùng mã GD) | `VERIFIED` $\rightarrow$ `REFUND_PENDING` $\rightarrow$ `REFUNDED` (`refundStatus == 'SUCCESS'`).
* **Máy 2 — `StoreBankAccount.verificationStatus` (thực thể dài hạn)**:
  * `PENDING` $\longleftrightarrow$ `OWNERSHIP_VERIFIED` (quay lại `PENDING` nếu chủ Store đổi `bankBin/STK`; chỉ `OWNERSHIP_VERIFIED` mới được rút tiền ở `ACT10`).
  * `PENDING | OWNERSHIP_VERIFIED` $\xrightarrow{\text{adminSuspendOrRevoke()}}$ `SUSPENDED | REVOKED` (chặn `403` mọi yêu cầu xác minh lại & rút tiền).

---

### [ST08] Vòng đời Phiếu Bảo hành (`[ST08] WarrantyTicket State`)
* **Bảng**: `warranty_tickets` (partial unique `uq_warranty_tickets_pending_button` đảm bảo tối đa 1 phiếu `PENDING` mỗi nút).
* **Chuyển trạng thái**:
  * `PENDING` $\xrightarrow{\text{approveSwapAtomicTx() [GROUP\_A 1-1]}}$ `APPROVED_SWAP` (tác động cọc 0đ, tự reject các phiếu `PENDING` khác) $\xrightarrow{\text{PATCH /resolve}}$ `RESOLVED`.
  * `PENDING` $\xrightarrow{\text{lockDeviceAtomicTx() | PATCH /resolve}}$ `RESOLVED`.
  * `PENDING` $\xrightarrow{\text{PATCH /reject | bị reject do nút đổi 1-1}}$ `REJECTED`.

---

### [ST09] Vòng đời Đề nghị Hoàn tiền Cọc (`[ST09] DepositRefund State`)
* **Bảng**: `deposit_refunds` — hệ thống chỉ ghi 3 giá trị trạng thái: `'PENDING_APPROVAL'`, `'PENDING_PAYOUT'`, `'REFUNDED'`.
* **Chuyển trạng thái**:
  * Khởi tạo `'PENDING_APPROVAL'` từ `confirmReturnReceiptTx()` (`ACT13`) hoặc `lockDeviceAtomicTx()` (`ACT12`).
  * Nhánh khấu trừ 100% (`refundAmount == 0`): `PENDING_APPROVAL` $\xrightarrow{\text{approveDepositRefundTx() [Admin duyệt]}}$ `REFUNDED` (gán `WARRANTY_DEDUCTION_{id}`, bỏ qua PayOS).
  * Nhánh có hoàn tiền (`refundAmount > 0`, cần TK NH `VERIFIED`): `PENDING_APPROVAL` $\xrightarrow{\text{approveDepositRefundTx()}}$ `PENDING_PAYOUT` (chụp cứng 5 cột TK nhận + ghi `OutboxEvent DEPOSIT_REFUND_APPROVED`) $\xrightarrow{\text{OutboxConsumer(5s) / confirm-payout}}$ `REFUNDED` (nếu lỗi tạm thời giữ nguyên `PENDING_PAYOUT` để retry / chuyển `DeadLetterJob`).

---

### [ST10] Vòng đời Lệnh Rút tiền Cửa hàng (`[ST10] StoreWithdrawal State`)
* **Bảng**: `store_withdrawals`.
* **Chuyển trạng thái**:
  * `PENDING` (balance -> `frozenBalance`): `SUPER_ADMIN` `/reject` $\rightarrow$ `REJECTED` (mở phong tỏa về ví), hoặc `/payout` CAS tuần tự $\rightarrow$ `PROCESSING`.
  * `PROCESSING` (PayOS `createPayout`): nếu API lỗi / timeout / chưa xác định $\rightarrow$ `PENDING_RECONCILIATION` (**giữ nguyên `frozenBalance`**).
  * `PROCESSING | PENDING_RECONCILIATION` $\xrightarrow{\text{Webhook hoặc sync-payout/sync-status + fail-closed verifier}}$ `SUCCEEDED` (trừ vĩnh viễn `frozenBalance`) | `FAILED` (hoàn tiền ví `WITHDRAWAL_REFUND`).

---

### [ST11] Vòng đời Trạng thái Cửa hàng (`[ST11] Store Lifecycle State`)
* **Bảng**: `store` — chỉ dùng **3 giá trị** `'ACTIVE'`, `'INACTIVE'`, `'SUSPENDED'` (không tồn tại chuỗi `'PENDING'` hay `'REJECTED'` trên `Store.status`).
* **Chuyển trạng thái**:
  * Khởi tạo theo luồng: `'ACTIVE'` (mặc định `AuthService.register/googleLogin`) hoặc `'INACTIVE'` (nằm hàng đợi `GET /admin/stores/pending`).
  * `INACTIVE` $\xrightarrow{\text{POST /admin/stores/:id/approve [SUPER\_ADMIN]}}$ `ACTIVE` (đồng thời bật `user.status = 'ACTIVE'`).
  * `INACTIVE` $\xrightarrow{\text{POST /admin/stores/:id/reject [reason != empty]}}$ `SUSPENDED`.
  * `ACTIVE` $\longleftrightarrow$ `INACTIVE | SUSPENDED` (`PATCH /admin/stores/:id` bởi `SUPER_ADMIN`). Không vẽ nút kết thúc (`Final`) tại `SUSPENDED` vì trạng thái này vẫn có thể mở khóa khôi phục về `ACTIVE` và chưa có API xóa Store.
  * Các nghiệp vụ đặt hàng, thuê nút, cấp phát nút, ví Store và WebSocket room đều kiểm tra `Store.status === 'ACTIVE'`.

---

### [ST-SUP1] Vòng đời Phiên eKYC Didit & KYC Tài khoản (`[ST-SUP1] Didit eKYC Lifecycles`)
* **Cấu trúc**: 2 máy trạng thái **độc lập hoàn toàn** (không dùng Fork/Join kết thúc chung). *(Lưu ý: `CustomerProfile` không có cột `ekycStatus`; trạng thái KYC chuẩn nằm trên `User.kycStatus`.)*
* **Máy 1 — `IdentityVerificationSession.status`**:
  * `PENDING` $\rightarrow$ `IN_REVIEW` | `EXPIRED` | `ABANDONED` | `DECLINED` | `APPROVED` (đã `APPROVED` được bảo vệ chống hạ cấp).
  * Admin xóa phiên (`DELETE /sessions/:id`) $\rightarrow$ `DELETED` (xóa trên Didit & soft-delete).
* **Máy 2 — `User.kycStatus`**:
  * `UNVERIFIED` $\rightarrow$ `PENDING` (`createSession()`) $\rightarrow$ `APPROVED` (vĩnh viễn, chống hạ cấp) | `DECLINED` (chỉ chuyển khi user không còn bất kỳ phiên `APPROVED` nào khác; cho phép retry về `PENDING`).

---

### [ST-SUP2A] Vòng đời Phiếu Thu Tiền mặt Tại Quầy (`[ST-SUP2A] StoreCashVoucher State`)
* **Bảng**: `store_cash_vouchers` (tách khỏi `RentalReturn`; SQL check `ck_cash_voucher_state` và partial unique `uq_cash_voucher_active_rental` tối đa 1 voucher `ACTIVE`/hợp đồng).
* **Chuyển trạng thái**:
  * `ACTIVE` (TTL 120 phút, lưu `tokenHash`):
    * $\xrightarrow{\text{StoreCash.collect() [expires\_at > clock\_timestamp()]}}$ `CONSUMED` (trừ `StoreWallet`, tất toán `BillingCharge`).
    * $\xrightarrow{\text{Khách sinh voucher mới cùng Rental}}$ `REVOKED`.
  * Hết hạn sau 120 phút được kiểm tra động qua điều kiện `expires_at > clock_timestamp()`, không dùng enum riêng trong DB.

---

### [ST-SUP2B] Vòng đời Phiếu Trả Thiết bị Thuê (`[ST-SUP2B] RentalReturn State`)
* **Bảng**: `rental_returns` (tách khỏi `StoreCashVoucher`).
* **Chuyển trạng thái**:
  * `PENDING_RECEIPT` (`POST /rentals/:id/return-requests`: đặt nút `RETURN_IN_TRANSIT`, `canOrder=false`, phát `OutboxEvent RENTAL_RETURN_REQUESTED`) $\xrightarrow{\text{confirmReturnReceiptTx()}}$ `RECEIVED` (`STORE_OWNER` đúng kho hoặc `SYSTEM_STAFF/ADMIN/SUPER_ADMIN`: đưa nút về `ALLOCATED_TO_STORE / INACTIVE`, tạo `DepositRefund 'PENDING_APPROVAL'`, kết thúc hợp đồng về `RETURNED` khi trả hết nút).

---

### [ST-SUP3] Vòng đời Nghĩa vụ Hoàn tiền 2.000đ Xác minh NH (`[ST-SUP3] Bank Refund Obligations`)
* **Cấu trúc**: 2 máy trạng thái **độc lập hoàn toàn** (mỗi loại nghĩa vụ có Initial & Final riêng biệt, bỏ Fork/Join dùng chung):
  * **Máy 1 — `CustomerBankRefundObligation.refundStatus` (Cool-off 12h)**:
    * Choice khởi đầu (`PENDING_REFUND` nếu đủ chứng từ nguồn vs `PENDING_MANUAL_REFUND` nếu thiếu/unmatched).
    * `PENDING_REFUND` $\xrightarrow{\text{Worker (*/2m) [>=12h]}}$ `PROCESSING_REFUND` $\rightarrow$ `REFUNDED` (`Attempt == SUCCESS`) | quay về `PENDING_REFUND` (`FAILED < 3 lần`) | `PENDING_MANUAL_REFUND` (`FAILED >= 3 lần`).
  * **Máy 2 — `StoreBankRefundObligation.refundStatus` (Lease 60s)**:
    * Choice khởi đầu (`PENDING_REFUND` vs `PENDING_MANUAL_REFUND`).
    * `PENDING_REFUND` $\xrightarrow{\text{claim 60s lease}}$ `PROCESSING` $\rightarrow$ `PENDING_RECONCILIATION` (bắt buộc sau dispatch) $\xrightarrow{\text{reconcilePendingStoreRefunds()}}$ `REFUNDED` | `FAILED`.

---

### [ST-SUP4] Vòng đời Tài khoản & Quyền Platform (`[ST-SUP4] User Account & PlatformMembership Lifecycles`)
* **Cấu trúc**: 2 máy trạng thái **độc lập hoàn toàn** (không vẽ mô hình thăng chức tuyến tính `CUSTOMER -> STAFF -> ADMIN`):
* **Máy 1 — `User.status` & JWT Watermark (`users`)**:
  * Khởi tạo `ACTIVE` (hoặc `PENDING_VERIFICATION` -> `ACTIVE`).
  * `ACTIVE` $\longleftrightarrow$ `INACTIVE` (`POST /admin/users/:id/toggle-status` của `SUPER_ADMIN`). Không vẽ `Final` tại `INACTIVE` vì tài khoản vẫn có thể mở khóa quay lại `ACTIVE` (chưa có vòng kết thúc vĩnh viễn cho User). Khi khóa về `INACTIVE`: nâng `users.tokens_invalid_before`, thu hồi `refresh_tokens.is_revoked = true`, và bắn Redis `ws:auth:revoke` ngắt toàn bộ WebSocket.
* **Máy 2 — `PlatformMembership.status` (`platform_memberships` — bản ghi append-only bất biến)**:
  * Cấp mới (`POST /admin/users/:id/platform-role`): kiểm tra `!isBootstrapAdminConflict` & `!(SYSTEM_STAFF && ownedStores > 0)` $\rightarrow$ tạo bản ghi `ACTIVE` (`roleCode ∈ {SUPER_ADMIN, SYSTEM_ADMIN, ADMIN, SYSTEM_STAFF}`).
  * Thu hồi (`DELETE /admin/users/:id/platform-role` hoặc khi bị thay thế bởi lần grant vai trò khác): `ACTIVE` $\rightarrow$ `REVOKED` (dòng cũ giữ nguyên lịch sử, không xóa DB; kèm nâng watermark JWT + ngắt socket).
  * Phân giải quyền cuối (`resolveAuthority()`): Bootstrap SuperAdmin $\rightarrow$ `PlatformMembership ACTIVE` ưu tiên cao nhất $\rightarrow$ Sở hữu Store (`STORE_OWNER`) $\rightarrow$ `CUSTOMER`.
