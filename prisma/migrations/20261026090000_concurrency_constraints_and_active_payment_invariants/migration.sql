-- Concurrency Control & Database Invariants (CC-01 & ADR-1)

-- 1. Partial unique index: At most one active PENDING or PAID payment transaction per order
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_active_per_order
ON payment_transaction(order_id)
WHERE status IN ('PENDING', 'PAID') AND order_id IS NOT NULL;

-- 2. Partial unique index: At most one active PENDING or PAID payment transaction per rental
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_active_per_rental
ON payment_transaction(rental_id)
WHERE status IN ('PENDING', 'PAID') AND rental_id IS NOT NULL;

-- 3. Unique transaction code index on non-null values
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_transaction_code
ON payment_transaction(transaction_code)
WHERE transaction_code IS NOT NULL;

-- 4. Partial unique index: At most one default bank account per store
CREATE UNIQUE INDEX IF NOT EXISTS uq_default_bank_account_per_store
ON store_bank_accounts(store_id)
WHERE is_default = true;

-- 5. Non-negative balances check constraint on store_wallets
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_store_wallets_non_negative_balance'
  ) THEN
    ALTER TABLE store_wallets ADD CONSTRAINT chk_store_wallets_non_negative_balance CHECK (balance >= 0 AND frozen_balance >= 0);
  END IF;
END $$;
