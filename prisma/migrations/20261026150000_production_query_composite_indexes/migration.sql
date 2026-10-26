-- 1. Orders table composite indexes for store managers, customers, and drivers
CREATE INDEX IF NOT EXISTS "idx_orders_store_status_created"
    ON "orders"("store_id", "order_status", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "idx_orders_customer_status_created"
    ON "orders"("customer_id", "order_status", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "idx_orders_driver_status"
    ON "orders"("assigned_driver_id", "order_status");

CREATE INDEX IF NOT EXISTS "idx_orders_order_date"
    ON "orders"("order_date" DESC);

-- 2. Payment Transaction composite indexes
CREATE INDEX IF NOT EXISTS "idx_payment_tx_order_status"
    ON "payment_transaction"("order_id", "status");

CREATE INDEX IF NOT EXISTS "idx_payment_tx_rental_status"
    ON "payment_transaction"("rental_id", "status");

CREATE INDEX IF NOT EXISTS "idx_payment_tx_created_at"
    ON "payment_transaction"("created_at" DESC);

-- 3. Store Withdrawal composite indexes
CREATE INDEX IF NOT EXISTS "idx_store_withdrawals_store_status_created"
    ON "store_withdrawals"("store_id", "status", "created_at" DESC);

-- 4. Button Rentals composite indexes
CREATE INDEX IF NOT EXISTS "idx_button_rentals_customer_status"
    ON "button_rentals"("customer_id", "status");

CREATE INDEX IF NOT EXISTS "idx_button_rentals_package_status"
    ON "button_rentals"("package_id", "status");

-- 5. Product composite indexes
CREATE INDEX IF NOT EXISTS "idx_product_store_status_price"
    ON "product"("store_id", "status", "base_price");

CREATE INDEX IF NOT EXISTS "idx_product_store_cat_status"
    ON "product"("store_id", "category_id", "status");

-- 6. Driver Shifts composite indexes
CREATE INDEX IF NOT EXISTS "idx_driver_shifts_store_status_started"
    ON "driver_shifts"("store_id", "status", "started_at" DESC);

CREATE INDEX IF NOT EXISTS "idx_driver_shifts_driver_status"
    ON "driver_shifts"("driver_id", "status");
