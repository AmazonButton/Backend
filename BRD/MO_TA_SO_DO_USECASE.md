# TÀI LIỆU MÔ TẢ SƠ ĐỒ USE CASE HỆ THỐNG (USE CASE DIAGRAM)
> Phân rã chức năng toàn bộ hệ thống Backend theo từng Vai trò (Roles & Actors)

---

## 1. TỔNG QUAN RANH GIỚI HỆ THỐNG (SYSTEM BOUNDARY)
* **Tên sơ đồ**: `[UC] Core System Use Case Diagram` (Trang 24 trong file `ERD_Level_3_Editable.drawio`).
* **Ranh giới**: Khung bao bọc `IOT CLICK-TO-ORDER PLATFORM (BACKEND ARCHITECTURE)`.
* **Cấu trúc**: Gồm 6 Tác nhân (Actors) tương tác với 30 Use Cases cốt lõi được phân chia thành 3 cột chức năng:
  1. *Cột 1*: Các chức năng dành cho Khách hàng & Thiết bị Nút bấm IoT.
  2. *Cột 2*: Các chức năng Thanh toán, Đối soát tài chính & Điều phối Giao vận.
  3. *Cột 3*: Các chức năng Vận hành Cửa hàng & Quản trị Nền tảng của Admin.

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

### 🏪 2. Chủ cửa hàng (Store Owner)
* **Đăng ký mở đại lý liên kết**: Nộp hồ sơ xin làm đối tác, đính kèm giấy phép kinh doanh (GPKD) và tài khoản nhận doanh thu.
* **Quản lý sản phẩm & Bảng giá**: Tạo sản phẩm mới, thiết lập giá bán gốc và mô tả hàng hóa.
* **Thiết lập khuyến mãi & Giảm giá**: Tạo các chiến dịch Flash Sale giảm giá theo thời gian.
* **Quản lý tồn kho hàng hóa**: Theo dõi lượng hàng thực tế và lượng hàng đang bị tạm giữ chỗ khi có đơn mới.
* **Tiếp nhận đơn & Điều phối giao**: Bấm xác nhận đơn hàng từ nút bấm/app và chỉ định tài xế đi giao.
* **Quản lý hợp đồng thuê nút**: Theo dõi số lượng nút đang mượn từ nền tảng và danh sách khách hàng đang sử dụng nút của quán.
* **Quản lý ví & Rút tiền doanh thu**: Xem số dư tiền bán hàng và gửi lệnh rút tiền tự động về tài khoản ngân hàng qua PayOS.
* **Đóng phí thuê nút hàng tháng**: Nhận hóa đơn cước định kỳ và thanh toán tiền thuê nút cho nền tảng qua VietQR.
* **Thu & Đối soát tiền mặt tại quầy**: Tạo phiếu thu tiền mặt và hạch toán biên lai đối soát vào sổ kế toán quán.
* **Quản lý nhân sự cửa hàng**: Cấp tài khoản cho nhân viên thu ngân và phân công ca trực cho shipper.
* **Xem báo cáo doanh thu cửa hàng**: Theo dõi biểu đồ tăng trưởng đơn hàng và doanh số bán hàng theo ngày/tháng.

---

### 💼 3. Nhân viên cửa hàng (Store Staff)
* **Đăng nhập tài khoản nhân viên**: Đăng nhập với quyền hạn bị giới hạn (không được xem số dư ví hay rút tiền).
* **Hỗ trợ ghép nút tại quầy (POS)**: Hỗ trợ khách hàng lớn tuổi liên kết nút bấm trực tiếp tại quầy bằng số điện thoại.
* **Cập nhật đóng gói đơn hàng**: Bấm xác nhận hàng đã đóng gói xong, sẵn sàng để tài xế lấy đi giao.
* **Ghi nhận nhập / xuất kho**: Cập nhật số lượng bình nước/bình gas thực tế xuất nhập tại điểm bán.

---

### 🛵 4. Tài xế giao hàng (Driver / Shipper)
* **Điểm danh vào ca & Kết ca**: Bật trạng thái sẵn sàng nhận đơn (`ONLINE`) khi trực và chuyển `OFFLINE` khi nghỉ.
* **Tiếp nhận nhiệm vụ giao hàng**: Nhận đơn hàng được gán, xem địa chỉ và số điện thoại của khách hàng.
* **Cập nhật tiến độ lộ trình**: Cập nhật các mốc "Đã lấy hàng từ kho" và "Đang trên đường giao".
* **Xác nhận giao hàng & Tải ảnh chứng từ**: Bấm hoàn tất giao hàng và tải ảnh chụp chữ ký/bình nước tại nhà khách để đối soát.
* **Thu tiền mặt (COD) & Bàn giao**: Thu tiền mặt tận tay khách và nộp lại đầy đủ cho thu ngân cửa hàng khi hết ca.

---

### 🛡️ 5. Quản trị viên hệ thống (System Admin)
* **Quản trị người dùng & Phân quyền (RBAC)**: Quản lý danh sách tài khoản toàn sàn và khóa tài khoản có hành vi gian lận.
* **Thẩm định & Phê duyệt đại lý**: Kiểm tra giấy phép kinh doanh của cửa hàng, bấm Duyệt (`ACTIVE`) hoặc Từ chối (`REJECTED`).
* **Quản lý kho nút bấm tập trung**: Quản lý số lượng phần cứng tại kho tổng và xuất kho bàn giao cho các đại lý.
* **Cấu hình gói cước & Bảng giá thuê**: Thiết lập phí thuê nút bấm hàng tháng, mức tiền cọc và các gói dịch vụ phần mềm.
* **Tự động tạo & Thu cước định kỳ**: Chạy tiến trình đầu tháng tính toán số lượng nút đang hoạt động của từng quán để xuất hóa đơn cước.
* **Xử lý đối soát nộp thừa tiền cước**: Khấu trừ vào kỳ sau hoặc hoàn tiền đối với các khoản thanh toán cước bị chuyển thừa tiền.
* **Giám sát tài chính & Lệnh rút tiền**: Theo dõi luồng tiền ra vào qua cổng PayOS và tra soát các giao dịch rút tiền bất thường.
* **Xem Dashboard phân tích toàn sàn**: Theo dõi tổng giá trị giao dịch (GMV), doanh thu phí sàn và tỷ lệ đơn hoàn tất.
* **Giám sát hàng đợi lỗi (DLQ) & Hệ thống**: Theo dõi các tiến trình chạy ngầm bị lỗi và kiểm tra tình trạng sức khỏe của server.

---

### 🤖 6. Thiết bị Phần cứng & Hệ thống ngoài (Hardware & External Systems)
* **Nút bấm IoT (ESP32-S3)**: Phát tín hiệu đặt hàng bảo mật HMAC-SHA256 khi người dùng nhấn nút; định kỳ báo cáo mức pin (Heartbeat) và kích hoạt cảnh báo khi pin yếu.
* **Cổng thanh toán PayOS**: Xử lý thanh toán VietQR Napas 24/7; gửi Webhook khớp đơn hàng tự động; thực thi lệnh chi tiền Payout về tài khoản ngân hàng.
* **Didit Cloud AI Engine**: Nhận diện OCR căn cước công dân và quét khuôn mặt 3D chống giả mạo; gửi Webhook thông báo kết quả định danh người dùng.

