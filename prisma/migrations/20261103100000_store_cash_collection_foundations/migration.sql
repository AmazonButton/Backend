-- Additive cash-collection v1 foundations. No existing balances/data are changed.
-- This migration does NOT activate cash endpoints or implement settlement CAS.
BEGIN;

CREATE UNIQUE INDEX "uq_rental_customer_cash_binding" ON "button_rentals" ("rental_id", "customer_id");
CREATE UNIQUE INDEX "uq_charge_cash_binding" ON "billing_charges" ("charge_id", "target_type", "target_id", "total_amount");

CREATE TABLE "store_cash_vouchers" (
    "id" BIGSERIAL PRIMARY KEY,
    "token_hash" VARCHAR(64) NOT NULL,
    "customer_id" BIGINT NOT NULL,
    "rental_id" BIGINT NOT NULL,
    "charge_id" BIGINT NOT NULL,
    "target_type" VARCHAR(32) NOT NULL DEFAULT 'RENTAL',
    "collecting_store_id" BIGINT NOT NULL,
    "amount" DECIMAL(15,2) NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "consumed_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ck_cash_voucher_hash" CHECK ("token_hash" ~ '^[a-f0-9]{64}$'),
    CONSTRAINT "ck_cash_voucher_target" CHECK ("target_type" = 'RENTAL'),
    CONSTRAINT "ck_cash_voucher_amount" CHECK ("amount" > 0 AND "amount" = trunc("amount")),
    CONSTRAINT "ck_cash_voucher_expiry" CHECK ("expires_at" > "created_at"),
    CONSTRAINT "ck_cash_voucher_state" CHECK (
        ("status" = 'ACTIVE' AND "consumed_at" IS NULL AND "revoked_at" IS NULL) OR
        ("status" = 'CONSUMED' AND "consumed_at" IS NOT NULL AND "revoked_at" IS NULL) OR
        ("status" = 'REVOKED' AND "consumed_at" IS NULL AND "revoked_at" IS NOT NULL)
    ),
    CONSTRAINT "store_cash_vouchers_rental_id_customer_id_fkey" FOREIGN KEY ("rental_id", "customer_id")
        REFERENCES "button_rentals" ("rental_id", "customer_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "store_cash_vouchers_charge_id_target_type_rental_id_amount_fkey" FOREIGN KEY ("charge_id", "target_type", "rental_id", "amount")
        REFERENCES "billing_charges" ("charge_id", "target_type", "target_id", "total_amount") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "store_cash_vouchers_collecting_store_id_fkey" FOREIGN KEY ("collecting_store_id")
        REFERENCES "store" ("store_id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "uq_cash_voucher_token_hash" ON "store_cash_vouchers" ("token_hash");
CREATE UNIQUE INDEX "uq_cash_voucher_receipt_binding" ON "store_cash_vouchers" ("id", "charge_id", "collecting_store_id", "amount");
-- Expired ACTIVE vouchers must be revoked in the same transaction before reissue.
CREATE UNIQUE INDEX "uq_cash_voucher_active_rental" ON "store_cash_vouchers" ("rental_id") WHERE "status" = 'ACTIVE';
CREATE INDEX "idx_cash_voucher_store_expiry" ON "store_cash_vouchers" ("collecting_store_id", "status", "expires_at");
CREATE INDEX "idx_cash_voucher_charge" ON "store_cash_vouchers" ("charge_id");
CREATE INDEX "idx_cash_voucher_rental_customer" ON "store_cash_vouchers" ("rental_id", "customer_id");

CREATE TABLE "store_cash_receipts" (
    "id" BIGSERIAL PRIMARY KEY,
    "charge_id" BIGINT NOT NULL,
    "voucher_id" BIGINT NOT NULL,
    "collecting_store_id" BIGINT NOT NULL,
    "amount" DECIMAL(15,2) NOT NULL,
    "wallet_transaction_id" BIGINT NOT NULL,
    "collected_by_user_id" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ck_cash_receipt_amount" CHECK ("amount" > 0 AND "amount" = trunc("amount")),
    CONSTRAINT "store_cash_receipts_voucher_binding_fkey" FOREIGN KEY ("voucher_id", "charge_id", "collecting_store_id", "amount")
        REFERENCES "store_cash_vouchers" ("id", "charge_id", "collecting_store_id", "amount") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "store_cash_receipts_wallet_transaction_id_fkey" FOREIGN KEY ("wallet_transaction_id")
        REFERENCES "wallet_transactions" ("transaction_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "store_cash_receipts_collected_by_user_id_fkey" FOREIGN KEY ("collected_by_user_id")
        REFERENCES "users" ("user_id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "uq_cash_receipt_charge" ON "store_cash_receipts" ("charge_id");
CREATE UNIQUE INDEX "uq_cash_receipt_voucher" ON "store_cash_receipts" ("voucher_id");
CREATE UNIQUE INDEX "uq_cash_receipt_wallet_tx" ON "store_cash_receipts" ("wallet_transaction_id");
CREATE UNIQUE INDEX "uq_cash_receipt_voucher_binding" ON "store_cash_receipts" ("voucher_id", "charge_id", "collecting_store_id", "amount");
CREATE INDEX "idx_cash_receipt_store_created" ON "store_cash_receipts" ("collecting_store_id", "created_at");
CREATE INDEX "idx_cash_receipt_actor" ON "store_cash_receipts" ("collected_by_user_id");

CREATE TABLE "billing_payment_receipts" (
    "id" BIGSERIAL PRIMARY KEY,
    "charge_id" BIGINT NOT NULL,
    "provider" VARCHAR(32) NOT NULL,
    "channel" VARCHAR(64) NOT NULL,
    "provider_transaction_ref" VARCHAR(128) NOT NULL,
    "amount" DECIMAL(15,2) NOT NULL,
    "currency" VARCHAR(10) NOT NULL DEFAULT 'VND',
    "classification" VARCHAR(32) NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ck_billing_receipt_amount" CHECK ("amount" > 0 AND "amount" = trunc("amount")),
    CONSTRAINT "ck_billing_receipt_currency" CHECK ("currency" = 'VND'),
    CONSTRAINT "ck_billing_receipt_identity" CHECK (
        length(trim("provider")) > 0 AND length(trim("channel")) > 0 AND length(trim("provider_transaction_ref")) > 0
    ),
    CONSTRAINT "ck_billing_receipt_classification" CHECK ("classification" IN ('SETTLEMENT_RECEIPT', 'OVERPAYMENT_RECEIPT')),
    CONSTRAINT "billing_payment_receipts_charge_id_fkey" FOREIGN KEY ("charge_id")
        REFERENCES "billing_charges" ("charge_id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "uq_billing_receipt_provider_channel_ref" ON "billing_payment_receipts" ("provider", "channel", "provider_transaction_ref");
CREATE UNIQUE INDEX "uq_billing_receipt_obligation_binding" ON "billing_payment_receipts" ("id", "amount", "classification");
CREATE INDEX "idx_billing_receipt_charge_received" ON "billing_payment_receipts" ("charge_id", "received_at");

CREATE TABLE "billing_overpayment_obligations" (
    "id" BIGSERIAL PRIMARY KEY,
    "receipt_id" BIGINT NOT NULL,
    "amount" DECIMAL(15,2) NOT NULL,
    "receipt_classification" VARCHAR(32) NOT NULL DEFAULT 'OVERPAYMENT_RECEIPT',
    "status" VARCHAR(32) NOT NULL DEFAULT 'PENDING_RECONCILIATION',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ck_billing_overpayment_amount" CHECK ("amount" > 0 AND "amount" = trunc("amount")),
    CONSTRAINT "ck_billing_overpayment_kind" CHECK ("receipt_classification" = 'OVERPAYMENT_RECEIPT'),
    -- Intentional v1 gate: payout needs a separately reviewed recipient snapshot and attempt ledger.
    CONSTRAINT "ck_billing_overpayment_status" CHECK ("status" = 'PENDING_RECONCILIATION'),
    CONSTRAINT "billing_overpayment_obligations_receipt_binding_fkey" FOREIGN KEY ("receipt_id", "amount", "receipt_classification")
        REFERENCES "billing_payment_receipts" ("id", "amount", "classification") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "uq_billing_overpayment_receipt" ON "billing_overpayment_obligations" ("receipt_id");
CREATE UNIQUE INDEX "uq_billing_overpayment_binding" ON "billing_overpayment_obligations" ("receipt_id", "amount", "receipt_classification");
CREATE INDEX "idx_billing_overpayment_queue" ON "billing_overpayment_obligations" ("status", "created_at");

COMMIT;
