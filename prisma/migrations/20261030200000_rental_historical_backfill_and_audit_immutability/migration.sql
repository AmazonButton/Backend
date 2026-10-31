-- Migration 4: Historical Contract Snapshot Backfill & Append-Only Audit Trigger
-- Fixes R05, R07, R08

-- 1. Backfill snapshot fields on button_rentals
UPDATE button_rentals br
SET button_quantity = COALESCE(rp.button_quantity, (
    SELECT COUNT(*) FROM iot_button b WHERE b.rental_id = br.rental_id
), 1)
FROM rental_packages rp
WHERE br.package_id = rp.package_id
  AND (br.button_quantity IS NULL OR br.button_quantity = 0);

UPDATE button_rentals br
SET deposit_per_button = COALESCE(
    (SELECT rd.collected_amount / NULLIF(br.button_quantity, 0) FROM rental_deposits rd WHERE rd.rental_id = br.rental_id),
    rp.deposit_fee,
    200000
)
FROM rental_packages rp
WHERE br.package_id = rp.package_id
  AND (br.deposit_per_button IS NULL OR br.deposit_per_button = 0);

UPDATE button_rentals br
SET rent_per_button = COALESCE(
    rp.monthly_price / NULLIF(br.button_quantity, 0),
    30000
)
FROM rental_packages rp
WHERE br.package_id = rp.package_id
  AND (br.rent_per_button IS NULL OR br.rent_per_button = 0);

-- 2. Backfill effective_expires_at & paid_through for active rentals
UPDATE button_rentals
SET effective_expires_at = COALESCE(end_date, start_date + INTERVAL '30 days', created_at + INTERVAL '30 days'),
    paid_through = COALESCE(paid_through, end_date, start_date + INTERVAL '30 days', created_at + INTERVAL '30 days')
WHERE status = 'ACTIVE' AND effective_expires_at IS NULL;

-- 3. Backfill structured line items on billing_charge_lines
UPDATE billing_charge_lines bcl
SET duration_unit = 'MONTH',
    duration_count = GREATEST(COALESCE(br.months_rented, 1), 1),
    quantity = GREATEST(COALESCE(br.button_quantity, 1), 1),
    unit_price = ROUND(bcl.amount / NULLIF(GREATEST(COALESCE(br.months_rented, 1), 1) * GREATEST(COALESCE(br.button_quantity, 1), 1), 0))
FROM billing_charges bc
JOIN button_rentals br ON bc.target_id = br.rental_id
WHERE bcl.charge_id = bc.charge_id
  AND bc.target_type = 'RENTAL'
  AND bcl.line_type = 'RENT'
  AND (bcl.duration_unit IS NULL OR bcl.duration_count IS NULL);

UPDATE billing_charge_lines bcl
SET duration_unit = 'SESSION',
    duration_count = 1,
    quantity = GREATEST(COALESCE(br.button_quantity, 1), 1),
    unit_price = ROUND(bcl.amount / NULLIF(GREATEST(COALESCE(br.button_quantity, 1), 1), 0))
FROM billing_charges bc
JOIN button_rentals br ON bc.target_id = br.rental_id
WHERE bcl.charge_id = bc.charge_id
  AND bc.target_type = 'RENTAL'
  AND bcl.line_type = 'DEPOSIT'
  AND (bcl.duration_unit IS NULL OR bcl.duration_count IS NULL);

-- 4. Enforce strict Append-Only Immutability on rental_audit_logs
CREATE OR REPLACE FUNCTION prevent_rental_audit_logs_mutation()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'rental_audit_logs is append-only and cannot be updated or deleted';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prevent_rental_audit_logs_mutation ON rental_audit_logs;
CREATE TRIGGER trg_prevent_rental_audit_logs_mutation
BEFORE UPDATE OR DELETE ON rental_audit_logs
FOR EACH ROW
EXECUTE FUNCTION prevent_rental_audit_logs_mutation();
