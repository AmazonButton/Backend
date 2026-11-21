-- Migration: 20261117230000_platform_memberships_and_system_staff
-- Additive, non-destructive schema transition:
-- 1. Add user-level multi-node session revocation watermark (`tokens_invalid_before`).
-- 2. Create `platform_memberships` for store-independent platform roles (SYSTEM_STAFF, ADMIN, SYSTEM_ADMIN, SUPER_ADMIN).
-- 3. Ensure canonical platform roles exist and backfill existing active platform admins from `store_staff` (without promoting legacy store staff/drivers).

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "tokens_invalid_before" TIMESTAMPTZ(6);

CREATE TABLE IF NOT EXISTS "platform_memberships" (
  "membership_id"      BIGSERIAL PRIMARY KEY,
  "user_id"            BIGINT NOT NULL,
  "role_id"            BIGINT NOT NULL,
  "status"             VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  "granted_by_user_id" BIGINT,
  "granted_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revoked_by_user_id" BIGINT,
  "revoked_at"         TIMESTAMPTZ(6),
  "reason"             VARCHAR(500),
  "created_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "platform_memberships_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "platform_memberships_role_id_fkey"
    FOREIGN KEY ("role_id") REFERENCES "roles"("role_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "platform_memberships_granted_by_user_id_fkey"
    FOREIGN KEY ("granted_by_user_id") REFERENCES "users"("user_id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "platform_memberships_revoked_by_user_id_fkey"
    FOREIGN KEY ("revoked_by_user_id") REFERENCES "users"("user_id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "chk_platform_memberships_status"
    CHECK ("status" IN ('ACTIVE', 'REVOKED'))
);

CREATE INDEX IF NOT EXISTS "idx_platform_memberships_user_status"
  ON "platform_memberships"("user_id", "status");

CREATE UNIQUE INDEX IF NOT EXISTS "uq_platform_memberships_active_user"
  ON "platform_memberships"("user_id")
  WHERE "status" = 'ACTIVE';

-- Ensure canonical platform roles exist (including new SYSTEM_STAFF)
INSERT INTO "roles" ("role_code", "role_name", "description")
VALUES
  ('SYSTEM_STAFF', 'System Hardware Staff', 'Nhân viên hệ thống quản lý nút bấm IoT và bảo hành thiết bị'),
  ('ADMIN', 'Administrator', 'Quản trị viên hệ thống'),
  ('SYSTEM_ADMIN', 'System Administrator', 'Quản trị viên vận hành hệ thống'),
  ('SUPER_ADMIN', 'Super Administrator', 'Quản trị viên tối cao toàn nền tảng')
ON CONFLICT ("role_code") DO NOTHING;

-- Safe non-destructive backfill: move existing active platform admins (NOT store staff / drivers) into platform_memberships.
INSERT INTO "platform_memberships" ("user_id", "role_id", "status", "granted_at", "reason")
SELECT DISTINCT ON (ss."user_id")
  ss."user_id",
  ss."role_id",
  'ACTIVE',
  COALESCE(ss."joined_at", CURRENT_TIMESTAMP),
  'Backfill platform admin membership from store_staff'
FROM "store_staff" ss
JOIN "roles" r ON r."role_id" = ss."role_id"
WHERE ss."status" = 'ACTIVE'
  AND r."role_code" IN ('SUPER_ADMIN', 'SYSTEM_ADMIN', 'ADMIN')
ORDER BY
  ss."user_id",
  CASE r."role_code"
    WHEN 'SUPER_ADMIN' THEN 1
    WHEN 'SYSTEM_ADMIN' THEN 2
    WHEN 'ADMIN' THEN 3
    ELSE 99
  END,
  ss."store_staff_id" ASC
ON CONFLICT ("user_id") WHERE "status" = 'ACTIVE' DO NOTHING;
