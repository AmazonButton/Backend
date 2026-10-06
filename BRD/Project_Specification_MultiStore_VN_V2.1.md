# Đặc Tả Dự Án --- Hệ Thống Đặt Hàng Qua Nút Bấm IoT (Đa Cửa Hàng / Multi-Store) [Phiên Bản 2.1 - Cố Định Cửa Hàng Cho Nút]

## 1. Tổng quan dự án

Hệ thống là một nền tảng đặt hàng qua Nút bấm IoT hỗ trợ mô hình đa cửa hàng (Multi-Store).

Khách hàng sở hữu các Nút bấm IoT (IoT Button) vật lý. Mỗi Nút bấm được liên kết **cố định với một Cửa hàng (Store) cụ thể** và được cấu hình với một hoặc nhiều Sản phẩm từ Cửa hàng đó. Khi Khách hàng bấm nút, hệ thống sẽ tự động xác định Nút bấm, Khách hàng, Cửa hàng của nút, các Sản phẩm đã cấu hình kèm số lượng tương ứng và địa chỉ giao hàng, từ đó tạo ra một Đơn hàng (Order).

Hệ thống hỗ trợ nhiều Cửa hàng độc lập trong khi tài khoản của Khách hàng là duy nhất và mang tính toàn cục (Global Customer Account). Mỗi nút bấm gắn liền cố định với một Cửa hàng duy nhất từ lúc đăng ký.

---

## 2. Phạm vi dự án (Scope)

### 2.1 Trong phạm vi (In scope)

- Quản lý đa Cửa hàng (Multi-Store management).
- Quản lý tài khoản và hồ sơ Khách hàng (Customer accounts & profiles).
- Quản lý danh sách địa chỉ giao hàng của Khách hàng (bảo vệ địa chỉ mặc định duy nhất).
- Quản lý mối quan hệ Cửa hàng - Khách hàng (`STORE_CUSTOMER`).
- Quản lý nhân viên Cửa hàng và phân quyền theo vai trò (Store staff & roles).
- Quản lý Sản phẩm và Danh mục sản phẩm cách ly theo từng Cửa hàng.
- Lưu vết lịch sử thay đổi giá bán sản phẩm (`PRODUCT_PRICE_HISTORY`).
- Quản lý chương trình giảm giá sản phẩm (theo % hoặc số tiền cố định, chống chồng lấn thời gian).
- Quản lý kho hàng và tồn kho 2 bước (Inventory reservation & Two-phase commit).
- Đăng ký và cấu hình Nút bấm IoT.
- Quy tắc: Một Nút bấm thuộc về duy nhất một Khách hàng.
- **Quy tắc cốt lõi: Một Nút bấm gắn liền cố định với duy nhất một Cửa hàng trong suốt vòng đời của nút (Không chuyển đổi Cửa hàng)**.
- Quy tắc: Một Nút bấm có thể cấu hình nhiều Sản phẩm (thuộc Cửa hàng của nút đó).
- Tạo Đơn hàng độc quyền từ thao tác bấm nút vật lý.
- Stored Procedure tạo đơn hàng an toàn chống Race-condition (`sp_create_order_from_button` - All-or-Nothing).
- Tự động hoàn trả hoặc trừ tồn kho thực tế theo vòng đời đơn hàng qua Trigger.
- Thanh toán khi nhận hàng (COD hoặc PayOS QR).
- Lưu trữ bản sao dữ liệu lịch sử tại thời điểm đặt hàng (Snapshots giá bán, giảm giá, địa chỉ giao hàng).

### 2.2 Ngoài phạm vi (Out of scope)

