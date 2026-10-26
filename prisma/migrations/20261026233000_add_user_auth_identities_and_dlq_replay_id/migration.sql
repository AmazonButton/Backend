-- AlterTable dead_letter_jobs
ALTER TABLE "dead_letter_jobs" ADD COLUMN IF NOT EXISTS "replay_job_id" VARCHAR(128);
CREATE INDEX IF NOT EXISTS "idx_dead_letter_replay_job_id" ON "dead_letter_jobs"("replay_job_id");

-- CreateTable user_auth_identities
CREATE TABLE IF NOT EXISTS "user_auth_identities" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" BIGINT NOT NULL,
    "provider" VARCHAR(32) NOT NULL,
    "provider_subject" VARCHAR(255) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_auth_identities_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "user_auth_identities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "uq_user_auth_identities_provider_subject" ON "user_auth_identities"("provider", "provider_subject");
CREATE INDEX IF NOT EXISTS "idx_user_auth_identities_user_id" ON "user_auth_identities"("user_id");
