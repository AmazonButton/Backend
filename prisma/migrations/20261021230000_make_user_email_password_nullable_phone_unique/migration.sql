-- AlterTable: Make email and password_hash nullable for phone-first registration
ALTER TABLE "users" ALTER COLUMN "email" DROP NOT NULL;
ALTER TABLE "users" ALTER COLUMN "password_hash" DROP NOT NULL;

-- CreateIndex: Enforce unique phone numbers across users
CREATE UNIQUE INDEX IF NOT EXISTS "uq_users_phone" ON "users"("phone");
