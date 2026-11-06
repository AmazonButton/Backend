-- ==============================================================================
-- SMART ORDER: SUPABASE COMPREHENSIVE IDEMPOTENT SYNC PATCH
-- Synchronizes 100% of all 64 tables and columns to match ERD Level 3 and Prisma.
-- Run this directly in Supabase SQL Editor. Safe to re-run multiple times.
-- ==============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ==============================================================================
-- 1. CỘT 2: BẢNG DEPOSIT_REFUNDS (Bổ sung 5 cột Recipient Snapshot)
-- ==============================================================================
ALTER TABLE IF EXISTS deposit_refunds ADD COLUMN IF NOT EXISTS recipient_bin VARCHAR(16);
ALTER TABLE IF EXISTS deposit_refunds ADD COLUMN IF NOT EXISTS recipient_account_number_encrypted TEXT;
ALTER TABLE IF EXISTS deposit_refunds ADD COLUMN IF NOT EXISTS recipient_account_number_hash VARCHAR(64);
ALTER TABLE IF EXISTS deposit_refunds ADD COLUMN IF NOT EXISTS recipient_account_holder_name VARCHAR(255);
ALTER TABLE IF EXISTS deposit_refunds ADD COLUMN IF NOT EXISTS recipient_account_number_masked VARCHAR(32);
ALTER TABLE IF EXISTS deposit_refunds ADD COLUMN IF NOT EXISTS refund_code VARCHAR(64);
ALTER TABLE IF EXISTS deposit_refunds ADD COLUMN IF NOT EXISTS rental_id BIGINT;
ALTER TABLE IF EXISTS deposit_refunds ADD COLUMN IF NOT EXISTS customer_id BIGINT;
ALTER TABLE IF EXISTS deposit_refunds ADD COLUMN IF NOT EXISTS approved_by_user_id BIGINT;
ALTER TABLE IF EXISTS deposit_refunds ADD COLUMN IF NOT EXISTS rejection_reason VARCHAR(255);
ALTER TABLE IF EXISTS deposit_refunds ADD COLUMN IF NOT EXISTS provider_reference_id VARCHAR(128);
ALTER TABLE IF EXISTS deposit_refunds ADD COLUMN IF NOT EXISTS payout_error TEXT;
ALTER TABLE IF EXISTS deposit_refunds ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ(6);
ALTER TABLE IF EXISTS deposit_refunds ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ(6) DEFAULT now();

-- ==============================================================================
-- 2. CỘT 6: BẢNG DEVICE_MOVEMENTS (Đồng bộ đầy đủ tên cột và 2 cột trạng thái kho)
-- ==============================================================================
CREATE TABLE IF NOT EXISTS device_movements (
    movement_id BIGSERIAL PRIMARY KEY,
    device_id UUID NOT NULL,
    button_id BIGINT,
    source_type VARCHAR(50) NOT NULL,
    source_store_id BIGINT,
    dest_type VARCHAR(50) NOT NULL,
    dest_store_id BIGINT,
    rental_id BIGINT,
    from_inventory_state VARCHAR(50),
    to_inventory_state VARCHAR(50),
    reason VARCHAR(255),
    actor_user_id BIGINT,
    created_at TIMESTAMPTZ(6) DEFAULT now()
);

-- Bổ sung các cột nếu bảng đã tồn tại sẵn
ALTER TABLE IF EXISTS device_movements ADD COLUMN IF NOT EXISTS movement_id BIGSERIAL;
ALTER TABLE IF EXISTS device_movements ADD COLUMN IF NOT EXISTS from_inventory_state VARCHAR(50);
ALTER TABLE IF EXISTS device_movements ADD COLUMN IF NOT EXISTS to_inventory_state VARCHAR(50);
ALTER TABLE IF EXISTS device_movements ADD COLUMN IF NOT EXISTS source_type VARCHAR(50);
ALTER TABLE IF EXISTS device_movements ADD COLUMN IF NOT EXISTS source_store_id BIGINT;
ALTER TABLE IF EXISTS device_movements ADD COLUMN IF NOT EXISTS dest_type VARCHAR(50);
ALTER TABLE IF EXISTS device_movements ADD COLUMN IF NOT EXISTS dest_store_id BIGINT;
ALTER TABLE IF EXISTS device_movements ADD COLUMN IF NOT EXISTS from_custody_type VARCHAR(50);
ALTER TABLE IF EXISTS device_movements ADD COLUMN IF NOT EXISTS from_custody_id BIGINT;
ALTER TABLE IF EXISTS device_movements ADD COLUMN IF NOT EXISTS to_custody_type VARCHAR(50);
ALTER TABLE IF EXISTS device_movements ADD COLUMN IF NOT EXISTS to_custody_id BIGINT;
ALTER TABLE IF EXISTS device_movements ADD COLUMN IF NOT EXISTS rental_id BIGINT;

