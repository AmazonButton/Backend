-- ============================================================================
-- SƠ ĐỒ ERD LEVEL 3 — FULL PHYSICAL DATABASE SCHEMA SCRIPT (POSTGRESQL / SUPABASE)
-- Dự án: Smart Order Button & Multi-Store Marketplace Platform V2.2
-- Phiên bản: Level 3 Physical DDL (Chuẩn hóa 28 bảng vật lý thực tế)
-- Tương thích: PostgreSQL 15+ / Supabase SQL Editor / Prisma ORM
-- ============================================================================

-- Bắt đầu khối giao dịch
BEGIN;

-- 0. CẤU HÌNH TIỆN ÍCH MỞ RỘNG (EXTENSIONS)
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================================
-- NHÓM 1: DANH TÍNH, PHÂN QUYỀN & BẢO MẬT PHIÊN (IDENTITY, RBAC & SESSIONS)
-- ============================================================================

-- 1.1 Bảng Vai Trò (roles)
CREATE TABLE IF NOT EXISTS public.roles (
    role_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    role_code VARCHAR(50) UNIQUE NOT NULL,
    role_name VARCHAR(100) NOT NULL,
    description TEXT
);

-- 1.2 Bảng Người Dùng Toàn Cầu (users)
CREATE TABLE IF NOT EXISTS public.users (
    user_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    auth_id UUID UNIQUE, -- Ánh xạ 1-1 với Supabase auth.users.id
    username VARCHAR(100) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    full_name VARCHAR(255) NOT NULL,
    phone VARCHAR(20),
    password_reset_token VARCHAR(255),
    password_reset_expires_at TIMESTAMPTZ,
    email_verification_token VARCHAR(255),
    email_verification_expires_at TIMESTAMPTZ,
    status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE', 'BLOCKED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 1.3 Bảng Phân Quyền Người Dùng (user_roles)
CREATE TABLE IF NOT EXISTS public.user_roles (
    user_id BIGINT NOT NULL REFERENCES public.users(user_id) ON DELETE CASCADE,
    role_id BIGINT NOT NULL REFERENCES public.roles(role_id) ON DELETE RESTRICT,
    assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, role_id)
);

