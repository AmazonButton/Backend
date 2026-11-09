-- Corrective data migration for 20261109000000_add_user_email_verified_at.
-- The original backfill marked every ACTIVE user without a pending verification token as email-verified,
-- including phone/Firebase registrations that never proved email ownership. Migration files that were
-- already applied must not be edited, so this follow-up undoes only rows written by that backfill
-- (email_verified_at exactly equal to created_at) for phone/Firebase-registered users.
-- Users who verified their email later (email_verified_at set to the real verification time) are untouched.
UPDATE "users"
SET "email_verified_at" = NULL
WHERE "email_verified_at" = "created_at"
  AND ("firebase_uid" IS NOT NULL OR "phone_verified_at" IS NOT NULL);
