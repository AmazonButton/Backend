-- AlterTable
ALTER TABLE "users"
ADD COLUMN IF NOT EXISTS "phone_verified_at" TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS "firebase_uid" VARCHAR(128);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "uq_users_firebase_uid" ON "users"("firebase_uid");

