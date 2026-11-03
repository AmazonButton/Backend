-- Migration: 20261101130000_customer_bank_penny_deposit_four_entities
-- Purpose: Implement 4-entity relational model for Penny-Deposit Verification & Refund Lifecycle (Phase 2 - Draft)
-- Invariants:
--   1. Zero Financial Cascade (RESTRICT on all accounting records)
--   2. Strict Object-Pointer Scoping (Composite FKs guarantee verified transaction & active attempt integrity)
--   3. Single In-Flight Payout Attempt per Obligation (Partial Unique Index)
--   4. Explicit Session Lifecycle (ACTIVE, EXPIRED, CONSUMED, ABANDONED)
--   5. Orphan / Out-of-Session Inbound Ledger (proof_id NULLABLE, tracking unmatched payments)
--   6. Provider & Channel Scoped Idempotency

-- ============================================================================
-- 1. Alter customer_bank_verification_proofs (VerificationSession)
-- ============================================================================
ALTER TABLE "customer_bank_verification_proofs"
    ADD COLUMN IF NOT EXISTS "session_status" VARCHAR(32) NOT NULL DEFAULT 'ACTIVE',
    ADD COLUMN IF NOT EXISTS "payment_order_code" BIGINT,
    ADD COLUMN IF NOT EXISTS "payment_link_id" VARCHAR(128),
    ADD COLUMN IF NOT EXISTS "payment_checkout_url" TEXT,
    ADD COLUMN IF NOT EXISTS "verification_status" VARCHAR(32) NOT NULL DEFAULT 'PENDING',
    ADD COLUMN IF NOT EXISTS "verified_at" TIMESTAMPTZ(6),
    ADD COLUMN IF NOT EXISTS "verified_by_transaction_id" BIGINT,
    ADD COLUMN IF NOT EXISTS "rejection_reason" VARCHAR(255);

CREATE UNIQUE INDEX IF NOT EXISTS "uq_cust_bank_payment_order_code" 
    ON "customer_bank_verification_proofs"("payment_order_code") 
    WHERE "payment_order_code" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "idx_cust_bank_proof_session_status"
    ON "customer_bank_verification_proofs"("session_status");

