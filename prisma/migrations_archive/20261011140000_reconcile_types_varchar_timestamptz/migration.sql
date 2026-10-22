-- Reconcile all column types to match schema.prisma exactly

-- orders triggers drop
DROP TRIGGER IF EXISTS trg_validate_order_status_transition ON public.orders;
DROP TRIGGER IF EXISTS trg_sync_inventory_on_order_status_change ON public.orders;

-- orders: exact types from schema.prisma
ALTER TABLE "orders"
  ALTER COLUMN "order_code" TYPE VARCHAR(50),
  ALTER COLUMN "order_status" TYPE VARCHAR(30),
  ALTER COLUMN "payment_status" TYPE VARCHAR(30),
  ALTER COLUMN "payment_method" TYPE VARCHAR(30),
  ALTER COLUMN "shipping_recipient_name" TYPE VARCHAR(255),
  ALTER COLUMN "shipping_phone" TYPE VARCHAR(20),
  ALTER COLUMN "shipping_address" TYPE VARCHAR(500),
  ALTER COLUMN "order_date" TYPE TIMESTAMPTZ(6) USING order_date AT TIME ZONE 'UTC',
  ALTER COLUMN "completed_at" TYPE TIMESTAMPTZ(6) USING completed_at AT TIME ZONE 'UTC',
  ALTER COLUMN "created_at" TYPE TIMESTAMPTZ(6) USING created_at AT TIME ZONE 'UTC',
  ALTER COLUMN "updated_at" TYPE TIMESTAMPTZ(6) USING updated_at AT TIME ZONE 'UTC';

-- recreate triggers on orders
CREATE OR REPLACE FUNCTION public.fn_validate_order_status_transition()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
    v_valid_transitions JSONB := '{
        "PENDING": ["CANCELLED", "REJECTED", "CONFIRMED"],
        "CONFIRMED": ["CANCELLED", "REJECTED", "PREPARING"],
        "PREPARING": ["CANCELLED", "READY_FOR_DELIVERY"],
        "READY_FOR_DELIVERY": ["CANCELLED", "SHIPPING"],
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

    v_allowed := v_valid_transitions -> OLD.order_status;

    IF v_allowed IS NULL OR NOT v_allowed ? NEW.order_status THEN
        RAISE EXCEPTION 'Chuyển trạng thái không hợp lệ: % → %. Các trạng thái hợp lệ từ %: %',
            OLD.order_status, NEW.order_status, OLD.order_status, v_allowed;
    END IF;

    IF NEW.order_status = 'COMPLETED' THEN
        NEW.completed_at := now();
    END IF;

    RETURN NEW;
END;
$function$;

CREATE TRIGGER trg_validate_order_status_transition BEFORE UPDATE OF order_status ON public.orders FOR EACH ROW EXECUTE FUNCTION fn_validate_order_status_transition();
CREATE TRIGGER trg_sync_inventory_on_order_status_change AFTER UPDATE OF order_status ON public.orders FOR EACH ROW EXECUTE FUNCTION fn_sync_inventory_on_order_status_change();

-- store policies drop
DROP POLICY IF EXISTS "Public read active stores" ON public.store;

ALTER TABLE "store"
  ALTER COLUMN "name" TYPE VARCHAR(255),
  ALTER COLUMN "code" TYPE VARCHAR(50),
  ALTER COLUMN "email" TYPE VARCHAR(255),
  ALTER COLUMN "phone" TYPE VARCHAR(20),
  ALTER COLUMN "status" TYPE VARCHAR(20),
  ALTER COLUMN "created_at" TYPE TIMESTAMPTZ(6) USING created_at AT TIME ZONE 'UTC',
  ALTER COLUMN "updated_at" TYPE TIMESTAMPTZ(6) USING updated_at AT TIME ZONE 'UTC';

CREATE POLICY "Public read active stores" ON public.store FOR SELECT USING ((status)::text = 'ACTIVE'::text);

-- product policies drop
DROP POLICY IF EXISTS "Public read products" ON public.product;

ALTER TABLE "product"
  ALTER COLUMN "product_code" TYPE VARCHAR(50),
  ALTER COLUMN "product_name" TYPE VARCHAR(255),
  ALTER COLUMN "status" TYPE VARCHAR(20),
  ALTER COLUMN "created_at" TYPE TIMESTAMPTZ(6) USING created_at AT TIME ZONE 'UTC',
  ALTER COLUMN "updated_at" TYPE TIMESTAMPTZ(6) USING updated_at AT TIME ZONE 'UTC';

CREATE POLICY "Public read products" ON public.product FOR SELECT USING ((status)::text = 'ACTIVE'::text);

-- product_discount policies drop
DROP POLICY IF EXISTS "Public read active discounts" ON public.product_discount;

