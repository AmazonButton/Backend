-- ==============================================================================
-- MIGRATION: 20261023190000_add_long_press_action_check_constraints
-- PURPOSE: Enforce strict PostgreSQL CHECK constraints on long_press_action column
--          for both "device_templates" and "iot_button" tables.
-- ALLOWED VALUES: 'WIFI_CONFIGURATION', 'ORDER_PRODUCT', 'NONE'
--
-- DATA NORMALIZATION NOTICE:
-- This migration normalizes any existing rows having an invalid or legacy
-- long_press_action value (outside the allowed set) by resetting them to the safe
-- system default 'WIFI_CONFIGURATION' prior to adding the CHECK constraints.
-- This ensures zero downtime and prevents constraint violation failures during deployment.
-- ==============================================================================

-- 1. AlterTable device_templates: Normalize data and add CHECK constraint
DO $$
BEGIN
  -- Normalize legacy or out-of-spec values to safe default
  UPDATE "device_templates" 
  SET "long_press_action" = 'WIFI_CONFIGURATION'
  WHERE "long_press_action" IS NOT NULL 
    AND "long_press_action" NOT IN ('WIFI_CONFIGURATION', 'ORDER_PRODUCT', 'NONE');

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_device_templates_long_press_action'
  ) THEN
    ALTER TABLE "device_templates" ADD CONSTRAINT "chk_device_templates_long_press_action"
      CHECK ("long_press_action" IN ('WIFI_CONFIGURATION', 'ORDER_PRODUCT', 'NONE'));
  END IF;
END $$;

-- 2. AlterTable iot_button: Normalize data and add CHECK constraint
DO $$
BEGIN
  -- Normalize legacy or out-of-spec values to safe default
  UPDATE "iot_button"
  SET "long_press_action" = 'WIFI_CONFIGURATION'
  WHERE "long_press_action" IS NOT NULL 
    AND "long_press_action" NOT IN ('WIFI_CONFIGURATION', 'ORDER_PRODUCT', 'NONE');

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_iot_button_long_press_action'
  ) THEN
    ALTER TABLE "iot_button" ADD CONSTRAINT "chk_iot_button_long_press_action"
      CHECK ("long_press_action" IN ('WIFI_CONFIGURATION', 'ORDER_PRODUCT', 'NONE'));
  END IF;
END $$;
