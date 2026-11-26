-- Hardening Migration: Resolve all DB constraint, index, trigger, and SP findings from 44-issue audit.
-- Idempotent across fresh CI DBs, Neon test DBs, and existing Supabase Production DBs.

-- 1. rental_deposits: Add deducted_amount for partial/100% warranty deductions (A1)
ALTER TABLE "public"."rental_deposits"
  ADD COLUMN IF NOT EXISTS "deducted_amount" DECIMAL(15,2) NOT NULL DEFAULT 0;

-- Heal any historical row whose collected_amount > held + reserved + refunded due to pre-existing deductions
UPDATE "public"."rental_deposits"
SET "deducted_amount" = GREATEST(0, "collected_amount" - ("held_amount" + "refund_reserved_amount" + "refunded_amount"))
WHERE "deducted_amount" = 0
  AND ("held_amount" + "refund_reserved_amount" + "refunded_amount") < "collected_amount";

ALTER TABLE "public"."rental_deposits"
  DROP CONSTRAINT IF EXISTS "chk_rental_deposits_conservation";

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.rental_deposits'::regclass
      AND conname = 'chk_rental_deposits_deducted_non_negative'
  ) THEN
    ALTER TABLE "public"."rental_deposits"
      ADD CONSTRAINT "chk_rental_deposits_deducted_non_negative"
      CHECK ("deducted_amount" >= 0);
  END IF;
END $$;

ALTER TABLE "public"."rental_deposits"
  ADD CONSTRAINT "chk_rental_deposits_conservation"
  CHECK (("held_amount" + "refund_reserved_amount" + "refunded_amount" + "deducted_amount") = "collected_amount");

-- 2. iot_button: Add customer_child_lock (E15) & enforce inventory_state + custody invariants (A7)
ALTER TABLE "public"."iot_button"
  ADD COLUMN IF NOT EXISTS "customer_child_lock" BOOLEAN NOT NULL DEFAULT false;

UPDATE "public"."iot_button"
SET "inventory_state" = 'ALLOCATED_TO_STORE'
WHERE "inventory_state" = 'IN_STORE';

UPDATE "public"."iot_button"
SET "custody_store_id" = NULL
WHERE "inventory_state" = 'IN_CUSTOMER_CUSTODY'
  AND "custody_store_id" IS NOT NULL;

ALTER TABLE "public"."iot_button"
  DROP CONSTRAINT IF EXISTS "chk_iot_button_inventory_state";
ALTER TABLE "public"."iot_button"
  ADD CONSTRAINT "chk_iot_button_inventory_state"
  CHECK (("inventory_state")::text = ANY (ARRAY[
    'IN_PLATFORM_WAREHOUSE'::text,
    'ALLOCATED_TO_STORE'::text,
    'ASSIGNED_TO_RENTAL'::text,
    'IN_CUSTOMER_CUSTODY'::text,
    'RETURN_IN_TRANSIT'::text,
    'DEFECTIVE_RETURN'::text
  ]));

ALTER TABLE "public"."iot_button"
  DROP CONSTRAINT IF EXISTS "chk_iot_button_customer_custody_no_store";
ALTER TABLE "public"."iot_button"
  ADD CONSTRAINT "chk_iot_button_customer_custody_no_store"
  CHECK ("inventory_state" <> 'IN_CUSTOMER_CUSTODY' OR "custody_store_id" IS NULL);

-- 3. billing_overpayment_obligations: Support admin resolution/refund states (A2)
ALTER TABLE "public"."billing_overpayment_obligations"
  ADD COLUMN IF NOT EXISTS "resolved_at" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "resolved_by_user_id" BIGINT,
  ADD COLUMN IF NOT EXISTS "resolution_note" VARCHAR(500);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.billing_overpayment_obligations'::regclass
      AND conname = 'billing_overpayment_obligations_resolved_by_fkey'
  ) THEN
    ALTER TABLE "public"."billing_overpayment_obligations"
      ADD CONSTRAINT "billing_overpayment_obligations_resolved_by_fkey"
      FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."users"("user_id") ON DELETE SET NULL;
  END IF;
END $$;

ALTER TABLE "public"."billing_overpayment_obligations"
  DROP CONSTRAINT IF EXISTS "ck_billing_overpayment_status";
