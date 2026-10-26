-- AlterTable api_idempotency_keys to add lock_token for race-free lease management
ALTER TABLE "api_idempotency_keys"
ADD COLUMN IF NOT EXISTS "lock_token" VARCHAR(64);
