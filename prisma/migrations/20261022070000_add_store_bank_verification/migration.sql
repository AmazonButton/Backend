-- CreateTable store_bank_accounts
CREATE TABLE IF NOT EXISTS "store_bank_accounts" (
    "id" BIGSERIAL PRIMARY KEY,
    "store_id" BIGINT NOT NULL,
    "bank_bin" VARCHAR(10) NOT NULL,
    "bank_code" VARCHAR(20),
    "bank_name" VARCHAR(100) NOT NULL,
    "account_number_encrypted" TEXT NOT NULL,
    "account_number_hash" VARCHAR(64) NOT NULL,
    "account_name" VARCHAR(255) NOT NULL,
    "verification_status" VARCHAR(32) NOT NULL DEFAULT 'PENDING',
    "is_default" BOOLEAN NOT NULL DEFAULT true,
    "verified_at" TIMESTAMPTZ(6),
    "last_verified_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "fk_store_bank_accounts_store" FOREIGN KEY ("store_id") REFERENCES "store"("store_id") ON DELETE CASCADE
);

-- Indexes for store_bank_accounts
CREATE UNIQUE INDEX IF NOT EXISTS "uq_store_bank_account_store_acc_hash" ON "store_bank_accounts"("store_id", "account_number_hash");
CREATE INDEX IF NOT EXISTS "idx_store_bank_accounts_status" ON "store_bank_accounts"("store_id", "verification_status");

-- CreateTable bank_account_verification_transactions
CREATE TABLE IF NOT EXISTS "bank_account_verification_transactions" (
    "id" BIGSERIAL PRIMARY KEY,
    "bank_account_id" BIGINT NOT NULL,
    "reference_code" VARCHAR(64) NOT NULL,
    "expected_amount" DECIMAL(15, 2) NOT NULL DEFAULT 2000.00,
    "received_amount" DECIMAL(15, 2),
    "provider_transaction_id" VARCHAR(128),
    "status" VARCHAR(32) NOT NULL DEFAULT 'PENDING',
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "verified_at" TIMESTAMPTZ(6),
    "refund_status" VARCHAR(32),
    "refund_transaction_id" VARCHAR(128),
    "refunded_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "fk_bank_verify_tx_account" FOREIGN KEY ("bank_account_id") REFERENCES "store_bank_accounts"("id") ON DELETE CASCADE
);

-- Indexes for bank_account_verification_transactions
CREATE UNIQUE INDEX IF NOT EXISTS "uq_bank_verify_tx_provider_tx_id" ON "bank_account_verification_transactions"("provider_transaction_id") WHERE "provider_transaction_id" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "uq_bank_verify_acc_ref" ON "bank_account_verification_transactions"("bank_account_id", "reference_code");
CREATE INDEX IF NOT EXISTS "idx_bank_verify_tx_ref_code" ON "bank_account_verification_transactions"("reference_code");
CREATE INDEX IF NOT EXISTS "idx_bank_verify_tx_status" ON "bank_account_verification_transactions"("status");
