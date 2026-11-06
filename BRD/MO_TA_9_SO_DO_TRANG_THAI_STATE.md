# TÀI LIỆU MÔ TẢ 9 SƠ ĐỒ TRẠNG THÁI (STATE MACHINE DIAGRAMS)
> Chuỗi chuyển đổi trạng thái hợp lệ của các đối tượng cốt lõi trong hệ thống

---

### [STATE 1] Vòng đời Đơn hàng (Order Lifecycle)
* **Đối tượng**: Bảng `orders` (Đơn đặt hàng).
* **Chuỗi trạng thái bình thường**:
  $$\text{PENDING (Chờ xác nhận)} \longrightarrow \text{CONFIRMED (Đã nhận đơn)} \longrightarrow \text{PREPARING (Đang chuẩn bị)} \longrightarrow \text{SHIPPING (Đang giao)} \longrightarrow \text{DELIVERED (Giao thành công)}$$
* **Trạng thái hủy / Thất bại**: 
  * `CANCELLED`: Khách hoặc Cửa hàng bấm hủy đơn.
  * `REJECTED`: Quán từ chối do hết hàng hoặc bận.
  * `FAILED`: Tài xế giao không được (khách không nghe máy, sai địa chỉ) sau nhiều lần thử lại.
* **Ý nghĩa thực tế**: Đảm bảo hàng hóa chỉ bị trừ kho thật và chỉ ghi nhận doanh thu vào ví quán khi đơn hàng chuyển sang `DELIVERED`.

---

### [STATE 2] Vòng đời Nút bấm IoT (IoT Device Lifecycle)
* **Đối tượng**: Bảng `iot_button` (Nút bấm vật lý ESP32-S3).
* **Chuỗi trạng thái bình thường**:
  $$\text{UNPROVISIONED (Mới sản xuất)} \longrightarrow \text{PROVISIONED (Đã nạp khóa bí mật)} \longrightarrow \text{ALLOCATED\_TO\_STORE (Đã giao quán)} \longrightarrow \text{PAIRING (Chờ ghép nối)} \longrightarrow \text{ACTIVE (Đang dùng)}$$
* **Trạng thái phụ**:
  * `SUSPENDED`: Khách gạt khóa trẻ em hoặc khóa vắng nhà $\rightarrow$ Nút không phát lệnh đặt hàng được.
  * `MAINTENANCE`: Pin yếu (dưới 3.3V) hoặc thiết bị cần sửa chữa.
  * `DECOMMISSIONED`: Thiết bị hỏng hoàn toàn, thu hồi hoặc hủy bỏ.
* **Ý nghĩa thực tế**: Nút bấm chỉ được phép kích hoạt tạo đơn hàng tự động khi đang ở trạng thái `ACTIVE` và đã liên kết với địa chỉ giao hàng hợp lệ.

---

### [STATE 3] Vòng đời Rút tiền Cửa hàng (Store Withdrawal Lifecycle)
* **Đối tượng**: Bảng `store_withdrawals` (Lệnh rút doanh thu của quán).
* **Chuỗi trạng thái bình thường**:
  $$\text{PENDING (Chờ duyệt)} \longrightarrow \text{APPROVED (Admin duyệt)} \longrightarrow \text{PROCESSING (Gọi PayOS)} \longrightarrow \text{COMPLETED (Tiền về tài khoản)}$$
* **Trạng thái hoàn tác**:
  * `REJECTED` (Admin từ chối) hoặc `FAILED` (Ngân hàng lỗi): Hệ thống tự động mở phong tỏa và trả lại tiền về số dư khả dụng trong ví cho chủ quán.
* **Ý nghĩa thực tế**: Ngăn chặn gian lận rút âm tiền trong ví và tự động hóa khâu chuyển khoản ngân hàng qua cổng PayOS Payout.

---

### [STATE 4] Vòng đời Thuê Nút bấm (Button Rental Lifecycle)
* **Đối tượng**: Bảng `button_rentals` (Hợp đồng thuê nút bấm phần cứng).
* **Chuỗi trạng thái bình thường**:
  $$\text{PENDING\_DEPOSIT (Chờ cọc)} \longrightarrow \text{ACTIVE (Đang thuê)} \longrightarrow \text{RENEWED (Gia hạn hàng tháng)} \longrightarrow \text{RETURN\_REQUESTED (Yêu cầu trả)} \longrightarrow \text{RETURNED (Đã trả nút)} \longrightarrow \text{TERMINATED (Hoàn cọc & Kết thúc)}$$
* **Trạng thái vi phạm**: `OVERDUE` (Quá hạn trả cước), `FORFEITED` (Làm mất nút $\rightarrow$ Mất tiền cọc).
* **Ý nghĩa thực tế**: Quản lý tài sản phần cứng mượn/thuê, đảm bảo tính đúng cước thuê hàng tháng và hoàn trả lại tiền cọc khi trả nút nguyên vẹn.

