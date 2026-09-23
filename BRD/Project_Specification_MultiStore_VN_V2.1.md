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

### 3.3 Nhân viên cửa hàng (Store Staff)
Nhân viên làm việc theo các vai trò được phân công, ví dụ:
- Quản lý đơn hàng (`STAFF_ORDER`).
- Quản lý tồn kho (`STAFF_INVENTORY`).
- Quản lý / Hỗ trợ cài đặt Nút bấm (`STAFF_BUTTON`).

Khi nhân viên nghỉ việc, quyền đăng nhập bị vô hiệu hóa (`status = TERMINATED` hoặc `INACTIVE`) nhưng toàn bộ lịch sử thao tác trước đó vẫn được giữ nguyên để đối soát.

### 3.4 Khách hàng (Customer)
Khách hàng có tài khoản toàn cầu (`CUSTOMER`), có thể:
- Đăng ký / Đăng nhập tài khoản.
- Quản lý danh sách địa chỉ nhận hàng (tối đa 1 địa chỉ mặc định).
- Đăng ký Nút bấm IoT mới và gắn cố định với một Cửa hàng mong muốn.
- Cấu hình nhiều Sản phẩm của Cửa hàng đó lên Nút bấm kèm số lượng cố định.
- Bấm nút vật lý để tạo Đơn hàng tự động.
- Xem lịch sử đơn hàng đã đặt.

---

## 4. Mô hình Đa cửa hàng (Multi-Store Model)

Khách hàng chỉ có duy nhất một tài khoản toàn cục và có thể sở hữu nhiều Nút bấm thuộc các Cửa hàng khác nhau. Mỗi nút bấm chỉ phục vụ cho đúng một Cửa hàng.

```text
Khách hàng A
├── Nút 01 (Cố định Store A) -> Đặt hàng tại Store A
├── Nút 02 (Cố định Store A) -> Đặt hàng tại Store A
└── Nút 03 (Cố định Store B) -> Đặt hàng tại Store B
```

Thực thể `STORE_CUSTOMER` đại diện cho mối quan hệ giữa Cửa hàng và Khách hàng. Khi Khách hàng đăng ký hoặc kích hoạt một Nút bấm cho một Cửa hàng, Khách hàng sẽ tự động được liên kết với Cửa hàng đó với `status = ACTIVE`.

---

## 5. Quy tắc nghiệp vụ Cửa hàng & Danh mục (Store & Category Rules)

- **BR-STORE-01**: Hệ thống hỗ trợ đồng thời nhiều Cửa hàng độc lập.
- **BR-STORE-02**: Mỗi Cửa hàng tự quản lý danh mục Sản phẩm, Tồn kho, Khách hàng liên kết, Nút bấm và Đơn hàng của riêng mình.
- **BR-STORE-03**: Cửa hàng có thể xem danh sách tất cả Khách hàng đang sở hữu Nút bấm trỏ tới mình.
- **BR-STORE-04**: Một Khách hàng có thể liên kết đồng thời với nhiều Cửa hàng khác nhau (thông qua việc sở hữu các nút ở các cửa hàng khác nhau).
- **BR-STORE-05**: Khi đăng ký Nút bấm mới, Cửa hàng được chọn bắt buộc phải đang ở trạng thái hoạt động (`status = ACTIVE`).
- **BRD-CAT-02 (Cách ly Danh mục theo Store)**: Cây danh mục cha - con bắt buộc phải có cùng `store_id`. Danh mục của Store A tuyệt đối không thể làm cha của danh mục Store B thông qua khóa ngoại phức hợp `(store_id, parent_category_id) REFERENCES category(store_id, category_id)`.

---

## 6. Quy tắc nghiệp vụ Khách hàng & Sổ địa chỉ (Customer Rules)

- **BR-CUSTOMER-01**: Mỗi Khách hàng sở hữu một tài khoản toàn cục duy nhất trong hệ thống (`CUSTOMER_PROFILE.user_id UK`).
- **BR-CUSTOMER-02**: Một Khách hàng có thể lưu nhiều địa chỉ giao hàng khác nhau.
- **BR-CUSTOMER-03**: Địa chỉ giao hàng thuộc quyền sở hữu của Khách hàng, không thuộc về bất kỳ Cửa hàng nào.
- **BR-CUSTOMER-04**: Cùng một địa chỉ giao hàng có thể được gán cho các Nút bấm thuộc các Cửa hàng khác nhau.
- **BR-CUSTOMER-05**: Thao tác đăng ký Nút bấm cho một Cửa hàng sẽ tự động tạo liên kết `ACTIVE` giữa Khách hàng và Cửa hàng đó.
- **BR-CUSTOMER-06**: Mỗi khách hàng chỉ có tối đa một địa chỉ giao hàng mặc định (`is_default = true`), được bảo đảm tuyệt đối ở tầng cơ sở dữ liệu bằng Partial Unique Index.

