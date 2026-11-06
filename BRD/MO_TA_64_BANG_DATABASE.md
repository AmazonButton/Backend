# TÀI LIỆU MÔ TẢ 64 BẢNG CƠ SỞ DỮ LIỆU & CHI TIẾT CÁC CỘT QUAN TRỌNG
> Hệ thống Backend Bán hàng Nước & Gas thông minh qua Nút bấm IoT (Multi-Store Marketplace)

---

## PHÂN HỆ 1: NGƯỜI DÙNG, ĐỊNH DANH & BẢO MẬT (IAM) (7 bảng)

### 1. `roles` (Vai trò người dùng)
* **Chức năng**: Định nghĩa các nhóm quyền hạn truy cập (RBAC) trên toàn hệ thống.
* **Các cột quan trọng**:
  * `role_id` (PK, Integer): Mã số định danh duy nhất của vai trò.
  * `role_name` (VarChar, UNIQUE): Tên vai trò phân quyền (`SUPER_ADMIN`, `ADMIN`, `STORE_OWNER`, `STORE_STAFF`, `CUSTOMER`, `DRIVER`).
  * `description` (VarChar): Mô tả phạm vi quyền hạn và trách nhiệm của vai trò.

### 2. `users` (Tài khoản người dùng trung tâm)
* **Chức năng**: Lưu thông tin đăng nhập gốc của mọi tác nhân (Admin, Khách hàng, Chủ quán, Tài xế).
* **Các cột quan trọng**:
  * `user_id` (PK, BigInt): Mã định danh duy nhất của người dùng.
  * `phone_number` (VarChar, UNIQUE): Số điện thoại dùng làm tài khoản đăng nhập chính.
  * `email` (VarChar): Địa chỉ email nhận thông báo, hóa đơn và mật khẩu kích hoạt.
  * `password_hash` (VarChar): Chuỗi băm mật khẩu bảo mật (sử dụng thuật toán Argon2/Bcrypt).
  * `role_id` (FK, Integer): Khóa ngoại liên kết tới bảng `roles` xác định quyền hạn.
  * `status` (VarChar): Trạng thái tài khoản (`ACTIVE`, `SUSPENDED`, `INACTIVE`).
  * `last_login_at` (Timestamp): Thời điểm đăng nhập gần nhất để giám sát bảo mật.

### 3. `user_auth_identities` (Đăng nhập đa kênh)
* **Chức năng**: Hỗ trợ liên kết tài khoản với các dịch vụ bên ngoài (Google, Apple) hoặc OTP số điện thoại.
* **Các cột quan trọng**:
  * `identity_id` (PK, BigInt): Mã định danh bản ghi liên kết.
  * `user_id` (FK, BigInt): Khóa ngoại trỏ về tài khoản gốc tại bảng `users`.
  * `provider` (VarChar): Tên nhà cung cấp xác thực (`GOOGLE`, `APPLE`, `PHONE_OTP`).
  * `provider_user_id` (VarChar): Mã định danh duy nhất của người dùng do bên thứ 3 cấp.

### 4. `refresh_tokens` (Phiên đăng nhập dài hạn)
* **Chức năng**: Quản lý phiên làm việc dài hạn (Refresh Token Rotation) giúp người dùng không phải nhập lại mật khẩu.
* **Các cột quan trọng**:
  * `id` (PK, BigInt): Mã phiên đăng nhập.
  * `user_id` (FK, BigInt): Khóa ngoại trỏ đến tài khoản người dùng đang đăng nhập.
  * `token_hash` (VarChar, UNIQUE): Chuỗi băm SHA-256 của Refresh Token nhằm chống lộ token nếu database bị đọc lén.
  * `expires_at` (Timestamp): Thời điểm token hết hạn buộc người dùng phải xác thực lại.
  * `is_revoked` (Boolean): Cờ đánh dấu token đã bị hủy (ví dụ khi người dùng đăng xuất).

### 5. `revoked_tokens` (Danh sách đen Token đã thu hồi)
* **Chức năng**: Danh sách đen (Blacklist) lưu Access Token bị vô hiệu hóa sớm khi đăng xuất trên hệ thống đa máy chủ.
* **Các cột quan trọng**:
  * `id` (PK, BigInt): Mã bản ghi thu hồi.
  * `jti` (VarChar, UNIQUE): Mã định danh duy nhất của JWT Access Token (`JWT ID`).
  * `user_id` (FK, BigInt): Mã người dùng vừa thực hiện đăng xuất.
  * `expires_at` (Timestamp): Hạn dùng gốc của token, dùng để cron job tự dọn dẹp bộ nhớ khi token hết hạn tự nhiên.

### 6. `auth_otps` (Mã xác thực OTP qua SMS)
* **Chức năng**: Quản lý mã OTP 6 số ngẫu nhiên gửi qua điện thoại khi đăng ký hoặc đăng nhập.
* **Các cột quan trọng**:
  * `otp_id` (PK, BigInt): Mã phiên gửi OTP.
  * `phone_number` (VarChar): Số điện thoại nhận mã OTP.
  * `otp_code_hash` (VarChar): Chuỗi băm của mã OTP nhằm bảo vệ mã số bí mật trong cơ sở dữ liệu.
  * `attempts_count` (Integer): Số lần người dùng đã nhập sai, vượt quá 3-5 lần sẽ tự động khóa.
  * `expires_at` (Timestamp): Hạn dùng của mã OTP (thường là 2 đến 5 phút).
  * `is_consumed` (Boolean): Đánh dấu mã OTP đã được sử dụng thành công hay chưa.

### 7. `access_adjustments` (Lịch sử can thiệp quyền hạn)
* **Chức năng**: Nhật ký kiểm toán bảo mật ghi nhận việc Admin cấp quyền bổ sung hoặc khóa tạm thời tài khoản.
* **Các cột quan trọng**:
  * `id` (PK, BigInt): Mã bản ghi điều chỉnh quyền.
  * `user_id` (FK, BigInt): Tài khoản người dùng bị điều chỉnh quyền.
  * `adjusted_by_user_id` (FK, BigInt): Tài khoản Admin thực hiện thao tác can thiệp.
  * `action_type` (VarChar): Loại thao tác (`GRANT_TEMP_PERMISSION`, `SUSPEND_ACCOUNT`, `EXTEND_EXPIRY`).
  * `reason` (Text): Lý do cụ thể bắt buộc Admin phải nhập khi thực hiện can thiệp.

---

## PHÂN HỆ 2: KHÁCH HÀNG & SỔ ĐỊA CHỈ (3 bảng)

