CREATE OR REPLACE FUNCTION fn_validate_store_staff_role()
RETURNS TRIGGER AS $$
DECLARE
    v_role_code VARCHAR(50);
BEGIN
    SELECT role_code INTO v_role_code FROM roles WHERE role_id = NEW.role_id;
    IF v_role_code NOT LIKE 'STAFF_%' AND v_role_code NOT IN ('STORE_OWNER', 'STORE_MANAGER') THEN
        RAISE EXCEPTION 'Gán vai trò sai: Chỉ được gán vai trò nhân viên (STAFF_*), STORE_OWNER hoặc STORE_MANAGER cho nhân sự cửa hàng.';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
