-- =====================================================================
-- SUPABASE POSTGRESQL PRODUCTION SCHEMA SCRIPT
-- Project: Multi-Store IoT Button Ordering Platform
-- Version: 2.1 (Fixed Store per Button - Ready for Supabase SQL Editor)
-- Compatibility: Supabase / PostgreSQL 15+
-- =====================================================================

-- 0. TIỆN ÍCH MỞ RỘNG & CẤU HÌNH MÚI GIỜ (EXTENSIONS & CONFIG)
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Thiết lập múi giờ mặc định toàn Database sang Việt Nam (UTC+7)
ALTER DATABASE postgres SET timezone TO 'Asia/Ho_Chi_Minh';
SET timezone TO 'Asia/Ho_Chi_Minh';

-- =====================================================================
-- 1. IDENTITY & ACCESS MANAGEMENT (IAM)
-- =====================================================================

CREATE TABLE IF NOT EXISTS roles (
    role_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    role_code VARCHAR(50) UNIQUE NOT NULL,
    role_name VARCHAR(100) NOT NULL,
    description TEXT
);

CREATE TABLE IF NOT EXISTS users (
    user_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    auth_id UUID UNIQUE,  -- Ánh xạ tới auth.users.id của Supabase (NULL nếu tạo bởi admin/seed)
    username VARCHAR(100) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL 
        CONSTRAINT chk_user_email CHECK (email ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'),
    password_hash VARCHAR(255) NOT NULL 
        CONSTRAINT chk_user_password_hash CHECK (length(password_hash) >= 60),
    full_name VARCHAR(255) NOT NULL,
    phone VARCHAR(20) 
        CONSTRAINT chk_user_phone CHECK (phone IS NULL OR phone ~ '^[0-9+]{9,15}$'),
    status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE', 'BLOCKED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Khởi tạo các vai trò chuẩn của hệ thống
INSERT INTO roles (role_code, role_name, description)
VALUES 
    ('SYSTEM_ADMIN', 'System Administrator', 'Quản trị viên toàn hệ thống'),
    ('STORE_OWNER', 'Store Owner', 'Chủ cửa hàng, toàn quyền trên Store'),
    ('STAFF_ORDER', 'Order Management Staff', 'Nhân viên xử lý và giao đơn hàng'),
    ('STAFF_INVENTORY', 'Inventory Staff', 'Nhân viên quản lý kho và kiểm kê'),
    ('STAFF_BUTTON', 'Button Tech Staff', 'Nhân viên kỹ thuật phần cứng nút bấm'),
    ('CUSTOMER', 'Customer', 'Khách hàng toàn cầu')
ON CONFLICT (role_code) DO NOTHING;

-- =====================================================================
-- 2. CỬA HÀNG & PHÂN QUYỀN NHÂN VIÊN (STORE & STAFF)
-- =====================================================================

CREATE TABLE IF NOT EXISTS store (
    store_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    owner_user_id BIGINT NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
    name VARCHAR(255) NOT NULL,
    code VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(255) CONSTRAINT chk_store_email CHECK (email IS NULL OR email ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'),
    phone VARCHAR(20) NOT NULL CONSTRAINT chk_store_phone CHECK (phone ~ '^[0-9+]{9,15}$'),
    address TEXT NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE', 'SUSPENDED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS store_staff (
    store_staff_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    store_id BIGINT NOT NULL REFERENCES store(store_id) ON DELETE RESTRICT,
    user_id BIGINT NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
    role_id BIGINT NOT NULL REFERENCES roles(role_id) ON DELETE RESTRICT,
    status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ON_LEAVE', 'TERMINATED')),
    joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    left_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Ràng buộc: 1 user chỉ giữ 1 vai trò duy nhất trong 1 store
    -- (Lưu ý: ERD Mermaid không thể hiện composite unique trực quan do giới hạn cú pháp)
    CONSTRAINT uq_store_staff_store_user UNIQUE (store_id, user_id)
);

-- =====================================================================
-- 3. KHÁCH HÀNG TOÀN CẦU & SỔ ĐỊA CHỈ (CUSTOMER)
-- =====================================================================

CREATE TABLE IF NOT EXISTS customer_profile (
    customer_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id BIGINT UNIQUE NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
    phone VARCHAR(20) CONSTRAINT chk_customer_phone CHECK (phone IS NULL OR phone ~ '^[0-9+]{9,15}$'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS customer_address (
    address_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    customer_id BIGINT NOT NULL REFERENCES customer_profile(customer_id) ON DELETE CASCADE,
    recipient_name VARCHAR(255) NOT NULL,
    phone VARCHAR(20) NOT NULL CONSTRAINT chk_addr_phone CHECK (phone ~ '^[0-9+]{9,15}$'),
    address_detail VARCHAR(500) NOT NULL,
    ward VARCHAR(100),
    district VARCHAR(100),
    province VARCHAR(100),
    is_default BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Đảm bảo cặp (customer_id, address_id) là duy nhất để bảo vệ Khóa ngoại cho Nút bấm
    CONSTRAINT uq_customer_address_pair UNIQUE (customer_id, address_id)
);

-- Partial Unique Index: Mỗi khách hàng chỉ có duy nhất 1 địa chỉ mặc định
CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_default_address 
ON customer_address(customer_id) 
WHERE is_default = true;

-- [FIX LỖ HỔNG 6] Tự động hạ cờ địa chỉ mặc định cũ trước khi set mặc định mới
CREATE OR REPLACE FUNCTION fn_handle_customer_default_address()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.is_default = true THEN
        UPDATE customer_address 
        SET is_default = false 
        WHERE customer_id = NEW.customer_id 
          AND address_id <> COALESCE(NEW.address_id, -1)
          AND is_default = true;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_handle_customer_default_address ON customer_address;
CREATE TRIGGER trg_handle_customer_default_address
BEFORE INSERT OR UPDATE OF is_default ON customer_address
FOR EACH ROW EXECUTE FUNCTION fn_handle_customer_default_address();

CREATE TABLE IF NOT EXISTS store_customer (
    store_customer_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    store_id BIGINT NOT NULL REFERENCES store(store_id) ON DELETE RESTRICT,
    customer_id BIGINT NOT NULL REFERENCES customer_profile(customer_id) ON DELETE RESTRICT,
    status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE', 'BLOCKED')),
    joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_store_customer UNIQUE (store_id, customer_id)
);

-- =====================================================================
-- 4. DANH MỤC, SẢN PHẨM, GIẢM GIÁ & TỒN KHO
-- =====================================================================

CREATE TABLE IF NOT EXISTS category (
    category_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    store_id BIGINT NOT NULL REFERENCES store(store_id) ON DELETE RESTRICT,
    parent_category_id BIGINT,
    category_name VARCHAR(255) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Ràng buộc tự tham chiếu: Đảm bảo danh mục cha và con cùng thuộc 1 Store
    CONSTRAINT uq_category_store_pair UNIQUE (store_id, category_id),
    CONSTRAINT fk_category_parent_same_store FOREIGN KEY (store_id, parent_category_id) 
        REFERENCES category(store_id, category_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS product (
    product_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    store_id BIGINT NOT NULL REFERENCES store(store_id) ON DELETE RESTRICT,
    category_id BIGINT,
    product_code VARCHAR(50) NOT NULL,
    product_name VARCHAR(255) NOT NULL,
    brand VARCHAR(100),
    description TEXT,
    base_price DECIMAL(15,2) NOT NULL CHECK (base_price >= 0),
    status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('DRAFT', 'ACTIVE', 'INACTIVE', 'ARCHIVED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_product_store_code UNIQUE (store_id, product_code),
    CONSTRAINT uq_product_store_pair UNIQUE (store_id, product_id),
    -- Đảm bảo Category được gán bắt buộc phải thuộc cùng Store với Product
    CONSTRAINT fk_product_category_same_store FOREIGN KEY (store_id, category_id) 
        REFERENCES category(store_id, category_id) ON DELETE SET NULL
);

-- Bảng lưu vết lịch sử thay đổi giá bán sản phẩm
CREATE TABLE IF NOT EXISTS product_price_history (
    history_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    product_id BIGINT NOT NULL REFERENCES product(product_id) ON DELETE CASCADE,
    old_price DECIMAL(15,2) NOT NULL,
    new_price DECIMAL(15,2) NOT NULL,
    changed_by_user_id BIGINT REFERENCES users(user_id) ON DELETE SET NULL,
    changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS product_discount (
    discount_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    product_id BIGINT NOT NULL REFERENCES product(product_id) ON DELETE RESTRICT,
    discount_percent DECIMAL(5,2) CHECK (discount_percent > 0 AND discount_percent <= 100),
    discount_amount DECIMAL(15,2) CHECK (discount_amount > 0),
    start_at TIMESTAMPTZ NOT NULL,
    end_at TIMESTAMPTZ NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'EXPIRED', 'DISABLED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_discount_time CHECK (end_at > start_at),
    -- Ràng buộc loại trừ: Chỉ được chọn 1 trong 2 hình thức giảm giá (% hoặc số tiền)
    CONSTRAINT chk_discount_type_exclusive CHECK (
        (discount_percent IS NOT NULL AND discount_amount IS NULL) OR 
        (discount_percent IS NULL AND discount_amount IS NOT NULL)
    )
);

CREATE TABLE IF NOT EXISTS inventory (
    inventory_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    store_id BIGINT NOT NULL,
    product_id BIGINT UNIQUE NOT NULL,
    quantity_on_hand INT NOT NULL DEFAULT 0 CHECK (quantity_on_hand >= 0),
    reserved_quantity INT NOT NULL DEFAULT 0 CHECK (reserved_quantity >= 0),
    min_stock_alert INT NOT NULL DEFAULT 5 CHECK (min_stock_alert >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Đảm bảo store_id của Inventory khớp tuyệt đối với product.store_id
    CONSTRAINT fk_inventory_product_store FOREIGN KEY (store_id, product_id) 
        REFERENCES product(store_id, product_id) ON DELETE RESTRICT,
    CONSTRAINT chk_inventory_reserved_le_onhand CHECK (reserved_quantity <= quantity_on_hand)
);

-- =====================================================================
-- 5. NÚT BẤM IOT (GẮN CỐ ĐỊNH VỚI STORE)
-- =====================================================================

CREATE TABLE IF NOT EXISTS iot_button (
    button_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    store_id BIGINT NOT NULL REFERENCES store(store_id) ON DELETE RESTRICT,
    customer_id BIGINT NOT NULL REFERENCES customer_profile(customer_id) ON DELETE RESTRICT,
    address_id BIGINT NOT NULL,
    device_id VARCHAR(100) UNIQUE NOT NULL,
    button_code VARCHAR(50) UNIQUE NOT NULL,
    button_name VARCHAR(255) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE', 'LOCKED')),
    installed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Ràng buộc địa chỉ nhận hàng bắt buộc phải thuộc sở hữu của chính khách hàng sở hữu nút
    CONSTRAINT fk_button_customer_address FOREIGN KEY (customer_id, address_id) 
        REFERENCES customer_address(customer_id, address_id) ON DELETE RESTRICT,
    CONSTRAINT uq_button_cust_store_triplet UNIQUE (button_id, customer_id, store_id)
);

CREATE TABLE IF NOT EXISTS button_product (
    button_product_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    button_id BIGINT NOT NULL REFERENCES iot_button(button_id) ON DELETE CASCADE,
    product_id BIGINT NOT NULL REFERENCES product(product_id) ON DELETE RESTRICT,
    quantity INT NOT NULL DEFAULT 1 CHECK (quantity > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_button_product UNIQUE (button_id, product_id)
);

-- =====================================================================
-- 6. ĐƠN HÀNG, CHI TIẾT SNAPSHOT & THANH TOÁN
-- =====================================================================

CREATE TABLE IF NOT EXISTS orders (
    order_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_code VARCHAR(50) UNIQUE NOT NULL,
    store_id BIGINT NOT NULL REFERENCES store(store_id) ON DELETE RESTRICT,
    customer_id BIGINT NOT NULL REFERENCES customer_profile(customer_id) ON DELETE RESTRICT,
    button_id BIGINT NOT NULL REFERENCES iot_button(button_id) ON DELETE RESTRICT,
    order_status VARCHAR(30) NOT NULL DEFAULT 'PENDING' 
        CHECK (order_status IN ('PENDING', 'CONFIRMED', 'PREPARING', 'READY_FOR_DELIVERY', 'SHIPPING', 'DELIVERED', 'COMPLETED', 'CANCELLED', 'REJECTED', 'DELIVERY_FAILED')),
    payment_status VARCHAR(30) NOT NULL DEFAULT 'UNPAID' 
        CHECK (payment_status IN ('UNPAID', 'PAID', 'REFUNDED')),
    payment_method VARCHAR(30) NOT NULL 
        CHECK (payment_method IN ('COD', 'PAYOS')),
    subtotal_amount DECIMAL(15,2) NOT NULL DEFAULT 0 CHECK (subtotal_amount >= 0),
    discount_amount DECIMAL(15,2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
    shipping_fee DECIMAL(15,2) NOT NULL DEFAULT 0 CHECK (shipping_fee >= 0),
    total_amount DECIMAL(15,2) NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
    shipping_recipient_name VARCHAR(255) NOT NULL,
    shipping_phone VARCHAR(20) NOT NULL,
    shipping_address VARCHAR(500) NOT NULL,
    order_note TEXT,
    order_date TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Khóa ngoại đảm bảo Button, Customer, Store khớp nhau tại thời điểm tạo đơn
    CONSTRAINT fk_orders_button_context FOREIGN KEY (button_id, customer_id, store_id)
        REFERENCES iot_button(button_id, customer_id, store_id) ON DELETE RESTRICT,
    -- Ràng buộc toàn vẹn toán học của đơn hàng
    CONSTRAINT chk_orders_total_math CHECK (total_amount = (subtotal_amount - discount_amount + shipping_fee)),
    CONSTRAINT chk_orders_discount_limit CHECK (discount_amount <= subtotal_amount)
);

CREATE TABLE IF NOT EXISTS order_item (
    order_item_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_id BIGINT NOT NULL REFERENCES orders(order_id) ON DELETE CASCADE,
    product_id BIGINT NOT NULL REFERENCES product(product_id) ON DELETE RESTRICT,
    product_name_snapshot VARCHAR(255) NOT NULL,
    unit_price_snapshot DECIMAL(15,2) NOT NULL CHECK (unit_price_snapshot >= 0),
    discount_percent_snapshot DECIMAL(5,2) DEFAULT 0 CHECK (discount_percent_snapshot >= 0 AND discount_percent_snapshot <= 100),
    discount_amount_snapshot DECIMAL(15,2) DEFAULT 0 CHECK (discount_amount_snapshot >= 0),
    final_unit_price DECIMAL(15,2) NOT NULL CHECK (final_unit_price >= 0),
    quantity INT NOT NULL CHECK (quantity > 0),
    item_subtotal DECIMAL(15,2) NOT NULL CHECK (item_subtotal >= 0)
);

CREATE TABLE IF NOT EXISTS order_status_history (
    history_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_id BIGINT NOT NULL REFERENCES orders(order_id) ON DELETE CASCADE,
    changed_by_user_id BIGINT REFERENCES users(user_id) ON DELETE SET NULL,
    old_status VARCHAR(30),
    new_status VARCHAR(30) NOT NULL,
    reason TEXT,
    changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payment_transaction (
    payment_transaction_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_id BIGINT NOT NULL REFERENCES orders(order_id) ON DELETE RESTRICT,
    provider VARCHAR(50) NOT NULL CHECK (provider IN ('COD', 'PAYOS')),
    transaction_code VARCHAR(100),
    amount DECIMAL(15,2) NOT NULL CHECK (amount >= 0),
    payment_method VARCHAR(30) NOT NULL CHECK (payment_method IN ('COD', 'PAYOS')),
    status VARCHAR(30) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SUCCESS', 'FAILED')),
    paid_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =====================================================================
-- 7. TỐI ƯU HÓA TRUY VẤN (INDEXES)
-- =====================================================================

CREATE INDEX IF NOT EXISTS idx_store_staff_lookup ON store_staff(store_id, user_id, status);
CREATE INDEX IF NOT EXISTS idx_store_customer_lookup ON store_customer(store_id, customer_id);
CREATE INDEX IF NOT EXISTS idx_product_store ON product(store_id, status);
CREATE INDEX IF NOT EXISTS idx_product_code_global ON product(product_code);
CREATE INDEX IF NOT EXISTS idx_product_discount_active_period ON product_discount(product_id, status, start_at, end_at);
CREATE INDEX IF NOT EXISTS idx_inventory_lookup ON inventory(store_id, product_id);
CREATE INDEX IF NOT EXISTS idx_iot_button_device ON iot_button(device_id);
CREATE INDEX IF NOT EXISTS idx_iot_button_customer ON iot_button(customer_id);
CREATE INDEX IF NOT EXISTS idx_iot_button_store ON iot_button(store_id);
CREATE INDEX IF NOT EXISTS idx_orders_customer_date ON orders(customer_id, order_date DESC);
CREATE INDEX IF NOT EXISTS idx_orders_store_status ON orders(store_id, order_status, order_date DESC);
CREATE INDEX IF NOT EXISTS idx_orders_button_id ON orders(button_id, order_date DESC);
CREATE INDEX IF NOT EXISTS idx_order_item_order ON order_item(order_id);

-- =====================================================================
-- 8. TRIGGERS & PROCEDURES (THỰC THI TOÀN VẸN NGHIỆP VỤ)
-- =====================================================================

-- 8.1 Đồng nhất Store giữa Nút và Sản phẩm
CREATE OR REPLACE FUNCTION fn_validate_button_product_store()
RETURNS TRIGGER AS $$
DECLARE
    v_button_store_id BIGINT;
    v_product_store_id BIGINT;
BEGIN
    SELECT store_id INTO v_button_store_id FROM iot_button WHERE button_id = NEW.button_id;
    SELECT store_id INTO v_product_store_id FROM product WHERE product_id = NEW.product_id;

    IF v_button_store_id IS NULL THEN
        RAISE EXCEPTION 'IoT Button ID % không tồn tại.', NEW.button_id;
    END IF;

    IF v_product_store_id IS NULL THEN
        RAISE EXCEPTION 'Sản phẩm ID % không tồn tại.', NEW.product_id;
    END IF;

    IF v_button_store_id <> v_product_store_id THEN
        RAISE EXCEPTION 'Vi phạm Store: Sản phẩm (Store %) không thuộc Store của Nút bấm (Store %).', 
            v_product_store_id, v_button_store_id;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_validate_button_product_store ON button_product;
CREATE TRIGGER trg_validate_button_product_store
BEFORE INSERT OR UPDATE ON button_product
FOR EACH ROW EXECUTE FUNCTION fn_validate_button_product_store();


-- 8.2 Chống đổi Cửa hàng của Nút bấm (store_id là bất biến)
CREATE OR REPLACE FUNCTION fn_prevent_button_store_update()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.store_id <> NEW.store_id THEN
        RAISE EXCEPTION 'Nút bấm gắn liền cố định với Cửa hàng, không được phép chuyển đổi Cửa hàng (store_id bất biến).';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prevent_button_store_update ON iot_button;
CREATE TRIGGER trg_prevent_button_store_update
BEFORE UPDATE OF store_id ON iot_button
FOR EACH ROW EXECUTE FUNCTION fn_prevent_button_store_update();


-- 8.3 Tự động liên kết STORE_CUSTOMER khi kích hoạt Nút bấm mới
CREATE OR REPLACE FUNCTION fn_auto_link_store_customer_on_button_insert()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO store_customer (store_id, customer_id, status, joined_at)
    VALUES (NEW.store_id, NEW.customer_id, 'ACTIVE', now())
    ON CONFLICT (store_id, customer_id) 
    DO UPDATE SET status = 'ACTIVE', updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_auto_link_store_customer_on_button_insert ON iot_button;
CREATE TRIGGER trg_auto_link_store_customer_on_button_insert
AFTER INSERT ON iot_button
FOR EACH ROW EXECUTE FUNCTION fn_auto_link_store_customer_on_button_insert();


-- 8.4 Chống chồng lấn Giảm giá (Chỉ check khi NEW.status = ACTIVE)
CREATE OR REPLACE FUNCTION fn_validate_product_discount_no_overlap()
RETURNS TRIGGER AS $$
DECLARE
    v_overlap_count INT;
BEGIN
    IF NEW.status = 'ACTIVE' THEN
        SELECT COUNT(*) INTO v_overlap_count
        FROM product_discount
        WHERE product_id = NEW.product_id
          AND discount_id <> COALESCE(NEW.discount_id, -1)
          AND status = 'ACTIVE'
          AND (NEW.start_at, NEW.end_at) OVERLAPS (start_at, end_at);

        IF v_overlap_count > 0 THEN
            RAISE EXCEPTION 'Xung đột giảm giá: Sản phẩm ID % đã có giảm giá ACTIVE khác trong khoảng (% - %).', 
                NEW.product_id, NEW.start_at, NEW.end_at;
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_validate_product_discount_no_overlap ON product_discount;
CREATE TRIGGER trg_validate_product_discount_no_overlap
BEFORE INSERT OR UPDATE ON product_discount
FOR EACH ROW EXECUTE FUNCTION fn_validate_product_discount_no_overlap();


-- 8.5 Validate chuyển trạng thái đơn hàng (State Machine) + Auto-set completed_at
-- BEFORE UPDATE: Chạy trước trigger inventory để đảm bảo transition hợp lệ
CREATE OR REPLACE FUNCTION fn_validate_order_status_transition()
RETURNS TRIGGER AS $$
DECLARE
    v_valid_transitions JSONB := '{
        "PENDING": ["CANCELLED", "REJECTED", "CONFIRMED"],
        "CONFIRMED": ["CANCELLED", "PREPARING"],
        "PREPARING": ["CANCELLED", "READY_FOR_DELIVERY"],
        "READY_FOR_DELIVERY": ["CANCELLED", "SHIPPING"],
        "SHIPPING": ["DELIVERED", "DELIVERY_FAILED"],
        "DELIVERED": ["COMPLETED"],
        "DELIVERY_FAILED": ["CANCELLED"],
        "COMPLETED": [],
        "CANCELLED": [],
        "REJECTED": []
    }'::JSONB;
    v_allowed JSONB;
BEGIN
    -- Bỏ qua nếu trạng thái không thay đổi
    IF OLD.order_status = NEW.order_status THEN
        RETURN NEW;
    END IF;

    v_allowed := v_valid_transitions -> OLD.order_status;

    IF v_allowed IS NULL OR NOT v_allowed ? NEW.order_status THEN
        RAISE EXCEPTION 'Chuyển trạng thái không hợp lệ: % → %. Các trạng thái hợp lệ từ %: %',
            OLD.order_status, NEW.order_status, OLD.order_status, v_allowed;
    END IF;

    -- Auto-set completed_at khi đơn hàng hoàn tất
    IF NEW.order_status = 'COMPLETED' THEN
        NEW.completed_at := now();
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_validate_order_status_transition ON orders;
CREATE TRIGGER trg_validate_order_status_transition
BEFORE UPDATE OF order_status ON orders
FOR EACH ROW EXECUTE FUNCTION fn_validate_order_status_transition();


-- Helper function CỐT LÕI: Ánh xạ Supabase Auth UUID → user_id BIGINT
-- Dùng cho cả Triggers (audit/history) lẫn Row Level Security (RLS)
CREATE OR REPLACE FUNCTION fn_current_user_id()
RETURNS BIGINT AS $$
    SELECT user_id FROM users WHERE auth_id = auth.uid() LIMIT 1;
$$ LANGUAGE sql SECURITY DEFINER STABLE;


-- 8.5 Đồng bộ Tồn kho tự động theo Vòng đời Đơn hàng (Two-Phase Inventory Protection)
-- LƯU Ý: Trigger này CHỈ xử lý inventory + ghi history kèm changed_by_user_id.
--         App layer cần SET current_setting('app.current_user_id') TRƯỚC KHI UPDATE order_status.
--         Fallback thông minh: Tự động lấy user_id qua fn_current_user_id() từ JWT Supabase nếu chưa SET context.
--         App layer KHÔNG TỰ INSERT vào order_status_history để tránh duplicate.
CREATE OR REPLACE FUNCTION fn_sync_inventory_on_order_status_change()
RETURNS TRIGGER AS $$
DECLARE
    v_item RECORD;
    v_changed_by BIGINT;
BEGIN
    -- Lấy user_id từ application context (fallback về fn_current_user_id() từ JWT Supabase)
    v_changed_by := COALESCE(
        NULLIF(current_setting('app.current_user_id', true), '')::BIGINT,
        fn_current_user_id()
    );

    IF NEW.order_status IN ('CANCELLED', 'REJECTED') AND OLD.order_status NOT IN ('CANCELLED', 'REJECTED', 'COMPLETED') THEN
        FOR v_item IN SELECT product_id, quantity FROM order_item WHERE order_id = NEW.order_id LOOP
            UPDATE inventory 
            SET reserved_quantity = GREATEST(0, reserved_quantity - v_item.quantity),
                updated_at = now()
            WHERE product_id = v_item.product_id;
        END LOOP;

    ELSIF NEW.order_status = 'COMPLETED' AND OLD.order_status <> 'COMPLETED' THEN
        FOR v_item IN SELECT product_id, quantity FROM order_item WHERE order_id = NEW.order_id LOOP
            UPDATE inventory 
            SET quantity_on_hand = GREATEST(0, quantity_on_hand - v_item.quantity),
                reserved_quantity = GREATEST(0, reserved_quantity - v_item.quantity),
                updated_at = now()
            WHERE product_id = v_item.product_id;
        END LOOP;
    END IF;

    -- Ghi lịch sử trạng thái kèm người thực hiện (tránh duplicate: app layer KHÔNG tự insert)
    IF OLD.order_status <> NEW.order_status THEN
        INSERT INTO order_status_history (order_id, changed_by_user_id, old_status, new_status, reason, changed_at)
        VALUES (NEW.order_id, v_changed_by, OLD.order_status, NEW.order_status, 'Cập nhật trạng thái đơn hàng', now());
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_inventory_on_order_status_change ON orders;
CREATE TRIGGER trg_sync_inventory_on_order_status_change
AFTER UPDATE OF order_status ON orders
FOR EACH ROW EXECUTE FUNCTION fn_sync_inventory_on_order_status_change();


-- 8.6 Kiểm toán lịch sử thay đổi giá sản phẩm (Product Price Audit)
-- LƯU Ý: App layer cần SET current_setting('app.current_user_id') TRƯỚC KHI UPDATE base_price.
--         Fallback thông minh: Tự động lấy user_id qua fn_current_user_id() từ JWT Supabase nếu chưa SET context.
CREATE OR REPLACE FUNCTION fn_audit_product_price_change()
RETURNS TRIGGER AS $$
DECLARE
    v_changed_by BIGINT;
BEGIN
    IF OLD.base_price <> NEW.base_price THEN
        -- Lấy user_id từ application context (fallback về fn_current_user_id() từ JWT Supabase)
        v_changed_by := COALESCE(
            NULLIF(current_setting('app.current_user_id', true), '')::BIGINT,
            fn_current_user_id()
        );

        INSERT INTO product_price_history (product_id, old_price, new_price, changed_by_user_id, changed_at)
        VALUES (NEW.product_id, OLD.base_price, NEW.base_price, v_changed_by, now());
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_product_price_change ON product;
CREATE TRIGGER trg_audit_product_price_change
AFTER UPDATE OF base_price ON product
FOR EACH ROW EXECUTE FUNCTION fn_audit_product_price_change();


-- [FIX LỖ HỔNG 3] Tự động khởi tạo bản ghi Inventory khi tạo Sản phẩm mới
-- Đảm bảo quan hệ 1-1 PRODUCT <-> INVENTORY luôn được duy trì
CREATE OR REPLACE FUNCTION fn_auto_create_inventory_for_new_product()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO inventory (store_id, product_id, quantity_on_hand, reserved_quantity, min_stock_alert, updated_at)
    VALUES (NEW.store_id, NEW.product_id, 0, 0, 5, now())
    ON CONFLICT (product_id) DO NOTHING;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_auto_create_inventory_for_new_product ON product;
CREATE TRIGGER trg_auto_create_inventory_for_new_product
AFTER INSERT ON product
FOR EACH ROW EXECUTE FUNCTION fn_auto_create_inventory_for_new_product();


-- 8.7 Giới hạn Role hợp lệ cho Store_Staff
CREATE OR REPLACE FUNCTION fn_validate_store_staff_role()
RETURNS TRIGGER AS $$
DECLARE
    v_role_code VARCHAR(50);
BEGIN
    SELECT role_code INTO v_role_code FROM roles WHERE role_id = NEW.role_id;
    IF v_role_code NOT LIKE 'STAFF_%' AND v_role_code <> 'STORE_OWNER' THEN
        RAISE EXCEPTION 'Gán vai trò sai: Chỉ được gán vai trò nhân viên (STAFF_*) hoặc STORE_OWNER cho nhân sự cửa hàng.';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_validate_store_staff_role ON store_staff;
CREATE TRIGGER trg_validate_store_staff_role
BEFORE INSERT OR UPDATE OF role_id ON store_staff
FOR EACH ROW EXECUTE FUNCTION fn_validate_store_staff_role();


-- 8.8 Tự động cập nhật updated_at cho 14 bảng
CREATE OR REPLACE FUNCTION fn_auto_update_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
    target_table text;
    target_tables text[] := ARRAY[
        'users', 'store', 'store_staff', 'customer_profile', 'customer_address', 
        'store_customer', 'category', 'product', 'product_discount', 'inventory', 
        'iot_button', 'button_product', 'orders', 'payment_transaction'
    ];
BEGIN
    FOREACH target_table IN ARRAY target_tables LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS trg_auto_update_timestamp_%I ON %I;', target_table, target_table);
        EXECUTE format('CREATE TRIGGER trg_auto_update_timestamp_%I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION fn_auto_update_timestamp();', target_table, target_table);
    END LOOP;
END;
$$;

-- =====================================================================
-- 9. STORED PROCEDURE TẠO ĐƠN HÀNG AN TOÀN (ANTI RACE-CONDITION)
-- =====================================================================

CREATE OR REPLACE FUNCTION sp_create_order_from_button(
    p_button_id BIGINT,
    p_payment_method VARCHAR(30) DEFAULT 'COD',
    p_shipping_fee DECIMAL(15,2) DEFAULT 0,
    p_order_note TEXT DEFAULT NULL
)
RETURNS BIGINT 
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_btn RECORD;
    v_order_id BIGINT;
    v_order_code VARCHAR(50);
    v_subtotal DECIMAL(15,2) := 0;
    v_total_discount DECIMAL(15,2) := 0;
    v_item RECORD;
    v_discount RECORD;
    v_unit_discount DECIMAL(15,2);
    v_final_price DECIMAL(15,2);
    v_line_subtotal DECIMAL(15,2);
BEGIN
    -- Validate payment_method
    IF p_payment_method NOT IN ('COD', 'PAYOS') THEN
        RAISE EXCEPTION 'Phương thức thanh toán không hợp lệ: %. Chỉ chấp nhận COD hoặc PAYOS.', p_payment_method;
    END IF;

    IF p_shipping_fee < 0 THEN
        RAISE EXCEPTION 'Phí vận chuyển không được âm.';
    END IF;
    -- 1. Khóa bi quan và kiểm tra Nút bấm
    SELECT b.*, ca.recipient_name, ca.phone AS recipient_phone, ca.address_detail, ca.ward, ca.district, ca.province
    INTO v_btn
    FROM iot_button b
    JOIN customer_address ca ON b.customer_id = ca.customer_id AND b.address_id = ca.address_id
    WHERE b.button_id = p_button_id
    FOR UPDATE OF b;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Nút bấm ID % không tồn tại.', p_button_id;
    END IF;

    IF v_btn.status <> 'ACTIVE' THEN
        RAISE EXCEPTION 'Nút bấm ID % đang không ở trạng thái ACTIVE.', p_button_id;
    END IF;

    -- Kiểm tra Cửa hàng có đang hoạt động không
    IF NOT EXISTS (SELECT 1 FROM store WHERE store_id = v_btn.store_id AND status = 'ACTIVE') THEN
        RAISE EXCEPTION 'Store ID % hiện không hoạt động.', v_btn.store_id;
    END IF;

    -- 1b. Kiểm tra nút phải có ít nhất 1 sản phẩm cấu hình
    IF NOT EXISTS (SELECT 1 FROM button_product WHERE button_id = p_button_id) THEN
        RAISE EXCEPTION 'Nút bấm ID % chưa cấu hình sản phẩm nào. Không thể tạo đơn hàng rỗng.', p_button_id;
    END IF;

    -- 1c. Kiểm tra tất cả sản phẩm trên nút phải đang ACTIVE
    IF EXISTS (
        SELECT 1 FROM button_product bp
        JOIN product p ON bp.product_id = p.product_id
        WHERE bp.button_id = p_button_id AND p.status <> 'ACTIVE'
    ) THEN
        RAISE EXCEPTION 'Một hoặc nhiều sản phẩm trên nút bấm ID % không ở trạng thái ACTIVE. Vui lòng cập nhật cấu hình nút.', p_button_id;
    END IF;

    -- 2. Khóa tất cả các dòng Tồn kho của các sản phẩm có trong nút
    PERFORM 1 
    FROM inventory inv
    JOIN button_product bp ON inv.product_id = bp.product_id
    WHERE bp.button_id = p_button_id
    FOR UPDATE OF inv;

    -- 3. Kiểm tra All-or-Nothing: Đảm bảo TẤT CẢ các sản phẩm đều đủ tồn khả dụng
    IF EXISTS (
        SELECT 1
        FROM button_product bp
        JOIN inventory inv ON bp.product_id = inv.product_id
        WHERE bp.button_id = p_button_id
          AND (inv.quantity_on_hand - inv.reserved_quantity) < bp.quantity
    ) THEN
        RAISE EXCEPTION 'Không đủ tồn kho khả dụng cho một hoặc nhiều sản phẩm trong nút bấm.';
    END IF;

    -- 4. Tạo mã đơn hàng duy nhất
    v_order_code := 'ORD-' || to_char(now(), 'YYYYMMDD') || '-' || substr(md5(random()::text), 1, 6);

    -- 5. Tạo bản ghi Orders tạm thời
    INSERT INTO orders (
        order_code, store_id, customer_id, button_id, order_status, payment_status, payment_method,
        subtotal_amount, discount_amount, shipping_fee, total_amount,
        shipping_recipient_name, shipping_phone, shipping_address, order_note, order_date
    ) VALUES (
        v_order_code, v_btn.store_id, v_btn.customer_id, v_btn.button_id,
        'PENDING', 'UNPAID', p_payment_method, 0, 0, p_shipping_fee, p_shipping_fee, -- total = shipping_fee thỏa CHECK (0 - 0 + fee = fee)
        v_btn.recipient_name, v_btn.recipient_phone, 
        concat_ws(', ', v_btn.address_detail, v_btn.ward, v_btn.district, v_btn.province),
        p_order_note, now()
    ) RETURNING order_id INTO v_order_id;

    -- 6. Duyệt qua từng sản phẩm để Snapshot và Giữ kho (Reserved)
    FOR v_item IN 
        SELECT bp.product_id, bp.quantity, p.product_name, p.base_price
        FROM button_product bp
        JOIN product p ON bp.product_id = p.product_id
        WHERE bp.button_id = p_button_id
    LOOP
        -- Tìm giảm giá ACTIVE hiện hành
        SELECT * INTO v_discount
        FROM product_discount
        WHERE product_id = v_item.product_id
          AND status = 'ACTIVE'
          AND now() BETWEEN start_at AND end_at
        LIMIT 1;

        IF FOUND THEN
            IF v_discount.discount_percent IS NOT NULL THEN
                v_unit_discount := ROUND((v_item.base_price * v_discount.discount_percent / 100.0), 2);
            ELSE
                v_unit_discount := LEAST(v_item.base_price, v_discount.discount_amount);
            END IF;
        ELSE
            v_unit_discount := 0;
        END IF;

        v_final_price := v_item.base_price - v_unit_discount;
        v_line_subtotal := v_final_price * v_item.quantity;

        v_subtotal := v_subtotal + (v_item.base_price * v_item.quantity);
        v_total_discount := v_total_discount + (v_unit_discount * v_item.quantity);

        -- Thêm Order Item
        INSERT INTO order_item (
            order_id, product_id, product_name_snapshot, unit_price_snapshot,
            discount_percent_snapshot, discount_amount_snapshot, final_unit_price, quantity, item_subtotal
        ) VALUES (
            v_order_id, v_item.product_id, v_item.product_name, v_item.base_price,
            COALESCE(v_discount.discount_percent, 0), v_unit_discount, v_final_price, v_item.quantity, v_line_subtotal
        );

        -- Tăng tồn giữ chỗ (Reserved Quantity)
        UPDATE inventory 
        SET reserved_quantity = reserved_quantity + v_item.quantity,
            updated_at = now()
        WHERE product_id = v_item.product_id;
    END LOOP;

    -- 7. Cập nhật lại tổng tiền chính xác cho đơn hàng (bao gồm shipping_fee)
    UPDATE orders
    SET subtotal_amount = v_subtotal,
        discount_amount = v_total_discount,
        total_amount = (v_subtotal - v_total_discount + p_shipping_fee)
    WHERE order_id = v_order_id;

    -- 8. Ghi nhận lịch sử trạng thái ban đầu
    INSERT INTO order_status_history (order_id, old_status, new_status, reason, changed_at)
    VALUES (v_order_id, NULL, 'PENDING', 'Khách hàng nhấn nút tạo đơn thành công', now());

    RETURN v_order_id;
END;
$$;

-- =====================================================================
-- 10. ROW LEVEL SECURITY (RLS) POLICIES CHO SUPABASE
-- =====================================================================
-- [FIX LỖI 2] Sử dụng auth_id UUID thay vì auth.uid()::bigint
-- Supabase auth.uid() trả về UUID, KHÔNG THỂ ép kiểu trực tiếp sang BIGINT.
-- Giải pháp: Helper function fn_current_user_id() ánh xạ UUID -> BIGINT qua cột users.auth_id.
-- =====================================================================

-- Helper function CỐT LÕI: Ánh xạ Supabase Auth UUID → user_id BIGINT
CREATE OR REPLACE FUNCTION fn_current_user_id()
RETURNS BIGINT AS $$
    SELECT user_id FROM users WHERE auth_id = auth.uid() LIMIT 1;
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- Helper function: Lấy customer_id của user hiện tại
CREATE OR REPLACE FUNCTION fn_current_customer_id()
RETURNS BIGINT AS $$
    SELECT customer_id FROM customer_profile WHERE user_id = fn_current_user_id() LIMIT 1;
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- Helper function: Kiểm tra user có phải Store Owner hoặc Staff ACTIVE của store_id không
CREATE OR REPLACE FUNCTION fn_user_has_store_access(p_store_id BIGINT)
RETURNS BOOLEAN AS $$
    SELECT EXISTS (
        SELECT 1 FROM store WHERE store_id = p_store_id AND owner_user_id = fn_current_user_id()
        UNION ALL
        SELECT 1 FROM store_staff WHERE store_id = p_store_id AND user_id = fn_current_user_id() AND status = 'ACTIVE'
    );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- Bật RLS cho tất cả các bảng
ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE store ENABLE ROW LEVEL SECURITY;
ALTER TABLE store_staff ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_profile ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_address ENABLE ROW LEVEL SECURITY;
ALTER TABLE store_customer ENABLE ROW LEVEL SECURITY;
ALTER TABLE category ENABLE ROW LEVEL SECURITY;
ALTER TABLE product ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_price_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_discount ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory ENABLE ROW LEVEL SECURITY;
ALTER TABLE iot_button ENABLE ROW LEVEL SECURITY;
ALTER TABLE button_product ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_status_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_transaction ENABLE ROW LEVEL SECURITY;

-- =====================================================================
-- POLICIES: DỮ LIỆU CÔNG KHAI
-- =====================================================================
CREATE POLICY "Public read roles" ON roles FOR SELECT USING (true);
CREATE POLICY "Public read active stores" ON store FOR SELECT USING (status = 'ACTIVE');
CREATE POLICY "Public read categories" ON category FOR SELECT USING (status = 'ACTIVE');
CREATE POLICY "Public read products" ON product FOR SELECT USING (status = 'ACTIVE');
CREATE POLICY "Public read active discounts" ON product_discount FOR SELECT USING (status = 'ACTIVE');

-- =====================================================================
-- POLICIES: USERS
-- =====================================================================
CREATE POLICY "Users read own profile" ON users
FOR SELECT USING (user_id = fn_current_user_id());

CREATE POLICY "Users update own profile" ON users
FOR UPDATE USING (user_id = fn_current_user_id());

-- =====================================================================
-- POLICIES: STORE & STAFF
-- =====================================================================
CREATE POLICY "Owner manage own store" ON store
FOR ALL USING (owner_user_id = fn_current_user_id());

CREATE POLICY "Store access staff list" ON store_staff
FOR SELECT USING (fn_user_has_store_access(store_id));

CREATE POLICY "Owner manage store staff" ON store_staff
FOR ALL USING (
    store_id IN (SELECT store_id FROM store WHERE owner_user_id = fn_current_user_id())
);

-- =====================================================================
-- POLICIES: CUSTOMER & ADDRESS
-- =====================================================================
CREATE POLICY "Customers manage own profile" ON customer_profile
FOR ALL USING (user_id = fn_current_user_id());

CREATE POLICY "Store staff read linked customers" ON customer_profile
FOR SELECT USING (
    customer_id IN (
        SELECT sc.customer_id FROM store_customer sc
        WHERE fn_user_has_store_access(sc.store_id)
    )
);

CREATE POLICY "Customers manage own address" ON customer_address
FOR ALL USING (customer_id = fn_current_customer_id());

CREATE POLICY "Customers view own store links" ON store_customer
FOR SELECT USING (customer_id = fn_current_customer_id());

CREATE POLICY "Store staff manage store customers" ON store_customer
FOR ALL USING (fn_user_has_store_access(store_id));

-- =====================================================================
-- POLICIES: PRODUCT & INVENTORY
-- =====================================================================
CREATE POLICY "Store staff view price history" ON product_price_history
FOR SELECT USING (
    product_id IN (
        SELECT product_id FROM product WHERE fn_user_has_store_access(store_id)
    )
);

CREATE POLICY "Store staff manage inventory" ON inventory
FOR ALL USING (fn_user_has_store_access(store_id));

-- =====================================================================
-- POLICIES: IOT BUTTON & CONFIG
-- =====================================================================
CREATE POLICY "Customers view own buttons" ON iot_button
FOR SELECT USING (customer_id = fn_current_customer_id());

CREATE POLICY "Customers update own buttons" ON iot_button
FOR UPDATE USING (customer_id = fn_current_customer_id());

CREATE POLICY "Store staff manage store buttons" ON iot_button
FOR ALL USING (fn_user_has_store_access(store_id));

CREATE POLICY "Customers manage own button products" ON button_product
FOR ALL USING (
    button_id IN (SELECT button_id FROM iot_button WHERE customer_id = fn_current_customer_id())
);

CREATE POLICY "Store staff view button products" ON button_product
FOR SELECT USING (
    button_id IN (SELECT button_id FROM iot_button WHERE fn_user_has_store_access(store_id))
);

-- =====================================================================
-- POLICIES: ORDERS & PAYMENT
-- =====================================================================
CREATE POLICY "Customers view own orders" ON orders
FOR SELECT USING (customer_id = fn_current_customer_id());

CREATE POLICY "Store staff manage store orders" ON orders
FOR ALL USING (fn_user_has_store_access(store_id));

CREATE POLICY "Customers view own order items" ON order_item
FOR SELECT USING (
    order_id IN (SELECT order_id FROM orders WHERE customer_id = fn_current_customer_id())
);

CREATE POLICY "Store staff view store order items" ON order_item
FOR SELECT USING (
    order_id IN (SELECT order_id FROM orders WHERE fn_user_has_store_access(store_id))
);

CREATE POLICY "Customers view own order history" ON order_status_history
FOR SELECT USING (
    order_id IN (SELECT order_id FROM orders WHERE customer_id = fn_current_customer_id())
);

CREATE POLICY "Store staff view store order history" ON order_status_history
FOR SELECT USING (
    order_id IN (SELECT order_id FROM orders WHERE fn_user_has_store_access(store_id))
);

CREATE POLICY "Customers view own payments" ON payment_transaction
FOR SELECT USING (
    order_id IN (SELECT order_id FROM orders WHERE customer_id = fn_current_customer_id())
);

CREATE POLICY "Store staff manage store payments" ON payment_transaction
FOR ALL USING (
    order_id IN (SELECT order_id FROM orders WHERE fn_user_has_store_access(store_id))
);