### 8. `customer_profile` (Hồ sơ người tiêu dùng)
* **Chức năng**: Lưu thông tin cá nhân của khách hàng, điểm tích lũy và trạng thái xác thực căn cước công dân.
* **Các cột quan trọng**:
  * `customer_id` (PK/FK, BigInt): Khóa chính và đồng thời là khóa ngoại liên kết 1-1 với `users.user_id`.
  * `full_name` (VarChar): Họ và tên đầy đủ của khách hàng.
  * `avatar_url` (Text): Đường dẫn ảnh đại diện cá nhân.
  * `ekyc_status` (VarChar): Trạng thái xác thực danh tính (`UNVERIFIED`, `PENDING`, `VERIFIED`, `REJECTED`).
  * `loyalty_points` (Integer): Điểm thưởng tích lũy khi mua bình nước/gas thành công.

### 9. `customer_address` (Sổ địa chỉ nhận hàng)
* **Chức năng**: Danh sách địa chỉ giao hàng của khách kèm tọa độ GPS để tính cự ly điều phối shipper.
* **Các cột quan trọng**:
  * `address_id` (PK, BigInt): Mã số định danh của địa chỉ.
  * `customer_id` (FK, BigInt): Khóa ngoại trỏ đến khách hàng sở hữu địa chỉ này.
  * `recipient_name` (VarChar): Tên người nhận hàng tại điểm giao.
  * `phone` (VarChar): Số điện thoại liên hệ nhận hàng.
  * `address_detail` (VarChar): Số nhà, tên ngõ, tên đường cụ thể.
  * `ward`, `district`, `province` (VarChar): Phường/Xã, Quận/Huyện, Tỉnh/Thành phố.
  * `latitude`, `longitude` (Decimal): Tọa độ địa lý GPS dùng để tính khoảng cách giao hàng.
  * `is_default` (Boolean): Cờ đánh dấu đây là địa chỉ nhận hàng mặc định cho nút bấm IoT.

### 10. `store_customer` (Khách hàng thân thiết của Cửa hàng)
* **Chức năng**: Quản lý mối quan hệ giữa khách hàng và từng đại lý cụ thể, theo dõi sổ nợ vỏ bình.
* **Các cột quan trọng**:
  * `store_id` (PK/FK, BigInt): Mã cửa hàng quen thuộc.
  * `customer_id` (PK/FK, BigInt): Mã khách hàng.
  * `container_debt_count` (Integer): Số lượng vỏ bình nước 19L hoặc vỏ bình gas khách đang mượn chưa trả.
  * `loyalty_tier` (VarChar): Hạng thành viên của khách tại quán (`STANDARD`, `VIP`, `PLATINUM`).

---

## PHÂN HỆ 3: CỬA HÀNG & NHÂN VIÊN ĐẠI LÝ (2 bảng)

### 11. `store` (Thông tin Cửa hàng / Đại lý)
* **Chức năng**: Hồ sơ pháp lý, địa chỉ và trạng thái hoạt động của các đại lý tham gia sàn.
* **Các cột quan trọng**:
  * `store_id` (PK, BigInt): Mã định danh duy nhất của cửa hàng.
  * `store_code` (VarChar, UNIQUE): Mã viết tắt hiển thị của đại lý (ví dụ: `STR-GIADINH`).
  * `store_name` (VarChar): Tên thương hiệu đại lý hiển thị cho khách hàng.
  * `phone_number` (VarChar): Số điện thoại hotline liên hệ của cửa hàng.
  * `address` (VarChar): Địa chỉ thực tế của cửa hàng.
  * `latitude`, `longitude` (Decimal): Tọa độ GPS của cửa hàng dùng để quét đại lý gần nhất.
  * `status` (VarChar): Trạng thái phê duyệt (`PENDING_VERIFICATION`, `ACTIVE`, `REJECTED`, `SUSPENDED`).
  * `business_license_url` (Text): Link ảnh chụp giấy phép kinh doanh phục vụ Admin thẩm định.

### 12. `store_staff` (Nhân sự cửa hàng)
* **Chức năng**: Quản lý phân quyền nội bộ giữa các nhân viên làm việc tại cùng một đại lý.
* **Các cột quan trọng**:
  * `staff_id` (PK, BigInt): Mã định danh nhân viên.
  * `store_id` (FK, BigInt): Khóa ngoại liên kết tới cửa hàng nơi nhân viên làm việc.
  * `user_id` (FK, BigInt): Khóa ngoại liên kết tới tài khoản đăng nhập của nhân viên tại bảng `users`.
  * `staff_role` (VarChar): Chức vụ (`STORE_OWNER`, `STORE_MANAGER`, `STORE_CASHIER`, `STORE_STAFF`).
  * `status` (VarChar): Trạng thái làm việc (`ACTIVE`, `INACTIVE`).

---

## PHÂN HỆ 4: DANH MỤC, SẢN PHẨM & TỒN KHO (6 bảng)

### 13. `category` (Danh mục ngành hàng)
* **Chức năng**: Phân loại sản phẩm (Bình nước 19L, Nước đóng chai, Bình Gas 12kg).
* **Các cột quan trọng**:
  * `category_id` (PK, BigInt): Mã danh mục sản phẩm.
  * `store_id` (FK, BigInt): Mã cửa hàng sở hữu danh mục này.
  * `category_name` (VarChar): Tên phân loại hàng hóa.
  * `status` (VarChar): Trạng thái hoạt động (`ACTIVE`, `INACTIVE`).

### 14. `product` (Hàng hóa kinh doanh của Cửa hàng)
* **Chức năng**: Món hàng cụ thể của từng đại lý niêm yết bán trên sàn kèm đơn giá.
* **Các cột quan trọng**:
  * `product_id` (PK, BigInt): Mã định danh duy nhất của món hàng.
  * `store_id` (FK, BigInt): Mã đại lý sở hữu và kinh doanh món hàng này.
  * `product_code` (VarChar): Mã SKU quản lý nội bộ của sản phẩm.
  * `product_name` (VarChar): Tên đầy đủ của sản phẩm (ví dụ: Nước khoáng LaVie 19L).
  * `base_price` (Decimal): Giá bán cơ sở niêm yết chưa giảm giá.
  * `status` (VarChar): Trạng thái kinh doanh (`ACTIVE`: Còn bán, `INACTIVE`: Tạm ngưng).

### 15. `product_price_history` (Lịch sử biến động giá)
* **Chức năng**: Lưu vết mọi lần thay đổi giá bán để đối soát đơn hàng cũ và chống gian lận giá.
* **Các cột quan trọng**:
  * `history_id` (PK, BigInt): Mã bản ghi lịch sử giá.
  * `product_id` (FK, BigInt): Mã sản phẩm bị thay đổi giá.
  * `old_price` (Decimal): Mức giá bán trước khi chỉnh sửa.
  * `new_price` (Decimal): Mức giá bán mới áp dụng.
  * `changed_by_user_id` (FK, BigInt): Tài khoản người thực hiện thay đổi giá.
  * `effective_at` (Timestamp): Thời điểm mức giá mới chính thức có hiệu lực.

