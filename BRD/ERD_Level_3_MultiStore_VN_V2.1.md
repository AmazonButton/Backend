# Sơ Đồ ERD Level 3 - Thiết Kế Vật Lý Cơ Sở Dữ Liệu (Physical Database Schema)
**Hệ Thống Đặt Hàng Qua Nút Bấm IoT Đa Cửa Hàng & Sàn Thương Mại Điện Tử (Enterprise Multi-Store Marketplace V2.2)**
**Môi trường triển khai:** PostgreSQL 15+ (Supabase Production Engine) & Prisma ORM

---

## 1. Tổng Quan Kiến Trúc Vật Lý Cấp Độ 3 (Level 3 Physical Architecture)

Khác với ERD Level 1 (Khái niệm) và Level 2 (Logic), **ERD Level 3 (Vật lý)** thể hiện:
1. **Kiểu dữ liệu vật lý chính xác (Exact PostgreSQL Data Types)**: `BIGINT`, `VARCHAR(n)`, `DECIMAL(15,2)`, `TIMESTAMPTZ`, `UUID`, `BOOLEAN`, `TEXT`, `JSONB`.
2. **Khóa và Ràng buộc toàn vẹn (Keys & Integrity Constraints)**: Khóa chính `PK`, khóa ngoại `FK`, tính duy nhất `UK`, tự tăng `BIGSERIAL / IDENTITY`.
3. **Quy tắc dọn dẹp quan hệ (Referential Action)**: `ON DELETE CASCADE`, `ON DELETE SET NULL`, `ON DELETE RESTRICT`.
4. **Phân vùng 6 Nhóm Nghiệp Vụ Cốt Lõi**:
   - **Nhóm 1**: Danh tính & Bảo mật phiên (`users`, `roles`, `user_roles`, `refresh_tokens`).
   - **Nhóm 2**: Gian hàng, Nhân viên & Thành viên (`store`, `store_staff`, `store_customer`).
   - **Nhóm 3**: Hồ sơ Khách hàng & Địa chỉ giao hàng (`customer_profile`, `customer_address`).
   - **Nhóm 4**: Danh mục, Sản phẩm, Hình ảnh Cloudinary & Kho hàng (`category`, `product`, `product_image`, `product_price_history`, `product_discount`, `inventory`).
   - **Nhóm 5**: Thiết bị IoT, Thuê phần cứng & Lịch sử cấu hình (`iot_button`, `button_product`, `device_templates`, `rental_packages`, `button_rentals`, `button_config_history`).
   - **Nhóm 6**: Đơn hàng, Thanh toán, Ví điện tử & Quyết toán Sàn (`orders`, `order_items`, `order_status_history`, `payment_transaction`, `subscription_plans`, `store_subscriptions`, `store_wallets`, `wallet_transactions`, `store_withdrawals`).

---

## 2. Sơ Đồ Mermaid ERD Level 3 (Chi Tiết Toàn Bộ 28 Bảng Vật Lý)

