-- Additive migration: Snapshot rental_id at warranty ticket creation time.
-- Intentionally DO NOT backfill legacy tickets from iot_button.rental_id so stale tickets
-- without a rental snapshot trigger 409 Conflict manual reconciliation instead of silently
-- binding to a newer rental contract.

ALTER TABLE "warranty_tickets" ADD COLUMN IF NOT EXISTS "rental_id" BIGINT;

CREATE INDEX IF NOT EXISTS "idx_warranty_tickets_rental" ON "warranty_tickets"("rental_id");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'warranty_tickets_rental_id_fkey'
  ) THEN
    ALTER TABLE "warranty_tickets"
      ADD CONSTRAINT "warranty_tickets_rental_id_fkey"
      FOREIGN KEY ("rental_id") REFERENCES "button_rentals"("rental_id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