### 16. `product_discount` (Chiến dịch khuyến mãi & Giảm giá)
* **Chức năng**: Thiết lập các chương trình Flash Sale hoặc chiết khấu giảm giá theo thời gian.
* **Các cột quan trọng**:
  * `discount_id` (PK, BigInt): Mã chương trình giảm giá.
  * `product_id` (FK, BigInt): Sản phẩm được áp dụng giảm giá.
  * `discount_percent` (Decimal): Tỷ lệ phần trăm giảm giá (ví dụ: 10.00%).
  * `discount_amount` (Decimal): Số tiền giảm trực tiếp trên mỗi sản phẩm.
  * `start_at`, `end_at` (Timestamp): Khung giờ bắt đầu và kết thúc của đợt khuyến mãi.
  * `status` (VarChar): Trạng thái chiến dịch (`ACTIVE`, `EXPIRED`, `CANCELLED`).

### 17. `inventory` (Quản lý tồn kho hàng hóa)
* **Chức năng**: Kiểm soát số lượng hàng thực tế và lượng hàng đang bị giữ chỗ khi có đơn mới tạo.
* **Các cột quan trọng**:
  * `inventory_id` (PK, BigInt): Mã định danh kho của sản phẩm.
  * `product_id` (FK, BigInt, UNIQUE): Khóa ngoại trỏ đến sản phẩm tương ứng.
  * `quantity_on_hand` (Integer): Số lượng hàng thực tế đang có sẵn trong kho.
  * `reserved_quantity` (Integer): Số lượng hàng đang bị tạm giữ chỗ khi khách vừa bấm đặt hàng.
  * `reorder_threshold` (Integer): Ngưỡng cảnh báo sắp hết hàng để chủ quán nhập thêm.

### 18. `product_image` (Hình ảnh sản phẩm)
* **Chức năng**: Thư viện hình ảnh chụp chân thực của sản phẩm hiển thị trên ứng dụng.
* **Các cột quan trọng**:
  * `image_id` (PK, BigInt): Mã hình ảnh.
  * `product_id` (FK, BigInt): Sản phẩm gắn với hình ảnh này.
  * `image_url` (Text): Đường dẫn lưu trữ ảnh trên Cloud Storage.
  * `is_primary` (Boolean): Đánh dấu đây là ảnh đại diện chính của sản phẩm.
  * `display_order` (Integer): Thứ tự hiển thị trong bộ sưu tập ảnh.

---

## PHÂN HỆ 5: HỆ SINH THÁI NÚT BẤM IOT & PHẦN CỨNG (6 bảng)

### 19. `iot_button` (Thực thể Nút bấm IoT - Trái tim hệ thống)
* **Chức năng**: Quản lý vòng đời phần cứng nút bấm ESP32-S3: lưu mã nhận diện, khóa mật mã, quyền sở hữu và mức pin.
* **Các cột quan trọng**:
  * `button_id` (PK, BigInt): Mã định danh số của nút bấm trong cơ sở dữ liệu.
  * `button_code` (VarChar, UNIQUE): Mã số in trên vỏ nút (ví dụ: `BTN-8829-WTR`) để người dùng nhận diện.
  * `mac_address` (VarChar, UNIQUE): Địa chỉ MAC phần cứng của vi điều khiển ESP32-S3.
  * `secret_key_hash` (VarChar): Chuỗi băm khóa bí mật dùng để xác thực chữ ký số HMAC-SHA256 khi bấm nút.
  * `customer_id` (FK, BigInt): Mã khách hàng đang sở hữu và sử dụng nút bấm.
  * `store_id` (FK, BigInt): Mã cửa hàng gốc xuất nút.
  * `custody_store_id` (FK, BigInt): Mã cửa hàng đang chịu trách nhiệm lưu ký và tiếp nhận đơn khi nút được bấm.
  * `address_id` (FK, BigInt): Mã địa chỉ giao hàng mặc định được gán cho nút bấm này.
  * `battery_voltage` (Integer): Điện áp pin đo qua bộ biến đổi ADC (mV), dùng để cảnh báo pin yếu.
  * `can_order` (Boolean): Cờ cho phép đặt hàng (`true`) hoặc khóa an toàn / khóa trẻ em (`false`).
  * `status` (VarChar): Trạng thái hoạt động (`ACTIVE`, `SUSPENDED`, `MAINTENANCE`).

### 20. `button_product` (Cài đặt sản phẩm cho nút)
* **Chức năng**: Quy định nút bấm này khi nhấn sẽ đặt mua sản phẩm nào và số lượng bao nhiêu.
* **Các cột quan trọng**:
  * `button_product_id` (PK, BigInt): Mã cấu hình liên kết.
  * `button_id` (FK, BigInt): Mã nút bấm tương ứng.
  * `product_id` (FK, BigInt): Mã sản phẩm mặc định gắn với nút bấm.
  * `quantity` (Integer): Số lượng sản phẩm tự động mua trong mỗi lần nhấn nút (ví dụ: 2 bình).

### 21. `device_templates` (Mẫu cấu hình thiết bị)
* **Chức năng**: Định nghĩa các bản mẫu hành vi: bấm 1 lần (đặt hàng), bấm đúp, bấm giữ lâu.
* **Các cột quan trọng**:
  * `template_id` (PK, BigInt): Mã bản mẫu cấu hình.
  * `template_name` (VarChar): Tên mẫu cấu hình (ví dụ: Nút Nước Tiêu Chuẩn, Nút Gas Khẩn Cấp).
  * `single_click_action` (VarChar): Hành động khi nhấn đơn (mặc định: `CREATE_ORDER`).
  * `double_click_action` (VarChar): Hành động khi nhấn đúp (ví dụ: `CANCEL_RECENT_ORDER`).
  * `long_press_action` (VarChar): Hành động khi nhấn giữ lâu (ví dụ: `SOS_ALERT` hoặc `FACTORY_RESET`).

### 22. `pairing_tokens` (Mã ghép nối nhanh)
* **Chức năng**: Quản lý mã QR / Token dùng một lần dán trên nút để khách quét nhận thiết bị vào tài khoản.
* **Các cột quan trọng**:
  * `token_id` (PK, BigInt): Mã định danh token ghép nối.
  * `button_id` (FK, BigInt): Nút bấm tương ứng với mã QR này.
  * `token_hash` (VarChar): Chuỗi băm bảo mật của token ghép nối.
  * `is_used` (Boolean): Đánh dấu mã đã được kích hoạt sử dụng hay chưa.
  * `expires_at` (Timestamp): Thời hạn hiệu lực của mã ghép nối.

### 23. `provisioning_sessions` (Phiên nạp bảo mật Zero-Touch)
* **Chức năng**: Lưu vết quá trình nạp phần mềm và khóa bí mật tại xưởng trước khi xuất bán.
* **Các cột quan trọng**:
  * `session_id` (PK, BigInt): Mã phiên nạp thiết bị.
  * `hardware_uuid` (VarChar): Mã định danh vĩnh viễn của phần cứng chip.
  * `mac_address` (VarChar): Địa chỉ MAC của thiết bị vừa được nạp.
  * `status` (VarChar): Trạng thái phiên nạp (`PROVISIONED`, `FAILED`).

