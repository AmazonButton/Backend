# ĐẶC TẢ QUY TRÌNH NGHIỆP VỤ ĐĂNG NHẬP & PHÂN QUYỀN (BPMN 2.0)
## Hệ Thống Đặt Hàng Qua Nút Bấm IoT Đa Cửa Hàng (Smart Order Button Platform)
**Tài liệu tham chiếu:** [Giải ngố các ký hiệu BPMN - Thinhnotes](https://thinhnotes.com/chuyen-nghe-ba/giai-ngo-cac-ky-hieu-bpmn/)  
**Tệp sơ đồ Draw.io:** [BPMN_Chuc_Nang_Dang_Nhap.drawio](file:///F:/Learning/SEM9-FPTu/backend/BRD/BPMN_Chuc_Nang_Dang_Nhap.drawio) & [BPMN_Chuc_Nang_Dang_Nhap.xml](file:///F:/Learning/SEM9-FPTu/backend/BRD/BPMN_Chuc_Nang_Dang_Nhap.xml)

---

## 1. Tổng quan & Mục tiêu nghiệp vụ

Chức năng **Đăng nhập (Authentication & Authorization)** là cửa ngõ kiểm soát an ninh tối quan trọng của nền tảng Smart Order Button. Quy trình được thiết kế chuẩn mực theo mô hình BPMN 2.0 (Business Process Model and Notation), phân định trách nhiệm rõ ràng qua 4 làn bơi (Swimlanes), đảm bảo các tiêu chuẩn bảo mật doanh nghiệp:
1. **Chống tấn công Brute-Force & DoS**: Throttler Guard kiểm soát tần suất request theo IP.
2. **Chống dò quét thông tin người dùng (Anti-Enumeration)**: Thông báo lỗi đồng nhất HTTP 401 khi sai email hoặc sai mật khẩu.
3. **Mã hóa mật khẩu chuẩn công nghiệp**: Thuật toán Bcrypt với Salt Rounds an toàn.
4. **Cơ chế Token bảo mật 2 lớp**:
   - **Access Token (JWT)**: Thời hạn ngắn (15 phút), chứa ngữ cảnh phân quyền RBAC và Tenant (`storeId`, `customerProfileId`).
   - **Refresh Token**: Chuỗi ngẫu nhiên 40-byte cryptographically secure, thời hạn 7 ngày, lưu trữ bản băm SHA-256 trong CSDL, cơ chế xoay vòng 1 lần (Single-Use Rotation) chống tái sử dụng (Replay Attack).
5. **Định tuyến giao diện tự động theo vai trò (Role Routing)**: Phân tách không gian làm việc giữa Super Admin, Chủ cửa hàng, Nhân viên và Khách hàng.

---

## 2. Cấu trúc Swimlanes (Làn bơi phân định trách nhiệm)

Theo hướng dẫn từ Thinhnotes, một sơ đồ BPMN chuẩn phân tích nghiệp vụ phần mềm được tổ chức thành 1 Pool lớn chứa 4 Swimlanes:

| Làn bơi (Swimlane) | Vai trò / Chủ thể | Trách nhiệm chính |
| :--- | :--- | :--- |
| **1. NGƯỜI DÙNG (ACTOR)** | Khách hàng (Customer), Chủ cửa hàng (Store Owner), Nhân viên (Store Staff), Quản trị viên (Super Admin) | - Nhập thông tin tài khoản & mật khẩu.<br>- Bấm xác nhận đăng nhập.<br>- Tiếp cận Dashboard và thực hiện các chức năng tương ứng với vai trò. |
| **2. GIAO DIỆN CLIENT** | Web Portal, Mobile Application, Zero-Touch UI | - Kiểm tra định dạng dữ liệu phía máy khách (Client Validation).<br>- Gửi HTTP Request kèm thông tin IP, User-Agent.<br>- Xử lý hiển thị các phản hồi lỗi (400, 401, 403, 429).<br>- Lưu trữ Access Token trong Memory/App State & nhận HTTP-only Cookie.<br>- Định tuyến điều hướng người dùng theo Role. |
| **3. BACKEND CORE & AUTH SERVICE** | NestJS Core, API Gateway, Throttler Guard, AuthService | - Chặn tấn công Brute-force qua Rate Limiter.<br>- Chuẩn hóa định dạng identifier (trim & lowercase).<br>- Thẩm định mã băm mật khẩu qua `bcrypt.compare`.<br>- Kiểm tra trạng thái tài khoản (`status`).<br>- Xác định vai trò (RBAC Scoping) và Tenant Context.<br>- Ký số cặp JWT Access Token & sinh Refresh Token.<br>- Đóng gói Envelope dữ liệu an toàn. |
| **4. CƠ SỞ DỮ LIỆU & LƯU TRỮ** | PostgreSQL Database (Supabase) | - Bảng `users`: Truy vấn tài khoản và các liên kết RBAC.<br>- Bảng `refresh_tokens`: Lưu trữ bản băm SHA-256 của Refresh Token.<br>- Bảng `audit_logs`: Ghi nhận nhật ký đăng nhập thành công để kiểm toán an ninh. |

---

## 3. Các ký hiệu BPMN 2.0 được sử dụng (Chuẩn Thinhnotes)

1. **Sự kiện (Events)**:
   - **Start Event (Sự kiện bắt đầu)**: Vòng tròn viền đơn mảnh xanh lá, kích hoạt khi người dùng mở trang đăng nhập.
   - **End Event - Thành công**: Vòng tròn viền đậm đôi xanh lá, kết thúc khi phiên làm việc được kích hoạt thành công.
   - **End Event - Thất bại**: Vòng tròn viền đậm đỏ, kết thúc luồng do lỗi bảo mật (Rate limit, Sai thông tin, Khóa tài khoản).
2. **Hoạt động (Activities / Tasks)**:
   - **User Task**: Thao tác thủ công của người dùng (Nhập thông tin, bấm nút, truy cập giao diện).
   - **Service Task**: Tác vụ tự động của hệ thống (Validate form, gọi API, băm mật khẩu, truy vấn CSDL, cấp Token).
3. **Cổng rẽ nhánh (Gateways)**:
   - **Exclusive Gateway (XOR - Cổng loại trừ)**: Rẽ 1 trong các nhánh logic (Dữ liệu hợp lệ? Vượt Rate Limit? Tìm thấy User? Trạng thái tài khoản? Khớp mật khẩu? Phân loại Role?).
   - **Parallel Gateway (AND - Cổng song song)**: Thực hiện đồng thời 2 tác vụ:
     - Nhánh 1: Cấp cặp Token và lưu trữ bản băm Refresh Token.
     - Nhánh 2: Ghi vết nhật ký kiểm toán (Audit Log) và cập nhật `last_login_at`.
4. **Kho dữ liệu (Data Store)**:
   - Biểu tượng hình trụ đại diện cho các bảng dữ liệu PostgreSQL: `users`, `refresh_tokens`, `audit_logs`.
5. **Dòng tuần tự (Sequence Flow)**:
   - Các mũi tên liền nét có nhãn điều kiện rõ ràng: `[Hợp lệ]`, `[Thiếu dữ liệu]`, `[Vượt quá]`, `[ACTIVE]`, `[PENDING]`, `[BLOCKED]`, `[Mật khẩu đúng]`, v.v.
