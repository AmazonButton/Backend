-- Migration: Add partial unique index to enforce single default address per customer
CREATE UNIQUE INDEX IF NOT EXISTS "uq_customer_single_default" 
ON "customer_address"("customer_id") 
WHERE "is_default" = true;
