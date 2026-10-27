-- Backfill existing auth_provider and provider_subject from users table into user_auth_identities
INSERT INTO "user_auth_identities" ("id", "user_id", "provider", "provider_subject", "created_at", "updated_at")
SELECT gen_random_uuid(), "user_id", "auth_provider", "provider_subject", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "users"
WHERE "auth_provider" IS NOT NULL AND "provider_subject" IS NOT NULL
ON CONFLICT ("provider", "provider_subject") DO NOTHING;

-- Deduplicate any multiple identities for the same (user_id, provider) keeping the newest one
DELETE FROM "user_auth_identities"
WHERE "id" IN (
    SELECT "id" FROM (
        SELECT "id", ROW_NUMBER() OVER (PARTITION BY "user_id", "provider" ORDER BY "created_at" DESC) as rn
        FROM "user_auth_identities"
    ) t WHERE t.rn > 1
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "uq_user_auth_identities_user_provider" ON "user_auth_identities"("user_id", "provider");
