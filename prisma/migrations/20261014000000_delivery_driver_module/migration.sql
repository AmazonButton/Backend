-- ====================================================================
-- MIGRATION: 20261014000000_delivery_driver_module
-- BRD V2.1 Multi-Store Delivery Driver Platform
-- ====================================================================

-- 1. Alter Table orders
ALTER TABLE "orders"
  ADD COLUMN IF NOT EXISTS "assigned_driver_id" BIGINT,
  ADD COLUMN IF NOT EXISTS "pod_image_url" VARCHAR(1000),
  ADD COLUMN IF NOT EXISTS "delivered_at" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "failure_reason_code" VARCHAR(50),
  ADD COLUMN IF NOT EXISTS "failure_note" TEXT,
  ADD COLUMN IF NOT EXISTS "evidence_image_url" VARCHAR(1000),
  ADD COLUMN IF NOT EXISTS "shipping_latitude" DECIMAL(10, 7),
  ADD COLUMN IF NOT EXISTS "shipping_longitude" DECIMAL(10, 7);

-- 2. Alter Table customer_address
ALTER TABLE "customer_address"
  ADD COLUMN IF NOT EXISTS "latitude" DECIMAL(10, 7),
  ADD COLUMN IF NOT EXISTS "longitude" DECIMAL(10, 7);

-- 3. Create Table driver_duties
CREATE TABLE IF NOT EXISTS "driver_duties" (
  "driver_duty_id" BIGSERIAL PRIMARY KEY,
  "driver_id" BIGINT UNIQUE NOT NULL,
  "store_id" BIGINT NOT NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'OFFLINE',
  "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);

-- 4. Create Table driver_shifts
CREATE TABLE IF NOT EXISTS "driver_shifts" (
  "shift_id" BIGSERIAL PRIMARY KEY,
  "store_id" BIGINT NOT NULL,
  "driver_id" BIGINT NOT NULL,
  "status" VARCHAR(30) NOT NULL DEFAULT 'OPEN',
  "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "ended_at" TIMESTAMPTZ(6),
  "handed_over_at" TIMESTAMPTZ(6),
  "confirmed_by_user_id" BIGINT,
  "handover_code" VARCHAR(50),
  "total_orders_delivered" INTEGER NOT NULL DEFAULT 0,
  "total_orders_failed" INTEGER NOT NULL DEFAULT 0,
  "total_cod_collected" DECIMAL(15, 2) NOT NULL DEFAULT 0,
  "total_vietqr_collected" DECIMAL(15, 2) NOT NULL DEFAULT 0,
  "handover_note" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);

-- 5. Unique Indexes
CREATE UNIQUE INDEX IF NOT EXISTS "driver_duties_driver_id_key" ON "driver_duties"("driver_id");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_driver_open_shift" ON "driver_shifts"("driver_id") WHERE "status" = 'OPEN';

-- 6. Foreign Key Constraints
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_assigned_driver_id_fkey') THEN
    ALTER TABLE "orders" ADD CONSTRAINT "orders_assigned_driver_id_fkey" FOREIGN KEY ("assigned_driver_id") REFERENCES "users"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'driver_duties_driver_id_fkey') THEN
    ALTER TABLE "driver_duties" ADD CONSTRAINT "driver_duties_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'driver_duties_store_id_fkey') THEN
    ALTER TABLE "driver_duties" ADD CONSTRAINT "driver_duties_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "store"("store_id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'driver_shifts_store_id_fkey') THEN
    ALTER TABLE "driver_shifts" ADD CONSTRAINT "driver_shifts_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "store"("store_id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'driver_shifts_driver_id_fkey') THEN
    ALTER TABLE "driver_shifts" ADD CONSTRAINT "driver_shifts_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "users"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'driver_shifts_confirmed_by_user_id_fkey') THEN
    ALTER TABLE "driver_shifts" ADD CONSTRAINT "driver_shifts_confirmed_by_user_id_fkey" FOREIGN KEY ("confirmed_by_user_id") REFERENCES "users"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- 7. Seed Role STAFF_DELIVERY
INSERT INTO "roles" ("role_code", "role_name", "description")
VALUES ('STAFF_DELIVERY', 'Delivery Driver Staff', 'Nhân viên giao hàng của cửa hàng')
ON CONFLICT ("role_code") DO NOTHING;