---

### [STATE 5] Vòng đời Định danh Điện tử (eKYC Verification Lifecycle)
* **Đối tượng**: Bảng `identity_verification_sessions` (Phiên xác thực căn cước công dân).
* **Chuỗi trạng thái bình thường**:
  $$\text{INITIATED (Khởi tạo)} \longrightarrow \text{PENDING\_SUBMISSION (Đang chụp CCCD & Mặt)} \longrightarrow \text{PROCESSING (AI đang chấm điểm)} \longrightarrow \text{APPROVED (Xác thực thành công)}$$
* **Trạng thái từ chối**: `DECLINED` (CCCD giả mạo / Mặt không khớp) hoặc `EXPIRED` (Quá 15 phút không hoàn tất).
* **Ý nghĩa thực tế**: Ngăn chặn tài khoản ảo, chỉ cho phép người dùng đã xác minh danh tính được thuê các thiết bị phần cứng có giá trị.

---

### [STATE 6] Vòng đời Ca trực của Tài xế (Driver Shift Lifecycle)
* **Đối tượng**: Bảng `driver_shifts` (Ca làm việc của shipper).
* **Chuỗi trạng thái bình thường**:
  $$\text{OFFLINE (Nghỉ trực)} \longrightarrow \text{OPEN / ONLINE (Bật nhận đơn)} \longleftrightarrow \text{ON\_DUTY (Đang đi giao hàng)} \longrightarrow \text{CLOSING (Chờ nộp tiền COD)} \longrightarrow \text{CLOSED (Hết ca)}$$
* **Ý nghĩa thực tế**: Tài xế chỉ được gán đơn khi đang `ONLINE`. Khi kết ca, shipper phải nộp đủ tiền mặt thu hộ (COD) cho thu ngân cửa hàng mới được đóng ca an toàn.

---

### [STATE 7] Vòng đời Xác minh Ngân hàng 2.000đ & Hoàn tiền (Customer Bank Verification & Refund)
* **Đối tượng**: Cụm bảng xác minh ngân hàng 2k.
* **Chuỗi trạng thái bình thường**:
  $$\text{QR\_GENERATED (Tạo mã 2k)} \longrightarrow \text{PAYMENT\_MATCHED (Khách chuyển 2k thành công)} \longrightarrow \text{OBLIGATION\_CREATED (Tạo lệnh hoàn 2k)} \longrightarrow \text{REFUND\_PROCESSING (Đang bắn tiền)} \longrightarrow \text{REFUNDED (Đã hoàn tiền & Tài khoản Verified)}$$
* **Ý nghĩa thực tế**: Dùng 2.000đ để kiểm tra tài khoản nhận tiền chính chủ của khách, sau đó hệ thống tự động bắn trả lại đúng 2.000đ qua PayOS Payout, không làm mất tiền của khách.

---

### [STATE 8] Vòng đời Gói cước Cửa hàng (Store Subscription Lifecycle)
* **Đối tượng**: Bảng `store_subscriptions` (Gói phần mềm đại lý).
* **Chuỗi trạng thái bình thường**:
  $$\text{INACTIVE (Chưa kích hoạt)} \longrightarrow \text{ACTIVE (Đang hoạt động)} \longrightarrow \text{RENEWED (Đã đóng cước tháng mới)} \longrightarrow \text{PAST\_DUE (Quá hạn đóng tiền)} \longrightarrow \text{SUSPENDED (Tạm khóa vì nợ cước)}$$
* **Ý nghĩa thực tế**: Kiểm soát phí dịch vụ phần mềm; nếu đại lý không thanh toán cước thuê nút đúng hạn, hệ thống sẽ tạm khóa quyền nhận đơn mới.

---

### [STATE 9] Vòng đời Giao dịch Thanh toán Đơn hàng (Payment Transaction Lifecycle)
* **Đối tượng**: Bảng `payment_transaction` (Giao dịch cổng VietQR PayOS).
* **Chuỗi trạng thái bình thường**:
  $$\text{PENDING (Chờ quét mã QR)} \longrightarrow \text{PROCESSING (Napas đang xử lý)} \longrightarrow \text{SUCCESS (Thanh toán thành công)}$$
* **Trạng thái khác**: `FAILED` (Giao dịch lỗi), `EXPIRED` (Mã QR hết hạn sau 15 phút), `REFUNDED` (Đã hoàn tiền lại cho khách).
* **Ý nghĩa thực tế**: Đảm bảo trạng thái thanh toán minh bạch, chỉ khi PayOS bắn webhook có chữ ký số hợp lệ thì đơn hàng mới được chuyển sang `PAID`.

