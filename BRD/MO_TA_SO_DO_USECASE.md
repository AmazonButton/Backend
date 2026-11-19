# TÀI LIỆU MÔ TẢ SƠ ĐỒ USE CASE HỆ THỐNG (USE CASE DIAGRAM)
> Phân rã chức năng toàn bộ hệ thống Backend theo từng Vai trò (Roles & Actors)

---

## 1. TỔNG QUAN RANH GIỚI HỆ THỐNG (SYSTEM BOUNDARY)
* **Tên sơ đồ**: `[UC] Core System Use Case Diagram` (trong file `ERD_Level_3_Editable.drawio`).
* **Ranh giới**: Khung bao bọc `IOT CLICK-TO-ORDER PLATFORM (BACKEND ARCHITECTURE)`.
* **Cấu trúc**: Gồm 5 nhóm Tác nhân (Actors) tương tác với các Use Cases cốt lõi theo mô hình phân quyền `CUSTOMER → STORE_OWNER → SYSTEM_STAFF → ADMIN / SUPER_ADMIN` (đã ngừng cấp `STORE_STAFF` và `STAFF_DELIVERY` / Shipper riêng của cửa hàng):
  1. *Cột 1*: Các chức năng dành cho Khách hàng (`CUSTOMER`) & Thiết bị Nút bấm IoT (`ESP32-S3`).
  2. *Cột 2*: Các chức năng Thanh toán, Bảo hành thiết bị & Tự giao vận / POD của Chủ cửa hàng (`STORE_OWNER`).
  3. *Cột 3*: Các chức năng Kho nút bấm & Bảo hành (`SYSTEM_STAFF`) cùng Quản trị Nền tảng & Duyệt Tài chính (`ADMIN / SUPER_ADMIN`).

---

## 2. DANH SÁCH USE CASE THEO TỪNG VAI TRÒ (ACTORS)

### 👤 1. Khách hàng (Customer)
* **Đăng ký & Đăng nhập**: Xác thực qua mã OTP số điện thoại hoặc tài khoản Google.
* **Xác thực danh tính eKYC**: Tải ảnh 2 mặt CCCD và quét khuôn mặt 3D để đủ điều kiện mượn nút bấm.
* **Xác minh tài khoản ngân hàng**: Quét mã VietQR chuyển 2.000đ để định danh tài khoản nhận tiền hoàn cọc (được hoàn lại ngay 2.000đ).
* **Ghép nối nút bấm (Zero-Touch)**: Quét mã QR trên thân nút để nhận quyền sở hữu vào tài khoản.
* **Đặt hàng bằng nút bấm vật lý**: Nhấn nút ESP32 để kích hoạt đơn hàng mặc định chỉ trong 1 giây.
* **Đặt hàng qua ứng dụng**: Mở app di động duyệt sản phẩm và bấm mua thủ công.
* **Cấu hình nút bấm & Khóa trẻ em**: Đổi món, đổi số lượng mặc định, hoặc bật chế độ khóa an toàn khi vắng nhà.
* **Yêu cầu đổi cửa hàng phục vụ**: Chuyển nút sang đại lý khác gần nhà hơn mà không cần trả lại nút phần cứng.
* **Theo dõi đơn hàng & Lộ trình**: Xem trạng thái chuẩn bị hàng và vị trí di chuyển của tài xế trên bản đồ.
* **Trả nút & Nhận lại tiền cọc**: Gửi yêu cầu chấm dứt hợp đồng mượn nút và nhận lại tiền đặt cọc về tài khoản ngân hàng.
* **Quản lý sổ địa chỉ giao hàng**: Thêm, sửa, xóa và chọn địa chỉ mặc định nhận hàng.

---

### 🏪 2. Chủ cửa hàng (Store Owner — `STORE_OWNER`)
* **Đăng ký mở đại lý liên kết**: Nộp hồ sơ xin làm đối tác, đính kèm giấy phép kinh doanh (GPKD) và tài khoản nhận doanh thu.
* **Quản lý sản phẩm & Bảng giá**: Tạo sản phẩm mới, thiết lập giá bán gốc, khuyến mãi (Flash Sale) và tồn kho hàng hóa (`inventory`).
* **Tiếp nhận đơn, Tự giao hàng & Tải ảnh bằng chứng (POD)**: Xác nhận đơn, đóng gói, tự nhận giao đơn từ hàng đợi (`delivery-queue`), cập nhật giao thành công (`DELIVERED`) hoặc thất bại (`FAILED`) kèm tải ảnh/xem ảnh chứng từ POD qua Presigned URL (chỉ trong phạm vi `storeId` của mình).
* **Thu hồi & Tất toán bàn giao legacy**: Giành quyền xử lý các đơn `SHIPPING` tồn đọng từ tài khoản shipper cũ (`takeover-delivery`) và đối soát ca/tiền COD còn mở (`/legacy-handover/settle`).
* **Quản lý hợp đồng thuê nút & Bảo hành cửa hàng**: Theo dõi nút bấm thuộc cửa hàng và gửi/theo dõi phiếu bảo hành cho thiết bị của quán.
* **Quản lý ví, Rút tiền & Đóng cước**: Xem số dư doanh thu, gửi lệnh rút tiền qua PayOS Payout, thanh toán cước thuê nút định kỳ và tạo phiếu thu tiền mặt tại quầy.
* **Xem báo cáo doanh thu cửa hàng**: Theo dõi biểu đồ đơn hàng và doanh số theo ngày/tháng.

