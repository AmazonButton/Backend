# Backend API Design & Development Convention Rules

Quy chuẩn thiết kế REST API, định dạng dữ liệu, chuẩn lập trình và quy trình phát triển cho dự án **Node.js + Express.js + PostgreSQL**.

Tài liệu này được chuẩn hóa theo quy chuẩn thiết kế RESTful API chuẩn công nghiệp kết hợp cùng [NODEJS_BACKEND_SECURITY_RULES.md](file:///f:/Learning/SEM9-FPTu/project/Rules/NODEJS_BACKEND_SECURITY_RULES.md).

---

## 1. RESTful API Naming & Versioning Rules

- **URL Base & Versioning**: Mọi API phải có prefix `/api/v1/` (ví dụ: `/api/v1/users`, `/api/v1/books`). Tuyệt đối không thay đổi breaking changes ngầm mà không nâng version (`/api/v2/`).
- **Resource Naming**:
  - Dùng **danh từ số nhiều** (plural noun), chữ thường (`lowercase`).
  - Đường dẫn gồm nhiều từ phải dùng dạng **`kebab-case`** (ví dụ: `/borrow-records`, `/user-profiles`).
  - **Tuyệt đối không dùng động từ trong URI**: Dùng `POST /api/v1/users` thay vì `/createUser`, dùng `DELETE /api/v1/users/:id` thay vì `/deleteUser`.
- **HTTP Methods Chuẩn**:
  - `GET`: Truy vấn dữ liệu (Safe & Idempotent). Không gửi body trong `GET`.
  - `POST`: Tạo mới resource hoặc kích hoạt tác vụ đặc thù (Non-idempotent).
  - `PUT`: Thay thế toàn bộ resource.
  - `PATCH`: Cập nhật một phần resource.
  - `DELETE`: Xóa resource.
- **Resource Relationships**: Hạn chế lồng URI quá sâu (tối đa 2 cấp: `/api/v1/users/:id/borrow-records`). Nếu resource con có ID định danh riêng, ưu tiên đưa về endpoint cấp 1 (`/api/v1/borrow-records/:recordId`).

---

## 2. Response & Error Envelopes

Mọi API của hệ thống bắt buộc phải trả về JSON có cấu trúc envelope đồng nhất, giúp frontend xử lý nhất quán.

### A. Success Response
```json
{
  "success": true,
  "message": "Books retrieved successfully",
  "data": [ ... ],
  "pagination": {
    "page": 1,
    "pageSize": 20,
    "totalItems": 150,
    "totalPages": 8
  }
}
```
*Lưu ý:* Nếu trả về danh sách rỗng, `data` bắt buộc là mảng rỗng `[]`, không được để `null`.

### B. Error Response
```json
{
  "success": false,
  "message": "Validation failed",
  "errorCode": "VALIDATION_ERROR",
  "errors": [
    { "field": "email", "message": "Email is already in use" }
  ]
}
```
*Lưu ý:* Frontend phải bắt lỗi theo `errorCode` (enum UPPER_SNAKE_CASE), không được parse chuỗi text trong `message`.

### C. HTTP Status Code Semantics
- `200 OK`: Thành công (GET, PATCH, PUT, hoặc DELETE kèm response data).
- `201 Created`: Tạo mới thành công (POST).
- `204 No Content`: Xóa thành công hoặc cập nhật không cần trả body.
- `400 Bad Request`: Payload sai cú pháp hoặc thiếu thông tin cơ bản.
- `401 Unauthorized`: Chưa đăng nhập hoặc token không hợp lệ/hết hạn.
- `403 Forbidden`: Đã đăng nhập nhưng không đủ quyền hạn (RBAC) hoặc không sở hữu tài nguyên (BOLA).
- `404 Not Found`: Không tìm thấy endpoint hoặc resource ID.
- `409 Conflict`: Xung đột dữ liệu (trùng email, trùng mã tài liệu, state không hợp lệ).
- `422 Unprocessable Entity`: Dữ liệu vi phạm validation schema hoặc business rule.
- `429 Too Many Requests`: Vượt quá giới hạn rate limit.
- `500 Internal Server Error`: Lỗi máy chủ (tuyệt đối không leak stack trace trong production).

---

## 3. Pagination, Sorting, Filtering, Field Selection & Expansion Standard

- **Pagination Query & Extended Metadata**:
  - Tham số thống nhất: `?page=1&pageSize=20`. Cấm dùng tên khác như `p`, `size`, `limit`, `per_page`.
  - Giới hạn cứng: `page >= 1`, `1 <= pageSize <= 100`. Luôn fallback giá trị mặc định (`page=1, pageSize=10`).
  - Metadata phân trang bắt buộc trả về đầy đủ cờ điều hướng:
    ```json
    "pagination": {
      "page": 1,
      "pageSize": 20,
      "totalItems": 150,
      "totalPages": 8,
      "hasNextPage": true,
      "hasPrevPage": false
    }
    ```
- **Sorting Query**:
  - Tham số: `?sortBy=created_at&sortOrder=desc`.
  - Backend bắt buộc phải whitelist các trường được phép sort (`ALLOWED_SORT_FIELDS`). Tuyệt đối không cho phép client truyền chuỗi SQL raw vào mệnh đề `ORDER BY`.
- **Search & Filter**:
  - Tìm kiếm toàn văn/từ khóa: `?search=keyword`.
  - Bộ lọc cụ thể: `?categoryId=5&status=active`.
- **Sparse Fieldsets (Field Selection — `?fields=`)**:
  - Cho phép client chỉ yêu cầu các trường cần thiết để tối ưu băng thông: `?fields=id,name,status`.
  - Backend phải kiểm tra whitelist trường hợp lệ, loại bỏ các trường cấm (ví dụ: `password_hash`, `internal_note`) trước khi đưa vào câu lệnh SELECT SQL hoặc DTO projection.
- **Resource Expansion (Relation Embedding — `?expand=`)**:
  - Cho phép client nhúng thêm quan hệ liên kết trong 1 request GET duy nhất mà không cần gọi nhiều API: `?expand=author,category`.
  - Backend phải định nghĩa mảng quan hệ được phép mở rộng (`ALLOWED_EXPANDS = ['author', 'category']`). Truy vấn bằng SQL `LEFT JOIN` hoặc nạp theo batch IDs (tránh triệt để lỗi N+1 Query).


---

## 4. DTO & Data Transfer Boundary

- **Không trả raw Database Entity**: Tuyệt đối không `res.json(userEntity)`.
- **DTO Mappers bắt buộc**: Mọi dữ liệu trả ra phải đi qua hàm mapper để:
  1. Loại bỏ các trường nhạy cảm (`password_hash`, `refresh_token`, `reset_token`).
  2. Ẩn các trường nội bộ (`internal_note`, `version`).
  3. Định dạng thời gian theo chuẩn ISO 8601 (`YYYY-MM-DDTHH:mm:ssZ`).
  4. Độc lập giữa Database Schema và API Contract.

---

## 5. Code Style & Naming Convention

- **Files**: `[feature].[layer].js` dạng `kebab-case` hoặc `dot-case`:
  - `books.routes.js`, `books.controller.js`, `books.service.js`, `books.repository.js`, `books.schema.js`.
  - Không trộn lẫn: `BooksController.js` hay `book_service.js`.
- **Variables & Functions**: `camelCase` (ví dụ: `getUserById()`, `calculateTotal()`, `accessToken`).
- **Classes**: `PascalCase` (ví dụ: `AppError`, `DatabasePool`).
- **Constants & Enums**: `UPPER_SNAKE_CASE` (ví dụ: `MAX_PAGE_SIZE = 100`, `ROLES = { ADMIN: 'ADMIN' }`).
- **Database Schema**: Bắt buộc dùng `snake_case`:
  - Bảng: số nhiều (`users`, `books`, `borrow_records`).
  - Khóa ngoại: `[singular_table]_id` (`user_id`, `book_id`).
  - Thời gian: `created_at`, `updated_at`, `deleted_at`.

---

## 6. Database Integrity, Migrations & Transactions

- **Dual-Layer Integrity**: Không chỉ validate ở Node.js. Database phải có đầy đủ constraints: `PRIMARY KEY`, `FOREIGN KEY`, `NOT NULL`, `UNIQUE`, `CHECK` (ví dụ: `CHECK (price >= 0)`).
- **Explicit Indexing**: Tạo index cho các cột thường xuyên nằm trong `WHERE`, `JOIN`, `ORDER BY` (ví dụ: `users.email`, `borrow_records.user_id`).
- **Migration bắt buộc**: Không bao giờ chỉnh sửa trực tiếp database production. Mọi thay đổi schema phải được ghi lại qua migration file (`migrations/001_initial_schema.sql`).
- **Transaction Safety**: Các luồng nghiệp vụ đụng chạm nhiều bảng (đặt hàng, mượn sách, trừ tiền) phải được bọc trong database transaction (`BEGIN ... COMMIT / ROLLBACK`).
- **Idempotency**: Đối với các endpoint thanh toán, tạo đơn hoặc webhook, hỗ trợ header `Idempotency-Key` để tránh bị thực thi trùng lặp khi mạng chập chờn.

---

## 7. Soft Delete & Partial Index Standard

- **Nguyên tắc Soft Delete**: Các bảng dữ liệu quan trọng liên quan đến người dùng hoặc giao dịch tài chính không thực hiện `DELETE` vật lý (Hard Delete). Bắt buộc sử dụng cờ `deleted_at TIMESTAMPTZ NULL`.
- **Giải quyết xung đột Unique Constraint**: Khi một bản ghi bị xóa mềm (`deleted_at IS NOT NULL`), người dùng hoặc hệ thống có quyền tạo mới bản ghi khác với cùng giá trị định danh (ví dụ: email). Do đó, **tuyệt đối không dùng `UNIQUE(email)` trực tiếp**, mà phải dùng **Partial Unique Index**:
  ```sql
  CREATE UNIQUE INDEX idx_users_email_active ON users (email) WHERE deleted_at IS NULL;
  ```
- **Query Filter**: Mọi câu lệnh `SELECT` ở Repository layer phải tự động gắn điều kiện `WHERE deleted_at IS NULL` trừ khi là query phục vụ module Admin Audit/Restore.

---

## 8. Caching & Background Jobs Convention (Redis & BullMQ)

- **Chiến lược Caching (Cache-Aside)**:
  - Sử dụng Redis làm cache cho các endpoint có tần suất đọc lớn nhưng ít biến động (danh mục sách, chi tiết cấu hình).
  - Luôn đặt **TTL (Time-To-Live)** cụ thể (ví dụ: 15-60 phút) cho mọi cache key để tránh tồn đọng stale data vĩnh viễn.
  - **Cache Invalidation bắt buộc**: Bất cứ khi nào dữ liệu bị thay đổi (`POST /books`, `PUT /books/:id`), Service layer phải chủ động xóa cache key tương ứng (`redis.del('books:list:*')`).
- **Tác vụ nền bất đồng bộ (Background Jobs)**:
  - Tuyệt đối không thực thi các tác vụ nặng (gửi email kích hoạt, render PDF, nén ảnh đại diện, sync bên thứ ba) trực tiếp trong chu kỳ sống của HTTP request Express.
  - Sử dụng **BullMQ** (chạy trên Redis) để đẩy tác vụ vào hàng đợi (producer), và cho Worker xử lý ở tiến trình độc lập kèm chính sách Retry (3-5 lần) với exponential backoff.

---

## 9. Server Lifecycle, Health Monitoring & API Documentation

- **Health Checks (`/healthz` & `/readyz`)**:
  - `GET /healthz` (Liveness): Trả về `200 OK` nếu tiến trình Node.js đang chạy bình thường.
  - `GET /readyz` (Readiness): Kiểm tra trạng thái ping thực tế tới PostgreSQL (`SELECT 1`) và Redis (`redis.ping()`). Chỉ trả `200 OK` khi cả 2 phụ thuộc cốt lõi đã sẵn sàng; nếu lỗi, trả về `503 Service Unavailable` để Load Balancer không điều hướng request tới instance này.
- **Graceful Shutdown Lifecycle**:
  - Ứng dụng phải bắt tín hiệu `SIGTERM` và `SIGINT` (từ Docker/Kubernetes/PM2).
  - Khi nhận tín hiệu tắt:
    1. Ngừng nhận request HTTP mới (`server.close()`).
    2. Đợi các request đang thực thi hoàn tất (timeout 10-15s).
    3. Đóng an toàn PostgreSQL pool (`await pool.end()`) và Redis client (`await redis.quit()`).
    4. Thoát tiến trình với mã `process.exit(0)`.
- **OpenAPI / Swagger Automation**:
  - Không viết tay và duy trì thủ công file `swagger.yaml`.
  - Sử dụng thư viện `@asteasolutions/zod-to-openapi` tích hợp trực tiếp với các Zod Schema có sẵn để tự động phát sinh Swagger Document, phục vụ tài liệu sống (Living Documentation) cho đội ngũ Frontend React.

---

## 10. Correlation ID & Request Tracing (Observability Standard)

- **Mục tiêu**: Giúp định danh duy nhất từng request xuyên suốt vòng đời từ HTTP route -> Middleware -> Service -> SQL query -> Error log.
- **Quy tắc**:
  - Middleware kiểm tra header `X-Request-Id` do client gửi lên (nếu có) hoặc tự sinh mới bằng `crypto.randomUUID()`.
  - Gán ID này vào `res.setHeader('X-Request-Id', requestId)` để client có thể báo cáo khi gặp lỗi.
  - Tích hợp `AsyncLocalStorage` của Node.js vào Winston Logger để mọi dòng log tự động đính kèm `[requestId]`, không cần truyền thủ công qua từng hàm.

---

## 11. Webhook Security & Raw Body Standard

- **Bảo toàn Raw Body Buffer**:
  - Khi tiếp nhận Webhook từ cổng thanh toán (VNPay, Stripe, MoMo), bắt buộc phải lưu lại raw buffer byte (`req.rawBody`) trước khi `express.json()` phân tích cú pháp.
  - Sử dụng tùy chọn `verify: (req, res, buf) => { if (req.originalUrl.startsWith('/api/v1/webhooks')) req.rawBody = buf; }`.
- **Xác thực chữ ký số (HMAC Verification)**:
  - Bắt buộc kiểm tra chữ ký số HMAC-SHA256 gửi trong header.
  - Luôn sử dụng hàm so sánh thời gian bất biến (`crypto.timingSafeEqual`) để chống Timing Attacks.
  - Kiểm tra timestamp đi kèm để chặn tấn công phát lại (Replay Attacks, cửa sổ chấp nhận tối đa 5 phút).

---

## 12. Local Development Experience (DevEx) & Database Seeding

- **Môi trường cục bộ**: Dự án bắt buộc có file `docker-compose.yml` chứa PostgreSQL 16 và Redis 7 để thành viên mới chỉ cần gõ `docker compose up -d` là sẵn sàng làm việc.
- **Database Seeding (`npm run seed`)**:
  - Cung cấp script tạo tài khoản quản trị mặc định (`admin@example.com` với mật khẩu được hash bằng Argon2 chuẩn).
  - Khởi tạo danh mục dữ liệu tĩnh bắt buộc (vai trò hệ thống, danh mục sách mẫu) mà không cần can thiệp thủ công vào cơ sở dữ liệu.

---

## 13. Nested RESTful Routing Standard

- **Nguyên tắc phân cấp quan hệ 1-N (One-to-Many)**:
  - Khi một resource con phụ thuộc chặt chẽ vào một resource cha (Parent-Child relation, ví dụ: tạo một `item` gắn trực tiếp vào một `container`), sử dụng Nested Route để thể hiện quan hệ cha-con:
    - `POST /api/v1/parents/:parentId/children`: Tạo resource con gắn với parentId.
    - `GET  /api/v1/parents/:parentId/children`: Lấy danh sách resource con thuộc về parentId.
- **Giới hạn độ sâu URL (Max 2 Levels)**:
  - Tuyệt đối không lồng quá 2 cấp URL (ví dụ cấm: `/api/v1/orgs/1/depts/2/teams/3/users/4`).
  - Khi thao tác trên một resource con cụ thể đã có ID định danh duy nhất (UUID), **bắt buộc đưa về Top-Level Route** để URL tinh gọn và dễ bảo trì:
    - `GET    /api/v1/children/:childId` (thay vì `/parents/:parentId/children/:childId`).
    - `PATCH  /api/v1/children/:childId`.
    - `DELETE /api/v1/children/:childId`.

---

## 14. Resource State Transitions & Lifecycle Mutations

- **Quy tắc thay đổi trạng thái thực thể (State Machine)**:
  - Các thực thể có vòng đời phức tạp (ví dụ: `Order`: PENDING $\rightarrow$ CONFIRMED $\rightarrow$ COMPLETED / CANCELLED; `Enrollment`: ENROLLED $\rightarrow$ COMPLETED / DROPPED).
  - Không cho phép client gửi `PATCH /resources/:id` sửa tự do mọi trường trạng thái.
  - Sử dụng endpoint hành động cụ thể hoặc validate chặt chẽ ma trận chuyển đổi trạng thái (State Transition Matrix):
    - `PATCH /api/v1/resources/:id/status` với body `{ "status": "CANCELLED", "reason": "..." }`.
  - Service Layer phải kiểm tra tính hợp lệ của trạng thái hiện tại trước khi chuyển đổi (ví dụ: không thể `CANCEL` một đơn đã `COMPLETED`).
  - Sử dụng **Row-Level Locking (`SELECT ... FOR UPDATE`)** trong database transaction để đảm bảo 2 request cập nhật trạng thái đồng thời không gây xung đột logic.



