-- ============================================================================
-- DRAW.IO COMPATIBLE SQL DDL SCRIPT (ERD LEVEL 3)
-- Chuẩn hóa cú pháp thuần ANSI SQL tương thích 100% với trình phân tích của Draw.io
-- Hướng dẫn Draw.io: Arrange -> Insert -> Advanced -> SQL (hoặc Paste SQL)
-- ============================================================================

CREATE TABLE roles (
    role_id BIGINT PRIMARY KEY,
    role_code VARCHAR(50) UNIQUE,
    role_name VARCHAR(100),
    description TEXT
);

CREATE TABLE users (
    user_id BIGINT PRIMARY KEY,
    auth_id VARCHAR(36) UNIQUE,
    username VARCHAR(100) UNIQUE,
    email VARCHAR(255) UNIQUE,
    password_hash VARCHAR(255),
    full_name VARCHAR(255),
    phone VARCHAR(20),
    password_reset_token VARCHAR(255),
    password_reset_expires_at TIMESTAMP,
    email_verification_token VARCHAR(255),
    email_verification_expires_at TIMESTAMP,
    status VARCHAR(20),
    created_at TIMESTAMP,
    updated_at TIMESTAMP
);

CREATE TABLE user_roles (
    user_id BIGINT,
    role_id BIGINT,
    assigned_at TIMESTAMP,
    PRIMARY KEY (user_id, role_id),
    FOREIGN KEY (user_id) REFERENCES users(user_id),
    FOREIGN KEY (role_id) REFERENCES roles(role_id)
);

CREATE TABLE refresh_tokens (
    id BIGINT PRIMARY KEY,
    user_id BIGINT,
    token_hash VARCHAR(255) UNIQUE,
    expires_at TIMESTAMP,
    is_revoked BOOLEAN,
    created_at TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(user_id)
);

CREATE TABLE store (
    store_id BIGINT PRIMARY KEY,
    owner_user_id BIGINT,
    name VARCHAR(255),
    code VARCHAR(50) UNIQUE,
    email VARCHAR(255),
    phone VARCHAR(20),
    address TEXT,
    commission_rate DECIMAL(5,2),
    status VARCHAR(20),
    created_at TIMESTAMP,
    updated_at TIMESTAMP,
    FOREIGN KEY (owner_user_id) REFERENCES users(user_id)
);

CREATE TABLE store_staff (
    staff_id BIGINT PRIMARY KEY,
    store_id BIGINT,
    user_id BIGINT,
    role_id BIGINT,
    is_active BOOLEAN,
    created_at TIMESTAMP,
    FOREIGN KEY (store_id) REFERENCES store(store_id),
    FOREIGN KEY (user_id) REFERENCES users(user_id),
    FOREIGN KEY (role_id) REFERENCES roles(role_id)
);

CREATE TABLE customer_profile (
    customer_id BIGINT PRIMARY KEY,
    user_id BIGINT UNIQUE,
    customer_code VARCHAR(50) UNIQUE,
    date_of_birth TIMESTAMP,
    gender VARCHAR(10),
    default_payment_method VARCHAR(20),
    created_at TIMESTAMP,
    updated_at TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(user_id)
);

CREATE TABLE customer_address (
    address_id BIGINT PRIMARY KEY,
    customer_id BIGINT,
    receiver_name VARCHAR(255),
    receiver_phone VARCHAR(20),
    address_line TEXT,
    ward VARCHAR(100),
    district VARCHAR(100),
    city VARCHAR(100),
    is_default BOOLEAN,
    created_at TIMESTAMP,
    updated_at TIMESTAMP,
    FOREIGN KEY (customer_id) REFERENCES customer_profile(customer_id)
);

CREATE TABLE store_customer (
    store_customer_id BIGINT PRIMARY KEY,
    store_id BIGINT,
    customer_id BIGINT,
    loyalty_points INT,
    created_at TIMESTAMP,
    FOREIGN KEY (store_id) REFERENCES store(store_id),
    FOREIGN KEY (customer_id) REFERENCES customer_profile(customer_id)
);

