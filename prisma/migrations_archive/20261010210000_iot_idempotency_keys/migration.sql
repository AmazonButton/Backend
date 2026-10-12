-- CreateTable
CREATE TABLE IF NOT EXISTS "iot_idempotency_keys" (
    "id" BIGSERIAL NOT NULL,
    "device_id" BIGINT NOT NULL,
    "request_id" VARCHAR(128) NOT NULL,
    "order_id" BIGINT,
    "status" VARCHAR(20) NOT NULL DEFAULT 'PROCESSING',
    "lease_token" VARCHAR(64),
    "locked_until" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "iot_idempotency_keys_pkey" PRIMARY KEY ("id")
);

-- Delete null device_id rows if existing from legacy schema
DELETE FROM "iot_idempotency_keys" WHERE "device_id" IS NULL;

-- Ensure device_id is NOT NULL
ALTER TABLE "iot_idempotency_keys" ALTER COLUMN "device_id" SET NOT NULL;

-- AlterTable existing if columns missing
ALTER TABLE "iot_idempotency_keys" ADD COLUMN IF NOT EXISTS "status" VARCHAR(20) NOT NULL DEFAULT 'PROCESSING';
ALTER TABLE "iot_idempotency_keys" ADD COLUMN IF NOT EXISTS "lease_token" VARCHAR(64);
ALTER TABLE "iot_idempotency_keys" ADD COLUMN IF NOT EXISTS "locked_until" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "iot_idempotency_keys" ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Check constraints for state machine integrity
ALTER TABLE "iot_idempotency_keys" DROP CONSTRAINT IF EXISTS "chk_iot_idempotency_status";
ALTER TABLE "iot_idempotency_keys" ADD CONSTRAINT "chk_iot_idempotency_status"
    CHECK (status IN ('PROCESSING', 'COMPLETED', 'FAILED'));

ALTER TABLE "iot_idempotency_keys" DROP CONSTRAINT IF EXISTS "chk_iot_idempotency_completed_order";
ALTER TABLE "iot_idempotency_keys" ADD CONSTRAINT "chk_iot_idempotency_completed_order"
    CHECK (status <> 'COMPLETED' OR order_id IS NOT NULL);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "uq_iot_idempotency_device_request" ON "iot_idempotency_keys"("device_id", "request_id");
CREATE INDEX IF NOT EXISTS "idx_iot_idempotency_request_id" ON "iot_idempotency_keys"("request_id");

-- Foreign Keys
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'iot_idempotency_keys_device_id_fkey') THEN
        ALTER TABLE "iot_idempotency_keys" ADD CONSTRAINT "iot_idempotency_keys_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "iot_button"("button_id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'iot_idempotency_keys_order_id_fkey') THEN
        ALTER TABLE "iot_idempotency_keys" ADD CONSTRAINT "iot_idempotency_keys_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("order_id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END $$;

-- Add iot_request_id to orders table with unique constraint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "iot_request_id" VARCHAR(128);
ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "uq_orders_button_request";
ALTER TABLE "orders" ADD CONSTRAINT "uq_orders_button_request" UNIQUE ("button_id", "iot_request_id");

-- Support REFUND_PENDING in check constraints
ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "orders_payment_status_check";
ALTER TABLE "orders" ADD CONSTRAINT "orders_payment_status_check"
CHECK (((payment_status)::text = ANY (ARRAY['UNPAID', 'PAID', 'REFUNDED', 'REFUND_PENDING']::text[])));

ALTER TABLE "payment_transaction" DROP CONSTRAINT IF EXISTS "payment_transaction_status_check";
ALTER TABLE "payment_transaction" ADD CONSTRAINT "payment_transaction_status_check"
CHECK (((status)::text = ANY (ARRAY['PENDING', 'SUCCESS', 'PAID', 'FAILED', 'CANCELLED', 'EXPIRED', 'REFUND_PENDING']::text[])));
