-- ==============================================================================
-- MIGRATION: 20261023210000_add_notifications_table
-- PURPOSE: Create notifications history table with idempotency key, read tracking,
--          and user foreign key with cascade deletion.
-- ==============================================================================

CREATE TABLE IF NOT EXISTS "notifications" (
    "notification_id" BIGSERIAL NOT NULL,
    "user_id" BIGINT NOT NULL,
    "type" VARCHAR(50) NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "body" TEXT NOT NULL,
    "data" JSONB,
    "idempotency_key" VARCHAR(128) NOT NULL,
    "read_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("notification_id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "notifications_idempotency_key_key" ON "notifications"("idempotency_key");

CREATE INDEX IF NOT EXISTS "idx_notifications_user_read" ON "notifications"("user_id", "read_at");

CREATE INDEX IF NOT EXISTS "idx_notifications_user_created" ON "notifications"("user_id", "created_at");

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'notifications_user_id_fkey'
    ) THEN
        ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" 
            FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;
