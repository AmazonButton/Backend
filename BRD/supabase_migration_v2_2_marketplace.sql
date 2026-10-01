-- ============================================================================
-- SMART ORDER BUTTON PLATFORM (BRD V2.2) — SUPABASE POSTGRESQL MIGRATION
-- File: supabase_migration_v2_2_marketplace.sql
-- Mục đích: Kích hoạt toàn bộ mô hình Sàn thương mại điện tử IoT, bao gồm:
--   1. Gói cước thuê gian hàng cho Chủ Shop (Store Listing Subscriptions)
--   2. Gói cước thuê nút bấm IoT định kỳ cho Khách hàng (Customer Button Rentals)
--   3. Ví số dư Cửa hàng & Đối soát Escrow đơn hàng (Store Wallets & Ledger)
--   4. Quản lý yêu cầu rút tiền về tài khoản ngân hàng (Store Withdrawals)
-- Hướng dẫn: Copy toàn bộ nội dung file này vào Supabase SQL Editor và nhấn Run.
-- ============================================================================

BEGIN;

-- ============================================================================
-- PHẦN 1: GÓI CƯỚC GIAN HÀNG & HỢP ĐỒNG THUÊ SÀN CỦA SHOP
-- ============================================================================

-- Bảng danh mục gói cước do Super Admin quản lý
CREATE TABLE IF NOT EXISTS public.subscription_plans (
    plan_id BIGSERIAL PRIMARY KEY,
    plan_code VARCHAR(50) NOT NULL UNIQUE,
    plan_name VARCHAR(150) NOT NULL,
    description TEXT,
    price DECIMAL(15, 2) NOT NULL,
    duration_days INT NOT NULL,
    max_products INT NOT NULL DEFAULT 50,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.subscription_plans IS 'Bảng cấu hình các gói cước thuê gian hàng định kỳ trên sàn (SaaS Listing Plans)';
COMMENT ON COLUMN public.subscription_plans.plan_code IS 'Mã định danh duy nhất của gói (vd: BASIC_30D, PRO_90D)';
COMMENT ON COLUMN public.subscription_plans.duration_days IS 'Thời hạn sử dụng của gói (30, 90, 365 ngày)';
COMMENT ON COLUMN public.subscription_plans.max_products IS 'Số lượng sản phẩm tối đa được đăng bán trong thời gian thuê';

-- Bảng ghi nhận hợp đồng thuê gian hàng của từng Store
CREATE TABLE IF NOT EXISTS public.store_subscriptions (
    subscription_id BIGSERIAL PRIMARY KEY,
    store_id BIGINT NOT NULL,
    plan_id BIGINT NOT NULL,
    start_date TIMESTAMPTZ NOT NULL,
    end_date TIMESTAMPTZ NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    payment_method VARCHAR(20) NOT NULL DEFAULT 'PAYOS',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_store_subscriptions_store
        FOREIGN KEY (store_id)
        REFERENCES public.store(store_id)
        ON DELETE RESTRICT,

    CONSTRAINT fk_store_subscriptions_plan
        FOREIGN KEY (plan_id)
        REFERENCES public.subscription_plans(plan_id)
        ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_store_subscriptions_store_id ON public.store_subscriptions(store_id);
CREATE INDEX IF NOT EXISTS idx_store_subscriptions_status ON public.store_subscriptions(status);

COMMENT ON TABLE public.store_subscriptions IS 'Hợp đồng đăng ký gói thuê gian hàng của cửa hàng';
COMMENT ON COLUMN public.store_subscriptions.status IS 'Trạng thái: ACTIVE (đang hiệu lực), EXPIRED (hết hạn), CANCELLED (hủy)';


-- ============================================================================
-- PHẦN 2: GÓI THUÊ NÚT IOT ĐỊNH KỲ CHO KHÁCH HÀNG & GÁN PHẦN CỨNG
-- ============================================================================

-- Bảng các gói cước thuê phần cứng do Admin cấu hình
CREATE TABLE IF NOT EXISTS public.rental_packages (
    package_id BIGSERIAL PRIMARY KEY,
    package_code VARCHAR(50) NOT NULL UNIQUE,
    package_name VARCHAR(150) NOT NULL,
    description TEXT,
    button_quantity INT NOT NULL DEFAULT 1,
    monthly_price DECIMAL(15, 2) NOT NULL,
    deposit_fee DECIMAL(15, 2) NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.rental_packages IS 'Cấu hình các gói thuê nút bấm IoT (1 nút lẻ hoặc Bộ Kit 3 nút) kèm giá thuê và tiền cọc';
COMMENT ON COLUMN public.rental_packages.button_quantity IS 'Số lượng nút vật lý được cung cấp trong gói (1 hoặc 3)';
COMMENT ON COLUMN public.rental_packages.monthly_price IS 'Giá tiền thuê hàng tháng (VND, ví dụ 50,000 VND)';
COMMENT ON COLUMN public.rental_packages.deposit_fee IS 'Tiền cọc phần cứng (hoàn lại khi trả thiết bị)';

-- Bảng hợp đồng thuê nút của khách hàng cuối
CREATE TABLE IF NOT EXISTS public.button_rentals (
    rental_id BIGSERIAL PRIMARY KEY,
    rental_code VARCHAR(50) NOT NULL UNIQUE,
    customer_id BIGINT NOT NULL,
    package_id BIGINT NOT NULL,
    months_rented INT NOT NULL DEFAULT 1,
    total_rent_amount DECIMAL(15, 2) NOT NULL,
    deposit_amount DECIMAL(15, 2) NOT NULL DEFAULT 0,
    start_date TIMESTAMPTZ NOT NULL,
    end_date TIMESTAMPTZ NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING_PAYMENT',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_button_rentals_customer
        FOREIGN KEY (customer_id)
        REFERENCES public.customer_profile(customer_id)
        ON DELETE RESTRICT,

    CONSTRAINT fk_button_rentals_package
        FOREIGN KEY (package_id)
        REFERENCES public.rental_packages(package_id)
        ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_button_rentals_customer_id ON public.button_rentals(customer_id);
CREATE INDEX IF NOT EXISTS idx_button_rentals_status ON public.button_rentals(status);

-- Bổ sung cột rental_id vào iot_button để gán nút vật lý vào hợp đồng thuê
ALTER TABLE public.iot_button 
    ADD COLUMN IF NOT EXISTS rental_id BIGINT;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints 
        WHERE constraint_name = 'fk_iot_button_rental' AND table_name = 'iot_button'
    ) THEN
        ALTER TABLE public.iot_button 
            ADD CONSTRAINT fk_iot_button_rental 
            FOREIGN KEY (rental_id) 
            REFERENCES public.button_rentals(rental_id) 
            ON DELETE SET NULL;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_iot_button_rental_id ON public.iot_button(rental_id);


-- ============================================================================
-- PHẦN 3: VÍ SỐ DƯ CỬA HÀNG (STORE WALLETS) & SỔ CÁI ĐỐI SOÁT (LEDGER)
-- ============================================================================

-- Bảng ví nội bộ của từng cửa hàng
CREATE TABLE IF NOT EXISTS public.store_wallets (
    wallet_id BIGSERIAL PRIMARY KEY,
    store_id BIGINT NOT NULL UNIQUE,
    balance DECIMAL(15, 2) NOT NULL DEFAULT 0,
    frozen_balance DECIMAL(15, 2) NOT NULL DEFAULT 0,
    bank_name VARCHAR(100),
    bank_account_number VARCHAR(50),
    bank_account_holder VARCHAR(150),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_store_wallets_store
        FOREIGN KEY (store_id)
        REFERENCES public.store(store_id)
        ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_store_wallets_store_id ON public.store_wallets(store_id);

COMMENT ON TABLE public.store_wallets IS 'Ví số dư nội bộ của Cửa hàng, tích lũy tiền bán hàng và yêu cầu rút';
COMMENT ON COLUMN public.store_wallets.balance IS 'Số dư khả dụng có thể rút hoặc dùng thanh toán gói cước';
COMMENT ON COLUMN public.store_wallets.frozen_balance IS 'Số dư tạm giữ chờ đối soát đơn hàng';

-- Bảng sổ cái biến động số dư bất biến
CREATE TABLE IF NOT EXISTS public.wallet_transactions (
    transaction_id BIGSERIAL PRIMARY KEY,
    wallet_id BIGINT NOT NULL,
    amount DECIMAL(15, 2) NOT NULL,
    type VARCHAR(30) NOT NULL,
    balance_before DECIMAL(15, 2) NOT NULL,
    balance_after DECIMAL(15, 2) NOT NULL,
    reference_id VARCHAR(100),
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_wallet_transactions_wallet
        FOREIGN KEY (wallet_id)
        REFERENCES public.store_wallets(wallet_id)
        ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_wallet_transactions_wallet_id ON public.wallet_transactions(wallet_id);
CREATE INDEX IF NOT EXISTS idx_wallet_transactions_type ON public.wallet_transactions(type);

COMMENT ON TABLE public.wallet_transactions IS 'Lịch sử biến động số dư bất biến (ORDER_REVENUE, WITHDRAWAL, SUBSCRIPTION_PAYMENT, REFUND)';


-- ============================================================================
-- PHẦN 4: QUẢN LÝ YÊU CẦU RÚT TIỀN (STORE WITHDRAWALS)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.store_withdrawals (
    withdrawal_id BIGSERIAL PRIMARY KEY,
    withdrawal_code VARCHAR(50) NOT NULL UNIQUE,
    wallet_id BIGINT NOT NULL,
    amount DECIMAL(15, 2) NOT NULL,
    bank_name VARCHAR(100) NOT NULL,
    bank_account_number VARCHAR(50) NOT NULL,
    bank_account_holder VARCHAR(150) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    approved_by_user_id BIGINT,
    rejection_reason TEXT,
    transfer_evidence_url TEXT,
    requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_store_withdrawals_wallet
        FOREIGN KEY (wallet_id)
        REFERENCES public.store_wallets(wallet_id)
        ON DELETE CASCADE,

    CONSTRAINT fk_store_withdrawals_approved_by
        FOREIGN KEY (approved_by_user_id)
        REFERENCES public.users(user_id)
        ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_store_withdrawals_wallet_id ON public.store_withdrawals(wallet_id);
CREATE INDEX IF NOT EXISTS idx_store_withdrawals_status ON public.store_withdrawals(status);

COMMENT ON TABLE public.store_withdrawals IS 'Danh sách yêu cầu rút tiền từ ví của cửa hàng về tài khoản ngân hàng thực tế';


-- ============================================================================
-- PHẦN 5: DỮ LIỆU KHỞI TẠO MẪU (SEED DATA CHO HỆ THỐNG)
-- ============================================================================

-- Seed các gói cước gian hàng chuẩn
INSERT INTO public.subscription_plans (plan_code, plan_name, description, price, duration_days, max_products, is_active)
VALUES
    ('BASIC_30D', 'Gói Khởi Động (30 Ngày)', 'Phù hợp cửa hàng mới tham gia, tối đa 30 sản phẩm', 150000.00, 30, 30, TRUE),
    ('PRO_90D', 'Gói Tiêu Chuẩn (90 Ngày)', 'Tiết kiệm chi phí, tối đa 100 sản phẩm, ưu tiên hiển thị', 390000.00, 90, 100, TRUE),
    ('ENTERPRISE_365D', 'Gói Doanh Nghiệp (1 Năm)', 'Không giới hạn sản phẩm, hỗ trợ kỹ thuật riêng 24/7', 1200000.00, 365, 500, TRUE)
ON CONFLICT (plan_code) DO NOTHING;

-- Seed các gói thuê nút IoT thông minh
INSERT INTO public.rental_packages (package_code, package_name, description, button_quantity, monthly_price, deposit_fee, is_active)
VALUES
    ('SINGLE_BUTTON_1M', 'Gói Nút Đơn Lẻ (50k/Tháng)', 'Thuê 1 nút bấm IoT thông minh giao tận nơi', 1, 50000.00, 100000.00, TRUE),
    ('KIT_3_BUTTONS_1M', 'Bộ Kit 3 Nút Bấm Tiện Lợi (120k/Tháng)', 'Combo 3 nút bấm IoT cho 3 vị trí (bếp, phòng khách, kho)', 3, 120000.00, 250000.00, TRUE)
ON CONFLICT (package_code) DO NOTHING;

-- Tự động tạo ví cho các Store hiện hữu nếu chưa có ví
INSERT INTO public.store_wallets (store_id, balance, frozen_balance)
SELECT store_id, 0, 0 
FROM public.store s
WHERE NOT EXISTS (
    SELECT 1 FROM public.store_wallets w WHERE w.store_id = s.store_id
)
ON CONFLICT (store_id) DO NOTHING;

COMMIT;

-- ============================================================================
-- TRUY VẤN KIỂM TRA NHANH KẾT QUẢ MIGRATION (SANITY CHECK)
-- ============================================================================
-- Chạy các lệnh dưới đây để kiểm tra dữ liệu sau khi chạy file script:
-- 1. Kiểm tra 7 bảng mới đã tạo thành công:
--    SELECT table_name FROM information_schema.tables 
--    WHERE table_name IN ('subscription_plans', 'store_subscriptions', 'rental_packages', 'button_rentals', 'store_wallets', 'wallet_transactions', 'store_withdrawals');
--
-- 2. Kiểm tra các gói cước đã seed:
--    SELECT plan_code, plan_name, price, duration_days FROM public.subscription_plans;
--
-- 3. Kiểm tra các gói thuê nút đã seed:
--    SELECT package_code, package_name, button_quantity, monthly_price, deposit_fee FROM public.rental_packages;
--
-- 4. Kiểm tra ví của các cửa hàng:
--    SELECT wallet_id, store_id, balance FROM public.store_wallets;
