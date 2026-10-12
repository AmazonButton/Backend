-- CreateTable
CREATE TABLE "roles" (
    "role_id" BIGSERIAL NOT NULL,
    "role_code" TEXT NOT NULL,
    "role_name" TEXT NOT NULL,
    "description" TEXT,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("role_id")
);

-- CreateTable
CREATE TABLE "users" (
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

-- CreateTable
CREATE TABLE "store" (
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

-- CreateTable
CREATE TABLE "store_staff" (
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

-- CreateTable
CREATE TABLE "customer_profile" (
    "customer_id" BIGSERIAL NOT NULL,
    "user_id" BIGINT NOT NULL,
    "phone" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_profile_pkey" PRIMARY KEY ("customer_id")
);

-- CreateTable
CREATE TABLE "customer_address" (
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

-- CreateTable
CREATE TABLE "store_customer" (
    "store_customer_id" BIGSERIAL NOT NULL,
    "store_id" BIGINT NOT NULL,
    "customer_id" BIGINT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "store_customer_pkey" PRIMARY KEY ("store_customer_id")
);

-- CreateTable
CREATE TABLE "category" (
    "category_id" BIGSERIAL NOT NULL,
    "store_id" BIGINT NOT NULL,
    "parent_category_id" BIGINT,
    "category_name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "category_pkey" PRIMARY KEY ("category_id")
);

-- CreateTable
CREATE TABLE "product" (
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

-- CreateTable
CREATE TABLE "product_price_history" (
    "history_id" BIGSERIAL NOT NULL,
    "product_id" BIGINT NOT NULL,
    "old_price" DECIMAL(15,2) NOT NULL,
    "new_price" DECIMAL(15,2) NOT NULL,
    "changed_by_user_id" BIGINT,
    "changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_price_history_pkey" PRIMARY KEY ("history_id")
);

-- CreateTable
CREATE TABLE "product_discount" (
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

-- CreateTable
CREATE TABLE "inventory" (
    "inventory_id" BIGSERIAL NOT NULL,
    "store_id" BIGINT NOT NULL,
    "product_id" BIGINT NOT NULL,
    "quantity_on_hand" INTEGER NOT NULL DEFAULT 0,
    "reserved_quantity" INTEGER NOT NULL DEFAULT 0,
    "min_stock_alert" INTEGER NOT NULL DEFAULT 5,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_pkey" PRIMARY KEY ("inventory_id")
);

-- CreateTable
CREATE TABLE "iot_button" (
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
    "single_press_action" VARCHAR(50) DEFAULT 'CREATE_ORDER',
    "double_press_action" VARCHAR(50) DEFAULT 'CANCEL_ORDER',
    "cancel_window_seconds" INTEGER DEFAULT 60,
    "deployed_template_id" BIGINT,
    "installed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rental_id" BIGINT,

    CONSTRAINT "iot_button_pkey" PRIMARY KEY ("button_id")
);

-- CreateTable
CREATE TABLE "button_product" (
    "button_product_id" BIGSERIAL NOT NULL,
    "button_id" BIGINT NOT NULL,
    "product_id" BIGINT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "button_product_pkey" PRIMARY KEY ("button_product_id")
);

-- CreateTable
CREATE TABLE "orders" (
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

-- CreateTable
CREATE TABLE "order_item" (
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

-- CreateTable
CREATE TABLE "order_status_history" (
    "history_id" BIGSERIAL NOT NULL,
    "order_id" BIGINT NOT NULL,
    "changed_by_user_id" BIGINT,
    "old_status" TEXT,
    "new_status" TEXT NOT NULL,
    "reason" TEXT,
    "changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_status_history_pkey" PRIMARY KEY ("history_id")
);

-- CreateTable
CREATE TABLE "payment_transaction" (
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

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" BIGSERIAL NOT NULL,
    "user_id" BIGINT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "is_revoked" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_templates" (
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

-- CreateTable
CREATE TABLE "subscription_plans" (
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

-- CreateTable
CREATE TABLE "store_subscriptions" (
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

-- CreateTable
CREATE TABLE "rental_packages" (
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

-- CreateTable
CREATE TABLE "button_rentals" (
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

-- CreateTable
CREATE TABLE "store_wallets" (
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

-- CreateTable
CREATE TABLE "wallet_transactions" (
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

-- CreateTable
CREATE TABLE "store_withdrawals" (
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

-- CreateTable
CREATE TABLE "product_image" (
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

-- CreateTable
CREATE TABLE "pairing_tokens" (
    "id" BIGSERIAL NOT NULL,
    "device_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pairing_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "revoked_tokens" (
    "id" BIGSERIAL NOT NULL,
    "token_hash" TEXT NOT NULL,
    "user_id" BIGINT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "revoked_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_otps" (
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

-- CreateTable
CREATE TABLE "iot_idempotency_keys" (
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

-- CreateTable
CREATE TABLE "device_nonces" (
    "device_id" VARCHAR(64) NOT NULL,
    "nonce" VARCHAR(128) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_nonces_pkey" PRIMARY KEY ("device_id","nonce")
);

-- CreateTable
CREATE TABLE "provisioning_sessions" (
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

-- CreateTable
CREATE TABLE "subscription_idempotency_keys" (
    "id" BIGSERIAL NOT NULL,
    "store_id" BIGINT NOT NULL,
    "idempotency_key" VARCHAR(128) NOT NULL,
    "request_hash" VARCHAR(64) NOT NULL,
    "subscription_id" BIGINT NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'COMPLETED',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscription_idempotency_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "roles_role_code_key" ON "roles"("role_code");

-- CreateIndex
CREATE UNIQUE INDEX "users_auth_id_key" ON "users"("auth_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "store_code_key" ON "store"("code");

-- CreateIndex
CREATE UNIQUE INDEX "store_staff_store_id_user_id_key" ON "store_staff"("store_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "customer_profile_user_id_key" ON "customer_profile"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "customer_address_customer_id_address_id_key" ON "customer_address"("customer_id", "address_id");

-- CreateIndex
CREATE UNIQUE INDEX "store_customer_store_id_customer_id_key" ON "store_customer"("store_id", "customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "category_store_id_category_id_key" ON "category"("store_id", "category_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_store_id_product_code_key" ON "product"("store_id", "product_code");

-- CreateIndex
CREATE UNIQUE INDEX "product_store_id_product_id_key" ON "product"("store_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_product_id_key" ON "inventory"("product_id");

-- CreateIndex
CREATE UNIQUE INDEX "iot_button_device_id_key" ON "iot_button"("device_id");

-- CreateIndex
CREATE UNIQUE INDEX "iot_button_button_code_key" ON "iot_button"("button_code");

-- CreateIndex
CREATE UNIQUE INDEX "iot_button_button_id_customer_id_store_id_key" ON "iot_button"("button_id", "customer_id", "store_id");

-- CreateIndex
CREATE UNIQUE INDEX "button_product_button_id_product_id_key" ON "button_product"("button_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "orders_order_code_key" ON "orders"("order_code");

-- CreateIndex
CREATE UNIQUE INDEX "uq_orders_button_request" ON "orders"("button_id", "iot_request_id");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "device_templates_code_key" ON "device_templates"("code");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_plans_plan_code_key" ON "subscription_plans"("plan_code");

-- CreateIndex
CREATE UNIQUE INDEX "rental_packages_package_code_key" ON "rental_packages"("package_code");

-- CreateIndex
CREATE UNIQUE INDEX "button_rentals_rental_code_key" ON "button_rentals"("rental_code");

-- CreateIndex
CREATE UNIQUE INDEX "store_wallets_store_id_key" ON "store_wallets"("store_id");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_transactions_wallet_id_type_reference_id_key" ON "wallet_transactions"("wallet_id", "type", "reference_id");

-- CreateIndex
CREATE UNIQUE INDEX "store_withdrawals_withdrawal_code_key" ON "store_withdrawals"("withdrawal_code");

-- CreateIndex
CREATE UNIQUE INDEX "store_withdrawals_provider_reference_id_key" ON "store_withdrawals"("provider_reference_id");

-- CreateIndex
CREATE UNIQUE INDEX "pairing_tokens_token_hash_key" ON "pairing_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "pairing_tokens_device_id_status_idx" ON "pairing_tokens"("device_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "revoked_tokens_token_hash_key" ON "revoked_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "revoked_tokens_token_hash_idx" ON "revoked_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "auth_otps_token_hash_purpose_idx" ON "auth_otps"("token_hash", "purpose");

-- CreateIndex
CREATE INDEX "auth_otps_email_purpose_idx" ON "auth_otps"("email", "purpose");

-- CreateIndex
CREATE INDEX "auth_otps_user_id_purpose_idx" ON "auth_otps"("user_id", "purpose");

-- CreateIndex
CREATE INDEX "idx_iot_idempotency_request_id" ON "iot_idempotency_keys"("request_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_iot_idempotency_device_request" ON "iot_idempotency_keys"("device_id", "request_id");

-- CreateIndex
CREATE INDEX "device_nonces_expires_at_idx" ON "device_nonces"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "provisioning_sessions_session_id_key" ON "provisioning_sessions"("session_id");

-- CreateIndex
CREATE INDEX "provisioning_sessions_session_id_idx" ON "provisioning_sessions"("session_id");

-- CreateIndex
CREATE INDEX "idx_sub_idemp_store" ON "subscription_idempotency_keys"("store_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_sub_idemp_store_key" ON "subscription_idempotency_keys"("store_id", "idempotency_key");

-- AddForeignKey
ALTER TABLE "store" ADD CONSTRAINT "store_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_staff" ADD CONSTRAINT "store_staff_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "store"("store_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_staff" ADD CONSTRAINT "store_staff_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_staff" ADD CONSTRAINT "store_staff_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("role_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_profile" ADD CONSTRAINT "customer_profile_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_address" ADD CONSTRAINT "customer_address_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer_profile"("customer_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_customer" ADD CONSTRAINT "store_customer_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "store"("store_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_customer" ADD CONSTRAINT "store_customer_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer_profile"("customer_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "category" ADD CONSTRAINT "category_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "store"("store_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "category" ADD CONSTRAINT "category_store_id_parent_category_id_fkey" FOREIGN KEY ("store_id", "parent_category_id") REFERENCES "category"("store_id", "category_id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product" ADD CONSTRAINT "product_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "store"("store_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product" ADD CONSTRAINT "product_store_id_category_id_fkey" FOREIGN KEY ("store_id", "category_id") REFERENCES "category"("store_id", "category_id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_price_history" ADD CONSTRAINT "product_price_history_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("product_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_price_history" ADD CONSTRAINT "product_price_history_changed_by_user_id_fkey" FOREIGN KEY ("changed_by_user_id") REFERENCES "users"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_discount" ADD CONSTRAINT "product_discount_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("product_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory" ADD CONSTRAINT "inventory_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "store"("store_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory" ADD CONSTRAINT "inventory_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("product_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "iot_button" ADD CONSTRAINT "iot_button_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "store"("store_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "iot_button" ADD CONSTRAINT "iot_button_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer_profile"("customer_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "iot_button" ADD CONSTRAINT "iot_button_customer_id_address_id_fkey" FOREIGN KEY ("customer_id", "address_id") REFERENCES "customer_address"("customer_id", "address_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "iot_button" ADD CONSTRAINT "iot_button_deployed_template_id_fkey" FOREIGN KEY ("deployed_template_id") REFERENCES "device_templates"("template_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "iot_button" ADD CONSTRAINT "iot_button_rental_id_fkey" FOREIGN KEY ("rental_id") REFERENCES "button_rentals"("rental_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "button_product" ADD CONSTRAINT "button_product_button_id_fkey" FOREIGN KEY ("button_id") REFERENCES "iot_button"("button_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "button_product" ADD CONSTRAINT "button_product_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("product_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "store"("store_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer_profile"("customer_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_button_id_fkey" FOREIGN KEY ("button_id") REFERENCES "iot_button"("button_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_item" ADD CONSTRAINT "order_item_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("order_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_item" ADD CONSTRAINT "order_item_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("product_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_status_history" ADD CONSTRAINT "order_status_history_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("order_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_status_history" ADD CONSTRAINT "order_status_history_changed_by_user_id_fkey" FOREIGN KEY ("changed_by_user_id") REFERENCES "users"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_transaction" ADD CONSTRAINT "payment_transaction_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("order_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_templates" ADD CONSTRAINT "device_templates_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "store"("store_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_subscriptions" ADD CONSTRAINT "store_subscriptions_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "store"("store_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_subscriptions" ADD CONSTRAINT "store_subscriptions_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "subscription_plans"("plan_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "button_rentals" ADD CONSTRAINT "button_rentals_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer_profile"("customer_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "button_rentals" ADD CONSTRAINT "button_rentals_package_id_fkey" FOREIGN KEY ("package_id") REFERENCES "rental_packages"("package_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_wallets" ADD CONSTRAINT "store_wallets_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "store"("store_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "store_wallets"("wallet_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_withdrawals" ADD CONSTRAINT "store_withdrawals_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "store_wallets"("wallet_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_withdrawals" ADD CONSTRAINT "store_withdrawals_approved_by_user_id_fkey" FOREIGN KEY ("approved_by_user_id") REFERENCES "users"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_image" ADD CONSTRAINT "product_image_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("product_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_otps" ADD CONSTRAINT "auth_otps_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "iot_idempotency_keys" ADD CONSTRAINT "iot_idempotency_keys_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "iot_button"("button_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "iot_idempotency_keys" ADD CONSTRAINT "iot_idempotency_keys_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("order_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_idempotency_keys" ADD CONSTRAINT "subscription_idempotency_keys_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "store"("store_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_idempotency_keys" ADD CONSTRAINT "subscription_idempotency_keys_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "store_subscriptions"("subscription_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- =========================================================================
-- EXTENSIONS & COMPATIBILITY
-- =========================================================================
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'gen_random_bytes' AND pronamespace = 'extensions'::regnamespace)
     AND NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'gen_random_bytes' AND pronamespace = CURRENT_SCHEMA::regnamespace) THEN
    EXECUTE 'CREATE OR REPLACE FUNCTION gen_random_bytes(integer) RETURNS bytea LANGUAGE sql AS $f$ SELECT extensions.gen_random_bytes($1); $f$';
  END IF;
END $$;

-- =========================================================================
-- CHECK CONSTRAINTS
-- =========================================================================
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_user_password_hash') THEN
    ALTER TABLE "users" ADD CONSTRAINT chk_user_password_hash CHECK ((length(password_hash) >= 60));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_iot_button_battery') THEN
    ALTER TABLE "iot_button" ADD CONSTRAINT chk_iot_button_battery CHECK ((battery_level >= 0 AND battery_level <= 100));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'iot_button_status_check') THEN
    ALTER TABLE "iot_button" ADD CONSTRAINT iot_button_status_check CHECK (status IN ('ACTIVE', 'INACTIVE', 'LOCKED', 'SUSPENDED', 'UNASSIGNED', 'MAINTENANCE'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payment_transaction_status_check') THEN
    ALTER TABLE "payment_transaction" ADD CONSTRAINT payment_transaction_status_check CHECK (status = ANY (ARRAY['PENDING'::text, 'CREATING'::text, 'SUCCESS'::text, 'PAID'::text, 'FAILED'::text, 'CANCELLED'::text, 'EXPIRED'::text, 'REFUND_PENDING'::text]));
  END IF;
END $$;

-- =========================================================================
-- STORED PROCEDURES & BUSINESS TRIGGERS
-- =========================================================================
CREATE OR REPLACE FUNCTION fn_current_user_id()
RETURNS bigint
LANGUAGE plpgsql
STABLE
AS $function$
DECLARE
    v_user_id text;
BEGIN
    v_user_id := current_setting('request.jwt.claim.sub', true);
    IF v_user_id IS NOT NULL AND v_user_id ~ '^[0-9]+$' THEN
        RETURN v_user_id::bigint;
    END IF;
    RETURN NULL;
EXCEPTION
    WHEN OTHERS THEN
        RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION fn_validate_order_status_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
    v_transitions JSONB := '{
        "PENDING": ["CONFIRMED", "CANCELLED", "REJECTED"],
        "CONFIRMED": ["PREPARING", "CANCELLED", "REJECTED"],
        "PREPARING": ["READY_FOR_DELIVERY", "CANCELLED"],
        "READY_FOR_DELIVERY": ["SHIPPING", "CANCELLED"],
        "SHIPPING": ["DELIVERED", "DELIVERY_FAILED", "CANCELLED"],
        "DELIVERED": ["COMPLETED"],
        "DELIVERY_FAILED": ["CANCELLED", "SHIPPING"],
        "COMPLETED": [],
        "CANCELLED": [],
        "REJECTED": []
    }'::JSONB;
    v_allowed JSONB;
BEGIN
    IF OLD.order_status = NEW.order_status THEN
        RETURN NEW;
    END IF;

    v_allowed := v_transitions -> OLD.order_status;

    IF v_allowed IS NULL OR NOT (v_allowed ? NEW.order_status) THEN
        RAISE EXCEPTION 'Chuyển trạng thái không hợp lệ: % → %. Các trạng thái hợp lệ từ %: %',
            OLD.order_status,
            NEW.order_status,
            OLD.order_status,
            COALESCE(v_allowed::text, '[]')
            USING ERRCODE = 'P0001';
    END IF;

    IF NEW.order_status = 'COMPLETED' THEN
        NEW.completed_at := now();
    END IF;

    RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION fn_sync_inventory_on_order_status_change()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
    v_changed_by bigint;
BEGIN
    IF OLD.order_status = NEW.order_status THEN
        RETURN NEW;
    END IF;

    v_changed_by := fn_current_user_id();

    INSERT INTO public.order_status_history (
        order_id,
        from_status,
        to_status,
        changed_by,
        reason,
        created_at
    ) VALUES (
        NEW.order_id,
        OLD.order_status,
        NEW.order_status,
        v_changed_by,
        CASE
            WHEN NEW.order_status = 'CANCELLED' THEN 'Khách hàng hoặc hệ thống hủy đơn'
            WHEN NEW.order_status = 'REJECTED' THEN 'Cửa hàng từ chối đơn hàng'
            WHEN NEW.order_status = 'COMPLETED' THEN 'Hoàn tất đơn hàng thành công'
            ELSE 'Cập nhật trạng thái đơn hàng'
        END,
        NOW()
    );

    RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION sp_create_order_from_button(
    p_button_id BIGINT,
    p_payment_method VARCHAR(30) DEFAULT 'COD',
    p_shipping_fee NUMERIC(15,2) DEFAULT 0,
    p_order_note TEXT DEFAULT 'Đơn hàng tự động từ nút bấm IoT',
    p_iot_request_id VARCHAR(128) DEFAULT NULL
)
RETURNS TABLE (
    order_id BIGINT,
    order_code VARCHAR(50),
    total_amount NUMERIC(15,2),
    order_status VARCHAR(30)
)
LANGUAGE plpgsql
AS $function$
DECLARE
    v_button RECORD;
    v_order_id BIGINT;
    v_order_code VARCHAR(50);
    v_subtotal NUMERIC(15,2) := 0;
    v_total NUMERIC(15,2);
    v_item RECORD;
    v_commission_rate NUMERIC(5,2);
    v_commission_amount NUMERIC(15,2);
    v_net_amount NUMERIC(15,2);
    v_current_stock INT;
    v_existing_order_id BIGINT;
BEGIN
    IF p_iot_request_id IS NOT NULL THEN
        SELECT o.order_id INTO v_existing_order_id
        FROM orders o
        WHERE o.button_id = p_button_id AND o.iot_request_id = p_iot_request_id
        LIMIT 1;

        IF v_existing_order_id IS NOT NULL THEN
            RETURN QUERY
            SELECT o.order_id, o.order_code, o.total_amount, o.order_status
            FROM orders o
            WHERE o.order_id = v_existing_order_id;
            RETURN;
        END IF;
    END IF;

    SELECT b.*, s.commission_rate AS store_commission_rate,
           a.recipient_name, a.phone AS recipient_phone,
           (a.address_detail || ', ' || COALESCE(a.ward, '') || ', ' || COALESCE(a.district, '') || ', ' || COALESCE(a.province, '')) AS full_address
    INTO v_button
    FROM iot_button b
    JOIN store s ON b.store_id = s.store_id
    LEFT JOIN customer_address a ON b.customer_id = a.customer_id AND (b.address_id = a.address_id OR (b.address_id IS NULL AND a.is_default = true))
    WHERE b.button_id = p_button_id
    FOR UPDATE OF b;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Thiết bị nút bấm không tồn tại' USING ERRCODE = 'P0002';
    END IF;

    IF v_button.status != 'ACTIVE' THEN
        RAISE EXCEPTION 'Thiết bị chưa được kích hoạt hoặc đang bị khóa' USING ERRCODE = 'P0003';
    END IF;

    IF v_button.customer_id IS NULL THEN
        RAISE EXCEPTION 'Thiết bị chưa được gán cho khách hàng' USING ERRCODE = 'P0004';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM button_product WHERE button_id = p_button_id) THEN
        RAISE EXCEPTION 'Nút bấm chưa được cấu hình sản phẩm' USING ERRCODE = 'P0005';
    END IF;

    FOR v_item IN
        SELECT bp.product_id, bp.quantity, p.product_name, p.base_price, p.status AS product_status,
               inv.quantity_on_hand, inv.reserved_quantity
        FROM button_product bp
        JOIN product p ON bp.product_id = p.product_id
        LEFT JOIN inventory inv ON p.product_id = inv.product_id
        WHERE bp.button_id = p_button_id
        FOR UPDATE OF inv
    LOOP
        IF v_item.product_status != 'ACTIVE' THEN
            RAISE EXCEPTION 'Sản phẩm % không còn kinh doanh', v_item.product_name USING ERRCODE = 'P0006';
        END IF;

        IF (v_item.quantity_on_hand - v_item.reserved_quantity) < v_item.quantity THEN
            RAISE EXCEPTION 'Sản phẩm % không đủ tồn kho khả dụng', v_item.product_name USING ERRCODE = 'P0007';
        END IF;

        v_subtotal := v_subtotal + (v_item.base_price * v_item.quantity);
    END LOOP;

    v_total := v_subtotal + p_shipping_fee;
    v_commission_rate := COALESCE(v_button.store_commission_rate, 8.0);
    v_commission_amount := ROUND((v_subtotal * v_commission_rate / 100.0), 2);
    v_net_amount := v_total - v_commission_amount;
    v_order_code := 'ORD-' || TO_CHAR(NOW(), 'YYYYMMDD') || '-' || LPAD(FLOOR(RANDOM() * 10000)::TEXT, 4, '0');

    INSERT INTO orders (
        order_code, store_id, customer_id, button_id,
        order_status, payment_status, payment_method,
        subtotal_amount, shipping_fee, total_amount,
        commission_rate, commission_amount, net_amount,
        shipping_recipient_name, shipping_phone, shipping_address,
        order_note, iot_request_id, created_at, updated_at
    ) VALUES (
        v_order_code, v_button.store_id, v_button.customer_id, p_button_id,
        'PENDING', 'UNPAID', p_payment_method,
        v_subtotal, p_shipping_fee, v_total,
        v_commission_rate, v_commission_amount, v_net_amount,
        COALESCE(v_button.recipient_name, 'Khách hàng'),
        COALESCE(v_button.recipient_phone, '0000000000'),
        COALESCE(v_button.full_address, 'Địa chỉ mặc định'),
        p_order_note, p_iot_request_id, NOW(), NOW()
    ) RETURNING orders.order_id INTO v_order_id;

    FOR v_item IN
        SELECT bp.product_id, bp.quantity, p.product_name, p.base_price
        FROM button_product bp
        JOIN product p ON bp.product_id = p.product_id
        WHERE bp.button_id = p_button_id
    LOOP
        INSERT INTO order_item (
            order_id, product_id, product_name_snapshot,
            unit_price_snapshot, final_unit_price, quantity, item_subtotal
        ) VALUES (
            v_order_id, v_item.product_id, v_item.product_name,
            v_item.base_price, v_item.base_price, v_item.quantity,
            v_item.base_price * v_item.quantity
        );

        UPDATE inventory
        SET reserved_quantity = reserved_quantity + v_item.quantity,
            updated_at = NOW()
        WHERE product_id = v_item.product_id;
    END LOOP;

    RETURN QUERY
    SELECT o.order_id, o.order_code, o.total_amount, o.order_status
    FROM orders o
    WHERE o.order_id = v_order_id;
END;
$function$;

-- =========================================================================
-- ATTACH TRIGGERS
-- =========================================================================
DROP TRIGGER IF EXISTS trg_validate_order_status_transition ON public.orders;
CREATE TRIGGER trg_validate_order_status_transition
BEFORE UPDATE OF order_status ON public.orders
FOR EACH ROW
EXECUTE FUNCTION fn_validate_order_status_transition();

DROP TRIGGER IF EXISTS trg_sync_inventory_on_order_status_change ON public.orders;
CREATE TRIGGER trg_sync_inventory_on_order_status_change
AFTER UPDATE OF order_status ON public.orders
FOR EACH ROW
EXECUTE FUNCTION fn_sync_inventory_on_order_status_change();
