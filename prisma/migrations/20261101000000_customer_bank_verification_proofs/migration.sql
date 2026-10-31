-- CreateTable customer_bank_verification_proofs
CREATE TABLE IF NOT EXISTS "customer_bank_verification_proofs" (
    "id" BIGSERIAL PRIMARY KEY,
    "proof_reference" VARCHAR(128) NOT NULL,
    "customer_id" BIGINT NOT NULL,
    "account_id" BIGINT NOT NULL,
    "bank_bin" VARCHAR(10) NOT NULL,
    "account_number_hash" VARCHAR(64) NOT NULL,
    "status" VARCHAR(32) NOT NULL DEFAULT 'PENDING',
    "provider" VARCHAR(32) NOT NULL DEFAULT 'PAYOS',
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "fk_cust_bank_proof_account" FOREIGN KEY ("account_id") REFERENCES "customer_bank_accounts"("id") ON DELETE CASCADE,
    CONSTRAINT "fk_cust_bank_proof_customer" FOREIGN KEY ("customer_id") REFERENCES "customer_profile"("customer_id") ON DELETE CASCADE
);

-- Unique & composite indexes
CREATE UNIQUE INDEX IF NOT EXISTS "uq_cust_bank_proof_ref" ON "customer_bank_verification_proofs"("proof_reference");
CREATE INDEX IF NOT EXISTS "idx_cust_bank_proof_cust_acc" ON "customer_bank_verification_proofs"("customer_id", "account_id");