---

## 7. Quy tắc nghiệp vụ Nút bấm IoT (Button Rules)

- **BR-BUTTON-01**: Một Nút bấm thuộc về duy nhất một Khách hàng.
- **BR-BUTTON-02**: Một Khách hàng có thể sở hữu nhiều Nút bấm khác nhau.
- **BR-BUTTON-03 (Cố định Store)**: Một Nút bấm gắn liền cố định với DUY NHẤT một Cửa hàng từ lúc tạo (`store_id` là bất biến, không được phép chuyển đổi sang Store khác).
- **BR-BUTTON-04**: Khách hàng có thể sở hữu các Nút bấm thuộc các Cửa hàng khác nhau.
- **BR-BUTTON-05**: Mã định danh thiết bị (`device_id`) là duy nhất trên toàn hệ thống.
- **BR-BUTTON-06**: Mã hiển thị của nút (`button_code`) là duy nhất trên toàn hệ thống.
- **BR-BUTTON-07**: Một Nút bấm có thể được cấu hình để mua nhiều Sản phẩm cùng lúc.
- **BR-BUTTON-08**: Tất cả các Sản phẩm được cấu hình trên một Nút bấm bắt buộc phải thuộc về Cửa hàng của Nút đó (kiểm tra tự động bằng Trigger `trg_validate_button_product_store`).
- **BR-BUTTON-09**: Số lượng từng Sản phẩm trên Nút bấm là cố định cho đến khi Khách hàng chủ động thay đổi cấu hình.
- **BR-BUTTON-10**: Số lượng cấu hình của mỗi Sản phẩm phải lớn hơn 0.
- **BR-BUTTON-11**: Mỗi Nút bấm sử dụng một địa chỉ giao hàng thuộc sở hữu của chính Khách hàng đó (`FOREIGN KEY (customer_id, address_id)`).
- **BR-BUTTON-12**: Thao tác bấm nút vật lý là nguồn duy nhất để tạo Đơn hàng trong phạm vi dự án này.

---

## 8. Luồng Đăng ký & Cấu hình Nút bấm Cố định (Button Registration & Setup)

```text
Khách hàng
   │
Chọn / Đăng ký Nút bấm mới (Nhập Device ID / Button Code)
   │
Khách hàng chọn Cửa hàng phục vụ (Chỉ chọn 1 lần duy nhất)
   │
Hệ thống kiểm tra: Cửa hàng phải đang ACTIVE
   │
Tự động tạo liên kết Khách hàng - Cửa hàng (STORE_CUSTOMER)
   │
Khách hàng cấu hình Nút bấm:
   ├── Tên gợi nhớ của nút (Ví dụ: "Nút mua Sữa tươi hàng tuần")
   ├── Chọn địa chỉ nhận hàng (từ danh bạ cá nhân)
   ├── Chọn Sản phẩm 1 (thuộc Cửa hàng đã chọn) + Số lượng
   ├── Chọn Sản phẩm 2 (thuộc Cửa hàng đã chọn) + Số lượng
   └── ...
   │
Hệ thống kiểm tra tính hợp lệ và lưu cấu hình IOT_BUTTON & BUTTON_PRODUCT
   │
Nút bấm sẵn sàng hoạt động (Khách hàng nhấn nút để đặt hàng)
```

---

## 9. Quy tắc Sản phẩm, Tồn kho & Giảm giá (Product, Inventory & Discount)

- **BR-PRODUCT-01**: Mỗi Sản phẩm thuộc về duy nhất một Cửa hàng.
- **BR-PRODUCT-04**: Các Sản phẩm đã từng phát sinh đơn hàng lịch sử không được phép xóa cứng khỏi cơ sở dữ liệu; chỉ được chuyển sang trạng thái ngưng hoạt động (`INACTIVE` hoặc `ARCHIVED`).
- **BRD-PROD-06 (Bảo vệ tính toàn vẹn Sản phẩm - Kho - Danh mục)**:
  - Sản phẩm chỉ được gắn vào Danh mục thuộc cùng Store của sản phẩm đó (`FOREIGN KEY (store_id, category_id)`).
  - Bản ghi `INVENTORY` phải gắn đúng `store_id` của sản phẩm thông qua khóa ngoại phức hợp `(store_id, product_id)`.
  - Mọi biến động giá bán `base_price` đều được ghi vết tự động vào `PRODUCT_PRICE_HISTORY` kèm thời gian và người thay đổi.