ALTER TABLE "product_discount"
  ALTER COLUMN "start_at" TYPE TIMESTAMPTZ(6) USING start_at AT TIME ZONE 'UTC',
  ALTER COLUMN "end_at" TYPE TIMESTAMPTZ(6) USING end_at AT TIME ZONE 'UTC',
  ALTER COLUMN "status" TYPE VARCHAR(20),
  ALTER COLUMN "created_at" TYPE TIMESTAMPTZ(6) USING created_at AT TIME ZONE 'UTC',
  ALTER COLUMN "updated_at" TYPE TIMESTAMPTZ(6) USING updated_at AT TIME ZONE 'UTC';

CREATE POLICY "Public read active discounts" ON public.product_discount FOR SELECT USING ((status)::text = 'ACTIVE'::text);

-- pairing_tokens
ALTER TABLE "pairing_tokens"
  ALTER COLUMN "expires_at" TYPE TIMESTAMPTZ(6) USING expires_at AT TIME ZONE 'UTC',
  ALTER COLUMN "created_at" TYPE TIMESTAMPTZ(6) USING created_at AT TIME ZONE 'UTC';

-- auth_otps
ALTER TABLE "auth_otps"
  ALTER COLUMN "email" TYPE TEXT,
  ALTER COLUMN "purpose" TYPE TEXT,
  ALTER COLUMN "token_hash" TYPE TEXT,
  ALTER COLUMN "expires_at" TYPE TIMESTAMPTZ(6) USING expires_at AT TIME ZONE 'UTC',
  ALTER COLUMN "consumed_at" TYPE TIMESTAMPTZ(6) USING consumed_at AT TIME ZONE 'UTC',
  ALTER COLUMN "created_at" TYPE TIMESTAMPTZ(6) USING created_at AT TIME ZONE 'UTC';

-- iot_idempotency_keys
ALTER TABLE "iot_idempotency_keys"
  ALTER COLUMN "request_id" TYPE VARCHAR(128),
  ALTER COLUMN "status" TYPE VARCHAR(20),
  ALTER COLUMN "locked_until" TYPE TIMESTAMP(3),
  ALTER COLUMN "created_at" TYPE TIMESTAMP(3),
  ALTER COLUMN "updated_at" TYPE TIMESTAMP(3);

-- device_nonces
ALTER TABLE "device_nonces"
  ALTER COLUMN "device_id" TYPE VARCHAR(64),
  ALTER COLUMN "nonce" TYPE VARCHAR(128),
  ALTER COLUMN "expires_at" TYPE TIMESTAMP(3),
  ALTER COLUMN "created_at" TYPE TIMESTAMP(3);

-- provisioning_sessions
ALTER TABLE "provisioning_sessions"
  ALTER COLUMN "session_id" TYPE VARCHAR(64),
  ALTER COLUMN "session_hash" TYPE VARCHAR(128),
  ALTER COLUMN "status" TYPE VARCHAR(20),
  ALTER COLUMN "expires_at" TYPE TIMESTAMPTZ(6) USING expires_at AT TIME ZONE 'UTC',
  ALTER COLUMN "created_at" TYPE TIMESTAMPTZ(6) USING created_at AT TIME ZONE 'UTC',
  ALTER COLUMN "updated_at" TYPE TIMESTAMPTZ(6) USING updated_at AT TIME ZONE 'UTC';

-- iot_button
ALTER TABLE "iot_button"
  ALTER COLUMN "warranty_until" TYPE TIMESTAMP(3),
  ALTER COLUMN "click_behavior" TYPE TEXT;

-- payment_transaction
ALTER TABLE "payment_transaction"
  ALTER COLUMN "provider" TYPE TEXT,
  ALTER COLUMN "transaction_code" TYPE TEXT,
  ALTER COLUMN "payment_method" TYPE TEXT,
  ALTER COLUMN "status" TYPE TEXT,
  ALTER COLUMN "paid_at" TYPE TIMESTAMP(3),
  ALTER COLUMN "created_at" TYPE TIMESTAMP(3),
  ALTER COLUMN "updated_at" TYPE TIMESTAMP(3),
  ALTER COLUMN "payment_link_id" TYPE TEXT,
  ALTER COLUMN "checkout_url" TYPE TEXT;

-- product_image
ALTER TABLE "product_image"
  ALTER COLUMN "created_at" TYPE TIMESTAMP(3),
  ALTER COLUMN "updated_at" TYPE TIMESTAMP(3),
  ALTER COLUMN "cloudinary_public_id" TYPE TEXT;

-- product_price_history
ALTER TABLE "product_price_history"
  ALTER COLUMN "changed_at" TYPE TIMESTAMP(3);

-- refresh_tokens
ALTER TABLE "refresh_tokens"
  ALTER COLUMN "token_hash" TYPE TEXT,
  ALTER COLUMN "expires_at" TYPE TIMESTAMP(3),
  ALTER COLUMN "created_at" TYPE TIMESTAMP(3);

-- rental_packages
ALTER TABLE "rental_packages"
  ALTER COLUMN "package_code" TYPE TEXT,
  ALTER COLUMN "package_name" TYPE TEXT,
  ALTER COLUMN "created_at" TYPE TIMESTAMP(3),
  ALTER COLUMN "updated_at" TYPE TIMESTAMP(3);