- **Chuyển đổi Nút bấm giữa các Cửa hàng khác nhau (Mỗi nút bấm gắn cố định với một Cửa hàng)**.
- Khách hàng tự tạo đơn hàng thủ công qua Web/App.
- Biến thể sản phẩm / SKU phức tạp (Product variants/SKU).
- Quản lý Nhà cung cấp và Đơn đặt hàng nhập kho (Supplier/Purchase Order).
- Quy trình chi tiết xuất/nhập/kiểm kê kho chuyên sâu.
- Hệ thống tích điểm / Khách hàng thân thiết (Loyalty/Membership).
- Quy trình hoàn tiền (Refund workflow).
- Mô-đun khuyến mãi nâng cao / Mã giảm giá (Voucher/Promotion module).

---

## 3. Các tác nhân trong hệ thống (Actors)

### 3.1 Quản trị viên hệ thống (System Admin)
Quản trị toàn bộ hệ thống ở mức nền tảng (`SYSTEM_ADMIN`). Chi tiết phân quyền System Admin nằm ngoài phạm vi nghiệp vụ hiện tại.

### 3.2 Chủ cửa hàng (Store Owner)
Quản lý Cửa hàng (`STORE_OWNER`), nhân viên, Sản phẩm, Tồn kho, Đơn hàng, Khách hàng và các Nút bấm đang trỏ tới Cửa hàng của mình.

### 3.3 Gi?i ph�p K�nh Thu PayOS & Ghi nh?n S? c�i n?i b? (PayOS Payment Collection & Ledger)
- **Lu?ng ti?n PayOS S�n**: Ti?n thanh to�n don h�ng online c?a kh�ch h�ng ch?y v? t�i kho?n ng�n h�ng PayOS c?a S�n th�ng qua QR Payment Link.
- **X�c th?c Webhook an to�n**:
  - Backend x�c th?c ch? k� HMAC-SHA256 b?ng `checksumKey` s? d?ng thu?t to�n `crypto.timingSafeEqual` ch?ng t?n c�ng timing attack.
  - **Ch?ng duplicate webhook (Idempotency)**: N?u giao d?ch d� ? tr?ng th�i `PAID`, tr? v? HTTP 200 ngay l?p t?c, tuy?t d?i kh�ng c?ng ti?n hai l?n.
- **Ghi nh?n S? c�i Atomic (Database $transaction)**:
  - C?p nh?t `payment_transaction.status = 'PAID'`.
  - C?p nh?t `orders.order_status = 'CONFIRMED'` v� `payment_status = 'PAID'`.
  - Kh�a v� c?ng s? du v� Store: `balance_after = balance_before + amount`.
  - Ghi nh?n l?ch s? giao d?ch b?t bi?n v�o `wallet_transactions` v?i type `PAYMENT_CREDIT`.

### 3.4 Gi?i ph�p K�nh Chi PayOS Payout T? �?ng & Ch?ng Race-Condition (Automated Payout & Two-Phase Balance Lock)
- **Ph�n bi?t hai lo?i s? du**:
  - `Store Wallet`: S? c�i n?i b? trong DB c?a h? th?ng ghi nh?n kho?n ph?i tr? cho Store.
  - `PayOS Payout Account Balance`: Ngu?n ti?n th?c t? trong t�i kho?n chi c?a PayOS/B?o Kim. �i?u ki?n gi?i ng�n th�nh c�ng: `Store Wallet >= R�t` V� `PayOS Payout Balance >= R�t + Ph�`.
- **Co ch? Kh�a s? du 2-Phase (Two-Phase Balance Lock)**:
  - **Phase 1 (Reserve Balance)**: M? DB transaction, ki?m tra `balance >= amount`, l?p t?c tr? s? du v�, snapshot th�ng tin ng�n h�ng (`bank_code`, `bank_name`, `bank_account_number`, `bank_account_holder`), t?o b?n ghi `store_withdrawals` ? tr?ng th�i `PENDING`, ghi s? c�i `WITHDRAWAL_DEBIT` v� **commit ngay l?p t?c**. Tuy?t d?i kh�ng gi? DB lock trong l�c g?i API b�n th? ba.
  - **Phase 2 (G?i PayOS Payout API)**: G?i request `POST https://api-merchant.payos.vn/v1/payouts` v?i headers `x-client-id`, `x-api-key`, `x-idempotency-key` (m� `withdrawal_code`), v� ch? k� `x-signature` (thu?t to�n HMAC-SHA256 Payout ri�ng). Khi PayOS ti?p nh?n th�nh c�ng, chuy?n tr?ng th�i r�t ti?n sang `PROCESSING`.
