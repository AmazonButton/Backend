-- CreateTable
CREATE TABLE IF NOT EXISTS "warranty_tickets" (
    "ticket_id" BIGSERIAL NOT NULL,
    "ticket_code" VARCHAR(32) NOT NULL,
    "button_id" BIGINT NOT NULL,
    "replacement_button_id" BIGINT,
    "store_id" BIGINT,
    "customer_id" BIGINT,
    "reported_by_user_id" BIGINT NOT NULL,
    "fault_group" VARCHAR(20) NOT NULL,
    "fault_code" VARCHAR(50) NOT NULL,
    "deposit_amount" DECIMAL(15,2) NOT NULL DEFAULT 100000,
    "deduction_percent" INTEGER NOT NULL DEFAULT 0,
    "deduction_amount" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "refund_amount" DECIMAL(15,2) NOT NULL DEFAULT 100000,
    "inspection_note" TEXT,
    "admin_note" TEXT,
    "status" VARCHAR(30) NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "warranty_tickets_pkey" PRIMARY KEY ("ticket_id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "warranty_tickets_ticket_code_key" ON "warranty_tickets"("ticket_code");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_warranty_tickets_store_status" ON "warranty_tickets"("store_id", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_warranty_tickets_button" ON "warranty_tickets"("button_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_warranty_tickets_reporter" ON "warranty_tickets"("reported_by_user_id");

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'warranty_tickets_button_id_fkey'
    ) THEN
        ALTER TABLE "warranty_tickets" ADD CONSTRAINT "warranty_tickets_button_id_fkey" FOREIGN KEY ("button_id") REFERENCES "iot_button"("button_id") ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'warranty_tickets_replacement_button_id_fkey'
    ) THEN
        ALTER TABLE "warranty_tickets" ADD CONSTRAINT "warranty_tickets_replacement_button_id_fkey" FOREIGN KEY ("replacement_button_id") REFERENCES "iot_button"("button_id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'warranty_tickets_store_id_fkey'
    ) THEN
        ALTER TABLE "warranty_tickets" ADD CONSTRAINT "warranty_tickets_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "store"("store_id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'warranty_tickets_customer_id_fkey'
    ) THEN
        ALTER TABLE "warranty_tickets" ADD CONSTRAINT "warranty_tickets_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer_profile"("customer_id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'warranty_tickets_reported_by_user_id_fkey'
    ) THEN
        ALTER TABLE "warranty_tickets" ADD CONSTRAINT "warranty_tickets_reported_by_user_id_fkey" FOREIGN KEY ("reported_by_user_id") REFERENCES "users"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;
END $$;
