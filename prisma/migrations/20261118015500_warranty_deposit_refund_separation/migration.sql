-- Migration: 20261118015500_warranty_deposit_refund_separation
-- 1. Link warranty-triggered deposit refund proposals to warranty_tickets with explicit deduction_amount
--    so rental_deposits is settled ONCE ONLY during admin approveDepositRefundTx (never double-held).
-- 2. Enforce at most one active PENDING warranty ticket per button_id at database level.

ALTER TABLE "deposit_refunds"
  ADD COLUMN IF NOT EXISTS "warranty_ticket_id" BIGINT,
  ADD COLUMN IF NOT EXISTS "deduction_amount" DECIMAL(15, 2) NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS "uq_deposit_refunds_warranty_ticket_id"
  ON "deposit_refunds"("warranty_ticket_id")
  WHERE "warranty_ticket_id" IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'deposit_refunds_warranty_ticket_id_fkey'
  ) THEN
    ALTER TABLE "deposit_refunds"
      ADD CONSTRAINT "deposit_refunds_warranty_ticket_id_fkey"
      FOREIGN KEY ("warranty_ticket_id") REFERENCES "warranty_tickets"("ticket_id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "uq_warranty_tickets_pending_button"
  ON "warranty_tickets"("button_id")
  WHERE "status" = 'PENDING';