-- 1.4 Bảng Refresh Tokens (Xoay vòng Single-use Rotation & Thu hồi Session)
CREATE TABLE IF NOT EXISTS public.refresh_tokens (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES public.users(user_id) ON DELETE CASCADE,
    token_hash VARCHAR(255) NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    is_revoked BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================================
-- NHÓM 2: GIAN HÀNG, NHÂN VIÊN & THÀNH VIÊN (MERCHANT & STORE MANAGEMENT)
-- ============================================================================

-- 2.1 Bảng Cửa Hàng Độc Lập (store)
CREATE TABLE IF NOT EXISTS public.store (
    store_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    owner_user_id BIGINT NOT NULL REFERENCES public.users(user_id) ON DELETE RESTRICT,
    name VARCHAR(255) NOT NULL,
    code VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(255),
    phone VARCHAR(20),
    address TEXT,
    commission_rate DECIMAL(5,2) DEFAULT 8.00 CHECK (commission_rate >= 0 AND commission_rate <= 100),
    status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE', 'SUSPENDED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2.2 Bảng Nhân Viên Cửa Hàng (store_staff)
CREATE TABLE IF NOT EXISTS public.store_staff (
    staff_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    store_id BIGINT NOT NULL REFERENCES public.store(store_id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES public.users(user_id) ON DELETE CASCADE,
    role_id BIGINT NOT NULL REFERENCES public.roles(role_id) ON DELETE RESTRICT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_store_staff_user UNIQUE (store_id, user_id)
);

-- ============================================================================
-- NHÓM 3: HỒ SƠ KHÁCH HÀNG & ĐỊA CHỈ GIAO HÀNG (CUSTOMER & ADDRESS)
-- ============================================================================

-- 3.1 Bảng Hồ Sơ Khách Hàng Toàn Cầu (customer_profile)
CREATE TABLE IF NOT EXISTS public.customer_profile (
    customer_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id BIGINT NOT NULL UNIQUE REFERENCES public.users(user_id) ON DELETE CASCADE,
    customer_code VARCHAR(50) UNIQUE NOT NULL,
    date_of_birth TIMESTAMPTZ,
    gender VARCHAR(10) CHECK (gender IN ('MALE', 'FEMALE', 'OTHER')),
    default_payment_method VARCHAR(20) NOT NULL DEFAULT 'COD' CHECK (default_payment_method IN ('COD', 'PAYOS')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3.2 Bảng Sổ Địa Chỉ Khách Hàng (customer_address)
CREATE TABLE IF NOT EXISTS public.customer_address (
    address_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    customer_id BIGINT NOT NULL REFERENCES public.customer_profile(customer_id) ON DELETE CASCADE,
    receiver_name VARCHAR(255) NOT NULL,
    receiver_phone VARCHAR(20) NOT NULL,
    address_line TEXT NOT NULL,
    ward VARCHAR(100),
    district VARCHAR(100),
    city VARCHAR(100) NOT NULL,
    is_default BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3.3 Bảng Khách Hàng Thân Thiết Của Cửa Hàng (store_customer)
CREATE TABLE IF NOT EXISTS public.store_customer (
    store_customer_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    store_id BIGINT NOT NULL REFERENCES public.store(store_id) ON DELETE CASCADE,
    customer_id BIGINT NOT NULL REFERENCES public.customer_profile(customer_id) ON DELETE CASCADE,
    loyalty_points INT NOT NULL DEFAULT 0 CHECK (loyalty_points >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_store_customer_pair UNIQUE (store_id, customer_id)
);

-- ============================================================================
-- NHÓM 4: DANH MỤC, SẢN PHẨM, HÌNH ẢNH CLOUDINARY & KHO BÃI
-- ============================================================================

-- 4.1 Bảng Danh Mục Sản Phẩm (category)
CREATE TABLE IF NOT EXISTS public.category (
    category_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    store_id BIGINT NOT NULL REFERENCES public.store(store_id) ON DELETE CASCADE,
    parent_id BIGINT REFERENCES public.category(category_id) ON DELETE SET NULL,
    name VARCHAR(255) NOT NULL,
    slug VARCHAR(255) NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_category_store_slug UNIQUE (store_id, slug)
);

-- 4.2 Bảng Sản Phẩm (product)
CREATE TABLE IF NOT EXISTS public.product (
    product_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    store_id BIGINT NOT NULL REFERENCES public.store(store_id) ON DELETE RESTRICT,
    category_id BIGINT REFERENCES public.category(category_id) ON DELETE SET NULL,
    product_code VARCHAR(50) NOT NULL,
    product_name VARCHAR(255) NOT NULL,
    brand VARCHAR(100),
    description TEXT,
    base_price DECIMAL(15,2) NOT NULL CHECK (base_price >= 0),
    status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('DRAFT', 'ACTIVE', 'INACTIVE', 'ARCHIVED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_product_store_code UNIQUE (store_id, product_code)
);

-- 4.3 Bảng Đa Hình Ảnh Sản Phẩm (product_image - Option 2 Cloudinary)
CREATE TABLE IF NOT EXISTS public.product_image (
    image_id BIGSERIAL PRIMARY KEY,
    product_id BIGINT NOT NULL REFERENCES public.product(product_id) ON DELETE CASCADE,
    image_url TEXT NOT NULL,
    is_thumbnail BOOLEAN NOT NULL DEFAULT FALSE,
    display_order INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 4.4 Bảng Lịch Sử Giá Bán (product_price_history)
CREATE TABLE IF NOT EXISTS public.product_price_history (
    history_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    product_id BIGINT NOT NULL REFERENCES public.product(product_id) ON DELETE CASCADE,
    old_price DECIMAL(15,2) NOT NULL,
    new_price DECIMAL(15,2) NOT NULL,
    changed_by_user_id BIGINT REFERENCES public.users(user_id) ON DELETE SET NULL,
    changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 4.5 Bảng Khuyến Mãi / Giảm Giá Sản Phẩm (product_discount)
CREATE TABLE IF NOT EXISTS public.product_discount (
    discount_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    product_id BIGINT NOT NULL REFERENCES public.product(product_id) ON DELETE RESTRICT,
    discount_percent DECIMAL(5,2) CHECK (discount_percent > 0 AND discount_percent <= 100),
    discount_amount DECIMAL(15,2) CHECK (discount_amount > 0),
    start_at TIMESTAMPTZ NOT NULL,
    end_at TIMESTAMPTZ NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'EXPIRED', 'DISABLED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_discount_time CHECK (end_at > start_at)
);

-- 4.6 Bảng Quản Lý Tồn Kho (inventory)
CREATE TABLE IF NOT EXISTS public.inventory (
    inventory_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    store_id BIGINT NOT NULL REFERENCES public.store(store_id) ON DELETE RESTRICT,
    product_id BIGINT NOT NULL UNIQUE REFERENCES public.product(product_id) ON DELETE CASCADE,
    quantity_on_hand INT NOT NULL DEFAULT 0 CHECK (quantity_on_hand >= 0),
    reserved_quantity INT NOT NULL DEFAULT 0 CHECK (reserved_quantity >= 0),
    min_stock_alert INT NOT NULL DEFAULT 5 CHECK (min_stock_alert >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================================
-- NHÓM 5: THIẾT BỊ IOT, THUÊ NÚT & LỊCH SỬ CẤU HÌNH (HARDWARE & IOT ECOSYSTEM)
-- ============================================================================

-- 5.1 Bảng Mẫu Cấu Hình Nút Bấm Thiết Bị (device_templates)
CREATE TABLE IF NOT EXISTS public.device_templates (
    template_id BIGSERIAL PRIMARY KEY,
    code VARCHAR(100) NOT NULL UNIQUE,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    category VARCHAR(100),
    store_id BIGINT REFERENCES public.store(store_id) ON DELETE CASCADE, -- NULL = toàn sàn
    single_press_action VARCHAR(50) DEFAULT 'CREATE_ORDER',
    double_press_action VARCHAR(50) DEFAULT 'CANCEL_ORDER',
    default_quantity INT DEFAULT 1,
    cancel_window_seconds INT DEFAULT 60,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 5.2 Bảng Gói Thuê Nút Bấm Phần Cứng (rental_packages)
CREATE TABLE IF NOT EXISTS public.rental_packages (
    package_id BIGSERIAL PRIMARY KEY,
    package_code VARCHAR(50) NOT NULL UNIQUE,
    package_name VARCHAR(150) NOT NULL,
    button_quantity INT NOT NULL CHECK (button_quantity > 0),
    monthly_price DECIMAL(15,2) NOT NULL CHECK (monthly_price >= 0),
    deposit_fee DECIMAL(15,2) NOT NULL CHECK (deposit_fee >= 0),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 5.3 Bảng Hợp Đồng Thuê Nút Bấm Khách Hàng (button_rentals)
CREATE TABLE IF NOT EXISTS public.button_rentals (
    rental_id BIGSERIAL PRIMARY KEY,
    rental_code VARCHAR(50) NOT NULL UNIQUE,
    customer_id BIGINT NOT NULL REFERENCES public.customer_profile(customer_id) ON DELETE RESTRICT,
    package_id BIGINT NOT NULL REFERENCES public.rental_packages(package_id) ON DELETE RESTRICT,
    months_rented INT NOT NULL CHECK (months_rented > 0),
    total_rent_amount DECIMAL(15,2) NOT NULL,
    deposit_amount DECIMAL(15,2) NOT NULL,
    start_date TIMESTAMPTZ NOT NULL,
    end_date TIMESTAMPTZ NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'ACTIVE', 'COMPLETED', 'CANCELLED', 'OVERDUE')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 5.4 Bảng Nút Bấm Thông Minh Đa Năng (iot_button)
CREATE TABLE IF NOT EXISTS public.iot_button (
    button_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    device_id VARCHAR(100) UNIQUE NOT NULL, -- MAC Address / Serial phần cứng ESP32
    button_code VARCHAR(50) UNIQUE NOT NULL, -- Mã định danh thân thiện
    customer_id BIGINT NOT NULL REFERENCES public.customer_profile(customer_id) ON DELETE RESTRICT,
    store_id BIGINT NOT NULL REFERENCES public.store(store_id) ON DELETE RESTRICT, -- Hỗ trợ Store Re-mapping
    address_id BIGINT NOT NULL REFERENCES public.customer_address(address_id) ON DELETE RESTRICT,
    rental_id BIGINT REFERENCES public.button_rentals(rental_id) ON DELETE SET NULL,
    label_name VARCHAR(100),
    status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE', 'SUSPENDED', 'UNASSIGNED')),
    last_pressed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 5.5 Bảng Lịch Sử Thay Đổi Cấu Hình Nút (button_config_history)
CREATE TABLE IF NOT EXISTS public.button_config_history (
    history_id BIGSERIAL PRIMARY KEY,
    button_id BIGINT NOT NULL REFERENCES public.iot_button(button_id) ON DELETE CASCADE,
    old_store_id BIGINT,
    new_store_id BIGINT,
    change_type VARCHAR(50) NOT NULL, -- REMAP_STORE, UPDATE_PRODUCTS, CHANGE_ADDRESS
    changed_by VARCHAR(50) NOT NULL, -- ADMIN, CUSTOMER
    old_config JSONB,
    new_config JSONB,
    changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 5.6 Bảng Gán Món Hàng Cấu Hình Trên Nút (button_product)
CREATE TABLE IF NOT EXISTS public.button_product (
    button_product_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    button_id BIGINT NOT NULL REFERENCES public.iot_button(button_id) ON DELETE CASCADE,
    product_id BIGINT NOT NULL REFERENCES public.product(product_id) ON DELETE CASCADE,
    quantity INT NOT NULL CHECK (quantity > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_button_product_pair UNIQUE (button_id, product_id)
);

-- ============================================================================
-- NHÓM 6: ĐƠN HÀNG, THANH TOÁN, VÍ ĐIỆN TỬ & QUYẾT TOÁN SÀN (ORDERS & WALLETS)
-- ============================================================================

-- 6.1 Bảng Đơn Hàng (orders)
CREATE TABLE IF NOT EXISTS public.orders (
    order_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_code VARCHAR(50) UNIQUE NOT NULL,
    store_id BIGINT NOT NULL REFERENCES public.store(store_id) ON DELETE RESTRICT,
    customer_id BIGINT NOT NULL REFERENCES public.customer_profile(customer_id) ON DELETE RESTRICT,
    button_id BIGINT REFERENCES public.iot_button(button_id) ON DELETE SET NULL,
    address_id BIGINT NOT NULL REFERENCES public.customer_address(address_id) ON DELETE RESTRICT,
    subtotal_amount DECIMAL(15,2) NOT NULL CHECK (subtotal_amount >= 0),
    discount_amount DECIMAL(15,2) NOT NULL DEFAULT 0.00 CHECK (discount_amount >= 0),
    shipping_fee DECIMAL(15,2) NOT NULL DEFAULT 0.00 CHECK (shipping_fee >= 0),
    total_amount DECIMAL(15,2) NOT NULL CHECK (total_amount >= 0),
    commission_rate DECIMAL(5,2) NOT NULL DEFAULT 8.00,
    commission_amount DECIMAL(15,2) NOT NULL DEFAULT 0.00,
    net_amount DECIMAL(15,2) NOT NULL CHECK (net_amount >= 0),
    status VARCHAR(30) NOT NULL DEFAULT 'PENDING' CHECK (status IN (
        'PENDING', 'CONFIRMED', 'PREPARING', 'READY_FOR_DELIVERY', 
        'SHIPPING', 'DELIVERED', 'COMPLETED', 'CANCELLED'
    )),
    payment_status VARCHAR(20) NOT NULL DEFAULT 'PENDING' CHECK (payment_status IN (
        'PENDING', 'PAID', 'FAILED', 'REFUNDED'
    )),
    payment_method VARCHAR(20) NOT NULL DEFAULT 'COD' CHECK (payment_method IN ('COD', 'PAYOS')),
    cancel_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 6.2 Bảng Chi Tiết Mặt Hàng Trong Đơn (order_items)
CREATE TABLE IF NOT EXISTS public.order_items (
    item_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_id BIGINT NOT NULL REFERENCES public.orders(order_id) ON DELETE CASCADE,
    product_id BIGINT NOT NULL REFERENCES public.product(product_id) ON DELETE RESTRICT,
    product_name_snapshot VARCHAR(255) NOT NULL,
    unit_price_snapshot DECIMAL(15,2) NOT NULL,
    discount_amount_snapshot DECIMAL(15,2) NOT NULL DEFAULT 0.00,
    final_unit_price DECIMAL(15,2) NOT NULL,
    quantity INT NOT NULL CHECK (quantity > 0),
    item_subtotal DECIMAL(15,2) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 6.3 Bảng Lịch Sử Trạng Thái Đơn Hàng (order_status_history)
CREATE TABLE IF NOT EXISTS public.order_status_history (
    history_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_id BIGINT NOT NULL REFERENCES public.orders(order_id) ON DELETE CASCADE,
    from_status VARCHAR(30),
    to_status VARCHAR(30) NOT NULL,
    changed_by_user_id BIGINT REFERENCES public.users(user_id) ON DELETE SET NULL,
    reason TEXT,
    changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 6.4 Bảng Giao Dịch Cổng Thanh Toán PayOS / COD (payment_transaction)
CREATE TABLE IF NOT EXISTS public.payment_transaction (
    payment_transaction_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_id BIGINT NOT NULL REFERENCES public.orders(order_id) ON DELETE CASCADE,
    provider VARCHAR(50) NOT NULL DEFAULT 'PAYOS',
    transaction_code VARCHAR(100) UNIQUE NOT NULL, -- orderCode PayOS
    amount DECIMAL(15,2) NOT NULL,
    payment_method VARCHAR(50) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING' CHECK (status IN (
        'PENDING', 'SUCCESS', 'PAID', 'FAILED', 'CANCELLED', 'EXPIRED'
    )),
    paid_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 6.5 Bảng Gói Thuê Bao Mở Gian Hàng (subscription_plans)
CREATE TABLE IF NOT EXISTS public.subscription_plans (
    plan_id BIGSERIAL PRIMARY KEY,
    plan_code VARCHAR(50) NOT NULL UNIQUE,
    plan_name VARCHAR(150) NOT NULL,
    description TEXT,
    price DECIMAL(15,2) NOT NULL CHECK (price >= 0),
    duration_days INT NOT NULL CHECK (duration_days > 0),
    max_products INT NOT NULL DEFAULT 50 CHECK (max_products > 0),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 6.6 Bảng Đăng Ký Gói Cước Thuê Gian Hàng Của Store (store_subscriptions)
CREATE TABLE IF NOT EXISTS public.store_subscriptions (
    subscription_id BIGSERIAL PRIMARY KEY,
    store_id BIGINT NOT NULL REFERENCES public.store(store_id) ON DELETE RESTRICT,
    plan_id BIGINT NOT NULL REFERENCES public.subscription_plans(plan_id) ON DELETE RESTRICT,
    start_date TIMESTAMPTZ NOT NULL,
    end_date TIMESTAMPTZ NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'ACTIVE', 'EXPIRED', 'CANCELLED')),
    payment_method VARCHAR(50) NOT NULL DEFAULT 'WALLET',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 6.7 Bảng Ví Điện Tử Cửa Hàng (store_wallets)
CREATE TABLE IF NOT EXISTS public.store_wallets (
    wallet_id BIGSERIAL PRIMARY KEY,
    store_id BIGINT NOT NULL UNIQUE REFERENCES public.store(store_id) ON DELETE RESTRICT,
    balance DECIMAL(15,2) NOT NULL DEFAULT 0.00 CHECK (balance >= 0),
    frozen_balance DECIMAL(15,2) NOT NULL DEFAULT 0.00 CHECK (frozen_balance >= 0),
    bank_code VARCHAR(20),
    bank_name VARCHAR(100),
    bank_account_number VARCHAR(50),
    bank_account_holder VARCHAR(150),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 6.8 Bảng Sổ Cái Giao Dịch Ví (wallet_transactions)
CREATE TABLE IF NOT EXISTS public.wallet_transactions (
    transaction_id BIGSERIAL PRIMARY KEY,
    wallet_id BIGINT NOT NULL REFERENCES public.store_wallets(wallet_id) ON DELETE RESTRICT,
    amount DECIMAL(15,2) NOT NULL,
    type VARCHAR(50) NOT NULL CHECK (type IN ('ORDER_REVENUE', 'WITHDRAWAL_DEBIT', 'WITHDRAWAL_REFUND', 'ADJUSTMENT')),
    balance_before DECIMAL(15,2) NOT NULL,
    balance_after DECIMAL(15,2) NOT NULL,
    reference_id BIGINT,
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 6.9 Bảng Yêu Cầu Rút Tiền & Chi Trả Tự Động PayOS Payout (store_withdrawals)
CREATE TABLE IF NOT EXISTS public.store_withdrawals (
    withdrawal_id BIGSERIAL PRIMARY KEY,
    withdrawal_code VARCHAR(50) NOT NULL UNIQUE,
    wallet_id BIGINT NOT NULL REFERENCES public.store_wallets(wallet_id) ON DELETE RESTRICT,
    amount DECIMAL(15,2) NOT NULL CHECK (amount > 0),
    fee DECIMAL(15,2) NOT NULL DEFAULT 0.00 CHECK (fee >= 0),
    net_amount DECIMAL(15,2) NOT NULL CHECK (net_amount > 0),
    bank_code VARCHAR(20) NOT NULL,
    bank_name VARCHAR(100) NOT NULL,
    bank_account_number VARCHAR(50) NOT NULL,
    bank_account_holder VARCHAR(150) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING' CHECK (status IN (
        'PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'REJECTED'
    )),
    provider VARCHAR(50) NOT NULL DEFAULT 'PAYOS',
    provider_payout_id VARCHAR(100),
    provider_reference_id VARCHAR(100) UNIQUE, -- Khóa đối soát Idempotency
    failure_reason TEXT,
    approved_by_user_id BIGINT REFERENCES public.users(user_id) ON DELETE SET NULL,
    requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    processed_at TIMESTAMPTZ
);

-- ============================================================================
-- CHỈ MỤC TỐI ƯU HÓA HIỆU NĂNG TẦNG VẬT LÝ (PERFORMANCE INDEXES)
-- ============================================================================

-- Tối ưu truy vấn người dùng & phiên đăng nhập
CREATE INDEX IF NOT EXISTS idx_users_email ON public.users(email);
CREATE INDEX IF NOT EXISTS idx_users_phone ON public.users(phone);
CREATE UNIQUE INDEX IF NOT EXISTS idx_refresh_tokens_token_hash ON public.refresh_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id ON public.refresh_tokens(user_id);

-- Tối ưu hình ảnh sản phẩm Cloudinary (Option 2)
CREATE INDEX IF NOT EXISTS idx_product_image_product_id ON public.product_image(product_id);
CREATE INDEX IF NOT EXISTS idx_product_image_is_thumbnail ON public.product_image(is_thumbnail);

-- Tối ưu điều hướng nút bấm IoT
CREATE UNIQUE INDEX IF NOT EXISTS idx_iot_button_device_id ON public.iot_button(device_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_iot_button_code ON public.iot_button(button_code);
CREATE INDEX IF NOT EXISTS idx_iot_button_store_id ON public.iot_button(store_id);
CREATE INDEX IF NOT EXISTS idx_iot_button_customer_id ON public.iot_button(customer_id);

-- Tối ưu đơn hàng & thanh toán
CREATE INDEX IF NOT EXISTS idx_orders_store_status ON public.orders(store_id, status);
CREATE INDEX IF NOT EXISTS idx_orders_customer_id ON public.orders(customer_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_tx_code ON public.payment_transaction(transaction_code);
CREATE INDEX IF NOT EXISTS idx_payment_tx_order_id ON public.payment_transaction(order_id);

-- Tối ưu sổ cái ví & rút tiền
CREATE INDEX IF NOT EXISTS idx_wallet_tx_wallet_id ON public.wallet_transactions(wallet_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_withdrawals_wallet_status ON public.store_withdrawals(wallet_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_withdrawals_ref_id ON public.store_withdrawals(provider_reference_id);

-- Hoàn tất giao dịch DDL
COMMIT;