ALTER TABLE "public"."billing_overpayment_obligations"
  ADD CONSTRAINT "ck_billing_overpayment_status"
  CHECK (("status")::text = ANY (ARRAY[
    'PENDING_RECONCILIATION'::text,
    'READY_FOR_PAYOUT'::text,
    'PROCESSING_PAYOUT'::text,
    'REFUNDED'::text,
    'RESOLVED'::text
  ]));

-- 4. Restore missing partial unique indexes & constraints safely (A6)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'driver_shifts') THEN
    WITH ranked_shifts AS (
      SELECT shift_id, ROW_NUMBER() OVER (PARTITION BY driver_id ORDER BY started_at DESC, shift_id DESC) AS rn
      FROM public.driver_shifts
      WHERE status = 'OPEN'
    )
    UPDATE public.driver_shifts ds
    SET status = 'CLOSED', ended_at = COALESCE(ds.ended_at, NOW()), updated_at = NOW()
    FROM ranked_shifts rs
    WHERE ds.shift_id = rs.shift_id AND rs.rn > 1;

    CREATE UNIQUE INDEX IF NOT EXISTS "uq_driver_open_shift"
      ON "public"."driver_shifts" ("driver_id")
      WHERE ("status" = 'OPEN');
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'customer_address') THEN
    WITH ranked_addr AS (
      SELECT address_id, ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY updated_at DESC NULLS LAST, address_id DESC) AS rn
      FROM public.customer_address
      WHERE is_default = true
    )
    UPDATE public.customer_address ca
    SET is_default = false, updated_at = NOW()
    FROM ranked_addr ra
    WHERE ca.address_id = ra.address_id AND ra.rn > 1;

    CREATE UNIQUE INDEX IF NOT EXISTS "uq_customer_single_default"
      ON "public"."customer_address" ("customer_id")
      WHERE ("is_default" = true);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'customer_bank_accounts') THEN
    WITH ranked_bank AS (
      SELECT id, ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY (CASE WHEN verification_status = 'VERIFIED' THEN 0 ELSE 1 END), updated_at DESC NULLS LAST, id DESC) AS rn
      FROM public.customer_bank_accounts
      WHERE is_default = true
    )
    UPDATE public.customer_bank_accounts cba
    SET is_default = false, updated_at = NOW()
    FROM ranked_bank rb
    WHERE cba.id = rb.id AND rb.rn > 1;

    CREATE UNIQUE INDEX IF NOT EXISTS "uq_customer_bank_one_default"
      ON "public"."customer_bank_accounts" ("customer_id")
      WHERE ("is_default" = true);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'customer_bank_refund_payout_attempts') THEN
    WITH ranked_att AS (
      SELECT id, ROW_NUMBER() OVER (PARTITION BY obligation_id ORDER BY attempt_number DESC, id DESC) AS rn
      FROM public.customer_bank_refund_payout_attempts
      WHERE status IN ('PREPARING', 'SUBMITTED', 'PENDING_RECONCILIATION', 'PROCESSING')
    )
    UPDATE public.customer_bank_refund_payout_attempts a
    SET status = 'FAILED'
    FROM ranked_att ra
    WHERE a.id = ra.id AND ra.rn > 1;

    CREATE UNIQUE INDEX IF NOT EXISTS "uq_cust_bank_active_attempt_per_obligation"
      ON "public"."customer_bank_refund_payout_attempts" ("obligation_id")
      WHERE (("status")::text = ANY (ARRAY['PREPARING'::text, 'SUBMITTED'::text, 'PENDING_RECONCILIATION'::text, 'PROCESSING'::text]));
  END IF;
END $$;

-- Fix warranty active replacement unique index to exclude terminal 'RESOLVED' (A6.2)
DROP INDEX IF EXISTS "public"."uq_warranty_tickets_active_replacement_button";
CREATE UNIQUE INDEX IF NOT EXISTS "uq_warranty_tickets_active_replacement_button"
  ON "public"."warranty_tickets" ("replacement_button_id")
  WHERE ("replacement_button_id" IS NOT NULL AND ("status")::text = ANY (ARRAY['PENDING'::text, 'APPROVED_SWAP'::text]));

