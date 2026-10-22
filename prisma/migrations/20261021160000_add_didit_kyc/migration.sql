-- AlterTable users
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "kyc_status" VARCHAR(32) NOT NULL DEFAULT 'UNVERIFIED';

-- CreateTable identity_verification_sessions
CREATE TABLE IF NOT EXISTS "identity_verification_sessions" (
    "id" BIGSERIAL NOT NULL,
    "user_id" BIGINT NOT NULL,
    "didit_session_id" VARCHAR(128) NOT NULL,
    "workflow_id" VARCHAR(128) NOT NULL,
    "vendor_data" VARCHAR(128) NOT NULL,
    "status" VARCHAR(32) NOT NULL DEFAULT 'PENDING',
    "verification_url" VARCHAR(1024) NOT NULL,
    "metadata" JSONB,
    "expires_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "identity_verification_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable didit_webhook_events
CREATE TABLE IF NOT EXISTS "didit_webhook_events" (
    "id" BIGSERIAL NOT NULL,
    "event_id" VARCHAR(128),
    "didit_session_id" VARCHAR(128),
    "event_type" VARCHAR(64) NOT NULL,
    "status" VARCHAR(32) NOT NULL,
    "payload_hash" VARCHAR(64) NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(6),

    CONSTRAINT "didit_webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "identity_verification_sessions_didit_session_id_key" ON "identity_verification_sessions"("didit_session_id");
CREATE INDEX IF NOT EXISTS "identity_verification_sessions_user_id_idx" ON "identity_verification_sessions"("user_id");
CREATE INDEX IF NOT EXISTS "identity_verification_sessions_status_idx" ON "identity_verification_sessions"("status");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "didit_webhook_events_event_id_key" ON "didit_webhook_events"("event_id");
CREATE UNIQUE INDEX IF NOT EXISTS "didit_webhook_events_payload_hash_key" ON "didit_webhook_events"("payload_hash");
CREATE INDEX IF NOT EXISTS "didit_webhook_events_didit_session_id_idx" ON "didit_webhook_events"("didit_session_id");

-- AddForeignKey
ALTER TABLE "identity_verification_sessions" DROP CONSTRAINT IF EXISTS "identity_verification_sessions_user_id_fkey";
ALTER TABLE "identity_verification_sessions" ADD CONSTRAINT "identity_verification_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "didit_webhook_events" DROP CONSTRAINT IF EXISTS "didit_webhook_events_didit_session_id_fkey";
ALTER TABLE "didit_webhook_events" ADD CONSTRAINT "didit_webhook_events_didit_session_id_fkey" FOREIGN KEY ("didit_session_id") REFERENCES "identity_verification_sessions"("didit_session_id") ON DELETE SET NULL ON UPDATE CASCADE;
