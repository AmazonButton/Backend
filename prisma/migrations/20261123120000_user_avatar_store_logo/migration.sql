-- Add store logo_url + Cloudinary public_id tracking columns for safe media replacement cleanup
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "avatar_public_id" VARCHAR(255);

ALTER TABLE "store"
  ADD COLUMN IF NOT EXISTS "logo_url" VARCHAR(512),
  ADD COLUMN IF NOT EXISTS "logo_public_id" VARCHAR(255);
