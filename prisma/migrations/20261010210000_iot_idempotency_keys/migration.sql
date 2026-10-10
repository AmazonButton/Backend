-- CreateTable
CREATE TABLE IF NOT EXISTS "iot_idempotency_keys" (
    "id" BIGSERIAL NOT NULL,
    "device_id" BIGINT NOT NULL,
    "request_id" VARCHAR(128) NOT NULL,
    "order_id" BIGINT,
    "status" VARCHAR(20) NOT NULL DEFAULT 'PROCESSING',
    "locked_until" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "iot_idempotency_keys_pkey" PRIMARY KEY ("id")
);

-- AlterTable existing if columns missing
ALTER TABLE "iot_idempotency_keys" ADD COLUMN IF NOT EXISTS "status" VARCHAR(20) NOT NULL DEFAULT 'PROCESSING';
ALTER TABLE "iot_idempotency_keys" ADD COLUMN IF NOT EXISTS "locked_until" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "iot_idempotency_keys" ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;

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
-- Support REFUND_PENDING in check constraints
ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "orders_payment_status_check";
ALTER TABLE "orders" ADD CONSTRAINT "orders_payment_status_check"
CHECK (((payment_status)::text = ANY (ARRAY['UNPAID', 'PAID', 'REFUNDED', 'REFUND_PENDING']::text[])));

ALTER TABLE "payment_transaction" DROP CONSTRAINT IF EXISTS "payment_transaction_status_check";
ALTER TABLE "payment_transaction" ADD CONSTRAINT "payment_transaction_status_check"
CHECK (((status)::text = ANY (ARRAY['PENDING', 'SUCCESS', 'PAID', 'FAILED', 'CANCELLED', 'EXPIRED', 'REFUND_PENDING']::text[])));
