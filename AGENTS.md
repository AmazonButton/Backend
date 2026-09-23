# Antigravity Global Rules for Node.js Backend Project

This project implements a Security-by-Design Node.js + Express + PostgreSQL backend.
All AI agent actions, code generation, refactoring, and reviews MUST strictly adhere to the project rules and standards defined below.

Full Specifications & Standards:
- [NODEJS_BACKEND_SECURITY_RULES.md](file:///f:/Learning/SEM9-FPTu/backend/Rules/NODEJS_BACKEND_SECURITY_RULES.md): Security-by-Design and 25 core security rules.
- [BACKEND_API_DEVELOPMENT_RULES.md](file:///f:/Learning/SEM9-FPTu/backend/Rules/BACKEND_API_DEVELOPMENT_RULES.md): REST API design, response envelopes, DTOs, and coding conventions.

---

## 1. Architecture Rules (Mandatory 6-Layer Pattern)
- Do NOT place database calls or business logic directly inside route handlers or controllers.
- All endpoints must strictly adhere to the layered pipeline:
  `Router Layer` -> `Middleware Layer (Auth/RBAC/Validation/RateLimit)` -> `Controller Layer` -> `Service Layer` -> `Repository Layer` -> `PostgreSQL Database`.
- The **Router Layer** is strictly responsible for route definition, URL path mapping (`/api/v1/...`, plural nouns, kebab-case), and binding the appropriate middleware chain to the controller method.
- **Controllers** are only responsible for extracting validated input, delegating to the appropriate Service, and returning standard HTTP responses using the uniform envelope (`{ success, message, data, pagination }`).
- **Repositories** exclusively interact with the database using parameterized queries (`$1, $2, ...`).

## 2. Core Security & API Invariants (Do Not Violate)
1. **Zero Client Trust**: All data from `req.body`, `req.query`, `req.params`, `headers` is untrusted. Must validate schemas using Zod before business processing.
2. **RESTful Naming & Versioning**: URLs must be lowercase plural nouns in `kebab-case` with `/api/v1/` prefix. Never use verbs in URLs.
3. **Uniform Response Envelope**: All API responses must follow the standardized `{ success, message, data }` shape. Errors must return `{ success: false, message, errorCode, errors }`.
4. **No Direct Entity Returns**: All database outputs must pass through DTO mappers before being returned to the client.
5. **No SQL Concatenation**: NEVER concatenate strings into SQL queries. Always use `$1`, `$2` parameter placeholders with `node-postgres`.
6. **No Mass Assignment**: Never pass `req.body` directly into database inserts or updates. Whitelist allowed fields via DTOs.
7. **BOLA / IDOR Protection**: When manipulating resources by ID (`/api/v1/items/:id`), always verify in Service/Repository that `item.user_id === req.user.id` unless the user has `ADMIN` role.
8. **No Secrets in Output or Logs**: Never return `password_hash`, `refresh_token`, or secret keys in HTTP responses. Never log passwords or authorization tokens.
9. **Production Error Handling**: Centralized error middleware must catch all unhandled errors. In production, never return stack traces or database errors to the client; respond with a generic `500 Internal Server Error` and log details securely on the server.
10. **Password Hashing**: Use `argon2` or `bcrypt` with salt rounds >= 12. Never store or handle plaintext passwords.
11. **Pagination & Query Caps**: Pagination query must use `?page=1&pageSize=20`. Limit `pageSize` to maximum 100.
12. **Transaction & Concurrency Safety**: Multi-table updates must run in explicit transactions (`BEGIN ... COMMIT / ROLLBACK`). Use row-locking (`SELECT FOR UPDATE`) for inventory/balance mutations.

## 3. Skills Available for Workflows
Consult and run the following skills located in `Skills/` and `.agents/skills/`:
- [`secure-api-scaffolding`](file:///f:/Learning/SEM9-FPTu/backend/Skills/secure-api-scaffolding/SKILL.md): Scaffold new Express modules and middleware pipelines.
- [`api-standard-design-and-dto`](file:///f:/Learning/SEM9-FPTu/backend/Skills/api-standard-design-and-dto/SKILL.md): Build REST endpoints, uniform response envelopes, pagination, and DTO mappers.
- [`auth-rbac-implementation`](file:///f:/Learning/SEM9-FPTu/backend/Skills/auth-rbac-implementation/SKILL.md): Implement secure JWT, Refresh Token rotation, and RBAC / Ownership guards.
- [`secure-database-postgres`](file:///f:/Learning/SEM9-FPTu/backend/Skills/secure-database-postgres/SKILL.md): Setup connection pool, migrations, and parameterized repository pattern.
- [`db-migration-and-concurrency`](file:///f:/Learning/SEM9-FPTu/backend/Skills/db-migration-and-concurrency/SKILL.md): Manage database migrations, constraints, row locking (`SELECT FOR UPDATE`), and Idempotency keys.
- [`caching-and-background-jobs`](file:///f:/Learning/SEM9-FPTu/backend/Skills/caching-and-background-jobs/SKILL.md): Implement Cache-Aside with Redis, cache invalidation, and async queues with BullMQ.
- [`server-lifecycle-and-health`](file:///f:/Learning/SEM9-FPTu/backend/Skills/server-lifecycle-and-health/SKILL.md): Setup /healthz & /readyz probes, graceful shutdown, and Swagger generation via Zod.
- [`secure-file-upload-and-storage`](file:///f:/Learning/SEM9-FPTu/backend/Skills/secure-file-upload-and-storage/SKILL.md): Handle multipart uploads safely with magic bytes, SVG sanitization, and S3 Presigned URLs.
- [`advanced-auth-and-webhooks`](file:///f:/Learning/SEM9-FPTu/backend/Skills/advanced-auth-and-webhooks/SKILL.md): Implement anti-enumeration forgot/reset password flow and timing-safe webhook HMAC verification.
- [`backend-security-audit`](file:///f:/Learning/SEM9-FPTu/backend/Skills/backend-security-audit/SKILL.md): Audit backend code against the 42-point security checklist and OWASP standards.

