-- ============================================================================
-- SMART ORDER BUTTON (BRD V2.1) — SUPABASE POSTGRESQL MIGRATION
-- File: supabase_migration_abc.sql
-- Mục đích: Kích hoạt đầy đủ 3 tính năng bảo mật & cấu hình cốt lõi:
--   A. Refresh Token Rotation & Session Revocation (Skill: auth-rbac-implementation)
--   B. Password Reset & Email Verification bằng mã băm SHA-256 (Skill: advanced-auth-and-webhooks)
--   C. Quản lý Mẫu Nút Bấm Thiết Bị Đa Cửa Hàng (Device Templates in PostgreSQL)
-- ============================================================================

-- Bắt đầu giao dịch an toàn (Transaction Block)
BEGIN;

-- ============================================================================
-- PHẦN A: BẢNG REFRESH TOKENS (XOAY VÒNG & THU HỒI TOKEN ĐĂNG NHẬP)
-- ============================================================================
-- Lý do thiết kế:
-- 1. Tuyệt đối không lưu token thô trong Database. Chỉ lưu mã băm SHA-256 (token_hash).
-- 2. Hỗ trợ Single-Use Rotation: Mỗi khi đổi token, bản ghi cũ đổi thành is_revoked = TRUE.
-- 3. Hỗ trợ Logout an toàn: Khi đăng xuất, token bị thu hồi ngay lập tức trong DB.
-- 4. Tự động xóa sạch token khi người dùng bị xóa khỏi hệ thống (ON DELETE CASCADE).

CREATE TABLE IF NOT EXISTS public.refresh_tokens (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL,
    token_hash VARCHAR(255) NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    is_revoked BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    CONSTRAINT fk_refresh_tokens_user 
        FOREIGN KEY (user_id) 
        REFERENCES public.users(user_id) 
        ON DELETE CASCADE
);

-- Tối ưu chỉ mục truy vấn xác thực token và dọn dẹp token theo người dùng
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_token_hash ON public.refresh_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id ON public.refresh_tokens(user_id);

COMMENT ON TABLE public.refresh_tokens IS 'Lưu trữ mã băm SHA-256 của Refresh Token phục vụ xoay vòng và thu hồi phiên đăng nhập';
COMMENT ON COLUMN public.refresh_tokens.token_hash IS 'Chuỗi băm SHA-256 duy nhất (64 ký tự hex) của refresh token';
COMMENT ON COLUMN public.refresh_tokens.is_revoked IS 'Cờ đánh dấu token đã bị vô hiệu hóa (khi đổi token mới hoặc logout)';


-- ============================================================================
-- PHẦN B: BỔ SUNG CỘT BẢO MẬT VÀO BẢNG USERS (XÁC THỰC EMAIL & QUÊN MẬT KHẨU)
-- ============================================================================
-- Lý do thiết kế:
-- 1. password_reset_token: Lưu mã băm SHA-256 của token quên mật khẩu (thời hạn 15 phút).
-- 2. email_verification_token: Lưu mã băm SHA-256 của token kích hoạt tài khoản (thời hạn 24 giờ).
-- 3. Sau khi xác thực thành công, các trường này được xóa về NULL (chống dùng lại mã).

ALTER TABLE public.users 
    ADD COLUMN IF NOT EXISTS password_reset_token VARCHAR(255),
    ADD COLUMN IF NOT EXISTS password_reset_expires_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS email_verification_token VARCHAR(255),
    ADD COLUMN IF NOT EXISTS email_verification_expires_at TIMESTAMPTZ;

-- Tối ưu chỉ mục tìm kiếm người dùng khi click vào đường dẫn xác thực
CREATE INDEX IF NOT EXISTS idx_users_pwd_reset_token ON public.users(password_reset_token);
CREATE INDEX IF NOT EXISTS idx_users_email_verify_token ON public.users(email_verification_token);

COMMENT ON COLUMN public.users.password_reset_token IS 'Mã băm SHA-256 của chuỗi token đặt lại mật khẩu (link gửi qua email)';
COMMENT ON COLUMN public.users.password_reset_expires_at IS 'Thời điểm hết hạn của link đặt lại mật khẩu (mặc định 15 phút)';
COMMENT ON COLUMN public.users.email_verification_token IS 'Mã băm SHA-256 của token xác minh email kích hoạt tài khoản';
COMMENT ON COLUMN public.users.email_verification_expires_at IS 'Thời điểm hết hạn của mã xác minh email (mặc định 24 giờ)';


