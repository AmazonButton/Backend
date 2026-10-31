-- Platform Button Rental Expansion Migration (BRD V2.3)
-- Safe additive schema changes for button custody, billing charges, rental deposits and refunds

-- 1. IoT Button additive fields
ALTER TABLE "iot_button" 
  ADD COLUMN IF NOT EXISTS "custody_store_id" BIGINT,
  ADD COLUMN IF NOT EXISTS "inventory_state" VARCHAR(30) NOT NULL DEFAULT 'IN_PLATFORM_WAREHOUSE',
  ADD COLUMN IF NOT EXISTS "can_order" BOOLEAN NOT NULL DEFAULT true;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_iot_button_custody_store') THEN
    ALTER TABLE "iot_button" ADD CONSTRAINT "fk_iot_button_custody_store" FOREIGN KEY ("custody_store_id") REFERENCES "store"("store_id") ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "idx_iot_button_custody_inventory" ON "iot_button"("custody_store_id", "inventory_state");

-- 2. Button Rentals additive fields
ALTER TABLE "button_rentals"
  ADD COLUMN IF NOT EXISTS "fulfillment_store_id" BIGINT,
  ADD COLUMN IF NOT EXISTS "paid_through" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "effective_expires_at" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "returned_at" TIMESTAMPTZ(6);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_button_rentals_fulfillment_store') THEN
    ALTER TABLE "button_rentals" ADD CONSTRAINT "fk_button_rentals_fulfillment_store" FOREIGN KEY ("fulfillment_store_id") REFERENCES "store"("store_id") ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "idx_button_rentals_fulfillment_status" ON "button_rentals"("fulfillment_store_id", "status");

