# Antigravity Global Rules for Node.js Backend Project

This project implements a Security-by-Design Node.js + Express + PostgreSQL backend.
All AI agent actions, code generation, refactoring, and reviews MUST strictly adhere to the project rules and standards defined below.

Full Specifications & Standards:
- [NODEJS_BACKEND_SECURITY_RULES.md](file:///f:/Learning/SEM9-FPTu/backend/Rules/NODEJS_BACKEND_SECURITY_RULES.md): Security-by-Design and 25 core security rules.
- [BACKEND_API_DEVELOPMENT_RULES.md](file:///f:/Learning/SEM9-FPTu/backend/Rules/BACKEND_API_DEVELOPMENT_RULES.md): REST API design, response envelopes, DTOs, and coding conventions.
- [SESSION_HANDOFF.md](file:///f:/Learning/SEM9-FPTu/backend/SESSION_HANDOFF.md): Current project status and verified handoff context.
- [docs/AGENT_CONTEXT_POLICY.md](file:///f:/Learning/SEM9-FPTu/backend/docs/AGENT_CONTEXT_POLICY.md): Mandatory context update and verification policy for agents.

## 0. Agent Context & Handoff (Mandatory)
- Before starting work, read `SESSION_HANDOFF.md` and the task-relevant BRD/Rules/skill documents.
- After any code, migration, configuration, or test change, update `SESSION_HANDOFF.md` using the policy in `docs/AGENT_CONTEXT_POLICY.md`.
- Record only verified commands/results; do not claim tests passed without current evidence.
- Never write secrets, private keys, tokens, passwords, or real personal data into context files.

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
13. **Zero Plaintext Financial Storage**: All bank accounts must be encrypted with AES-256-GCM (`accountNumberEncrypted`), hashed with SHA-256 for lookup (`accountNumberHash`), and masked for display (`bankAccountMasked`, e.g. `******1234`). Never persist plaintext bank account numbers in database rows, audit logs, or error responses.
14. **Single-Path Automated Payout & Webhook Verification**: Store withdrawals must strictly follow automated PayOS Payout (`POST /api/v1/admin/withdrawals/:id/payout`). Manual transfer route (`/withdrawals/:id/transfer`) is permanently disabled with `MANUAL_TRANSFER_DEPRECATED`. Webhooks must verify timing-safe HMAC (`crypto.timingSafeEqual`) on canonical query strings and raw body buffers.
15. **Multi-Instance Session & Token Revocation**: Logout (`POST /api/v1/auth/logout`) must invalidate Access Tokens via distributed PostgreSQL `revoked_tokens` table + memory blacklist (`iat <= lastLogout`), and revoke Refresh Tokens via `is_revoked = true` in table `refresh_tokens`.
16. **Multi-Role Dashboard & Analytics Invariants**: All analytics endpoints (`/admin/dashboard`, `/analytics/dashboard`, `/customers/me/dashboard`, `/staff/me/dashboard`) must enforce strict BOLA tenant isolation (`item.store_id === req.user.storeId` or `customer.user_id === req.user.userId`). Staff roles are strictly forbidden from accessing store finance metrics (`403 Forbidden`). Realized revenue strictly includes only `DELIVERED`/`COMPLETED` orders; `CANCELLED`/`REJECTED` orders are strictly excluded from GMV and revenue metrics. Cached with Redis Cache-Aside (`DashboardCacheService`, 30s TTL) with graceful in-memory fallback. `AdminController` class-level is strictly guarded by `@Roles('SUPER_ADMIN')`; read-only dashboard & analytics endpoints use method-level `@Roles('SUPER_ADMIN', 'SYSTEM_ADMIN', 'ADMIN')` to prevent privilege escalation into admin mutations (payouts, role changes, store approvals).

## 3. Skills Available for Workflows
Consult and run the following skills located in `.agents/skills/`:
- [`secure-api-scaffolding`](file:///f:/Learning/SEM9-FPTu/backend/.agents/skills/secure-api-scaffolding/SKILL.md): Scaffold new Express modules and middleware pipelines.
- [`api-standard-design-and-dto`](file:///f:/Learning/SEM9-FPTu/backend/.agents/skills/api-standard-design-and-dto/SKILL.md): Build REST endpoints, uniform response envelopes, pagination, and DTO mappers.
- [`auth-rbac-implementation`](file:///f:/Learning/SEM9-FPTu/backend/.agents/skills/auth-rbac-implementation/SKILL.md): Implement secure JWT, Refresh Token rotation, and RBAC / Ownership guards.
- [`secure-database-postgres`](file:///f:/Learning/SEM9-FPTu/backend/.agents/skills/secure-database-postgres/SKILL.md): Setup connection pool, migrations, and parameterized repository pattern.
- [`db-migration-and-concurrency`](file:///f:/Learning/SEM9-FPTu/backend/.agents/skills/db-migration-and-concurrency/SKILL.md): Manage database migrations, constraints, row locking (`SELECT FOR UPDATE`), and Idempotency keys.
- [`caching-and-background-jobs`](file:///f:/Learning/SEM9-FPTu/backend/.agents/skills/caching-and-background-jobs/SKILL.md): Implement Cache-Aside with Redis, cache invalidation, and async queues with BullMQ.
- [`server-lifecycle-and-health`](file:///f:/Learning/SEM9-FPTu/backend/.agents/skills/server-lifecycle-and-health/SKILL.md): Setup /healthz & /readyz probes, graceful shutdown, and Swagger generation via Zod.
- [`secure-file-upload-and-storage`](file:///f:/Learning/SEM9-FPTu/backend/.agents/skills/secure-file-upload-and-storage/SKILL.md): Handle multipart uploads safely with magic bytes, SVG sanitization, and S3 Presigned URLs.
- [`advanced-auth-and-webhooks`](file:///f:/Learning/SEM9-FPTu/backend/.agents/skills/advanced-auth-and-webhooks/SKILL.md): Implement anti-enumeration forgot/reset password flow and timing-safe webhook HMAC verification.
- [`backend-security-audit`](file:///f:/Learning/SEM9-FPTu/backend/.agents/skills/backend-security-audit/SKILL.md): Audit backend code against the 42-point security checklist and OWASP standards.
- [`security-audit`](file:///f:/Learning/SEM9-FPTu/backend/.agents/skills/cloudflare-security-audit/SKILL.md): Cloudflare Security Audit skill for vulnerability review, API protocol safety, and pen-testing.
