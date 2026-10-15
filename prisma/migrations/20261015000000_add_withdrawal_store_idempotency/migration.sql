-- AlterTable
ALTER TABLE "store_withdrawals" ADD COLUMN IF NOT EXISTS "store_id" BIGINT;
ALTER TABLE "store_withdrawals" ADD COLUMN IF NOT EXISTS "idempotency_key" VARCHAR(255);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "uq_store_withdrawals_store_idempotency" ON "store_withdrawals"("store_id", "idempotency_key") WHERE "idempotency_key" IS NOT NULL;

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_store_withdrawals_store'
  ) THEN
    ALTER TABLE "store_withdrawals" 
    ADD CONSTRAINT "fk_store_withdrawals_store" 
    FOREIGN KEY ("store_id") REFERENCES "store"("store_id") ON DELETE SET NULL;
  END IF;
END $$;