-- ============================================================================
-- 2. Create customer_bank_inbound_transactions (Sổ giao dịch thực nhận)
-- ============================================================================
CREATE TABLE IF NOT EXISTS "customer_bank_inbound_transactions" (
    "id" BIGSERIAL PRIMARY KEY,
    "proof_id" BIGINT, -- NULLABLE: Cho phép ghi nhận giao dịch ngoài phiên / phục hồi
    "provider" VARCHAR(32) NOT NULL DEFAULT 'PAYOS',
    "channel" VARCHAR(64) NOT NULL DEFAULT 'DEFAULT',
    "provider_transaction_ref" VARCHAR(128) NOT NULL,
    "amount" DECIMAL(15, 2) NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL,
    "is_late_payment" BOOLEAN NOT NULL DEFAULT false,
    "source_bank_bin" VARCHAR(10),
    "source_account_masked" VARCHAR(32),
    "source_account_hash" VARCHAR(64),
    "source_account_encrypted" TEXT,
    "source_account_name" VARCHAR(255),
    "has_sufficient_evidence" BOOLEAN NOT NULL DEFAULT false,
    "session_match_status" VARCHAR(32) NOT NULL DEFAULT 'MATCHED_SESSION',
    "match_decision" VARCHAR(32) NOT NULL DEFAULT 'PENDING',
    "raw_payload_checksum" VARCHAR(64),
    "reconciliation_flag" VARCHAR(64),
    "merged_into_inbound_id" BIGINT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "fk_cust_bank_inbound_proof" FOREIGN KEY ("proof_id") REFERENCES "customer_bank_verification_proofs"("id") ON DELETE RESTRICT,
    CONSTRAINT "fk_cust_bank_inbound_merged_into" FOREIGN KEY ("merged_into_inbound_id") REFERENCES "customer_bank_inbound_transactions"("id") ON DELETE RESTRICT,
    CONSTRAINT "chk_cust_bank_inbound_amount_positive" CHECK ("amount" > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS "uq_cust_bank_inbound_provider_channel_ref"
    ON "customer_bank_inbound_transactions"("provider", "channel", "provider_transaction_ref");

CREATE INDEX IF NOT EXISTS "idx_cust_bank_inbound_proof_id"
    ON "customer_bank_inbound_transactions"("proof_id");

CREATE INDEX IF NOT EXISTS "idx_cust_bank_inbound_match_status"
    ON "customer_bank_inbound_transactions"("session_match_status");

CREATE INDEX IF NOT EXISTS "idx_cust_bank_inbound_merged_into"
    ON "customer_bank_inbound_transactions"("merged_into_inbound_id");

-- Composite unique key to bind session and transaction strictly
CREATE UNIQUE INDEX IF NOT EXISTS "uq_cust_bank_inbound_proof_tx"
    ON "customer_bank_inbound_transactions"("proof_id", "id");

-- Foreign key link back from proof to the transaction that verified it (Strictly within the same session!)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_cust_bank_proof_verified_by_tx'
    ) THEN
        ALTER TABLE "customer_bank_verification_proofs"
            ADD CONSTRAINT "fk_cust_bank_proof_verified_by_tx"
            FOREIGN KEY ("id", "verified_by_transaction_id")
            REFERENCES "customer_bank_inbound_transactions"("proof_id", "id")
            ON DELETE SET NULL;
    END IF;
END $$;

-- ============================================================================
-- 3. Create customer_bank_refund_obligations (Sổ nghĩa vụ hoàn trả)
-- ============================================================================
CREATE TABLE IF NOT EXISTS "customer_bank_refund_obligations" (
    "id" BIGSERIAL PRIMARY KEY,
    "inbound_transaction_id" BIGINT NOT NULL,
    "refund_amount" DECIMAL(15, 2) NOT NULL,
    "refund_status" VARCHAR(32) NOT NULL DEFAULT 'PENDING_REFUND',
    "target_bank_bin" VARCHAR(10),
    "target_account_masked" VARCHAR(32),
    "target_account_hash" VARCHAR(64),
    "target_account_encrypted" TEXT,
    "target_account_name" VARCHAR(255),
    "refund_payout_reference" VARCHAR(128) NOT NULL,
    "active_payout_attempt_id" BIGINT,
    "refunded_at" TIMESTAMPTZ(6),
    "failure_reason" VARCHAR(255),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "fk_cust_bank_refund_inbound" FOREIGN KEY ("inbound_transaction_id") REFERENCES "customer_bank_inbound_transactions"("id") ON DELETE RESTRICT,
    CONSTRAINT "chk_cust_bank_refund_amount_positive" CHECK ("refund_amount" > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS "uq_cust_bank_refund_inbound_tx"
    ON "customer_bank_refund_obligations"("inbound_transaction_id");

CREATE UNIQUE INDEX IF NOT EXISTS "uq_cust_bank_refund_payout_ref"
    ON "customer_bank_refund_obligations"("refund_payout_reference");

CREATE INDEX IF NOT EXISTS "idx_cust_bank_refund_status"
    ON "customer_bank_refund_obligations"("refund_status");

-- ============================================================================
-- 4. Create customer_bank_refund_payout_attempts (Lịch sử từng đợt dispatch/đối soát)
-- ============================================================================
CREATE TABLE IF NOT EXISTS "customer_bank_refund_payout_attempts" (
    "id" BIGSERIAL PRIMARY KEY,
    "obligation_id" BIGINT NOT NULL,
    "attempt_number" INT NOT NULL,
    "payout_provider" VARCHAR(32) NOT NULL DEFAULT 'PAYOS',
    "payout_reference" VARCHAR(128) NOT NULL,
    "provider_payout_id" VARCHAR(128),
    "status" VARCHAR(32) NOT NULL DEFAULT 'PREPARING',
    "dispatched_at" TIMESTAMPTZ(6),
    "reconciled_at" TIMESTAMPTZ(6),
    "response_code" VARCHAR(32),
    "failure_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "fk_cust_bank_attempt_obligation" FOREIGN KEY ("obligation_id") REFERENCES "customer_bank_refund_obligations"("id") ON DELETE RESTRICT,
    CONSTRAINT "chk_cust_bank_attempt_number_positive" CHECK ("attempt_number" > 0)
);

-- Attempt uniqueness per obligation
CREATE UNIQUE INDEX IF NOT EXISTS "uq_cust_bank_attempt_obligation_number"
    ON "customer_bank_refund_payout_attempts"("obligation_id", "attempt_number");

-- Provider reference uniqueness
CREATE UNIQUE INDEX IF NOT EXISTS "uq_cust_bank_attempt_provider_ref"
    ON "customer_bank_refund_payout_attempts"("payout_provider", "payout_reference");

-- Composite unique key to bind obligation and attempt strictly
CREATE UNIQUE INDEX IF NOT EXISTS "uq_cust_bank_attempt_obligation_id_id"
    ON "customer_bank_refund_payout_attempts"("obligation_id", "id");

-- Partial unique index ensuring at most ONE in-flight attempt per obligation!
CREATE UNIQUE INDEX IF NOT EXISTS "uq_cust_bank_active_attempt_per_obligation"
    ON "customer_bank_refund_payout_attempts"("obligation_id")
    WHERE "status" IN ('PREPARING', 'SUBMITTED', 'PENDING_RECONCILIATION');

CREATE INDEX IF NOT EXISTS "idx_cust_bank_attempt_obligation_id"
    ON "customer_bank_refund_payout_attempts"("obligation_id");

-- Foreign key link back from obligation to the active payout attempt (Strictly within the same obligation!)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_cust_bank_obligation_active_attempt'
    ) THEN
        ALTER TABLE "customer_bank_refund_obligations"
            ADD CONSTRAINT "fk_cust_bank_obligation_active_attempt"
            FOREIGN KEY ("id", "active_payout_attempt_id")
            REFERENCES "customer_bank_refund_payout_attempts"("obligation_id", "id")
            ON DELETE SET NULL;
    END IF;
END $$;

-- Enforce ON DELETE RESTRICT from customer_bank_accounts to customer_profiles (Zero Financial Cascade)
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'customer_bank_accounts_customer_id_fkey'
    ) THEN
        ALTER TABLE "customer_bank_accounts"
            DROP CONSTRAINT "customer_bank_accounts_customer_id_fkey";
        ALTER TABLE "customer_bank_accounts"
            ADD CONSTRAINT "customer_bank_accounts_customer_id_fkey"
            FOREIGN KEY ("customer_id") REFERENCES "customer_profiles"("customer_id") ON DELETE RESTRICT;
    END IF;
END $$;