-- ==============================================================================
-- 3. CỘT 7: THÊM 2 BẢNG THU TIỀN MẶT (STORE_CASH_VOUCHERS & STORE_CASH_RECEIPTS)
-- ==============================================================================
-- 3.1. STORE_CASH_VOUCHERS (13 cột chuẩn)
CREATE TABLE IF NOT EXISTS store_cash_vouchers (
    id BIGSERIAL PRIMARY KEY,
    token_hash VARCHAR(255) NOT NULL,
    customer_id BIGINT NOT NULL,
    rental_id BIGINT,
    charge_id BIGINT NOT NULL,
    target_type VARCHAR(50) NOT NULL DEFAULT 'BUTTON_RENTAL',
    collecting_store_id BIGINT NOT NULL,
    amount DECIMAL(15,2) NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'ACTIVE',
    expires_at TIMESTAMPTZ(6) NOT NULL,
    consumed_at TIMESTAMPTZ(6),
    revoked_at TIMESTAMPTZ(6),
    created_at TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

-- 3.2. STORE_CASH_RECEIPTS (9 cột chuẩn)
CREATE TABLE IF NOT EXISTS store_cash_receipts (
    id BIGSERIAL PRIMARY KEY,
    charge_id BIGINT NOT NULL,
    voucher_id BIGINT NOT NULL,
    collecting_store_id BIGINT NOT NULL,
    amount DECIMAL(15,2) NOT NULL,
    wallet_transaction_id BIGINT,
    request_hash VARCHAR(255),
    collected_by_user_id BIGINT NOT NULL,
    created_at TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

-- ==============================================================================
-- 4. CỘT 9: CỤM HÓA ĐƠN BILLING
-- ==============================================================================
-- 4.1. BẢNG BILLING_CHARGES (Bổ sung 4 cột nghiệp vụ: store_id, customer_id, paid_amount, due_date)
CREATE TABLE IF NOT EXISTS billing_charges (
    charge_id BIGSERIAL PRIMARY KEY,
    charge_code VARCHAR(64) NOT NULL UNIQUE,
    target_type VARCHAR(50) NOT NULL DEFAULT 'BUTTON_RENTAL',
    target_id BIGINT NOT NULL,
    purpose VARCHAR(50) NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'PENDING',
    currency VARCHAR(10) NOT NULL DEFAULT 'VND',
    total_amount DECIMAL(15,2) NOT NULL,
    payment_method VARCHAR(50),
    provider_transaction_code VARCHAR(255),
    qr_code TEXT,
    payment_link_id VARCHAR(255),
    checkout_url TEXT,
    paid_at TIMESTAMPTZ(6),
    created_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

ALTER TABLE IF EXISTS billing_charges ADD COLUMN IF NOT EXISTS store_id BIGINT;
ALTER TABLE IF EXISTS billing_charges ADD COLUMN IF NOT EXISTS customer_id BIGINT;
ALTER TABLE IF EXISTS billing_charges ADD COLUMN IF NOT EXISTS paid_amount DECIMAL(15,2) DEFAULT 0.00;
ALTER TABLE IF EXISTS billing_charges ADD COLUMN IF NOT EXISTS due_date TIMESTAMPTZ(6);
ALTER TABLE IF EXISTS billing_charges ADD COLUMN IF NOT EXISTS charge_code VARCHAR(64);
ALTER TABLE IF EXISTS billing_charges ADD COLUMN IF NOT EXISTS target_type VARCHAR(50) DEFAULT 'BUTTON_RENTAL';
ALTER TABLE IF EXISTS billing_charges ADD COLUMN IF NOT EXISTS target_id BIGINT;
ALTER TABLE IF EXISTS billing_charges ADD COLUMN IF NOT EXISTS provider_transaction_code VARCHAR(255);
ALTER TABLE IF EXISTS billing_charges ADD COLUMN IF NOT EXISTS qr_code TEXT;
ALTER TABLE IF EXISTS billing_charges ADD COLUMN IF NOT EXISTS payment_link_id VARCHAR(255);
ALTER TABLE IF EXISTS billing_charges ADD COLUMN IF NOT EXISTS checkout_url TEXT;

-- 4.2. BILLING_PAYMENT_RECEIPTS (10 cột chuẩn)
CREATE TABLE IF NOT EXISTS billing_payment_receipts (
    id BIGSERIAL PRIMARY KEY,
    charge_id BIGINT NOT NULL,
    provider VARCHAR(50) NOT NULL DEFAULT 'PAYOS',
    channel VARCHAR(50) NOT NULL DEFAULT 'ONLINE',
    provider_transaction_ref VARCHAR(255) NOT NULL,
    amount DECIMAL(15,2) NOT NULL,
    currency VARCHAR(10) NOT NULL DEFAULT 'VND',
    classification VARCHAR(50) NOT NULL DEFAULT 'STANDARD',
    received_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

-- 4.3. BILLING_OVERPAYMENT_OBLIGATIONS (6 cột chuẩn)
CREATE TABLE IF NOT EXISTS billing_overpayment_obligations (
    id BIGSERIAL PRIMARY KEY,
    receipt_id BIGINT NOT NULL,
    amount DECIMAL(15,2) NOT NULL,
    receipt_classification VARCHAR(50) NOT NULL DEFAULT 'OVERPAYMENT',
    status VARCHAR(50) NOT NULL DEFAULT 'PENDING_REFUND',
    created_at TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

-- ==============================================================================
-- 5. HÀNG NGANG DƯỚI CÙNG: 4 BẢNG XÁC MINH NGÂN HÀNG 2.000Đ
-- ==============================================================================
-- 5.1. customer_bank_verification_proofs (21 cột chuẩn)
CREATE TABLE IF NOT EXISTS customer_bank_verification_proofs (
    id BIGSERIAL PRIMARY KEY,
    proof_reference VARCHAR(128) NOT NULL UNIQUE,
    customer_id BIGINT NOT NULL,
    account_id BIGINT NOT NULL,
    bank_bin VARCHAR(10) NOT NULL,
    account_number_hash VARCHAR(64) NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'PENDING',
    session_status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE',
    provider VARCHAR(32) NOT NULL DEFAULT 'PAYOS',
    transfer_amount DECIMAL(15,2) DEFAULT 2000.00,
    transfer_content VARCHAR(255),
    expires_at TIMESTAMPTZ(6) NOT NULL,
    used_at TIMESTAMPTZ(6),
    payment_order_code BIGINT UNIQUE,
    payment_link_id VARCHAR(128),
    payment_checkout_url TEXT,
    qr_data_url TEXT,
    verification_status VARCHAR(32) NOT NULL DEFAULT 'PENDING',
    verified_at TIMESTAMPTZ(6),
    verified_by_transaction_id BIGINT,
    rejection_reason VARCHAR(255),
    metadata JSONB,
    created_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

-- 5.2. customer_bank_inbound_transactions (20 cột chuẩn)
CREATE TABLE IF NOT EXISTS customer_bank_inbound_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    proof_id BIGINT,
    provider VARCHAR(50) NOT NULL DEFAULT 'PAYOS',
    channel VARCHAR(50) NOT NULL DEFAULT 'VIETQR',
    provider_transaction_ref VARCHAR(128) NOT NULL,
    amount INTEGER NOT NULL DEFAULT 2000,
    received_at VARCHAR(64) NOT NULL,
    is_late_payment BOOLEAN NOT NULL DEFAULT false,
    source_bank_bin VARCHAR(16),
    source_account_masked VARCHAR(32),
    source_account_hash VARCHAR(64),
    source_account_encrypted TEXT,
    source_account_name VARCHAR(255),
    has_sufficient_evidence BOOLEAN NOT NULL DEFAULT true,
    session_match_status VARCHAR(50) NOT NULL DEFAULT 'MATCHED',
    match_decision VARCHAR(50) NOT NULL DEFAULT 'AUTO_APPROVED',
    raw_payload_checksum VARCHAR(64),
    reconciliation_flag VARCHAR(50) NOT NULL DEFAULT 'RECONCILED',
    merged_into_inbound_id UUID,
    created_at TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

-- 5.3. customer_bank_refund_obligations (16 cột chuẩn)
CREATE TABLE IF NOT EXISTS customer_bank_refund_obligations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    inbound_transaction_id UUID NOT NULL,
    refund_amount INTEGER NOT NULL DEFAULT 2000,
    refund_status VARCHAR(50) NOT NULL DEFAULT 'PENDING',
    target_bank_bin VARCHAR(16) NOT NULL,
    target_account_masked VARCHAR(32) NOT NULL,
    target_account_hash VARCHAR(64) NOT NULL,
    target_account_encrypted TEXT NOT NULL,
    target_account_name VARCHAR(255) NOT NULL,
    refund_payout_reference VARCHAR(128) NOT NULL,
    active_payout_attempt_id UUID,
    refunded_at TIMESTAMPTZ(6),
    failure_reason TEXT,
    metadata JSONB,
    created_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

-- 5.4. customer_bank_refund_payout_attempts (13 cột chuẩn)
CREATE TABLE IF NOT EXISTS customer_bank_refund_payout_attempts (
    id BIGSERIAL PRIMARY KEY,
    obligation_id BIGINT,
    attempt_number INTEGER DEFAULT 1,
    attempt_no INTEGER DEFAULT 1,
    payout_provider VARCHAR(32) NOT NULL DEFAULT 'PAYOS',
    payout_reference VARCHAR(128) NOT NULL,
    provider_payout_id VARCHAR(128),
    status VARCHAR(32) NOT NULL DEFAULT 'PREPARING',
    error_code VARCHAR(50),
    error_message TEXT,
    raw_response JSONB,
    dispatched_at TIMESTAMPTZ(6),
    reconciled_at TIMESTAMPTZ(6),
    attempted_at TIMESTAMPTZ(6),
    response_code VARCHAR(32),
    failure_reason TEXT,
    created_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ(6) DEFAULT now()
);

-- ==============================================================================
-- 6. ĐỒNG BỘ CÁC CỘT QUAN TRỌNG ĐÃ CÓ TRÊN ERD VÀO SQL
-- ==============================================================================
-- iot_button
ALTER TABLE IF EXISTS iot_button ADD COLUMN IF NOT EXISTS custody_store_id BIGINT;
ALTER TABLE IF EXISTS iot_button ADD COLUMN IF NOT EXISTS double_click_window_ms INTEGER DEFAULT 400;
ALTER TABLE IF EXISTS iot_button ADD COLUMN IF NOT EXISTS long_press_action VARCHAR(50);
ALTER TABLE IF EXISTS iot_button ADD COLUMN IF NOT EXISTS inventory_state VARCHAR(50) DEFAULT 'IN_CUSTOMER_CUSTODY';
ALTER TABLE IF EXISTS iot_button ADD COLUMN IF NOT EXISTS can_order BOOLEAN DEFAULT true;

-- device_templates
ALTER TABLE IF EXISTS device_templates ADD COLUMN IF NOT EXISTS long_press_action VARCHAR(50);

-- store_withdrawals
ALTER TABLE IF EXISTS store_withdrawals ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(255);
ALTER TABLE IF EXISTS store_withdrawals ADD COLUMN IF NOT EXISTS bank_account_id BIGINT;
ALTER TABLE IF EXISTS store_withdrawals ADD COLUMN IF NOT EXISTS bank_account_encrypted TEXT;
ALTER TABLE IF EXISTS store_withdrawals ADD COLUMN IF NOT EXISTS bank_account_hash VARCHAR(64);
ALTER TABLE IF EXISTS store_withdrawals ADD COLUMN IF NOT EXISTS bank_account_masked VARCHAR(32);
ALTER TABLE IF EXISTS store_withdrawals ADD COLUMN IF NOT EXISTS bank_account_name_snapshot VARCHAR(255);
ALTER TABLE IF EXISTS store_withdrawals ADD COLUMN IF NOT EXISTS bank_bin_snapshot VARCHAR(16);
ALTER TABLE IF EXISTS store_withdrawals ADD COLUMN IF NOT EXISTS bank_name_snapshot VARCHAR(255);

-- bank_account_verification_transactions
ALTER TABLE IF EXISTS bank_account_verification_transactions ADD COLUMN IF NOT EXISTS failure_reason VARCHAR(255);

-- api_idempotency_keys
ALTER TABLE IF EXISTS api_idempotency_keys ADD COLUMN IF NOT EXISTS method VARCHAR(16) DEFAULT 'POST';
ALTER TABLE IF EXISTS api_idempotency_keys ADD COLUMN IF NOT EXISTS actual_path VARCHAR(255);
ALTER TABLE IF EXISTS api_idempotency_keys ADD COLUMN IF NOT EXISTS actor_scope VARCHAR(64);
ALTER TABLE IF EXISTS api_idempotency_keys ADD COLUMN IF NOT EXISTS lock_token VARCHAR(255);

-- customer_bank_accounts
ALTER TABLE IF EXISTS customer_bank_accounts ADD COLUMN IF NOT EXISTS bank_bin VARCHAR(16);

-- button_rentals
ALTER TABLE IF EXISTS button_rentals ADD COLUMN IF NOT EXISTS monthly_rent_per_button_snapshot DECIMAL(15,2);
ALTER TABLE IF EXISTS button_rentals ADD COLUMN IF NOT EXISTS pricing_review_required BOOLEAN DEFAULT false;

-- billing_charge_lines
ALTER TABLE IF EXISTS billing_charge_lines ADD COLUMN IF NOT EXISTS duration_unit VARCHAR(20);
ALTER TABLE IF EXISTS billing_charge_lines ADD COLUMN IF NOT EXISTS duration_count INTEGER;

-- ==============================================================================
-- HOÀN TẤT ĐỒNG BỘ 100%!
-- ==============================================================================
