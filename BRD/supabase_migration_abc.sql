-- ============================================================================
-- SMART ORDER BUTTON (BRD V2.1 & V2.2) — SUPABASE POSTGRESQL MIGRATION
-- File: supabase_migration_abc.sql
-- Mục đích: Kích hoạt đầy đủ các tính năng bảo mật, cấu hình cốt lõi & hình ảnh:
--   A. Refresh Token Rotation & Session Revocation (Skill: auth-rbac-implementation)
--   B. Password Reset & Email Verification bằng mã băm SHA-256 (Skill: advanced-auth-and-webhooks)
--   C. Quản lý Mẫu Nút Bấm Thiết Bị Đa Cửa Hàng (Device Templates in PostgreSQL)
--   D. Quản lý Đa Hình Ảnh Sản Phẩm qua Cloudinary (Product Images - Option 2)
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


-- ============================================================================
-- PHẦN D: BẢNG PRODUCT_IMAGE (QUẢN LÝ ĐA HÌNH ẢNH SẢN PHẨM & CLOUDINARY URL - OPTION 2)
-- ============================================================================
-- Lý do thiết kế:
-- 1. Chuẩn hóa theo Phương án 2 (Option 2): Một sản phẩm có thể có nhiều hình ảnh (Gallery & Carousel).
-- 2. Tách biệt hình ảnh thành bảng riêng public.product_image liên kết khóa ngoại với public.product(product_id).
-- 3. Hỗ trợ cờ is_thumbnail để đánh dấu ảnh đại diện nhanh và display_order để sắp xếp thứ tự hiển thị ảnh trên UI.
-- 4. Ràng buộc toàn vẹn ON DELETE CASCADE: Khi xóa sản phẩm thì toàn bộ ảnh liên quan tự động xóa sạch sẽ.
-- 5. image_url lưu trữ trực tiếp đường dẫn CDN Cloudinary đã upload qua Presigned Signature (GET /media/signature)
--    hoặc Server Upload API (POST /media/upload) với xác thực Magic Bytes chống RCE.

CREATE TABLE IF NOT EXISTS public.product_image (
    image_id BIGSERIAL PRIMARY KEY,
    product_id BIGINT NOT NULL,
    image_url TEXT NOT NULL,
    is_thumbnail BOOLEAN NOT NULL DEFAULT FALSE,
    display_order INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_product_image_product
        FOREIGN KEY (product_id)
        REFERENCES public.product(product_id)
        ON DELETE CASCADE
);

-- Tối ưu chỉ mục truy vấn danh sách ảnh theo sản phẩm và tìm ảnh đại diện
CREATE INDEX IF NOT EXISTS idx_product_image_product_id ON public.product_image(product_id);
CREATE INDEX IF NOT EXISTS idx_product_image_is_thumbnail ON public.product_image(is_thumbnail);

COMMENT ON TABLE public.product_image IS 'Lưu trữ danh sách hình ảnh của sản phẩm lưu qua Cloudinary (hỗ trợ nhiều ảnh/gallery và thumbnail)';
COMMENT ON COLUMN public.product_image.image_id IS 'Khóa chính định danh ảnh sản phẩm';
COMMENT ON COLUMN public.product_image.product_id IS 'Mã sản phẩm sở hữu ảnh (FK -> product.product_id)';
COMMENT ON COLUMN public.product_image.image_url IS 'Đường dẫn URL an toàn của ảnh trên Cloudinary CDN';
COMMENT ON COLUMN public.product_image.is_thumbnail IS 'Đánh dấu ảnh làm ảnh đại diện chính của sản phẩm (Thumbnail)';
COMMENT ON COLUMN public.product_image.display_order IS 'Thứ tự ưu tiên hiển thị của ảnh trên giao diện người dùng (0, 1, 2, ...)';


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
-- 4. Kiểm tra bảng product_image:
--    SELECT table_name FROM information_schema.tables WHERE table_name = 'product_image';
--    SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = 'product_image';
--    SELECT p.product_id, p.product_name, count(pi.image_id) as total_images
--    FROM public.product p
--    LEFT JOIN public.product_image pi ON p.product_id = pi.product_id
--    GROUP BY p.product_id, p.product_name
--    LIMIT 10;


-- =========================================================================
-- Wallet Idempotency & Security Tables
-- =========================================================================
CREATE UNIQUE INDEX IF NOT EXISTS uq_wallet_tx_idempotency
  ON public.wallet_transactions (wallet_id, type, reference_id);

CREATE TABLE IF NOT EXISTS public.pairing_tokens (
  id BIGSERIAL PRIMARY KEY,
  device_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pairing_tokens_device_status ON public.pairing_tokens(device_id, status);

CREATE TABLE IF NOT EXISTS public.revoked_tokens (
  id BIGSERIAL PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id BIGINT,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_revoked_tokens_hash ON public.revoked_tokens(token_hash);


-- Foreign key and check constraints for pairing_tokens
ALTER TABLE public.pairing_tokens ADD CONSTRAINT fk_pairing_tokens_device FOREIGN KEY (device_id) REFERENCES public.iot_button(device_id) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE public.pairing_tokens ADD CONSTRAINT chk_pairing_token_status CHECK (status IN ('ACTIVE', 'USED', 'REVOKED'));
