# Kế hoạch Triển khai Xác minh Tài khoản Ngân hàng Chính chủ bằng 2.000 VND (Penny-Deposit Verification & Automated Refund)

## 1. Mục tiêu & Luồng hoạt động cốt lõi
1. **Store Owner** chọn ngân hàng (từ danh mục chuẩn NAPAS/VietQR) và nhập số tài khoản ngân hàng.
2. Hệ thống gọi tra cứu tên chủ tài khoản (Account Name Lookup).
3. Store Owner bấm **Xác minh chính chủ**:
   - Backend sinh mã đối soát ngẫu nhiên duy nhất (ví dụ: `VERIFY_8F3K2A`).
   - Cố định số tiền giao dịch chính xác là **2.000 VND** (không cho client tự truyền số tiền).
   - Thiết lập thời gian hết hạn (mặc định 30 phút).
   - Lưu trữ số tài khoản đã mã hóa AES-256-GCM và hash SHA-256.
4. **Store chuyển khoản đúng 2.000 VND** kèm nội dung chứa mã đối soát vào tài khoản nền tảng.
5. **Webhook nhận giao dịch**:
   - Xác thực chữ ký HMAC-SHA256 trên raw body byte buffer.
   - Chống replay attack và kiểm tra số tiền `amount === 2000`.
   - Khóa dòng dữ liệu bằng PostgreSQL `SELECT ... FOR UPDATE` trong transaction đơn nguyên tử.
   - Chuyển trạng thái giao dịch `PENDING` -> `RECEIVED` -> `VERIFIED`.
   - Cập nhật tài khoản ngân hàng của Store thành `OWNERSHIP_VERIFIED`.
6. **Hoàn tiền tự động (Automated Refund)**:
   - Ngay sau khi `VERIFIED`, kích hoạt payout hoàn trả đúng 2.000 VND về tài khoản đã xác minh.
   - Sử dụng Idempotency Key `REFUND_<verificationId>` để đảm bảo không bao giờ hoàn tiền 2 lần.
7. **Rút tiền (Store Withdrawal Guard)**:
   - Trong `POST /api/v1/store-wallet/withdraw`, bắt buộc tài khoản thụ hưởng phải ở trạng thái `OWNERSHIP_VERIFIED`.
   - Chặn tuyệt đối các tài khoản chưa xác minh với mã lỗi `BANK_ACCOUNT_NOT_VERIFIED`.

---

## 2. Kiến trúc Provider Adapter (Decoupled Architecture)
Để không bị phụ thuộc chặt (vendor lock-in) vào PayOS, kiến trúc áp dụng Interface Adapter Pattern:

```
[Store / Client] 
       │
       ▼
[BankVerificationController] 
       │
       ▼
[BankVerificationService] ──► [BankVerificationRepository (PostgreSQL + Row Locks)]
       │
       ▼
[BankVerificationProvider Interface]
       ├──► [PayOSBankVerificationProvider] (Mặc định)
       ├──► [VietQRBankVerificationProvider] (Tùy chọn)
       └──► [MockBankVerificationProvider] (Unit / CI Testing)
```

### Phương thức Interface `BankVerificationProvider`:
- `lookupAccount(bankBin: string, accountNumber: string)`: Tra cứu tên chủ tài khoản từ hệ thống NAPAS.
- `createRefund(params)`: Khởi tạo lệnh chi tiền hoàn trả 2.000 VND.
- `getTransaction(transactionId: string)`: Truy vấn trạng thái giao dịch từ Provider.
- `verifyWebhook(rawBody: Buffer, signature: string, headers: Record<string, string>)`: Xác thực tính toàn vẹn và nguồn gốc của Webhook.

---

## 3. Thiết kế Cơ sở Dữ liệu & Bảo mật Dữ liệu

### Bảng 1: `store_bank_accounts`
- `id`: BigInt (Primary Key)
- `store_id`: BigInt (Foreign Key -> `store.store_id`)
- `bank_bin`: VarChar(10) (Mã BIN ngân hàng 6 chữ số, ví dụ 970422)
- `bank_code`: VarChar(20) (Mã viết tắt, ví dụ MB, VCB)
- `bank_name`: VarChar(100) (Tên ngân hàng)
- `account_number_encrypted`: Text (Mã hóa đối xứng AES-256-GCM với IV và Auth Tag)
- `account_number_hash`: VarChar(64) (Blind index SHA-256 dùng để tìm kiếm và áp dụng ràng buộc duy nhất)
- `account_name`: VarChar(255) (Tên chủ tài khoản in hoa không dấu)
- `verification_status`: VarChar(32) (`PENDING`, `VERIFIED_BY_LOOKUP`, `OWNERSHIP_VERIFIED`, `SUSPENDED`, `REVOKED`)
- `is_default`: Boolean (Mặc định true)
- `verified_at`: Timestamptz
- `last_verified_at`: Timestamptz
- `created_at`, `updated_at`: Timestamptz

