-- Restore partial unique indexes and wallet non-negative check invariants that may be absent on synced/pushed DBs.
-- Idempotent so both fresh and already-migrated databases apply cleanly.

CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_active_per_order
ON payment_transaction(order_id)
WHERE status IN ('PENDING', 'PAID') AND order_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_active_per_rental
ON payment_transaction(rental_id)
WHERE status IN ('PENDING', 'PAID') AND rental_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_transaction_code
ON payment_transaction(transaction_code)
WHERE transaction_code IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_default_bank_account_per_store
ON store_bank_accounts(store_id)
WHERE is_default = true;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_store_wallets_non_negative_balance'
  ) THEN
    ALTER TABLE store_wallets
    ADD CONSTRAINT chk_store_wallets_non_negative_balance
    CHECK (balance >= 0 AND frozen_balance >= 0);
  END IF;
END $$;
