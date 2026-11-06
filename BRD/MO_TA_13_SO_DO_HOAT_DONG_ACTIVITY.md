# TÀI LIỆU MÔ TẢ 13 SƠ ĐỒ HOẠT ĐỘNG (ACTIVITY DIAGRAMS)
> Quy trình nghiệp vụ vận hành thực tế phân chia theo các Làn bơi (Swimlanes)

---

### [ACT 1] Quy trình Nạp & Ghép nối Nút bấm (Zero-Touch IoT Provisioning)
* **Các bên tham gia**: `Khách hàng / App` | `Nút bấm IoT (ESP32)` | `Máy chủ Backend & DB` | `Cửa hàng / Đại lý`.
* **Luồng chạy**:
  1. Tại xưởng sản xuất, kỹ thuật viên nạp phần mềm cơ sở và khóa bí mật HMAC-SHA256 vào chip ESP32.
  2. Nút bấm được xuất kho trung tâm và bàn giao về cửa hàng đại lý.
  3. Cửa hàng giao nút cho khách hàng kèm mã QR in trên thân nút.
  4. Khách hàng mở ứng dụng, quét mã QR để nhận quyền sở hữu nút (Claim).
  5. Hệ thống kích hoạt nút sang trạng thái `ACTIVE`, sẵn sàng nhấn để đặt hàng.

---

### [ACT 2] Quy trình Nhấn nút Đặt hàng & Giao vận (Click-to-Order Fulfillment)
* **Các bên tham gia**: `Nút bấm IoT` | `Máy chủ Backend & DB` | `Nhân viên Cửa hàng` | `Tài xế Giao hàng`.
* **Luồng chạy**:
  1. Khách hàng nhấn nút vật lý ESP32 tại nhà.
  2. Chip ESP32 tự động kết nối Wi-Fi, tính toán chữ ký mật mã HMAC-SHA256 và gửi gói tin lên Render Cloud.
  3. Backend xác thực chữ ký HMAC và kiểm tra chuỗi Nonce chống phát lại.
  4. Backend gọi Stored Procedure `sp_create_order_from_button` để tạo đơn hàng, tự động khóa kiểm tra tồn kho và tính chiết khấu.
  5. Hệ thống gửi thông báo chuông về màn hình cửa hàng để nhân viên đóng gói bình nước/gas.
  6. Hệ thống tự động gán đơn cho tài xế đi giao; khi giao xong, tài xế chụp ảnh xác nhận $\rightarrow$ Nút bấm đổi đèn LED xanh lá và bíp còi báo thành công.

---

### [ACT 3] Quy trình Thanh toán Trực tuyến VietQR (PayOS VietQR Payment)
* **Các bên tham gia**: `Khách hàng` | `Hệ thống Backend` | `Cổng PayOS & Napas 24/7` | `App Ngân hàng của Khách`.
* **Luồng chạy**:
  1. Khi đặt hàng chọn thanh toán PayOS, Backend gọi API PayOS để sinh mã VietQR động chứa số tiền chính xác.
  2. Khách hàng mở app ngân hàng quét mã VietQR và bấm xác nhận chuyển tiền.
  3. Hệ thống Napas 24/7 xử lý chuyển tiền tức thì và báo cho cổng PayOS.
  4. PayOS gửi một Webhook kèm chữ ký số HMAC về máy chủ Backend.
  5. Backend kiểm tra chữ ký an toàn, tự động khớp đơn hàng và cập nhật trạng thái đơn thành Đã Thanh Toán (`PAID`).

---

### [ACT 4] Quy trình Rút tiền Doanh thu Cửa hàng (Store Wallet Payout)
* **Các bên tham gia**: `Chủ cửa hàng` | `Quản trị viên (Admin)` | `Dịch vụ Ví Backend` | `Cổng PayOS Payout`.
* **Luồng chạy**:
  1. Chủ quán vào phần quản lý ví, nhập số tiền muốn rút về tài khoản ngân hàng của quán.
  2. Hệ thống kiểm tra số dư và tự động chuyển số tiền rút vào quỹ phong tỏa (`locked_balance`) để chống rút âm ví.
  3. Admin kiểm tra tính hợp lệ của yêu cầu trên trang quản trị và bấm Phê duyệt.
  4. Backend tự động gọi API PayOS Payout để chuyển khoản Napas 24/7 thẳng về tài khoản ngân hàng của quán.
  5. Khi ngân hàng báo tiền đã vào tài khoản, hệ thống trừ dứt điểm số tiền trong quỹ phong tỏa. Nếu lỗi, tiền được hoàn lại ví cho chủ quán.

---

