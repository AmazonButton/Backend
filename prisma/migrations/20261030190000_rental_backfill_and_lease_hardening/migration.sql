-- Migration: 20261030190000_rental_backfill_and_lease_hardening
-- Deep invariants remediation for Review Points R01 - R08:
-- 1. Snapshot fields on button_rentals (button_quantity, deposit_per_button, rent_per_button)
-- 2. Structured duration & quantity on billing_charge_lines (duration_unit, duration_count, quantity, unit_price)
-- 3. CustomerBankAccount verification_status default set to 'PENDING'
-- 4. Outbox events lease recovery fields (claim_token, locked_until)
-- 5. Strict equality check constraint on rental_deposits (held + reserved + refunded = collected)
-- 6. Rental Audit Logs table for all financial/access mutations
-- 7. Backfill existing devices: preserve active customer buttons in IN_CUSTOMER_CUSTODY and store inventory in ALLOCATED_TO_STORE
-- 8. Stored Procedure sp_create_order_from_button alignment (effective_expires_at IS NULL OR <= NOW())

-- 1. Button Rentals snapshot columns
ALTER TABLE "button_rentals" 
  ADD COLUMN IF NOT EXISTS "button_quantity" INT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "deposit_per_button" DECIMAL(15, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "rent_per_button" DECIMAL(15, 2) NOT NULL DEFAULT 0;

-- 2. Billing Charge Lines structured duration columns
ALTER TABLE "billing_charge_lines"
  ADD COLUMN IF NOT EXISTS "duration_unit" VARCHAR(10) DEFAULT 'MONTH',
  ADD COLUMN IF NOT EXISTS "duration_count" INT DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "quantity" INT DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "unit_price" DECIMAL(15, 2);

-- 3. CustomerBankAccount verification status default to PENDING
ALTER TABLE "customer_bank_accounts" ALTER COLUMN "verification_status" SET DEFAULT 'PENDING';

-- 4. Outbox Events lease fields
ALTER TABLE "outbox_events"
  ADD COLUMN IF NOT EXISTS "claim_token" VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "locked_until" TIMESTAMPTZ(6);

CREATE INDEX IF NOT EXISTS "idx_outbox_events_claim_lease" ON "outbox_events"("status", "locked_until", "next_attempt_at");

-- 5. Strict equality deposit conservation constraint
DO $$ BEGIN
  ALTER TABLE "rental_deposits" DROP CONSTRAINT IF EXISTS "chk_rental_deposits_conservation";
  ALTER TABLE "rental_deposits" ADD CONSTRAINT "chk_rental_deposits_conservation" 
    CHECK ("held_amount" + "refund_reserved_amount" + "refunded_amount" = "collected_amount");
END $$;

-- 6. Rental Audit Logs table
CREATE TABLE IF NOT EXISTS "rental_audit_logs" (
  "audit_id" BIGSERIAL PRIMARY KEY,
  "actor_type" VARCHAR(32) NOT NULL,
  "actor_user_id" BIGINT,
  "action" VARCHAR(64) NOT NULL,
  "target_type" VARCHAR(32) NOT NULL,
  "target_id" BIGINT NOT NULL,
  "before_state" VARCHAR(64),
  "after_state" VARCHAR(64),
  "amount" DECIMAL(15, 2),
  "correlation_id" VARCHAR(128),
  "idempotency_key" VARCHAR(128),
  "reason" VARCHAR(255),
  "metadata" JSONB,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "idx_rental_audit_target" ON "rental_audit_logs"("target_type", "target_id");
CREATE INDEX IF NOT EXISTS "idx_rental_audit_action_created" ON "rental_audit_logs"("action", "created_at" DESC);

-- 7. Backfill existing devices: do not lock active customer buttons in warehouse
UPDATE "iot_button" 
SET "inventory_state" = 'IN_CUSTOMER_CUSTODY', "can_order" = true, "custody_store_id" = NULL
WHERE "customer_id" IS NOT NULL AND "inventory_state" = 'IN_PLATFORM_WAREHOUSE';

UPDATE "iot_button"
SET "custody_store_id" = "store_id", "inventory_state" = 'ALLOCATED_TO_STORE'
WHERE "customer_id" IS NULL AND "store_id" IS NOT NULL AND "custody_store_id" IS NULL;

-- 8. Stored Procedure sp_create_order_from_button alignment
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
