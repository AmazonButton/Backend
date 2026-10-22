# Backend Node.js Security & Architecture Rules (AGENTS / GEMINI)

Hệ thống quy tắc bắt buộc áp dụng cho toàn bộ quá trình thiết kế, lập trình, review và refactor mã nguồn Backend sử dụng **Node.js, Express.js và PostgreSQL**.

Tài liệu này được chuẩn hóa theo tiêu chuẩn OWASP API Security Top 10 và các nguyên tắc cốt lõi của Security-by-Design.

---

## 1. Triết lý & Nguyên tắc cốt lõi (Core Principles)

1. **Never Trust Client (Zero Trust)**: Mọi dữ liệu đến từ frontend (React, Mobile, Postman, curl) đều là UNTRUSTED (`req.body`, `req.params`, `req.query`, `headers`, `cookies`, `files`). Frontend chỉ là UX; Backend là chốt chặn bảo mật duy nhất (Security Boundary).
2. **Defense in Depth**: Bảo mật đa lớp (Network/Reverse Proxy -> Security Headers -> CORS -> Rate Limiting -> Body Size Limit -> Authentication -> Authorization -> Input Validation -> Business Logic -> Parameterized Query -> Sanitized Output).
3. **Least Privilege**: Cấp quyền tối thiểu cho Database User, Application Service, và End-User Roles. Không bao giờ dùng PostgreSQL Superuser cho ứng dụng.
4. **Fail Securely**: Khi xảy ra lỗi hoặc ngoại lệ, hệ thống phải đóng quyền truy cập, không mở cửa sổ thông tin, không tiết lộ stack trace hay cấu trúc database ra response.
5. **No Secrets in Code**: Tuyệt đối không hard-code passwords, API keys, JWT secrets, database credentials vào source code hoặc Git.

---

## 2. Chuẩn công nghệ Backend (Standard Tech Stack)

| Thành phần | Công nghệ / Thư viện đề xuất | Mục đích an toàn & vận hành |
|---|---|---|
| **Runtime & Framework** | Node.js (LTS), Express.js | Khởi tạo REST API tốc độ cao, tiêu chuẩn công nghiệp |
| **Database** | PostgreSQL | Quan hệ dữ liệu chặt chẽ, ACID compliance |
| **DB Client / Pool** | `pg` (`node-postgres`) hoặc Kysely / Prisma | Quản lý connection pool, bắt buộc dùng **Parameterized Queries** |
| **Security Headers** | `helmet` | Bật CSP, HSTS, X-Content-Type-Options, chặn Clickjacking |
| **CORS** | `cors` | Whitelist chính xác domain React frontend, `credentials: true` nếu dùng cookie |
| **Rate Limiting** | `express-rate-limit` (kết hợp Redis nếu cluster) | Chống DoS, Brute Force mật khẩu, OTP flooding |
| **Input Validation** | `zod` hoặc `express-validator` | Validate kiểu dữ liệu, format, độ dài, sanitize input |
| **Password Hashing** | `argon2` hoặc `bcrypt` (salt rounds >= 12) | Băm mật khẩu một chiều chống GPU/ASIC rainbow table |
| **Authentication** | `jsonwebtoken` + HttpOnly Cookie / Bearer | Quản lý Access Token (ngắn hạn) và Refresh Token rotation |
| **Cookie Parsing** | `cookie-parser` | Đọc cookie an toàn với `httpOnly`, `secure`, `sameSite: 'strict'/'lax'` |
| **File Upload** | `multer` + file type verification (magic bytes) | Giới hạn dung lượng, whitelist MIME type, đổi tên file ngẫu nhiên (UUID) |
| **Logging** | `winston` hoặc `pino` | Ghi log JSON có cấu trúc, tự động mask/redact thông tin nhạy cảm |
| **Env Validation** | `zod` hoặc `envalid` | Xác thực toàn bộ biến môi trường lúc khởi động server (Boot-time validation) |
| **Caching & KV Store** | `ioredis` / Redis | Tăng tốc độ đọc (Cache-Aside), lưu distributed rate limit & idempotency |
| **Task Queue / Jobs** | `bullmq` | Xử lý tác vụ nền bất đồng bộ (email, render PDF, nén ảnh), không block HTTP |
| **Automated Testing**| `jest` / `vitest` + `supertest` | Viết unit test & security integration test tự động |

---

## 3. Kiến trúc phân lớp bắt buộc (6-Layer Architecture)