-- ============================================================================
-- PHẦN C: BẢNG DEVICE TEMPLATES (MẪU CẤU HÌNH NÚT BẤM VÀO DATABASE)
-- ============================================================================
-- Lý do thiết kế:
-- 1. Thay thế hoàn toàn mảng RAM tạm thời (in-memory) bằng bảng cơ sở dữ liệu bền vững.
-- 2. Đa khách thuê (Multi-tenant SaaS):
--    - store_id IS NULL: Template dùng chung toàn sàn (do Quản trị viên Super Admin tạo).
--    - store_id = [ID]: Template độc quyền của từng Cửa hàng cụ thể.
-- 3. Ràng buộc toàn vẹn: Xóa Store thì tự động dọn dẹp các Template riêng của Store đó.

CREATE TABLE IF NOT EXISTS public.device_templates (
    template_id BIGSERIAL PRIMARY KEY,
    code VARCHAR(100) NOT NULL UNIQUE,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    category VARCHAR(100),
    store_id BIGINT,
    single_press_action VARCHAR(50) DEFAULT 'CREATE_ORDER',
    double_press_action VARCHAR(50) DEFAULT 'CANCEL_ORDER',
    default_quantity INT DEFAULT 1,
    cancel_window_seconds INT DEFAULT 60,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_device_templates_store 
        FOREIGN KEY (store_id) 
        REFERENCES public.store(store_id) 
        ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_device_templates_store_id ON public.device_templates(store_id);
CREATE INDEX IF NOT EXISTS idx_device_templates_category ON public.device_templates(category);

COMMENT ON TABLE public.device_templates IS 'Bảng cấu hình mẫu nút bấm IoT (Device Templates) phục vụ nhân bản nhanh thiết bị';
COMMENT ON COLUMN public.device_templates.store_id IS 'Mã Store sở hữu template (NULL nếu là template dùng chung toàn hệ thống)';
COMMENT ON COLUMN public.device_templates.cancel_window_seconds IS 'Thời gian đếm ngược cho phép khách bấm đúp hủy đơn (mặc định 60 giây)';


-- ============================================================================
-- DỮ LIỆU MẪU MẶC ĐỊNH (SEED TEMPLATES CHO HỆ THỐNG)
-- ============================================================================
INSERT INTO public.device_templates (code, name, description, category, store_id, single_press_action, double_press_action, default_quantity, cancel_window_seconds)
VALUES 
    ('TMPL-WATER-20L', 'Nút Nước Khoáng 20L Tiêu Chuẩn', 'Cấu hình tiêu chuẩn cho dịch vụ giao nước đóng bình 20L tận nhà', 'Nước uống', NULL, 'CREATE_ORDER', 'CANCEL_ORDER', 1, 60),
    ('TMPL-GAS-12KG', 'Nút Đổi Bình Gas 12kg', 'Cấu hình cho dịch vụ đổi bình gas gia đình kèm kiểm tra van an toàn', 'Gas & Nhiên liệu', NULL, 'CREATE_ORDER', 'CANCEL_ORDER', 1, 60)
ON CONFLICT (code) DO NOTHING;

-- Xác nhận hoàn tất thành công toàn bộ giao dịch
COMMIT;

-- ============================================================================
-- TRUY VẤN KIỂM TRA NHANH KẾT QUẢ MIGRATION (SANITY CHECK)
-- ============================================================================
-- Chạy các lệnh SELECT dưới đây để kiểm tra sau khi chạy file script:
-- 1. Kiểm tra bảng refresh_tokens:
--    SELECT table_name FROM information_schema.tables WHERE table_name = 'refresh_tokens';
-- 2. Kiểm tra các cột bảo mật mới trong users:
--    SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'users' AND column_name LIKE '%token%';
-- 3. Kiểm tra bảng device_templates:
--    SELECT template_id, code, name, category, store_id FROM public.device_templates;
