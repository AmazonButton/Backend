-- ============================================================================
-- SMART ORDER BUTTON (BRD V2.3) — SUPABASE POSTGRESQL MIGRATION
-- File: supabase_migration_v2_3_payos_payout.sql
-- M?c dích: Nâng c?p b?ng store_withdrawals & payment_transaction d? tích h?p
--           hoàn ch?nh h? th?ng Thu - Chi t? d?ng qua PayOS Payout API:
--           1. Thêm các tru?ng Snapshot ngân hàng & tracking PayOS Payout.
--           2. C?p nh?t Check Constraints cho payment_transaction (h? tr? PAID, QR).
--           3. Ð?m b?o tính Idempotency và Unique Constraint cho provider_reference_id.
-- ============================================================================

BEGIN;

-- 1. B? sung các c?t ph?c v? Kênh Chi PayOS Payout vào b?ng store_withdrawals
ALTER TABLE IF EXISTS public.store_withdrawals 
    ADD COLUMN IF NOT EXISTS bank_code VARCHAR(20),
    ADD COLUMN IF NOT EXISTS fee DECIMAL(15, 2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS net_amount DECIMAL(15, 2),
    ADD COLUMN IF NOT EXISTS provider VARCHAR(50) NOT NULL DEFAULT 'PAYOS',
    ADD COLUMN IF NOT EXISTS provider_payout_id VARCHAR(100),
    ADD COLUMN IF NOT EXISTS provider_reference_id VARCHAR(100),
    ADD COLUMN IF NOT EXISTS failure_reason TEXT;

-- 2. Ð?t Unique Index trên provider_reference_id d? d?m b?o Idempotency tuy?t d?i
CREATE UNIQUE INDEX IF NOT EXISTS uq_store_withdrawals_provider_ref 
    ON public.store_withdrawals(provider_reference_id) 
    WHERE provider_reference_id IS NOT NULL;

-- 3. T?o Index t?i uu tra c?u Payout Id
CREATE INDEX IF NOT EXISTS idx_store_withdrawals_provider_payout_id 
    ON public.store_withdrawals(provider_payout_id) 
    WHERE provider_payout_id IS NOT NULL;

-- 4. Thêm chú thích c?t cho vi?c ki?m toán và tài li?u
COMMENT ON COLUMN public.store_withdrawals.bank_code IS 'Mã BIN ngân hàng th? hu?ng (ví d?: 970422 cho MBBank)';
COMMENT ON COLUMN public.store_withdrawals.fee IS 'Phí rút ti?n h? th?ng tr? (m?c d?nh 0 VND)';
COMMENT ON COLUMN public.store_withdrawals.net_amount IS 'S? ti?n th?c t? gi?i ngân t?i ngân hàng (amount - fee)';
COMMENT ON COLUMN public.store_withdrawals.provider IS 'C?ng chi tr? ti?n (PAYOS ho?c MANUAL)';
COMMENT ON COLUMN public.store_withdrawals.provider_payout_id IS 'Mã d?nh danh Payout do PayOS API tr? v?';
COMMENT ON COLUMN public.store_withdrawals.provider_reference_id IS 'Mã tham chi?u d?i soát duy nh?t g?i sang PayOS (idempotency key)';
COMMENT ON COLUMN public.store_withdrawals.failure_reason IS 'Nguyên nhân chi ti?n th?t b?i t? PayOS n?u b? t? ch?i';

-- 5. C?p nh?t check constraint cho payment_transaction d? tuong thích PayOS Webhook
ALTER TABLE IF EXISTS public.payment_transaction 
    DROP CONSTRAINT IF EXISTS payment_transaction_status_check;

ALTER TABLE IF EXISTS public.payment_transaction 
    ADD CONSTRAINT payment_transaction_status_check 
    CHECK (status IN ('PENDING', 'SUCCESS', 'PAID', 'FAILED', 'CANCELLED', 'EXPIRED'));

ALTER TABLE IF EXISTS public.payment_transaction 
    DROP CONSTRAINT IF EXISTS payment_transaction_payment_method_check;

ALTER TABLE IF EXISTS public.payment_transaction 
    ADD CONSTRAINT payment_transaction_payment_method_check 
    CHECK (payment_method IN ('COD', 'PAYOS', 'QR', 'BANK_TRANSFER'));

COMMIT;
