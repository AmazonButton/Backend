-- Dashboard analytics access paths. All statements are additive and safe to
-- replay during local verification.
CREATE INDEX IF NOT EXISTS "idx_orders_store_date_status"
  ON "orders" ("store_id", "order_date" DESC, "order_status");

CREATE INDEX IF NOT EXISTS "idx_orders_customer_date_status"
  ON "orders" ("customer_id", "order_date" DESC, "order_status");

CREATE INDEX IF NOT EXISTS "idx_inventory_store_stock_alert"
  ON "inventory" ("store_id", "quantity_on_hand", "min_stock_alert");

CREATE INDEX IF NOT EXISTS "idx_iot_button_store_status_battery"
  ON "iot_button" ("store_id", "status", "battery_level");

CREATE INDEX IF NOT EXISTS "idx_payment_tx_status_order_created"
  ON "payment_transaction" ("status", "order_id", "created_at" DESC);
