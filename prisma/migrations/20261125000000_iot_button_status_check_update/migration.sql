-- Expand iot_button_status_check constraint to allow TRANSFER_PENDING (device ownership transfer)
-- and DISABLED (defective warranty lock) alongside existing baseline statuses.
ALTER TABLE "iot_button" DROP CONSTRAINT IF EXISTS "iot_button_status_check";
ALTER TABLE "iot_button"
  ADD CONSTRAINT "iot_button_status_check"
  CHECK ("status" IN (
    'ACTIVE',
    'INACTIVE',
    'LOCKED',
    'SUSPENDED',
    'UNASSIGNED',
    'MAINTENANCE',
    'TRANSFER_PENDING',
    'DISABLED'
  ));
