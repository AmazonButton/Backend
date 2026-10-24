-- Migration: 20261024170000_standardize_bank_account_and_withdrawal
-- Phase 1 Safe Migration: Add encrypted snapshot columns to store_withdrawals, make plaintext bank_account_number nullable (deprecated), add indexes and relations.

-- 1. Alter store_withdrawals columns
ALTER TABLE "store_withdrawals" ALTER COLUMN "bank_account_number" DROP NOT NULL;

ALTER TABLE "store_withdrawals" ADD COLUMN IF NOT EXISTS "bank_account_id" BIGINT;
ALTER TABLE "store_withdrawals" ADD COLUMN IF NOT EXISTS "bank_account_encrypted" TEXT;
ALTER TABLE "store_withdrawals" ADD COLUMN IF NOT EXISTS "bank_account_hash" VARCHAR(64);
ALTER TABLE "store_withdrawals" ADD COLUMN IF NOT EXISTS "bank_account_masked" VARCHAR(32);
ALTER TABLE "store_withdrawals" ADD COLUMN IF NOT EXISTS "bank_account_name_snapshot" VARCHAR(255);
ALTER TABLE "store_withdrawals" ADD COLUMN IF NOT EXISTS "bank_bin_snapshot" VARCHAR(10);
ALTER TABLE "store_withdrawals" ADD COLUMN IF NOT EXISTS "bank_name_snapshot" VARCHAR(100);

-- 2. Foreign key relation to store_bank_accounts
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'store_withdrawals_bank_account_id_fkey') THEN
    ALTER TABLE "store_withdrawals" ADD CONSTRAINT "store_withdrawals_bank_account_id_fkey" FOREIGN KEY ("bank_account_id") REFERENCES "store_bank_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- 3. Indexes for fast encrypted lookup and provider reference resolution
CREATE INDEX IF NOT EXISTS "idx_store_withdrawals_acc_hash" ON "store_withdrawals"("bank_account_hash");
CREATE INDEX IF NOT EXISTS "idx_store_withdrawals_provider_ref" ON "store_withdrawals"("provider_reference_id");
CREATE INDEX IF NOT EXISTS "idx_store_bank_accounts_acc_hash" ON "store_bank_accounts"("account_number_hash");