**Ràng buộc duy nhất:**
- `UNIQUE(store_id, account_number_hash)`: Một Store không thêm trùng số tài khoản.

### Bảng 2: `bank_account_verification_transactions`
- `id`: BigInt (Primary Key)
- `bank_account_id`: BigInt (Foreign Key -> `store_bank_accounts.id`)
- `reference_code`: VarChar(64) (Mã nội dung chuyển khoản duy nhất, ví dụ `VERIFY_8F3K2A`)
- `expected_amount`: Decimal(15, 2) (Cố định 2.000 VND)
- `received_amount`: Decimal(15, 2) (Số tiền thực nhận từ Webhook)
- `provider_transaction_id`: VarChar(128) (Mã giao dịch từ PayOS/Casso/Ngân hàng)
- `status`: VarChar(32) (`PENDING`, `RECEIVED`, `VERIFIED`, `REFUND_PENDING`, `REFUNDED`, `FAILED`, `EXPIRED`)
- `expires_at`: Timestamptz (Thời gian hết hạn yêu cầu xác minh, mặc định 30 phút)
- `verified_at`: Timestamptz
- `refund_status`: VarChar(32) (`PENDING`, `SUCCESS`, `FAILED`)
- `refund_transaction_id`: VarChar(128) (Mã giao dịch payout từ nhà cung cấp chi hộ)
- `refunded_at`: Timestamptz
- `created_at`, `updated_at`: Timestamptz

**Ràng buộc duy nhất:**
- `UNIQUE(provider_transaction_id)` (Chống xử lý lặp giao dịch)
- `UNIQUE(bank_account_id, reference_code)` (Mã đối soát là duy nhất trên mỗi tài khoản)

---

## 4. Danh sách API Endpoints

| Phương thức | Đường dẫn | Phân quyền | Chức năng |
|---|---|---|---|
| `GET` | `/api/v1/banks` | Public / Authed | Lấy danh sách ngân hàng Việt Nam (BIN, tên, mã, logo) từ NAPAS |
| `POST` | `/api/v1/stores/bank-accounts/lookup` | Store Owner / Staff | Tra cứu tên tài khoản theo BIN và số tài khoản |
| `POST` | `/api/v1/stores/bank-accounts/verification` | Store Owner | Tạo yêu cầu xác minh 2.000 VND & nhận mã chuyển khoản |
| `GET` | `/api/v1/stores/bank-accounts` | Store Owner | Danh sách tài khoản ngân hàng của Store & trạng thái xác minh |
| `POST` | `/api/v1/webhooks/bank-verification` | Provider (HMAC Guard) | Nhận webhook giao dịch 2.000 VND, xác minh chính chủ và kích hoạt hoàn tiền |

---

## 5. Quy trình Kiểm thử Nghiêm ngặt (Test Matrix)
1. **Lookup Suite**: BIN đúng, BIN sai, định dạng tài khoản sai, tài khoản không tồn tại, provider lỗi/timeout.
2. **Verification Suite**:
   - Nhận đúng 2.000 VND và đúng mã đối soát -> `OWNERSHIP_VERIFIED` + `REFUNDED`.
   - Nhận 1.000 VND hoặc 2.001 VND -> `FAILED`, tuyệt đối không xác minh quyền sở hữu.
   - Nhận sai mã đối soát -> Không khớp, từ chối.
   - Giao dịch quá hạn 30 phút -> `EXPIRED`.
3. **Concurrency & Race Condition Suite**:
   - 2 Webhook giống hệt nhau gửi tới đồng thời -> Chống trùng lặp, chỉ 1 transaction được ghi nhận.
   - 2 Webhook khác nhau cho cùng một `verification_id` -> Row locking xử lý tuần tự, trạng thái cuối cùng nhất quán.
4. **Refund Safety Suite**:
   - Payout thành công -> Cập nhật `REFUNDED`.
   - Payout lỗi -> Giữ `REFUND_PENDING` để retry, không báo thành công sai lệch.
   - Không thể hoàn tiền lần thứ hai cho cùng một giao dịch.
5. **Withdrawal Enforcement Suite**:
   - Store chưa xác minh tài khoản -> HTTP 400 `BANK_ACCOUNT_NOT_VERIFIED`.
   - Store đã xác minh chính chủ -> Rút tiền thành công.
