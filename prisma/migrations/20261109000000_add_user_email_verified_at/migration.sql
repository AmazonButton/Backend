-- AlterTable
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "email_verified_at" TIMESTAMPTZ(6);

-- Backfill existing active verified users (excluding phone-only registrations without prior email verification)
UPDATE "users"
SET "email_verified_at" = "created_at"
WHERE "email_verified_at" IS NULL
  AND "email_verification_token" IS NULL
  AND "status" = 'ACTIVE'
  AND "firebase_uid" IS NULL
  AND "phone_verified_at" IS NULL;