Mọi endpoint trong project đều phải tuân thủ nghiêm ngặt mô hình phân lớp rõ ràng. Tầng **Router** đóng vai trò cửa ngõ định tuyến, gắn kết middleware pipeline và điều hướng tới Controller. **Nghiêm cấm viết trực tiếp Business Logic hay gọi Database trong Route handler**:

```text
HTTP Request
     │
     ▼
[ 1. Router Layer ]      ──► (Định tuyến HTTP Method/Path: GET, POST...; ghép nối middleware pipeline)
     │
     ▼
[ 2. Middleware Layer ]  ──► (Security Headers, CORS, Rate Limiter, Body Limit, Auth, RBAC, Validator)
     │
     ▼
[ 3. Controller Layer ]  ──► (Tiếp nhận request đã qua validate, gọi Service, trả HTTP status & DTO)
     │
     ▼
[ 4. Service Layer ]     ──► (Xử lý toàn bộ Business Logic, kiểm tra quyền sở hữu BOLA/IDOR, tính toán)
     │
     ▼
[ 5. Repository Layer ]  ──► (Thực thi truy vấn dữ liệu SQL với Parameterized Query an toàn)
     │
     ▼
[ 6. Database Layer ]    ──► (PostgreSQL vận hành với Role phân quyền tối thiểu)
```

### Trách nhiệm chi tiết của Tầng Router (`routes/`):
- **Khai báo URL & HTTP Method**: Xác định rõ ràng endpoint chuẩn RESTful (ví dụ: `router.post('/books', ...)`).
- **Gắn chuỗi Middleware (Middleware Pipeline)**: Áp dụng các chốt chặn theo đúng thứ tự:
  `authenticate` $\rightarrow$ `requireRoles([...])` $\rightarrow$ `validate(schema)` $\rightarrow$ `controller.method`.
- **Tránh phình to logic**: Router chỉ làm nhiệm vụ "dẫn đường" (Routing & Wiring), tuyệt đối không chứa `try/catch`, không tính toán hay truy vấn dữ liệu.


---

## 4. 25 Quy tắc bảo mật bất khả xâm phạm (25 Immutable Security Rules)

### Nhóm Authentication & Password
- **RULE-01 (Password Plaintext)**: Tuyệt đối không lưu plaintext password. Sử dụng `argon2.hash()` hoặc `bcrypt.hash()` với salt round >= 12.
- **RULE-02 (Token Expiration)**: Access Token phải ngắn hạn (15 phút - 1 giờ). Refresh Token phải được mã hóa, lưu trong Database hoặc Cookie `httpOnly, secure, sameSite`.
- **RULE-03 (Credential Leak)**: Khi đăng nhập thất bại, chỉ trả thông báo chung: `{"message": "Invalid email or password"}` (HTTP 401). Không tiết lộ email có tồn tại hay không.
- **RULE-04 (Sensitive Response)**: Tuyệt đối không trả `password_hash`, `refresh_token`, `reset_token`, hoặc internal flags trong response gửi về client. Luôn chuyển đổi qua hàm DTO/Sanitizer trước khi `res.json()`.

### Nhóm Authorization & Access Control (Chống BOLA / IDOR / BFLA)
- **RULE-05 (Backend Authorization)**: Ẩn nút hay bảo vệ route ở React chỉ là UX. Mọi API nhạy cảm phải được kiểm tra quyền ở Backend middleware.
- **RULE-06 (Object-Level Ownership / BOLA)**: Với các endpoint dạng `/api/resource/:id`, Service/Repository PHẢI kiểm tra `resource.userId === currentUserId` trừ khi người gọi có role `ADMIN`. Không cho phép user tùy tiện đọc/sửa dữ liệu của người khác bằng cách đổi ID trên URL.
- **RULE-07 (Role-Based Access Control - RBAC)**: Định nghĩa rõ ràng danh sách role (`ADMIN`, `STAFF`, `USER`) và permission. Dùng middleware `requireRole(['ADMIN'])` để bảo vệ các chức năng quản trị.

### Nhóm Input Validation & Mass Assignment
- **RULE-08 (Mandatory Validation)**: Mọi payload từ `req.body`, `req.query`, `req.params` phải qua schema validator (`zod` hoặc `express-validator`) trước khi vào Controller.
- **RULE-09 (Mass Assignment / Whitelist DTO)**: Tuyệt đối không truyền thẳng `req.body` vào lệnh Update/Create (`User.update(req.body)`). Bắt buộc phải whitelist danh sách trường được phép sửa (ví dụ: chỉ cho phép `username`, `avatar`, cấm `role`, `isActive`, `balance`).

