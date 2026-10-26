-- AlterTable api_idempotency_keys to add method, actual_path, and actor_scope
ALTER TABLE "api_idempotency_keys"
    ADD COLUMN IF NOT EXISTS "method" VARCHAR(10) NOT NULL DEFAULT 'POST',
    ADD COLUMN IF NOT EXISTS "actual_path" VARCHAR(255) NOT NULL DEFAULT '/',
    ADD COLUMN IF NOT EXISTS "actor_scope" VARCHAR(128) NOT NULL DEFAULT 'public';

-- Drop old route-only unique index
DROP INDEX IF EXISTS "uq_api_idempotency_key_route";

-- Create robust scoped unique index
CREATE UNIQUE INDEX IF NOT EXISTS "uq_api_idempotency_scoped"
    ON "api_idempotency_keys"("actor_scope", "idempotency_key", "method", "actual_path");
