-- AlterTable users to add auth_provider and provider_subject
ALTER TABLE "users"
ADD COLUMN IF NOT EXISTS "auth_provider" VARCHAR(32) DEFAULT 'LOCAL',
ADD COLUMN IF NOT EXISTS "provider_subject" VARCHAR(255);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "uq_users_auth_provider_subject" ON "users"("auth_provider", "provider_subject");