- **Co ch? T? �?ng Ho�n Ti?n (Fail-Safe Auto-Refund)**:
  - N?u PayOS t? ch?i l?nh ngay l?p t?c ho?c g?p l?i m?ng tru?c khi t?o du?c payout: Chuy?n `store_withdrawals.status = 'FAILED'`, luu `failure_reason`.
  - M? DB transaction th? hai ho�n tr? ch�nh x�c s? ti?n v�o v� Store: `balance += amount` v� ghi nh?n s? c�i `WITHDRAWAL_REFUND`.
- **�?i so�t & C?p nh?t tr?ng th�i Payout (Reconciliation)**:
  - Tra c?u tr?ng th�i qua PayOS API: `GET /v1/payouts/{id}`.
  - Khi PayOS x�c nh?n `SUCCEEDED` -> c?p nh?t `store_withdrawals.status = 'SUCCEEDED'`.
  - Khi PayOS x�c nh?n `FAILED` -> k�ch ho?t ho�n ti?n t? d?ng v�o v�.
  - Khi PayOS dang `PROCESSING` -> **gi? nguy�n tr?ng th�i, tuy?t d?i kh�ng ho�n ti?n khi dang x? l�**.

### 3.5 Gi�m s�t T�i Kho?n Chi PayOS & Danh m?c API Endpoints
- **Gi�m s�t s? du Payout**: Admin theo d�i s? du v� chi th?c t? th�ng qua endpoint PayOS: `GET https://api-merchant.payos.vn/v1/payouts-account/balance`.
- **Danh m?c API Store Owner**:
  - `GET /api/v1/store/wallet`: Xem s? du v� v� t�i kho?n ng�n h�ng li�n k?t.
  - `PUT /api/v1/store/wallet/bank-account`: C?p nh?t th�ng tin ng�n h�ng m?c d?nh.
  - `GET /api/v1/store/wallet/transactions`: Xem sao k� l?ch s? bi?n d?ng s? du s? c�i.
  - `POST /api/v1/store/wallet/withdrawals`: T?o y�u c?u r�t ti?n (t? d?ng ph�t l?nh PayOS ho?c ch? duy?t).
  - `GET /api/v1/store/wallet/withdrawals`: L?ch s? c�c y�u c?u r�t ti?n.
  - `POST /api/v1/store/wallet/withdrawals/:id/sync-status`: Store ch? d?ng d?ng b? tr?ng th�i chi ti?n t? PayOS.
- **Danh m?c API Super Admin**:
  - `GET /api/v1/admin/payos/payout-balance`: Ki?m tra s? du t�i kho?n chi PayOS th?c t?.
  - `GET /api/v1/admin/withdrawals`: Danh s�ch to�n b? y�u c?u r�t ti?n c?a c�c Store.
  - `POST /api/v1/admin/withdrawals/:id/payout`: Admin duy?t v� k�ch ho?t chi ti?n t? d?ng qua PayOS.
  - `POST /api/v1/admin/withdrawals/:id/sync-payout`: Admin d?ng b? tr?ng th�i Payout d?i so�t.
  - `POST /api/v1/admin/withdrawals/:id/transfer`: X�c nh?n chuy?n kho?n th? c�ng (k�m h�a don ?y nhi?m chi).
  - `POST /api/v1/admin/withdrawals/:id/reject`: T? ch?i y�u c?u v� t? d?ng ho�n ti?n l?i v� Shop.
