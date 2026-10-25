-- Migration: Add database check constraints for product discounts
-- 1. Ensure start_at < end_at
ALTER TABLE "product_discount" 
DROP CONSTRAINT IF EXISTS "chk_discount_time_range";

ALTER TABLE "product_discount" 
ADD CONSTRAINT "chk_discount_time_range" 
CHECK ("start_at" < "end_at");

-- 2. Mutual exclusivity between discount_percent and discount_amount
ALTER TABLE "product_discount" 
DROP CONSTRAINT IF EXISTS "chk_discount_exclusivity";

ALTER TABLE "product_discount" 
ADD CONSTRAINT "chk_discount_exclusivity" 
CHECK (
  ("discount_percent" IS NOT NULL AND "discount_amount" IS NULL) OR 
  ("discount_percent" IS NULL AND "discount_amount" IS NOT NULL)
);

-- 3. Non-negative and valid ranges
ALTER TABLE "product_discount" 
DROP CONSTRAINT IF EXISTS "chk_discount_values";

ALTER TABLE "product_discount" 
ADD CONSTRAINT "chk_discount_values" 
CHECK (
  ("discount_percent" IS NULL OR ("discount_percent" >= 0 AND "discount_percent" <= 100)) AND
  ("discount_amount" IS NULL OR "discount_amount" >= 0)
);
