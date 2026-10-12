-- Baseline Initial Schema for Clean Database Deployments
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Bridge extensions functions to current schema if extensions schema is used (e.g. Supabase)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'gen_random_bytes' AND pronamespace = 'extensions'::regnamespace)
     AND NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'gen_random_bytes' AND pronamespace = CURRENT_SCHEMA::regnamespace) THEN
    EXECUTE 'CREATE OR REPLACE FUNCTION gen_random_bytes(integer) RETURNS bytea LANGUAGE sql AS $f$ SELECT extensions.gen_random_bytes($1); $f$';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "roles" (
    "role_id" BIGSERIAL NOT NULL,
    "role_code" TEXT NOT NULL,
    "role_name" TEXT NOT NULL,
    "description" TEXT,
    CONSTRAINT "roles_pkey" PRIMARY KEY ("role_id")
);
CREATE TABLE IF NOT EXISTS "users" (
    "user_id" BIGSERIAL NOT NULL,
    "auth_id" UUID,
    "username" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "phone" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "password_reset_token" TEXT,
    "password_reset_expires_at" TIMESTAMP(3),
    "email_verification_token" TEXT,
    "email_verification_expires_at" TIMESTAMP(3),
    "password_changed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "users_pkey" PRIMARY KEY ("user_id")
);
CREATE TABLE IF NOT EXISTS "store" (
    "store_id" BIGSERIAL NOT NULL,
    "owner_user_id" BIGINT NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "code" VARCHAR(50) NOT NULL,
    "email" VARCHAR(255),
    "phone" VARCHAR(20) NOT NULL,
    "address" TEXT NOT NULL,
    "commission_rate" DECIMAL(5,2) DEFAULT 8.0,
    "status" VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "store_pkey" PRIMARY KEY ("store_id")
);
CREATE TABLE IF NOT EXISTS "store_staff" (
    "store_staff_id" BIGSERIAL NOT NULL,
    "store_id" BIGINT NOT NULL,
    "user_id" BIGINT NOT NULL,
    "role_id" BIGINT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "left_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "store_staff_pkey" PRIMARY KEY ("store_staff_id")
);
CREATE TABLE IF NOT EXISTS "customer_profile" (
    "customer_id" BIGSERIAL NOT NULL,
    "user_id" BIGINT NOT NULL,
    "phone" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "customer_profile_pkey" PRIMARY KEY ("customer_id")
);
CREATE TABLE IF NOT EXISTS "customer_address" (
    "address_id" BIGSERIAL NOT NULL,
    "customer_id" BIGINT NOT NULL,
    "recipient_name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "address_detail" TEXT NOT NULL,
    "ward" TEXT,
    "district" TEXT,
    "province" TEXT,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "customer_address_pkey" PRIMARY KEY ("address_id")
);
CREATE TABLE IF NOT EXISTS "store_customer" (
    "store_customer_id" BIGSERIAL NOT NULL,
    "store_id" BIGINT NOT NULL,
    "customer_id" BIGINT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "store_customer_pkey" PRIMARY KEY ("store_customer_id")
);
CREATE TABLE IF NOT EXISTS "category" (
    "category_id" BIGSERIAL NOT NULL,
    "store_id" BIGINT NOT NULL,
    "parent_category_id" BIGINT,
    "category_name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "category_pkey" PRIMARY KEY ("category_id")
);
CREATE TABLE IF NOT EXISTS "product" (
    "product_id" BIGSERIAL NOT NULL,
    "store_id" BIGINT NOT NULL,
    "category_id" BIGINT,
    "product_code" VARCHAR(50) NOT NULL,
    "product_name" VARCHAR(255) NOT NULL,
    "brand" VARCHAR(100),
    "description" TEXT,
    "base_price" DECIMAL(15,2) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "product_pkey" PRIMARY KEY ("product_id")
);
CREATE TABLE IF NOT EXISTS "product_price_history" (
    "history_id" BIGSERIAL NOT NULL,
    "product_id" BIGINT NOT NULL,
    "old_price" DECIMAL(15,2) NOT NULL,
    "new_price" DECIMAL(15,2) NOT NULL,
    "changed_by_user_id" BIGINT,
    "changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "product_price_history_pkey" PRIMARY KEY ("history_id")
);
CREATE TABLE IF NOT EXISTS "product_discount" (
    "discount_id" BIGSERIAL NOT NULL,
    "product_id" BIGINT NOT NULL,
    "discount_percent" DECIMAL(5,2),
    "discount_amount" DECIMAL(15,2),
    "start_at" TIMESTAMPTZ(6) NOT NULL,
    "end_at" TIMESTAMPTZ(6) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "product_discount_pkey" PRIMARY KEY ("discount_id")
);
CREATE TABLE IF NOT EXISTS "inventory" (
    "inventory_id" BIGSERIAL NOT NULL,
    "store_id" BIGINT NOT NULL,
    "product_id" BIGINT NOT NULL,
    "quantity_on_hand" INTEGER NOT NULL DEFAULT 0,
    "reserved_quantity" INTEGER NOT NULL DEFAULT 0,
    "min_stock_alert" INTEGER NOT NULL DEFAULT 5,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "inventory_pkey" PRIMARY KEY ("inventory_id")
);
CREATE TABLE IF NOT EXISTS "iot_button" (
    "button_id" BIGSERIAL NOT NULL,
    "store_id" BIGINT NOT NULL,
    "customer_id" BIGINT,
    "address_id" BIGINT,
    "device_id" TEXT NOT NULL,
    "button_code" TEXT NOT NULL,
    "button_name" TEXT,
    "hmac_secret" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "battery_level" INTEGER DEFAULT 100,
    "warranty_until" TIMESTAMP(3),
    "click_behavior" TEXT DEFAULT 'SINGLE',
    "double_click_window_ms" INTEGER DEFAULT 300,
    "hold_duration_ms" INTEGER DEFAULT 1500,
    "installed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rental_id" BIGINT,
    CONSTRAINT "iot_button_pkey" PRIMARY KEY ("button_id")
);
CREATE TABLE IF NOT EXISTS "button_product" (
    "button_product_id" BIGSERIAL NOT NULL,
    "button_id" BIGINT NOT NULL,
    "product_id" BIGINT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "button_product_pkey" PRIMARY KEY ("button_product_id")
);
CREATE TABLE IF NOT EXISTS "orders" (
    "order_id" BIGSERIAL NOT NULL,
    "order_code" VARCHAR(50) NOT NULL,
    "store_id" BIGINT NOT NULL,
    "customer_id" BIGINT NOT NULL,
    "button_id" BIGINT NOT NULL,
    "order_status" VARCHAR(30) NOT NULL DEFAULT 'PENDING',
    "payment_status" VARCHAR(30) NOT NULL DEFAULT 'UNPAID',
    "payment_method" VARCHAR(30) NOT NULL,
    "subtotal_amount" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "discount_amount" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "shipping_fee" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "total_amount" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "commission_rate" DECIMAL(5,2) DEFAULT 8.0,
    "commission_amount" DECIMAL(15,2) DEFAULT 0,
    "net_amount" DECIMAL(15,2) DEFAULT 0,
    "shipping_recipient_name" VARCHAR(255) NOT NULL,
    "shipping_phone" VARCHAR(20) NOT NULL,
    "shipping_address" VARCHAR(500) NOT NULL,
    "order_note" TEXT,
    "order_date" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "iot_request_id" VARCHAR(128),
    CONSTRAINT "orders_pkey" PRIMARY KEY ("order_id")
);
CREATE TABLE IF NOT EXISTS "order_item" (
    "order_item_id" BIGSERIAL NOT NULL,
    "order_id" BIGINT NOT NULL,
    "product_id" BIGINT NOT NULL,
    "product_name_snapshot" TEXT NOT NULL,
    "unit_price_snapshot" DECIMAL(15,2) NOT NULL,
    "discount_percent_snapshot" DECIMAL(5,2) DEFAULT 0,
    "discount_amount_snapshot" DECIMAL(15,2) DEFAULT 0,
    "final_unit_price" DECIMAL(15,2) NOT NULL,
    "quantity" INTEGER NOT NULL,
    "item_subtotal" DECIMAL(15,2) NOT NULL,
    CONSTRAINT "order_item_pkey" PRIMARY KEY ("order_item_id")
);
CREATE TABLE IF NOT EXISTS "order_status_history" (
    "history_id" BIGSERIAL NOT NULL,
    "order_id" BIGINT NOT NULL,
    "changed_by_user_id" BIGINT,
    "old_status" TEXT,
    "new_status" TEXT NOT NULL,
    "reason" TEXT,
    "changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "order_status_history_pkey" PRIMARY KEY ("history_id")
);
CREATE TABLE IF NOT EXISTS "payment_transaction" (
    "payment_transaction_id" BIGSERIAL NOT NULL,
    "order_id" BIGINT NOT NULL,
    "provider" TEXT NOT NULL,
    "transaction_code" TEXT,
    "amount" DECIMAL(15,2) NOT NULL,
    "payment_method" TEXT NOT NULL,
    "payment_link_id" TEXT,
    "checkout_url" TEXT,
    "qr_code" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "paid_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "payment_transaction_pkey" PRIMARY KEY ("payment_transaction_id")
);
CREATE TABLE IF NOT EXISTS "refresh_tokens" (
    "id" BIGSERIAL NOT NULL,
    "user_id" BIGINT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "is_revoked" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);
