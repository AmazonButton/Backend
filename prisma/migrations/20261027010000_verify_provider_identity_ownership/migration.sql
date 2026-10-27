-- 1. Subject đang thuộc user khác
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM users u
    JOIN user_auth_identities i
      ON i.provider = u.auth_provider
     AND i.provider_subject = u.provider_subject
    WHERE u.provider_subject IS NOT NULL
      AND i.user_id <> u.user_id
  ) THEN
    RAISE EXCEPTION
      'PROVIDER_SUBJECT_OWNERSHIP_CONFLICT: manual reconciliation required';
  END IF;
END $$;

-- 2. Một user có nhiều subject cho cùng provider
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM user_auth_identities
    GROUP BY user_id, provider
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'MULTIPLE_PROVIDER_IDENTITIES: manual reconciliation required';
  END IF;
END $$;

-- 3. Chỉ backfill identity chưa tồn tại
INSERT INTO user_auth_identities (
  id,
  user_id,
  provider,
  provider_subject,
  created_at,
  updated_at
)
SELECT
  gen_random_uuid(),
  u.user_id,
  u.auth_provider,
  u.provider_subject,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM users u
WHERE u.auth_provider IS NOT NULL
  AND u.provider_subject IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM user_auth_identities i
    WHERE i.user_id = u.user_id
      AND i.provider = u.auth_provider
  );

-- 4. Postflight: mọi anchor phải tồn tại chính xác
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM users u
    LEFT JOIN user_auth_identities i
      ON i.user_id = u.user_id
     AND i.provider = u.auth_provider
     AND i.provider_subject = u.provider_subject
    WHERE u.auth_provider IS NOT NULL
      AND u.provider_subject IS NOT NULL
      AND i.id IS NULL
  ) THEN
    RAISE EXCEPTION
      'PROVIDER_IDENTITY_POSTFLIGHT_FAILED';
  END IF;
END $$;
