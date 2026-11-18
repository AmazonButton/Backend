-- Migration: 20261118003000_warranty_swap_and_lock_invariants
-- Additive database constraints preventing self-swap and duplicate replacement button assignments across active/resolved warranty tickets.

CREATE UNIQUE INDEX IF NOT EXISTS "uq_warranty_tickets_active_replacement_button"
  ON "warranty_tickets"("replacement_button_id")
  WHERE "replacement_button_id" IS NOT NULL AND "status" IN ('PENDING', 'APPROVED_SWAP', 'RESOLVED');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_warranty_tickets_distinct_replacement'
  ) THEN
    ALTER TABLE "warranty_tickets"
      ADD CONSTRAINT "chk_warranty_tickets_distinct_replacement"
      CHECK ("replacement_button_id" IS NULL OR "replacement_button_id" <> "button_id");
  END IF;
END $$;