CREATE TABLE category (
    category_id BIGINT PRIMARY KEY,
    store_id BIGINT,
    parent_id BIGINT,
    name VARCHAR(255),
    slug VARCHAR(255),
    is_active BOOLEAN,
    created_at TIMESTAMP,
    updated_at TIMESTAMP,
    FOREIGN KEY (store_id) REFERENCES store(store_id),
    FOREIGN KEY (parent_id) REFERENCES category(category_id)
);

CREATE TABLE product (
    product_id BIGINT PRIMARY KEY,
    store_id BIGINT,
    category_id BIGINT,
    product_code VARCHAR(50),
    product_name VARCHAR(255),
    brand VARCHAR(100),
    description TEXT,
    base_price DECIMAL(15,2),
    status VARCHAR(20),
    created_at TIMESTAMP,
    updated_at TIMESTAMP,
    FOREIGN KEY (store_id) REFERENCES store(store_id),
    FOREIGN KEY (category_id) REFERENCES category(category_id)
);

CREATE TABLE product_image (
    image_id BIGINT PRIMARY KEY,
    product_id BIGINT,
    image_url TEXT,
    is_thumbnail BOOLEAN,
    display_order INT,
    created_at TIMESTAMP,
    updated_at TIMESTAMP,
    FOREIGN KEY (product_id) REFERENCES product(product_id)
);

CREATE TABLE product_price_history (
    history_id BIGINT PRIMARY KEY,
    product_id BIGINT,
    old_price DECIMAL(15,2),
    new_price DECIMAL(15,2),
    changed_by_user_id BIGINT,
    changed_at TIMESTAMP,
    FOREIGN KEY (product_id) REFERENCES product(product_id),
    FOREIGN KEY (changed_by_user_id) REFERENCES users(user_id)
);

CREATE TABLE product_discount (
    discount_id BIGINT PRIMARY KEY,
    product_id BIGINT,
    discount_percent DECIMAL(5,2),
    discount_amount DECIMAL(15,2),
    start_at TIMESTAMP,
    end_at TIMESTAMP,
    status VARCHAR(20),
    created_at TIMESTAMP,
    updated_at TIMESTAMP,
    FOREIGN KEY (product_id) REFERENCES product(product_id)
);

CREATE TABLE inventory (
    inventory_id BIGINT PRIMARY KEY,
    store_id BIGINT,
    product_id BIGINT UNIQUE,
    quantity_on_hand INT,
    reserved_quantity INT,
    min_stock_alert INT,
    updated_at TIMESTAMP,
    FOREIGN KEY (store_id) REFERENCES store(store_id),
    FOREIGN KEY (product_id) REFERENCES product(product_id)
);

CREATE TABLE device_templates (
    template_id BIGINT PRIMARY KEY,
    code VARCHAR(100) UNIQUE,
    name VARCHAR(255),
    description TEXT,
    category VARCHAR(100),
    store_id BIGINT,
    single_press_action VARCHAR(50),
    double_press_action VARCHAR(50),
    default_quantity INT,
    cancel_window_seconds INT,
    created_at TIMESTAMP,
    updated_at TIMESTAMP,
    FOREIGN KEY (store_id) REFERENCES store(store_id)
);

CREATE TABLE rental_packages (
    package_id BIGINT PRIMARY KEY,
    package_code VARCHAR(50) UNIQUE,
    package_name VARCHAR(150),
    button_quantity INT,
    monthly_price DECIMAL(15,2),
    deposit_fee DECIMAL(15,2),
    is_active BOOLEAN,
    created_at TIMESTAMP,
    updated_at TIMESTAMP
);

