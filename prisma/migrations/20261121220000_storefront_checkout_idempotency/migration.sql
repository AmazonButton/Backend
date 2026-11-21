-- Durable storefront checkout idempotency binding inside business order transaction (F4)
ALTER TABLE "orders"
  ADD COLUMN IF NOT EXISTS "checkout_actor_scope" VARCHAR(128),
  ADD COLUMN IF NOT EXISTS "checkout_idempotency_key" VARCHAR(128),
  ADD COLUMN IF NOT EXISTS "checkout_request_hash" CHAR(64);

CREATE UNIQUE INDEX IF NOT EXISTS "uq_orders_checkout_idempotency"
  ON "orders"("checkout_actor_scope", "checkout_idempotency_key");
