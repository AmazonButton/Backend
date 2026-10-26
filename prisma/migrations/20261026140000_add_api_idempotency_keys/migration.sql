-- CreateTable
CREATE TABLE IF NOT EXISTS "api_idempotency_keys" (
    "id" BIGSERIAL NOT NULL,
    "idempotency_key" VARCHAR(128) NOT NULL,
    "route" VARCHAR(255) NOT NULL,
    "user_id" BIGINT,
    "request_hash" CHAR(64) NOT NULL,
    "status_code" INTEGER,
    "response_body" JSONB,
    "status" VARCHAR(20) NOT NULL DEFAULT 'PROCESSING',
    "locked_until" TIMESTAMPTZ(6) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_idempotency_keys_pkey" PRIMARY KEY ("id")
);

-- Foreign Key to users
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'api_idempotency_keys_user_id_fkey'
    ) THEN
        ALTER TABLE "api_idempotency_keys"
            ADD CONSTRAINT "api_idempotency_keys_user_id_fkey"
            FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- Unique constraint on (idempotency_key, route)
CREATE UNIQUE INDEX IF NOT EXISTS "uq_api_idempotency_key_route"
    ON "api_idempotency_keys"("idempotency_key", "route");

-- Index for background cleanup of expired idempotency keys
CREATE INDEX IF NOT EXISTS "idx_api_idempotency_expires_at"
    ON "api_idempotency_keys"("expires_at");