### 24. `device_movements` (Nhật ký luân chuyển nút bấm)
* **Chức năng**: Truy vết lịch sử lưu ký vật lý của nút (từ kho tổng về quán A, giao cho khách, hoặc khách chuyển quán B).
* **Các cột quan trọng**:
  * `movement_id` (PK, BigInt): Mã lượt di chuyển thiết bị.
  * `button_id` (FK, BigInt): Mã nút bấm được điều chuyển.
  * `source_type`, `dest_type` (VarChar): Loại điểm đi và điểm đến (`WAREHOUSE`, `STORE`, `CUSTOMER`).
  * `source_store_id`, `dest_store_id` (BigInt): Mã cửa hàng bàn giao và cửa hàng tiếp nhận.
  * `actor_user_id` (FK, BigInt): Người thực hiện thao tác bàn giao thiết bị.
  * `from_inventory_state`, `to_inventory_state` (VarChar): Trạng thái tồn kho của nút trước và sau khi chuyển.

---

## PHÂN HỆ 6: ĐƠN HÀNG, TIẾN ĐỘ & GIAO VẬN (5 bảng)

### 25. `orders` (Đơn đặt hàng)
* **Chức năng**: Bản ghi trung tâm lưu trữ toàn bộ thông tin đơn hàng sinh ra khi người dùng bấm nút hoặc đặt qua app.
* **Các cột quan trọng**:
  * `order_id` (PK, BigInt): Mã đơn hàng duy nhất trong cơ sở dữ liệu.
  * `order_code` (VarChar, UNIQUE): Mã đơn hiển thị cho người dùng (ví dụ: `ORD-20261105-289464`).
  * `button_id` (FK, BigInt): Mã nút bấm đã kích hoạt tạo đơn (nếu đặt qua nút).
  * `customer_id` (FK, BigInt): Khách hàng đặt mua.
  * `store_id` (FK, BigInt): Đại lý tiếp nhận và xử lý đơn hàng.
  * `driver_id` (FK, BigInt): Tài xế được phân công đi giao hàng.
  * `total_amount` (Decimal): Tổng số tiền khách phải thanh toán.
  * `order_status` (VarChar): Trạng thái đơn (`PENDING`, `CONFIRMED`, `PREPARING`, `SHIPPING`, `DELIVERED`, `CANCELLED`).
  * `payment_method` (VarChar): Phương thức thanh toán (`COD`: Tiền mặt, `PAYOS`: Chuyển khoản VietQR).
  * `iot_request_id` (VarChar, UNIQUE): Khóa Idempotency chống tạo đơn trùng khi nút gửi lặp gói tin.

### 26. `order_item` (Chi tiết món hàng trong đơn)
* **Chức năng**: Từng dòng sản phẩm cụ thể trong đơn (món gì, giá lúc mua, số lượng, tiền giảm giá).
* **Các cột quan trọng**:
  * `order_item_id` (PK, BigInt): Mã chi tiết dòng hàng.
  * `order_id` (FK, BigInt): Khóa ngoại trỏ đến đơn hàng cha tại bảng `orders`.
  * `product_id` (FK, BigInt): Mã món hàng được mua.
  * `quantity` (Integer): Số lượng sản phẩm mua.
  * `unit_price` (Decimal): Đơn giá gốc tại thời điểm đặt hàng.
  * `discount_amount` (Decimal): Số tiền được giảm giá trên dòng này.
  * `line_total` (Decimal): Tổng tiền thực tế của dòng hàng sau giảm giá.

### 27. `order_status_history` (Dòng thời gian tiến độ đơn hàng)
* **Chức năng**: Ghi nhận thời gian và người thay đổi trạng thái đơn để đối soát dịch vụ khách hàng.
* **Các cột quan trọng**:
  * `history_id` (PK, BigInt): Mã bản ghi tiến độ.
  * `order_id` (FK, BigInt): Đơn hàng tương ứng.
  * `from_status`, `to_status` (VarChar): Trạng thái trước và sau khi thay đổi.
  * `changed_by_user_id` (FK, BigInt): Tài khoản người thực hiện thay đổi trạng thái.
  * `note` (Text): Ghi chú lý do thay đổi (ví dụ: Khách hẹn giao sau 18h).

### 28. `driver_shifts` (Ca trực của Tài xế)
* **Chức năng**: Quản lý ca làm việc của shipper (giờ bắt đầu trực, giờ kết ca, trạng thái sẵn sàng nhận đơn).
* **Các cột quan trọng**:
  * `shift_id` (PK, BigInt): Mã ca trực.
  * `driver_user_id` (FK, BigInt): Tài khoản tài xế làm việc.
  * `store_id` (FK, BigInt): Đại lý nơi tài xế trực thuộc.
  * `shift_status` (VarChar): Trạng thái ca trực (`OPEN`, `ON_DUTY`, `CLOSING`, `CLOSED`).
  * `started_at`, `ended_at` (Timestamp): Thời điểm bắt đầu và kết thúc ca trực.

### 29. `driver_duties` (Lượt giao hàng của Tài xế)
* **Chức năng**: Nhiệm vụ giao một đơn hàng cụ thể được gán cho tài xế kèm bằng chứng ảnh chụp khi giao xong.
* **Các cột quan trọng**:
  * `duty_id` (PK, BigInt): Mã lượt giao hàng.
  * `shift_id` (FK, BigInt): Ca trực của tài xế thực hiện nhiệm vụ.
  * `order_id` (FK, BigInt): Đơn hàng cần đi giao.
  * `duty_status` (VarChar): Trạng thái giao (`ASSIGNED`, `IN_TRANSIT`, `COMPLETED`, `FAILED`).
  * `delivery_proof_url` (Text): Link ảnh chụp chữ ký hoặc ảnh bình nước đã đặt tại nhà khách.

---

## PHÂN HỆ 7: THUÊ NÚT, GÓI CƯỚC & ĐẶT CỌC (7 bảng)

### 30. `subscription_plans` (Các gói cước phần mềm)
* **Chức năng**: Bảng giá dịch vụ phần mềm dành cho các đại lý kinh doanh trên sàn.
* **Các cột quan trọng**:
  * `plan_id` (PK, BigInt): Mã gói cước.
  * `plan_name` (VarChar): Tên gói cước (ví dụ: Gói Cơ Bản, Gói Đại Lý Lớn).
  * `monthly_fee` (Decimal): Mức phí thuê dịch vụ hàng tháng.
  * `max_buttons_allowed` (Integer): Số lượng nút bấm tối đa được quản lý trong gói.

### 31. `store_subscriptions` (Đăng ký gói cước của Quán)
* **Chức năng**: Hợp đồng thuê bao phần mềm của từng quán với nền tảng.
* **Các cột quan trọng**:
  * `subscription_id` (PK, BigInt): Mã đăng ký gói cước.
  * `store_id` (FK, BigInt): Đại lý đăng ký gói.
  * `plan_id` (FK, BigInt): Gói cước đã chọn.
  * `status` (VarChar): Trạng thái hợp đồng (`ACTIVE`, `PAST_DUE`, `EXPIRED`, `CANCELLED`).
  * `current_period_end` (Timestamp): Hạn dùng của chu kỳ cước hiện tại.

