-- Production Security Hardening Migration
-- 1. Add hmac_secret to iot_button
ALTER TABLE public.iot_button ADD COLUMN IF NOT EXISTS hmac_secret TEXT;

-- Backfill missing hmac_secret for pre-existing devices
UPDATE public.iot_button 
SET hmac_secret = 'sec_' || encode(gen_random_bytes(24), 'hex') 
WHERE hmac_secret IS NULL;

ALTER TABLE public.iot_button ALTER COLUMN hmac_secret SET NOT NULL;

-- 2. Create pairing_tokens table
CREATE TABLE IF NOT EXISTS public.pairing_tokens (
  id BIGSERIAL PRIMARY KEY,
  device_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Foreign key & check constraint for pairing_tokens
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_pairing_tokens_device'
  ) THEN
    ALTER TABLE public.pairing_tokens 
    ADD CONSTRAINT fk_pairing_tokens_device 
    FOREIGN KEY (device_id) REFERENCES public.iot_button(device_id) 
    ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_pairing_token_status'
  ) THEN
    ALTER TABLE public.pairing_tokens 
    ADD CONSTRAINT chk_pairing_token_status 
    CHECK (status IN ('ACTIVE', 'USED', 'REVOKED'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_pairing_tokens_device_status ON public.pairing_tokens(device_id, status);

-- 3. Create revoked_tokens table
CREATE TABLE IF NOT EXISTS public.revoked_tokens (
  id BIGSERIAL PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id BIGINT,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_revoked_tokens_hash ON public.revoked_tokens(token_hash);

-- 4. Unique index for wallet transactions idempotency
CREATE UNIQUE INDEX IF NOT EXISTS uq_wallet_tx_idempotency 
  ON public.wallet_transactions (wallet_id, type, reference_id);
