-- AlterTable: Add delivery origin coordinates to store
ALTER TABLE "store"
  ADD COLUMN IF NOT EXISTS "latitude" DECIMAL(10, 7),
  ADD COLUMN IF NOT EXISTS "longitude" DECIMAL(10, 7);

-- Backfill default Ho Chi Minh City coordinates for existing ACTIVE stores that have null coordinates
UPDATE "store"
SET
  "latitude" = 10.7768890,
  "longitude" = 106.7008060
WHERE "status" = 'ACTIVE'
  AND ("latitude" IS NULL OR "longitude" IS NULL);

-- AlterTable: Add delivery eligibility snapshot fields to orders
ALTER TABLE "orders"
  ADD COLUMN IF NOT EXISTS "delivery_address_id" BIGINT,
  ADD COLUMN IF NOT EXISTS "delivery_distance_meters" INTEGER,
  ADD COLUMN IF NOT EXISTS "delivery_distance_source" VARCHAR(50);
