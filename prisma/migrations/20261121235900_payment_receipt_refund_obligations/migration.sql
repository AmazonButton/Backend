-- F2 Full Remediation: Payment Order Receipts, Refund Obligations, Payout Attempts,
-- Global Verified Voucher Uniqueness, Conservation Triggers, and Legacy Backfill.

-- 1. Receipt ledger identifying every actual bank/provider money receipt uniquely
CREATE TABLE IF NOT EXISTS "payment_order_receipts" (
  "receipt_id"               BIGSERIAL PRIMARY KEY,
  "order_id"                 BIGINT NOT NULL REFERENCES "orders"("order_id") ON DELETE RESTRICT,
  "payment_transaction_id"   BIGINT REFERENCES "payment_transaction"("payment_transaction_id") ON DELETE RESTRICT,
  "provider"                 VARCHAR(32) NOT NULL DEFAULT 'PAYOS',
  "channel"                  VARCHAR(64) NOT NULL DEFAULT 'ORDER_PAYMENT_LINK',
  "provider_transaction_ref" VARCHAR(128) NOT NULL,
  "payment_link_id"          VARCHAR(128),
  "amount"                   DECIMAL(15, 2) NOT NULL,
  "currency"                 VARCHAR(10) NOT NULL DEFAULT 'VND',
  "classification"           VARCHAR(32) NOT NULL,
  "source_bank_raw"          VARCHAR(64),
  "source_bank_bin"          VARCHAR(10),
  "source_account_masked"    VARCHAR(32),
  "source_account_hash"      VARCHAR(64),
  "source_account_encrypted" TEXT,
  "source_account_name"      VARCHAR(255),
  "source_evidence_status"   VARCHAR(32) NOT NULL DEFAULT 'MISSING',
  "raw_payload_checksum"     CHAR(64),
  "received_at"              TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "created_at"               TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT "chk_payment_order_receipt_amount_pos" CHECK ("amount" > 0),
  CONSTRAINT "chk_payment_order_receipt_classification"
    CHECK ("classification" IN ('ORDER_PAYMENT', 'LATE_CANCELLED_OR_COD', 'EXCESS_DUPLICATE', 'LEGACY_UNCLASSIFIED')),
  CONSTRAINT "chk_payment_order_receipt_evidence_status"
    CHECK ("source_evidence_status" IN ('SUFFICIENT', 'MISSING', 'MASKED', 'UNMAPPED_BANK', 'CONFLICTING'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "uq_payment_order_receipt_provider_ref"
  ON "payment_order_receipts"("provider", "channel", "provider_transaction_ref");

CREATE UNIQUE INDEX IF NOT EXISTS "uq_payment_order_receipt_order_binding"
  ON "payment_order_receipts"("receipt_id", "order_id");

CREATE INDEX IF NOT EXISTS "idx_payment_order_receipt_order_cls"
  ON "payment_order_receipts"("order_id", "classification");

CREATE INDEX IF NOT EXISTS "idx_payment_order_receipt_tx"
  ON "payment_order_receipts"("payment_transaction_id");

-- 2. Refund Obligations (one obligation per refundable receipt; decoupled from sibling status)
CREATE TABLE IF NOT EXISTS "payment_refund_obligations" (
  "obligation_id"                 BIGSERIAL PRIMARY KEY,
  "order_id"                      BIGINT NOT NULL,
  "source_payment_transaction_id" BIGINT REFERENCES "payment_transaction"("payment_transaction_id") ON DELETE RESTRICT,
  "receipt_id"                    BIGINT NOT NULL,
  "obligation_type"               VARCHAR(32) NOT NULL,
  "refund_amount"                 DECIMAL(15, 2) NOT NULL,
  "currency"                      VARCHAR(10) NOT NULL DEFAULT 'VND',
  "status"                        VARCHAR(40) NOT NULL DEFAULT 'PENDING_RECIPIENT_VERIFICATION',
  "recipient_verification_status" VARCHAR(40) NOT NULL DEFAULT 'SOURCE_INSUFFICIENT',
  "verification_note"             VARCHAR(500),
  "customer_bank_account_id"      BIGINT REFERENCES "customer_bank_accounts"("id") ON DELETE RESTRICT,
  "target_bank_bin"               VARCHAR(10),
  "target_account_encrypted"      TEXT,
  "target_account_hash"           VARCHAR(64),
  "target_account_masked"         VARCHAR(32),
  "target_account_name"           VARCHAR(255),
  "snapshot_locked_at"            TIMESTAMPTZ(6),
  "active_payout_attempt_id"      BIGINT,
  "settled_attempt_id"            BIGINT,
  "settled_by_user_id"            BIGINT REFERENCES "users"("user_id") ON DELETE SET NULL,
  "refunded_at"                   TIMESTAMPTZ(6),
  "failure_reason"                VARCHAR(500),
  "created_at"                    TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at"                    TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT "chk_payment_refund_obligation_amount_pos" CHECK ("refund_amount" > 0),
  CONSTRAINT "chk_payment_refund_obligation_type"
    CHECK ("obligation_type" IN ('ORDER_REFUND', 'EXCESS_DUPLICATE', 'LEGACY_UNCLASSIFIED')),
  CONSTRAINT "chk_payment_refund_obligation_status"
    CHECK ("status" IN (
      'PENDING_RECIPIENT_VERIFICATION',
      'READY_FOR_PAYOUT',
      'PROCESSING_PAYOUT',
      'PENDING_RECONCILIATION',
      'REFUNDED',
      'CANCELLED'
    )),
  CONSTRAINT "fk_payment_refund_obligation_receipt_order"
    FOREIGN KEY ("receipt_id", "order_id")
    REFERENCES "payment_order_receipts"("receipt_id", "order_id")
    ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS "uq_payment_refund_obligation_receipt"
  ON "payment_refund_obligations"("receipt_id");

CREATE INDEX IF NOT EXISTS "idx_payment_refund_obligation_order_status"
  ON "payment_refund_obligations"("order_id", "status");

CREATE INDEX IF NOT EXISTS "idx_payment_refund_obligation_status_created"
  ON "payment_refund_obligations"("status", "created_at");

-- 3. Individual Payout Attempts (clean separation from obligation liability)
CREATE TABLE IF NOT EXISTS "payment_refund_payout_attempts" (
  "attempt_id"              BIGSERIAL PRIMARY KEY,
  "obligation_id"           BIGINT NOT NULL REFERENCES "payment_refund_obligations"("obligation_id") ON DELETE RESTRICT,
  "attempt_number"          INT NOT NULL,
  "payout_provider"         VARCHAR(32) NOT NULL DEFAULT 'PAYOS',
  "payout_reference"        VARCHAR(128) NOT NULL,
  "provider_payout_id"      VARCHAR(128),
  "provider_transaction_id" VARCHAR(128),
  "status"                  VARCHAR(32) NOT NULL DEFAULT 'PREPARING',
  "initiated_by_user_id"    BIGINT REFERENCES "users"("user_id") ON DELETE SET NULL,
  "dispatched_at"           TIMESTAMPTZ(6),
  "reconciled_at"           TIMESTAMPTZ(6),
  "next_reconcile_at"       TIMESTAMPTZ(6),
  "reconcile_attempts"      INT NOT NULL DEFAULT 0,
  "response_code"           VARCHAR(64),
  "failure_reason"          TEXT,
  "created_at"              TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at"              TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT "chk_pay_refund_attempt_num_pos" CHECK ("attempt_number" >= 1),
  CONSTRAINT "chk_pay_refund_attempt_status"
    CHECK ("status" IN ('PREPARING', 'DISPATCHING', 'PENDING_RECONCILIATION', 'SUCCEEDED', 'FAILED'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "uq_pay_refund_attempt_num"
  ON "payment_refund_payout_attempts"("obligation_id", "attempt_number");

CREATE UNIQUE INDEX IF NOT EXISTS "uq_pay_refund_attempt_provider_ref"
  ON "payment_refund_payout_attempts"("payout_provider", "payout_reference");

CREATE UNIQUE INDEX IF NOT EXISTS "uq_pay_refund_attempt_active"
  ON "payment_refund_payout_attempts"("obligation_id")
  WHERE "status" IN ('PREPARING', 'DISPATCHING', 'PENDING_RECONCILIATION');

CREATE UNIQUE INDEX IF NOT EXISTS "uq_pay_refund_attempt_provider_tx_id"
  ON "payment_refund_payout_attempts"("payout_provider", "provider_transaction_id")
  WHERE "provider_transaction_id" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "uq_pay_refund_attempt_provider_payout_ref"
  ON "payment_refund_payout_attempts"("payout_provider", "provider_payout_id", "payout_reference")
  WHERE "provider_payout_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "idx_pay_refund_attempt_reconcile"
  ON "payment_refund_payout_attempts"("status", "next_reconcile_at");

-- Link obligation active/settled attempt pointers safely
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payment_refund_obligation_active_attempt') THEN
    ALTER TABLE "payment_refund_obligations"
      ADD CONSTRAINT "fk_payment_refund_obligation_active_attempt"
      FOREIGN KEY ("active_payout_attempt_id")
      REFERENCES "payment_refund_payout_attempts"("attempt_id")
      ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payment_refund_obligation_settled_attempt') THEN
    ALTER TABLE "payment_refund_obligations"
      ADD CONSTRAINT "fk_payment_refund_obligation_settled_attempt"
      FOREIGN KEY ("settled_attempt_id")
      REFERENCES "payment_refund_payout_attempts"("attempt_id")
      ON DELETE SET NULL;
  END IF;
END $$;

-- 4. Global Verified Payout Voucher Ledger (supports future batch payouts while forbidding voucher reuse)
CREATE TABLE IF NOT EXISTS "payment_refund_verified_vouchers" (
  "voucher_id"              BIGSERIAL PRIMARY KEY,
  "payout_provider"         VARCHAR(32) NOT NULL DEFAULT 'PAYOS',
  "provider_payout_id"      VARCHAR(128) NOT NULL,
  "provider_transaction_id" VARCHAR(128) NOT NULL,
  "payout_reference"        VARCHAR(128) NOT NULL,
  "obligation_id"           BIGINT NOT NULL UNIQUE REFERENCES "payment_refund_obligations"("obligation_id") ON DELETE RESTRICT,
  "attempt_id"              BIGINT NOT NULL UNIQUE REFERENCES "payment_refund_payout_attempts"("attempt_id") ON DELETE RESTRICT,
  "verified_amount"         DECIMAL(15, 2) NOT NULL,
  "target_bank_bin"         VARCHAR(10) NOT NULL,
  "target_account_hash"     VARCHAR(64) NOT NULL,
  "verified_at"             TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "created_at"              TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT "chk_pay_refund_voucher_amount_pos" CHECK ("verified_amount" > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS "uq_refund_voucher_provider_tx"
  ON "payment_refund_verified_vouchers"("payout_provider", "provider_transaction_id");

CREATE UNIQUE INDEX IF NOT EXISTS "uq_refund_voucher_payout_ref"
  ON "payment_refund_verified_vouchers"("payout_provider", "provider_payout_id", "payout_reference");

-- 5. PostgreSQL Conservation Trigger & Locked Snapshot Immutability Guard
CREATE OR REPLACE FUNCTION "fn_enforce_payment_refund_budget"()
RETURNS TRIGGER AS $$
DECLARE
  v_order RECORD;
  v_receipt RECORD;
  v_allowable DECIMAL(15, 2);
  v_allocated DECIMAL(15, 2);
BEGIN
  SELECT order_id, order_status, payment_status, payment_method
  INTO v_order
  FROM orders
  WHERE order_id = NEW.order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND: order_id=% does not exist', NEW.order_id;
  END IF;

  SELECT receipt_id, order_id, amount, classification
  INTO v_receipt
  FROM payment_order_receipts
  WHERE receipt_id = NEW.receipt_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'RECEIPT_NOT_FOUND: receipt_id=% does not exist', NEW.receipt_id;
  END IF;

  IF v_receipt.order_id <> NEW.order_id THEN
    RAISE EXCEPTION 'RECEIPT_ORDER_MISMATCH: receipt % belongs to order %, not %', NEW.receipt_id, v_receipt.order_id, NEW.order_id;
  END IF;

  IF NEW.refund_amount <= 0 OR NEW.refund_amount > v_receipt.amount THEN
    RAISE EXCEPTION 'RECEIPT_REFUND_EXCEEDED: obligation amount % exceeds receipt amount % (receipt %)', NEW.refund_amount, v_receipt.amount, NEW.receipt_id;
  END IF;

  -- Active paid order retains its primary ORDER_PAYMENT receipt(s) until cancelled/rejected/failed/switched
  IF NEW.status <> 'CANCELLED' THEN
    IF v_receipt.classification = 'ORDER_PAYMENT'
       AND v_order.payment_method = 'PAYOS'
       AND v_order.order_status NOT IN ('CANCELLED', 'REJECTED', 'DELIVERY_FAILED')
       AND v_order.payment_status NOT IN ('REFUND_PENDING', 'REFUNDED') THEN
      RAISE EXCEPTION 'ACTIVE_ORDER_PAYMENT_NOT_REFUNDABLE: order % is still active (status=%, payment_status=%)',
        NEW.order_id, v_order.order_status, v_order.payment_status;
    END IF;

    SELECT COALESCE(SUM(r.amount), 0)
    INTO v_allowable
    FROM payment_order_receipts r
    WHERE r.order_id = NEW.order_id
      AND (
        r.classification IN ('EXCESS_DUPLICATE', 'LATE_CANCELLED_OR_COD', 'LEGACY_UNCLASSIFIED')
        OR (
          r.classification = 'ORDER_PAYMENT'
          AND (
            v_order.payment_method <> 'PAYOS'
            OR v_order.order_status IN ('CANCELLED', 'REJECTED', 'DELIVERY_FAILED')
            OR v_order.payment_status IN ('REFUND_PENDING', 'REFUNDED')
          )
        )
      );

    SELECT COALESCE(SUM(o.refund_amount), 0)
    INTO v_allocated
    FROM payment_refund_obligations o
    WHERE o.order_id = NEW.order_id
      AND o.status <> 'CANCELLED'
      AND (TG_OP = 'INSERT' OR o.obligation_id <> NEW.obligation_id);

    v_allocated := v_allocated + NEW.refund_amount;

    IF v_allocated > v_allowable THEN
      RAISE EXCEPTION 'REFUND_BUDGET_EXCEEDED: allocated % > allowable % for order %',
        v_allocated, v_allowable, NEW.order_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "trg_enforce_payment_refund_budget" ON "payment_refund_obligations";
CREATE TRIGGER "trg_enforce_payment_refund_budget"
  BEFORE INSERT OR UPDATE OF "refund_amount", "status", "order_id", "receipt_id"
  ON "payment_refund_obligations"
  FOR EACH ROW
  EXECUTE FUNCTION "fn_enforce_payment_refund_budget"();

CREATE OR REPLACE FUNCTION "fn_guard_locked_refund_obligation_snapshot"()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.snapshot_locked_at IS NOT NULL THEN
    IF NEW.receipt_id IS DISTINCT FROM OLD.receipt_id
       OR NEW.order_id IS DISTINCT FROM OLD.order_id
       OR NEW.refund_amount IS DISTINCT FROM OLD.refund_amount
       OR NEW.target_bank_bin IS DISTINCT FROM OLD.target_bank_bin
       OR NEW.target_account_encrypted IS DISTINCT FROM OLD.target_account_encrypted
       OR NEW.target_account_hash IS DISTINCT FROM OLD.target_account_hash
       OR NEW.target_account_masked IS DISTINCT FROM OLD.target_account_masked
       OR NEW.target_account_name IS DISTINCT FROM OLD.target_account_name THEN
      RAISE EXCEPTION 'IMMUTABLE_REFUND_SNAPSHOT: cannot mutate beneficiary snapshot or amount once locked on obligation %', OLD.obligation_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "trg_guard_locked_refund_obligation_snapshot" ON "payment_refund_obligations";
CREATE TRIGGER "trg_guard_locked_refund_obligation_snapshot"
  BEFORE UPDATE ON "payment_refund_obligations"
  FOR EACH ROW
  EXECUTE FUNCTION "fn_guard_locked_refund_obligation_snapshot"();

-- 6. Safe Legacy Backfill (never assumes every REFUND_PENDING is excess; never re-queues legacy REFUNDED)
-- 6a. Historical PAID transactions (order_id present, positive amount)
INSERT INTO "payment_order_receipts" (
  "order_id",
  "payment_transaction_id",
  "provider",
  "channel",
  "provider_transaction_ref",
  "payment_link_id",
  "amount",
  "currency",
  "classification",
  "source_evidence_status",
  "received_at"
)
SELECT
  pt."order_id",
  pt."payment_transaction_id",
  pt."provider",
  'LEGACY_BACKFILL',
  'LEGACY_PT_' || pt."payment_transaction_id"::TEXT,
  pt."payment_link_id",
  pt."amount",
  'VND',
  CASE
    WHEN o."payment_status" = 'REFUND_PENDING' THEN 'LEGACY_UNCLASSIFIED'
    ELSE 'ORDER_PAYMENT'
  END,
  'MISSING',
  COALESCE(pt."paid_at", pt."updated_at", pt."created_at", NOW())
FROM "payment_transaction" pt
JOIN "orders" o ON o."order_id" = pt."order_id"
WHERE pt."order_id" IS NOT NULL
  AND pt."amount" > 0
  AND pt."status" = 'PAID'
ON CONFLICT ("provider", "channel", "provider_transaction_ref") DO NOTHING;

-- 6b. Historical REFUND_PENDING transactions (always LEGACY_UNCLASSIFIED for manual verification)
INSERT INTO "payment_order_receipts" (
  "order_id",
  "payment_transaction_id",
  "provider",
  "channel",
  "provider_transaction_ref",
  "payment_link_id",
  "amount",
  "currency",
  "classification",
  "source_evidence_status",
  "received_at"
)
SELECT
  pt."order_id",
  pt."payment_transaction_id",
  pt."provider",
  'LEGACY_BACKFILL',
  'LEGACY_PT_' || pt."payment_transaction_id"::TEXT,
  pt."payment_link_id",
  pt."amount",
  'VND',
  'LEGACY_UNCLASSIFIED',
  'MISSING',
  COALESCE(pt."paid_at", pt."updated_at", pt."created_at", NOW())
FROM "payment_transaction" pt
JOIN "orders" o ON o."order_id" = pt."order_id"
WHERE pt."order_id" IS NOT NULL
  AND pt."amount" > 0
  AND pt."status" = 'REFUND_PENDING'
ON CONFLICT ("provider", "channel", "provider_transaction_ref") DO NOTHING;

-- 6c. Open obligations for legacy REFUND_PENDING receipts only (locked in PENDING_RECIPIENT_VERIFICATION)
INSERT INTO "payment_refund_obligations" (
  "order_id",
  "source_payment_transaction_id",
  "receipt_id",
  "obligation_type",
  "refund_amount",
  "currency",
  "status",
  "recipient_verification_status",
  "verification_note"
)
SELECT
  r."order_id",
  r."payment_transaction_id",
  r."receipt_id",
  'LEGACY_UNCLASSIFIED',
  r."amount",
  r."currency",
  'PENDING_RECIPIENT_VERIFICATION',
  'LEGACY_UNCLASSIFIED',
  'Backfilled legacy REFUND_PENDING record missing inbound sender evidence; manual verification required.'
FROM "payment_order_receipts" r
WHERE r."channel" = 'LEGACY_BACKFILL'
  AND r."classification" = 'LEGACY_UNCLASSIFIED'
ON CONFLICT ("receipt_id") DO NOTHING;
