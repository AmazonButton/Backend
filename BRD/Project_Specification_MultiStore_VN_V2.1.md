# Tài Liệu Đặc Tả Dự Án (Project Specification)
## Nền Tảng Đặt Hàng Qua Nút Bấm IoT Đa Cửa Hàng & Sàn Thương Mại Điện Tử
**Phiên bản: V2.2 (Universal Smart Button & Multi-Store Marketplace Ecosystem)**

---

## 1. Tổng quan dự án (Project Overview)

Dự án xây dựng nền tảng Thương mại Điện tử và IoT cho phép khách hàng đặt hàng siêu tốc tức thì (Zero-Touch Ordering) chỉ bằng một thao tác bấm nút vật lý (Single Press) gắn tại nhà/văn phòng.

Hệ thống hoạt động theo mô hình **Sàn Thương Mại Điện Tử Đa Cửa Hàng (Multi-Store Marketplace)**:
- Tài khoản của Khách hàng mang tính toàn cầu (Global Customer Account).
- **Mô hình Nút Thông Minh Đa Năng (Universal Smart Button)**: Nút bấm IoT thuộc quyền sở hữu của Khách hàng (hoặc do Sàn cấp phát). Khách hàng có quyền linh hoạt **ghép nối và chuyển đổi Cửa hàng cung cấp (Dynamic Store Re-mapping)** trên Web/App bất cứ lúc nào.
- **Mô hình Thu phí Sàn Phân Tầng (Dual-Fee Marketplace Monetization)**:
  1. **Phí Thuê Bao Gian Hàng (STORE_SUBSCRIPTIONS)**: Store trả phí cố định định kỳ hàng tháng để duy trì gian hàng và quyền đăng bán sản phẩm.
  2. **Phí Hoa Hồng Sàn Trên Đơn Hàng (COMMISSION_RATE & COMMISSION_AMOUNT)**: Sàn thu chiết khấu % trên mỗi đơn hàng thành công (mặc định 8% - 10%), tự động khấu trừ trước khi ghi có doanh thu thực nhận (
et_amount) vào Ví Cửa Hàng (STORE_WALLETS).
  3. **Phí Thuê & Cọc Thiết Bị IoT (BUTTON_RENTALS)**: Do Khách hàng chi trả trực tiếp cho Sàn (Admin). Store không phải lo chi phí phần cứng và không phát sinh tranh chấp thiết bị khi khách chuyển đổi cửa hàng.

---

## 2. Phạm vi dự án (Scope)

### 2.1 Trong phạm vi (In scope)

- **Quản lý đa Cửa hàng (Multi-Store Management)**: Cách ly dữ liệu sản phẩm, tồn kho, đơn hàng, ví tiền giữa các Store.
- **Quản lý tài khoản & phân quyền (RBAC)**: Phân quyền chặt chẽ theo mô hình 4 tầng `CUSTOMER → STORE_OWNER → SYSTEM_STAFF → ADMIN / SYSTEM_ADMIN / SUPER_ADMIN` (đã ngừng cấp các vai trò `STORE_STAFF` và `STAFF_DELIVERY` / shipper riêng của cửa hàng).
- **Quản lý hồ sơ & danh bạ địa chỉ Khách hàng**: Hỗ trợ nhiều địa chỉ, bảo vệ duy nhất một địa chỉ mặc định để nhận hàng khi bấm nút.
- **Mô hình Nút Thông Minh Đa Năng (Universal IoT Button)**:
  - Một Nút bấm gắn liền với Khách hàng sở hữu (customer_id).
  - Cho phép Khách hàng **chuyển đổi Cửa hàng (Store Re-mapping)** linh hoạt trên ứng dụng.
  - Khi đổi Cửa hàng, hệ thống tự động làm mới danh sách sản phẩm cấu hình trên nút (BUTTON_PRODUCT) theo menu của Store mới.
