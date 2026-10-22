-- CreateTable
CREATE TABLE IF NOT EXISTS "user_fcm_tokens" (
    "id" BIGSERIAL NOT NULL,
    "user_id" BIGINT NOT NULL,
    "token" VARCHAR(500) NOT NULL,
    "device_type" VARCHAR(50),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_fcm_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "user_fcm_tokens_token_key" ON "user_fcm_tokens"("token");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "user_fcm_tokens_user_id_is_active_idx" ON "user_fcm_tokens"("user_id", "is_active");

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'user_fcm_tokens_user_id_fkey'
  ) THEN
    ALTER TABLE "user_fcm_tokens" 
    ADD CONSTRAINT "user_fcm_tokens_user_id_fkey" 
    FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