CREATE TABLE IF NOT EXISTS "device_templates" (
    "template_id" BIGSERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT,
    "store_id" BIGINT,
    "single_press_action" TEXT DEFAULT 'CREATE_ORDER',
    "double_press_action" TEXT DEFAULT 'CANCEL_ORDER',
    "default_quantity" INTEGER DEFAULT 1,
    "cancel_window_seconds" INTEGER DEFAULT 60,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "device_templates_pkey" PRIMARY KEY ("template_id")
);
CREATE TABLE IF NOT EXISTS "subscription_plans" (
    "plan_id" BIGSERIAL NOT NULL,
    "plan_code" TEXT NOT NULL,
    "plan_name" TEXT NOT NULL,
    "description" TEXT,
    "price" DECIMAL(15,2) NOT NULL,
    "duration_days" INTEGER NOT NULL,
    "max_products" INTEGER NOT NULL DEFAULT 50,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "subscription_plans_pkey" PRIMARY KEY ("plan_id")
);
CREATE TABLE IF NOT EXISTS "store_subscriptions" (
    "subscription_id" BIGSERIAL NOT NULL,
    "store_id" BIGINT NOT NULL,
    "plan_id" BIGINT NOT NULL,
    "start_date" TIMESTAMP(3) NOT NULL,
    "end_date" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "payment_method" TEXT NOT NULL DEFAULT 'PAYOS',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "store_subscriptions_pkey" PRIMARY KEY ("subscription_id")
);
CREATE TABLE IF NOT EXISTS "rental_packages" (
    "package_id" BIGSERIAL NOT NULL,
    "package_code" TEXT NOT NULL,
    "package_name" TEXT NOT NULL,
    "description" TEXT,
    "button_quantity" INTEGER NOT NULL DEFAULT 1,
    "monthly_price" DECIMAL(15,2) NOT NULL,
    "deposit_fee" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "rental_packages_pkey" PRIMARY KEY ("package_id")
);
CREATE TABLE IF NOT EXISTS "button_rentals" (
    "rental_id" BIGSERIAL NOT NULL,
    "rental_code" TEXT NOT NULL,
    "customer_id" BIGINT NOT NULL,
    "package_id" BIGINT NOT NULL,
    "months_rented" INTEGER NOT NULL DEFAULT 1,
    "total_rent_amount" DECIMAL(15,2) NOT NULL,
    "deposit_amount" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "start_date" TIMESTAMP(3) NOT NULL,
    "end_date" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING_PAYMENT',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "button_rentals_pkey" PRIMARY KEY ("rental_id")
);
CREATE TABLE IF NOT EXISTS "store_wallets" (
    "wallet_id" BIGSERIAL NOT NULL,
    "store_id" BIGINT NOT NULL,
    "balance" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "frozen_balance" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "bank_name" TEXT,
    "bank_account_number" TEXT,
    "bank_account_holder" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "store_wallets_pkey" PRIMARY KEY ("wallet_id")
);
CREATE TABLE IF NOT EXISTS "wallet_transactions" (
    "transaction_id" BIGSERIAL NOT NULL,
    "wallet_id" BIGINT NOT NULL,
    "amount" DECIMAL(15,2) NOT NULL,
    "type" TEXT NOT NULL,
    "balance_before" DECIMAL(15,2) NOT NULL,
    "balance_after" DECIMAL(15,2) NOT NULL,
    "reference_id" TEXT,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "wallet_transactions_pkey" PRIMARY KEY ("transaction_id")
);
CREATE TABLE IF NOT EXISTS "store_withdrawals" (
    "withdrawal_id" BIGSERIAL NOT NULL,
    "withdrawal_code" TEXT NOT NULL,
    "wallet_id" BIGINT NOT NULL,
    "amount" DECIMAL(15,2) NOT NULL,
    "fee" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "net_amount" DECIMAL(15,2),
    "bank_code" TEXT,
    "bank_name" TEXT NOT NULL,
    "bank_account_number" TEXT NOT NULL,
    "bank_account_holder" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "provider" TEXT NOT NULL DEFAULT 'PAYOS',
    "provider_payout_id" TEXT,
    "provider_reference_id" TEXT,
    "failure_reason" TEXT,
    "approved_by_user_id" BIGINT,
    "rejection_reason" TEXT,
    "transfer_evidence_url" TEXT,
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "store_withdrawals_pkey" PRIMARY KEY ("withdrawal_id")
);
CREATE TABLE IF NOT EXISTS "product_image" (
    "image_id" BIGSERIAL NOT NULL,
    "product_id" BIGINT NOT NULL,
    "image_url" TEXT NOT NULL,
    "cloudinary_public_id" TEXT,
    "is_thumbnail" BOOLEAN NOT NULL DEFAULT false,
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "product_image_pkey" PRIMARY KEY ("image_id")
);
CREATE TABLE IF NOT EXISTS "pairing_tokens" (
    "id" BIGSERIAL NOT NULL,
    "device_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "pairing_tokens_pkey" PRIMARY KEY ("id")
);
CREATE TABLE IF NOT EXISTS "revoked_tokens" (
    "id" BIGSERIAL NOT NULL,
    "token_hash" TEXT NOT NULL,
    "user_id" BIGINT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "revoked_tokens_pkey" PRIMARY KEY ("id")
);
CREATE TABLE IF NOT EXISTS "auth_otps" (
    "id" BIGSERIAL NOT NULL,
    "user_id" BIGINT,
    "email" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 5,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "consumed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "auth_otps_pkey" PRIMARY KEY ("id")
);
CREATE TABLE IF NOT EXISTS "iot_idempotency_keys" (
    "id" BIGSERIAL NOT NULL,
    "device_id" BIGINT NOT NULL,
    "request_id" VARCHAR(128) NOT NULL,
    "order_id" BIGINT,
    "status" VARCHAR(20) NOT NULL DEFAULT 'PROCESSING',
    "lease_token" VARCHAR(64),
    "locked_until" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "iot_idempotency_keys_pkey" PRIMARY KEY ("id")
);
CREATE TABLE IF NOT EXISTS "device_nonces" (
    "device_id" VARCHAR(64) NOT NULL,
    "nonce" VARCHAR(128) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "device_nonces_pkey" PRIMARY KEY ("device_id","nonce")
);
CREATE TABLE IF NOT EXISTS "provisioning_sessions" (
    "id" BIGSERIAL NOT NULL,
    "session_id" VARCHAR(64) NOT NULL,
    "session_hash" VARCHAR(128) NOT NULL,
    "device_id" BIGINT NOT NULL,
    "session_data" JSONB,
    "token_hash" VARCHAR(128),
    "status" VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    "claimed_by" BIGINT,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "provisioning_sessions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "roles_role_code_key" ON "roles"("role_code");
CREATE UNIQUE INDEX IF NOT EXISTS "users_auth_id_key" ON "users"("auth_id");
CREATE UNIQUE INDEX IF NOT EXISTS "users_username_key" ON "users"("username");
CREATE UNIQUE INDEX IF NOT EXISTS "users_email_key" ON "users"("email");
CREATE UNIQUE INDEX IF NOT EXISTS "store_code_key" ON "store"("code");
CREATE UNIQUE INDEX IF NOT EXISTS "store_staff_store_id_user_id_key" ON "store_staff"("store_id", "user_id");
CREATE UNIQUE INDEX IF NOT EXISTS "customer_profile_user_id_key" ON "customer_profile"("user_id");
CREATE UNIQUE INDEX IF NOT EXISTS "customer_address_customer_id_address_id_key" ON "customer_address"("customer_id", "address_id");
CREATE UNIQUE INDEX IF NOT EXISTS "store_customer_store_id_customer_id_key" ON "store_customer"("store_id", "customer_id");
CREATE UNIQUE INDEX IF NOT EXISTS "category_store_id_category_id_key" ON "category"("store_id", "category_id");
CREATE UNIQUE INDEX IF NOT EXISTS "product_store_id_product_code_key" ON "product"("store_id", "product_code");
CREATE UNIQUE INDEX IF NOT EXISTS "product_store_id_product_id_key" ON "product"("store_id", "product_id");
CREATE UNIQUE INDEX IF NOT EXISTS "inventory_product_id_key" ON "inventory"("product_id");
CREATE UNIQUE INDEX IF NOT EXISTS "iot_button_device_id_key" ON "iot_button"("device_id");
CREATE UNIQUE INDEX IF NOT EXISTS "iot_button_button_code_key" ON "iot_button"("button_code");
CREATE UNIQUE INDEX IF NOT EXISTS "iot_button_button_id_customer_id_store_id_key" ON "iot_button"("button_id", "customer_id", "store_id");
CREATE UNIQUE INDEX IF NOT EXISTS "button_product_button_id_product_id_key" ON "button_product"("button_id", "product_id");
CREATE UNIQUE INDEX IF NOT EXISTS "orders_order_code_key" ON "orders"("order_code");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_orders_button_request" ON "orders"("button_id", "iot_request_id");
CREATE UNIQUE INDEX IF NOT EXISTS "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");
CREATE UNIQUE INDEX IF NOT EXISTS "device_templates_code_key" ON "device_templates"("code");
CREATE UNIQUE INDEX IF NOT EXISTS "subscription_plans_plan_code_key" ON "subscription_plans"("plan_code");
CREATE UNIQUE INDEX IF NOT EXISTS "rental_packages_package_code_key" ON "rental_packages"("package_code");
CREATE UNIQUE INDEX IF NOT EXISTS "button_rentals_rental_code_key" ON "button_rentals"("rental_code");
CREATE UNIQUE INDEX IF NOT EXISTS "store_wallets_store_id_key" ON "store_wallets"("store_id");
CREATE UNIQUE INDEX IF NOT EXISTS "wallet_transactions_wallet_id_type_reference_id_key" ON "wallet_transactions"("wallet_id", "type", "reference_id");
CREATE UNIQUE INDEX IF NOT EXISTS "store_withdrawals_withdrawal_code_key" ON "store_withdrawals"("withdrawal_code");
CREATE UNIQUE INDEX IF NOT EXISTS "store_withdrawals_provider_reference_id_key" ON "store_withdrawals"("provider_reference_id");
CREATE UNIQUE INDEX IF NOT EXISTS "pairing_tokens_token_hash_key" ON "pairing_tokens"("token_hash");
CREATE INDEX IF NOT EXISTS "pairing_tokens_device_id_status_idx" ON "pairing_tokens"("device_id", "status");
CREATE UNIQUE INDEX IF NOT EXISTS "revoked_tokens_token_hash_key" ON "revoked_tokens"("token_hash");
CREATE INDEX IF NOT EXISTS "revoked_tokens_token_hash_idx" ON "revoked_tokens"("token_hash");
CREATE INDEX IF NOT EXISTS "auth_otps_token_hash_purpose_idx" ON "auth_otps"("token_hash", "purpose");
CREATE INDEX IF NOT EXISTS "auth_otps_email_purpose_idx" ON "auth_otps"("email", "purpose");
CREATE INDEX IF NOT EXISTS "auth_otps_user_id_purpose_idx" ON "auth_otps"("user_id", "purpose");
CREATE INDEX IF NOT EXISTS "idx_iot_idempotency_request_id" ON "iot_idempotency_keys"("request_id");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_iot_idempotency_device_request" ON "iot_idempotency_keys"("device_id", "request_id");
CREATE INDEX IF NOT EXISTS "device_nonces_expires_at_idx" ON "device_nonces"("expires_at");
CREATE UNIQUE INDEX IF NOT EXISTS "provisioning_sessions_session_id_key" ON "provisioning_sessions"("session_id");
CREATE INDEX IF NOT EXISTS "provisioning_sessions_session_id_idx" ON "provisioning_sessions"("session_id");
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'store_owner_user_id_fkey') THEN
    ALTER TABLE "store" ADD CONSTRAINT "store_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'store_staff_store_id_fkey') THEN
    ALTER TABLE "store_staff" ADD CONSTRAINT "store_staff_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "store"("store_id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'store_staff_user_id_fkey') THEN
    ALTER TABLE "store_staff" ADD CONSTRAINT "store_staff_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'store_staff_role_id_fkey') THEN
    ALTER TABLE "store_staff" ADD CONSTRAINT "store_staff_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("role_id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customer_profile_user_id_fkey') THEN
    ALTER TABLE "customer_profile" ADD CONSTRAINT "customer_profile_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customer_address_customer_id_fkey') THEN
    ALTER TABLE "customer_address" ADD CONSTRAINT "customer_address_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer_profile"("customer_id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'store_customer_store_id_fkey') THEN
    ALTER TABLE "store_customer" ADD CONSTRAINT "store_customer_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "store"("store_id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'store_customer_customer_id_fkey') THEN
    ALTER TABLE "store_customer" ADD CONSTRAINT "store_customer_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer_profile"("customer_id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'category_store_id_fkey') THEN
    ALTER TABLE "category" ADD CONSTRAINT "category_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "store"("store_id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'category_store_id_parent_category_id_fkey') THEN
    ALTER TABLE "category" ADD CONSTRAINT "category_store_id_parent_category_id_fkey" FOREIGN KEY ("store_id", "parent_category_id") REFERENCES "category"("store_id", "category_id") ON DELETE NO ACTION ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'product_store_id_fkey') THEN
    ALTER TABLE "product" ADD CONSTRAINT "product_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "store"("store_id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'product_store_id_category_id_fkey') THEN
    ALTER TABLE "product" ADD CONSTRAINT "product_store_id_category_id_fkey" FOREIGN KEY ("store_id", "category_id") REFERENCES "category"("store_id", "category_id") ON DELETE NO ACTION ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'product_price_history_product_id_fkey') THEN
    ALTER TABLE "product_price_history" ADD CONSTRAINT "product_price_history_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("product_id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'product_price_history_changed_by_user_id_fkey') THEN
    ALTER TABLE "product_price_history" ADD CONSTRAINT "product_price_history_changed_by_user_id_fkey" FOREIGN KEY ("changed_by_user_id") REFERENCES "users"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'product_discount_product_id_fkey') THEN
    ALTER TABLE "product_discount" ADD CONSTRAINT "product_discount_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("product_id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inventory_store_id_fkey') THEN
    ALTER TABLE "inventory" ADD CONSTRAINT "inventory_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "store"("store_id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inventory_product_id_fkey') THEN
    ALTER TABLE "inventory" ADD CONSTRAINT "inventory_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("product_id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'iot_button_store_id_fkey') THEN
    ALTER TABLE "iot_button" ADD CONSTRAINT "iot_button_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "store"("store_id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'iot_button_customer_id_fkey') THEN
    ALTER TABLE "iot_button" ADD CONSTRAINT "iot_button_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer_profile"("customer_id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'iot_button_customer_id_address_id_fkey') THEN
    ALTER TABLE "iot_button" ADD CONSTRAINT "iot_button_customer_id_address_id_fkey" FOREIGN KEY ("customer_id", "address_id") REFERENCES "customer_address"("customer_id", "address_id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'iot_button_rental_id_fkey') THEN
    ALTER TABLE "iot_button" ADD CONSTRAINT "iot_button_rental_id_fkey" FOREIGN KEY ("rental_id") REFERENCES "button_rentals"("rental_id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'button_product_button_id_fkey') THEN
    ALTER TABLE "button_product" ADD CONSTRAINT "button_product_button_id_fkey" FOREIGN KEY ("button_id") REFERENCES "iot_button"("button_id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'button_product_product_id_fkey') THEN
    ALTER TABLE "button_product" ADD CONSTRAINT "button_product_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("product_id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_store_id_fkey') THEN
    ALTER TABLE "orders" ADD CONSTRAINT "orders_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "store"("store_id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_customer_id_fkey') THEN
    ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer_profile"("customer_id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_button_id_fkey') THEN
    ALTER TABLE "orders" ADD CONSTRAINT "orders_button_id_fkey" FOREIGN KEY ("button_id") REFERENCES "iot_button"("button_id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'order_item_order_id_fkey') THEN
    ALTER TABLE "order_item" ADD CONSTRAINT "order_item_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("order_id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'order_item_product_id_fkey') THEN
    ALTER TABLE "order_item" ADD CONSTRAINT "order_item_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("product_id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'order_status_history_order_id_fkey') THEN
    ALTER TABLE "order_status_history" ADD CONSTRAINT "order_status_history_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("order_id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'order_status_history_changed_by_user_id_fkey') THEN
    ALTER TABLE "order_status_history" ADD CONSTRAINT "order_status_history_changed_by_user_id_fkey" FOREIGN KEY ("changed_by_user_id") REFERENCES "users"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payment_transaction_order_id_fkey') THEN
    ALTER TABLE "payment_transaction" ADD CONSTRAINT "payment_transaction_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("order_id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'refresh_tokens_user_id_fkey') THEN
    ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'device_templates_store_id_fkey') THEN
    ALTER TABLE "device_templates" ADD CONSTRAINT "device_templates_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "store"("store_id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'store_subscriptions_store_id_fkey') THEN
    ALTER TABLE "store_subscriptions" ADD CONSTRAINT "store_subscriptions_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "store"("store_id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'store_subscriptions_plan_id_fkey') THEN
    ALTER TABLE "store_subscriptions" ADD CONSTRAINT "store_subscriptions_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "subscription_plans"("plan_id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'button_rentals_customer_id_fkey') THEN
    ALTER TABLE "button_rentals" ADD CONSTRAINT "button_rentals_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer_profile"("customer_id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'button_rentals_package_id_fkey') THEN
    ALTER TABLE "button_rentals" ADD CONSTRAINT "button_rentals_package_id_fkey" FOREIGN KEY ("package_id") REFERENCES "rental_packages"("package_id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'store_wallets_store_id_fkey') THEN
    ALTER TABLE "store_wallets" ADD CONSTRAINT "store_wallets_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "store"("store_id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wallet_transactions_wallet_id_fkey') THEN
    ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "store_wallets"("wallet_id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'store_withdrawals_wallet_id_fkey') THEN
    ALTER TABLE "store_withdrawals" ADD CONSTRAINT "store_withdrawals_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "store_wallets"("wallet_id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'store_withdrawals_approved_by_user_id_fkey') THEN
    ALTER TABLE "store_withdrawals" ADD CONSTRAINT "store_withdrawals_approved_by_user_id_fkey" FOREIGN KEY ("approved_by_user_id") REFERENCES "users"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'product_image_product_id_fkey') THEN
    ALTER TABLE "product_image" ADD CONSTRAINT "product_image_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("product_id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'auth_otps_user_id_fkey') THEN
    ALTER TABLE "auth_otps" ADD CONSTRAINT "auth_otps_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'iot_idempotency_keys_device_id_fkey') THEN
    ALTER TABLE "iot_idempotency_keys" ADD CONSTRAINT "iot_idempotency_keys_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "iot_button"("button_id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'iot_idempotency_keys_order_id_fkey') THEN
    ALTER TABLE "iot_idempotency_keys" ADD CONSTRAINT "iot_idempotency_keys_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("order_id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