- **Tạo đơn hàng Zero-Touch từ Nút bấm IoT**: Xử lý tín hiệu an toàn chống giả mạo chữ ký (HMAC-SHA256) và chống phát lại gói tin (Anti-Replay Nonce).
- **Quy trình hoàn tất đơn hàng chuẩn State Machine**: PENDING → CONFIRMED → PREPARING → READY_FOR_DELIVERY → SHIPPING → DELIVERED → COMPLETED.
- **Cơ chế Khóa & Trừ tồn kho 2 bước (Two-Phase Inventory Commit)**: Giữ chỗ (
eserved_quantity) khi bấm nút và trừ kho thực tế (quantity_on_hand) khi xác nhận đơn.
- **Kênh Thu Thanh toán Online PayOS & Ghi nhận Sổ cái nội bộ (Ledger)**:
  - Tích hợp PayOS Webhook xác thực chữ ký HMAC chống giả mạo.
  - Đảm bảo tính Idempotency: không cộng tiền 2 lần khi webhook gọi lại.
  - Tự động khấu trừ phí hoa hồng Sàn (commission_amount), ghi có số tiền thực nhận (
et_amount) vào Ví Cửa Hàng (STORE_WALLETS).
- **Kênh Chi PayOS Payout Tự Động & Khóa số dư 2 pha (Two-Phase Balance Lock)**:
  - Cho phép Store rút tiền doanh thu về tài khoản ngân hàng.
  - Phase 1 trừ số dư ví ngay lập tức để chống Race-condition/Double-spending.
  - Phase 2 phát lệnh PayOS Payout tự động và cơ chế Fail-Safe Auto-Refund hoàn tiền nếu cổng thanh toán lỗi.
- **Gói Thuê Nút Phần Cứng Cho Khách Hàng (BUTTON_RENTALS)**: Khách hàng thuê nút định kỳ từ Sàn, Sàn giữ tiền cọc (deposit_fee) và bảo hành thiết bị.
- **Gói Dịch Vụ Mở Gian Hàng Cho Store (STORE_SUBSCRIPTIONS)**: Cửa hàng mua gói định kỳ để mở khóa quyền đăng sản phẩm và tiếp cận khách hàng.
- **Sự kiện Real-time qua WebSocket / Socket.io**: Bắn thông báo đơn hàng tức thì vào đúng Room của Store (store_{storeId}), cách ly phòng tuyệt đối chống rò rỉ dữ liệu.
- **Bảo mật OWASP Top 10**: Chống BOLA/IDOR trên Đơn hàng, Ví tiền, Nút bấm và Rate Limit / Debounce chống kẹt nút vật lý.

### 2.2 Ngoài phạm vi (Out of scope)

- Khách hàng tự tạo đơn hàng giỏ hàng phức tạp (Hệ thống tập trung tối ưu trải nghiệm 1-Touch từ Nút bấm IoT và Quick Reorder).
- Biến thể sản phẩm / SKU đa tầng phức tạp (Tập trung danh mục tiêu dùng nhanh: Nước khoáng, Gas, Gạo, Cà phê, Giặt ủi...).
- Quản lý Nhà cung cấp và quy trình nhập kho chuyên sâu (Supplier / Purchase Order).
- Hệ thống tích điểm / Đổi quà thành viên nâng cao (Loyalty Points).

---

## 3. Các tác nhân và mô hình tài chính (Actors & Financial Flows)

### 3.1 Quản trị viên hệ thống (Admin / System Admin / Super Admin)
- Quản trị toàn bộ nền tảng, thiết bị phần cứng IoT, cấp/thu hồi `SYSTEM_STAFF` qua `platform_memberships` và cấu hình hệ thống.
- Ban hành các Gói thuê nút (RENTAL_PACKAGES) và Gói mở gian hàng (SUBSCRIPTION_PLANS).
- Tiếp nhận tiền thuê phần cứng & tiền cọc thiết bị từ Khách hàng; giữ quỹ ký quỹ hoàn cọc và phê duyệt tài chính (`approveDepositRefundTx`) khi khách trả nút hoặc tất toán bảo hành.
- Thu phí hoa hồng sàn (Take-rate 8% - 10%) trên mỗi đơn hàng hoàn tất.
- Giám sát số dư tài khoản chi PayOS Payout và phê duyệt các lệnh rút tiền của Store (`SUPER_ADMIN`).