### 32. `rental_packages` (Gói thuê nút bấm phần cứng)
* **Chức năng**: Bảng giá thuê phần cứng (tiền đặt cọc mỗi nút và tiền thuê mỗi tháng).
* **Các cột quan trọng**:
  * `package_id` (PK, BigInt): Mã gói thuê nút.
  * `package_name` (VarChar): Tên gói thuê phần cứng.
  * `deposit_per_button` (Decimal): Tiền cọc bảo đảm cho mỗi nút bấm (ví dụ: 100.000đ).
  * `rental_fee_per_month` (Decimal): Tiền cước thuê 1 nút trong 1 tháng (ví dụ: 20.000đ).

### 33. `button_rentals` (Hợp đồng thuê nút cụ thể)
* **Chức năng**: Hợp đồng mượn/thuê nút giữa Cửa hàng và Khách hàng hoặc Cửa hàng và Admin.
* **Các cột quan trọng**:
  * `rental_id` (PK, BigInt): Mã hợp đồng thuê nút.
  * `store_id` (FK, BigInt): Cửa hàng cung cấp nút.
  * `customer_id` (FK, BigInt): Khách hàng thuê/mượn nút.
  * `rental_status` (VarChar): Trạng thái thuê (`ACTIVE`, `TERMINATED`, `OVERDUE`).
  * `monthly_rent_per_button_snapshot` (Decimal): Giá cước thuê nút được đóng băng cố định theo hợp đồng.
  * `effective_expires_at` (Timestamp): Thời điểm hết hạn hợp đồng thuê.

### 34. `rental_deposits` (Tiền đặt cọc nút bấm)
* **Chức năng**: Quản lý khoản tiền cọc an toàn khi nhận nút vật lý để bảo vệ tài sản phần cứng.
* **Các cột quan trọng**:
  * `deposit_id` (PK, BigInt): Mã khoản tiền cọc.
  * `rental_id` (FK, BigInt): Hợp đồng thuê nút tương ứng.
  * `deposit_amount` (Decimal): Số tiền đặt cọc đã nộp.
  * `status` (VarChar): Trạng thái tiền cọc (`HELD`: Đang giữ, `REFUNDED`: Đã hoàn trả, `FORFEITED`: Mất nút tịch thu cọc).

### 35. `rental_returns` (Biên bản trả nút bấm)
* **Chức năng**: Ghi nhận việc khách đem trả nút, thẩm định hỏng hóc để tính số tiền cọc được hoàn lại.
* **Các cột quan trọng**:
  * `return_id` (PK, BigInt): Mã biên bản trả nút.
  * `rental_id` (FK, BigInt): Hợp đồng thuê ban đầu.
  * `button_id` (FK, BigInt): Mã nút bấm được trả lại.
  * `hardware_condition` (VarChar): Tình trạng phần cứng (`GOOD`: Nguyên vẹn, `DAMAGED`: Hỏng hóc).
  * `refund_eligible_amount` (Decimal): Số tiền cọc đủ điều kiện được hoàn trả về tài khoản.

### 36. `rental_audit_logs` (Nhật ký kiểm toán hợp đồng thuê)
* **Chức năng**: Lưu vết mọi thao tác gia hạn hoặc thay đổi giá thuê nút để phục vụ đối soát pháp lý.
* **Các cột quan trọng**:
  * `log_id` (PK, BigInt): Mã bản ghi kiểm toán.
  * `rental_id` (FK, BigInt): Hợp đồng thuê bị can thiệp.
  * `action` (VarChar): Hành động (`EXTEND`, `TERMINATE`, `ADJUST_PRICE`).
  * `changed_by_user_id` (FK, BigInt): Tài khoản người thực hiện thay đổi.

---

## PHÂN HỆ 8: TÀI CHÍNH, VÍ CỬA HÀNG & TIỀN MẶT (5 bảng)

### 37. `store_wallets` (Ví điện tử Cửa hàng)
* **Chức năng**: Quản lý tiền bán hàng của đại lý, phân tách tiền có thể rút và tiền đang bị phong tỏa.
* **Các cột quan trọng**:
  * `wallet_id` (PK, BigInt): Mã định danh ví.
  * `store_id` (FK, BigInt, UNIQUE): Đại lý sở hữu ví này.
  * `available_balance` (Decimal): Số dư khả dụng (tiền có thể tạo lệnh rút về ngân hàng).
  * `locked_balance` (Decimal): Số dư phong tỏa (tiền đang trong lệnh rút chờ ngân hàng xử lý).

### 38. `wallet_transactions` (Lịch sử biến động số dư ví)
* **Chức năng**: Bảng kê chi tiết từng đồng tiền ra vào ví (+ tiền bán hàng, - phí sàn, - tiền rút).
* **Các cột quan trọng**:
  * `transaction_id` (PK, BigInt): Mã giao dịch ví.
  * `wallet_id` (FK, BigInt): Ví bị biến động số dư.
  * `amount` (Decimal): Số tiền cộng (+) hoặc trừ (-).
  * `type` (VarChar): Loại biến động (`ORDER_REVENUE`, `WITHDRAWAL`, `PLATFORM_FEE`).
  * `balance_after` (Decimal): Số dư ví ngay sau khi thực hiện giao dịch.

### 39. `store_withdrawals` (Lệnh rút tiền về ngân hàng)
* **Chức năng**: Quản lý yêu cầu rút tiền từ ví cửa hàng về tài khoản ngân hàng thực tế qua PayOS Payout.
* **Các cột quan trọng**:
  * `id` (PK, BigInt): Mã lệnh rút tiền.
  * `store_id` (FK, BigInt): Cửa hàng yêu cầu rút tiền.
  * `bank_account_id` (FK, BigInt): Tài khoản ngân hàng thụ hưởng nhận tiền.
  * `amount` (Decimal): Số tiền yêu cầu rút.
  * `status` (VarChar): Trạng thái rút (`PENDING`, `APPROVED`, `PROCESSING`, `COMPLETED`, `FAILED`).
  * `idempotency_key` (VarChar, UNIQUE): Khóa chống tạo lệnh rút tiền trùng lặp.
  * `payout_ref` (VarChar): Mã tham chiếu giao dịch từ cổng thanh toán PayOS.

### 40. `store_cash_vouchers` (Phiếu thu tiền mặt)
* **Chức năng**: Tạo mã phiếu thu khi khách hàng hoặc shipper thanh toán tiền mặt trực tiếp.
* **Các cột quan trọng**:
  * `id` (PK, BigInt): Mã phiếu thu.
  * `customer_id` (FK, BigInt): Khách hàng nộp tiền mặt.
  * `collecting_store_id` (FK, BigInt): Đại lý thực hiện thu tiền mặt.
  * `amount` (Decimal): Số tiền mặt thu được.
  * `token_hash` (VarChar): Mã xác thực bảo mật của phiếu thu.
  * `status` (VarChar): Trạng thái (`PENDING`, `CONSUMED`, `EXPIRED`).