### [ACT 5] Quy trình Thuê Nút bấm & Thu cước Định kỳ (Button Rental Lifecycle)
* **Các bên tham gia**: `Khách thuê nút` | `Cửa hàng / Đại lý` | `Hệ thống Backend` | `Cổng PayOS & Cron Job`.
* **Luồng chạy**:
  1. Người thuê chọn gói thuê nút bấm và thanh toán tiền đặt cọc thiết bị.
  2. Cửa hàng bàn giao nút bấm và kích hoạt hợp đồng thuê.
  3. Đầu mỗi tháng, tiến trình tự động (Cron Job) quét số lượng nút đang hoạt động để sinh hóa đơn cước thuê gửi cho cửa hàng.
  4. Khi chấm dứt hợp đồng, khách đem trả lại nút; nhân viên kiểm tra phần cứng nguyên vẹn $\rightarrow$ Hệ thống tự động kích hoạt hoàn tiền cọc về tài khoản ngân hàng.

---

### [ACT 6] Quy trình Ca trực Tài xế & Điều phối Đơn (Driver Shift & Dispatch)
* **Các bên tham gia**: `Tài xế giao hàng` | `Quản lý Cửa hàng` | `Hệ thống Điều phối tự động` | `Thu ngân Đối soát COD`.
* **Luồng chạy**:
  1. Tài xế mở app, bấm "Bắt đầu ca trực" và bật trạng thái `ONLINE` sẵn sàng nhận đơn.
  2. Khi có đơn hàng mới từ nút bấm, thuật toán hệ thống tự động gán đơn cho tài xế có cự ly gần nhất.
  3. Tài xế nhận hàng từ kho, di chuyển theo định vị bản đồ và giao tận tay khách.
  4. Tài xế chụp ảnh bình nước/chữ ký làm bằng chứng giao hàng thành công.
  5. Hết ca trực, tài xế nộp lại toàn bộ tiền mặt thu hộ (COD) cho thu ngân cửa hàng để được xác nhận đóng ca an toàn.

---

### [ACT 7] Quy trình Đăng ký, Đăng nhập & Xác thực OTP (Phone OTP & Auth Flow)
* **Các bên tham gia**: `Người dùng / App` | `Giao diện Frontend` | `Dịch vụ Backend Auth` | `Cổng SMS / Firebase`.
* **Luồng chạy**:
  1. Người dùng nhập số điện thoại trên màn hình đăng ký hoặc đăng nhập.
  2. Hệ thống gửi mã OTP 6 chữ số ngẫu nhiên qua tin nhắn SMS.
  3. Người dùng nhập mã OTP vào ứng dụng.
  4. Backend đối soát mã với bản băm lưu trong database kèm bộ đếm giới hạn (chống dò mã tự động).
  5. Nếu đúng, Backend cấp một cặp mã: Access Token (ngắn hạn để gọi API) và Refresh Token (dài hạn để duy trì phiên).

---

### [ACT 8] Quy trình Quản lý Sản phẩm & Khuyến mãi (Product & Discount Campaign)
* **Các bên tham gia**: `Chủ cửa hàng` | `Dịch vụ Sản phẩm Backend` | `Cơ sở Dữ liệu Kho & Giá` | `Giao diện Khách hàng`.
* **Luồng chạy**:
  1. Chủ quán nhập thông tin bình nước/gas mới, bấm tải ảnh $\rightarrow$ Backend sinh link an toàn để tải ảnh thẳng lên Cloud.
  2. Chủ quán tạo đợt giảm giá Flash Sale (giảm 10% trong 3 ngày).
  3. Database lưu thông tin giá và tồn kho khả dụng.
  4. Ứng dụng khách hàng tự động cập nhật hiển thị giá khuyến mãi gạch ngang để kích thích mua sắm.

---

### [ACT 9] Quy trình Khiếu nại Đơn hàng & Hoàn tiền (Refund & Dispute Resolution)
* **Các bên tham gia**: `Khách hàng` | `Chủ cửa hàng` | `Hệ thống Xử lý Tranh chấp` | `Admin & Cổng PayOS`.
* **Luồng chạy**:
  1. Khách hàng nhận bình nước bị xì van hoặc giao nhầm loại $\rightarrow$ Tạo phiếu khiếu nại trên app.
  2. Cửa hàng nhận thông báo, có thể chấp nhận đổi bình mới hoặc thương lượng hoàn tiền.
  3. Nếu hai bên không thống nhất được, Admin sẽ vào xem xét chứng cứ ảnh chụp để phân xử.
  4. Nếu quyết định hoàn tiền, hệ thống tự động gọi API PayOS bắn trả tiền về lại tài khoản ngân hàng của khách.

---

