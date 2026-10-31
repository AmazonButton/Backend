-- AlterTable: Add immutable recipient bank account snapshot fields to deposit_refunds
ALTER TABLE "deposit_refunds"
ADD COLUMN IF NOT EXISTS "recipient_bin" VARCHAR(10),
ADD COLUMN IF NOT EXISTS "recipient_account_number_encrypted" TEXT,
ADD COLUMN IF NOT EXISTS "recipient_account_number_hash" VARCHAR(64),
ADD COLUMN IF NOT EXISTS "recipient_account_holder_name" VARCHAR(255),
ADD COLUMN IF NOT EXISTS "recipient_account_number_masked" VARCHAR(32);

-- Backfill existing refunds from referenced customer_bank_accounts
UPDATE "deposit_refunds" dr
SET
  "recipient_bin" = cba.bank_bin,
  "recipient_account_number_encrypted" = cba.account_number_encrypted,
  "recipient_account_number_hash" = cba.account_number_hash,
  "recipient_account_holder_name" = cba.account_name,
  "recipient_account_number_masked" = cba.account_number_masked
FROM "customer_bank_accounts" cba
WHERE dr.bank_account_id = cba.id
  AND dr.recipient_bin IS NULL;