### 41. `store_cash_receipts` (Biên lai đối soát tiền mặt)
* **Chức năng**: Xác nhận tiền mặt thực tế đã được nộp vào két và hạch toán vào hệ thống kế toán quán.
* **Các cột quan trọng**:
  * `id` (PK, BigInt): Mã biên lai hạch toán.
  * `voucher_id` (FK, BigInt): Mã phiếu thu tiền mặt tương ứng.
  * `amount` (Decimal): Số tiền mặt đã đối soát khớp.
  * `wallet_transaction_id` (FK, BigInt): Giao dịch ví tương ứng ghi nhận tiền vào hệ thống.
  * `collected_by_user_id` (FK, BigInt): Thu ngân thực hiện kiểm đếm và nhận tiền.

---

## PHÂN HỆ 9: CỔNG THANH TOÁN & HÓA ĐƠN THU PHÍ (BILLING) (6 bảng)

### 42. `payment_transaction` (Giao dịch thanh toán đơn hàng)
* **Chức năng**: Lưu thông tin thanh toán trực tuyến qua cổng VietQR PayOS khi khách đặt mua hàng.
* **Các cột quan trọng**:
  * `transaction_id` (PK, BigInt): Mã giao dịch thanh toán.
  * `order_id` (FK, BigInt): Đơn hàng tương ứng với khoản thanh toán này.
  * `amount` (Decimal): Số tiền thanh toán.
  * `payment_method` (VarChar): Cổng thanh toán (`PAYOS`, `VNPAY`).
  * `status` (VarChar): Trạng thái giao dịch (`PENDING`, `SUCCESS`, `FAILED`).
  * `provider_transaction_code` (VarChar): Mã giao dịch do cổng thanh toán PayOS cấp.

### 43. `billing_charges` (Hóa đơn thu cước định kỳ)
* **Chức năng**: Hóa đơn do hệ thống tự động sinh vào đầu tháng để thu tiền thuê nút bấm từ các đại lý.
* **Các cột quan trọng**:
  * `charge_id` (PK, BigInt): Mã hóa đơn cước.
  * `charge_code` (VarChar, UNIQUE): Mã hóa đơn duy nhất (ví dụ: `INV-202611-0012`).
  * `store_id` (FK, BigInt): Đại lý có nghĩa vụ thanh toán hóa đơn.
  * `total_amount` (Decimal): Tổng số tiền cước phải đóng.
  * `paid_amount` (Decimal): Số tiền thực tế đại lý đã chuyển khoản thanh toán.
  * `status` (VarChar): Trạng thái thanh toán cước (`UNPAID`, `PAID`, `OVERDUE`).
  * `due_date` (Timestamp): Ngày hạn chót phải hoàn tất đóng cước.

### 44. `billing_charge_lines` (Chi tiết dòng cước trong hóa đơn)
* **Chức năng**: Bóc tách chi tiết từng khoản cước (phí thuê 10 nút x 20.000đ; gói phần mềm Pro).
* **Các cột quan trọng**:
  * `line_id` (PK, BigInt): Mã dòng cước.
  * `charge_id` (FK, BigInt): Hóa đơn cước cha tương ứng.
  * `description` (VarChar): Nội dung khoản cước chi tiết.
  * `amount` (Decimal): Số tiền của dòng cước này.
  * `duration_count`, `duration_unit` (Integer, VarChar): Thời lượng tính cước (ví dụ: 1 Tháng).

### 45. `billing_payment_receipts` (Biên nhận tiền đóng cước)
* **Chức năng**: Bằng chứng ghi nhận tiền đóng cước của đại lý đổ về từ cổng thanh toán PayOS.
* **Các cột quan trọng**:
  * `id` (PK, BigInt): Mã biên nhận tiền cước.
  * `charge_id` (FK, BigInt): Hóa đơn cước được thanh toán.
  * `provider` (VarChar): Cổng tiếp nhận tiền (`PAYOS`).
  * `amount` (Decimal): Số tiền thực tế nhận được từ tài khoản ngân hàng.
  * `provider_transaction_ref` (VarChar): Mã đối soát chuyển khoản ngân hàng.
  * `received_at` (Timestamp): Thời điểm ngân hàng báo nhận được tiền.

### 46. `billing_overpayment_obligations` (Nghĩa vụ tiền nộp thừa)
* **Chức năng**: Xử lý tình huống đại lý nộp thừa tiền cước (ghi nợ trừ tháng sau hoặc hoàn lại).
* **Các cột quan trọng**:
  * `id` (PK, BigInt): Mã nghĩa vụ tiền nộp thừa.
  * `receipt_id` (FK, BigInt): Biên nhận thanh toán có khoản tiền thừa.
  * `amount` (Decimal): Số tiền nộp thừa phát sinh.
  * `status` (VarChar): Trạng thái xử lý (`OPEN`: Chờ giải quyết, `RESOLVED`: Đã cấn trừ/hoàn tiền).

### 47. `deposit_refunds` (Lệnh hoàn tiền cọc nút bấm)
* **Chức năng**: Quản lý lệnh hoàn tiền cọc nút bấm về tài khoản ngân hàng của khách một cách an toàn.
* **Các cột quan trọng**:
  * `refund_id` (PK, BigInt): Mã lệnh hoàn cọc.
  * `customer_id` (FK, BigInt): Khách hàng nhận lại tiền cọc.
  * `bank_account_id` (FK, BigInt): Tài khoản ngân hàng nhận tiền.
  * `refund_amount` (Decimal): Số tiền cọc được hoàn trả.
  * `status` (VarChar): Trạng thái hoàn cọc (`PENDING`, `APPROVED`, `TRANSFERRED`).
  * `recipient_account_number_masked` (VarChar): Số tài khoản nhận tiền được che dạng `******1234` để bảo mật.

---

## PHÂN HỆ 10: XÁC MINH NGÂN HÀNG 2.000Đ & EKYC (9 bảng)

### 48. `customer_bank_accounts` (Tài khoản ngân hàng của Khách)
* **Chức năng**: Quản lý tài khoản ngân hàng nhận tiền hoàn cọc của khách (mã hóa dữ liệu theo chuẩn PCI-DSS).
* **Các cột quan trọng**:
  * `account_id` (PK, BigInt): Mã tài khoản ngân hàng lưu trong hệ thống.
  * `customer_id` (FK, BigInt): Khách hàng sở hữu tài khoản này.
  * `bank_bin` (VarChar): Mã định danh ngân hàng VietQR (ví dụ: 970422 cho MBBank).
  * `account_number_encrypted` (Text): Số tài khoản được mã hóa bằng thuật toán AES-256-GCM.
  * `account_number_hash` (VarChar, UNIQUE): Chuỗi băm SHA-256 dùng để tìm kiếm số tài khoản mà không cần giải mã.
  * `account_number_masked` (VarChar): Số tài khoản hiển thị cho người dùng dạng `******1234`.
  * `account_holder_name` (VarChar): Tên chủ tài khoản viết hoa không dấu.
  * `is_verified` (Boolean): Cờ đánh dấu tài khoản đã được xác minh chính chủ thành công hay chưa.

