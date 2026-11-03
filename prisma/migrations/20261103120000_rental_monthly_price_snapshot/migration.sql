BEGIN;
ALTER TABLE button_rentals
  ADD COLUMN monthly_rent_per_button_snapshot DECIMAL(15,2),
  ADD COLUMN pricing_review_required BOOLEAN NOT NULL DEFAULT true;

-- Only a unique initial charge with unambiguous structured lines is evidence.
-- Never derive from the mutable catalog, months_rented, or a default price.
WITH unique_initial AS (
  SELECT target_id AS rental_id, MIN(charge_id) AS charge_id
  FROM billing_charges
  WHERE target_type = 'RENTAL' AND purpose = 'RENTAL_INITIAL'
  GROUP BY target_id HAVING COUNT(*) = 1
), evidence AS (
  SELECT i.rental_id, bc.currency, bc.status, bc.total_amount,
    COUNT(*) AS line_count,
    COUNT(*) FILTER (WHERE l.line_type = 'RENT') AS rent_count,
    COUNT(*) FILTER (WHERE l.line_type = 'DEPOSIT') AS deposit_count,
    MAX(l.amount) FILTER (WHERE l.line_type = 'RENT') AS rent_amount,
    MAX(l.amount) FILTER (WHERE l.line_type = 'DEPOSIT') AS deposit_amount,
    MAX(l.quantity) FILTER (WHERE l.line_type = 'RENT') AS quantity,
    MAX(l.duration_count) FILTER (WHERE l.line_type = 'RENT') AS months,
    MAX(l.duration_unit) FILTER (WHERE l.line_type = 'RENT') AS duration_unit
  FROM unique_initial i JOIN billing_charges bc ON bc.charge_id = i.charge_id
  JOIN billing_charge_lines l ON l.charge_id = bc.charge_id
  GROUP BY i.rental_id, bc.currency, bc.status, bc.total_amount
)
UPDATE button_rentals r
SET monthly_rent_per_button_snapshot = e.rent_amount / NULLIF(e.quantity::numeric * e.months, 0),
    pricing_review_required = false
FROM evidence e
WHERE r.rental_id = e.rental_id
  AND e.currency = 'VND' AND e.status IN ('PENDING', 'PAID')
  AND e.line_count = 2 AND e.rent_count = 1 AND e.deposit_count = 1
  AND e.quantity = r.button_quantity AND e.quantity BETWEEN 1 AND 100
  AND e.months BETWEEN 1 AND 120 AND e.duration_unit = 'MONTH'
  AND e.rent_amount > 0 AND e.rent_amount = trunc(e.rent_amount)
  AND e.deposit_amount = r.deposit_amount
  AND e.total_amount = e.rent_amount + e.deposit_amount
  AND MOD(e.rent_amount, NULLIF(e.quantity::numeric * e.months, 0)) = 0;

ALTER TABLE button_rentals ADD CONSTRAINT ck_rental_monthly_snapshot CHECK (
  (monthly_rent_per_button_snapshot IS NULL AND pricing_review_required = true)
  OR (monthly_rent_per_button_snapshot IS NOT NULL AND monthly_rent_per_button_snapshot > 0
      AND monthly_rent_per_button_snapshot = trunc(monthly_rent_per_button_snapshot)
      AND pricing_review_required = false)
);
CREATE INDEX idx_rental_pricing_review ON button_rentals (rental_id) WHERE pricing_review_required = true;

CREATE FUNCTION protect_rental_monthly_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.monthly_rent_per_button_snapshot IS NOT NULL
     AND NEW.monthly_rent_per_button_snapshot IS DISTINCT FROM OLD.monthly_rent_per_button_snapshot THEN
    RAISE EXCEPTION 'Rental monthly price snapshot is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_protect_rental_monthly_snapshot BEFORE UPDATE ON button_rentals
FOR EACH ROW EXECUTE FUNCTION protect_rental_monthly_snapshot();
-- No historical device status is reset: legacy INACTIVE has ambiguous cause.
COMMIT;