-- 3. Device Movements table
CREATE TABLE IF NOT EXISTS "device_movements" (
  "movement_id" BIGSERIAL PRIMARY KEY,
  "button_id" BIGINT NOT NULL REFERENCES "iot_button"("button_id") ON DELETE CASCADE,
  "source_type" VARCHAR(30) NOT NULL,
  "source_store_id" BIGINT,
  "dest_type" VARCHAR(30) NOT NULL,
  "dest_store_id" BIGINT,
  "rental_id" BIGINT,
  "actor_user_id" BIGINT,
  "reason" VARCHAR(255),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "idx_device_movements_button" ON "device_movements"("button_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "idx_device_movements_source_store" ON "device_movements"("source_store_id");
CREATE INDEX IF NOT EXISTS "idx_device_movements_dest_store" ON "device_movements"("dest_store_id");

-- 4. Billing Charges & Lines tables
CREATE TABLE IF NOT EXISTS "billing_charges" (
  "charge_id" BIGSERIAL PRIMARY KEY,
  "charge_code" VARCHAR(64) NOT NULL UNIQUE,
  "purpose" VARCHAR(32) NOT NULL,
  "target_type" VARCHAR(32) NOT NULL,
  "target_id" BIGINT NOT NULL,
  "currency" VARCHAR(10) NOT NULL DEFAULT 'VND',
  "total_amount" DECIMAL(15, 2) NOT NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  "paid_at" TIMESTAMPTZ(6),
  "payment_method" VARCHAR(32),
  "qr_code" TEXT,
  "payment_link_id" VARCHAR(128),
  "checkout_url" VARCHAR(1024),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "idx_billing_charges_target" ON "billing_charges"("target_type", "target_id", "status");
CREATE INDEX IF NOT EXISTS "idx_billing_charges_status_created" ON "billing_charges"("status", "created_at" DESC);

CREATE TABLE IF NOT EXISTS "billing_charge_lines" (
  "line_id" BIGSERIAL PRIMARY KEY,
  "charge_id" BIGINT NOT NULL REFERENCES "billing_charges"("charge_id") ON DELETE CASCADE,
  "line_type" VARCHAR(32) NOT NULL,
  "amount" DECIMAL(15, 2) NOT NULL,
  "description" VARCHAR(255),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "idx_billing_charge_lines_charge" ON "billing_charge_lines"("charge_id");

-- 5. Rental Deposits table
CREATE TABLE IF NOT EXISTS "rental_deposits" (
  "deposit_id" BIGSERIAL PRIMARY KEY,
  "rental_id" BIGINT NOT NULL UNIQUE REFERENCES "button_rentals"("rental_id") ON DELETE CASCADE,
  "collected_amount" DECIMAL(15, 2) NOT NULL DEFAULT 0,
  "held_amount" DECIMAL(15, 2) NOT NULL DEFAULT 0,
  "refund_reserved_amount" DECIMAL(15, 2) NOT NULL DEFAULT 0,
  "refunded_amount" DECIMAL(15, 2) NOT NULL DEFAULT 0,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);

-- 6. Rental Returns table
CREATE TABLE IF NOT EXISTS "rental_returns" (
  "return_id" BIGSERIAL PRIMARY KEY,
  "return_code" VARCHAR(64) NOT NULL UNIQUE,
  "rental_id" BIGINT NOT NULL REFERENCES "button_rentals"("rental_id") ON DELETE RESTRICT,
  "button_id" BIGINT NOT NULL REFERENCES "iot_button"("button_id") ON DELETE RESTRICT,
  "status" VARCHAR(30) NOT NULL DEFAULT 'PENDING_RECEIPT',
  "received_by_user_id" BIGINT,
  "inspected_by_user_id" BIGINT,
  "inspection_note" TEXT,
  "received_at" TIMESTAMPTZ(6),
  "inspected_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "idx_rental_returns_rental_status" ON "rental_returns"("rental_id", "status");
CREATE INDEX IF NOT EXISTS "idx_rental_returns_button" ON "rental_returns"("button_id");

-- 7. Customer Bank Accounts table
CREATE TABLE IF NOT EXISTS "customer_bank_accounts" (
  "id" BIGSERIAL PRIMARY KEY,
  "customer_id" BIGINT NOT NULL REFERENCES "customer_profile"("customer_id") ON DELETE CASCADE,
  "bank_bin" VARCHAR(10) NOT NULL,
  "bank_code" VARCHAR(20),
  "bank_name" VARCHAR(100) NOT NULL,
  "account_number_encrypted" TEXT NOT NULL,
  "account_number_hash" VARCHAR(64) NOT NULL,
  "account_number_masked" VARCHAR(32) NOT NULL,
  "account_name" VARCHAR(255) NOT NULL,
  "verification_status" VARCHAR(32) NOT NULL DEFAULT 'VERIFIED',
  "is_default" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "uq_customer_bank_acc_hash" UNIQUE ("customer_id", "account_number_hash")
);

CREATE INDEX IF NOT EXISTS "idx_customer_bank_default" ON "customer_bank_accounts"("customer_id", "is_default");

-- 8. Deposit Refunds table
CREATE TABLE IF NOT EXISTS "deposit_refunds" (
  "refund_id" BIGSERIAL PRIMARY KEY,
  "refund_code" VARCHAR(64) NOT NULL UNIQUE,
  "return_id" BIGINT REFERENCES "rental_returns"("return_id") ON DELETE SET NULL,
  "rental_id" BIGINT NOT NULL REFERENCES "button_rentals"("rental_id") ON DELETE RESTRICT,
  "customer_id" BIGINT NOT NULL REFERENCES "customer_profile"("customer_id") ON DELETE RESTRICT,
  "bank_account_id" BIGINT REFERENCES "customer_bank_accounts"("id") ON DELETE SET NULL,
  "amount" DECIMAL(15, 2) NOT NULL,
  "status" VARCHAR(30) NOT NULL DEFAULT 'PENDING_APPROVAL',
  "approved_by_user_id" BIGINT,
  "rejection_reason" VARCHAR(255),
  "provider_reference_id" VARCHAR(128) UNIQUE,
  "payout_error" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "refunded_at" TIMESTAMPTZ(6),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "idx_deposit_refunds_customer_status" ON "deposit_refunds"("customer_id", "status");
CREATE INDEX IF NOT EXISTS "idx_deposit_refunds_rental" ON "deposit_refunds"("rental_id");

-- 9. Access Adjustments table
CREATE TABLE IF NOT EXISTS "access_adjustments" (
  "id" BIGSERIAL PRIMARY KEY,
  "target_type" VARCHAR(32) NOT NULL,
  "target_id" BIGINT NOT NULL,
  "operation" VARCHAR(32) NOT NULL,
  "additional_days" INT,
  "previous_expires_at" TIMESTAMPTZ(6),
  "new_expires_at" TIMESTAMPTZ(6) NOT NULL,
  "reason" VARCHAR(255) NOT NULL,
  "actor_user_id" BIGINT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "idx_access_adjustments_target" ON "access_adjustments"("target_type", "target_id");

-- 10. Outbox Events table
CREATE TABLE IF NOT EXISTS "outbox_events" (
  "id" BIGSERIAL PRIMARY KEY,
  "event_type" VARCHAR(64) NOT NULL,
  "payload" JSONB NOT NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  "attempts" INT NOT NULL DEFAULT 0,
  "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "processed_at" TIMESTAMPTZ(6),
  "error" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "idx_outbox_events_status_next" ON "outbox_events"("status", "next_attempt_at");