### 49. `customer_bank_verification_proofs` (Phiên xác minh 2.000đ)
* **Chức năng**: Khởi tạo phiên xác thực tài khoản chính chủ bằng mã VietQR chuyển 2.000đ kèm mã code ngẫu nhiên.
* **Các cột quan trọng**:
  * `id` (PK, BigInt): Mã phiên xác minh.
  * `customer_id` (FK, BigInt): Khách hàng cần xác minh.
  * `account_id` (FK, BigInt): Tài khoản ngân hàng cần kiểm tra.
  * `expected_amount` (Decimal): Số tiền bắt buộc chuyển (chính xác `2000.00`).
  * `verification_code` (VarChar, UNIQUE): Mã nội dung chuyển khoản ngẫu nhiên (ví dụ: `V2K-88294`).
  * `qr_data_url` (Text): Chuỗi dữ liệu mã VietQR động để hiển thị lên app cho khách quét.
  * `status` (VarChar): Trạng thái phiên (`PENDING`, `MATCHED`, `EXPIRED`).

### 50. `customer_bank_inbound_transactions` (Giao dịch 2.000đ nhận về)
* **Chức năng**: Lưu biến động số dư từ cổng thanh toán gửi về để đối soát khớp phiên chuyển khoản 2.000đ.
* **Các cột quan trọng**:
  * `id` (PK, BigInt): Mã giao dịch nhận tiền.
  * `proof_id` (FK, BigInt): Phiên xác minh tương ứng được khớp.
  * `amount` (Decimal): Số tiền nhận thực tế từ ngân hàng.
  * `reference_code` (VarChar): Mã giao dịch ngân hàng.
  * `sender_account_number` (VarChar): Số tài khoản người gửi tiền tới.
  * `reconciliation_flag` (VarChar): Cờ đánh giá đối soát (`MATCHED`, `AMOUNT_DIFF`, `ANOMALY`).

### 51. `customer_bank_refund_obligations` (Nghĩa vụ hoàn lại 2.000đ)
* **Chức năng**: Cam kết của hệ thống: Sau khi xác minh đúng chính chủ, tự động tạo lệnh hoàn trả lại đúng 2.000đ.
* **Các cột quan trọng**:
  * `id` (PK, BigInt): Mã nghĩa vụ hoàn tiền 2k.
  * `inbound_transaction_id` (FK, BigInt): Giao dịch tiền vào tương ứng.
  * `account_id` (FK, BigInt): Tài khoản ngân hàng nhận tiền hoàn lại.
  * `refund_amount` (Decimal): Số tiền hoàn trả (đúng `2000.00`).
  * `status` (VarChar): Trạng thái hoàn tiền (`PENDING`, `PROCESSING`, `COMPLETED`, `FAILED`).

### 52. `customer_bank_refund_payout_attempts` (Nhật ký bắn tiền hoàn 2k)
* **Chức năng**: Ghi lại lịch sử từng lần gọi API PayOS Payout để bắn trả 2.000đ, phục vụ cơ chế tự động thử lại nếu ngân hàng bảo trì.
* **Các cột quan trọng**:
  * `id` (PK, BigInt): Mã lần thử chuyển tiền.
  * `obligation_id` (FK, BigInt): Nghĩa vụ hoàn tiền tương ứng.
  * `attempt_no` (Integer): Số thứ tự lần gọi API (lần 1, lần 2, lần 3).
  * `payout_response_code` (VarChar): Mã kết quả phản hồi từ cổng PayOS.
  * `attempted_at` (Timestamp): Thời điểm thực hiện lệnh chuyển tiền.

### 53. `store_bank_accounts` (Tài khoản ngân hàng của Cửa hàng)
* **Chức năng**: Lưu tài khoản ngân hàng chính thức của đại lý để nhận doanh thu rút về từ ví điện tử.
* **Các cột quan trọng**:
  * `id` (PK, BigInt): Mã tài khoản ngân hàng của đại lý.
  * `store_id` (FK, BigInt): Cửa hàng sở hữu tài khoản.
  * `bank_bin` (VarChar): Mã định danh ngân hàng VietQR.
  * `account_number_encrypted` (Text): Số tài khoản ngân hàng được mã hóa AES-256.
  * `account_number_masked` (VarChar): Số tài khoản hiển thị che dạng `******1234`.
  * `account_holder_name` (VarChar): Tên chủ tài khoản doanh nghiệp hoặc chủ hộ kinh doanh.
  * `is_verified` (Boolean): Đã được Admin kiểm tra hợp lệ hay chưa.

### 54. `bank_account_verification_transactions` (Lịch sử xác thực ngân hàng quán)
* **Chức năng**: Lưu vết các lần kiểm tra tài khoản ngân hàng của quán trước khi kích hoạt tính năng rút tiền.
* **Các cột quan trọng**:
  * `id` (PK, BigInt): Mã giao dịch kiểm tra.
  * `bank_account_id` (FK, BigInt): Tài khoản ngân hàng của quán được kiểm tra.
  * `status` (VarChar): Kết quả kiểm tra (`SUCCESS`, `FAILED`).
  * `failure_reason` (VarChar): Lý do thất bại (sai tên chủ tài khoản, tài khoản bị khóa).

### 55. `identity_verification_sessions` (Phiên định danh eKYC)
* **Chức năng**: Quản lý phiên quét căn cước công dân và khuôn mặt 3D của khách hàng qua Didit AI.
* **Các cột quan trọng**:
  * `session_id` (PK, BigInt): Mã phiên định danh eKYC.
  * `customer_id` (FK, BigInt): Khách hàng thực hiện eKYC.
  * `vendor` (VarChar): Đơn vị AI cung cấp dịch vụ (`DIDIT`).
  * `vendor_session_id` (VarChar): Mã phiên trên hệ thống máy chủ Didit Cloud.
  * `status` (VarChar): Trạng thái xác thực (`PENDING`, `APPROVED`, `DECLINED`).

### 56. `didit_webhook_events` (Nhật ký sự kiện Webhook eKYC)
* **Chức năng**: Lưu trữ toàn bộ kết quả chấm điểm sinh trắc học do Didit gửi về để phục vụ kiểm toán sau này.
* **Các cột quan trọng**:
  * `event_id` (PK, BigInt): Mã sự kiện webhook.
  * `session_id` (FK, BigInt): Phiên eKYC tương ứng.
  * `event_type` (VarChar): Loại sự kiện (`SESSION_COMPLETED`, `VERIFICATION_APPROVED`).
  * `payload_hash` (VarChar): Mã băm toàn vẹn của gói tin webhook chống sửa đổi dữ liệu.
  * `verified_at` (Timestamp): Thời điểm hệ thống hoàn tất thẩm định.

