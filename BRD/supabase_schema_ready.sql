-- ==============================================================================
-- SMART ORDER BACKEND: SUPABASE FULL DATABASE SCHEMA (64 TABLES)
-- Generated automatically from Prisma schema & production migrations
-- ==============================================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

﻿-- CreateTable
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
    "email" TEXT,
    "password_hash" TEXT,
    "full_name" TEXT NOT NULL,
    "phone" TEXT,
    "phone_verified_at" TIMESTAMPTZ(6),
    "firebase_uid" VARCHAR(128),
    "auth_provider" VARCHAR(32) DEFAULT 'LOCAL',
    "provider_subject" VARCHAR(255),
    "avatar_url" VARCHAR(512),
    "kyc_status" VARCHAR(32) NOT NULL DEFAULT 'UNVERIFIED',
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
    "latitude" DECIMAL(10,7),
    "longitude" DECIMAL(10,7),
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
    "long_press_action" VARCHAR(50) DEFAULT 'WIFI_CONFIGURATION',
    "cancel_window_seconds" INTEGER DEFAULT 60,
    "deployed_template_id" BIGINT,
    "installed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rental_id" BIGINT,
    "from_inventory_state" VARCHAR(50),
    "to_inventory_state" VARCHAR(50),
    "custody_store_id" BIGINT,
    "inventory_state" VARCHAR(30) NOT NULL DEFAULT 'IN_PLATFORM_WAREHOUSE',
    "can_order" BOOLEAN NOT NULL DEFAULT true,

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
    "customer_id" BIGINT,
    "button_id" BIGINT,
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
    "assigned_driver_id" BIGINT,
    "pod_image_url" VARCHAR(1000),
    "delivered_at" TIMESTAMPTZ(6),
    "failure_reason_code" VARCHAR(50),
    "failure_note" TEXT,
    "evidence_image_url" VARCHAR(1000),
    "shipping_latitude" DECIMAL(10,7),
    "shipping_longitude" DECIMAL(10,7),

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
    "order_id" BIGINT,
    "rental_id" BIGINT,
    "provider" TEXT NOT NULL,
    "transaction_code" TEXT,
    "amount" DECIMAL(15,2) NOT NULL,
    "payment_method" TEXT NOT NULL,
    "payment_link_id" TEXT,
    "checkout_url" TEXT,
    "due_date" TIMESTAMPTZ(6),
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
CREATE TABLE "user_fcm_tokens" (
    "id" BIGSERIAL NOT NULL,
    "user_id" BIGINT NOT NULL,
    "token" VARCHAR(500) NOT NULL,
    "device_type" VARCHAR(50),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_fcm_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_templates" (
    "template_id" BIGSERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT,
    "store_id" BIGINT,
    "default_product_id" BIGINT,
    "single_press_action" TEXT DEFAULT 'CREATE_ORDER',
    "double_press_action" TEXT DEFAULT 'CANCEL_ORDER',
    "long_press_action" TEXT DEFAULT 'WIFI_CONFIGURATION',
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
    "fulfillment_store_id" BIGINT,
    "button_quantity" INTEGER NOT NULL DEFAULT 1,
    "deposit_per_button" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "rent_per_button" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "monthly_rent_per_button_snapshot" DECIMAL(15,2),
    "billing_policy" VARCHAR(50) NOT NULL DEFAULT 'STORE_RENT_CUSTOMER_DEPOSIT',
    "billing_policy_review_required" BOOLEAN NOT NULL DEFAULT false,
    "pricing_review_required" BOOLEAN NOT NULL DEFAULT true,
    "months_rented" INTEGER NOT NULL DEFAULT 1,
    "total_rent_amount" DECIMAL(15,2) NOT NULL,
    "deposit_amount" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "start_date" TIMESTAMP(3) NOT NULL,
    "end_date" TIMESTAMP(3) NOT NULL,
    "paid_through" TIMESTAMP(3),
    "effective_expires_at" TIMESTAMP(3),
    "returned_at" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'PENDING_PAYMENT',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "button_rentals_pkey" PRIMARY KEY ("rental_id"),
    CONSTRAINT "chk_button_rentals_billing_policy" CHECK ("billing_policy" IN ('LEGACY_CUSTOMER_RENT', 'STORE_RENT_CUSTOMER_DEPOSIT'))
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
    "bank_account_number" TEXT,
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
    "store_id" BIGINT,
    "idempotency_key" VARCHAR(255),
    "bank_account_id" BIGINT,
    "bank_account_encrypted" TEXT,
    "bank_account_hash" VARCHAR(64),
    "bank_account_masked" VARCHAR(32),
    "bank_account_name_snapshot" VARCHAR(255),
    "bank_bin_snapshot" VARCHAR(10),
    "bank_name_snapshot" VARCHAR(100),

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

-- CreateTable
CREATE TABLE "driver_duties" (
    "driver_duty_id" BIGSERIAL NOT NULL,
    "driver_id" BIGINT NOT NULL,
    "store_id" BIGINT NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'OFFLINE',
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "driver_duties_pkey" PRIMARY KEY ("driver_duty_id")
);

-- CreateTable
CREATE TABLE "driver_shifts" (
    "shift_id" BIGSERIAL NOT NULL,
    "store_id" BIGINT NOT NULL,
    "driver_id" BIGINT NOT NULL,
    "status" VARCHAR(30) NOT NULL DEFAULT 'OPEN',
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMPTZ(6),
    "handed_over_at" TIMESTAMPTZ(6),
    "confirmed_by_user_id" BIGINT,
    "handover_code" VARCHAR(50),
    "total_orders_delivered" INTEGER NOT NULL DEFAULT 0,
    "total_orders_failed" INTEGER NOT NULL DEFAULT 0,
    "total_cod_collected" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "total_vietqr_collected" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "handover_note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "driver_shifts_pkey" PRIMARY KEY ("shift_id")
);

-- CreateTable
CREATE TABLE "identity_verification_sessions" (
    "id" BIGSERIAL NOT NULL,
    "user_id" BIGINT NOT NULL,
    "didit_session_id" VARCHAR(128) NOT NULL,
    "workflow_id" VARCHAR(128) NOT NULL,
    "vendor_data" VARCHAR(128) NOT NULL,
    "status" VARCHAR(32) NOT NULL DEFAULT 'PENDING',
    "verification_url" VARCHAR(1024) NOT NULL,
    "metadata" JSONB,
    "expires_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "identity_verification_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "didit_webhook_events" (
    "id" BIGSERIAL NOT NULL,
    "event_id" VARCHAR(128),
    "didit_session_id" VARCHAR(128),
    "event_type" VARCHAR(64) NOT NULL,
    "status" VARCHAR(32) NOT NULL,
    "payload_hash" VARCHAR(64) NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(6),

    CONSTRAINT "didit_webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "store_bank_accounts" (
    "id" BIGSERIAL NOT NULL,
    "store_id" BIGINT NOT NULL,
    "bank_bin" VARCHAR(10) NOT NULL,
    "bank_code" VARCHAR(20),
    "bank_name" VARCHAR(100) NOT NULL,
    "account_number_encrypted" TEXT NOT NULL,
    "account_number_hash" VARCHAR(64) NOT NULL,
    "account_name" VARCHAR(255) NOT NULL,
    "verification_status" VARCHAR(32) NOT NULL DEFAULT 'PENDING',
    "is_default" BOOLEAN NOT NULL DEFAULT true,
    "verified_at" TIMESTAMPTZ(6),
    "last_verified_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "store_bank_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_account_verification_transactions" (
    "id" BIGSERIAL NOT NULL,
    "bank_account_id" BIGINT NOT NULL,
    "reference_code" VARCHAR(64) NOT NULL,
    "expected_amount" DECIMAL(15,2) NOT NULL DEFAULT 2000,
    "received_amount" DECIMAL(15,2),
    "provider_transaction_id" VARCHAR(128),
    "status" VARCHAR(32) NOT NULL DEFAULT 'PENDING',
    "failure_reason" VARCHAR(64),
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "verified_at" TIMESTAMPTZ(6),
    "refund_status" VARCHAR(32),
    "refund_transaction_id" VARCHAR(128),
    "refunded_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bank_account_verification_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "notification_id" BIGSERIAL NOT NULL,
    "user_id" BIGINT NOT NULL,
    "type" VARCHAR(50) NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "body" TEXT NOT NULL,
    "data" JSONB,
    "idempotency_key" VARCHAR(128) NOT NULL,
    "read_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("notification_id")
);

-- CreateTable
CREATE TABLE "api_idempotency_keys" (
    "id" BIGSERIAL NOT NULL,
    "idempotency_key" VARCHAR(128) NOT NULL,
    "method" VARCHAR(10) NOT NULL DEFAULT 'POST',
    "actual_path" VARCHAR(255) NOT NULL DEFAULT '/',
    "actor_scope" VARCHAR(128) NOT NULL DEFAULT 'public',
    "route" VARCHAR(255) NOT NULL,
    "user_id" BIGINT,
    "request_hash" CHAR(64) NOT NULL,
    "status_code" INTEGER,
    "response_body" JSONB,
    "status" VARCHAR(20) NOT NULL DEFAULT 'PROCESSING',
    "lock_token" VARCHAR(64),
    "locked_until" TIMESTAMPTZ(6) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_idempotency_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dead_letter_jobs" (
    "id" VARCHAR(64) NOT NULL,
    "queue_name" VARCHAR(64) NOT NULL,
    "job_name" VARCHAR(128) NOT NULL,
    "payload" JSONB NOT NULL,
    "attempts_made" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 3,
    "failed_reason" TEXT,
    "stacktrace" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" VARCHAR(32) NOT NULL DEFAULT 'DEAD',
    "replay_job_id" VARCHAR(128),
    "failed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dead_letter_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_auth_identities" (
    "id" UUID NOT NULL,
    "user_id" BIGINT NOT NULL,
    "provider" VARCHAR(32) NOT NULL,
    "provider_subject" VARCHAR(255) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_auth_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_movements" (
    "movement_id" BIGSERIAL NOT NULL,
    "button_id" BIGINT NOT NULL,
    "source_type" VARCHAR(30) NOT NULL,
    "source_store_id" BIGINT,
    "dest_type" VARCHAR(30) NOT NULL,
    "dest_store_id" BIGINT,
    "rental_id" BIGINT,
    "actor_user_id" BIGINT,
    "reason" VARCHAR(255),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_movements_pkey" PRIMARY KEY ("movement_id")
);

-- CreateTable
CREATE TABLE "billing_charges" (
    "charge_id" BIGSERIAL NOT NULL,
    "charge_code" VARCHAR(64) NOT NULL,
    "purpose" VARCHAR(32) NOT NULL,
    "target_type" VARCHAR(32) NOT NULL,
    "target_id" BIGINT NOT NULL,
    "payer_store_id" BIGINT,
    "currency" VARCHAR(10) NOT NULL DEFAULT 'VND',
    "total_amount" DECIMAL(15,2) NOT NULL,
    "paid_amount" DECIMAL(15,2) DEFAULT 0.00,
    "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    "paid_at" TIMESTAMPTZ(6),
    "payment_method" VARCHAR(32),
    "qr_code" TEXT,
    "payment_link_id" VARCHAR(128),
    "checkout_url" VARCHAR(1024),
    "provider_transaction_code" VARCHAR(128),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_charges_pkey" PRIMARY KEY ("charge_id")
);

-- CreateTable
CREATE TABLE "store_cash_vouchers" (
    "id" BIGSERIAL NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "customer_id" BIGINT NOT NULL,
    "rental_id" BIGINT NOT NULL,
    "charge_id" BIGINT NOT NULL,
    "target_type" VARCHAR(32) NOT NULL DEFAULT 'RENTAL',
    "collecting_store_id" BIGINT NOT NULL,
    "amount" DECIMAL(15,2) NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "consumed_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "store_cash_vouchers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "store_cash_receipts" (
    "id" BIGSERIAL NOT NULL,
    "charge_id" BIGINT NOT NULL,
    "voucher_id" BIGINT NOT NULL,
    "collecting_store_id" BIGINT NOT NULL,
    "amount" DECIMAL(15,2) NOT NULL,
    "wallet_transaction_id" BIGINT NOT NULL,
    "request_hash" VARCHAR(64),
    "collected_by_user_id" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "store_cash_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_payment_receipts" (
    "id" BIGSERIAL NOT NULL,
    "charge_id" BIGINT NOT NULL,
    "provider" VARCHAR(32) NOT NULL,
    "channel" VARCHAR(64) NOT NULL,
    "provider_transaction_ref" VARCHAR(128) NOT NULL,
    "amount" DECIMAL(15,2) NOT NULL,
    "currency" VARCHAR(10) NOT NULL DEFAULT 'VND',
    "classification" VARCHAR(32) NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_payment_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_overpayment_obligations" (
    "id" BIGSERIAL NOT NULL,
    "receipt_id" BIGINT NOT NULL,
    "amount" DECIMAL(15,2) NOT NULL,
    "receipt_classification" VARCHAR(32) NOT NULL DEFAULT 'OVERPAYMENT_RECEIPT',
    "status" VARCHAR(32) NOT NULL DEFAULT 'PENDING_RECONCILIATION',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_overpayment_obligations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_charge_lines" (
    "line_id" BIGSERIAL NOT NULL,
    "charge_id" BIGINT NOT NULL,
    "line_type" VARCHAR(32) NOT NULL,
    "amount" DECIMAL(15,2) NOT NULL,
    "duration_unit" VARCHAR(10) DEFAULT 'MONTH',
    "duration_count" INTEGER DEFAULT 1,
    "quantity" INTEGER DEFAULT 1,
    "unit_price" DECIMAL(15,2),
    "description" VARCHAR(255),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_charge_lines_pkey" PRIMARY KEY ("line_id")
);

-- CreateTable
CREATE TABLE "rental_deposits" (
    "deposit_id" BIGSERIAL NOT NULL,
    "rental_id" BIGINT NOT NULL,
    "collected_amount" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "held_amount" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "refund_reserved_amount" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "refunded_amount" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rental_deposits_pkey" PRIMARY KEY ("deposit_id")
);

-- CreateTable
CREATE TABLE "rental_returns" (
    "return_id" BIGSERIAL NOT NULL,
    "return_code" VARCHAR(64) NOT NULL,
    "rental_id" BIGINT NOT NULL,
    "button_id" BIGINT NOT NULL,
    "status" VARCHAR(30) NOT NULL DEFAULT 'PENDING_RECEIPT',
    "received_by_user_id" BIGINT,
    "inspected_by_user_id" BIGINT,
    "inspection_note" TEXT,
    "received_at" TIMESTAMPTZ(6),
    "inspected_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rental_returns_pkey" PRIMARY KEY ("return_id")
);

-- CreateTable
CREATE TABLE "deposit_refunds" (
    "refund_id" BIGSERIAL NOT NULL,
    "refund_code" VARCHAR(64) NOT NULL,
    "return_id" BIGINT,
    "rental_id" BIGINT NOT NULL,
    "customer_id" BIGINT NOT NULL,
    "bank_account_id" BIGINT,
    "recipient_bin" VARCHAR(10),
    "recipient_account_number_encrypted" TEXT,
    "recipient_account_number_hash" VARCHAR(64),
    "recipient_account_holder_name" VARCHAR(255),
    "recipient_account_number_masked" VARCHAR(32),
    "amount" DECIMAL(15,2) NOT NULL,
    "status" VARCHAR(30) NOT NULL DEFAULT 'PENDING_APPROVAL',
    "approved_by_user_id" BIGINT,
    "rejection_reason" VARCHAR(255),
    "provider_reference_id" VARCHAR(128),
    "payout_error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "refunded_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deposit_refunds_pkey" PRIMARY KEY ("refund_id")
);

-- CreateTable
CREATE TABLE "customer_bank_accounts" (
    "id" BIGSERIAL NOT NULL,
    "customer_id" BIGINT NOT NULL,
    "bank_bin" VARCHAR(10) NOT NULL,
    "bank_code" VARCHAR(20),
    "bank_name" VARCHAR(100) NOT NULL,
    "account_number_encrypted" TEXT NOT NULL,
    "account_number_hash" VARCHAR(64) NOT NULL,
    "account_number_masked" VARCHAR(32) NOT NULL,
    "account_name" VARCHAR(255) NOT NULL,
    "verification_status" VARCHAR(32) NOT NULL DEFAULT 'PENDING',
    "is_default" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_bank_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_bank_verification_proofs" (
    "id" BIGSERIAL NOT NULL,
    "proof_reference" VARCHAR(128) NOT NULL,
    "customer_id" BIGINT NOT NULL,
    "account_id" BIGINT NOT NULL,
    "bank_bin" VARCHAR(10) NOT NULL,
    "account_number_hash" VARCHAR(64) NOT NULL,
    "status" VARCHAR(32) NOT NULL DEFAULT 'PENDING',
    "session_status" VARCHAR(32) NOT NULL DEFAULT 'ACTIVE',
    "provider" VARCHAR(32) NOT NULL DEFAULT 'PAYOS',
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "payment_order_code" BIGINT,
    "payment_link_id" VARCHAR(128),
    "payment_checkout_url" TEXT,
    "verification_status" VARCHAR(32) NOT NULL DEFAULT 'PENDING',
    "verified_at" TIMESTAMPTZ(6),
    "verified_by_transaction_id" BIGINT,
    "rejection_reason" VARCHAR(255),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_bank_verification_proofs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_bank_inbound_transactions" (
    "id" BIGSERIAL NOT NULL,
    "proof_id" BIGINT,
    "provider" VARCHAR(32) NOT NULL DEFAULT 'PAYOS',
    "channel" VARCHAR(64) NOT NULL DEFAULT 'DEFAULT',
    "provider_transaction_ref" VARCHAR(128) NOT NULL,
    "amount" DECIMAL(15,2) NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL,
    "is_late_payment" BOOLEAN NOT NULL DEFAULT false,
    "source_bank_bin" VARCHAR(10),
    "source_account_masked" VARCHAR(32),
    "source_account_hash" VARCHAR(64),
    "source_account_encrypted" TEXT,
    "source_account_name" VARCHAR(255),
    "has_sufficient_evidence" BOOLEAN NOT NULL DEFAULT false,
    "session_match_status" VARCHAR(32) NOT NULL DEFAULT 'MATCHED_SESSION',
    "match_decision" VARCHAR(32) NOT NULL DEFAULT 'PENDING',
    "raw_payload_checksum" VARCHAR(64),
    "reconciliation_flag" VARCHAR(64),
    "merged_into_inbound_id" BIGINT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_bank_inbound_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_bank_refund_obligations" (
    "id" BIGSERIAL NOT NULL,
    "inbound_transaction_id" BIGINT NOT NULL,
    "refund_amount" DECIMAL(15,2) NOT NULL,
    "refund_status" VARCHAR(32) NOT NULL DEFAULT 'PENDING_REFUND',
    "target_bank_bin" VARCHAR(10),
    "target_account_masked" VARCHAR(32),
    "target_account_hash" VARCHAR(64),
    "target_account_encrypted" TEXT,
    "target_account_name" VARCHAR(255),
    "refund_payout_reference" VARCHAR(128) NOT NULL,
    "active_payout_attempt_id" BIGINT,
    "refunded_at" TIMESTAMPTZ(6),
    "failure_reason" VARCHAR(255),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_bank_refund_obligations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_bank_refund_payout_attempts" (
    "id" BIGSERIAL NOT NULL,
    "obligation_id" BIGINT NOT NULL,
    "attempt_number" INTEGER NOT NULL,
    "payout_provider" VARCHAR(32) NOT NULL DEFAULT 'PAYOS',
    "payout_reference" VARCHAR(128) NOT NULL,
    "provider_payout_id" VARCHAR(128),
    "status" VARCHAR(32) NOT NULL DEFAULT 'PREPARING',
    "dispatched_at" TIMESTAMPTZ(6),
    "reconciled_at" TIMESTAMPTZ(6),
    "response_code" VARCHAR(32),
    "failure_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_bank_refund_payout_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "access_adjustments" (
    "id" BIGSERIAL NOT NULL,
    "target_type" VARCHAR(32) NOT NULL,
    "target_id" BIGINT NOT NULL,
    "operation" VARCHAR(32) NOT NULL,
    "additional_days" INTEGER,
    "previous_expires_at" TIMESTAMPTZ(6),
    "new_expires_at" TIMESTAMPTZ(6) NOT NULL,
    "reason" VARCHAR(255) NOT NULL,
    "actor_user_id" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "access_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" BIGSERIAL NOT NULL,
    "event_type" VARCHAR(64) NOT NULL,
    "payload" JSONB NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    "claim_token" VARCHAR(64),
    "locked_until" TIMESTAMPTZ(6),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(6),
    "error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rental_audit_logs" (
    "audit_id" BIGSERIAL NOT NULL,
    "actor_type" VARCHAR(32) NOT NULL,
    "actor_user_id" BIGINT,
    "action" VARCHAR(64) NOT NULL,
    "target_type" VARCHAR(32) NOT NULL,
    "target_id" BIGINT NOT NULL,
    "before_state" VARCHAR(64),
    "after_state" VARCHAR(64),
    "amount" DECIMAL(15,2),
    "correlation_id" VARCHAR(128),
    "idempotency_key" VARCHAR(128),
    "reason" VARCHAR(255),
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rental_audit_logs_pkey" PRIMARY KEY ("audit_id")
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
CREATE UNIQUE INDEX "uq_users_phone" ON "users"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "users_firebase_uid_key" ON "users"("firebase_uid");

-- CreateIndex
CREATE UNIQUE INDEX "uq_users_auth_provider_subject" ON "users"("auth_provider", "provider_subject");

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
CREATE INDEX "idx_product_store_status_price" ON "product"("store_id", "status", "base_price");

-- CreateIndex
CREATE INDEX "idx_product_store_cat_status" ON "product"("store_id", "category_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "product_store_id_product_code_key" ON "product"("store_id", "product_code");

-- CreateIndex
CREATE UNIQUE INDEX "product_store_id_product_id_key" ON "product"("store_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_product_id_key" ON "inventory"("product_id");

-- CreateIndex
CREATE INDEX "idx_inventory_store_stock_alert" ON "inventory"("store_id", "quantity_on_hand", "min_stock_alert");

-- CreateIndex
CREATE UNIQUE INDEX "iot_button_device_id_key" ON "iot_button"("device_id");

-- CreateIndex
CREATE UNIQUE INDEX "iot_button_button_code_key" ON "iot_button"("button_code");

-- CreateIndex
CREATE INDEX "idx_iot_button_store_status_battery" ON "iot_button"("store_id", "status", "battery_level");

-- CreateIndex
CREATE INDEX "idx_iot_button_custody_inventory" ON "iot_button"("custody_store_id", "inventory_state");

-- CreateIndex
CREATE UNIQUE INDEX "iot_button_button_id_customer_id_store_id_key" ON "iot_button"("button_id", "customer_id", "store_id");

-- CreateIndex
CREATE UNIQUE INDEX "button_product_button_id_product_id_key" ON "button_product"("button_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "orders_order_code_key" ON "orders"("order_code");

-- CreateIndex
CREATE INDEX "idx_orders_store_status_created" ON "orders"("store_id", "order_status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_orders_customer_status_created" ON "orders"("customer_id", "order_status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_orders_driver_status" ON "orders"("assigned_driver_id", "order_status");

-- CreateIndex
CREATE INDEX "idx_orders_order_date" ON "orders"("order_date" DESC);

-- CreateIndex
CREATE INDEX "idx_orders_store_date_status" ON "orders"("store_id", "order_date" DESC, "order_status");

-- CreateIndex
CREATE INDEX "idx_orders_customer_date_status" ON "orders"("customer_id", "order_date" DESC, "order_status");

-- CreateIndex
CREATE UNIQUE INDEX "uq_orders_button_request" ON "orders"("button_id", "iot_request_id");

-- CreateIndex
CREATE INDEX "idx_payment_tx_order_status" ON "payment_transaction"("order_id", "status");

-- CreateIndex
CREATE INDEX "idx_payment_tx_rental_status" ON "payment_transaction"("rental_id", "status");

-- CreateIndex
CREATE INDEX "idx_payment_tx_created_at" ON "payment_transaction"("created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_payment_tx_status_order_created" ON "payment_transaction"("status", "order_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "user_fcm_tokens_token_key" ON "user_fcm_tokens"("token");

-- CreateIndex
CREATE INDEX "user_fcm_tokens_user_id_is_active_idx" ON "user_fcm_tokens"("user_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "device_templates_code_key" ON "device_templates"("code");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_plans_plan_code_key" ON "subscription_plans"("plan_code");

-- CreateIndex
CREATE UNIQUE INDEX "rental_packages_package_code_key" ON "rental_packages"("package_code");

-- CreateIndex
CREATE UNIQUE INDEX "button_rentals_rental_code_key" ON "button_rentals"("rental_code");

-- CreateIndex
CREATE INDEX "idx_button_rentals_customer_status" ON "button_rentals"("customer_id", "status");

-- CreateIndex
CREATE INDEX "idx_button_rentals_package_status" ON "button_rentals"("package_id", "status");

-- CreateIndex
CREATE INDEX "idx_button_rentals_fulfillment_status" ON "button_rentals"("fulfillment_store_id", "status");

-- CreateIndex
CREATE INDEX "idx_button_rentals_billing_policy" ON "button_rentals"("billing_policy");

-- CreateIndex
CREATE INDEX "idx_button_rentals_policy_review" ON "button_rentals"("billing_policy_review_required");

-- CreateIndex
CREATE UNIQUE INDEX "uq_rental_customer_cash_binding" ON "button_rentals"("rental_id", "customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "store_wallets_store_id_key" ON "store_wallets"("store_id");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_transactions_wallet_id_type_reference_id_key" ON "wallet_transactions"("wallet_id", "type", "reference_id");

-- CreateIndex
CREATE UNIQUE INDEX "store_withdrawals_withdrawal_code_key" ON "store_withdrawals"("withdrawal_code");

-- CreateIndex
CREATE UNIQUE INDEX "store_withdrawals_provider_reference_id_key" ON "store_withdrawals"("provider_reference_id");

-- CreateIndex
CREATE INDEX "idx_store_withdrawals_acc_hash" ON "store_withdrawals"("bank_account_hash");

-- CreateIndex
CREATE INDEX "idx_store_withdrawals_provider_ref" ON "store_withdrawals"("provider_reference_id");

-- CreateIndex
CREATE INDEX "idx_store_withdrawals_store_status_created" ON "store_withdrawals"("store_id", "status", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "uq_store_withdrawals_store_idempotency" ON "store_withdrawals"("store_id", "idempotency_key");

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

-- CreateIndex
CREATE UNIQUE INDEX "driver_duties_driver_id_key" ON "driver_duties"("driver_id");

-- CreateIndex
CREATE INDEX "idx_driver_shifts_store_status_started" ON "driver_shifts"("store_id", "status", "started_at" DESC);

-- CreateIndex
CREATE INDEX "idx_driver_shifts_driver_status" ON "driver_shifts"("driver_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "identity_verification_sessions_didit_session_id_key" ON "identity_verification_sessions"("didit_session_id");

-- CreateIndex
CREATE INDEX "identity_verification_sessions_user_id_idx" ON "identity_verification_sessions"("user_id");

-- CreateIndex
CREATE INDEX "identity_verification_sessions_status_idx" ON "identity_verification_sessions"("status");

-- CreateIndex
CREATE UNIQUE INDEX "didit_webhook_events_event_id_key" ON "didit_webhook_events"("event_id");

-- CreateIndex
CREATE UNIQUE INDEX "didit_webhook_events_payload_hash_key" ON "didit_webhook_events"("payload_hash");

-- CreateIndex
CREATE INDEX "didit_webhook_events_didit_session_id_idx" ON "didit_webhook_events"("didit_session_id");

-- CreateIndex
CREATE INDEX "idx_store_bank_accounts_acc_hash" ON "store_bank_accounts"("account_number_hash");

-- CreateIndex
CREATE INDEX "idx_store_bank_accounts_status" ON "store_bank_accounts"("store_id", "verification_status");

-- CreateIndex
CREATE UNIQUE INDEX "store_bank_accounts_store_id_account_number_hash_key" ON "store_bank_accounts"("store_id", "account_number_hash");

-- CreateIndex
CREATE UNIQUE INDEX "uq_bank_verify_tx_provider_tx_id" ON "bank_account_verification_transactions"("provider_transaction_id");

-- CreateIndex
CREATE INDEX "idx_bank_verify_tx_ref_code" ON "bank_account_verification_transactions"("reference_code");

-- CreateIndex
CREATE INDEX "idx_bank_verify_tx_status" ON "bank_account_verification_transactions"("status");

-- CreateIndex
CREATE UNIQUE INDEX "bank_account_verification_transactions_bank_account_id_refe_key" ON "bank_account_verification_transactions"("bank_account_id", "reference_code");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_idempotency_key_key" ON "notifications"("idempotency_key");

-- CreateIndex
CREATE INDEX "idx_notifications_user_read" ON "notifications"("user_id", "read_at");

-- CreateIndex
CREATE INDEX "idx_notifications_user_created" ON "notifications"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "idx_api_idempotency_expires_at" ON "api_idempotency_keys"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "api_idempotency_keys_actor_scope_idempotency_key_method_act_key" ON "api_idempotency_keys"("actor_scope", "idempotency_key", "method", "actual_path");

-- CreateIndex
CREATE INDEX "idx_dead_letter_queue_name" ON "dead_letter_jobs"("queue_name");

-- CreateIndex
CREATE INDEX "idx_dead_letter_status" ON "dead_letter_jobs"("status");

-- CreateIndex
CREATE INDEX "idx_dead_letter_replay_job_id" ON "dead_letter_jobs"("replay_job_id");

-- CreateIndex
CREATE INDEX "idx_user_auth_identities_user_id" ON "user_auth_identities"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_user_auth_identities_provider_subject" ON "user_auth_identities"("provider", "provider_subject");

-- CreateIndex
CREATE UNIQUE INDEX "uq_user_auth_identities_user_provider" ON "user_auth_identities"("user_id", "provider");

-- CreateIndex
CREATE INDEX "idx_device_movements_button" ON "device_movements"("button_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_device_movements_source_store" ON "device_movements"("source_store_id");

-- CreateIndex
CREATE INDEX "idx_device_movements_dest_store" ON "device_movements"("dest_store_id");

-- CreateIndex
CREATE UNIQUE INDEX "billing_charges_charge_code_key" ON "billing_charges"("charge_code");

-- CreateIndex
CREATE UNIQUE INDEX "uq_billing_charges_provider_tx" ON "billing_charges"("provider_transaction_code");

-- CreateIndex
CREATE INDEX "idx_billing_charges_target" ON "billing_charges"("target_type", "target_id", "status");

-- CreateIndex
CREATE INDEX "idx_billing_charges_status_created" ON "billing_charges"("status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_billing_charges_payer_store" ON "billing_charges"("payer_store_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_charge_cash_binding" ON "billing_charges"("charge_id", "target_type", "target_id", "total_amount");

-- CreateIndex
CREATE UNIQUE INDEX "uq_cash_voucher_token_hash" ON "store_cash_vouchers"("token_hash");

-- CreateIndex
CREATE INDEX "idx_cash_voucher_store_expiry" ON "store_cash_vouchers"("collecting_store_id", "status", "expires_at");

-- CreateIndex
CREATE INDEX "idx_cash_voucher_charge" ON "store_cash_vouchers"("charge_id");

-- CreateIndex
CREATE INDEX "idx_cash_voucher_rental_customer" ON "store_cash_vouchers"("rental_id", "customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_cash_voucher_receipt_binding" ON "store_cash_vouchers"("id", "charge_id", "collecting_store_id", "amount");

-- CreateIndex
CREATE UNIQUE INDEX "uq_cash_receipt_charge" ON "store_cash_receipts"("charge_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_cash_receipt_voucher" ON "store_cash_receipts"("voucher_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_cash_receipt_wallet_tx" ON "store_cash_receipts"("wallet_transaction_id");

-- CreateIndex
CREATE INDEX "idx_cash_receipt_store_created" ON "store_cash_receipts"("collecting_store_id", "created_at");

-- CreateIndex
CREATE INDEX "idx_cash_receipt_actor" ON "store_cash_receipts"("collected_by_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_cash_receipt_voucher_binding" ON "store_cash_receipts"("voucher_id", "charge_id", "collecting_store_id", "amount");

-- CreateIndex
CREATE INDEX "idx_billing_receipt_charge_received" ON "billing_payment_receipts"("charge_id", "received_at");

-- CreateIndex
CREATE UNIQUE INDEX "uq_billing_receipt_provider_channel_ref" ON "billing_payment_receipts"("provider", "channel", "provider_transaction_ref");

-- CreateIndex
CREATE UNIQUE INDEX "uq_billing_receipt_obligation_binding" ON "billing_payment_receipts"("id", "amount", "classification");

-- CreateIndex
CREATE UNIQUE INDEX "uq_billing_overpayment_receipt" ON "billing_overpayment_obligations"("receipt_id");

-- CreateIndex
CREATE INDEX "idx_billing_overpayment_queue" ON "billing_overpayment_obligations"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "uq_billing_overpayment_binding" ON "billing_overpayment_obligations"("receipt_id", "amount", "receipt_classification");

-- CreateIndex
CREATE INDEX "idx_billing_charge_lines_charge" ON "billing_charge_lines"("charge_id");

-- CreateIndex
CREATE UNIQUE INDEX "rental_deposits_rental_id_key" ON "rental_deposits"("rental_id");

-- CreateIndex
CREATE UNIQUE INDEX "rental_returns_return_code_key" ON "rental_returns"("return_code");

-- CreateIndex
CREATE INDEX "idx_rental_returns_rental_status" ON "rental_returns"("rental_id", "status");

-- CreateIndex
CREATE INDEX "idx_rental_returns_button" ON "rental_returns"("button_id");

-- CreateIndex
CREATE UNIQUE INDEX "deposit_refunds_refund_code_key" ON "deposit_refunds"("refund_code");

-- CreateIndex
CREATE UNIQUE INDEX "uq_deposit_refunds_return_id" ON "deposit_refunds"("return_id");

-- CreateIndex
CREATE UNIQUE INDEX "deposit_refunds_provider_reference_id_key" ON "deposit_refunds"("provider_reference_id");

-- CreateIndex
CREATE INDEX "idx_deposit_refunds_customer_status" ON "deposit_refunds"("customer_id", "status");

-- CreateIndex
CREATE INDEX "idx_deposit_refunds_rental" ON "deposit_refunds"("rental_id");

-- CreateIndex
CREATE INDEX "idx_customer_bank_default" ON "customer_bank_accounts"("customer_id", "is_default");

-- CreateIndex
CREATE UNIQUE INDEX "customer_bank_accounts_customer_id_account_number_hash_key" ON "customer_bank_accounts"("customer_id", "account_number_hash");

-- CreateIndex
CREATE UNIQUE INDEX "uq_cust_bank_proof_ref" ON "customer_bank_verification_proofs"("proof_reference");

-- CreateIndex
CREATE UNIQUE INDEX "uq_cust_bank_payment_order_code" ON "customer_bank_verification_proofs"("payment_order_code");

-- CreateIndex
CREATE INDEX "idx_cust_bank_proof_cust_acc" ON "customer_bank_verification_proofs"("customer_id", "account_id");

-- CreateIndex
CREATE INDEX "idx_cust_bank_inbound_proof_id" ON "customer_bank_inbound_transactions"("proof_id");

-- CreateIndex
CREATE INDEX "idx_cust_bank_inbound_match_status" ON "customer_bank_inbound_transactions"("session_match_status");

-- CreateIndex
CREATE INDEX "idx_cust_bank_inbound_merged_into" ON "customer_bank_inbound_transactions"("merged_into_inbound_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_cust_bank_inbound_provider_channel_ref" ON "customer_bank_inbound_transactions"("provider", "channel", "provider_transaction_ref");

-- CreateIndex
CREATE UNIQUE INDEX "uq_cust_bank_refund_inbound_tx" ON "customer_bank_refund_obligations"("inbound_transaction_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_cust_bank_refund_payout_ref" ON "customer_bank_refund_obligations"("refund_payout_reference");

-- CreateIndex
CREATE INDEX "idx_cust_bank_refund_status" ON "customer_bank_refund_obligations"("refund_status");

-- CreateIndex
CREATE INDEX "idx_cust_bank_attempt_obligation_id" ON "customer_bank_refund_payout_attempts"("obligation_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_cust_bank_attempt_obligation_number" ON "customer_bank_refund_payout_attempts"("obligation_id", "attempt_number");

-- CreateIndex
CREATE UNIQUE INDEX "uq_cust_bank_attempt_provider_ref" ON "customer_bank_refund_payout_attempts"("payout_provider", "payout_reference");

-- CreateIndex
CREATE INDEX "idx_access_adjustments_target" ON "access_adjustments"("target_type", "target_id");

-- CreateIndex
CREATE INDEX "idx_outbox_events_status_next" ON "outbox_events"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "idx_rental_audit_target" ON "rental_audit_logs"("target_type", "target_id");

-- CreateIndex
CREATE INDEX "idx_rental_audit_action_created" ON "rental_audit_logs"("action", "created_at");

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
ALTER TABLE "iot_button" ADD CONSTRAINT "iot_button_custody_store_id_fkey" FOREIGN KEY ("custody_store_id") REFERENCES "store"("store_id") ON DELETE SET NULL ON UPDATE CASCADE;

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
ALTER TABLE "orders" ADD CONSTRAINT "orders_assigned_driver_id_fkey" FOREIGN KEY ("assigned_driver_id") REFERENCES "users"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;

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
ALTER TABLE "payment_transaction" ADD CONSTRAINT "payment_transaction_rental_id_fkey" FOREIGN KEY ("rental_id") REFERENCES "button_rentals"("rental_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_fcm_tokens" ADD CONSTRAINT "user_fcm_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_templates" ADD CONSTRAINT "device_templates_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "store"("store_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_templates" ADD CONSTRAINT "device_templates_default_product_id_fkey" FOREIGN KEY ("default_product_id") REFERENCES "product"("product_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_subscriptions" ADD CONSTRAINT "store_subscriptions_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "store"("store_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_subscriptions" ADD CONSTRAINT "store_subscriptions_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "subscription_plans"("plan_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "button_rentals" ADD CONSTRAINT "button_rentals_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer_profile"("customer_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "button_rentals" ADD CONSTRAINT "button_rentals_package_id_fkey" FOREIGN KEY ("package_id") REFERENCES "rental_packages"("package_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "button_rentals" ADD CONSTRAINT "button_rentals_fulfillment_store_id_fkey" FOREIGN KEY ("fulfillment_store_id") REFERENCES "store"("store_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_wallets" ADD CONSTRAINT "store_wallets_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "store"("store_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "store_wallets"("wallet_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_withdrawals" ADD CONSTRAINT "store_withdrawals_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "store_wallets"("wallet_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_withdrawals" ADD CONSTRAINT "store_withdrawals_approved_by_user_id_fkey" FOREIGN KEY ("approved_by_user_id") REFERENCES "users"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_withdrawals" ADD CONSTRAINT "store_withdrawals_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "store"("store_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_withdrawals" ADD CONSTRAINT "store_withdrawals_bank_account_id_fkey" FOREIGN KEY ("bank_account_id") REFERENCES "store_bank_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

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

-- AddForeignKey
ALTER TABLE "driver_duties" ADD CONSTRAINT "driver_duties_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_duties" ADD CONSTRAINT "driver_duties_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "store"("store_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_shifts" ADD CONSTRAINT "driver_shifts_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "store"("store_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_shifts" ADD CONSTRAINT "driver_shifts_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "users"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_shifts" ADD CONSTRAINT "driver_shifts_confirmed_by_user_id_fkey" FOREIGN KEY ("confirmed_by_user_id") REFERENCES "users"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity_verification_sessions" ADD CONSTRAINT "identity_verification_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "didit_webhook_events" ADD CONSTRAINT "didit_webhook_events_didit_session_id_fkey" FOREIGN KEY ("didit_session_id") REFERENCES "identity_verification_sessions"("didit_session_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_bank_accounts" ADD CONSTRAINT "store_bank_accounts_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "store"("store_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_account_verification_transactions" ADD CONSTRAINT "bank_account_verification_transactions_bank_account_id_fkey" FOREIGN KEY ("bank_account_id") REFERENCES "store_bank_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_idempotency_keys" ADD CONSTRAINT "api_idempotency_keys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_auth_identities" ADD CONSTRAINT "user_auth_identities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_movements" ADD CONSTRAINT "device_movements_button_id_fkey" FOREIGN KEY ("button_id") REFERENCES "iot_button"("button_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_cash_vouchers" ADD CONSTRAINT "store_cash_vouchers_rental_id_customer_id_fkey" FOREIGN KEY ("rental_id", "customer_id") REFERENCES "button_rentals"("rental_id", "customer_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "store_cash_vouchers" ADD CONSTRAINT "store_cash_vouchers_charge_id_target_type_rental_id_amount_fkey" FOREIGN KEY ("charge_id", "target_type", "rental_id", "amount") REFERENCES "billing_charges"("charge_id", "target_type", "target_id", "total_amount") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "store_cash_vouchers" ADD CONSTRAINT "store_cash_vouchers_collecting_store_id_fkey" FOREIGN KEY ("collecting_store_id") REFERENCES "store"("store_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "store_cash_receipts" ADD CONSTRAINT "store_cash_receipts_voucher_binding_fkey" FOREIGN KEY ("voucher_id", "charge_id", "collecting_store_id", "amount") REFERENCES "store_cash_vouchers"("id", "charge_id", "collecting_store_id", "amount") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "store_cash_receipts" ADD CONSTRAINT "store_cash_receipts_wallet_transaction_id_fkey" FOREIGN KEY ("wallet_transaction_id") REFERENCES "wallet_transactions"("transaction_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "store_cash_receipts" ADD CONSTRAINT "store_cash_receipts_collected_by_user_id_fkey" FOREIGN KEY ("collected_by_user_id") REFERENCES "users"("user_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "billing_charges" ADD CONSTRAINT "billing_charges_payer_store_id_fkey" FOREIGN KEY ("payer_store_id") REFERENCES "store"("store_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_payment_receipts" ADD CONSTRAINT "billing_payment_receipts_charge_id_fkey" FOREIGN KEY ("charge_id") REFERENCES "billing_charges"("charge_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "billing_overpayment_obligations" ADD CONSTRAINT "billing_overpayment_obligations_receipt_binding_fkey" FOREIGN KEY ("receipt_id", "amount", "receipt_classification") REFERENCES "billing_payment_receipts"("id", "amount", "classification") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "billing_charge_lines" ADD CONSTRAINT "billing_charge_lines_charge_id_fkey" FOREIGN KEY ("charge_id") REFERENCES "billing_charges"("charge_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rental_deposits" ADD CONSTRAINT "rental_deposits_rental_id_fkey" FOREIGN KEY ("rental_id") REFERENCES "button_rentals"("rental_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rental_returns" ADD CONSTRAINT "rental_returns_rental_id_fkey" FOREIGN KEY ("rental_id") REFERENCES "button_rentals"("rental_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rental_returns" ADD CONSTRAINT "rental_returns_button_id_fkey" FOREIGN KEY ("button_id") REFERENCES "iot_button"("button_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deposit_refunds" ADD CONSTRAINT "deposit_refunds_return_id_fkey" FOREIGN KEY ("return_id") REFERENCES "rental_returns"("return_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deposit_refunds" ADD CONSTRAINT "deposit_refunds_rental_id_fkey" FOREIGN KEY ("rental_id") REFERENCES "button_rentals"("rental_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deposit_refunds" ADD CONSTRAINT "deposit_refunds_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer_profile"("customer_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deposit_refunds" ADD CONSTRAINT "deposit_refunds_bank_account_id_fkey" FOREIGN KEY ("bank_account_id") REFERENCES "customer_bank_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_bank_accounts" ADD CONSTRAINT "customer_bank_accounts_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer_profile"("customer_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_bank_verification_proofs" ADD CONSTRAINT "customer_bank_verification_proofs_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer_profile"("customer_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_bank_verification_proofs" ADD CONSTRAINT "customer_bank_verification_proofs_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "customer_bank_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_bank_verification_proofs" ADD CONSTRAINT "customer_bank_verification_proofs_verified_by_transaction__fkey" FOREIGN KEY ("verified_by_transaction_id") REFERENCES "customer_bank_inbound_transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_bank_inbound_transactions" ADD CONSTRAINT "customer_bank_inbound_transactions_proof_id_fkey" FOREIGN KEY ("proof_id") REFERENCES "customer_bank_verification_proofs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_bank_inbound_transactions" ADD CONSTRAINT "customer_bank_inbound_transactions_merged_into_inbound_id_fkey" FOREIGN KEY ("merged_into_inbound_id") REFERENCES "customer_bank_inbound_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_bank_refund_obligations" ADD CONSTRAINT "customer_bank_refund_obligations_inbound_transaction_id_fkey" FOREIGN KEY ("inbound_transaction_id") REFERENCES "customer_bank_inbound_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_bank_refund_obligations" ADD CONSTRAINT "customer_bank_refund_obligations_active_payout_attempt_id_fkey" FOREIGN KEY ("active_payout_attempt_id") REFERENCES "customer_bank_refund_payout_attempts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_bank_refund_payout_attempts" ADD CONSTRAINT "customer_bank_refund_payout_attempts_obligation_id_fkey" FOREIGN KEY ("obligation_id") REFERENCES "customer_bank_refund_obligations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- ==============================================================================
-- STORED PROCEDURE: sp_create_order_from_button
-- ==============================================================================
CREATE OR REPLACE FUNCTION public.sp_create_order_from_button(
    p_button_id bigint,
    p_payment_method character varying DEFAULT 'COD'::character varying,
    p_shipping_fee numeric DEFAULT 0,
    p_order_note text DEFAULT NULL::text,
    p_iot_request_id character varying DEFAULT NULL::character varying
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
    v_btn RECORD;
    v_rental RECORD;
    v_order_id BIGINT;
    v_order_code VARCHAR(50);
    v_subtotal DECIMAL(15,2) := 0;
    v_total_discount DECIMAL(15,2) := 0;
    v_item RECORD;
    v_discount RECORD;
    v_unit_discount DECIMAL(15,2);
    v_final_price DECIMAL(15,2);
    v_line_subtotal DECIMAL(15,2);
    v_comm_rate DECIMAL(5,2) := 8.00;
    v_tot_amt DECIMAL(15,2);
    v_comm_amt DECIMAL(15,2);
    v_net_amt DECIMAL(15,2);
    v_existing_order_id BIGINT;
BEGIN
    -- 0. Idempotency Check (Safe Hit)
    IF p_iot_request_id IS NOT NULL THEN
        SELECT o.order_id INTO v_existing_order_id
        FROM orders o
        WHERE o.button_id = p_button_id AND o.iot_request_id = p_iot_request_id
        LIMIT 1;

        IF v_existing_order_id IS NOT NULL THEN
            RETURN v_existing_order_id;
        END IF;
    END IF;

    IF p_payment_method NOT IN ('COD', 'PAYOS') THEN
        RAISE EXCEPTION 'Phương thức thanh toán không hợp lệ: %. Chỉ chấp nhận COD hoặc PAYOS.', p_payment_method;
    END IF;

    IF p_shipping_fee < 0 THEN
        RAISE EXCEPTION 'Phí vận chuyển không được âm.';
    END IF;

    -- Pessimistic Lock on IoT Button (Locking Order: IoT Button first, then Rental)
    SELECT b.*, ca.recipient_name, ca.phone AS recipient_phone, ca.address_detail, ca.ward, ca.district, ca.province
    INTO v_btn
    FROM iot_button b
    JOIN customer_address ca ON b.customer_id = ca.customer_id AND b.address_id = ca.address_id
    WHERE b.button_id = p_button_id
    FOR UPDATE OF b;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Nút bấm ID % không tồn tại.', p_button_id USING ERRCODE = 'P0002';
    END IF;

    IF v_btn.status <> 'ACTIVE' THEN
        RAISE EXCEPTION 'Nút bấm ID % đang không ở trạng thái ACTIVE.', p_button_id USING ERRCODE = 'P0003';
    END IF;

    -- Entitlement and custody check
    IF v_btn.can_order = false OR v_btn.inventory_state IN ('RETURN_IN_TRANSIT', 'ALLOCATED_TO_STORE', 'IN_PLATFORM_WAREHOUSE') THEN
        RAISE EXCEPTION 'Nút bấm ID % không được phép đặt hàng (can_order=false hoặc đang trong kho/hoàn trả).', p_button_id USING ERRCODE = 'P0008';
    END IF;

    -- If button belongs to a rental contract, lock and verify rental state
    IF v_btn.rental_id IS NOT NULL THEN
        SELECT * INTO v_rental FROM button_rentals WHERE rental_id = v_btn.rental_id FOR UPDATE;
        IF NOT FOUND OR v_rental.status <> 'ACTIVE' THEN
            RAISE EXCEPTION 'Hợp đồng thuê của nút ID % chưa ở trạng thái ACTIVE (hiện tại: %). Không thể đặt hàng trước khi hoàn tất bàn giao.', p_button_id, COALESCE(v_rental.status, 'NOT_FOUND') USING ERRCODE = 'P0009';
        END IF;
        IF v_rental.effective_expires_at IS NULL OR v_rental.effective_expires_at <= NOW() THEN
            RAISE EXCEPTION 'Hợp đồng thuê của nút ID % đã hết hạn.', p_button_id USING ERRCODE = 'P0011';
        END IF;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM store WHERE store_id = v_btn.store_id AND status = 'ACTIVE') THEN
        RAISE EXCEPTION 'Store ID % hiện không hoạt động.', v_btn.store_id USING ERRCODE = 'P0004';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM button_product WHERE button_id = p_button_id) THEN
        RAISE EXCEPTION 'Nút bấm ID % chưa cấu hình sản phẩm nào. Không thể tạo đơn hàng rỗng.', p_button_id USING ERRCODE = 'P0005';
    END IF;

    IF EXISTS (
        SELECT 1 FROM button_product bp
        JOIN product p ON bp.product_id = p.product_id
        WHERE bp.button_id = p_button_id AND p.status <> 'ACTIVE'
    ) THEN
        RAISE EXCEPTION 'Một hoặc nhiều sản phẩm trên nút bấm ID % không ở trạng thái ACTIVE. Vui lòng cập nhật cấu hình nút.', p_button_id USING ERRCODE = 'P0006';
    END IF;

    PERFORM 1
    FROM inventory inv
    JOIN button_product bp ON inv.product_id = bp.product_id
    WHERE bp.button_id = p_button_id
    FOR UPDATE OF inv;

    IF EXISTS (
        SELECT 1
        FROM button_product bp
        JOIN inventory inv ON bp.product_id = inv.product_id
        WHERE bp.button_id = p_button_id
          AND (inv.quantity_on_hand - inv.reserved_quantity) < bp.quantity
    ) THEN
        RAISE EXCEPTION 'Không đủ tồn kho khả dụng cho một hoặc nhiều sản phẩm trong nút bấm.' USING ERRCODE = 'P0007';
    END IF;

    -- 1. Pre-calculate subtotal and discounts before inserting order
    FOR v_item IN
        SELECT bp.product_id, bp.quantity, p.product_name, p.base_price
        FROM button_product bp
        JOIN product p ON bp.product_id = p.product_id
        WHERE bp.button_id = p_button_id
    LOOP
        SELECT * INTO v_discount
        FROM product_discount
        WHERE product_id = v_item.product_id
          AND status = 'ACTIVE'
          AND now() BETWEEN start_at AND end_at
        LIMIT 1;

        IF FOUND THEN
            IF v_discount.discount_percent IS NOT NULL THEN
                v_unit_discount := ROUND((v_item.base_price * v_discount.discount_percent / 100.0), 2);
            ELSE
                v_unit_discount := LEAST(v_item.base_price, v_discount.discount_amount);
            END IF;
        ELSE
            v_unit_discount := 0;
        END IF;

        v_subtotal := v_subtotal + (v_item.base_price * v_item.quantity);
        v_total_discount := v_total_discount + (v_unit_discount * v_item.quantity);
    END LOOP;

    v_tot_amt := (v_subtotal - v_total_discount + p_shipping_fee);

    -- 2. Enforce minimum order total (totalAmount >= 2.000 VND)
    IF v_tot_amt < 2000 THEN
        RAISE EXCEPTION 'Giá trị đơn hàng tối thiểu là 2.000 VND'
          USING ERRCODE = 'P0010';
    END IF;

    -- 3. Calculate store commission & net amount
    SELECT COALESCE(commission_rate, 8.00) INTO v_comm_rate FROM store WHERE store_id = v_btn.store_id;
    IF v_comm_rate IS NULL THEN v_comm_rate := 8.00; END IF;
    v_comm_amt := ROUND(v_tot_amt * v_comm_rate / 100.0, 2);
    v_net_amt := v_tot_amt - v_comm_amt;

    v_order_code := 'ORD-' || to_char(now(), 'YYYYMMDD') || '-' || substr(md5(random()::text), 1, 6);

    -- 4. Insert order directly with full final amounts
    INSERT INTO orders (
        order_code, store_id, customer_id, button_id, order_status, payment_status, payment_method,
        subtotal_amount, discount_amount, shipping_fee, total_amount,
        commission_rate, commission_amount, net_amount,
        shipping_recipient_name, shipping_phone, shipping_address, order_note, order_date, iot_request_id
    ) VALUES (
        v_order_code, v_btn.store_id, v_btn.customer_id, v_btn.button_id,
        'PENDING', 'UNPAID', p_payment_method,
        v_subtotal, v_total_discount, p_shipping_fee, v_tot_amt,
        v_comm_rate, v_comm_amt, v_net_amt,
        v_btn.recipient_name, v_btn.recipient_phone,
        concat_ws(', ', v_btn.address_detail, v_btn.ward, v_btn.district, v_btn.province),
        p_order_note, now(), p_iot_request_id
    ) RETURNING order_id INTO v_order_id;

    -- 5. Insert order items & reserve inventory
    FOR v_item IN
        SELECT bp.product_id, bp.quantity, p.product_name, p.base_price
        FROM button_product bp
        JOIN product p ON bp.product_id = p.product_id
        WHERE bp.button_id = p_button_id
    LOOP
        SELECT * INTO v_discount
        FROM product_discount
        WHERE product_id = v_item.product_id
          AND status = 'ACTIVE'
          AND now() BETWEEN start_at AND end_at
        LIMIT 1;

        IF FOUND THEN
            IF v_discount.discount_percent IS NOT NULL THEN
                v_unit_discount := ROUND((v_item.base_price * v_discount.discount_percent / 100.0), 2);
            ELSE
                v_unit_discount := LEAST(v_item.base_price, v_discount.discount_amount);
            END IF;
        ELSE
            v_unit_discount := 0;
        END IF;

        v_final_price := v_item.base_price - v_unit_discount;
        v_line_subtotal := v_final_price * v_item.quantity;

        INSERT INTO order_item (
            order_id, product_id, product_name_snapshot, unit_price_snapshot,
            discount_percent_snapshot, discount_amount_snapshot, final_unit_price, quantity, item_subtotal
        ) VALUES (
            v_order_id, v_item.product_id, v_item.product_name, v_item.base_price,
            COALESCE(v_discount.discount_percent, 0), v_unit_discount, v_final_price, v_item.quantity, v_line_subtotal
        );

        UPDATE inventory
        SET reserved_quantity = reserved_quantity + v_item.quantity,
            updated_at = now()
        WHERE product_id = v_item.product_id;
    END LOOP;

    INSERT INTO order_status_history (order_id, old_status, new_status, reason, changed_at)
    VALUES (v_order_id, NULL, 'PENDING', 'Khách hàng nhấn nút tạo đơn thành công', now());

    RETURN v_order_id;
END;
$function$;
