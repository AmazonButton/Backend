-- AlterTable payment_transaction
ALTER TABLE "payment_transaction" ADD COLUMN IF NOT EXISTS "payment_link_id" VARCHAR(255);

-- AlterTable product_image
ALTER TABLE "product_image" ADD COLUMN IF NOT EXISTS "cloudinary_public_id" VARCHAR(255);

-- CreateUniqueIndex
CREATE UNIQUE INDEX IF NOT EXISTS "uq_payment_tx_code" ON "payment_transaction"("transaction_code") WHERE "transaction_code" IS NOT NULL;

-- Stored Procedure
CREATE OR REPLACE FUNCTION sp_create_order_from_button(
    p_button_id BIGINT,
    p_payment_method VARCHAR(30) DEFAULT 'COD',
    p_shipping_fee DECIMAL(15,2) DEFAULT 0,
    p_order_note TEXT DEFAULT NULL
)
RETURNS BIGINT 
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_btn RECORD;
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
BEGIN
    IF p_payment_method NOT IN ('COD', 'PAYOS') THEN
        RAISE EXCEPTION 'Phương thức thanh toán không hợp lệ: %. Chỉ chấp nhận COD hoặc PAYOS.', p_payment_method;
    END IF;

    IF p_shipping_fee < 0 THEN
        RAISE EXCEPTION 'Phí vận chuyển không được âm.';
    END IF;

    SELECT b.*, ca.recipient_name, ca.phone AS recipient_phone, ca.address_detail, ca.ward, ca.district, ca.province
    INTO v_btn
    FROM iot_button b
    JOIN customer_address ca ON b.customer_id = ca.customer_id AND b.address_id = ca.address_id
    WHERE b.button_id = p_button_id
    FOR UPDATE OF b;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Nút bấm ID % không tồn tại.', p_button_id;
    END IF;

    IF v_btn.status <> 'ACTIVE' THEN
        RAISE EXCEPTION 'Nút bấm ID % đang không ở trạng thái ACTIVE.', p_button_id;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM store WHERE store_id = v_btn.store_id AND status = 'ACTIVE') THEN
        RAISE EXCEPTION 'Store ID % hiện không hoạt động.', v_btn.store_id;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM button_product WHERE button_id = p_button_id) THEN
        RAISE EXCEPTION 'Nút bấm ID % chưa cấu hình sản phẩm nào. Không thể tạo đơn hàng rỗng.', p_button_id;
    END IF;

    IF EXISTS (
        SELECT 1 FROM button_product bp
        JOIN product p ON bp.product_id = p.product_id
        WHERE bp.button_id = p_button_id AND p.status <> 'ACTIVE'
    ) THEN
        RAISE EXCEPTION 'Một hoặc nhiều sản phẩm trên nút bấm ID % không ở trạng thái ACTIVE. Vui lòng cập nhật cấu hình nút.', p_button_id;
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
        RAISE EXCEPTION 'Không đủ tồn kho khả dụng cho một hoặc nhiều sản phẩm trong nút bấm.';
    END IF;

    v_order_code := 'ORD-' || to_char(now(), 'YYYYMMDD') || '-' || substr(md5(random()::text), 1, 6);

    INSERT INTO orders (
        order_code, store_id, customer_id, button_id, order_status, payment_status, payment_method,
        subtotal_amount, discount_amount, shipping_fee, total_amount,
        shipping_recipient_name, shipping_phone, shipping_address, order_note, order_date
    ) VALUES (
        v_order_code, v_btn.store_id, v_btn.customer_id, v_btn.button_id,
        'PENDING', 'UNPAID', p_payment_method, 0, 0, p_shipping_fee, p_shipping_fee,
        v_btn.recipient_name, v_btn.recipient_phone, 
        concat_ws(', ', v_btn.address_detail, v_btn.ward, v_btn.district, v_btn.province),
        p_order_note, now()
    ) RETURNING order_id INTO v_order_id;

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

        v_subtotal := v_subtotal + (v_item.base_price * v_item.quantity);
        v_total_discount := v_total_discount + (v_unit_discount * v_item.quantity);

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

    SELECT COALESCE(commission_rate, 8.00) INTO v_comm_rate FROM store WHERE store_id = v_btn.store_id;
    IF v_comm_rate IS NULL THEN v_comm_rate := 8.00; END IF;
    v_tot_amt := (v_subtotal - v_total_discount + p_shipping_fee);
    v_comm_amt := ROUND(v_tot_amt * v_comm_rate / 100.0, 2);
    v_net_amt := v_tot_amt - v_comm_amt;

    UPDATE orders
    SET subtotal_amount = v_subtotal,
        discount_amount = v_total_discount,
        total_amount = v_tot_amt,
        commission_rate = v_comm_rate,
        commission_amount = v_comm_amt,
        net_amount = v_net_amt
    WHERE order_id = v_order_id;

    INSERT INTO order_status_history (order_id, old_status, new_status, reason, changed_at)
    VALUES (v_order_id, NULL, 'PENDING', 'Khách hàng nhấn nút tạo đơn thành công', now());

    RETURN v_order_id;
END;
$$;

-- Backfill commission
UPDATE orders
SET commission_rate = 8.00,
    commission_amount = ROUND(total_amount * 0.08, 2),
    net_amount = total_amount - ROUND(total_amount * 0.08, 2)
WHERE (net_amount = 0 OR net_amount IS NULL OR commission_amount = 0) AND total_amount > 0;