---

## PHÂN HỆ 11: HẠ TẦNG KỸ THUẬT & BẢO MẬT HỆ THỐNG (8 bảng)

### 57. `iot_idempotency_keys` (Chống lặp tín hiệu nút bấm)
* **Chức năng**: Ngăn chặn tình trạng bấm nút nhiều lần liên tiếp (double-click) hoặc mạng chập chờn tạo ra 2 đơn hàng trùng nhau.
* **Các cột quan trọng**:
  * `key_id` (PK, BigInt): Mã khóa chống trùng.
  * `button_id` (FK, BigInt): Nút bấm phát tín hiệu.
  * `request_hash` (VarChar, UNIQUE): Chuỗi băm đại diện cho lần bấm nút đó.
  * `order_id` (FK, BigInt): Đơn hàng đầu tiên được tạo ra từ lần bấm này (dùng để trả về ngay nếu bấm lặp).

### 58. `device_nonces` (Nonce chống tấn công phát lại)
* **Chức năng**: Mỗi lần bấm nút gửi kèm 1 chuỗi số ngẫu nhiên dùng 1 lần (Nonce). Kẻ xấu bắt trộm sóng Wi-Fi phát lại cũng sẽ bị hủy.
* **Các cột quan trọng**:
  * `button_id` (PK/FK, BigInt): Nút bấm tương ứng.
  * `nonce` (PK, VarChar): Chuỗi ký tự ngẫu nhiên dùng 1 lần của lần bấm đó.
  * `created_at` (Timestamp): Thời điểm ghi nhận Nonce.

### 59. `api_idempotency_keys` (Chống bấm lặp API Backend)
* **Chức năng**: Bảo vệ các thao tác nhạy cảm (như bấm nút Thanh toán, Rút tiền) không bị trừ tiền 2 lần khi khách bấm đúp nút trên app.
* **Các cột quan trọng**:
  * `key` (PK, VarChar): Chuỗi Idempotency-Key gửi từ Header của điện thoại.
  * `actual_path` (VarChar): Đường dẫn API được bảo vệ (ví dụ: `/api/v1/store-withdrawals`).
  * `method` (VarChar): Phương thức HTTP (`POST`, `PUT`).
  * `lock_token` (VarChar): Token khóa đồng thời chống 2 request chạy song song cùng 1 lúc.
  * `response_status` (Integer): Mã HTTP Response lưu lại để trả về ngay nếu bấm lặp lại (ví dụ: 200).
  * `response_body` (Text): Nội dung kết quả đã trả về trước đó.

### 60. `subscription_idempotency_keys` (Chống trừ cước lặp)
* **Chức năng**: Đảm bảo cron job tính tiền thuê nút hàng tháng chỉ trừ tiền đúng 1 lần duy nhất trong chu kỳ.
* **Các cột quan trọng**:
  * `key_id` (PK, BigInt): Mã khóa cước.
  * `subscription_id` (FK, BigInt): Hợp đồng thuê nút tương ứng.
  * `billing_cycle` (VarChar): Chu kỳ tháng tính cước (ví dụ: `2026-11`).
  * `status` (VarChar): Trạng thái xử lý cước (`PROCESSED`, `FAILED`).

### 61. `notifications` (Chuông thông báo ứng dụng)
* **Chức năng**: Lưu các tin nhắn thông báo hiển thị trên ứng dụng (Đơn hàng đang giao, Cảnh báo pin yếu, Tiền về ví).
* **Các cột quan trọng**:
  * `notification_id` (PK, BigInt): Mã thông báo.
  * `user_id` (FK, BigInt): Người nhận thông báo.
  * `title` (VarChar): Tiêu đề ngắn gọn của thông báo.
  * `content` (Text): Nội dung chi tiết thông báo gửi đến người dùng.
  * `type` (VarChar): Loại thông báo (`ORDER`, `BATTERY_ALERT`, `WALLET_UPDATE`, `SYSTEM`).
  * `is_read` (Boolean): Đánh dấu người dùng đã mở xem thông báo hay chưa.

### 62. `user_fcm_tokens` (Mã thiết bị bắn thông báo đẩy)
* **Chức năng**: Lưu mã Firebase Cloud Messaging của điện thoại để hệ thống bắn thông báo đẩy ra màn hình khóa.
* **Các cột quan trọng**:
  * `token_id` (PK, BigInt): Mã token thiết bị.
  * `user_id` (FK, BigInt): Người dùng sở hữu thiết bị này.
  * `fcm_token` (Text): Chuỗi mã thiết bị do Google Firebase cấp.
  * `device_type` (VarChar): Hệ điều hành (`IOS`, `ANDROID`).
  * `is_active` (Boolean): Thiết bị có đang bật nhận thông báo đẩy hay không.

### 63. `dead_letter_jobs` (Hàng đợi lỗi - DLQ)
* **Chức năng**: Tiếp nhận các công việc chạy ngầm (gửi mail, đồng bộ kho) bị lỗi sau nhiều lần thử lại để lập trình viên tra soát.
* **Các cột quan trọng**:
  * `job_id` (PK, BigInt): Mã công việc bị lỗi.
  * `queue_name` (VarChar): Tên hàng đợi nền (`EMAIL_QUEUE`, `PAYMENT_WEBHOOK_QUEUE`).
  * `job_name` (VarChar): Tên tác vụ cụ thể bị hỏng.
  * `payload` (Text): Dữ liệu đầu vào của tác vụ đó để lập trình viên bấm chạy lại (Retry).
  * `error_message` (Text): Chi tiết nguyên nhân và mã lỗi khi server gặp sự cố.
  * `failed_at` (Timestamp): Thời điểm tác vụ chính thức bị dừng và đưa vào hàng đợi lỗi.

### 64. `outbox_events` (Mô hình Outbox đồng bộ dữ liệu an toàn)
* **Chức năng**: Đảm bảo khi lưu dữ liệu vào PostgreSQL thành công mới gửi tin ra Redis/Message Queue mà không sợ mất tin khi server sập.
* **Các cột quan trọng**:
  * `id` (PK, BigInt): Mã sự kiện outbox.
  * `aggregate_type` (VarChar): Thực thể gốc phát sinh sự kiện (`ORDER`, `BUTTON`, `WITHDRAWAL`).
  * `aggregate_id` (BigInt): ID của thực thể tương ứng.
  * `event_type` (VarChar): Tên sự kiện (ví dụ: `ORDER_CREATED`, `BUTTON_TRANSFERRED`).
  * `payload` (Text): Nội dung chi tiết của sự kiện dạng JSON.
  * `status` (VarChar): Trạng thái gửi tin (`PENDING`: Chờ gửi, `PUBLISHED`: Đã bắn ra Message Broker).
  * `published_at` (Timestamp): Thời điểm sự kiện được bắn thành công ra bên ngoài.
