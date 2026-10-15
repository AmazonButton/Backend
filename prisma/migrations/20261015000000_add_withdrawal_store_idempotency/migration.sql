-- AlterTable
ALTER TABLE "store_withdrawals" ADD COLUMN IF NOT EXISTS "store_id" BIGINT;
ALTER TABLE "store_withdrawals" ADD COLUMN IF NOT EXISTS "idempotency_key" VARCHAR(255);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "uq_store_withdrawals_store_idempotency" ON "store_withdrawals"("store_id", "idempotency_key") WHERE "idempotency_key" IS NOT NULL;
