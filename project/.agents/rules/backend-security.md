# Antigravity Backend Security Rules

Reference to master project rules:
- [NODEJS_BACKEND_SECURITY_RULES.md](file:///f:/Learning/SEM9-FPTu/project/Rules/NODEJS_BACKEND_SECURITY_RULES.md)
- [BACKEND_API_DEVELOPMENT_RULES.md](file:///f:/Learning/SEM9-FPTu/project/Rules/BACKEND_API_DEVELOPMENT_RULES.md)
- [AGENTS.md](file:///f:/Learning/SEM9-FPTu/project/AGENTS.md)

All agents working on this backend must strictly enforce:
1. 6-layer architecture (Router -> Middleware -> Controller -> Service -> Repository -> Database).
2. RESTful naming (`/api/v1/...`, plural nouns, kebab-case) & uniform response envelope (`{ success, message, data }`).
3. Parameterized SQL queries with `$1, $2` via `node-postgres`. Zero string concatenation.
4. Zero trust input validation via Zod schemas.
5. Fail-secure centralized error handling with no stack trace leakage in production.
6. Whitelisted DTOs for create/update operations to block Mass Assignment attacks.
7. Resource ownership validation (BOLA / IDOR protection) on all by-ID routes.
8. Argon2/Bcrypt password hashing with salt rounds >= 12.
9. Rate limiting on all authentication and sensitive endpoints.
10. Explicit database transactions (`BEGIN ... COMMIT / ROLLBACK`) and row-locking (`FOR UPDATE`) on concurrent state changes.
11. Soft delete with PostgreSQL Partial Unique Index (`WHERE deleted_at IS NULL`) to avoid constraint collision.
12. Cache-Aside with TTL & explicit invalidation on mutations; BullMQ for background asynchronous tasks.
13. Health probes (`/healthz`, `/readyz`) and Graceful Shutdown on SIGTERM/SIGINT.
14. File uploads must verify magic bytes, sanitize SVGs, and prefer S3/Cloudinary presigned URLs.
15. Webhooks must retain raw body buffers and use timing-safe HMAC-SHA256 signature verification.
16. Correlation ID (`X-Request-Id`) attached to every request and traced across all logs.