### 3.2 Nhân viên Hệ thống (System Staff — `SYSTEM_STAFF`)
- Vận hành tập trung toàn sàn đối với **kho nút bấm IoT** (cấp phát lô thiết bị, kiểm tra, sửa, cấu hình/reset, đổi nút bảo hành 1-1, khóa nút hỏng) và **xử lý kỹ thuật phiếu bảo hành**.
- Không gắn `storeId` cố định; chịu ràng buộc tách biệt quyền lực nghiêm ngặt: **không** truy cập bán hàng/đơn hàng của Store, **không** quản lý ví/rút tiền, **không** tự phê duyệt hoàn cọc hoặc phát lệnh PayOS Payout, và **không** quản trị tài khoản/RBAC.

### 3.3 Chủ Cửa Hàng (Store Owner — `STORE_OWNER`)
- Đăng ký mở gian hàng và thanh toán Gói dịch vụ định kỳ (STORE_SUBSCRIPTIONS).
- Quản lý danh mục sản phẩm, giá bán, chương trình giảm giá và kho hàng của Store.
- Tự tiếp nhận tín hiệu đơn hàng tức thì, đóng gói, **nhận giao hàng, cập nhật trạng thái thành công/thất bại và tải ảnh bằng chứng giao hàng (POD)** cho cửa hàng mình (cùng chức năng bàn giao/tất toán ca & đơn legacy).
- Nhận doanh thu đơn hàng thực nhận (`net_amount = total_amount - commission_amount`) vào Ví Cửa Hàng (STORE_WALLETS).
- Khởi tạo lệnh rút tiền doanh thu về tài khoản ngân hàng cá nhân/doanh nghiệp qua kênh PayOS Payout.

### 3.4 Khách Hàng (Customer — `CUSTOMER`)
- Thuê thiết bị nút bấm IoT từ Sàn (đặt cọc + trả phí thuê hàng tháng).
- Ghép nối nút bấm với Cửa hàng quen thuộc gần nhà và chọn sản phẩm mặc định.
- Tự do chuyển đổi sang Cửa hàng khác (Store Re-mapping) trên ứng dụng mà không cần thay đổi phần cứng.
- Bấm nút vật lý để kích hoạt đặt hàng siêu tốc, nhận hàng tại nhà và thanh toán qua COD hoặc PayOS QR.

---

## 4. Cơ chế Doanh thu & Phí Sàn (Platform Monetization Model)

| Loại Phí | Đối Tượng Trả | Đối Tượng Nhận | Cách Tính & Thời Điểm Thu |
| :--- | :--- | :--- | :--- |
| **Phí Thuê Bao Gian Hàng (STORE_SUBSCRIPTIONS)** | Store | Admin (Sàn) | Cố định theo chu kỳ (ví dụ 199.000đ/tháng hoặc 499.000đ/quý). Trừ trực tiếp từ Ví Cửa Hàng hoặc thanh toán qua PayOS khi gia hạn. |
| **Phí Hoa Hồng Đơn Hàng (COMMISSION_AMOUNT)** | Store | Admin (Sàn) | Biến đổi theo đơn hàng (	otal_amount × commission_rate, vd 8%). Tự động khấu trừ ngay khi đơn hàng chuyển trạng thái COMPLETED. |
| **Phí Thuê Phần Cứng Nút Bấm (BUTTON_RENTALS)** | Khách hàng | Admin (Sàn) | Thu định kỳ hàng tháng (vd 30.000đ/tháng) kèm tiền cọc thiết bị (vd 200.000đ/nút). Tiền cọc được hoàn lại 100% khi trả nút nguyên vẹn. |