CREATE TABLE button_rentals (
    rental_id BIGINT PRIMARY KEY,
    rental_code VARCHAR(50) UNIQUE,
    customer_id BIGINT,
    package_id BIGINT,
    months_rented INT,
    total_rent_amount DECIMAL(15,2),
    deposit_amount DECIMAL(15,2),
    start_date TIMESTAMP,
    end_date TIMESTAMP,
    status VARCHAR(20),
    created_at TIMESTAMP,
    updated_at TIMESTAMP,
    FOREIGN KEY (customer_id) REFERENCES customer_profile(customer_id),
    FOREIGN KEY (package_id) REFERENCES rental_packages(package_id)
);

CREATE TABLE iot_button (
    button_id BIGINT PRIMARY KEY,
    device_id VARCHAR(100) UNIQUE,
    button_code VARCHAR(50) UNIQUE,
    customer_id BIGINT,
    store_id BIGINT,
    address_id BIGINT,
    rental_id BIGINT,
    label_name VARCHAR(100),
    status VARCHAR(20),
    last_pressed_at TIMESTAMP,
    created_at TIMESTAMP,
    updated_at TIMESTAMP,
    FOREIGN KEY (customer_id) REFERENCES customer_profile(customer_id),
    FOREIGN KEY (store_id) REFERENCES store(store_id),
    FOREIGN KEY (address_id) REFERENCES customer_address(address_id),
    FOREIGN KEY (rental_id) REFERENCES button_rentals(rental_id)
);

CREATE TABLE button_config_history (
    history_id BIGINT PRIMARY KEY,
    button_id BIGINT,
    old_store_id BIGINT,
    new_store_id BIGINT,
    change_type VARCHAR(50),
    changed_by VARCHAR(50),
    old_config TEXT,
    new_config TEXT,
    changed_at TIMESTAMP,
    FOREIGN KEY (button_id) REFERENCES iot_button(button_id)
);

CREATE TABLE button_product (
    button_product_id BIGINT PRIMARY KEY,
    button_id BIGINT,
    product_id BIGINT,
    quantity INT,
    created_at TIMESTAMP,
    FOREIGN KEY (button_id) REFERENCES iot_button(button_id),
    FOREIGN KEY (product_id) REFERENCES product(product_id)
);

CREATE TABLE orders (
    order_id BIGINT PRIMARY KEY,
    order_code VARCHAR(50) UNIQUE,
    store_id BIGINT,
    customer_id BIGINT,
    button_id BIGINT,
    address_id BIGINT,
    subtotal_amount DECIMAL(15,2),
    discount_amount DECIMAL(15,2),
    shipping_fee DECIMAL(15,2),
    total_amount DECIMAL(15,2),
    commission_rate DECIMAL(5,2),
    commission_amount DECIMAL(15,2),
    net_amount DECIMAL(15,2),
    status VARCHAR(30),
    payment_status VARCHAR(20),
    payment_method VARCHAR(20),
    cancel_reason TEXT,
    created_at TIMESTAMP,
    updated_at TIMESTAMP,
    FOREIGN KEY (store_id) REFERENCES store(store_id),
    FOREIGN KEY (customer_id) REFERENCES customer_profile(customer_id),
    FOREIGN KEY (button_id) REFERENCES iot_button(button_id),
    FOREIGN KEY (address_id) REFERENCES customer_address(address_id)
);

CREATE TABLE order_items (
    item_id BIGINT PRIMARY KEY,
    order_id BIGINT,
    product_id BIGINT,
    product_name_snapshot VARCHAR(255),
    unit_price_snapshot DECIMAL(15,2),
    discount_amount_snapshot DECIMAL(15,2),
    final_unit_price DECIMAL(15,2),
    quantity INT,
    item_subtotal DECIMAL(15,2),
    created_at TIMESTAMP,
    FOREIGN KEY (order_id) REFERENCES orders(order_id),
    FOREIGN KEY (product_id) REFERENCES product(product_id)
);

