-- Deduplicate any existing multiple default bank accounts for the same customer by keeping only the latest one
WITH ranked_defaults AS (
  SELECT id, customer_id,
         ROW_NUMBER() OVER(PARTITION BY customer_id ORDER BY updated_at DESC, id DESC) as rn
  FROM customer_bank_accounts
  WHERE is_default = true
)
UPDATE customer_bank_accounts
SET is_default = false
WHERE id IN (
  SELECT id FROM ranked_defaults WHERE rn > 1
);

-- Create partial unique index ensuring only one default bank account per customer
CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_bank_one_default
ON customer_bank_accounts (customer_id)
WHERE is_default = true;
