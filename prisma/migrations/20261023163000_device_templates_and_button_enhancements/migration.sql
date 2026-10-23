-- AlterTable device_templates
ALTER TABLE "device_templates" ADD COLUMN IF NOT EXISTS "default_product_id" BIGINT;
ALTER TABLE "device_templates" ADD COLUMN IF NOT EXISTS "long_press_action" VARCHAR(50) DEFAULT 'WIFI_CONFIGURATION';

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'device_templates_default_product_id_fkey'
  ) THEN
    ALTER TABLE "device_templates" ADD CONSTRAINT "device_templates_default_product_id_fkey" 
    FOREIGN KEY ("default_product_id") REFERENCES "product"("product_id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- AlterTable iot_button
ALTER TABLE "iot_button" ADD COLUMN IF NOT EXISTS "long_press_action" VARCHAR(50) DEFAULT 'WIFI_CONFIGURATION';
