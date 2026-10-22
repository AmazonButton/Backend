-- Forward migration: Add session_data JSONB to provisioning_sessions and enforce telemetry check constraints
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