### Nhóm Database & SQL Injection
- **RULE-10 (Parameterized Queries Only)**: Tuyệt đối KHÔNG cộng chuỗi SQL (`"SELECT * FROM users WHERE email = '" + email + "'"`). Bắt buộc dùng parameterized query với placeholder `$1, $2` của `node-postgres`.
- **RULE-11 (Dynamic Query Guard)**: Nếu cần sort hoặc filter động, tên cột (`column_name`) và thứ tự sắp xếp (`ASC`/`DESC`) phải được so sánh với một whitelist mảng cố định (`ALLOWED_SORT_FIELDS.includes(sortBy)`).
- **RULE-12 (Least Privilege DB User)**: Backend kết nối PostgreSQL bằng application user thông thường chỉ có quyền `SELECT, INSERT, UPDATE, DELETE` trên các bảng cần thiết. Không cấp quyền `SUPERUSER`, `DROP DATABASE`, `ALTER TABLE`.

### Nhóm Resource Exhaustion & DoS Prevention
- **RULE-13 (Rate Limiting)**: Áp dụng rate limiter nghiêm ngặt trên các endpoint nhạy cảm (`/api/auth/login`, `/api/auth/register`, `/api/auth/forgot-password`, `/api/auth/otp`) tối đa 5-10 requests / phút.
- **RULE-14 (Request Body Limits)**: Cấu hình giới hạn kích thước JSON: `express.json({ limit: '10kb' })` để chống DoS bằng memory payload khổng lồ.
- **RULE-15 (Pagination Cap)**: Mọi endpoint trả danh sách bắt buộc có phân trang. Thiết lập giới hạn tối đa `pageSize = Math.min(Number(req.query.pageSize) || 10, 100)`. Chặn triệt để request `pageSize=999999`.

### Nhóm Error Handling & Information Disclosure
- **RULE-16 (Secure Error Response)**: Middleware xử lý lỗi tập trung (Error Handler) phải phân biệt môi trường. Trong môi trường `production`, không bao giờ trả `stack`, `sql`, `path`, hoặc lỗi chi tiết của database về client. Chỉ trả mã lỗi nghiệp vụ và thông báo an toàn (`Internal Server Error`).
- **RULE-17 (Sanitized Logging)**: Ghi log lỗi vào file hoặc log collector phía server. Tự động xóa/mask các trường nhạy cảm: `password`, `token`, `authorization`, `creditCard`, `secret`. Tuyệt đối không `console.log(req.headers.authorization)`.

### Nhóm Network & File Security
- **RULE-18 (CORS Configuration)**: Không sử dụng `cors({ origin: '*' })` trong production khi có truyền cookie hay Authorization headers. Xác định rõ danh sách domain frontend tin cậy.
- **RULE-19 (Security Headers)**: Luôn kích hoạt `helmet()` ở đầu middleware pipeline của Express.
- **RULE-20 (Secure File Upload)**: Xác thực file upload bằng cả phần mở rộng (extension) và magic bytes (MIME type thực tế). Lưu file với tên UUID ngẫu nhiên, không đặt trực tiếp trong thư mục static thực thi được code (tránh Remote Code Execution).
- **RULE-21 (SSRF Protection)**: Nếu backend có chức năng fetch URL từ user (`/api/fetch-url`), bắt buộc phải whitelist domain, chặn các dải IP riêng tư (`127.0.0.1`, `localhost`, `10.0.0.0/8`, `192.168.0.0/16`, `169.254.169.254`).

### Nhóm Code Quality & Testing
- **RULE-22 (Test-Driven Security)**: Mỗi tính năng cốt lõi (Auth, RBAC, Ownership, Validation, SQLi) phải có bài kiểm tra tự động (`supertest`) để đảm bảo không bị regression.
- **RULE-23 (Dependency Security)**: Thường xuyên chạy `npm audit` trong quy trình CI/CD. Khóa phiên bản bằng `package-lock.json`.
- **RULE-24 (HTTP Status Semantics)**: Dùng đúng mã HTTP: `401 Unauthorized` (chưa đăng nhập / token sai), `403 Forbidden` (đã đăng nhập nhưng không có quyền), `422/400` (dữ liệu không hợp lệ), `429` (quá giới hạn rate limit).
- **RULE-25 (Fail-Safe Defaults)**: Mặc định mọi route mới tạo là **Protected** và yêu cầu Authentication, trừ khi được chỉ định rõ ràng là **Public Route**.
