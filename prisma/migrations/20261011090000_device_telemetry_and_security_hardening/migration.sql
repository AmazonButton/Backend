-- 1. Add device telemetry, warranty and behavior columns to iot_button
ALTER TABLE iot_button ADD COLUMN IF NOT EXISTS battery_level INTEGER DEFAULT 100;
ALTER TABLE iot_button ADD COLUMN IF NOT EXISTS warranty_until TIMESTAMP WITH TIME ZONE;
ALTER TABLE iot_button ADD COLUMN IF NOT EXISTS click_behavior VARCHAR(50) DEFAULT 'SINGLE';
ALTER TABLE iot_button ADD COLUMN IF NOT EXISTS double_click_window_ms INTEGER DEFAULT 300;
ALTER TABLE iot_button ADD COLUMN IF NOT EXISTS hold_duration_ms INTEGER DEFAULT 1500;

-- 2. Partial unique index: At most one active PENDING or PAID payment transaction per order
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_active_per_order
ON payment_transaction(order_id)
WHERE status IN ('PENDING', 'PAID');

-- 3. Persistent device nonces table for multi-instance anti-replay
CREATE TABLE IF NOT EXISTS device_nonces (
  device_id VARCHAR(64) NOT NULL,
  nonce VARCHAR(128) NOT NULL,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (device_id, nonce)
);
CREATE INDEX IF NOT EXISTS idx_device_nonces_expires_at ON device_nonces(expires_at);

-- 4. Persistent provisioning sessions table
CREATE TABLE IF NOT EXISTS provisioning_sessions (
  id BIGSERIAL PRIMARY KEY,
  session_id VARCHAR(64) UNIQUE NOT NULL,
  session_hash VARCHAR(128) NOT NULL,
  device_id BIGINT NOT NULL,
  token_hash VARCHAR(128),
  status VARCHAR(20) DEFAULT 'ACTIVE',
  claimed_by BIGINT,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_provisioning_sessions_session_id ON provisioning_sessions(session_id);

-- 5. Multi-instance session metadata & telemetry check constraints
ALTER TABLE provisioning_sessions ADD COLUMN IF NOT EXISTS session_data JSONB;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_iot_button_battery') THEN
    ALTER TABLE iot_button ADD CONSTRAINT chk_iot_button_battery
    CHECK (battery_level IS NULL OR (battery_level >= 0 AND battery_level <= 100));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_iot_button_behavior') THEN
    ALTER TABLE iot_button ADD CONSTRAINT chk_iot_button_behavior
    CHECK (click_behavior IS NULL OR click_behavior IN ('SINGLE', 'DOUBLE', 'HOLD'));
  END IF;
END $$;