```mermaid
erDiagram
    %% =========================================================================
    %% 1. QUAN HỆ DANH TÍNH & PHÂN QUYỀN
    %% =========================================================================
    users ||--o{ refresh_tokens : "user_id"
    users ||--o{ user_roles : "user_id"
    roles ||--o{ user_roles : "role_id"
    users ||--o| customer_profile : "user_id"
    users ||--o{ store : "owner_user_id"
    users ||--o{ store_staff : "user_id"
    users ||--o{ product_price_history : "changed_by_user_id"
    users ||--o{ order_status_history : "changed_by_user_id"
    users ||--o{ store_withdrawals : "approved_by_user_id"

    %% =========================================================================
    %% 2. QUAN HỆ GIAN HÀNG & THÀNH VIÊN
    %% =========================================================================
    store ||--o{ store_staff : "store_id"
    store ||--o{ store_customer : "store_id"
    customer_profile ||--o{ store_customer : "customer_id"
    store ||--o{ category : "store_id"
    store ||--o{ product : "store_id"
    store ||--o{ inventory : "store_id"
    store ||--o{ device_templates : "store_id"
    store ||--o{ iot_button : "store_id"
    store ||--o{ orders : "store_id"
    store ||--o| store_wallets : "store_id"
    store ||--o{ store_subscriptions : "store_id"

    %% =========================================================================
    %% 3. QUAN HỆ KHÁCH HÀNG & ĐỊA CHỈ
    %% =========================================================================
    customer_profile ||--o{ customer_address : "customer_id"
    customer_profile ||--o{ button_rentals : "customer_id"
    customer_profile ||--o{ iot_button : "customer_id"
    customer_profile ||--o{ orders : "customer_id"

    %% =========================================================================
    %% 4. QUAN HỆ SẢN PHẨM, HÌNH ẢNH & KHO
    %% =========================================================================
    category ||--o{ category : "parent_id"
    category ||--o{ product : "category_id"
    product ||--o{ product_image : "product_id"
    product ||--o{ product_price_history : "product_id"
    product ||--o{ product_discount : "product_id"
    product ||--o| inventory : "product_id"
    product ||--o{ button_product : "product_id"
    product ||--o{ order_items : "product_id"

    %% =========================================================================
    %% 5. QUAN HỆ THIẾT BỊ IOT & THUÊ NÚT
    %% =========================================================================
    rental_packages ||--o{ button_rentals : "package_id"
    button_rentals ||--o{ iot_button : "rental_id"
    customer_address ||--o{ iot_button : "address_id"
    iot_button ||--o{ button_product : "button_id"
    iot_button ||--o{ button_config_history : "button_id"
    iot_button ||--o{ orders : "button_id"

    %% =========================================================================
    %% 6. QUAN HỆ ĐƠN HÀNG, THANH TOÁN & VÍ TIỀN
    %% =========================================================================
    customer_address ||--o{ orders : "address_id"
    orders ||--o{ order_items : "order_id"
    orders ||--o{ order_status_history : "order_id"
    orders ||--o{ payment_transaction : "order_id"

    subscription_plans ||--o{ store_subscriptions : "plan_id"
    store_wallets ||--o{ wallet_transactions : "wallet_id"
    store_wallets ||--o{ store_withdrawals : "wallet_id"

    %% =========================================================================
    %% ĐỊNH NGHĨA CHI TIẾT CÁC THỰC THỂ VẬT LÝ (PHYSICAL ENTITIES)
    %% =========================================================================

    users {
        bigint user_id PK "BIGINT IDENTITY"
        uuid auth_id UK "UUID (Supabase Auth ID)"
        varchar username UK "VARCHAR(100) NOT NULL"
        varchar email UK "VARCHAR(255) NOT NULL"
        varchar password_hash "VARCHAR(255) NOT NULL"
        varchar full_name "VARCHAR(255) NOT NULL"
        varchar phone "VARCHAR(20)"
        varchar password_reset_token "VARCHAR(255) SHA-256"
        timestamptz password_reset_expires_at "TIMESTAMPTZ"
        varchar email_verification_token "VARCHAR(255) SHA-256"
        timestamptz email_verification_expires_at "TIMESTAMPTZ"
        varchar status "VARCHAR(20) DEFAULT 'ACTIVE'"
        timestamptz created_at "TIMESTAMPTZ DEFAULT now()"
        timestamptz updated_at "TIMESTAMPTZ DEFAULT now()"
    }

    refresh_tokens {
        bigint id PK "BIGSERIAL"
        bigint user_id FK "BIGINT NOT NULL (CASCADE)"
        varchar token_hash UK "VARCHAR(255) SHA-256 NOT NULL"
        timestamptz expires_at "TIMESTAMPTZ NOT NULL"
        boolean is_revoked "BOOLEAN DEFAULT FALSE NOT NULL"
        timestamptz created_at "TIMESTAMPTZ DEFAULT now() NOT NULL"
    }

    roles {
        bigint role_id PK "BIGINT IDENTITY"
        varchar role_code UK "VARCHAR(50) NOT NULL"
        varchar role_name "VARCHAR(100) NOT NULL"
        text description "TEXT"
    }

    user_roles {
        bigint user_id PK,FK "BIGINT NOT NULL (CASCADE)"
        bigint role_id PK,FK "BIGINT NOT NULL (RESTRICT)"
        timestamptz assigned_at "TIMESTAMPTZ DEFAULT now()"
    }

    store {
        bigint store_id PK "BIGINT IDENTITY"
        bigint owner_user_id FK "BIGINT NOT NULL (RESTRICT)"
        varchar name "VARCHAR(255) NOT NULL"
        varchar code UK "VARCHAR(50) NOT NULL"
        varchar email "VARCHAR(255)"
        varchar phone "VARCHAR(20)"
        text address "TEXT"
        decimal commission_rate "DECIMAL(5,2) DEFAULT 8.00"
        varchar status "VARCHAR(20) DEFAULT 'ACTIVE'"
        timestamptz created_at "TIMESTAMPTZ DEFAULT now()"
        timestamptz updated_at "TIMESTAMPTZ DEFAULT now()"
    }

    store_staff {
        bigint staff_id PK "BIGINT IDENTITY"
        bigint store_id FK "BIGINT NOT NULL (CASCADE)"
        bigint user_id FK "BIGINT NOT NULL (CASCADE)"
        bigint role_id FK "BIGINT NOT NULL (RESTRICT)"
        boolean is_active "BOOLEAN DEFAULT TRUE NOT NULL"
        timestamptz created_at "TIMESTAMPTZ DEFAULT now()"
    }

    customer_profile {
        bigint customer_id PK "BIGINT IDENTITY"
        bigint user_id FK,UK "BIGINT NOT NULL (CASCADE)"
        varchar customer_code UK "VARCHAR(50) NOT NULL"
        timestamptz date_of_birth "TIMESTAMPTZ"
        varchar gender "VARCHAR(10) CHECK (MALE,FEMALE,OTHER)"
        varchar default_payment_method "VARCHAR(20) DEFAULT 'COD'"
        timestamptz created_at "TIMESTAMPTZ DEFAULT now()"
        timestamptz updated_at "TIMESTAMPTZ DEFAULT now()"
    }

    customer_address {
        bigint address_id PK "BIGINT IDENTITY"
        bigint customer_id FK "BIGINT NOT NULL (CASCADE)"
        varchar receiver_name "VARCHAR(255) NOT NULL"
        varchar receiver_phone "VARCHAR(20) NOT NULL"
        text address_line "TEXT NOT NULL"
        varchar ward "VARCHAR(100)"
        varchar district "VARCHAR(100)"
        varchar city "VARCHAR(100) NOT NULL"
        boolean is_default "BOOLEAN DEFAULT FALSE NOT NULL"
        timestamptz created_at "TIMESTAMPTZ DEFAULT now()"
        timestamptz updated_at "TIMESTAMPTZ DEFAULT now()"
    }

    store_customer {
        bigint store_customer_id PK "BIGINT IDENTITY"
        bigint store_id FK "BIGINT NOT NULL (CASCADE)"
        bigint customer_id FK "BIGINT NOT NULL (CASCADE)"
        integer loyalty_points "INT DEFAULT 0 NOT NULL"
        timestamptz created_at "TIMESTAMPTZ DEFAULT now()"
    }

    category {
        bigint category_id PK "BIGINT IDENTITY"
        bigint store_id FK "BIGINT NOT NULL (CASCADE)"
        bigint parent_id FK "BIGINT (SET NULL)"
        varchar name "VARCHAR(255) NOT NULL"
        varchar slug "VARCHAR(255) NOT NULL"
        boolean is_active "BOOLEAN DEFAULT TRUE NOT NULL"
        timestamptz created_at "TIMESTAMPTZ DEFAULT now()"
        timestamptz updated_at "TIMESTAMPTZ DEFAULT now()"
    }

    product {
        bigint product_id PK "BIGINT IDENTITY"
        bigint store_id FK "BIGINT NOT NULL (RESTRICT)"
        bigint category_id FK "BIGINT (SET NULL)"
        varchar product_code "VARCHAR(50) NOT NULL"
        varchar product_name "VARCHAR(255) NOT NULL"
        varchar brand "VARCHAR(100)"
        text description "TEXT"
        decimal base_price "DECIMAL(15,2) NOT NULL CHECK (>=0)"
        varchar status "VARCHAR(20) DEFAULT 'ACTIVE'"
        timestamptz created_at "TIMESTAMPTZ DEFAULT now()"
        timestamptz updated_at "TIMESTAMPTZ DEFAULT now()"
    }

    product_image {
        bigint image_id PK "BIGSERIAL"
        bigint product_id FK "BIGINT NOT NULL (CASCADE)"
        text image_url "TEXT NOT NULL (Cloudinary CDN)"
        boolean is_thumbnail "BOOLEAN DEFAULT FALSE NOT NULL"
        integer display_order "INT DEFAULT 0 NOT NULL"
        timestamptz created_at "TIMESTAMPTZ DEFAULT now() NOT NULL"
        timestamptz updated_at "TIMESTAMPTZ DEFAULT now() NOT NULL"
    }

    product_price_history {
        bigint history_id PK "BIGINT IDENTITY"
        bigint product_id FK "BIGINT NOT NULL (CASCADE)"
        decimal old_price "DECIMAL(15,2) NOT NULL"
        decimal new_price "DECIMAL(15,2) NOT NULL"
        bigint changed_by_user_id FK "BIGINT (SET NULL)"
        timestamptz changed_at "TIMESTAMPTZ DEFAULT now()"
    }

    product_discount {
        bigint discount_id PK "BIGINT IDENTITY"
        bigint product_id FK "BIGINT NOT NULL (RESTRICT)"
        decimal discount_percent "DECIMAL(5,2)"
        decimal discount_amount "DECIMAL(15,2)"
        timestamptz start_at "TIMESTAMPTZ NOT NULL"
        timestamptz end_at "TIMESTAMPTZ NOT NULL"
        varchar status "VARCHAR(20) DEFAULT 'ACTIVE'"
        timestamptz created_at "TIMESTAMPTZ DEFAULT now()"
        timestamptz updated_at "TIMESTAMPTZ DEFAULT now()"
    }

    inventory {
        bigint inventory_id PK "BIGINT IDENTITY"
        bigint store_id FK "BIGINT NOT NULL (RESTRICT)"
        bigint product_id FK,UK "BIGINT NOT NULL (CASCADE)"
        integer quantity_on_hand "INT DEFAULT 0 NOT NULL CHECK (>=0)"
        integer reserved_quantity "INT DEFAULT 0 NOT NULL CHECK (>=0)"
        integer min_stock_alert "INT DEFAULT 5 NOT NULL"
        timestamptz updated_at "TIMESTAMPTZ DEFAULT now()"
    }

    device_templates {
        bigint template_id PK "BIGSERIAL"
        varchar code UK "VARCHAR(100) NOT NULL"
        varchar name "VARCHAR(255) NOT NULL"
        text description "TEXT"
        varchar category "VARCHAR(100)"
        bigint store_id FK "BIGINT (CASCADE - NULL if global)"
        varchar single_press_action "VARCHAR(50) DEFAULT 'CREATE_ORDER'"
        varchar double_press_action "VARCHAR(50) DEFAULT 'CANCEL_ORDER'"
        integer default_quantity "INT DEFAULT 1"
        integer cancel_window_seconds "INT DEFAULT 60"
        timestamptz created_at "TIMESTAMPTZ DEFAULT now() NOT NULL"
        timestamptz updated_at "TIMESTAMPTZ DEFAULT now() NOT NULL"
    }

    rental_packages {
        bigint package_id PK "BIGSERIAL"
        varchar package_code UK "VARCHAR(50) NOT NULL"
        varchar package_name "VARCHAR(150) NOT NULL"
        integer button_quantity "INT NOT NULL CHECK (>0)"
        decimal monthly_price "DECIMAL(15,2) NOT NULL"
        decimal deposit_fee "DECIMAL(15,2) NOT NULL"
        boolean is_active "BOOLEAN DEFAULT TRUE NOT NULL"
        timestamptz created_at "TIMESTAMPTZ DEFAULT now() NOT NULL"
        timestamptz updated_at "TIMESTAMPTZ DEFAULT now() NOT NULL"
    }

    button_rentals {
        bigint rental_id PK "BIGSERIAL"
        varchar rental_code UK "VARCHAR(50) NOT NULL"
        bigint customer_id FK "BIGINT NOT NULL (RESTRICT)"
        bigint package_id FK "BIGINT NOT NULL (RESTRICT)"
        integer months_rented "INT NOT NULL CHECK (>0)"
        decimal total_rent_amount "DECIMAL(15,2) NOT NULL"
        decimal deposit_amount "DECIMAL(15,2) NOT NULL"
        timestamptz start_date "TIMESTAMPTZ NOT NULL"
        timestamptz end_date "TIMESTAMPTZ NOT NULL"
        varchar status "VARCHAR(20) DEFAULT 'PENDING'"
        timestamptz created_at "TIMESTAMPTZ DEFAULT now() NOT NULL"
        timestamptz updated_at "TIMESTAMPTZ DEFAULT now() NOT NULL"
    }

    iot_button {
        bigint button_id PK "BIGINT IDENTITY"
        varchar device_id UK "VARCHAR(100) NOT NULL (MAC/Serial)"
        varchar button_code UK "VARCHAR(50) NOT NULL"
        bigint customer_id FK "BIGINT NOT NULL (RESTRICT)"
        bigint store_id FK "BIGINT NOT NULL (RESTRICT - Re-mappable)"
        bigint address_id FK "BIGINT NOT NULL (RESTRICT)"
        bigint rental_id FK "BIGINT (SET NULL)"
        varchar label_name "VARCHAR(100)"
        varchar status "VARCHAR(20) DEFAULT 'ACTIVE'"
        timestamptz last_pressed_at "TIMESTAMPTZ"
        timestamptz created_at "TIMESTAMPTZ DEFAULT now()"
        timestamptz updated_at "TIMESTAMPTZ DEFAULT now()"
    }

    button_config_history {
        bigint history_id PK "BIGSERIAL"
        bigint button_id FK "BIGINT NOT NULL (CASCADE)"
        bigint old_store_id "BIGINT"
        bigint new_store_id "BIGINT"
        varchar change_type "VARCHAR(50) NOT NULL"
        varchar changed_by "VARCHAR(50) NOT NULL"
        jsonb old_config "JSONB"
        jsonb new_config "JSONB"
        timestamptz changed_at "TIMESTAMPTZ DEFAULT now() NOT NULL"
    }

    button_product {
        bigint button_product_id PK "BIGINT IDENTITY"
        bigint button_id FK "BIGINT NOT NULL (CASCADE)"
        bigint product_id FK "BIGINT NOT NULL (CASCADE)"
        integer quantity "INT NOT NULL CHECK (>0)"
        timestamptz created_at "TIMESTAMPTZ DEFAULT now()"
    }

    orders {
        bigint order_id PK "BIGINT IDENTITY"
        varchar order_code UK "VARCHAR(50) NOT NULL"
        bigint store_id FK "BIGINT NOT NULL (RESTRICT)"
        bigint customer_id FK "BIGINT NOT NULL (RESTRICT)"
        bigint button_id FK "BIGINT (SET NULL)"
        bigint address_id FK "BIGINT NOT NULL (RESTRICT)"
        decimal subtotal_amount "DECIMAL(15,2) NOT NULL"
        decimal discount_amount "DECIMAL(15,2) DEFAULT 0.00"
        decimal shipping_fee "DECIMAL(15,2) DEFAULT 0.00"
        decimal total_amount "DECIMAL(15,2) NOT NULL"
        decimal commission_rate "DECIMAL(5,2) NOT NULL"
        decimal commission_amount "DECIMAL(15,2) NOT NULL"
        decimal net_amount "DECIMAL(15,2) NOT NULL"
        varchar status "VARCHAR(30) DEFAULT 'PENDING'"
        varchar payment_status "VARCHAR(20) DEFAULT 'PENDING'"
        varchar payment_method "VARCHAR(20) DEFAULT 'COD'"
        text cancel_reason "TEXT"
        timestamptz created_at "TIMESTAMPTZ DEFAULT now()"
        timestamptz updated_at "TIMESTAMPTZ DEFAULT now()"
    }

    order_items {
        bigint item_id PK "BIGINT IDENTITY"
        bigint order_id FK "BIGINT NOT NULL (CASCADE)"
        bigint product_id FK "BIGINT NOT NULL (RESTRICT)"
        varchar product_name_snapshot "VARCHAR(255) NOT NULL"
        decimal unit_price_snapshot "DECIMAL(15,2) NOT NULL"
        decimal discount_amount_snapshot "DECIMAL(15,2) DEFAULT 0.00"
        decimal final_unit_price "DECIMAL(15,2) NOT NULL"
        integer quantity "INT NOT NULL CHECK (>0)"
        decimal item_subtotal "DECIMAL(15,2) NOT NULL"
        timestamptz created_at "TIMESTAMPTZ DEFAULT now()"
    }

    order_status_history {
        bigint history_id PK "BIGINT IDENTITY"
        bigint order_id FK "BIGINT NOT NULL (CASCADE)"
        varchar from_status "VARCHAR(30)"
        varchar to_status "VARCHAR(30) NOT NULL"
        bigint changed_by_user_id FK "BIGINT (SET NULL)"
        text reason "TEXT"
        timestamptz changed_at "TIMESTAMPTZ DEFAULT now()"
    }

    payment_transaction {
        bigint payment_transaction_id PK "BIGINT IDENTITY"
        bigint order_id FK "BIGINT NOT NULL (CASCADE)"
        varchar provider "VARCHAR(50) DEFAULT 'PAYOS'"
        varchar transaction_code UK "VARCHAR(100) NOT NULL"
        decimal amount "DECIMAL(15,2) NOT NULL"
        varchar payment_method "VARCHAR(50) NOT NULL"
        varchar status "VARCHAR(20) DEFAULT 'PENDING'"
        timestamptz paid_at "TIMESTAMPTZ"
        timestamptz created_at "TIMESTAMPTZ DEFAULT now()"
        timestamptz updated_at "TIMESTAMPTZ DEFAULT now()"
    }

    subscription_plans {
        bigint plan_id PK "BIGSERIAL"
        varchar plan_code UK "VARCHAR(50) NOT NULL"
        varchar plan_name "VARCHAR(150) NOT NULL"
        text description "TEXT"
        decimal price "DECIMAL(15,2) NOT NULL"
        integer duration_days "INT NOT NULL"
        integer max_products "INT DEFAULT 50 NOT NULL"
        boolean is_active "BOOLEAN DEFAULT TRUE NOT NULL"
        timestamptz created_at "TIMESTAMPTZ DEFAULT now() NOT NULL"
        timestamptz updated_at "TIMESTAMPTZ DEFAULT now() NOT NULL"
    }

    store_subscriptions {
        bigint subscription_id PK "BIGSERIAL"
        bigint store_id FK "BIGINT NOT NULL (RESTRICT)"
        bigint plan_id FK "BIGINT NOT NULL (RESTRICT)"
        timestamptz start_date "TIMESTAMPTZ NOT NULL"
        timestamptz end_date "TIMESTAMPTZ NOT NULL"
        varchar status "VARCHAR(20) DEFAULT 'PENDING'"
        varchar payment_method "VARCHAR(50) DEFAULT 'WALLET'"
        timestamptz created_at "TIMESTAMPTZ DEFAULT now() NOT NULL"
        timestamptz updated_at "TIMESTAMPTZ DEFAULT now() NOT NULL"
    }

    store_wallets {
        bigint wallet_id PK "BIGSERIAL"
        bigint store_id FK,UK "BIGINT NOT NULL (RESTRICT)"
        decimal balance "DECIMAL(15,2) DEFAULT 0.00 NOT NULL CHECK (>=0)"
        decimal frozen_balance "DECIMAL(15,2) DEFAULT 0.00 NOT NULL CHECK (>=0)"
        varchar bank_code "VARCHAR(20)"
        varchar bank_name "VARCHAR(100)"
        varchar bank_account_number "VARCHAR(50)"
        varchar bank_account_holder "VARCHAR(150)"
        timestamptz created_at "TIMESTAMPTZ DEFAULT now() NOT NULL"
        timestamptz updated_at "TIMESTAMPTZ DEFAULT now() NOT NULL"
    }

    wallet_transactions {
        bigint transaction_id PK "BIGSERIAL"
        bigint wallet_id FK "BIGINT NOT NULL (RESTRICT)"
        decimal amount "DECIMAL(15,2) NOT NULL"
        varchar type "VARCHAR(50) NOT NULL"
        decimal balance_before "DECIMAL(15,2) NOT NULL"
        decimal balance_after "DECIMAL(15,2) NOT NULL"
        bigint reference_id "BIGINT"
        text description "TEXT"
        timestamptz created_at "TIMESTAMPTZ DEFAULT now() NOT NULL"
    }

    store_withdrawals {
        bigint withdrawal_id PK "BIGSERIAL"
        varchar withdrawal_code UK "VARCHAR(50) NOT NULL"
        bigint wallet_id FK "BIGINT NOT NULL (RESTRICT)"
        decimal amount "DECIMAL(15,2) NOT NULL CHECK (>0)"
        decimal fee "DECIMAL(15,2) DEFAULT 0.00 NOT NULL"
        decimal net_amount "DECIMAL(15,2) NOT NULL"
        varchar bank_code "VARCHAR(20) NOT NULL"
        varchar bank_name "VARCHAR(100) NOT NULL"
        varchar bank_account_number "VARCHAR(50) NOT NULL"
        varchar bank_account_holder "VARCHAR(150) NOT NULL"
        varchar status "VARCHAR(20) DEFAULT 'PENDING'"
        varchar provider "VARCHAR(50) DEFAULT 'PAYOS'"
        varchar provider_payout_id "VARCHAR(100)"
        varchar provider_reference_id UK "VARCHAR(100)"
        text failure_reason "TEXT"
        bigint approved_by_user_id FK "BIGINT (SET NULL)"
        timestamptz requested_at "TIMESTAMPTZ DEFAULT now() NOT NULL"
        timestamptz processed_at "TIMESTAMPTZ"
    }
```