CREATE TABLE order_status_history (
    history_id BIGINT PRIMARY KEY,
    order_id BIGINT,
    from_status VARCHAR(30),
    to_status VARCHAR(30),
    changed_by_user_id BIGINT,
    reason TEXT,
    changed_at TIMESTAMP,
    FOREIGN KEY (order_id) REFERENCES orders(order_id),
    FOREIGN KEY (changed_by_user_id) REFERENCES users(user_id)
);

CREATE TABLE payment_transaction (
    payment_transaction_id BIGINT PRIMARY KEY,
    order_id BIGINT,
    provider VARCHAR(50),
    transaction_code VARCHAR(100) UNIQUE,
    amount DECIMAL(15,2),
    payment_method VARCHAR(50),
    status VARCHAR(20),
    paid_at TIMESTAMP,
    created_at TIMESTAMP,
    updated_at TIMESTAMP,
    FOREIGN KEY (order_id) REFERENCES orders(order_id)
);

CREATE TABLE subscription_plans (
    plan_id BIGINT PRIMARY KEY,
    plan_code VARCHAR(50) UNIQUE,
    plan_name VARCHAR(150),
    description TEXT,
    price DECIMAL(15,2),
    duration_days INT,
    max_products INT,
    is_active BOOLEAN,
    created_at TIMESTAMP,
    updated_at TIMESTAMP
);

CREATE TABLE store_subscriptions (
    subscription_id BIGINT PRIMARY KEY,
    store_id BIGINT,
    plan_id BIGINT,
    start_date TIMESTAMP,
    end_date TIMESTAMP,
    status VARCHAR(20),
    payment_method VARCHAR(50),
    created_at TIMESTAMP,
    updated_at TIMESTAMP,
    FOREIGN KEY (store_id) REFERENCES store(store_id),
    FOREIGN KEY (plan_id) REFERENCES subscription_plans(plan_id)
);

CREATE TABLE store_wallets (
    wallet_id BIGINT PRIMARY KEY,
    store_id BIGINT UNIQUE,
    balance DECIMAL(15,2),
    frozen_balance DECIMAL(15,2),
    bank_code VARCHAR(20),
    bank_name VARCHAR(100),
    bank_account_number VARCHAR(50),
    bank_account_holder VARCHAR(150),
    created_at TIMESTAMP,
    updated_at TIMESTAMP,
    FOREIGN KEY (store_id) REFERENCES store(store_id)
);

CREATE TABLE wallet_transactions (
    transaction_id BIGINT PRIMARY KEY,
    wallet_id BIGINT,
    amount DECIMAL(15,2),
    type VARCHAR(50),
    balance_before DECIMAL(15,2),
    balance_after DECIMAL(15,2),
    reference_id BIGINT,
    description TEXT,
    created_at TIMESTAMP,
    FOREIGN KEY (wallet_id) REFERENCES store_wallets(wallet_id)
);

CREATE TABLE store_withdrawals (
    withdrawal_id BIGINT PRIMARY KEY,
    withdrawal_code VARCHAR(50) UNIQUE,
    wallet_id BIGINT,
    amount DECIMAL(15,2),
    fee DECIMAL(15,2),
    net_amount DECIMAL(15,2),
    bank_code VARCHAR(20),
    bank_name VARCHAR(100),
    bank_account_number VARCHAR(50),
    bank_account_holder VARCHAR(150),
    status VARCHAR(20),
    provider VARCHAR(50),
    provider_payout_id VARCHAR(100),
    provider_reference_id VARCHAR(100) UNIQUE,
    failure_reason TEXT,
    approved_by_user_id BIGINT,
    requested_at TIMESTAMP,
    processed_at TIMESTAMP,
    FOREIGN KEY (wallet_id) REFERENCES store_wallets(wallet_id),
    FOREIGN KEY (approved_by_user_id) REFERENCES users(user_id)
);
