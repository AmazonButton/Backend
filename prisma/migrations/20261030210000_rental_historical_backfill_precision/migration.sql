-- Migration 5: Precision Historical Backfill & Reconciliation Audit
-- Fixes R05, R07 precision edge cases identified during audit review

-- 1. Precision backfill for deposit_per_button:
-- Always divide package total deposit by button_quantity; prioritize actual collected deposit from rental_deposits
UPDATE button_rentals br
SET deposit_per_button = COALESCE(
    (
        SELECT ROUND(rd.collected_amount / NULLIF(COALESCE(br.button_quantity, 1), 0))
        FROM rental_deposits rd
        WHERE rd.rental_id = br.rental_id AND rd.collected_amount > 0
    ),
    ROUND(rp.deposit_fee / NULLIF(COALESCE(br.button_quantity, rp.button_quantity, 1), 0))
)
FROM rental_packages rp
WHERE br.package_id = rp.package_id;

-- 2. Precision backfill for rent_per_button:
UPDATE button_rentals br
SET rent_per_button = ROUND(rp.monthly_price / NULLIF(COALESCE(br.button_quantity, rp.button_quantity, 1), 0))
FROM rental_packages rp
WHERE br.package_id = rp.package_id;

-- 3. Precision backfill for billing_charge_lines (RENT lines):
-- Do NOT use br.months_rented (which represents cumulative lifetime across all renewals)!
-- Instead, parse specific duration from description or derive strictly from line amount.

-- 3a. Extract duration_count from description if explicit pattern like "2 tháng" or "months: 2" exists
UPDATE billing_charge_lines bcl
SET duration_unit = 'MONTH',
    duration_count = COALESCE(
        NULLIF(SUBSTRING(bcl.description FROM '([0-9]+)\s*(?:tháng|month)'), '')::INTEGER,
        NULLIF(SUBSTRING(bcl.description FROM 'months:\s*([0-9]+)'), '')::INTEGER
    )
FROM billing_charges bc
WHERE bcl.charge_id = bc.charge_id
  AND bc.target_type = 'RENTAL'
  AND bcl.line_type = 'RENT'
  AND (
      bcl.description ~* '[0-9]+\s*(?:tháng|month)'
      OR bcl.description ~* 'months:\s*[0-9]+'
  );

-- 3b. For RENTAL_INITIAL charges where description lacks month count:
-- If line amount matches 1 period unit price (or package monthly price), duration_count is 1.
UPDATE billing_charge_lines bcl
SET duration_unit = 'MONTH',
    duration_count = CASE
        WHEN rp.monthly_price > 0 AND bcl.amount >= rp.monthly_price AND (bcl.amount % rp.monthly_price = 0)
            THEN CAST(bcl.amount / rp.monthly_price AS INTEGER)
        ELSE 1
    END,
    quantity = GREATEST(COALESCE(br.button_quantity, 1), 1),
    unit_price = CASE
        WHEN rp.monthly_price > 0 AND bcl.amount >= rp.monthly_price AND (bcl.amount % rp.monthly_price = 0)
            THEN rp.monthly_price
        ELSE bcl.amount
    END
FROM billing_charges bc
JOIN button_rentals br ON bc.target_id = br.rental_id
LEFT JOIN rental_packages rp ON br.package_id = rp.package_id
WHERE bcl.charge_id = bc.charge_id
  AND bc.target_type = 'RENTAL'
  AND bcl.line_type = 'RENT'
  AND bc.purpose = 'RENTAL_INITIAL'
  AND (bcl.duration_count IS NULL OR bcl.duration_count = 0);

-- 3c. For RENTAL_EXTENSION charges:
-- Derive duration_count strictly from bcl.amount / monthly_price
UPDATE billing_charge_lines bcl
SET duration_unit = 'MONTH',
    duration_count = CASE
        WHEN rp.monthly_price > 0 AND bcl.amount >= rp.monthly_price AND (bcl.amount % rp.monthly_price = 0)
            THEN CAST(bcl.amount / rp.monthly_price AS INTEGER)
        ELSE 1
    END,
    quantity = GREATEST(COALESCE(br.button_quantity, 1), 1),
    unit_price = CASE
        WHEN rp.monthly_price > 0
            THEN rp.monthly_price
        ELSE bcl.amount
    END
FROM billing_charges bc
JOIN button_rentals br ON bc.target_id = br.rental_id
LEFT JOIN rental_packages rp ON br.package_id = rp.package_id
WHERE bcl.charge_id = bc.charge_id
  AND bc.target_type = 'RENTAL'
  AND bcl.line_type = 'RENT'
  AND bc.purpose = 'RENTAL_EXTENSION'
  AND (bcl.duration_count IS NULL OR bcl.duration_count = 0);

-- 4. Flag ambiguous historical charges for manual operator reconciliation instead of blind assumptions
INSERT INTO rental_audit_logs (
    actor_type,
    action,
    target_type,
    target_id,
    before_state,
    after_state,
    reason,
    metadata
)
SELECT 
    'SYSTEM',
    'RECONCILIATION_FLAGGED',
    'BILLING_CHARGE',
    bc.charge_id,
    bc.status,
    bc.status,
    'Historical charge line duration required approximation and is marked for manual operator verification',
    json_build_object(
        'chargeCode', bc.charge_code,
        'lineId', bcl.line_id,
        'amount', bcl.amount,
        'description', bcl.description,
        'inferredDuration', bcl.duration_count
    )
FROM billing_charges bc
JOIN billing_charge_lines bcl ON bc.charge_id = bcl.charge_id
WHERE bc.target_type = 'RENTAL'
  AND bcl.line_type = 'RENT'
  AND bcl.duration_count IS NULL;