---

### 🔧 3. Nhân viên Hệ thống (System Staff — `SYSTEM_STAFF`)
* **Quản lý kho nút bấm tập trung**: Xem danh sách thiết bị toàn sàn, cấp phát/chuyển kho thiết bị, tạo/triển khai mẫu cấu hình (`Device Templates`) và reset/sửa/khóa nút bấm.
* **Kiểm tra & Thẩm định bảo hành kỹ thuật**: Tiếp nhận phiếu bảo hành, thực hiện **đổi nút 1-1** (`approveSwapAtomicTx` — chuyển đầy đủ hợp đồng thuê `rentalId`, khách hàng, địa chỉ, cấu hình sản phẩm, hạn sử dụng, chặn đổi trùng nút/nút đang có hợp đồng) hoặc **khóa nút hỏng** (`lockDeviceAtomicTx`).
* **Đối chiếu snapshot hợp đồng khi bảo hành**: Xác thực nút gốc và phiếu bảo hành khớp cùng snapshot `rentalId` trước khi đổi hoặc khóa (trả `409 Conflict` yêu cầu đối soát nếu lệch hợp đồng).
* **Kiểm tra trả nút tại kho (`confirmReturnReceipt`)**: Xác nhận tình trạng phần cứng khi khách trả nút; chỉ tạo đề nghị hoàn cọc ở trạng thái `PENDING_APPROVAL` — **tuyệt đối không** tự duyệt hoàn cọc, không kích hoạt PayOS Payout, không xem/chỉnh đơn bán hàng, ví cửa hàng hay phân quyền RBAC.

---

### 🛡️ 4. Quản trị viên hệ thống (Admin / System Admin / Super Admin)
* **Quản trị người dùng & Phân quyền nền tảng (`platform_memberships`)**: Quản lý tài khoản, khóa tài khoản (thu hồi đa node tức thời via Redis Pub/Sub & `tokens_invalid_before`), cấp/thu hồi vai trò `SYSTEM_STAFF` (`SUPER_ADMIN`) và bảo vệ danh tính bootstrap.
* **Thẩm định & Phê duyệt đại lý**: Kiểm tra giấy phép kinh doanh của cửa hàng, bấm Duyệt (`ACTIVE`) hoặc Từ chối (`REJECTED`).
* **Cấu hình gói cước, Bảng giá thuê & Billing**: Thiết lập gói cước, chạy tiến trình thu cước hàng tháng và đối soát nộp thừa tiền cước.
* **Phê duyệt hoàn cọc & Payout PayOS (`ADMIN / SUPER_ADMIN`)**: Thực hiện bút toán duy nhất trên sổ cọc `rental_deposits` (`approveDepositRefundTx`) cho cả luồng trả nút và bảo hành, giám sát dòng tiền và duyệt lệnh rút tiền/chi hộ PayOS (`SUPER_ADMIN`).
* **Xem Dashboard phân tích toàn sàn & DLQ**: Theo dõi GMV, doanh thu phí sàn, cảnh báo bảo mật thiết bị và hàng đợi lỗi (DLQ).

---

### 🤖 5. Thiết bị Phần cứng & Hệ thống ngoài (Hardware & External Systems)
* **Nút bấm IoT (ESP32-S3)**: Phát tín hiệu đặt hàng bảo mật HMAC-SHA256 khi người dùng nhấn nút; định kỳ báo cáo mức pin (Heartbeat) và kích hoạt cảnh báo khi pin yếu.
* **Cổng thanh toán PayOS**: Xử lý thanh toán VietQR Napas 24/7; gửi Webhook khớp đơn hàng tự động; thực thi lệnh chi tiền Payout về tài khoản ngân hàng.
* **Didit Cloud AI Engine**: Nhận diện OCR căn cước công dân và quét khuôn mặt 3D chống giả mạo; gửi Webhook thông báo kết quả định danh người dùng.

