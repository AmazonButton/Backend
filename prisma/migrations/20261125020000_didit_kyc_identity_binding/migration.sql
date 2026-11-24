-- AlterTable users: store verified legal KYC identity separately from editable display full_name
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "verified_legal_name" VARCHAR(255),
  ADD COLUMN IF NOT EXISTS "verified_document_hash" VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "verified_document_encrypted" TEXT,
  ADD COLUMN IF NOT EXISTS "verified_document_masked" VARCHAR(32),
  ADD COLUMN IF NOT EXISTS "verified_date_of_birth" VARCHAR(32),
  ADD COLUMN IF NOT EXISTS "verified_nationality" VARCHAR(16),
  ADD COLUMN IF NOT EXISTS "kyc_verified_at" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "kyc_revoked_at" TIMESTAMPTZ(6);

-- Enforce strict 1-CCCD-1-account uniqueness at PostgreSQL level (NULLs allowed for unverified users)
CREATE UNIQUE INDEX IF NOT EXISTS "uq_users_verified_document_hash"
  ON "users"("verified_document_hash");

-- AlterTable identity_verification_sessions: record blind-index doc hash and mismatch/dispute review audit fields
ALTER TABLE "identity_verification_sessions"
  ADD COLUMN IF NOT EXISTS "verified_document_hash" VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "review_reason" VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "reviewed_by_user_id" BIGINT,
  ADD COLUMN IF NOT EXISTS "reviewed_at" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "review_note" TEXT;

CREATE INDEX IF NOT EXISTS "idx_identity_verification_sessions_doc_hash"
  ON "identity_verification_sessions"("verified_document_hash");

ALTER TABLE "identity_verification_sessions"
  DROP CONSTRAINT IF EXISTS "identity_verification_sessions_reviewed_by_user_id_fkey";

ALTER TABLE "identity_verification_sessions"
  ADD CONSTRAINT "identity_verification_sessions_reviewed_by_user_id_fkey"
  FOREIGN KEY ("reviewed_by_user_id") REFERENCES "users"("user_id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Quarantine legacy pre-binding APPROVED sessions/users that lack bound verified_document_hash
-- until scripts/backfill_didit_kyc_identities.js hashes, deduplicates, and re-promotes valid records.
UPDATE "identity_verification_sessions" s
SET
  "status" = 'IN_REVIEW',
  "review_reason" = CASE
    WHEN s."metadata" IS NULL
      OR NULLIF(TRIM(COALESCE(s."metadata"->>'fullName', s."metadata"->>'full_name', '')), '') IS NULL
      OR NULLIF(TRIM(COALESCE(
        s."metadata"->>'documentEncrypted',
        s."metadata"->>'documentNumber',
        s."metadata"->>'document_number',
        s."metadata"->>'id_number',
        s."metadata"->>'id_card',
        s."metadata"->>'personal_number',
        ''
      )), '') IS NULL
    THEN 'LEGACY_OCR_MISSING'
    ELSE 'LEGACY_BACKFILL_REQUIRED'
  END
FROM "users" u
WHERE s."user_id" = u."user_id"
  AND s."status" = 'APPROVED'
  AND s."deleted_at" IS NULL
  AND (u."verified_document_hash" IS NULL OR u."verified_legal_name" IS NULL);

UPDATE "users"
SET "kyc_status" = 'IN_REVIEW'
WHERE "kyc_status" = 'APPROVED'
  AND ("verified_document_hash" IS NULL OR "verified_legal_name" IS NULL);