---

## 3. Bảng Từ Điển Dữ Liệu Vật Lý Chi Tiết (Physical Data Dictionary)

| Bảng (Table) | Khóa chính (PK) | Khóa ngoại (FK) | Ràng buộc duy nhất (UK) | Hành vi xóa (ON DELETE) |
| :--- | :--- | :--- | :--- | :--- |
| `users` | `user_id` | - | `username`, `email`, `auth_id` | - |
| `refresh_tokens` | `id` | `user_id -> users` | `token_hash` | CASCADE |
| `roles` | `role_id` | - | `role_code` | - |
| `user_roles` | `(user_id, role_id)` | `user_id -> users`, `role_id -> roles` | PK Composite | CASCADE / RESTRICT |
| `store` | `store_id` | `owner_user_id -> users` | `code` | RESTRICT |
| `store_staff` | `staff_id` | `store_id -> store`, `user_id -> users`, `role_id -> roles` | - | CASCADE / RESTRICT |
| `customer_profile` | `customer_id` | `user_id -> users` | `customer_code`, `user_id` | CASCADE |
| `customer_address` | `address_id` | `customer_id -> customer_profile` | - | CASCADE |
| `store_customer` | `store_customer_id` | `store_id -> store`, `customer_id -> customer_profile` | `(store_id, customer_id)` | CASCADE |
| `category` | `category_id` | `store_id -> store`, `parent_id -> category` | - | CASCADE / SET NULL |
| `product` | `product_id` | `store_id -> store`, `category_id -> category` | `(store_id, product_code)` | RESTRICT / SET NULL |
| `product_image` | `image_id` | `product_id -> product` | - | CASCADE |
| `product_price_history` | `history_id` | `product_id -> product`, `changed_by_user_id -> users` | - | CASCADE / SET NULL |
| `product_discount` | `discount_id` | `product_id -> product` | - | RESTRICT |
| `inventory` | `inventory_id` | `store_id -> store`, `product_id -> product` | `product_id` | RESTRICT / CASCADE |
| `device_templates` | `template_id` | `store_id -> store` | `code` | CASCADE |
| `rental_packages` | `package_id` | - | `package_code` | - |
| `button_rentals` | `rental_id` | `customer_id -> customer_profile`, `package_id -> rental_packages` | `rental_code` | RESTRICT |
| `iot_button` | `button_id` | `customer_id`, `store_id`, `address_id`, `rental_id` | `device_id`, `button_code` | RESTRICT / SET NULL |
| `button_config_history` | `history_id` | `button_id -> iot_button` | - | CASCADE |
| `button_product` | `button_product_id` | `button_id -> iot_button`, `product_id -> product` | `(button_id, product_id)` | CASCADE |
| `orders` | `order_id` | `store_id`, `customer_id`, `button_id`, `address_id` | `order_code` | RESTRICT / SET NULL |
| `order_items` | `item_id` | `order_id -> orders`, `product_id -> product` | - | CASCADE / RESTRICT |
| `order_status_history` | `history_id` | `order_id -> orders`, `changed_by_user_id -> users` | - | CASCADE / SET NULL |
| `payment_transaction` | `payment_transaction_id`| `order_id -> orders` | `transaction_code` | CASCADE |
| `subscription_plans` | `plan_id` | - | `plan_code` | - |
| `store_subscriptions` | `subscription_id` | `store_id -> store`, `plan_id -> subscription_plans` | - | RESTRICT |
| `store_wallets` | `wallet_id` | `store_id -> store` | `store_id` | RESTRICT |
| `wallet_transactions` | `transaction_id` | `wallet_id -> store_wallets` | - | RESTRICT |
| `store_withdrawals` | `withdrawal_id` | `wallet_id -> store_wallets`, `approved_by_user_id -> users` | `withdrawal_code`, `provider_reference_id` | RESTRICT / SET NULL |

