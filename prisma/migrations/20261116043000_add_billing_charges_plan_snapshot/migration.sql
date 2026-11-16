-- AlterTable
ALTER TABLE "billing_charges" ADD COLUMN IF NOT EXISTS "plan_id" BIGINT,
ADD COLUMN IF NOT EXISTS "plan_snapshot" JSONB;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_billing_charges_plan" ON "billing_charges"("plan_id");

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'billing_charges_plan_id_fkey'
    ) THEN
        ALTER TABLE "billing_charges" ADD CONSTRAINT "billing_charges_plan_id_fkey" 
        FOREIGN KEY ("plan_id") REFERENCES "subscription_plans"("plan_id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END $$;
