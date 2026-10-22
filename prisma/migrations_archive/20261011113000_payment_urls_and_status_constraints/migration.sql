-- Forward migration: Add checkout_url and qr_code to payment_transaction, and align iot_button_status_check
ALTER TABLE payment_transaction ADD COLUMN IF NOT EXISTS checkout_url VARCHAR(512);
ALTER TABLE payment_transaction ADD COLUMN IF NOT EXISTS qr_code TEXT;

ALTER TABLE iot_button DROP CONSTRAINT IF EXISTS iot_button_status_check;
ALTER TABLE iot_button ADD CONSTRAINT iot_button_status_check
CHECK (status IN ('ACTIVE', 'INACTIVE', 'LOCKED', 'SUSPENDED', 'UNASSIGNED', 'MAINTENANCE'));