-- revoked_tokens
ALTER TABLE "revoked_tokens"
  ALTER COLUMN "token_hash" TYPE TEXT,
  ALTER COLUMN "expires_at" TYPE TIMESTAMP(3),
  ALTER COLUMN "created_at" TYPE TIMESTAMP(3);

-- roles
ALTER TABLE "roles"
  ALTER COLUMN "role_code" TYPE TEXT,
  ALTER COLUMN "role_name" TYPE TEXT;

-- store_customer
ALTER TABLE "store_customer"
  ALTER COLUMN "status" TYPE TEXT,
  ALTER COLUMN "joined_at" TYPE TIMESTAMP(3),
  ALTER COLUMN "created_at" TYPE TIMESTAMP(3),
  ALTER COLUMN "updated_at" TYPE TIMESTAMP(3);

-- store_staff
ALTER TABLE "store_staff"
  ALTER COLUMN "status" TYPE TEXT,
  ALTER COLUMN "joined_at" TYPE TIMESTAMP(3),
  ALTER COLUMN "left_at" TYPE TIMESTAMP(3),
  ALTER COLUMN "created_at" TYPE TIMESTAMP(3),
  ALTER COLUMN "updated_at" TYPE TIMESTAMP(3);

-- store_subscriptions
ALTER TABLE "store_subscriptions"
  ALTER COLUMN "start_date" TYPE TIMESTAMP(3),
  ALTER COLUMN "end_date" TYPE TIMESTAMP(3),
  ALTER COLUMN "status" TYPE TEXT,
  ALTER COLUMN "payment_method" TYPE TEXT,
  ALTER COLUMN "created_at" TYPE TIMESTAMP(3),
  ALTER COLUMN "updated_at" TYPE TIMESTAMP(3);

-- store_wallets
ALTER TABLE "store_wallets"
  ALTER COLUMN "bank_name" TYPE TEXT,
  ALTER COLUMN "bank_account_number" TYPE TEXT,
  ALTER COLUMN "bank_account_holder" TYPE TEXT,
  ALTER COLUMN "created_at" TYPE TIMESTAMP(3),
  ALTER COLUMN "updated_at" TYPE TIMESTAMP(3);

-- store_withdrawals
ALTER TABLE "store_withdrawals"
  ALTER COLUMN "withdrawal_code" TYPE TEXT,
  ALTER COLUMN "bank_name" TYPE TEXT,
  ALTER COLUMN "bank_account_number" TYPE TEXT,
  ALTER COLUMN "bank_account_holder" TYPE TEXT,
  ALTER COLUMN "status" TYPE TEXT,
  ALTER COLUMN "requested_at" TYPE TIMESTAMP(3),
  ALTER COLUMN "processed_at" TYPE TIMESTAMP(3),
  ALTER COLUMN "created_at" TYPE TIMESTAMP(3),
  ALTER COLUMN "updated_at" TYPE TIMESTAMP(3),
  ALTER COLUMN "bank_code" TYPE TEXT,
  ALTER COLUMN "provider" TYPE TEXT,
  ALTER COLUMN "provider_payout_id" TYPE TEXT,
  ALTER COLUMN "provider_reference_id" TYPE TEXT;

-- subscription_plans
ALTER TABLE "subscription_plans"
  ALTER COLUMN "plan_code" TYPE TEXT,
  ALTER COLUMN "plan_name" TYPE TEXT,
  ALTER COLUMN "created_at" TYPE TIMESTAMP(3),
  ALTER COLUMN "updated_at" TYPE TIMESTAMP(3);

-- users
ALTER TABLE "users"
  ALTER COLUMN "username" TYPE TEXT,
  ALTER COLUMN "email" TYPE TEXT,
  ALTER COLUMN "password_hash" TYPE TEXT,
  ALTER COLUMN "full_name" TYPE TEXT,
  ALTER COLUMN "phone" TYPE TEXT,
  ALTER COLUMN "status" TYPE TEXT,
  ALTER COLUMN "created_at" TYPE TIMESTAMP(3),
  ALTER COLUMN "updated_at" TYPE TIMESTAMP(3),
  ALTER COLUMN "password_reset_token" TYPE TEXT,
  ALTER COLUMN "password_reset_expires_at" TYPE TIMESTAMP(3),
  ALTER COLUMN "email_verification_token" TYPE TEXT,
  ALTER COLUMN "email_verification_expires_at" TYPE TIMESTAMP(3),
  ALTER COLUMN "password_changed_at" TYPE TIMESTAMP(3);

-- wallet_transactions
ALTER TABLE "wallet_transactions"
  ALTER COLUMN "type" TYPE TEXT,
  ALTER COLUMN "reference_id" TYPE TEXT,
  ALTER COLUMN "created_at" TYPE TIMESTAMP(3);
