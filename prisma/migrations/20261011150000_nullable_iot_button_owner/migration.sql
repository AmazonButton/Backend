-- Migration: 20261011150000_nullable_iot_button_owner
-- Purpose: Allow unclaim & factory reset to nullify customer_id and address_id on iot_button.
-- Disentangles orders from dynamic button ownership context to preserve order integrity.

-- 1. Replace orders composite foreign key with single button_id foreign key
ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "orders_button_id_customer_id_store_id_fkey";

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'orders_button_id_fkey'
    ) THEN
        ALTER TABLE "orders" ADD CONSTRAINT "orders_button_id_fkey"
            FOREIGN KEY ("button_id") REFERENCES "iot_button"("button_id") ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;
END $$;

-- 2. Make customer_id and address_id nullable on iot_button
ALTER TABLE "iot_button" ALTER COLUMN "customer_id" DROP NOT NULL;
ALTER TABLE "iot_button" ALTER COLUMN "address_id" DROP NOT NULL;
