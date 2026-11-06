-- AlterTable: Add payer_store_id column to billing_charges
ALTER TABLE "billing_charges" 
ADD COLUMN IF NOT EXISTS "payer_store_id" BIGINT;

ALTER TABLE "billing_charges"
DROP CONSTRAINT IF EXISTS "fk_billing_charges_payer_store";

ALTER TABLE "billing_charges"
ADD CONSTRAINT "fk_billing_charges_payer_store"
FOREIGN KEY ("payer_store_id") REFERENCES "store"("store_id") ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS "idx_billing_charges_payer_store" ON "billing_charges"("payer_store_id");

-- AlterTable: Add billing_policy column with default to button_rentals
ALTER TABLE "button_rentals" 
ADD COLUMN IF NOT EXISTS "billing_policy" VARCHAR(50) NOT NULL DEFAULT 'STORE_RENT_CUSTOMER_DEPOSIT';

-- Check constraint for allowed values
ALTER TABLE "button_rentals" 
DROP CONSTRAINT IF EXISTS "chk_button_rentals_billing_policy";

ALTER TABLE "button_rentals" 
ADD CONSTRAINT "chk_button_rentals_billing_policy" 
CHECK ("billing_policy" IN ('LEGACY_CUSTOMER_RENT', 'STORE_RENT_CUSTOMER_DEPOSIT'));

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_button_rentals_billing_policy" ON "button_rentals"("billing_policy");

-- AlterTable: Add billing_policy_review_required column (independent of pricing_review_required to prevent ck_rental_monthly_snapshot violation)
ALTER TABLE "button_rentals"
ADD COLUMN IF NOT EXISTS "billing_policy_review_required" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_button_rentals_policy_review" ON "button_rentals"("billing_policy_review_required");

-- Step 0: Flag all existing rentals as requiring review by default (safe containment)
UPDATE "button_rentals"
SET "billing_policy_review_required" = true;

-- Step 1: Backfill CLEAR LEGACY contracts at the RENTAL level (strictly 1 initial charge with 1 RENT line > 0 and 1 DEPOSIT line >= 0 matching total amount)
UPDATE "button_rentals" br
SET "billing_policy" = 'LEGACY_CUSTOMER_RENT',
    "billing_policy_review_required" = false
WHERE br.rental_id IN (
    SELECT bc.target_id
    FROM "billing_charges" bc
    LEFT JOIN "billing_charge_lines" bcl ON bc.charge_id = bcl.charge_id
    WHERE bc.target_type = 'RENTAL'
      AND bc.purpose = 'RENTAL_INITIAL'
    GROUP BY bc.target_id
    HAVING COUNT(DISTINCT bc.charge_id) = 1
       AND COUNT(bcl.line_id) = 2
       AND COUNT(bcl.line_id) FILTER (WHERE bcl.line_type = 'RENT' AND bcl.amount > 0 AND bcl.duration_count > 0) = 1
       AND COUNT(bcl.line_id) FILTER (WHERE bcl.line_type = 'RENT') = 1
       AND COUNT(bcl.line_id) FILTER (WHERE bcl.line_type = 'DEPOSIT' AND bcl.amount >= 0) = 1
       AND SUM(bcl.amount) = MAX(bc.total_amount)
);

-- Step 2: Backfill CLEAR DEPOSIT ONLY contracts at the RENTAL level (strictly 1 initial charge with 1 DEPOSIT line > 0 and 0 RENT lines matching total amount)
UPDATE "button_rentals" br
SET "billing_policy" = 'STORE_RENT_CUSTOMER_DEPOSIT',
    "billing_policy_review_required" = false
WHERE br.rental_id IN (
    SELECT bc.target_id
    FROM "billing_charges" bc
    LEFT JOIN "billing_charge_lines" bcl ON bc.charge_id = bcl.charge_id
    WHERE bc.target_type = 'RENTAL'
      AND bc.purpose = 'RENTAL_INITIAL'
    GROUP BY bc.target_id
    HAVING COUNT(DISTINCT bc.charge_id) = 1
       AND COUNT(bcl.line_id) = 1
       AND COUNT(bcl.line_id) FILTER (WHERE bcl.line_type = 'DEPOSIT' AND bcl.amount > 0) = 1
       AND COUNT(bcl.line_id) FILTER (WHERE bcl.line_type = 'RENT') = 0
       AND SUM(bcl.amount) = MAX(bc.total_amount)
);

-- Trigger to guarantee immutability of billing_policy after insertion
CREATE OR REPLACE FUNCTION check_button_rental_policy_immutable()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.billing_policy IS NOT NULL AND NEW.billing_policy <> OLD.billing_policy THEN
        RAISE EXCEPTION 'CANNOT_MUTATE_RENTAL_BILLING_POLICY: billing_policy is an immutable contract snapshot';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_button_rental_policy_immutable ON "button_rentals";
CREATE TRIGGER trg_button_rental_policy_immutable
BEFORE UPDATE OF billing_policy ON "button_rentals"
FOR EACH ROW
EXECUTE FUNCTION check_button_rental_policy_immutable();