-- Enforce positive button_product.quantity
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.button_product'::regclass
      AND conname = 'button_product_quantity_check'
  ) THEN
    ALTER TABLE "public"."button_product"
      ADD CONSTRAINT "button_product_quantity_check" CHECK ("quantity" > 0);
  END IF;
END $$;

-- 5. Fix PL/pgSQL trigger functions (A6.3, A6.4, B1)
CREATE OR REPLACE FUNCTION "public"."fn_auto_link_store_customer_on_button_insert"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.store_id IS NOT NULL AND NEW.customer_id IS NOT NULL THEN
    INSERT INTO store_customer (store_id, customer_id, status, joined_at)
    VALUES (NEW.store_id, NEW.customer_id, 'ACTIVE', now())
    ON CONFLICT (store_id, customer_id)
    DO UPDATE SET updated_at = now()
    WHERE store_customer.status <> 'BLOCKED';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION "public"."fn_current_user_id"()
RETURNS bigint
LANGUAGE plpgsql
STABLE
AS $function$
DECLARE
  v_app_uid BIGINT;
  v_sub TEXT;
BEGIN
  BEGIN
    v_app_uid := NULLIF(current_setting('app.current_user_id', true), '')::BIGINT;
    IF v_app_uid IS NOT NULL THEN
      RETURN v_app_uid;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_app_uid := NULL;
  END;

  BEGIN
    v_sub := NULLIF(current_setting('request.jwt.claim.sub', true), '');
    IF v_sub IS NOT NULL AND v_sub ~ '^\d+$' THEN
      RETURN v_sub::BIGINT;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  BEGIN
    RETURN (SELECT user_id FROM users WHERE auth_id = auth.uid() LIMIT 1);
  EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
  END;
END;
$function$;

CREATE OR REPLACE FUNCTION "public"."fn_enforce_payment_refund_budget"()
RETURNS TRIGGER AS $$
DECLARE
  v_order RECORD;
  v_receipt RECORD;
  v_allowable DECIMAL(15, 2);
  v_allocated DECIMAL(15, 2);
BEGIN
  SELECT order_id, order_status, payment_status, payment_method
  INTO v_order
  FROM orders
  WHERE order_id = NEW.order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND: order_id=% does not exist', NEW.order_id;
  END IF;

  SELECT receipt_id, order_id, amount, classification
  INTO v_receipt
  FROM payment_order_receipts
  WHERE receipt_id = NEW.receipt_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'RECEIPT_NOT_FOUND: receipt_id=% does not exist', NEW.receipt_id;
  END IF;

  IF v_receipt.order_id <> NEW.order_id THEN
    RAISE EXCEPTION 'RECEIPT_ORDER_MISMATCH: receipt % belongs to order %, not %', NEW.receipt_id, v_receipt.order_id, NEW.order_id;
  END IF;

  IF NEW.refund_amount <= 0 OR NEW.refund_amount > v_receipt.amount THEN
    RAISE EXCEPTION 'RECEIPT_REFUND_EXCEEDED: obligation amount % exceeds receipt amount % (receipt %)', NEW.refund_amount, v_receipt.amount, NEW.receipt_id;
  END IF;

  IF NEW.status <> 'CANCELLED' THEN
    -- Prevent double-spend: never refund primary ORDER_REFUND if store wallet already credited ORDER_REVENUE for this order
    IF NEW.obligation_type = 'ORDER_REFUND'
       AND EXISTS (
         SELECT 1 FROM wallet_transactions wt
         WHERE wt.type = 'ORDER_REVENUE'
           AND wt.reference_id = ('ORDER:' || NEW.order_id::text)
       ) THEN
      RAISE EXCEPTION 'ORDER_REVENUE_ALREADY_CREDITED: cannot create/keep ORDER_REFUND for order % after store wallet revenue credit', NEW.order_id;
    END IF;

    IF v_receipt.classification = 'ORDER_PAYMENT'
       AND v_order.payment_method = 'PAYOS'
       AND v_order.order_status NOT IN ('CANCELLED', 'REJECTED', 'DELIVERY_FAILED')
       AND v_order.payment_status NOT IN ('REFUND_PENDING', 'REFUNDED') THEN
      RAISE EXCEPTION 'ACTIVE_ORDER_PAYMENT_NOT_REFUNDABLE: order % is still active (status=%, payment_status=%)',
        NEW.order_id, v_order.order_status, v_order.payment_status;
    END IF;

    SELECT COALESCE(SUM(r.amount), 0)
    INTO v_allowable
    FROM payment_order_receipts r
    WHERE r.order_id = NEW.order_id
      AND (
        r.classification IN ('EXCESS_DUPLICATE', 'LATE_CANCELLED_OR_COD', 'LEGACY_UNCLASSIFIED')
        OR (
          r.classification = 'ORDER_PAYMENT'
          AND (
            v_order.payment_method <> 'PAYOS'
            OR v_order.order_status IN ('CANCELLED', 'REJECTED', 'DELIVERY_FAILED')
            OR v_order.payment_status IN ('REFUND_PENDING', 'REFUNDED')
          )
        )
      );

    SELECT COALESCE(SUM(o.refund_amount), 0)
    INTO v_allocated
    FROM payment_refund_obligations o
    WHERE o.order_id = NEW.order_id
      AND o.status <> 'CANCELLED'
      AND (TG_OP = 'INSERT' OR o.obligation_id <> NEW.obligation_id);

    v_allocated := v_allocated + NEW.refund_amount;

    IF v_allocated > v_allowable THEN
      RAISE EXCEPTION 'REFUND_BUDGET_EXCEEDED: allocated % > allowable % for order %',
        v_allocated, v_allowable, NEW.order_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 6. Harden sp_create_order_from_button: default-address fallback, category ACTIVE check, store_customer BLOCKED check, integer VND discounts (C4, E1, E10)
