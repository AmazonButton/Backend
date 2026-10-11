-- Migration: 20261011135000_order_status_audit_function
-- Purpose: Create audit-only fn_sync_inventory_on_order_status_change() and fallback fn_current_user_id()
-- Ensures fresh databases have the function defined prior to trigger creation in 20261011140000,
-- and converts existing Supabase function into audit-only (no double inventory mutations).

CREATE OR REPLACE FUNCTION fn_current_user_id()
RETURNS bigint
LANGUAGE plpgsql
STABLE
AS $function$
BEGIN
    BEGIN
        RETURN (SELECT user_id FROM users WHERE auth_id = auth.uid() LIMIT 1);
    EXCEPTION WHEN OTHERS THEN
        RETURN NULL;
    END;
END;
$function$;

CREATE OR REPLACE FUNCTION fn_sync_inventory_on_order_status_change()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
    v_changed_by BIGINT;
BEGIN
    -- Extract user_id from application context (fallback to fn_current_user_id())
    BEGIN
        v_changed_by := NULLIF(current_setting('app.current_user_id', true), '')::BIGINT;
    EXCEPTION WHEN OTHERS THEN
        v_changed_by := NULL;
    END;

    IF v_changed_by IS NULL THEN
        BEGIN
            v_changed_by := fn_current_user_id();
        EXCEPTION WHEN OTHERS THEN
            v_changed_by := NULL;
        END;
    END IF;

    -- AUDIT ONLY: Record order status history without touching inventory
    -- Inventory management is strictly handled with row-level locks by OrdersRepository in application layer.
    IF OLD.order_status <> NEW.order_status THEN
        INSERT INTO order_status_history (order_id, changed_by_user_id, old_status, new_status, reason, changed_at)
        VALUES (NEW.order_id, v_changed_by, OLD.order_status, NEW.order_status, 'Cập nhật trạng thái đơn hàng', now());
    END IF;

    RETURN NEW;
END;
$function$;