---

## 4. Các Index Tối Ưu Tầng Vật Lý (Physical Database Indexes)

```sql
-- 1. BẢO MẬT & PHIÊN ĐĂNG NHẬP
CREATE INDEX idx_users_email ON users(email);
CREATE UNIQUE INDEX idx_refresh_tokens_hash ON refresh_tokens(token_hash);
CREATE INDEX idx_refresh_tokens_user ON refresh_tokens(user_id);

-- 2. HÌNH ẢNH SẢN PHẨM CLOUDINARY
CREATE INDEX idx_product_image_product ON product_image(product_id);
CREATE INDEX idx_product_image_thumbnail ON product_image(is_thumbnail);

-- 3. ĐIỀU HƯỚNG NÚT BẤM IOT & GIAO DỊCH
CREATE UNIQUE INDEX idx_iot_button_device ON iot_button(device_id);
CREATE INDEX idx_iot_button_store ON iot_button(store_id);
CREATE INDEX idx_iot_button_customer ON iot_button(customer_id);

-- 4. ĐƠN HÀNG & QUYẾT TOÁN VÍ
CREATE INDEX idx_orders_store_status ON orders(store_id, status);
CREATE INDEX idx_orders_customer_created ON orders(customer_id, created_at DESC);
CREATE INDEX idx_wallet_tx_wallet ON wallet_transactions(wallet_id, created_at DESC);
CREATE UNIQUE INDEX idx_withdrawals_ref ON store_withdrawals(provider_reference_id);
CREATE UNIQUE INDEX idx_payment_tx_code ON payment_transaction(transaction_code);
```