### [ACT 10] Quy trình Xác minh Tài khoản Ngân hàng 2.000đ (Customer Bank 2.000đ Verification & Refund)
* **Các bên tham gia**: `Khách hàng / App` | `Cổng PayOS VietQR` | `Dịch vụ Ngân hàng Backend` | `Tiến trình Hoàn tiền tự động`.
* **Luồng chạy**:
  1. Khách hàng nhập số tài khoản ngân hàng muốn nhận tiền hoàn cọc.
  2. Backend tạo một mã VietQR yêu cầu chuyển 2.000đ kèm một mã code ngẫu nhiên duy nhất (ví dụ: `VERIFY8829`).
  3. Khách quét mã chuyển đúng 2.000đ.
  4. Ngân hàng gửi webhook báo tiền về, Backend kiểm tra đúng mã code $\rightarrow$ Đánh dấu tài khoản là Chính chủ (`VERIFIED`).
  5. Tiến trình chạy ngầm lập tức gọi PayOS Payout chuyển trả lại đúng 2.000đ về cho khách, bảo đảm uy tín và không làm mất tiền của khách.

---

### [ACT 11] Quy trình Định danh Điện tử Didit eKYC (Didit eKYC Verification Flow)
* **Các bên tham gia**: `Khách hàng / App` | `Backend Webhook Service` | `Trí tuệ Nhân tạo Didit Cloud` | `Cơ sở Dữ liệu`.
* **Luồng chạy**:
  1. Khách hàng bấm yêu cầu định danh để đủ điều kiện mượn nút bấm IoT.
  2. Ứng dụng mở Didit Camera SDK, hướng dẫn khách chụp mặt trước, mặt sau CCCD (tự kiểm tra chống lóa sáng).
  3. Khách quay mặt theo hướng dẫn để quét liveness 3D (chống dùng ảnh chụp lại hoặc video giả mạo).
  4. Didit AI xử lý OCR đọc thông tin thẻ và so khớp khuôn mặt với ảnh trên CCCD.
  5. Didit gửi Webhook có chữ ký số về Backend $\rightarrow$ Backend tự động cấp huy hiệu Đã Xác Minh (`VERIFIED`) cho hồ sơ khách hàng.

---

### [ACT 12] Quy trình Đăng ký & Duyệt Cửa hàng Liên kết (Store Merchant Onboarding & Admin Approval Flow)
* **Các bên tham gia**: `Chủ đại lý / Quán` | `Backend Provisioning Service` | `Admin Thẩm định` | `Cơ sở Dữ liệu`.
* **Luồng chạy**:
  1. Đại lý mới nộp hồ sơ xin làm đối tác (Tên quán, địa chỉ, ảnh GPKD, CCCD, tài khoản nhận tiền).
  2. Backend lưu hồ sơ ở trạng thái Chờ duyệt (`PENDING_VERIFICATION`) và đẩy vào hàng đợi của Admin.
  3. Admin xem xét hồ sơ, đối chiếu giấy phép kinh doanh với địa chỉ thực tế:
     * **Nếu Hợp lệ**: Admin bấm Phê duyệt $\rightarrow$ Backend chạy Transaction nguyên tử kích hoạt quán sang `ACTIVE`, tự động tạo ví cửa hàng `store_wallets`, cấp tài khoản đăng nhập và gửi email kèm mật khẩu cho chủ quán.
     * **Nếu Không hợp lệ**: Admin bấm Từ chối kèm lý do cụ thể $\rightarrow$ Hệ thống gửi email thông báo hướng dẫn chủ quán nộp lại giấy tờ.

---

### [ACT 13] Quy trình Khách hàng Chuyển đổi Cửa hàng (Customer Store Migration & Button Reassignment Flow)
* **Các bên tham gia**: `Khách hàng / App` | `Backend Migration Engine` | `Quán cũ & Quán mới` | `Cơ sở Dữ liệu`.
* **Luồng chạy**:
  1. Khách hàng chuyển nhà hoặc muốn đổi quán quen $\rightarrow$ Mở app chọn nút bấm và tìm đại lý mới gần nhà hơn.
  2. Backend kiểm tra điều kiện an toàn: Nếu nút đang có đơn hàng đang giao dở dang $\rightarrow$ Chặn lại, yêu cầu nhận hàng xong mới được chuyển.
  3. Backend kiểm tra xem đại lý mới có bán loại sản phẩm gắn với nút không: Nếu khác thương hiệu, mời khách chọn lại sản phẩm tương đương của quán mới.
  4. Backend chạy giao dịch nguyên tử: Đổi cột `custody_store_id` của nút sang quán mới, ghi nhật ký di chuyển thiết bị vào `device_movements` và tự động điều chuyển định mức thuê nút giữa 2 quán.
  5. Hệ thống gửi thông báo thời gian thực: Quán cũ gỡ nút khỏi tuyến giao, Quán mới nạp khách hàng vào lộ trình phục vụ của mình. Lần bấm nút tiếp theo sẽ đặt hàng thẳng về quán mới.