CREATE OR REPLACE FUNCTION "public"."sp_create_order_from_button"(
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
    v_addr RECORD;
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

    -- Pessimistic Lock on IoT Button (LEFT JOIN address so missing/default fallback has clear error)
    SELECT b.*
    INTO v_btn
    FROM iot_button b
    WHERE b.button_id = p_button_id
    FOR UPDATE OF b;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Nút bấm ID % không tồn tại.', p_button_id USING ERRCODE = 'P0002';
    END IF;

    IF v_btn.customer_id IS NULL THEN
        RAISE EXCEPTION 'Nút bấm ID % chưa được gán cho khách hàng.', p_button_id USING ERRCODE = 'P0002';
    END IF;

    SELECT ca.address_id, ca.recipient_name, ca.phone AS recipient_phone, ca.address_detail, ca.ward, ca.district, ca.province
    INTO v_addr
    FROM customer_address ca
    WHERE ca.customer_id = v_btn.customer_id
      AND (
        (v_btn.address_id IS NOT NULL AND ca.address_id = v_btn.address_id)
        OR (v_btn.address_id IS NULL AND ca.is_default = true)
      )
    ORDER BY ca.is_default DESC, ca.address_id DESC
    LIMIT 1;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Khách hàng chưa có địa chỉ giao hàng mặc định cho nút bấm ID %.', p_button_id USING ERRCODE = 'P0012';
    END IF;

    IF v_btn.status <> 'ACTIVE' THEN
        RAISE EXCEPTION 'Nút bấm ID % đang không ở trạng thái ACTIVE.', p_button_id USING ERRCODE = 'P0003';
    END IF;

    IF v_btn.can_order = false OR v_btn.inventory_state IN ('RETURN_IN_TRANSIT', 'ALLOCATED_TO_STORE', 'IN_PLATFORM_WAREHOUSE', 'DEFECTIVE_RETURN') THEN
        RAISE EXCEPTION 'Nút bấm ID % không được phép đặt hàng (can_order=false hoặc đang trong kho/hoàn trả).', p_button_id USING ERRCODE = 'P0008';
    END IF;

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

    IF EXISTS (
        SELECT 1 FROM store_customer sc
        WHERE sc.store_id = v_btn.store_id AND sc.customer_id = v_btn.customer_id AND sc.status = 'BLOCKED'
    ) THEN
        RAISE EXCEPTION 'Khách hàng đã bị cửa hàng chặn đặt hàng.' USING ERRCODE = 'P0008';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM button_product WHERE button_id = p_button_id) THEN
        RAISE EXCEPTION 'Nút bấm ID % chưa cấu hình sản phẩm nào. Không thể tạo đơn hàng rỗng.', p_button_id USING ERRCODE = 'P0005';
    END IF;

    IF EXISTS (
        SELECT 1 FROM button_product bp
        JOIN product p ON bp.product_id = p.product_id
        LEFT JOIN category c ON p.category_id = c.category_id
        WHERE bp.button_id = p_button_id
          AND (p.status <> 'ACTIVE' OR (p.category_id IS NOT NULL AND (c.category_id IS NULL OR c.status <> 'ACTIVE')))
    ) THEN
        RAISE EXCEPTION 'Một hoặc nhiều sản phẩm hoặc danh mục trên nút bấm ID % không ở trạng thái ACTIVE. Vui lòng cập nhật cấu hình nút.', p_button_id USING ERRCODE = 'P0006';
    END IF;

    PERFORM 1
    FROM inventory inv
    JOIN button_product bp ON inv.product_id = bp.product_id
    WHERE bp.button_id = p_button_id
    ORDER BY inv.product_id ASC
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

    -- 1. Pre-calculate subtotal and discounts before inserting order (Integer VND)
    FOR v_item IN
        SELECT bp.product_id, bp.quantity, p.product_name, p.base_price
        FROM button_product bp
        JOIN product p ON bp.product_id = p.product_id
        WHERE bp.button_id = p_button_id
        ORDER BY bp.product_id ASC
    LOOP
        SELECT * INTO v_discount
        FROM product_discount
        WHERE product_id = v_item.product_id
          AND status = 'ACTIVE'
          AND now() BETWEEN start_at AND end_at
        ORDER BY discount_id DESC
        LIMIT 1;

        IF FOUND THEN
            IF v_discount.discount_percent IS NOT NULL THEN
                v_unit_discount := ROUND((v_item.base_price * v_discount.discount_percent / 100.0), 0);
            ELSE
                v_unit_discount := LEAST(v_item.base_price, ROUND(v_discount.discount_amount, 0));
            END IF;
        ELSE
            v_unit_discount := 0;
        END IF;

        v_subtotal := v_subtotal + (v_item.base_price * v_item.quantity);
        v_total_discount := v_total_discount + (v_unit_discount * v_item.quantity);
    END LOOP;

    v_tot_amt := (v_subtotal - v_total_discount + p_shipping_fee);

    IF v_tot_amt < 2000 THEN
        RAISE EXCEPTION 'Giá trị đơn hàng tối thiểu là 2.000 VND'
          USING ERRCODE = 'P0010';
    END IF;

    SELECT COALESCE(commission_rate, 8.00) INTO v_comm_rate FROM store WHERE store_id = v_btn.store_id;
    IF v_comm_rate IS NULL THEN v_comm_rate := 8.00; END IF;
    v_comm_amt := ROUND(v_tot_amt * v_comm_rate / 100.0, 2);
    v_net_amt := v_tot_amt - v_comm_amt;

    v_order_code := 'ORD-' || to_char(now(), 'YYYYMMDD') || '-' || substr(md5(random()::text), 1, 6);

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
        v_addr.recipient_name, v_addr.recipient_phone,
        concat_ws(', ', v_addr.address_detail, v_addr.ward, v_addr.district, v_addr.province),
        p_order_note, now(), p_iot_request_id
    ) RETURNING order_id INTO v_order_id;

    FOR v_item IN
        SELECT bp.product_id, bp.quantity, p.product_name, p.base_price
        FROM button_product bp
        JOIN product p ON bp.product_id = p.product_id
        WHERE bp.button_id = p_button_id
        ORDER BY bp.product_id ASC
    LOOP
        SELECT * INTO v_discount
        FROM product_discount
        WHERE product_id = v_item.product_id
          AND status = 'ACTIVE'
          AND now() BETWEEN start_at AND end_at
        ORDER BY discount_id DESC
        LIMIT 1;

        IF FOUND THEN
            IF v_discount.discount_percent IS NOT NULL THEN
                v_unit_discount := ROUND((v_item.base_price * v_discount.discount_percent / 100.0), 0);
            ELSE
                v_unit_discount := LEAST(v_item.base_price, ROUND(v_discount.discount_amount, 0));
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
