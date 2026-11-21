-- Database-level ACID Consistency & Inventory Non-Negativity Invariants

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_inventory_non_negative_and_reserved_bound'
  ) THEN
    ALTER TABLE inventory
      ADD CONSTRAINT chk_inventory_non_negative_and_reserved_bound
      CHECK (quantity_on_hand >= 0 AND reserved_quantity >= 0 AND reserved_quantity <= quantity_on_hand);
  END IF;
END $$;
