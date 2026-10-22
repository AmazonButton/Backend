-- AlterTable bank_account_verification_transactions
ALTER TABLE "bank_account_verification_transactions"
ADD COLUMN IF NOT EXISTS "failure_reason" VARCHAR(64);