- **BRD-DISC-05 (Hình thức giảm giá loại trừ lẫn nhau)**:
  - Một chương trình giảm giá chỉ được chọn duy nhất: hoặc theo `%` (`discount_percent`), hoặc theo số tiền cố định (`discount_amount`).
  - Các khoảng thời gian áp dụng (`start_at` đến `end_at`) của cùng một sản phẩm ở trạng thái `ACTIVE` tuyệt đối không được chồng lấn nhau (kiểm tra bằng toán tử `OVERLAPS`).

---

## 10. Quản lý Tồn kho 2 Bước & Tạo Đơn Chống Race-Condition (ACID Inventory)

### BRD-INV-06 (Thực thi giao dịch cấp Database - Pessimistic Locking)
- Toàn bộ tiến trình tạo đơn hàng được thực hiện độc quyền qua **Stored Procedure `sp_create_order_from_button`**.
- Sử dụng lệnh khóa bi quan `SELECT ... FOR UPDATE` trên dòng thông tin Nút và các dòng `INVENTORY` của các sản phẩm liên quan.
- **Cơ chế All-or-Nothing**: Kiểm tra nếu bất kỳ sản phẩm nào có:
  $$\text{quantity\_on\_hand} - \text{reserved\_quantity} < \text{order\_quantity}$$
  thì hủy bỏ toàn bộ giao dịch, không tạo đơn hàng dở dang.
- Chụp bản sao (Snapshot) giá gốc, phần trăm giảm, số tiền giảm, giá bán cuối cùng vào `ORDER_ITEM`.
- Giữ chỗ tồn kho: `reserved_quantity = reserved_quantity + quantity`.

### BRD-INV-07 (Tự động hóa hoàn trả & khấu trừ tồn kho theo Trigger)
- **Khi đơn chuyển sang `CANCELLED` hoặc `REJECTED`**: Trigger `trg_sync_inventory_on_order_status_change` tự động giải phóng tồn giữ chỗ:
  $$\text{reserved\_quantity} = \max(0, \text{reserved\_quantity} - \text{quantity})$$
- **Khi đơn chuyển sang `COMPLETED`**: Trigger tự động trừ tồn thực tế và giảm giữ chỗ:
  $$\text{quantity\_on\_hand} = \max(0, \text{quantity\_on\_hand} - \text{quantity})$$
  $$\text{reserved\_quantity} = \max(0, \text{reserved\_quantity} - \text{quantity})$$
- Tự động ghi nhật ký chuyển trạng thái vào `ORDER_STATUS_HISTORY`.

---

## 11. Tính Toàn Vẹn Đơn Hàng & Thanh Toán (Order Integrity & Payment)

### BRD-ORD-05 (Toàn vẹn quan hệ Đơn hàng - Nút - Khách - Store)
- Đơn hàng tạo ra luôn có `ORDERS.store_id = IOT_BUTTON.store_id`.
- Bộ ba `(button_id, customer_id, store_id)` khớp tuyệt đối với thông tin nút bấm tại thời điểm đặt thông qua khóa ngoại phức hợp `fk_orders_button_context`.
- **Ràng buộc toàn vẹn toán học**:
  $$\text{total\_amount} = \text{subtotal\_amount} - \text{discount\_amount} + \text{shipping\_fee}$$
  $$\text{discount\_amount} \le \text{subtotal\_amount}$$

---

## 12. Vòng Đời Đơn Hàng (Order Status Lifecycle)

```text
PENDING (Chờ tiếp nhận - Đã giữ kho)
   ├── CANCELLED (Khách / Cửa hàng hủy -> Hoàn trả tồn giữ chỗ)
   ├── REJECTED (Cửa hàng từ chối -> Hoàn trả tồn giữ chỗ)
   └── CONFIRMED (Cửa hàng xác nhận đơn)
          │
      PREPARING (Đang chuẩn bị hàng)
          │
   READY_FOR_DELIVERY (Sẵn sàng bàn giao cho shipper)
          │
       SHIPPING (Đang giao hàng)
       ├── DELIVERED (Đã giao hàng vật lý tới tay khách)
       │      │
       │   COMPLETED (Hoàn tất đơn & Đã thu tiền -> Khấu trừ tồn thực tế)
       │
       └── DELIVERY_FAILED (Giao hàng thất bại)
              │
          CANCELLED (Hủy đơn & Hoàn hàng về kho -> Hoàn trả tồn giữ chỗ)
```
