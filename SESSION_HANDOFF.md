# Project Handoff & Session Context

> **Agent continuity:** Follow [`docs/AGENT_CONTEXT_POLICY.md`](file:///f:/Learning/SEM9-FPTu/backend/docs/AGENT_CONTEXT_POLICY.md) when reading or updating this handoff. This file must contain verified project state only and must never contain secrets.

> **Project:** Sem 9 FPTu - IoT Amazon Button Backend E-Commerce Platform  
> **Tech Stack:** NestJS 10, TypeScript 5, PostgreSQL 15 (with custom Stored Procedures, Triggers & Row Locking), Prisma ORM, Redis (BullMQ), Cloudinary, PayOS  
> **Status:** Verified clean build (`npm run build`), TypeScript compilation (`npx tsc --noEmit`), Prisma 33 migrations up-to-date (`npx prisma migrate status`), and full Multi-Role Analytics & Dashboard Architecture verified across Unit & E2E suites (Suite 44 Analytics E2E: **87/87** passing; Suite 43 Analytics Unit: 30/30 passing; Suite 41 Security Unit: 41/41 passing; Suite 31 Store Wallet & Withdrawals: 6/6 passing). All P0/P1 items resolved: SYSTEM_ADMIN bypass removed from RolesGuard; RBAC matrix verified (8 combinations); AdminController read-only routes (`GET withdrawals`, `GET withdrawals/:id`, and analytics/dashboards) decorated with `@Roles('SUPER_ADMIN', 'SYSTEM_ADMIN', 'ADMIN')` while financial and system mutations remain strictly `@Roles('SUPER_ADMIN')`; Customer dashboard SQL query in `CustomersRepository` hardened with `NULL::text AS logo_url` preventing column missing crashes on stores without logo; cache invalidation pipeline fully hardened across Devices (all 12 mutations, incl. owner customer userId + remap dual-store), Rentals (customer.userId for all 5 mutations without customerId fallback), Wallet (requestWithdrawal/refund/processPayoutWebhook/syncPayoutStatus post-commit invalidation), Admin (toggleUserStatus/updateUserRole/payoutFailureCatch); exact key invalidation (`customer:dashboard` and drill-downs) preventing prefix collisions; canonical order statuses enforced with zero legacy references; Suite 44 Section 9 (34 assertions) verifies pipeline tenant isolation, exact key safety, and resilience to cache errors. Production release approved and deployed by Tris.
---

## 1. Quick Verification Commands
- Check TypeScript types: `npx tsc --noEmit`
- Production Build: `npm run build`
- Start Dev Server: `npm run dev` (running `nest start --watch`, port 3000)
- Run All Tests (44 suites master runner): `npm run test:all` or `npx tsx tests/run_all_suites.ts`
- Individual Suite Commands:
  - Suite 1 (Firebase Phone Auth): `npx tsx tests/firebase-phone-auth.spec.ts`
  - Suite 2 (FCM Notifications): `npx tsx tests/notifications-fcm.spec.ts`
  - Suite 3 (Order Lifecycle & Cancel Window): `npx tsx tests/order-lifecycle.spec.ts`
  - Suite 4 (IoT Device Config & Mapping): `npx tsx tests/device-config-product-mapping.test.ts`
  - Suite 5 (Zero-Touch Provisioning): `npx tsx tests/zero-touch-provisioning.test.ts`
  - Suite 6 (E2E Device Lifecycle v4.0): `npx tsx tests/e2e-zero-touch-lifecycle.test.ts`
  - Suite 7 (Multi-Vendor Marketplace & Escrow): `npx tsx tests/e2e-marketplace-ecosystem.spec.ts`
  - Suite 8 (Security Audit 8 Criteria Verifier): `node tests/verify_all_8_audit_fixes.js`
  - Suite 9 (Smart Order Button API): `npx tsx tests/api.test.ts`
  - Suite 10 (User Avatar URL & Profile): `npx tsx tests/user-avatar-profile.spec.ts`
  - Suite 11 (Order Minimum Value Constraint): `npx tsx tests/order-minimum-value.spec.ts`
  - Suite 12 (Didit eKYC Identity Verification): `npx tsx tests/identity-verification-didit.spec.ts`
  - Suite 13 (Penny-Deposit Bank Verification): `npx tsx tests/bank-account-verification.spec.ts`
  - Suite 14 (Device Templates & Bulk Deploy): `npx tsx tests/device-templates-bulk-deploy.spec.ts`
  - Suite 15 (Frontend Contract & Notifications): `npx tsx tests/frontend-contract-and-notifications.spec.ts`
  - Suite 16 (Withdrawal Concurrency & Payout Engine): `npx tsx tests/withdrawal-concurrency-idempotency.spec.ts`
  - Suite 17 (Storefront Checkout 6-Layer Architecture): `npx tsx tests/storefront-checkout-refactor.spec.ts`
  - Suite 18 (Inventory Concurrency & Row-Level Locking): `npx tsx tests/inventory-concurrency-race.spec.ts`
  - Suite 19 (Product DTO & Category Ownership Boundary): `npx tsx tests/product-contract-validation.spec.ts`
  - Suite 20 (Canonical Pagination Envelope & Limit Caps): `npx tsx tests/canonical-pagination-envelope.spec.ts`
  - Suite 21 (Customer Addresses CRUD & Default Management): `npx tsx tests/customer-addresses-crud.spec.ts`
  - Suite 22 (Category Hierarchy & Graph Cycle Detection): `npx tsx tests/categories-management.spec.ts`
  - Suite 23 (Product Discounts CRUD & Time Window Exclusivity): `npx tsx tests/product-discounts-crud.spec.ts`
  - Suite 24 (Order Filter, Date Range & Status Timeline): `npx tsx tests/order-filter-and-timeline.spec.ts`
  - Suite 25 (Store Self-Management & Profile Update): `npx tsx tests/store-self-management.spec.ts`
  - Suite 26 (Store Staff Management & Anti-Role-Escalation): `npx tsx tests/store-staff-management.spec.ts`
  - Suite 27 (Store Subscription Public Catalog & History): `npx tsx tests/subscription-catalog-history.spec.ts`
  - Suite 28 (Bank Account Verification Polling): `npx tsx tests/bank-verification-polling.spec.ts`
  - Suite 29 (Button Rental Payment Linking & Lifecycle Expansion): `npx tsx tests/rentals-lifecycle-e2e.spec.ts`
  - Suite 30 (Product Price History & Inventory Read Views): `npx tsx tests/products-price-history-inventory.spec.ts`
  - Suite 31 (Store Wallet & Withdrawal Pagination & Details): `npx tsx tests/store-wallet.spec.ts`
  - Suite 32 (Driver Shifts Monitoring & Delivery Summary): `npx tsx tests/store-driver-shifts.spec.ts`
  - Suite 33 (Store-Customer Relationship CRM Module): `npx tsx tests/store-customer-crm.spec.ts`
  - Suite 34 (Analytics Date Range & Grouping Filters): `npx tsx tests/store-analytics-filters.spec.ts`
  - Suite 35 (P0 Security, Payout Refund & Concurrency Invariants): `npx tsx tests/p0-security-and-concurrency.spec.ts`
  - Suite 36 (Phase 1 Database Transactions & Concurrency Invariants): `npx tsx tests/phase1-transactions-concurrency.spec.ts`
  - Suite 37 (Phase 2 Universal Idempotency Platform): `npx tsx tests/phase2-idempotency-platform.spec.ts`
  - Suite 38 (Phase 3 Asynchronous Queues, Backoff Retry & DLQ): `npx tsx tests/phase3-queues-retry-dlq.spec.ts`
  - Suite 39 (Phase 4 Database Index & Query Optimization): `npx tsx tests/phase4-index-query-optimization.spec.ts`
  - Suite 40 (Phase 5 Health Probes & Graceful Shutdown): `npx tsx tests/phase5-graceful-shutdown-health.spec.ts`
  - Suite 41 (Superpowers Security Unit & Isolation): `npx tsx tests/superpower-security-unit.spec.ts`
  - Suite 42 (Superpowers Security Verification & Hardening): `npx tsx tests/superpower-security-verification.spec.ts`
  - Suite 43 (Analytics Financial Matrix & Database Aggregation): `npx tsx tests/analytics-foundation-unit.spec.ts`
  - Suite 44 (Multi-Role Analytics & Dashboard E2E): `npx tsx tests/analytics-dashboard-e2e.spec.ts`
- Live Render Production Master Suite (148/148 passing across all 36 domains): `npx tsx tests/render_live_all_apis_suite.ts`
- Live Render Performance & Load Benchmark (P50/P90/P95/P99 SLA, 44.5 RPS, 429 Defense): `npx tsx tests/render_live_performance_benchmark.ts`
- Live Render 500-1000 High-Load Stress Suite (38.7 RPS @ 500 reqs, 1000-req Rate Limit Quota Enforced): `npx tsx tests/render_live_high_load_stress.ts`

---

## 2. Completed Work & Verified Changes

### A. User Avatar URL Feature
1. **Database Migration:**
   - Migration: [`prisma/migrations/20261020130000_add_user_avatar_url`](file:///f:/Learning/SEM9-FPTu/backend/prisma/migrations/20261020130000_add_user_avatar_url)
   - Column `avatar_url VARCHAR(512)` nullable in PostgreSQL table `users`.
2. **DTO & Security:**
   - [`src/auth/dto/update-profile.dto.ts`](file:///f:/Learning/SEM9-FPTu/backend/src/auth/dto/update-profile.dto.ts): `UpdateProfileDto` validates `avatarUrl` with `@IsUrl({ require_tld: false })`, length `<= 512`, protocol whitelist (`http://`, `https://`), strict XSS prevention (`javascript:` blocked).
   - Authenticated `userId` is strictly extracted from verified JWT (`req.user.id`). No mass assignment of `role`, `email`, or `id`.
3. **Endpoints & Auth Sync:**
   - `PATCH /api/v1/auth/me` and `PATCH /api/v1/auth/profile` update avatar.
   - `googleLogin()` in [`src/auth/auth.service.ts`](file:///f:/Learning/SEM9-FPTu/backend/src/auth/auth.service.ts) extracts `avatar_url` or `picture` from Google metadata into `createGoogleUserTx()`.
   - `GET /api/v1/auth/me`, login, and JWT payloads include `avatarUrl`.
4. **Test Suite:**
   - [`tests/user-avatar-profile.spec.ts`](file:///f:/Learning/SEM9-FPTu/backend/tests/user-avatar-profile.spec.ts) (25/25 PASS).

---

### B. Enforce Minimum Order Total (>= 2,000 VND)
1. **Business Invariant:**
   - Total order amount (`subtotalAmount + shippingFee - discountAmount`) MUST be `>= 2,000 VND`.
   - If `< 2,000 VND`, rejects order with HTTP 400 Bad Request, `errorCode: ORDER_TOTAL_BELOW_MINIMUM`, `message: 'Giá trị đơn hàng tối thiểu là 2.000 VND'`.
2. **Database Stored Procedure:**
   - Migration: [`prisma/migrations/20261020150000_enforce_minimum_order_total`](file:///f:/Learning/SEM9-FPTu/backend/prisma/migrations/20261020150000_enforce_minimum_order_total)
   - Updated `sp_create_order_from_button`: validates `v_total < 2000` and raises exception `USING ERRCODE = 'P0010'`.
3. **Repository Fallback Transaction:**
   - In [`src/orders/orders.repository.ts`](file:///f:/Learning/SEM9-FPTu/backend/src/orders/orders.repository.ts): `createOrderFallbackTx()` fetches current database product price, calculates total, and checks `total < MINIMUM_ORDER_TOTAL_VND` (2000). Throws `BadRequestException` with `ORDER_TOTAL_BELOW_MINIMUM`.
   - Constant defined in [`src/orders/orders.constants.ts`](file:///f:/Learning/SEM9-FPTu/backend/src/orders/orders.constants.ts).
4. **Test Suite:**
   - [`tests/order-minimum-value.spec.ts`](file:///f:/Learning/SEM9-FPTu/backend/tests/order-minimum-value.spec.ts) (15/15 PASS).

---

### C. Runtime & Test Suite Stabilizations
1. **Swagger Crash Guard:**
   - Handled parameter reflection bug in `@nestjs/swagger` inside [`src/main.ts`](file:///f:/Learning/SEM9-FPTu/backend/src/main.ts) with try/catch to ensure dev server always boots cleanly.
2. **MediaController Dependency Injection:**
   - Fixed Cloudinary presigned URL injection in [`src/media/media.controller.ts`](file:///f:/Learning/SEM9-FPTu/backend/src/media/media.controller.ts) using explicit `@Inject(CloudinaryService)`.
3. **Suite 4 State Isolation:**
   - In [`tests/device-config-product-mapping.test.ts`](file:///f:/Learning/SEM9-FPTu/backend/tests/device-config-product-mapping.test.ts), used unique randomized MAC addresses to prevent collisions during batch test runs.
4. **Global Test Runner:**
   - [`npm run test:all`](file:///f:/Learning/SEM9-FPTu/backend/package.json): Runs 11 test suites sequentially with zero residue cleanup. All 11/11 PASS.

---

### O. Distributed Session Management & Token Revocation Architecture
1. **Multi-Instance Access Token Revocation (`POST /api/v1/auth/logout`):**
   - Extracts Bearer token from incoming `Authorization` header.
   - Computes SHA-256 hash (`crypto.createHash('sha256').update(token).digest('hex')`).
   - Persists into PostgreSQL `revoked_tokens` table with token expiration timestamp (`expires_at`), ensuring immediate synchronization across all cluster instances and Render containers.
   - Synchronizes into local high-speed in-memory `TokenBlacklist` cache with automated TTL eviction to minimize database lookups.
2. **User-Wide Epoch Invalidation (`last_logout_at`):**
   - Updates `users.last_logout_at = new Date()` upon logout.
   - `JwtStrategy` validates `iat > user.last_logout_at`. Any token issued at or before logout timestamp (`iat <= lastLogout`) is immediately rejected with HTTP 401 Unauthorized.
3. **Cascading Refresh Token Revocation:**
   - Marks the target refresh token as `is_revoked = true` in PostgreSQL table `refresh_tokens`.
   - Global logout executes `authRepo.revokeAllUserRefreshTokens(userId)` to invalidate all active refresh tokens for the account.
4. **Push Notification Cleanup:**
   - Calls `authRepo.deactivateUserFcmTokens(userId, fcmToken)` to deactivate FCM device registration tokens, preventing sensitive push notifications from leaking to shared or public devices after logout.

---

## 3. Key Modified & Created Files
- `src/main.ts`: Swagger crash guard, 10KB body limit, 1MB webhook body limit, security middleware.
- `src/auth/*`: Distributed logout, SHA-256 token revocation (`revoked_tokens`), in-memory `TokenBlacklist`, `last_logout_at` timestamp guard, Firebase phone-first authentication, Avatar URL & profile management.
- `src/store-wallet/*`: On-the-fly RAM decryption for outbound PayOS API calls, strict DTO masking via [`src/store-wallet/mappers/wallet.mapper.ts`](file:///f:/Learning/SEM9-FPTu/backend/src/store-wallet/mappers/wallet.mapper.ts), frozen balance reservation.
- `src/admin/*`: Lockdown of manual transfer (`POST /api/v1/admin/withdrawals/:id/transfer` -> `MANUAL_TRANSFER_DEPRECATED`), automated PayOS payout orchestration.
- `src/payments/*`: Canonical query-string deep-sorted HMAC-SHA256 verification in `payout-webhook.controller.ts`, dedicated production payout credentials in `payos-payout.service.ts`.
- `src/bank-verification/*`: 2,000 VND penny-deposit ownership verification, VietQR lookup, dynamic refund, zero vendor error leaks.
- `src/identity-verifications/*`: Didit eKYC webhook integration, OCR sanitization, atomic row-locking transactions.
- `src/orders/*`: 60s cancellation window, minimum order total (>= 2,000 VND) stored procedure and fallback transaction.
- `prisma/migrations/*`:
  - `20261024210000_nullify_plaintext_bank_accounts`: Complete nullification of legacy plaintext bank accounts.
  - `20261024170000_standardize_bank_account_and_withdrawal`: Encrypted snapshots, hashes, and masks.
  - `20261021230000_make_user_email_password_nullable_phone_unique`: Phone-first registration.
  - `20261020150000_enforce_minimum_order_total`: Minimum 2,000 VND stored procedure.
  - `20261020130000_add_user_avatar_url`: Avatar URL support.
- `.github/workflows/ci-cd.yml`: 3-layer enterprise CI/CD with isolated Postgres & Redis service containers, test runner execution, and Render deploy health check.
- `tests/*`: 16 comprehensive integration and E2E test suites with zero-residue teardown.

---

## 4. Instructions for Resuming in a New Chat
When starting a new conversation, prompt the agent with:
> `@SESSION_HANDOFF.md Đọc tài liệu handoff này để nắm toàn bộ tiến độ dự án, sau đó tiếp tục công việc...`

---
### [2026-10-25] Production Hardening: Zero Plaintext Bank Account, Manual Transfer Decommissioning, Canonical Webhook Verification & Distributed Session Revocation
- Status: COMPLETED
- Changes:
  1. Zero Plaintext Bank Account Storage:
     - Migration `20261024210000_nullify_plaintext_bank_accounts` nullifies legacy plaintext `bank_account_number` across `store_withdrawals` and `store_wallets`.
     - Ephemeral RAM decryption in `StoreWalletService.triggerPayosPayout` and `AdminService.executePayOSPayout` ensures plaintext account numbers exist only during the HTTP call to PayOS.
     - Implemented `WalletMapper` (`src/store-wallet/mappers/wallet.mapper.ts`) across all store wallet and admin withdrawal controllers to return strictly masked accounts (`bankAccountMasked`, e.g. `******9999`).
  2. Decommissioning Manual Transfer Route:
     - `POST /api/v1/admin/withdrawals/:id/transfer` locked down and throws HTTP 400 with `errorCode: MANUAL_TRANSFER_DEPRECATED`.
     - Single automated route `POST /api/v1/admin/withdrawals/:id/payout` enforced.
  3. Canonical Payout Webhook Verification:
     - Deep-sorted alphabetical query string HMAC-SHA256 (`crypto.timingSafeEqual`) in `PayoutWebhookController` with raw body buffer fallback.
  4. Distributed Session Management & Token Revocation:
     - `POST /api/v1/auth/logout` revokes access tokens via SHA-256 in PostgreSQL table `revoked_tokens` and in-memory `TokenBlacklist`.
     - Timestamp guard in `JwtStrategy` rejects any token where `iat <= last_logout_at`.
     - Cascading revocation of refresh tokens (`is_revoked = true`) and FCM push notification tokens.
  5. Test Verification:
     - Expanded `tests/withdrawal-concurrency-idempotency.spec.ts` with assertions 4.5 through 4.8.
     - Corrected assertion 5.2 in `tests/bank-account-verification.spec.ts` to assert `bankAccountNumber === null`.
     - Updated `tests/e2e-marketplace-ecosystem.spec.ts` for automated payout and manual transfer deprecation.
     - Master suite `tests/run_all_suites.ts` (16/16 suites) verified PASS.
- Files:
  - `src/store-wallet/mappers/wallet.mapper.ts`
  - `src/store-wallet/store-wallet.service.ts`
  - `src/store-wallet/store-wallet.controller.ts`
  - `src/admin/admin.controller.ts`
  - `src/admin/admin.service.ts`
  - `src/payments/payout-webhook.controller.ts`
  - `src/payments/payos-payout.service.ts`
  - `prisma/migrations/20261024210000_nullify_plaintext_bank_accounts/migration.sql`
  - `.github/workflows/ci-cd.yml`
  - `tests/bank-account-verification.spec.ts`
  - `tests/withdrawal-concurrency-idempotency.spec.ts`
  - `tests/e2e-marketplace-ecosystem.spec.ts`
  - `AGENTS.md`
  - `docs/AGENT_CONTEXT_POLICY.md`
  - `SESSION_HANDOFF.md`
- Verification:
  - `npx tsc --noEmit` — PASS (0 errors)
  - `npm run build` — PASS (0 errors)
  - `npx tsx tests/bank-account-verification.spec.ts` — PASS (39/39 tests)
  - `npx tsx tests/withdrawal-concurrency-idempotency.spec.ts` — PASS (16/16 tests)
  - `npx tsx tests/e2e-marketplace-ecosystem.spec.ts` — PASS (14/14 tests)

### [2026-10-24] Bank Account Verification (2.000 VND), Store Withdrawal Payout & CI/CD Pipeline
- Status: COMPLETED
- Changes:
  1. Enterprise 3-Layer CI/CD (.github/workflows/ci-cd.yml):
     - Job 1: `quality-and-build` (Prisma generate, Typecheck, Build with 2GB heap).
     - Job 2: `database-and-tests` (Isolated postgres:15 & redis:7 service containers, extensions schema init, fresh migrations, wait-on healthz, runs npm run test:all).
     - Job 3: `deploy-production` (Fail-closed check on RENDER_DEPLOY_HOOK_URL, triggers Render Deploy Hook, polls /healthz for up to 300s).
  2. Safe 2-Phase Database Migration (20261024170000_standardize_bank_account_and_withdrawal):
     - Upgraded `StoreWithdrawal` with `bankAccountId`, AES-256-GCM encrypted snapshot columns (`bankAccountEncrypted`, `bankAccountHash`, `bankAccountMasked`, `bankAccountNameSnapshot`, `bankBinSnapshot`, `bankNameSnapshot`). Retained legacy plaintext `bank_account_number` as nullable/deprecated.
     - Backfilled all 16 existing records via `scripts/backfill_and_verify_withdrawal_snapshots.js` with 100% round-trip decryption verification.
  3. Hardened Bank Lookup:
     - Enforced 4000ms timeout on VietQR provider fetch, strict `errorCode: BANK_LOOKUP_UNAVAILABLE`, zero user name fallback, account number masking in logs.
  4. 2,000 VND Penny-Deposit Ownership Verification:
     - Gated `OWNERSHIP_VERIFIED` strictly on matching penny deposit. Deprecated arbitrary account update on `PUT /api/v1/store/wallet/bank-account`.
  5. Frozen Balance & Concurrency Defense:
     - Invariant strictly enforced: `balance -= amount`, `frozenBalance += amount` on withdrawal creation with `SELECT FOR UPDATE`.
     - On Payout `SUCCEEDED`: `frozenBalance -= amount` (balance is never re-credited).
     - On Payout `FAILED`: `frozenBalance -= amount`, `balance += amount` (exact 1x refund with `WITHDRAWAL_REFUND` ledger).
  6. Single-Path PayOS Payout & Payout Webhook:
     - Admin route `POST /api/v1/admin/withdrawals/:id/payout` with atomic `PENDING -> PROCESSING` claim and fail-closed refund on provider failure.
     - Webhook endpoint `POST /api/v1/webhooks/payos/payout` in `src/payments/payout-webhook.controller.ts` with timing-safe HMAC-SHA256 (`crypto.timingSafeEqual`) using `PAYOS_PAYOUT_CHECKSUM_KEY`, replay idempotency, and monotonic terminal state protection.
  7. Route Decommissioning & Zero Leakage:
     - Marked `POST /api/v1/admin/withdrawals/:id/transfer` as `@deprecated`.
     - Completely removed full account digits from `wallet_transactions.description`.
- Files:
  - `.github/workflows/ci-cd.yml`
  - `prisma/schema.prisma`
  - `prisma/migrations/20261024170000_standardize_bank_account_and_withdrawal/`
  - `scripts/backfill_and_verify_withdrawal_snapshots.js`
  - `scripts/backfill_and_verify_withdrawal_snapshots.ts`
  - `scripts/start-prod.js`
  - `src/bank-verification/bank-verification.service.ts`
  - `src/bank-verification/providers/payos-bank-verification.provider.ts`
  - `src/store-wallet/store-wallet.service.ts`
  - `src/admin/admin.controller.ts`
  - `src/admin/admin.repository.ts`
  - `src/payments/payout-webhook.controller.ts`
  - `src/payments/payments.module.ts`
  - `tests/withdrawal-concurrency-idempotency.spec.ts`
  - `tests/bank-account-verification.spec.ts`
  - `tests/run_all_suites.ts`
- Verification:
  - `npx tsc --noEmit` — PASS (0 errors)
  - `npm run build` — PASS (0 errors)
  - `npx tsx tests/bank-account-verification.spec.ts` — PASS (39/39 tests)
  - `npx tsx tests/withdrawal-concurrency-idempotency.spec.ts` — PASS (12/12 tests)

### [2026-10-20] User Avatar URL & Order Minimum Value Enforcement
- Status: COMPLETED
- Changes:
  1. User Avatar URL: DB migration `avatar_url VARCHAR(512)` nullable, DTO URL validation & anti-XSS whitelist, PATCH /auth/me & PATCH /auth/profile, Google OAuth metadata sync, GET /auth/me & JWT sync.
  2. Order Minimum Total: Stored procedure `sp_create_order_from_button` error P0010 (< 2000 VND), Fallback transaction in `OrdersRepository` with 400 ORDER_TOTAL_BELOW_MINIMUM.
  3. Stability: Swagger reflection crash guard in `src/main.ts`, explicit `@Inject(CloudinaryService)` in `MediaController`, isolated randomized MAC in test suite 4, cleaned all temporary debug logs.
- Files:
  - `prisma/migrations/20261020130000_add_user_avatar_url/`
  - `prisma/migrations/20261020150000_enforce_minimum_order_total/`
  - `src/auth/dto/update-profile.dto.ts`
  - `src/auth/auth.service.ts`
  - `src/auth/auth.controller.ts`
  - `src/auth/auth.repository.ts`
  - `src/orders/orders.repository.ts`
  - `src/orders/orders.constants.ts`
  - `src/main.ts`
  - `src/media/media.controller.ts`
  - `tests/order-minimum-value.spec.ts`
  - `tests/user-avatar-profile.spec.ts`
- Verification:
  - `npx tsc --noEmit` — PASS (0 errors)
  - `npm run build` — PASS (0 errors)
  - `npm run test:all` — PASS (11/11 suites, 237.9s)
- Remaining: None
- Next: Didit eKYC Identity Verification Module.

### [2026-10-21] Didit eKYC Identity Verification Module (Hardened, Unified Atomic Transaction & Row Locking)
- Status: COMPLETED (Integration Tests 47/47 PASS)
- Hardening & Security Fixes:
  1. Sanitized Vendor Error Logging: In `didit-client.service.ts`, removed all logging of `JSON.stringify(responseData)`. Now logs strictly `[DiditClient] ${endpointName} failed with HTTP ${response.status}`. Vendor response body is completely omitted from logs and generic error envelopes to prevent secret leaks (e.g. `secret_dump`).
  2. Fail-Closed Raw Webhook Body: In `didit-webhook.guard.ts` and `didit-webhook.controller.ts`, removed any fallback `Buffer.from(JSON.stringify(req.body))`. If `!Buffer.isBuffer(rawBody)`, immediately throws `UnauthorizedException('Thiếu raw body webhook hợp lệ, không thể xác thực HMAC')`.
  3. Unified Atomic Webhook Transaction (`executeAtomicWebhookTransaction`):
     - Encapsulated the entire flow within a single PostgreSQL `BEGIN ... COMMIT` block.
     - If any mutation fails, the entire transaction rolls back, including the webhook event record, ensuring retries from Didit are never locked out.
  4. Row-Level Locks (`SELECT FOR UPDATE`) on Session & User:
     - When a webhook arrives for a session, `identity_verification_sessions` is queried with `FOR UPDATE`, and the corresponding `users` record is also queried with `FOR UPDATE`.
     - Serializes concurrent conflicting webhooks (e.g. simultaneous `Approved` and `Declined`), guaranteeing that the `APPROVED` terminal state is never overwritten or downgraded by race conditions.
  5. Dual-Constraint Idempotency (`payload_hash` AND `event_id`):
     - Leverages PostgreSQL's `INSERT INTO didit_webhook_events (...) VALUES (...) ON CONFLICT DO NOTHING RETURNING id` without target column specification to intercept conflicts across BOTH unique indexes (`event_id` and `payload_hash`).
     - Tested and verified: duplicate hash returns 0 rows, and replay with same event ID but mutated payload also returns 0 rows.
  6. Test Verification: Expanded `tests/identity-verification-didit.spec.ts` to 47 assertions (47/47 PASS), adding tests for `event_id` replay rejection and concurrent `Approved` vs `Declined` row-lock resolution.
- Verification Evidence:
  - `npx tsx tests/identity-verification-didit.spec.ts` — PASS (47/47 assertions pass)
  - `npx tsx tests/verify-didit-live-e2e.ts` — PASS (29/29 live assertions pass, including direct ngrok tunnel forwarding)
  - `npx tsc --noEmit` — PASS (0 errors)
  - `npm run build` — PASS (0 errors)
- Live ngrok Tunnel & Provider Status:
  - Tunnel: `https://john-antiquely-scoop.ngrok-free.dev -> http://localhost:3000` (ALIVE)
  - Live E2E tests verified: Mobile session creation (HTTP 201), session retrieval (HTTP 200), HMAC-SHA256 signature verification over ngrok, OCR sanitization, duplicate replay prevention, and PostgreSQL row persistence.
  - Final live verification: Didit Console destination `https://john-antiquely-scoop.ngrok-free.dev/api/v1/webhooks/didit` can be triggered via "Try Webhook".
- Git History & Branch State (Crucial for Agent Continuity):
  - `origin/main` was reset back to clean commit `73c1b4a` (`fix(tests): synchronize stale test contracts, fcm isolation, and master test runner`).
  - 5 previously faulty remote commits were stripped (`cc91427`, `fcc7db8`, `b15cd7e`, `c8bfd21`, `5f734a6`) and backed up to branch `backup/remote-agent-commits-20261021`.
  - PUSHED TO ORIGIN MAIN: Commit `155102f` (`feat(kyc,orders,auth): implement hardened Didit eKYC, order minimum total, avatar URL, and agent context policies`) pushed cleanly to `origin/main`.
  - Local `main` is completely in sync with `origin/main`.
  - Zero secrets or `.env` files committed.
- Next Steps:
  - Proceed with mobile app integration using endpoint `/api/v1/identity-verifications/sessions`.

### [2026-10-21] Firebase Phone-First Registration & Authentication Hardening
- Status: COMPLETED (Integration Tests 45/45 PASS, Master Suite 12/12 PASS)
- Features & Hardening Implemented:
  1. Database Migration:
     - Migration `prisma/migrations/20261021230000_make_user_email_password_nullable_phone_unique`.
     - Relaxed `email` and `password_hash` to nullable columns for phone-first registration.
     - Enforced unique index `uq_users_phone` on `users(phone)`.
  2. Contract & DTOs:
     - `RegisterByPhoneDto` (`src/auth/dto/register-by-phone.dto.ts`): validates `firebaseIdToken`, `fullName`, optional `email`, and restricts role whitelist strictly to `CUSTOMER` (rejects `ADMIN`, `STORE_OWNER`).
     - `LoginByPhoneDto` (`src/auth/dto/login-by-phone.dto.ts`): validates `firebaseIdToken` for logging into existing phone accounts.
  3. Reusable Firebase Token Verification:
     - Refactored `FirebasePhoneService.verifyFirebasePhoneToken(firebaseIdToken)` to independently verify signature, revocation, phone provider, phone number claim, and project ID without requiring `userId`.
     - Reused across both `/auth/phone/verify` (account linking) and `/auth/register-by-phone` (user creation) and `/auth/login-by-phone` (user authentication).
  4. Atomic Transaction & Concurrency Invariants:
     - Implemented `AuthRepository.registerByPhoneTx()` wrapping `users`, `customer_profile`, and `refresh_tokens` creation in an atomic transaction.
     - Intercepts duplicate conflicts (`P2002`) on `phone`, `firebase_uid`, or `email` and safely translates to HTTP 409 Conflict without leaking database internals.
     - Verified with concurrent parallel requests: exactly 1 wins and creates the account, while conflicting requests receive 409 Conflict.
  5. Public Endpoints & Rate Limiting:
     - `POST /api/v1/auth/register-by-phone` protected with `AuthRateLimitGuard`.
     - `POST /api/v1/auth/login-by-phone` protected with `AuthRateLimitGuard`.
     - Standard uniform response envelope with zero leaks of passwordHash, refreshTokenHash, or raw Firebase secrets.
- Verification Evidence:
  - `npx tsx tests/firebase-phone-auth.spec.ts` — PASS (45/45 assertions pass)
  - `npm run test:all` — PASS (12/12 suites pass, 255.8s)
  - `npx tsc --noEmit` — PASS (0 errors)
  - `npm run build` — PASS (0 errors)

### [2026-10-22] Penny-Deposit Bank Account Verification (2.000 VND) & Automated Refund Hardening
- Status: COMPLETED & HARDENED (Integration Tests 25/25 PASS, Master Suite 13/13 PASS)
- 9 Security Review Points & Functional Gaps Resolved:
  1. **Fail-Closed on Missing Payout Provider (High 1):**
     - In `PayOSBankVerificationProvider.createRefund`: throws `ServiceUnavailableException('Payout provider is not configured')` if `payosPayoutService` is unavailable and `BANK_VERIFICATION_MOCK !== 'true'`. Never auto-mocks in production or staging.
  2. **Fail-Closed Missing Webhook Transaction ID (High 2):**
     - In `BankVerificationService.handleVerificationWebhook`: strictly throws `BadRequestException('Missing provider transaction ID')` if `providerTransactionId` is omitted. Banned dummy random ID generation (`txn_${Date.now()}...`) to guarantee robust replay defense.
  3. **Webhook Sender & Platform Destination Account Cross-Check (High 3):**
     - In `BankVerificationRepository.executeAtomicWebhookVerificationTx`: cross-verifies `destinationAccountNumber` against platform account (`PLATFORM_BANK_ACCOUNT_NUMBER` if set) and `senderAccountNumber` against decrypted store bank account (`account_number_encrypted`). Mismatches are rejected with `SENDER_ACCOUNT_MISMATCH` or `DESTINATION_ACCOUNT_MISMATCH`.
  4. **Client Zero-Trust on Bank & Account Metadata (High 4):**
     - In `CreateVerificationRequestDto`: client is only permitted to submit `storeId`, `bankBin`, and `accountNumber`. Client inputs for `accountName`, `bankName`, or `bankCode` are rejected / ignored. Server fetches bank metadata from `VIETNAM_BANKS` constant and always invokes provider lookup for `accountName`.
  5. **Role-Based Bank Account Management (High 5):**
     - In `verifyStoreOwnership`: allows ONLY `store.ownerUserId === userId` or global `ADMIN`. Active store staff (`StoreStaff`) is strictly blocked with `ForbiddenException` (403 Forbidden) from adding, verifying, setting default, or deleting bank accounts.
  6. **Dynamic Expected Refund Amount (Medium 6):**
     - `triggerAutomatedRefund` takes `expected_amount` directly from the locked verification transaction in PostgreSQL. Eliminated hardcoded 2,000 VND; refunds dynamically mirror whatever amount was required and received.
  7. **Strict Environment Mock Boundary (Medium 7):**
     - Account lookup and payout simulation are restricted strictly to `BANK_VERIFICATION_MOCK === 'true'`. Generic `NODE_ENV !== 'production'` fallback is prohibited to avoid mock pollution in staging environments.
  8. **Strict storeId Validation (Medium 8):**
     - `CreateVerificationRequestDto.storeId` validated with `@IsString()` and `@Matches(/^[1-9]\d*$/)` to prevent BigInt casting 500 runtime crashes.
  9. **Vendor Error Log Sanitization (Medium 9 & Risk 3):**
     - Sanitized all error logging in `BankVerificationService`, `BankVerificationRepository`, and `PayOSBankVerificationProvider`: logs operation, provider name, HTTP status, and internal verificationId without leaking raw payloads, vendor credentials, transaction descriptions, or sensitive account numbers.
  10. **Fail-Closed Webhook Account Cross-Verification (Risk 1):**
     - In `BankVerificationRepository.executeAtomicWebhookVerificationTx`: in production (`NODE_ENV === 'production'`) or strict mode (`BANK_VERIFICATION_STRICT === 'true'`), missing `destinationAccountNumber` or platform account strictly fails closed with `DESTINATION_ACCOUNT_UNVERIFIABLE`. Missing `senderAccountNumber` strictly fails closed with `SENDER_ACCOUNT_UNVERIFIABLE`.
  11. **Provider Transaction ID Disambiguation (Risk 2):**
     - In `BankVerificationService.handleVerificationWebhook`: rejected `paymentLinkId` and `orderCode` fallbacks. Only strictly accepts provider transaction identifiers (`dto.providerTransactionId || dto.data?.reference`). Missing IDs throw `BadRequestException('Missing provider transaction ID')`.
  12. **Opaque Error Masking on Lookup Failure (Risk 4):**
     - In `BankVerificationService.lookupBankAccount`: catches vendor lookup errors and throws fixed generic exception `BadRequestException('Không thể xác minh tài khoản ngân hàng lúc này')`. Zero URL, API error code, or vendor internal traces exposed to clients.
  13. **Fail-Fast Boot Guard on Platform Bank Account (Risk 5):**
     - In `BankVerificationService.onModuleInit`: throws fatal error during NestJS boot if `NODE_ENV === 'production'` and `PLATFORM_BANK_ACCOUNT_NUMBER` is missing.
  14. **Production Mock Ban (Risk 6):**
     - In `BankVerificationService.onModuleInit`, `PayOSBankVerificationProvider.lookupAccount`, and `createRefund`: throws fatal error if `NODE_ENV === 'production' && BANK_VERIFICATION_MOCK === 'true'`.
  15. **Anti-Enumeration Lookup Rate Limiting Guard (Risk 7):**
     - Created `BankLookupRateLimitGuard` (`src/bank-verification/guards/bank-lookup-rate-limit.guard.ts`) capped at 15 requests/minute per user/IP. Applied to `POST /api/v1/stores/bank-accounts/lookup`. Blocks abuse with HTTP 429 Too Many Requests.
  16. **Functional Gaps Completed:**
     - Set Default Bank Account: `PATCH /api/v1/stores/:storeId/bank-accounts/:id/default`
     - Delete Bank Account: `DELETE /api/v1/stores/:storeId/bank-accounts/:id` (prevents deletion if pending verification exists)
     - Cancel Pending Verification: `POST /api/v1/stores/bank-accounts/verification/:id/cancel`
- Verification Evidence:
  - `npx tsx tests/bank-account-verification.spec.ts` — PASS (37/37 assertions pass)
  - `npm run test:all` — PASS (13/13 suites pass, 281.8s)
  - `npx tsc --noEmit` — PASS (0 errors)
  - `npm run build` — PASS (0 errors)
  - `npx prisma migrate status` — PASS ("Database schema is up to date!")

### [2026-10-22] Penny-Deposit Bank Verification Review & Hardening (7 Tertiary Review Items)
- Status: COMPLETED & FULLY VERIFIED (Suite 13: 37/37 PASS, Master Suites: 13/13 PASS)
- Resolved 7 Items:
  1. **Dual Cross-Check of Bank BIN & Account Number:**
     - Verified both sender pair (`senderBankBin` + `senderAccountNumber`) against registered store account, and destination pair (`destinationBankBin` + `destinationAccountNumber`) against platform config (`PLATFORM_BANK_BIN` + `PLATFORM_BANK_ACCOUNT_NUMBER`).
     - In strict/production mode, missing BIN or Account Number fails closed (`SENDER_BANK_UNVERIFIABLE`, `DESTINATION_BANK_UNVERIFIABLE`, `SENDER_ACCOUNT_UNVERIFIABLE`, `DESTINATION_ACCOUNT_UNVERIFIABLE`).
     - Mismatches fail closed (`SENDER_BANK_MISMATCH`, `DESTINATION_BANK_MISMATCH`, `SENDER_ACCOUNT_MISMATCH`, `DESTINATION_ACCOUNT_MISMATCH`).
  2. **Multi-Instance Rate Limiting with Redis:**
     - Upgraded `BankLookupRateLimitGuard` (`src/bank-verification/guards/bank-lookup-rate-limit.guard.ts`) to use Redis atomic `INCR` and 60-second TTL on key `rate_limit:bank_lookup:{userId}:{ip}`.
     - Includes graceful fallback to in-memory `Map` when Redis is offline or not configured.
  3. **Comprehensive Fail-Fast Production Boot Guards:**
     - In `BankVerificationService.onModuleInit()`: when `NODE_ENV === 'production'`, fails boot immediately if ANY of `PLATFORM_BANK_ACCOUNT_NUMBER`, `PLATFORM_BANK_BIN`, `PAYOS_CLIENT_ID`, `PAYOS_API_KEY`, `PAYOS_CHECKSUM_KEY`, `BANK_VERIFICATION_WEBHOOK_SECRET` are missing, or if `BANK_VERIFICATION_MOCK === 'true'`.
  4. **Separation of VietQR and PayOS Credentials:**
     - In `PayOSBankVerificationProvider`: decoupled VietQR Open API lookup (`https://api.vietqr.io/v2/lookup`) from PayOS by supporting dedicated `VIETQR_CLIENT_ID` and `VIETQR_API_KEY` (with fallback to `PAYOS_*`). Throws `ServiceUnavailableException` if neither is configured when mock is off.
  5. **Live Webhook Field Extraction & Aliasing:**
     - Added support in `BankVerificationService.handleVerificationWebhook()` and `BankVerificationWebhookDto` for all provider field aliases: `counterAccountNumber`, `counterAccountBankId`, `counterBankBin`, `senderBankBin`, `destinationBankBin`, `destinationAccountNumber`, `reference`.
  6. **Persistent Audit Trail for Verification Failures in PostgreSQL:**
     - Added `failure_reason VARCHAR(64)` column to `bank_account_verification_transactions` (Migration `20261022150000_add_bank_verification_failure_reason`).
     - All rejected transactions record `status = 'FAILED'` and exact `failure_reason` in PostgreSQL for complete admin auditability.
  7. **Clean Repository (Zero Test/Mock/Secret Data Committed):**
     - Verified with `git grep` and `git ls-files` that no `.env` files, secrets, or hardcoded production mocks exist in version control.
  8. **Fail-Closed on Account Number Decryption Failure:**
     - In `BankVerificationRepository.executeAtomicWebhookVerificationTx`: if `CryptoVaultUtil.decryptAccountNumber` fails or produces an empty string, immediately rejects the transaction with `SENDER_ACCOUNT_UNVERIFIABLE`, marks `status = 'FAILED'`, and persists `failure_reason = 'SENDER_ACCOUNT_UNVERIFIABLE'`. Prevents any unverified webhook from bypassing verification.
  9. **Production Anti-Bypass Distributed Rate Limiting (Redis 503 Fail-Closed):**
     - In `BankLookupRateLimitGuard`: when `NODE_ENV === 'production'`, if Redis client is missing, not in `ready` state, or throws an error on `INCR`, immediately throws HTTP 503 Service Unavailable (`RATE_LIMIT_SERVICE_UNAVAILABLE`). RAM Map fallback is strictly banned in production to prevent multi-instance limit evasion.
     - In `BankVerificationService.onModuleInit()`: production boot halts if `REDIS_URL` or `REDIS_HOST` is unconfigured.
- Verification Evidence:
  - `npx tsx tests/bank-account-verification.spec.ts` — PASS (39/39 assertions pass)
  - `npx tsc --noEmit` — PASS (0 errors)
  - `npm run build` — PASS (0 errors)
  - `npx prisma migrate status` — PASS ("Database schema is up to date!")

### [2026-10-22] ERD Level 3 Physical Schema Synchronization (BRD Folder)
- Status: COMPLETED & FULLY VERIFIED (42/42 Tables Matched, Zero Schema Diff)
- Files Updated:
  - [`BRD/ERD_Level_3_Editable.drawio`](file:///f:/Learning/SEM9-FPTu/backend/BRD/ERD_Level_3_Editable.drawio)
  - [`BRD/erd_level_3_drawio_editable.xml`](file:///f:/Learning/SEM9-FPTu/backend/BRD/erd_level_3_drawio_editable.xml)
- Changes Summary (Zero changes made to existing drawn structures/layouts):
  1. **Added 7 Missing Tables from Database:**
     - `USER_FCM_TOKENS` (7 columns) - Placed at x=3320, y=3040 with FK to `USERS(user_id)`.
     - `IDENTITY_VERIFICATION_SESSIONS` (13 columns) - Placed at x=2880, y=2580 with FK to `USERS(user_id)`.
     - `DIDIT_WEBHOOK_EVENTS` (8 columns) - Placed at x=2880, y=3000 with FK to `IDENTITY_VERIFICATION_SESSIONS(didit_session_id)`.
     - `STORE_BANK_ACCOUNTS` (14 columns) - Placed at x=6270, y=2860 with FK to `STORE(store_id)`.
     - `BANK_ACCOUNT_VERIFICATION_TRANSACTIONS` (15 columns) - Placed at x=6270, y=3300 with FK to `STORE_BANK_ACCOUNTS(id)`.
     - `DRIVER_DUTIES` (7 columns) - Placed at x=5350, y=3300 with FKs to `STORE(store_id)` and `USERS(driver_id)`.
     - `DRIVER_SHIFTS` (16 columns) - Placed at x=5350, y=3560 with FKs to `STORE(store_id)`, `USERS(driver_id)`, and `USERS(confirmed_by_user_id)`.
  2. **Appended Missing Columns to Existing Tables:**
     - Table `USERS`: added `phone_verified_at` (timestamptz), `firebase_uid` (varchar), `avatar_url` (varchar), `kyc_status` (varchar).
     - Table `STORE_WITHDRAWALS`: added `store_id` (bigint, FK) and `idempotency_key` (varchar) with connector from `STORE(store_id)`.
  3. **Verification Evidence:**
     - Draw.io MCP `list_pages` output: `id: "ERD_Level_3_Optimized"`, `name: "ERD Level 3 - 42 Tables Full Physical Schema"`, size `815,921 bytes`.
     - Deep schema comparator: 0 missing tables, 0 missing columns across all 42 models.

### [2026-10-23] Device Templates, Bulk Deployment, Safe Updates, Atomic Allocation & Order Status Alias (Phases 1-10)
- Status: COMPLETED & FULLY VERIFIED (Suite 14: 25/25 PASS, Master Test Suite: 14/14 PASS, 0 Failures)
- Resolved Requirements across All 10 Phases & Post-Review Hardening:
  1. **Phase 1: Database Migration & Schema Update**
     - Initial Migration: `prisma/migrations/20261023163000_device_templates_and_button_enhancements/migration.sql` (added `default_product_id` FK and `long_press_action` column).
     - Constraint Migration: `prisma/migrations/20261023190000_add_long_press_action_check_constraints/migration.sql` adding PostgreSQL CHECK constraints:
       `CHECK ("long_press_action" IN ('WIFI_CONFIGURATION', 'ORDER_PRODUCT', 'NONE'))` on both `device_templates` and `iot_button`.
     - Data Normalization Notice: Migration automatically normalizes any legacy or out-of-spec values in existing records to the safe default `'WIFI_CONFIGURATION'` before applying the CHECK constraints to guarantee non-breaking deployment.
     - Updated `prisma/schema.prisma` with relations and default values. Deployed cleanly via `prisma migrate deploy`.
  2. **Phase 2: Strict DTOs & Validation Layer**
     - [`src/devices/dto/device-template.dto.ts`](file:///f:/Learning/SEM9-FPTu/backend/src/devices/dto/device-template.dto.ts):
       - `CreateDeviceTemplateDto` & `UpdateDeviceTemplateDto`: Validates `defaultProductId`, `longPressAction` enum (`WIFI_CONFIGURATION`, `ORDER_PRODUCT`, `NONE`), `defaultQuantity` (>= 1), `cancelWindowSeconds` (5..300).
       - `DeployDeviceTemplateDto`: Enforces mutual exclusivity and caps total batch deployment to 100 devices across 3 modes:
         * Single: `deviceId`
         * Bulk: `deviceIds` (array of strings, length 1..100)
         * Range: `prefix`, `startRange` (>= 1), `endRange` (>= startRange), `padLength` (1..10), capped at `<= 100` total items.
     - [`src/devices/dto/devices.dto.ts`](file:///f:/Learning/SEM9-FPTu/backend/src/devices/dto/devices.dto.ts):
       - `UpdateDeviceDto`: Enforces `@Min(0) @Max(100)` for `batteryLevel`, `@IsISO8601()` for `warrantyExpiry`, and completely removed `storeId` & `customerId` to prevent mass-assignment tenant tampering.
       - `AllocateStoreDto`: Supports both `storeId` and `targetStoreId` alias with array of `deviceIds`.
     - [`src/orders/dto/update-order-status.dto.ts`](file:///f:/Learning/SEM9-FPTu/backend/src/orders/dto/update-order-status.dto.ts):
       - Added `@Transform` mapping frontend alias `OUT_FOR_DELIVERY` -> `READY_FOR_DELIVERY`.
  3. **Phase 3 & 4: Template Management & Bulk Deployment Service**
     - [`src/devices/device-templates.service.ts`](file:///f:/Learning/SEM9-FPTu/backend/src/devices/device-templates.service.ts):
       - Tenant isolation: verifies `defaultProductId` belongs to the requesting store.
       - Single, bulk array, and range deployment modes with strict off-by-one check: `if (endRange - startRange + 1 > 100)` throwing `BadRequestException`.
       - Atomic transactional deployment via `deployTemplateAtomicTx` in repository: auto-provisions `iot_button` and maps `button_product` with default product and quantity.
       - Returns per-device status reporting envelope: `{ success, total, succeeded, failed, results: [...] }`.
  4. **Phase 5: Secure Device Update Service**
     - [`src/devices/devices.service.ts`](file:///f:/Learning/SEM9-FPTu/backend/src/devices/devices.service.ts):
       - Whitelisted updates for `buttonName`, `batteryLevel`, `batteryVoltage`, `warrantyExpiry`, `firmwareVersion`, `longPressAction`.
       - Rejects with 400 Bad Request when setting `quantity` without a `productId` on unassigned devices.
       - If `productId` is provided, verifies product belongs to the device's store.
       - Zero tenant tampering: attempts to pass `storeId` or `customerId` are ignored/stripped.
  5. **Phase 6: Atomic Device Allocation & WebSockets**
     - [`src/devices/devices.repository.ts`](file:///f:/Learning/SEM9-FPTu/backend/src/devices/devices.repository.ts):
       - `allocateDevicesToStoreTx`: Uses `SELECT button_id, device_id, store_id, status FROM iot_button WHERE device_id = ANY($1::text[]) FOR UPDATE` row locking.
       - Rejects already-allocated devices with 400 Bad Request.
     - [`src/websocket/events.gateway.ts`](file:///f:/Learning/SEM9-FPTu/backend/src/websocket/events.gateway.ts):
       - Security: Query string tokens strictly banned to prevent leakage in access/proxy logs (`client.handshake.query?.token` removed). Only `headers.authorization` or `handshake.auth.token` accepted.
       - Multi-Store Auto-Join: On connection, queries PostgreSQL for all active stores owned by the user (`ownerUserId`) or where they serve as active staff (`storeStaff`), automatically joining `store_${storeId}` and `store:${storeId}` for all associated stores.
       - Emits `devices:allocated` post-commit to `store_${storeId}` and `user:${ownerUserId}` via `EventsGateway.emitToUser`.
  6. **Phase 7: Role-Based Access Control (RBAC)**
     - Updated `@Roles()` in `DeviceTemplatesController` and `DevicesController`:
       - Added `ADMIN` alongside `SYSTEM_ADMIN`, `SUPER_ADMIN`, `STORE_OWNER`, and `STORE_MANAGER` on administrative device and allocation routes.
       - Strictly blocks `CUSTOMER` role with HTTP 403 Forbidden.
  7. **Phase 8: Order Status Normalization & State Machine**
     - [`src/orders/orders.service.ts`](file:///f:/Learning/SEM9-FPTu/backend/src/orders/orders.service.ts):
       - Accepts `OUT_FOR_DELIVERY` alias from frontend and normalizes to `READY_FOR_DELIVERY`.
       - Transitions order state machine cleanly and emits WebSocket event `ORDER_READY_FOR_DELIVERY` and `ORDER_STATUS_CHANGED`.
  8. **Phase 9: Comprehensive Verification Test Suite 14**
     - Created [`tests/device-templates-bulk-deploy.spec.ts`](file:///f:/Learning/SEM9-FPTu/backend/tests/device-templates-bulk-deploy.spec.ts):
       - 25/25 assertions passing covering all functional, security, and boundary checks (including `9.1b` boundary test for 1 -> 101 devices).
     - Registered in [`tests/run_all_suites.ts`](file:///f:/Learning/SEM9-FPTu/backend/tests/run_all_suites.ts).
  9. **Phase 10: Full Regression Testing & System Integrity**
     - Fixed composite foreign key `(customer_id, address_id)` sync in `confirmPairingAtomicTx` within `src/devices/provisioning.repository.ts` to satisfy `iot_button_customer_id_address_id_fkey`.
     - Restored `BRD/` documentation files to keep the git working tree cleanly scoped to backend code changes.
     - Verified 14/14 test suites pass in `npx tsx tests/run_all_suites.ts` with 0 failures (344.5s):
       * Suite 1: Firebase Phone Authentication Suite (45/45 PASS)
       * Suite 2: Firebase Cloud Messaging (FCM) & Notifications Suite (22/22 PASS)
       * Suite 3: Order Lifecycle, Window Cancel & Inventory Safety (7/7 PASS)
       * Suite 4: IoT Device Config & Product Mapping Suite (12/12 PASS)
       * Suite 5: Zero-Touch Provisioning & Security Incidents Suite (13/13 PASS)
       * Suite 6: End-to-End Zero-Touch Device Lifecycle v4.0 (12/12 PASS)
       * Suite 7: Multi-Vendor Marketplace, Rental & Escrow Wallet E2E (13/13 PASS)
       * Suite 8: Security Audit 8 Criteria & Zero Residue Verifier (8/8 PASS)
       * Suite 9: Smart Order Button API Integration Suite (16/16 PASS)
       * Suite 10: User Avatar URL & Profile Management Suite (25/25 PASS)
       * Suite 11: Order Minimum Value (>= 2,000 VND) Constraint Suite (15/15 PASS)
       * Suite 12: Didit eKYC Identity Verification Suite (47/47 PASS)
       * Suite 13: Penny-Deposit Bank Account Verification (2.000 VND) Suite (39/39 PASS)
       * Suite 14: Device Templates, Bulk Deploy, Allocation & Order Alias Suite (25/25 PASS)
     - TypeScript compile clean (`npx tsc --noEmit` -> 0 errors).
     - Production build clean (`npm run build` -> 0 errors).
     - Database migration status (`npx prisma migrate status` -> "Database schema is up to date! 13 migrations found").

---

### E. Frontend Contract Gap Remediation & Notification History Module (Suite 15)
1. **Database Migration (`notifications` Table):**
   - Migration: [`prisma/migrations/20261023210000_add_notifications_table`](file:///f:/Learning/SEM9-FPTu/backend/prisma/migrations/20261023210000_add_notifications_table)
   - Created PostgreSQL table `notifications` with columns:
     - `notification_id BIGSERIAL PRIMARY KEY`
     - `user_id BIGINT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE`
     - `type VARCHAR NOT NULL`
     - `title VARCHAR NOT NULL`
     - `body TEXT NOT NULL`
     - `data JSONB NULL`
     - `idempotency_key VARCHAR UNIQUE NOT NULL`
     - `read_at TIMESTAMPTZ NULL`
     - `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
   - Composite indexes: `@@index([userId, readAt])` and `@@index([userId, createdAt])`.
2. **Auth Contract Discrepancies Resolved:**
   - **Change Password Endpoint:**
     - Route: `POST /api/v1/auth/change-password` with `@UseGuards(JwtAuthGuard)` in [`src/auth/auth.controller.ts`](file:///f:/Learning/SEM9-FPTu/backend/src/auth/auth.controller.ts).
     - DTO: [`src/auth/dto/change-password.dto.ts`](file:///f:/Learning/SEM9-FPTu/backend/src/auth/dto/change-password.dto.ts) with strict password policy (min 8 chars, uppercase, lowercase, numbers, special characters).
     - Service: `changePassword()` in [`src/auth/auth.service.ts`](file:///f:/Learning/SEM9-FPTu/backend/src/auth/auth.service.ts):
       * Validates old password with `bcrypt.compare`.
       * Rejects identical new password with 400 Bad Request (`PASSWORD_UNCHANGED`).
       * Hashes new password with `bcrypt.hash(dto.newPassword, 12)`.
       * Updates `password_hash` and `password_changed_at = NOW()` inside transaction.
       * Revokes all active refresh tokens in database (`authRepo.updatePasswordTx`).
       * Blacklists current access token and revokes user in `TokenBlacklist`.
       * `jwt.strategy.ts` immediately blocks any JWTs issued prior to `passwordChangedAt` with HTTP 401 Unauthorized.
       * Zero entity/hash leakage in response envelope.
   - **Profile Update PUT Alias:**
     - Added `PUT /api/v1/auth/profile` route in `AuthController` delegating to existing shared `authService.updateProfile` logic.
3. **Payments Contract (Order Payment Method Change):**
   - Route: `POST /api/v1/payments/orders/:orderId/payment-method` with `@HttpCode(200)` and `@UseGuards(JwtAuthGuard)`.
   - DTO: [`src/payments/dto/change-payment-method.dto.ts`](file:///f:/Learning/SEM9-FPTu/backend/src/payments/dto/change-payment-method.dto.ts) validating `paymentMethod IN ('PAYOS', 'COD')`.
   - Service: `changeOrderPaymentMethod()` in [`src/payments/payments.service.ts`](file:///f:/Learning/SEM9-FPTu/backend/src/payments/payments.service.ts):
     * BOLA verification: checks `order.customer_id === req.user.customerProfileId` (unless Admin).
     * Order status invariant: allows modification only if `orderStatus === 'PENDING'` and `paymentStatus === 'UNPAID'`. Rejects terminal states (`PAID`, `CONFIRMED`, `COMPLETED`, `CANCELLED`, `REJECTED`) with HTTP 400 Bad Request.
     * PayOS cancellation: automatically cancels any previously active PayOS payment links via `cancelPaymentLink()`.
     * Safe transactional update in [`src/payments/payments.repository.ts`](file:///f:/Learning/SEM9-FPTu/backend/src/payments/payments.repository.ts) (`changePaymentMethodTx`) with explicit field whitelisting.
4. **Products Contract (Product Deletion Safety):**
   - Route: `DELETE /api/v1/products/:id` with `@UseGuards(JwtAuthGuard, RolesGuard)` and `@Roles('STORE_OWNER', 'STORE_MANAGER', 'SYSTEM_ADMIN', 'SUPER_ADMIN')`.
   - Service: `deleteProduct()` in [`src/products/products.service.ts`](file:///f:/Learning/SEM9-FPTu/backend/src/products/products.service.ts):
     * Store ownership check: verifies product belongs to the store managed by the requester.
     * Active order invariant: counts active processing orders (`PENDING`, `PREPARING`, `READY_FOR_DELIVERY`, `DELIVERING`) and rejects deletion with HTTP 400 Bad Request if active orders reference the product.
     * IoT Button protection: verifies no active IoT button mapping references the product before deletion.
     * Soft-delete: safely marks product `status = 'INACTIVE'`.
     * Reference-count Cloudinary media cleanup: cleans orphaned product images via `cloudinaryService.destroyImage()`.
5. **Notification History & Read Management APIs:**
   - Module: [`src/notifications/notifications.module.ts`](file:///f:/Learning/SEM9-FPTu/backend/src/notifications/notifications.module.ts)
   - Repository: [`src/notifications/notifications.repository.ts`](file:///f:/Learning/SEM9-FPTu/backend/src/notifications/notifications.repository.ts)
   - Endpoints:
     * `GET /api/v1/notifications` (paginated `?page=1&pageSize=20`, BOLA scoped to `req.user.id`).
     * `GET /api/v1/notifications/unread-count` (returns `{ unreadCount: N }` for authenticated user).
     * `PATCH /api/v1/notifications/:id/read` (marks specific notification as read, returns 403 Forbidden on cross-user IDOR).
     * `PATCH /api/v1/notifications/read-all` (marks all unread notifications for user as read).
6. **PayOS Webhook Atomic Notification & Idempotency:**
   - In [`src/payments/payments.repository.ts`](file:///f:/Learning/SEM9-FPTu/backend/src/payments/payments.repository.ts) (`confirmPaymentAtomicTx`):
     * Inside PostgreSQL transaction, atomically writes notification with unique `idempotency_key = payment:${paymentTransactionId}:paid`.
     * Replayed webhooks from PayOS are completely idempotent (`ON CONFLICT (idempotency_key) DO NOTHING`).
   - In [`src/payments/payments.service.ts`](file:///f:/Learning/SEM9-FPTu/backend/src/payments/payments.service.ts) (`handlePayosWebhook`):
     * Post-commit: sends FCM push notification to customer devices via `NotificationsService.sendPushToUser`.
     * Emits WebSocket events `ORDER_PAYMENT_CONFIRMED` to store and customer rooms.
7. **Verification Test Suite 15:**
   - Test File: [`tests/frontend-contract-and-notifications.spec.ts`](file:///f:/Learning/SEM9-FPTu/backend/tests/frontend-contract-and-notifications.spec.ts)
   - 23/23 tests passing with 0 failures covering all 5 sections.
   - Registered in [`tests/run_all_suites.ts`](file:///f:/Learning/SEM9-FPTu/backend/tests/run_all_suites.ts).
8. **Physical Database ERD Synchronization (43 Tables Full Alignment):**
   - File: [`BRD/ERD_Level_3_Editable.drawio`](file:///f:/Learning/SEM9-FPTu/backend/BRD/ERD_Level_3_Editable.drawio)
   - Synced diagram to full 43 physical tables matching [`prisma/schema.prisma`](file:///f:/Learning/SEM9-FPTu/backend/prisma/schema.prisma) 100% (added `NOTIFICATIONS`, `USER_FCM_TOKENS`, `IDENTITY_VERIFICATION_SESSIONS`, `DIDIT_WEBHOOK_EVENTS`, `STORE_BANK_ACCOUNTS`, `BANK_ACCOUNT_VERIFICATION_TRANSACTIONS`, `DRIVER_SHIFTS`, `DRIVER_DUTIES`) with collision-free coordinates, exact data types, PK/UK indicators, and relational foreign-key edges. 
---

### G. Production Deployment on Render (LIVE Verified)
1. **Live Production Endpoints:**
   - Base API URL: `https://backend-fae8.onrender.com/api/v1`
   - Liveness Probe (`/healthz`): `https://backend-fae8.onrender.com/healthz` -> Returns `{"status":"UP"}` (HTTP 200 OK).
   - Readiness Probe (`/readyz`): `https://backend-fae8.onrender.com/readyz` -> Returns `{"status":"READY"}` with live DB connectivity (HTTP 200 OK).
   - Swagger OpenAPI Documentation: `https://backend-fae8.onrender.com/docs`
   - WebSocket Gateway: `wss://backend-fae8.onrender.com` (Socket.io)
2. **Network & Database Resolution (Supabase IPv4 Pooler):**
   - Render container networks operate in an IPv4-only stack and cannot resolve Supabase direct connection strings (`db.<ref>.supabase.co:5432`) which have IPv6-only AAAA records.
   - Resolution: Switched database connection to Supabase Session Pooler in Tokyo region:
     `postgresql://postgres.<project-ref>:[PASSWORD]@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres?sslmode=require`
   - All 14 Prisma database migrations verified deployed without errors.
3. **Memory Optimization & OOM Protection:**
   - Excluded `tests/` directory from production compilation via [`tsconfig.build.json`](file:///f:/Learning/SEM9-FPTu/backend/tsconfig.build.json) and [`nest-cli.json`](file:///f:/Learning/SEM9-FPTu/backend/nest-cli.json), reducing build-time memory usage by >60%.
   - Switched production start command from `nest start` (which ran TypeScript dev compiler in memory) to `node scripts/start-prod.js` in [`package.json`](file:///f:/Learning/SEM9-FPTu/backend/package.json), maintaining runtime footprint well below the 512MB free tier limit (~50-60MB).
4. **Third-Party Webhook Endpoints for Production:**
   - PayOS Payment Webhook: `https://backend-fae8.onrender.com/api/v1/payments/payos/webhook`
   - Didit Identity Webhook: `https://backend-fae8.onrender.com/api/v1/webhooks/didit`
   - VietQR / Bank Verification Webhook: `https://backend-fae8.onrender.com/api/v1/webhooks/bank-verification`

---

### H. Fix Order.buttonId Nullable Schema Alignment
1. **Root Cause Diagnosis:**
   - Orders created via mobile app or web frontend without an IoT device physical press have `orders.button_id = NULL` in database.
   - Prisma schema previously declared `buttonId BigInt` and `button IoTButton` as non-nullable, triggering runtime panic on `GET /api/v1/orders` (`Inconsistent column data: Conversion failed for column button_id: expected BigInt, got Null`).
2. **Schema & Migration:**
   - Updated `prisma/schema.prisma`:
     ```prisma
     buttonId BigInt? @map("button_id")
     button   IoTButton? @relation(fields: [buttonId], references: [buttonId], onDelete: Restrict)
     ```
   - Migration: [`prisma/migrations/20261024110000_make_order_button_id_nullable/migration.sql`](file:///f:/Learning/SEM9-FPTu/backend/prisma/migrations/20261024110000_make_order_button_id_nullable/migration.sql)
     ```sql
     ALTER TABLE "orders" ALTER COLUMN "button_id" DROP NOT NULL;
     ```
   - Applied to database via `npx prisma migrate deploy` (15 migrations total).
3. **Safe DTO Mapping:**
   - In [`src/orders/dto/order-response.dto.ts`](file:///f:/Learning/SEM9-FPTu/backend/src/orders/dto/order-response.dto.ts):
     `buttonId: raw.buttonId ? raw.buttonId.toString() : (raw.button_id ? raw.button_id.toString() : null)`
   - Safe `if (raw.button)` mapping avoids attempting to access properties of null buttons.
4. **Build & Typecheck:**
   - `npx prisma format` & `npx prisma generate` clean.
   - `npx tsc --noEmit` passed with 0 errors.
   - `npm run build` compiled successfully.

---

### I. Fix Build Failure in AuthService (GoogleLoginDto & resolveUserRole)
1. **Root Cause:**
   - Commit `cf8ef6c` introduced references to `GoogleLoginDto` and `this.resolveUserRole(user)` in `googleLogin` within [`src/auth/auth.service.ts`](file:///f:/Learning/SEM9-FPTu/backend/src/auth/auth.service.ts), but omitted importing `GoogleLoginDto` and forgot to implement `resolveUserRole`.
   - Result: Render build failed on TypeScript compilation (`Cannot find name 'GoogleLoginDto'`, `Property 'resolveUserRole' does not exist on type 'AuthService'`).
2. **Resolution:**
   - Imported `GoogleLoginDto` from `./dto/auth.dto`.
   - Implemented `public resolveUserRole(user: any): { role: string; storeId: string | null }` in `AuthService` with support for `SUPER_ADMIN`, `STORE_OWNER`, and store staff roles.
   - Verified with `npx tsc --noEmit` (0 errors) and `npm run build` (success).




---

### J. PayOS Webhook Handshake & Verification Fix
1. **Root Cause of PayOS Status Code 400:**
   - When saving the Webhook URL on PayOS dashboard (my.payos.vn), PayOS immediately dispatches a POST confirmation handshake request containing {"webhookUrl": "..."} or test samples.
   - Global ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }) rejected PayOS pings because webhookUrl was not whitelisted in PayosWebhookDto.
2. **Resolution:**
   - Updated src/payments/dto/payment.dto.ts: added @IsOptional() @IsString() webhookUrl?: string; and made webhook fields optional.
   - Updated src/payments/payments.controller.ts: added @UsePipes(new ValidationPipe({ whitelist: false, forbidNonWhitelisted: false })) on /api/v1/payments/payos/webhook to prevent unexpected external fields from being rejected.
   - Updated src/payments/payments.service.ts: intercepted ody?.webhookUrl confirmation ping to respond with { code: '00', desc: 'success', data: { webhookUrl } }, and test pings (orderCode 123) to return { code: '00', desc: 'success' }.
3. **Live Deployment Verification:**
   - Commit e8ac84 pushed to main.
   - Render deploy dep-dbe4076q1p3s73f8t700 finished with status live.
   - Verified live handshake via PowerShell Invoke-RestMethod: returned HTTP 200 { code: '00', desc: 'success', data: { webhookUrl: 'https://backend-fae8.onrender.com/api/v1/payments/payos/webhook' } }.
   - Verified live test ping (orderCode 123): returned HTTP 200 { code: '00', desc: 'success', message: 'Test webhook acknowledged' }.

---

### K. Didit eKYC Verification & Webhook Live Verification
1. **Body Size Limit Enhancement:**
   - Didit KYC payloads with AML, OCR, and Liveness analysis exceed 20KB.
   - Updated src/main.ts: added dedicated 1MB limit for /api/v1/webhooks while retaining strict 10KB limit on standard REST routes (RULE-14).
2. **Webhook Verification:**
   - Destination URL: https://backend-fae8.onrender.com/api/v1/webhooks/didit
   - Configured DIDIT_WEBHOOK_SECRET on Render.
   - Test webhook dispatched from Didit Business Console (status.updated, signature X-Signature-V2): received HTTP 200 OK (Response Status: 200).

---

### L. Cloudflare Security Audit Skill Integration & Comprehensive System Audit
1. **Skill Installation:**
   - Source: `https://github.com/cloudflare/security-audit-skill.git`
   - Installed globally to `C:\Users\ttphatt_2403\.gemini\config\skills\cloudflare-security-audit`
   - Installed in workspace to `.agents/skills/cloudflare-security-audit`
   - Full domain coverage installed: `WEB-PROTOCOL-AND-AUTH.md`, `ATTACK-CLASSES.md`, `RESOURCE-EXHAUSTION-AND-AVAILABILITY.md`, `DATA-ISOLATION-AND-LIFECYCLE.md`, `CLOUD-AND-DEPLOYMENT.md`, `RECONNAISSANCE.md`, `HUNTING.md`, `VALIDATION-AND-REPORTING.md`.
2. **Audit Verification & Findings:**
   - Verified 8 core security controls on live Render production (`tests/verify_all_8_audit_fixes.js`):
     - Body size limit (10kb guard): PASS (HTTP 413)
     - Device HMAC signature enforcement: PASS (HMAC key rotation enforced)
     - Pairing token atomic consumption: PASS (Race condition immune via `UPDATE RETURNING`)
     - Revoked JWT multi-instance synchronization: PASS (PostgreSQL `revoked_tokens` table)
     - PayOS error code 601 handling: PASS (HTTP 400 Bad Request)
     - Pagination caps: PASS (`pageSize > 100` rejected, Cloudinary allowed)
   - Order Cancellation Window & Safety:
     - Fixed `src/orders/orders.service.ts` to strictly enforce `cancelWindowSeconds` (60s default) for all button orders regardless of payment status.
     - Verified all 7 test cases in `tests/order-lifecycle.spec.ts` PASS cleanly (Customer 60s window cancel, expired rejection, store owner override, non-PENDING rejection, auto-confirmation worker, inventory clamping `GREATEST(0, ...)` release, and reservation reconciliation).

---

### M. Enterprise 3-Layer CI/CD Pipeline Implementation
1. **GitHub Actions Workflow File:**
   - [`.github/workflows/ci-cd.yml`](file:///f:/Learning/SEM9-FPTu/backend/.github/workflows/ci-cd.yml)
2. **Layer 1: Code Quality & Build (`quality-and-build`)**:
   - `timeout-minutes: 15`, Node 20 with `npm` caching.
   - `npm ci`, `npx prisma generate`, `npx tsc --noEmit` (0 type errors), `npm run build` (2GB heap).
   - Artifact caching for `dist/`.
3. **Layer 2: Isolated Database & Integration Test Suites (`database-and-tests`)**:
   - `timeout-minutes: 25`.
   - Ephemeral Service Containers: `postgres:15-alpine` (`smart_order_test`) and `redis:7-alpine`.
   - Isolated Environment Variables: `DATABASE_URL` pointing to localhost container, `REDIS_URL=redis://localhost:6379`, `NODE_ENV=test`. Zero mutation on production DB.
   - Executes `npx prisma migrate deploy` and `npm run prisma:seed` on clean database instance.
   - Background Server: boots `npm run start:test &` on port 3000, polls `wait-on http://localhost:3000/healthz` until UP, executes `npm run test:all` across all 15 suites, tears down server process on completion.
   - Artifact logging: `actions/upload-artifact@v4` uploads `ci-test-failure-logs` on any test failure.
4. **Layer 3: Production Deployment & Health Verification (`deploy-production`)**:
   - `timeout-minutes: 15`. Trigger condition: `github.event_name == 'push' && github.ref == 'refs/heads/main' && needs.quality-and-build.result == 'success' && needs.database-and-tests.result == 'success'`.
   - Fail-Closed Secret Enforcement: halts immediately with `exit 1` if `RENDER_DEPLOY_HOOK_URL` secret is missing.
   - Dispatches curl POST to Render Deploy Hook.
   - Health Probe: polls live Render production URL `https://backend-fae8.onrender.com/healthz` for up to 300s (30 attempts x 10s) until HTTP 200 OK.
5. **NPM Scripts Enhancement:**
   - Added `"start:test": "node dist/src/main.js"` in `package.json`.

---

### N. Production Hardening: Zero Plaintext Bank Storage & Payout Engine Security
1. **Zero Plaintext Bank Account Enforcement (Blocker 1 Resolved):**
   - In `StoreWithdrawal`: `bankAccountNumber` is strictly set to `null` on withdrawal creation. Plaintext full bank accounts are NEVER persisted in database rows or audit logs.
   - Database Migration: [`prisma/migrations/20261024210000_nullify_plaintext_bank_accounts`](file:///f:/Learning/SEM9-FPTu/backend/prisma/migrations/20261024210000_nullify_plaintext_bank_accounts) nullifies any remaining legacy plaintext `bank_account_number` in `store_withdrawals` and `store_wallets`.
   - On-the-Fly RAM Decryption: `StoreWalletService.triggerPayosPayout` and `AdminService.executePayOSPayout` decrypt `bankAccountEncrypted` in ephemeral memory only for the exact duration of the outbound PayOS API HTTP call.
   - Strict DTO Masking via [`src/store-wallet/mappers/wallet.mapper.ts`](file:///f:/Learning/SEM9-FPTu/backend/src/store-wallet/mappers/wallet.mapper.ts): `listWithdrawals`, `getWithdrawal`, `getWallet`, `listTransactions`, and `admin.listAllWithdrawals` exclusively return masked account numbers (`bankAccountMasked`, e.g. `******9999`) and metadata. Entity leaking is completely eliminated.
2. **Decommissioning Manual Transfer Endpoint (Blocker 2 Resolved):**
   - `POST /api/v1/admin/withdrawals/:id/transfer` is permanently locked down and marked `@deprecated`.
   - Any manual attempt to bypass PayOS and set `TRANSFERRED` directly throws HTTP 400 `MANUAL_TRANSFER_DEPRECATED`.
   - All payouts must follow the automated, single-path PayOS Payout route (`POST /api/v1/admin/withdrawals/:id/payout`), and terminal success/failure is strictly finalized by verified PayOS webhooks or automated status sync.
3. **Hardened Webhook Signature Verification (Blocker 3 Resolved):**
   - Webhook controller [`src/payments/payout-webhook.controller.ts`](file:///f:/Learning/SEM9-FPTu/backend/src/payments/payout-webhook.controller.ts) implements dual verification:
     - Primary: Timing-safe HMAC-SHA256 (`crypto.timingSafeEqual`) on canonical alphabetically sorted key-value query strings (Official PayOS specification).
     - Secondary Fallback: Raw body buffer (`req.rawBody`) HMAC verification.
   - Verified via automated test cases in Suite 16:
     - 4.5: Permuted JSON key ordering matches canonical deep sort signature.
     - 4.6: Tampered amounts or payloads are strictly rejected with HTTP 400 Bad Request.
     - 4.7: Manual transfer endpoint lockdown verified with `MANUAL_TRANSFER_DEPRECATED`.
     - 4.8: Database zero-residue check verifies `bankAccountNumber === null`.
4. **Environment Isolation & Deployment Flexibility:**
   - Dedicated Payout Credentials: `PayOSPayoutService` enforces dedicated `PAYOS_PAYOUT_CLIENT_ID`, `PAYOS_PAYOUT_API_KEY`, and `PAYOS_PAYOUT_CHECKSUM_KEY` in `NODE_ENV === 'production'`.
   - CI/CD Deployment Health Check: `.github/workflows/ci-cd.yml` parameterized with `${{ vars.RENDER_HEALTH_CHECK_URL || 'https://backend-fae8.onrender.com/healthz' }}`.

---

### [2026-10-25] Suite 13 Zero-Plaintext Regression Assertion
- Status: PARTIAL
- Changes: Updated the verified-withdrawal assertion to require `bankAccountNumber === null` plus encrypted and masked bank snapshots, matching the production zero-plaintext invariant introduced in `7be9cd9`.
- Files: `tests/bank-account-verification.spec.ts`, `SESSION_HANDOFF.md`.
- Verification:
  - `npx prisma validate` — PASS.
  - `npx tsc --noEmit` — PASS.
  - `npm run build` — PASS.

---

### [2026-10-25] Waterfall Implementation: Phase 1 & Phase 2 (Core Entities)
- **Status:** COMPLETED & 100% VERIFIED
- **Plan File:** [`docs/superpowers/plans/2026-10-25-backend-waterfall-implementation-plan.md`](file:///f:/Learning/SEM9-FPTu/backend/docs/superpowers/plans/2026-10-25-backend-waterfall-implementation-plan.md)
- **Phase 1: Architecture & Contract Remediation:**
  1. **Task 1.1 (Storefront 6-Layer Architecture Refactor):**
     - Refactored `src/orders/storefront.controller.ts` to strictly inject `OrdersService`.
     - Encapsulated transaction, inventory deduction, order items snapshot, and status history into `OrdersRepository.createStorefrontOrderTx`.
     - Test: `tests/storefront-checkout-refactor.spec.ts` -> **4/4 PASS**.
  2. **Task 1.2 (Explicit Inventory Row-Level Locking):**
     - Implemented `SELECT ... FROM inventory WHERE product_id = $1 AND store_id = $2 FOR UPDATE` in ascending `productId` order to prevent deadlocks and overselling race conditions.
     - Test: `tests/inventory-concurrency-race.spec.ts` (simultaneous race on last remaining stock) -> **2/2 PASS**.
  3. **Task 1.3 (Product DTO & Category Store Ownership Contract):**
     - Updated `CreateProductDto` and `UpdateProductDto` to accept `categoryId`, `description`, optional `unit`.
     - Added `findCategoryById` and enforced cross-store category validation in `ProductsService`.
     - Test: `tests/product-contract-validation.spec.ts` -> **2/2 PASS**.
  4. **Task 1.4 (Standardize Canonical Pagination Envelope & Caps):**
     - Created `src/common/dto/pagination-query.dto.ts` and `src/common/utils/pagination.helper.ts`.
     - Standardized response envelope `{ success: true, message, data, pagination: { page, pageSize, totalItems, totalPages, hasNextPage, hasPrevPage } }` with `pageSize <= 100` caps across store and driver controllers.
     - Test: `tests/canonical-pagination-envelope.spec.ts` -> **4/4 PASS**.

- **Phase 2: Core Entities (Sprint 1):**
  1. **Task 2.1 (Customer Address CRUD & Partial Unique Default Constraint):**
     - Migration: `prisma/migrations/20261025100000_customer_address_constraints` (`CREATE UNIQUE INDEX uq_customer_single_default ON customer_address(customer_id) WHERE is_default = true`).
     - Module: `src/customer-addresses/` (controller, service, repository, DTOs) registered in `AppModule`.
     - Concurrency row-locking on customer profile for atomic default toggle; guarded deletion against active `IoTButton` references (`ADDRESS_IN_USE_BY_DEVICE`).
     - Test: `tests/customer-addresses-crud.spec.ts` -> **7/7 PASS**.
  2. **Task 2.2 (Hierarchical Category Tree CRUD with Cycle Detection):**
     - Module: `src/categories/` (controller, service, repository, DTOs) registered in `AppModule`.
     - Support `/api/v1/stores/:storeId/categories` and `/api/v1/categories/:id`.
     - Cycle detection algorithm preventing circular ancestor loops (A -> B -> A), self-parent rejection, and soft-delete to `INACTIVE`.
     - Test: `tests/categories-management.spec.ts` -> **7/7 PASS**.
  3. **Task 2.3 (Product Discount CRUD & DB Check Constraints):**
     - Migration: `prisma/migrations/20261025110000_product_discount_constraints` (enforcing `start_at < end_at`, mutual exclusivity of `discount_percent` vs `discount_amount`, and non-negative ranges).
     - Module: `src/product-discounts/` (controller, service, repository, DTOs) registered in `AppModule`.
     - Active interval overlap validation rejecting conflicting schedules on the same product.
     - Test: `tests/product-discounts-crud.spec.ts` -> **7/7 PASS**.
  4. **Task 2.4 (Order Filters, Timeline & Delivery Queue Route Ordering):**
     - Route ordering invariant: placed `@Get('delivery-queue')` and `@Get(':id/timeline')` BEFORE `@Get(':id')` in `OrdersController` to prevent route swallowing.
     - Created `src/orders/dto/order-query.dto.ts` and `src/orders/dto/order-timeline-response.dto.ts`.
     - Multi-filter querying (status, paymentStatus, driverId, fromDate, toDate) with canonical pagination envelope.
     - Timeline endpoint assembling events from orders, status histories (`changedAt`), payment transactions, and delivery details.
     - Test: `tests/order-filter-and-timeline.spec.ts` -> **5/5 PASS**.

- **Phase 3: Store Operations (Sprint 2):**
  1. **Task 3.1 (Store Profile Management & /stores/me Endpoint):**
     - Implemented `GET /api/v1/stores/me` aggregating store profile, owner details, and wallet balances with BOLA ownership guard.
     - Implemented `PATCH /api/v1/stores/me` with `UpdateStoreProfileDto` whitelisting editable profile fields (name, email, phone, address, operating hours) and rejecting mass-assignment to status or store code.
     - Test: `tests/store-self-management.spec.ts` -> **5/5 PASS**.
  2. **Task 3.2 (Store Staff Management & Anti-Role-Escalation Whitelist):**
     - Created `StoreStaffModule` (`src/store-staff/`) with controller, service, repository, and DTOs.
     - Migration: `prisma/migrations/20261025113000_allow_store_manager_in_trigger` (updated trigger `trg_validate_store_staff_role` to whitelist `STORE_MANAGER`, `STAFF_*`, and `STORE_OWNER`).
     - Implemented `GET /api/v1/store-staff-roles`, `POST /api/v1/stores/:storeId/staff`, `GET /api/v1/stores/:storeId/staff`, `PATCH /api/v1/store-staff/:id`, `DELETE /api/v1/store-staff/:id`.
     - Anti-role-escalation guard strictly rejects assigning `ADMIN` role with HTTP 403 Forbidden.
     - Test: `tests/store-staff-management.spec.ts` -> **8/8 PASS**.
  3. **Task 3.3 (Store Subscription Public Catalog & History):**
     - Created `SubscriptionPlansController` (`src/store-subscriptions/subscription-plans.controller.ts`) for public catalog browsing (`GET /api/v1/subscription-plans`).
     - Created `StoreSubscriptionsController` (`src/store-subscriptions/store-subscriptions.controller.ts`) for store subscription management:
       - `GET /api/v1/store/subscriptions`: Paginated subscription history with canonical envelope.
       - `GET /api/v1/store/subscriptions/current`: Active store subscription view.
       - `GET /api/v1/store/subscriptions/:id`: Subscription detail with strict BOLA tenant isolation.
     - Test: `tests/subscription-catalog-history.spec.ts` -> **6/6 PASS**.
  4. **Task 3.4 (Penny-Deposit Bank Account Verification Polling & History):**
     - Created `BankVerificationPollingController` (`src/bank-verification/bank-verification-polling.controller.ts`):
       - `GET /api/v1/bank-account-verifications/:id`: Single verification detail with status, countdown timer, reference code, and masked bank account.
       - `GET /api/v1/stores/:storeId/bank-account-verifications`: Paginated store verification history with canonical envelope and BOLA isolation.
     - Test: `tests/bank-verification-polling.spec.ts` -> **5/5 PASS**.

- **Phase 4: Marketplace Ecosystem & Observability (Sprint 3):**
  1. **Task 4.1 (Button Rental Payment Linking & Contract Lifecycle Expansion):**
     - Migration: `prisma/migrations/20261025120000_enable_rental_payment_transactions` (`ALTER TABLE payment_transactions ADD COLUMN rental_id BIGINT REFERENCES customer_button_rentals(rental_id)` and relaxed `order_id` to nullable).
     - Expanded `src/rentals/rentals.controller.ts`:
       - `GET /api/v1/rentals/:id`: Rental contract detail with package snapshot and timeline.
       - `POST /api/v1/rentals/:id/payment-requests`: Generates `PaymentTransaction` linked to `rentalId` with null `orderId` (ADR-1 compliance).
       - `POST /api/v1/rentals/:id/extensions`: Extends contract duration and fee atomically.
       - `POST /api/v1/rentals/:id/return-requests`: Transitions status to `RETURN_REQUESTED`.
     - Created `AdminRentalsController` (`src/rentals/admin-rentals.controller.ts`): `GET /api/v1/admin/rentals` for backoffice oversight.
     - Test: `tests/rentals-lifecycle-e2e.spec.ts` -> **7/7 PASS**.
  2. **Task 4.2 (Product Price History & Inventory Read Views):**
     - Expanded `ProductsController`: `GET /api/v1/products/:id/price-history` returning paginated price revisions.
     - Created `StoresInventoryController`: `GET /api/v1/stores/:storeId/inventory` and `GET /api/v1/stores/:storeId/inventory/low-stock` with `minAlertStock` threshold and replenishment status.
     - Test: `tests/products-price-history-inventory.spec.ts` -> **7/7 PASS**.
  3. **Task 4.3 (Store Wallet Transactions & Withdrawals Pagination, Filters & Details):**
     - Expanded `StoreWalletController` with canonical query DTOs (`type`, `status`, `fromDate`, `toDate`) and pagination envelopes.
     - Implemented `GET /api/v1/store/wallet/withdrawals/:id` with zero-plaintext AES-256 masked account snapshots.
     - Test: `tests/store-wallet.spec.ts` -> **6/6 PASS**.
  4. **Task 4.4a (Store Driver Shift Monitoring & Driver Delivery Summary):**
     - Expanded `DriverShiftsController`: `GET /api/v1/stores/:storeId/driver-shifts` with canonical pagination envelope.
     - Implemented `GET /api/v1/drivers/me/delivery-summary` computing today's completed/pending deliveries and collected COD.
     - Test: `tests/store-driver-shifts.spec.ts` -> **4/4 PASS**.
  5. **Task 4.4b (Store Customer History & CRM Module):**
     - Implemented `GET /api/v1/stores/:storeId/customers` returning store customer CRM list with canonical pagination, lifetime spend, order count, and last order date.
     - Implemented `GET /api/v1/stores/:storeId/customers/:customerId` and `PATCH /api/v1/stores/:storeId/customers/:customerId/status`.
     - Implemented `GET /api/v1/customers/me/stores` for customers to browse their transacted stores.
     - Test: `tests/store-customer-crm.spec.ts` -> **5/5 PASS**.
  6. **Task 4.4c (Store Analytics Date Range & Grouping Filters):**
     - Expanded `AnalyticsController`: `GET /api/v1/analytics/dashboard` supporting `fromDate`, `toDate`, and `groupBy` (`day`, `week`, `month`) with tenant boundary enforcement.
     - Test: `tests/store-analytics-filters.spec.ts` -> **4/4 PASS**.

- **Phase 5: Master Verification & Baseline Remediation:**
  1. **Master Test Runner Integration:**
     - Registered all 34 integration suites in [`tests/run_all_suites.ts`](file:///f:/Learning/SEM9-FPTu/backend/tests/run_all_suites.ts).
     - Total suites executed: 34. Total test assertions passing: 400+.
  2. **Baseline Suite 13 Role Escalation Fix:**
     - Cause: `tests/bank-account-verification.spec.ts` assigned `roleCode: 'STAFF'` to `StoreStaff`, violating the database trigger.
     - Fix: Assigned valid staff role `STAFF_ORDER`.
     - Verification: Standalone run passed **39/39 PASS**; Master runner passed **(28.7s)**.
  3. **Baseline Suite 5 Sequence Collision Fix:**
     - Cause: Serial sequence out of sync from explicit fixtures, causing primary key collisions (`code 23505`).
     - Fix: Synchronized PostgreSQL sequences via `scratch/fix_sequences.ts`.
     - Verification: Standalone run passed **13/13 PASS**; Master runner passed **(24.6s)**.
  4. **Baseline Suite 9 Zero-Residue Cleanup Perfection:**
     - Cause: Unhandled order deletion by `orderCode` and external background refresh tokens for `admin@smartorder.local`.
     - Fix: Expanded teardown in `tests/api.test.ts` to purge by both `orderId` and `orderCode`, and verified zero test-generated residue.
     - Verification: Standalone run passed **16/16 PASS (Delta: 0, code 0)**.

  5. **CI Isolated Database Compatibility Remediation (Suites 17, 18, 32, 34):**
     - Cause:
       - Suites 17 & 18 called `prisma.inventory.update` on a freshly created product where no inventory row existed yet, throwing `P2025: Record to update not found`.
       - Fresh isolated CI database had `orders.customer_id` defined as `NOT NULL` from baseline migration, while `schema.prisma` defined `customerId BigInt?` and guest storefront checkout (`createStorefrontOrderTx`) passes `customerId: null`, throwing PostgreSQL error `23502 (null value in column "customer_id" violates not-null constraint)`.
       - Suites 32 & 34 created test orders without explicit `customerId`, violating PostgreSQL `NOT NULL` constraint on `orders.customer_id` (`P2011`).
     - Fix:
       - Replaced `prisma.inventory.update` with `prisma.inventory.upsert` in `tests/storefront-checkout-refactor.spec.ts` and `tests/inventory-concurrency-race.spec.ts`.
       - Created database migration `prisma/migrations/20261025140000_make_order_customer_id_nullable/migration.sql` to execute `ALTER TABLE "orders" ALTER COLUMN "customer_id" DROP NOT NULL;`, aligning the database schema with `schema.prisma` and allowing guest checkout orders cleanly.
       - Ensured customer profile and passed `customerId: testCustomer.customerId` to order creations in `tests/driver-shifts-monitoring.spec.ts` and `tests/analytics-window-filters.spec.ts`.
     - Verification:
       - `npx prisma migrate deploy` — **PASS (applied 20261025140000_make_order_customer_id_nullable)**.
       - Standalone runs: Suite 17 (4/4 PASS), Suite 18 (2/2 PASS), Suite 32 (4/4 PASS), Suite 34 (4/4 PASS).
       - `npx tsc --noEmit` — **PASS (0 errors)**.

  6. **Security Audit Remediation across Tracks 1, 2 & 3 (11 Leads Hardened):**
     - **Track 1 (Auth & Invariant Boundaries):**
       - Lead 1 (`auth.google_email_fallback.account_takeover`): Made `token` mandatory in `GoogleLoginDto`; trích xuất danh tính email độc quyền từ payload đã xác thực của Google/Supabase; loại bỏ triệt để fallback email client gửi.
       - Lead 7 (`orders.storefront.minimum_total_gap`): Áp dụng ràng buộc sàn `totalAmount >= MIN_ORDER_TOTAL_VND` (2.000 VND) cho `createStorefrontOrderTx` tương đương stored procedure IoT.
       - Lead 11 (`storefront.unbounded_cardinality.shared_work`): Giới hạn `@ArrayMaxSize(50)` cho `items` và `@MaxLength(100/20/255/500)` cho các trường PII/ghi chú trong `CreateStorefrontOrderDto`.
       - Lead 2 (`payments.payos_request.missing_ownership`): Bổ sung `verifyPaymentRequestOwnership` kiểm tra quyền sở hữu transaction/order đối với người dùng trước khi gọi PayOS get/cancel.
       - Lead 5 (`tenant_reads.missing_store_binding`): Chuyển đổi kiểm tra tenant sang chế độ **Fail-Closed** (`user.role === 'ADMIN' || user.storeId === targetStoreId`) cho kho hàng, cảnh báo tồn kho, lịch sử giá và phân ca tài xế.
     - **Track 2 (Staff Roles & Session Revocation):**
       - Lead 3 (`auth.staff_revocation.stale_authority`): Chỉ tải bản ghi staff có `status: 'ACTIVE'` trong `jwt.strategy.ts`, `auth.repository.ts` và `events.gateway.ts`; lập tức thu hồi quyền store từ JWT cũ nếu nhân viên bị terminate/xóa.
       - Lead 4 (`stores.staff_role.owner_mutations`): Giới hạn `PATCH /stores/me`, tạo Category và Discount bằng `@Roles('STORE_OWNER', 'STORE_MANAGER')`, chặn nhân viên cấp thấp (`STAFF_DELIVERY`, v.v.) sửa cấu hình cửa hàng.
       - Lead 10 (`roles.system_admin.global_bypass`): Không cho phép `SYSTEM_ADMIN` tự động bypass các route được chỉ định độc quyền cho `SUPER_ADMIN`.
     - **Track 3 (Business Invariants, Concurrency & Seed Hardening):**
       - Lead 8 (`discounts.overlap.check_then_create_race`): Khóa dòng sản phẩm bằng `SELECT ... FOR UPDATE` bên trong transaction trước khi kiểm tra overlap và tạo/sửa discount, triệt tiêu hoàn toàn race condition.
       - Lead 6 (`rentals.payment_state.unbound_entitlement`): Chặn kích hoạt rental từ trạng thái chưa thanh toán trên môi trường production.
       - Lead 9 (`seed.default_admin.deployment_exposure`): Chặn chạy seed trên môi trường production và loại bỏ việc in password ra console logs.

   7. **Platform Administrator Role & Staff Token Preservation in `jwt.strategy.ts`:**
      - Cause:
        - When checking `isPlatformAdmin`, `jwt.strategy.ts` demoted platform admins (`ADMIN`, `SUPER_ADMIN`, `SYSTEM_ADMIN`) and test drivers who do not possess explicit store staff database records (`user.storeStaffs = []`) to `CUSTOMER`, causing HTTP 403 on `/admin/rentals`, `/orders/driver/*`, and `/driver-shifts/*`.
        - In `src/product-discounts/product-discounts.repository.ts`, raw locking query targeted non-existent table `products` instead of schema-mapped table `product` (`@@map("product")`), throwing PostgreSQL error `42P01: relation "products" does not exist`.
      - Fix:
        - In `src/auth/jwt.strategy.ts`, updated `isPlatformAdmin` to explicitly include `ADMIN`, `SUPER_ADMIN`, `SYSTEM_ADMIN`, preserving platform roles without demotion.
        - Preserved role & storeId from token payload for users without store staff records while strictly checking `status === 'ACTIVE'` for all users who possess store staff records (ensuring terminated/inactive staff are immediately demoted to `CUSTOMER`).
        - Corrected PostgreSQL table name from `products` to `product` in `SELECT product_id FROM product WHERE product_id = $1 FOR UPDATE` within `ProductDiscountsRepository.create` and `update`.
      - Verification:
        - `npx tsc --noEmit` — **PASS (0 errors)**.
        - `node tests/verify_all_8_audit_fixes.js` — **PASS (8/8, 100%, zero residue)**.
        - `npx tsx tests/zero-touch-provisioning.test.ts` — **PASS (13/13)**.
        - `npx tsx tests/device-templates-bulk-deploy.spec.ts` — **PASS (25/25)**.
        - `npx tsx tests/canonical-pagination-envelope.spec.ts` — **PASS (4/4)**.
        - `npx tsx tests/product-discounts-crud.spec.ts` — **PASS (7/7)**.
        - `npx tsx tests/order-filter-and-timeline.spec.ts` — **PASS (5/5)**.
        - `npx tsx tests/rentals-lifecycle-e2e.spec.ts` — **PASS (9/9)**.
        - `npx tsx tests/driver-shifts-monitoring.spec.ts` — **PASS (4/4)**.

   8. **[2026-10-26] Phase 0 Production Readiness Hardening (TX-01, CC-01, SEC-01):**
      - **TX-01 (Payout Failure Automatic Refund Invariant):**
        - In [`src/store-wallet/store-wallet.service.ts`](file:///f:/Learning/SEM9-FPTu/backend/src/store-wallet/store-wallet.service.ts): eliminated premature `FAILED` update prior to `refundFailedWithdrawal`.
        - Delegated status transition to `FAILED` strictly inside `refundFailedWithdrawal` under `SELECT ... FOR UPDATE` row locking.
        - Replaced restrictive check with monotonic guard `if (lockedWithdrawal.status === 'SUCCEEDED') return ...` to guarantee recovery of unrefunded withdrawals.
        - Enforced check ensuring no duplicate `WITHDRAWAL_REFUND` ledger transaction exists before crediting store wallet balance.
        - Sanitized error code string before persisting to `failureReason` and transaction ledger `description`.
      - **CC-01 (Database Constraints & Active Payment Invariants):**
        - Migration: [`prisma/migrations/20261026090000_concurrency_constraints_and_active_payment_invariants/migration.sql`](file:///f:/Learning/SEM9-FPTu/backend/prisma/migrations/20261026090000_concurrency_constraints_and_active_payment_invariants/migration.sql) (applied cleanly via `npx prisma migrate deploy`).
        - Added partial unique index `uq_payment_active_per_order` on `payment_transaction(order_id)` WHERE `status IN ('PENDING', 'PAID') AND order_id IS NOT NULL`.
        - Added partial unique index `uq_payment_active_per_rental` on `payment_transaction(rental_id)` WHERE `status IN ('PENDING', 'PAID') AND rental_id IS NOT NULL`.
        - Added unique index `uq_payment_transaction_code` on `payment_transaction(transaction_code)` WHERE `transaction_code IS NOT NULL`.
        - Added partial unique index `uq_default_bank_account_per_store` on `store_bank_accounts(store_id)` WHERE `is_default = true`.
        - Added check constraint `chk_store_wallets_non_negative_balance` on `store_wallets(balance >= 0 AND frozen_balance >= 0)`.
      - **SEC-01 (Secrets Hardening & Fail-Fast Lifecycle):**
        - In [`src/common/utils/crypto-vault.util.ts`](file:///f:/Learning/SEM9-FPTu/backend/src/common/utils/crypto-vault.util.ts): removed fallback encryption keys and salt. Enforced fail-fast (`throw new Error(...)`) in non-test environments when `BANK_ACCOUNT_ENCRYPTION_KEY` or `BANK_ACCOUNT_HASH_SALT` is missing.
        - In [`src/auth/jwt.strategy.ts`](file:///f:/Learning/SEM9-FPTu/backend/src/auth/jwt.strategy.ts): removed fallback JWT secret `'sob_jwt_secret_dev_2026'` and enforced fail-fast.
        - In [`src/websocket/events.gateway.ts`](file:///f:/Learning/SEM9-FPTu/backend/src/websocket/events.gateway.ts): removed fallback JWT secret `'sob_jwt_secret_dev_2026'` and enforced fail-fast.
        - In [`src/main.ts`](file:///f:/Learning/SEM9-FPTu/backend/src/main.ts): added boot-time validation for `BANK_ACCOUNT_ENCRYPTION_KEY` and `BANK_ACCOUNT_HASH_SALT` alongside `JWT_SECRET` and `OTP_PEPPER`.
        - In [`.github/workflows/ci-cd.yml`](file:///f:/Learning/SEM9-FPTu/backend/.github/workflows/ci-cd.yml): added `BANK_ACCOUNT_ENCRYPTION_KEY` and `BANK_ACCOUNT_HASH_SALT` to the CI test environment; updated server readiness probe from `/healthz` to `/readyz` for true database readiness verification.
      - **Suite 35 (`tests/p0-security-and-concurrency.spec.ts`):**
        - Verified 10/10 assertions passing: payout failure refund, refund idempotency, active payment unique index enforcement, default bank account constraint enforcement, and crypto vault fail-fast validation.

   9. **[2026-10-26] Phase 1 Database Transactions & Concurrency Invariants (TX-02, TX-03, TX-04, TX-06, CC-03):**
      - **TX-02 (Atomic Product Update, Stock & Price History):**
        - Added `updateProductAtomicTx` in [`src/products/products.repository.ts`](file:///f:/Learning/SEM9-FPTu/backend/src/products/products.repository.ts) acquiring row-level lock (`SELECT product_id FROM product WHERE product_id = $1 FOR UPDATE`).
        - Bundled product core update, inventory upsert, price history recording (`oldPrice` vs `newPrice`), and image replacement into a single transaction rollback boundary.
        - Refactored [`src/products/products.service.ts`](file:///f:/Learning/SEM9-FPTu/backend/src/products/products.service.ts) to delegate completely to `updateProductAtomicTx`.
      - **TX-03 (Atomic Rental Extension with Non-Terminal Concurrency Lock):**
        - Added `extendRentalAtomicTx` in [`src/rentals/rentals.repository.ts`](file:///f:/Learning/SEM9-FPTu/backend/src/rentals/rentals.repository.ts) with `SELECT rental_id, status FROM button_rentals WHERE rental_id = $1 FOR UPDATE`.
        - Rejects extension if rental status is in terminal state (`TERMINATED`, `CANCELLED`).
        - Atomically recalculates `monthsRented`, `endDate`, and `totalRentAmount`.
        - Satisfies `uq_payment_active_per_rental` by canceling prior `PENDING` payment before creating new extension payment.
      - **TX-04 (Store Default Bank Account Switching Invariant):**
        - In [`src/bank-verification/bank-verification.repository.ts`](file:///f:/Learning/SEM9-FPTu/backend/src/bank-verification/bank-verification.repository.ts) and [`src/store-wallet/store-wallet.repository.ts`](file:///f:/Learning/SEM9-FPTu/backend/src/store-wallet/store-wallet.repository.ts): added explicit store locking (`SELECT store_id FROM store WHERE store_id = $1 FOR UPDATE`).
        - Reset prior default account and activated new default account within an atomic transaction, guaranteeing zero race conditions against `uq_default_bank_account_per_store`.
      - **TX-06 (6-Layer DB Isolation & Repository Separation):**
        - Created [`src/store-wallet/store-wallet.repository.ts`](file:///f:/Learning/SEM9-FPTu/backend/src/store-wallet/store-wallet.repository.ts) encapsulating wallet queries, encrypted bank update, and payout finalization.
        - Refactored [`src/store-wallet/store-wallet.service.ts`](file:///f:/Learning/SEM9-FPTu/backend/src/store-wallet/store-wallet.service.ts) to delegate to repository and exposed `processPayoutWebhook`.
        - Refactored [`src/payments/payout-webhook.controller.ts`](file:///f:/Learning/SEM9-FPTu/backend/src/payments/payout-webhook.controller.ts): removed direct Prisma query execution; controller only validates headers/signature and delegates business handling to `StoreWalletService`.
      - **CC-03 (Deadlock & Transient Concurrency Retry Utility):**
        - Created [`src/common/utils/transaction-retry.util.ts`](file:///f:/Learning/SEM9-FPTu/backend/src/common/utils/transaction-retry.util.ts) detecting transient conflict codes (`P2034`, `40P01`, `40001`, `deadlock detected`, `could not serialize access`).
        - Provides `runWithTransactionRetry` with exponential backoff and randomized jitter (full jitter) to break deadlock collisions.
      - **Suite 36 (`tests/phase1-transactions-concurrency.spec.ts`):**
        - Verified 16/16 assertions passing: TX-02 atomic rollback, TX-03 serialized rental extensions, TX-04 atomic default bank switch, and CC-03 transient conflict retry.

   10. **[2026-10-26] Phase 2 Universal Idempotency Platform (IDEM-01, IDEM-02, IDEM-03):**
      - **IDEM-01 (Database Idempotency Model & Migration):**
        - Migration: [`prisma/migrations/20261026140000_add_api_idempotency_keys/migration.sql`](file:///f:/Learning/SEM9-FPTu/backend/prisma/migrations/20261026140000_add_api_idempotency_keys/migration.sql).
        - Created table `api_idempotency_keys` with `idempotency_key`, `route`, `user_id`, `request_hash`, `status_code`, `response_body` (JSONB), `status`, `locked_until`, and `expires_at`.
        - Enforced unique index `uq_api_idempotency_key_route` and index `idx_api_idempotency_expires_at`.
      - **IDEM-02 (Universal Idempotency Engine & Interceptor):**
        - Created [`src/common/idempotency/idempotency.repository.ts`](file:///f:/Learning/SEM9-FPTu/backend/src/common/idempotency/idempotency.repository.ts) with row-locking atomic acquisition and cached response replay.
        - Created [`src/common/idempotency/idempotency.service.ts`](file:///f:/Learning/SEM9-FPTu/backend/src/common/idempotency/idempotency.service.ts) with deterministic recursive key-sorted SHA-256 body hashing, IETF key validation (1..128 chars, `^[A-Za-z0-9._:-]+$`), `ConflictException` (409) for concurrent requests, and `UnprocessableEntityException` (422) for payload tampering.
        - Created [`src/common/idempotency/idempotency.interceptor.ts`](file:///f:/Learning/SEM9-FPTu/backend/src/common/idempotency/idempotency.interceptor.ts) and decorator `@Idempotent()` in [`src/common/idempotency/idempotency.decorator.ts`](file:///f:/Learning/SEM9-FPTu/backend/src/common/idempotency/idempotency.decorator.ts).
      - **IDEM-03 (Cross-Scope Endpoint Integration):**
        - Storefront checkout: [`src/orders/storefront.controller.ts`](file:///f:/Learning/SEM9-FPTu/backend/src/orders/storefront.controller.ts).
        - Payment creation: [`src/payments/payments.controller.ts`](file:///f:/Learning/SEM9-FPTu/backend/src/payments/payments.controller.ts).
        - Rental creation & extension: [`src/rentals/rentals.controller.ts`](file:///f:/Learning/SEM9-FPTu/backend/src/rentals/rentals.controller.ts).
      - **Suite 37 (`tests/phase2-idempotency-platform.spec.ts`):**
        - Verified 18/18 assertions passing: format validation, recursive hashing, in-flight 409 lock, mismatch 422 defense, cache replay, expired lock recovery, and payment/rental scope deduplication.

   11. **[2026-10-26] Phase 3 Asynchronous Queues, Exponential Retry & DLQ:**
      - **Queue Engine & Dead-Letter Queue (DLQ):**
        - Created [`src/common/queues/queue.service.ts`](file:///f:/Learning/SEM9-FPTu/backend/src/common/queues/queue.service.ts) with worker polling loop, configurable `attempts`, and exponential backoff (`delay * 2^(attempt-1)`).
        - Integrated Dead-Letter Queue (DLQ) isolating permanently failed jobs after retry exhaustion with error stack trace, failure reason, and status `'DEAD'`.
        - Created DLQ admin utilities: `getDeadLetterJobs()`, `retryDeadLetterJob()`, `clearDeadLetterJobs()`, and `getQueueStats()`.
        - Created [`src/common/queues/queue.module.ts`](file:///f:/Learning/SEM9-FPTu/backend/src/common/queues/queue.module.ts) and registered in `AppModule`.
        - Integrated non-blocking `enqueueMail` into [`src/mail/mail.service.ts`](file:///f:/Learning/SEM9-FPTu/backend/src/mail/mail.service.ts).
      - **Suite 38 (`tests/phase3-queues-retry-dlq.spec.ts`):**
        - Verified 19/19 assertions passing: non-blocking enqueue (<20ms), async processing, 3-attempt exponential retry, DLQ isolation on exhaustion, DLQ replay/recovery, and queue statistics.

   12. **[2026-10-26] Phase 4 Database Index & Query Optimization:**
      - **Composite Indexes Applied:**
        - Migration: [`prisma/migrations/20261026150000_production_query_composite_indexes/migration.sql`](file:///f:/Learning/SEM9-FPTu/backend/prisma/migrations/20261026150000_production_query_composite_indexes/migration.sql).
        - `orders`: `idx_orders_store_status_created` (`store_id`, `order_status`, `created_at DESC`), `idx_orders_customer_status_created`, `idx_orders_driver_status`, `idx_orders_order_date`.
        - `payment_transaction`: `idx_payment_tx_order_status`, `idx_payment_tx_rental_status`, `idx_payment_tx_created_at`.
        - `store_withdrawals`: `idx_store_withdrawals_store_status_created` (`store_id`, `status`, `created_at DESC`).
        - `button_rentals`: `idx_button_rentals_customer_status`, `idx_button_rentals_package_status`.
        - `product`: `idx_product_store_status_price` (`store_id`, `status`, `base_price`), `idx_product_store_cat_status`.
        - `driver_shifts`: `idx_driver_shifts_store_status_started` (`store_id`, `status`, `started_at DESC`), `idx_driver_shifts_driver_status`.
      - **Suite 39 (`tests/phase4-index-query-optimization.spec.ts`):**
        - Verified 15/15 assertions passing: verified all composite indexes live in PostgreSQL schema catalog (`pg_indexes`) and EXPLAIN query plan executed cleanly.

   13. **[2026-10-26] Phase 5 Health Probes & Graceful Drain Shutdown (OP-01, OP-02):**
      - **Liveness & Readiness Probes:**
        - In [`src/app.controller.ts`](file:///f:/Learning/SEM9-FPTu/backend/src/app.controller.ts): enhanced `/healthz` with process uptime metrics; enhanced `/readyz` with deep PostgreSQL query probe and Queue engine checks with fail-closed 503 behavior on database outage.
      - **Graceful Shutdown & Connection Draining:**
        - In [`src/main.ts`](file:///f:/Learning/SEM9-FPTu/backend/src/main.ts): registered explicit OS signal handlers for `SIGTERM` and `SIGINT` with 15-second bounded shutdown timeout, connection draining, and clean Prisma/Queue disposal via `app.close()`.
      - **Suite 40 (`tests/phase5-graceful-shutdown-health.spec.ts`):**
        - Verified 12/12 assertions passing: `/healthz` liveness, `/readyz` deep dependency checks, 503 fail-closed simulation on DB failure, and signal handler registrations.

   14. **[2026-10-26] Pre-Deployment Security & Resilience Hardening (P0/P1/P2 Fixes):**
       - **P0-1 (Google Login Account Takeover Defense):**
         - In [`src/auth/auth.service.ts`](file:///f:/Learning/SEM9-FPTu/backend/src/auth/auth.service.ts): eliminated arbitrary `dto.email` / `dto.googleId` fallback in production. Restricted fallback strictly to `NODE_ENV === 'test'`.
         - Added Google ID Token verification via Google tokeninfo endpoint validating `iss`, `aud`, `exp`, and `email_verified`.
         - Requests without verified OAuth credentials immediately throw HTTP 401 `UnauthorizedException`.
       - **P0-2 (Financial Test Isolation & Store 4 Wallet Restoration):**
         - Audited store 4 ledger transaction #3 (balance: 500,000 VND, 0 frozen) and restored `frozen_balance = 0`.
         - Completely rewrote [`tests/superpower-security-verification.spec.ts`](file:///f:/Learning/SEM9-FPTu/backend/tests/superpower-security-verification.spec.ts) to create isolated test users, stores, and wallets with zero pollution on production/existing store entities.
         - Teardown executes strictly inside `finally` block wiping all test fixtures.
       - **P0-3 (Atomic Price History Lock):**
         - In [`src/products/products.repository.ts`](file:///f:/Learning/SEM9-FPTu/backend/src/products/products.repository.ts): `updateProductAtomicTx` queries `base_price` under `SELECT ... FOR UPDATE` directly in the database transaction and uses the locked price as `oldPrice`, ignoring caller's potentially stale value.
       - **P1-4 (BullMQ Worker Lifecycle & Readiness Probe):**
         - In [`src/common/queues/queue.service.ts`](file:///f:/Learning/SEM9-FPTu/backend/src/common/queues/queue.service.ts): automatically attaches BullMQ workers for processors registered prior to `onModuleInit`; monitors Redis connection events; fail-closed `/readyz` in production when Redis is required.
       - **P1-5 (Email Retry Propagation & Sensitive DLQ Masking):**
         - In [`src/mail/mail.service.ts`](file:///f:/Learning/SEM9-FPTu/backend/src/mail/mail.service.ts): worker calls `sendMail(job.data, true)` with `throwOnError: true` so failed emails trigger BullMQ exponential retry and DLQ isolation; non-blocking enqueue for OTPs; masks 6-digit OTPs in HTML/text payloads.
       - **P1-6 (PostgreSQL DLQ Durability):**
         - Replay and clear operations in [`src/common/queues/queue.service.ts`](file:///f:/Learning/SEM9-FPTu/backend/src/common/queues/queue.service.ts) interact durably with the PostgreSQL `dead_letter_jobs` table across server restarts.
       - **P1-7 (Transaction Retry Integration):**
         - Wrapped operations in `runWithTransactionRetry` (`updateProductAtomicTx`, `extendRentalAtomicTx`, `finalizePayoutSuccessTx`, `updateBankAccountAtomicTx`, `setDefaultBankAccount`, `refundFailedWithdrawal`).
       - **P1-8 & P1-9 (Idempotency Lease Lock Token & Safe Request Handling):**
         - Applied migration `prisma/migrations/20261026170000_add_idempotency_lock_token/migration.sql` (28/28 migrations up-to-date) and updated `ApiIdempotencyKey` model in `schema.prisma`.
         - Mandatory `lockToken: string` enforced in both `finalizeSuccess` and `finalizeFailure` with `WHERE id = ? AND lock_token = ? AND status = 'PROCESSING'` (removed fallback `OR lock_token IS NULL`).
         - In `idempotency.interceptor.ts`: eliminated auto-idempotency synthesis from request body. If key is omitted and not required, request passes through directly without caching, eliminating 24h order blocking and cross-guest order collisions.
         - Unified IP resolution to trusted `req.ip` across auth controller, rate limit guards, and interceptors; configured `trust proxy` via `TRUST_PROXY` env with production default `1`.
       - **P0-Google-OAuth (Strict Audience Binding & Tokeninfo Verification):**
         - In [`src/auth/auth.service.ts`](file:///f:/Learning/SEM9-FPTu/backend/src/auth/auth.service.ts): validates access tokens via `tokeninfo?access_token=...` verifying `audience === GOOGLE_CLIENT_ID` and `email_verified === true`.
         - Added `GOOGLE_CLIENT_ID` to `.env.example`.
       - **P0-Financial-Idempotency (Mandatory Idempotency on Financial Mutations):**
         - Enforced `@Idempotent({ required: true, ttlSeconds: 86400 })` on critical financial endpoints:
           - `POST /api/v1/storefront/orders` ([storefront.controller.ts](file:///f:/Learning/SEM9-FPTu/backend/src/orders/storefront.controller.ts:25))
           - `POST /api/v1/payments/payos/create-link` ([payments.controller.ts](file:///f:/Learning/SEM9-FPTu/backend/src/payments/payments.controller.ts:39))
           - `POST /api/v1/rentals/order` ([rentals.controller.ts](file:///f:/Learning/SEM9-FPTu/backend/src/rentals/rentals.controller.ts:34))
           - `POST /api/v1/rentals/:id/payment-requests` ([rentals.controller.ts](file:///f:/Learning/SEM9-FPTu/backend/src/rentals/rentals.controller.ts:68))
           - `POST /api/v1/rentals/:id/extensions` ([rentals.controller.ts](file:///f:/Learning/SEM9-FPTu/backend/src/rentals/rentals.controller.ts:80))
           - `POST /api/v1/store/wallet/withdrawals` ([store-wallet.controller.ts](file:///f:/Learning/SEM9-FPTu/backend/src/store-wallet/store-wallet.controller.ts:56))
         - Updated client callers in test suites (`tests/storefront-checkout-refactor.spec.ts`, `tests/inventory-concurrency-race.spec.ts`, `tests/rentals-lifecycle-e2e.spec.ts`) to provide client-generated UUID `x-idempotency-key` headers.
         - In Suite 41, added real controller metadata assertions via `Reflector` verifying all 6 financial mutations mandate `{ required: true, ttlSeconds: 86400 }`.
       - **P0-Test-DB-Isolation (Strict TEST_DATABASE_URL Enforcement):**
         - In [`tests/superpower-security-verification.spec.ts`](file:///f:/Learning/SEM9-FPTu/backend/tests/superpower-security-verification.spec.ts): strictly mandates `process.env.TEST_DATABASE_URL` across all environments. If omitted, suite immediately exits (code 1) and refuses to touch development, production, or default database.
         - Multi-layer Guard:
           1. Fail-fast if `TEST_DATABASE_URL` matches `DATABASE_URL`.
           2. Fail-fast if `TEST_DATABASE_URL` points to Supabase production/cloud pooler (`supabase.co`, `supabase.com`).
           3. Require URL test marker allowlist (`test`, `localhost`, `127.0.0.1`).
         - Instantiates PrismaClient with `new PrismaClient({ datasources: { db: { url: testDatabaseUrl } } })`.
         - Strict teardown: cleanup failures are caught, logged, increment `failed++`, and throw an error rather than being silently swallowed (`.catch(() => {})`).
         - Removed global/indiscriminate deletion of `sp_user_*` at startup/teardown; cleans up strictly run-specific test entities via `createdUserId`.
       - **P1-PostgreSQL-DLQ (Authoritative Source of Truth, Rollback & Reconciliation):**
         - In [`src/common/queues/queue.service.ts`](file:///f:/Learning/SEM9-FPTu/backend/src/common/queues/queue.service.ts):
           - `getDeadLetterJobs`: Always returns PostgreSQL `dead_letter_jobs` rows if `this.prisma` is present (never falls back to memory DLQ when DB returns `[]`).
           - `clearDeadLetterJobs`: Awaits DB deletion, does not swallow DB errors, and returns DB `result.count`.
           - `retryDeadLetterJob`: On success, updates DLQ record status to `RESOLVED`. On enqueue failure, rolls back job status to `DEAD` with `failedReason: RETRY_ENQUEUE_FAILED`; if DB rollback fails, throws a critical error to alert operations.
           - `reconcileStaleRetryingJobs`: Reconciles stale `RETRYING` jobs whose lease expired back to `DEAD`.
           - `failedAt`: Mapped from `r.failedAt || r.createdAt`.
       - **P1-PayOS-Timeout (Timeout & Exception Handling Cleaned):**
         - In [`src/payments/payos-payout.service.ts`](file:///f:/Learning/SEM9-FPTu/backend/src/payments/payos-payout.service.ts):
           - Enclosed `fetch` and `response.json()` within `try` block and placed `clearTimeout(timeoutHandle)` inside `finally` block for both `createPayout` and `getPayout`.
           - Removed duplicate `if (err instanceof BadRequestException) throw err;`.
       - **P1-Google-OAuth (Production Hardening & Anti-Account-Takeover):**
         - Migration `20261026223000_add_user_auth_provider_and_subject` applied: added `auth_provider` and `provider_subject` with unique index `(auth_provider, provider_subject)`.
         - In [`src/auth/auth.service.ts`](file:///f:/Learning/SEM9-FPTu/backend/src/auth/auth.service.ts):
           - Preserves full numeric Google `sub` in `authProvider = 'GOOGLE'` and `providerSubject`.
           - Domain Authority Verification: Automatic email linking restricted to `@gmail.com`, `@googlemail.com`, or Google Workspace accounts with verified `hd` claim matching the email domain.
           - Third-party email domains without `hd` reject automatic linking with 409 `THIRD_PARTY_EMAIL_LINK_CHALLENGE` to prevent account takeover.
           - Installed `google-auth-library` and integrated `OAuth2Client.verifyIdToken({ idToken, audience })` for offline cryptographic signature, expiration, and audience verification against Google public certs.
           - Wrapped external HTTP requests with 5000ms `AbortController` timeouts and guaranteed `clearTimeout` in `finally`.
           - Enforced `GOOGLE_CLIENT_ID` in production boot validation check in [`src/main.ts`](file:///f:/Learning/SEM9-FPTu/backend/src/main.ts).
         - In Suite 41: unit tests mock external `fetch` for offline determinism and verify audience mismatch, unverified email, third-party takeover rejection, and raw numeric `providerSubject` preservation.
       - **P1-Trust-Proxy-Deployment:**
         - In [`src/main.ts`](file:///f:/Learning/SEM9-FPTu/backend/src/main.ts): added security warning when `TRUST_PROXY === 'true'` (warns against trusting entire proxy chain).
         - Documented `TRUST_PROXY=1` and `TEST_DATABASE_URL` in [`.env.example`](file:///f:/Learning/SEM9-FPTu/backend/.env.example).

    12. **[2026-10-27] Superpowers Review Fixes & Hardening (Migration Checksum, DLQ CAS, Redis Production Invariants):**
       - **Item 1: P0 Migration Checksum Integrity:**
         - Restored applied migration [`prisma/migrations/20261027003000_add_user_provider_unique_and_backfill_identities/migration.sql`](file:///f:/Learning/SEM9-FPTu/backend/prisma/migrations/20261027003000_add_user_provider_unique_and_backfill_identities/migration.sql) to its exact original LF content matching database checksum `408617a9...`.
         - Created new migration [`prisma/migrations/20261027010000_verify_provider_identity_ownership/migration.sql`](file:///f:/Learning/SEM9-FPTu/backend/prisma/migrations/20261027010000_verify_provider_identity_ownership/migration.sql) executing:
           1. Ownership conflict check: aborts with `PROVIDER_SUBJECT_OWNERSHIP_CONFLICT` if subject belongs to another user.
           2. Multiple subjects check: aborts with `MULTIPLE_PROVIDER_IDENTITIES` if one user has multiple identities for the same provider.
           3. Safe backfill: inserts only missing identities without overwriting or deleting records.
           4. Postflight check: aborts with `PROVIDER_IDENTITY_POSTFLIGHT_FAILED` if any user anchor is missing.
         - Deployed via `npx prisma migrate deploy` (32 migrations applied, `prisma migrate status` PASS).
       - **Item 2: P0 Robust DLQ Replay ID Parsing:**
         - In [`src/common/queues/queue.service.ts`](file:///f:/Learning/SEM9-FPTu/backend/src/common/queues/queue.service.ts): implemented `extractReplayDlqId(jobId: string)` helper handling IDs with internal double underscores (e.g. `dlq-replay__dlq_origin__part__<timestamp>` extracts `dlq_origin__part`).
         - Unified parsing across `handleJobCompletion` and `moveToDeadLetterQueue`.
       - **Item 3: P0 CAS Failure Path & Stale Completion Guard:**
         - In `moveToDeadLetterQueue`: DB update executes CAS with `where: { id: originalDlqId, status: 'RETRY_QUEUED', replayJobId: job.id }`; ignores stale replay failures when `result.count === 0`.
         - In both DB and memory stores (`deadLetterStore`, `unpersistedDeadLetterJobs`), mutations and completions require `replayJobId === job.id`.
         - Stale replay completion does not evict newer active replay state.
       - **Item 4: P1 Unified Production Redis Invariants:**
         - In `initRedisAndBullMQ`:
           - Prohibits `DISABLE_REDIS=true` in production (throws immediately).
           - Requires `REDIS_URL` in production (throws immediately).
           - Connection failure throws `'Redis initialization failed'`.
           - In-memory fallback permitted exclusively in `test` / `development`.
         - In `enqueueJob`: throws `'QUEUE_UNAVAILABLE'` in production when BullMQ/Redis is disconnected or unavailable.
       - **Item 5: P1 Safe DLQ Flush & Volatile Emergency Buffer:**
         - Added `isFlushingUnpersistedDlq` concurrency lock to prevent overlapping flush executions.
         - Replaced `upsert` with `create` and `P2002` duplicate key handling (verifies record exists via `findUnique` and deletes from RAM buffer without mutating existing `RESOLVED` / active states).
         - Documented in-memory store as volatile emergency buffer; readiness probe `/readyz` fails if buffer contains unflushed records.
       - **Item 6: P1 Stateful OAuth Mock in Test Suite:**
         - In [`tests/superpower-security-verification.spec.ts`](file:///f:/Learning/SEM9-FPTu/backend/tests/superpower-security-verification.spec.ts): implemented `mockCreatedUsers = new Map<bigint, any>()` store for `createGoogleUserTx`, `linkProviderSubject`, and `findUserById` to return correct dynamic emails for Gmail and Workspace logins.
       - **Item 7: P2 Unit Suite Registration:**
         - Registered `41. Superpowers Security Unit & Isolation Suite` and `42. Superpowers Security Verification & Hardening Suite` in [`tests/run_all_suites.ts`](file:///f:/Learning/SEM9-FPTu/backend/tests/run_all_suites.ts).

- **Verification Matrix:**
  - `git diff --check` — **PASS (0 whitespace / syntax errors)**
  - `npx prisma validate` — **PASS (Schema valid)**
  - `npx prisma generate` — **PASS (Prisma Client v5.22.0 generated)**
  - `npx prisma migrate status` — **PASS (32 migrations applied, database schema up to date, checksum verified)**
  - `npx tsc --noEmit` — **PASS (0 errors, strict typechecking verified)**
  - `npm run build` — **PASS (NestJS production build succeeded)**
  - `npx tsx tests/superpower-security-unit.spec.ts` — **PASS (41 passed, 0 failed, 100% assertions verified across DB CAS, DLQ parsing, flush P2002, and Redis production fail-closed matrix)**
  - `npx tsx tests/phase3-queues-retry-dlq.spec.ts` — **PASS (19 passed, 0 failed, BullMQ colon-free replay verified)**
  - **CI/CD Pipeline (GitHub Actions Run 40468806261):**
    - `🛡️ Code Quality & Build`: **PASS** in 42s (TypeScript typecheck + NestJS build).
    - `🧪 Isolated DB & Integration Tests`: **PASS** in 1m47s (All 42 test suites passed: Suite 13 Bank Verification, Suite 37 Idempotency, Suite 38 Queues/DLQ, Suite 41 Security Unit, Suite 42 Hardening).
    - `🚀 Production Deploy & Verification`: **PASS** in 4s (Deploy hook triggered, live Render `/healthz` verified HTTP 200).
  - **Live Production Service (Render):**
    - Service URL: `https://backend-fae8.onrender.com`
    - `/healthz`: HTTP 200 `{"status":"UP","uptimeSeconds":123,"timestamp":"2026-10-27T07:46:16.744Z"}`
    - `/readyz`: HTTP 200 `{"status":"READY","checks":{"database":"UP","queue":"UP"}}`
    - `/docs`: HTTP 200 (Swagger/OpenAPI UI operational)
  - **Git Status:**
    - Branch `main` committed (`8a6d328`) and pushed to `origin/main` (`https://github.com/AmazonButton/Backend.git`).
    - Working tree clean, all 32 migrations, test runners, and production deployment verified.

### [2026-10-27] Phase 1–4 Hardening: Multi-Role Analytics & Dashboard Architecture Verified
- Status: VERIFIED & READY FOR REVIEW — all P0 and P1 review items resolved, 100% strict typecheck passed, all database schema mismatches aligned, and all test suites passing.
- Issues Resolved & Hardened:
  1. **P0 Admin & System Admin Privilege Escalation Remediation:**
     - In `src/common/guards/roles.guard.ts`, removed `user.role === 'SYSTEM_ADMIN'` from the global bypass condition. Now strictly only `SUPER_ADMIN` has superuser bypass, OR `requiredRoles.includes(user.role)`.
     - Reverted `AdminController` class-level decorator from `@Roles('SUPER_ADMIN', 'SYSTEM_ADMIN', 'ADMIN')` back to `@Roles('SUPER_ADMIN')` in `src/admin/admin.controller.ts`.
     - Added granular method-level `@Roles('SUPER_ADMIN', 'SYSTEM_ADMIN', 'ADMIN')` strictly to the 5 read-only dashboard & analytics endpoints (`getDashboard`, `getRevenueAnalytics`, `getGrowthAnalytics`, `getOperationsAnalytics`, `getStoresLeaderboard`).
     - Preserved class-level `@Roles('SUPER_ADMIN')` on sensitive mutations (`approveStore`, `rejectStore`, `updateUserStatus`, `updateUserRole`, `rejectWithdrawal`, `payoutViaPayOS`, `estimatePayout`, `batchPayout`).
     - Suite 44 Section 6 expanded to cover all 8 RBAC matrix combinations:
       - `ADMIN` calls dashboard -> allowed (200)
       - `SYSTEM_ADMIN` calls dashboard -> allowed (200)
       - `ADMIN` calls payoutViaPayOS -> 403 Forbidden
       - `ADMIN` calls updateUserRole -> 403 Forbidden
       - `SYSTEM_ADMIN` calls payoutViaPayOS -> 403 Forbidden
       - `SYSTEM_ADMIN` calls updateUserRole -> 403 Forbidden
       - `SUPER_ADMIN` calls payoutViaPayOS -> allowed
       - `SUPER_ADMIN` calls updateUserRole -> allowed
  2. **P1 Inventory DTO Contract Alignment:**
     - Aligned `InventoryAnalyticsQueryDto` in `src/analytics/dto/analytics-drilldown-query.dto.ts` with `AnalyticsService` and `AnalyticsRepository` implementations:
       - `page` (`@IsInt()`, `@Min(1)`, default 1).
       - `pageSize` (`@IsInt()`, `@Min(1)`, `@Max(100)`, default 20).
       - `filter?: 'low_stock' | 'out_of_stock'` (`@IsIn(['low_stock', 'out_of_stock'])`).
       - `storeId?: string` (`@Matches(/^[1-9]\d*$/)`).
  3. **P1 Admin Stores Leaderboard DTO Validation Hardening:**
     - In `src/admin/dto/admin-analytics-query.dto.ts`, upgraded `AdminStoresLeaderboardQueryDto`: replaced `@IsNumber()` with `@IsInt()`, `@Min(1)`, and added `@Max(100)` on `pageSize`. Rejects floating numbers (e.g. 1.5) and enforces query cap <= 100.
  4. **P1 Slow-Moving Product Aggregation Fix:**
     - In `src/analytics/analytics.repository.ts`, updated line 535 to `COALESCE(SUM(oi.quantity) FILTER (WHERE o.order_id IS NOT NULL), 0)::int AS units_sold` so cancelled/rejected orders and items outside the date range are excluded from sold unit aggregates.
  5. **P1 Cache Invalidation Pipeline Hardening & Whole-Dashboard Coverage:**
     - In `src/orders/orders.service.ts`:
       - `createStorefrontOrder`: Fixed customer cache invalidation to use customer's `userId` (`customerUserBigInt.toString()`) instead of customer profile id.
       - Added awaited `invalidateDashboardCaches(order.storeId, customerUserId)` call in `cancelOrder`.
       - Added customer userId and awaited `invalidateDashboardCaches` call in `claimOrder`.
       - Awaited all cache invalidations in `updateOrderStatus`, `completeDelivery`, `failDelivery`, and `handleButtonEvent`.
     - In `src/admin/admin.service.ts`:
       - Replaced empty `catch (_) {}` with `this.logger.warn` logging safe error messages without sensitive data leaks.
       - Awaited all `invalidateAdminAndStoreCaches` calls across store approvals/rejections, withdrawal rejections, and payouts.
     - In `src/products/products.service.ts`: Injected `DashboardCacheService` and added `await this.invalidateProductCaches(storeId)` on product creation, updates, and stock adjustments.
     - In `src/devices/devices.service.ts`: Injected `DashboardCacheService` and added `await this.invalidateDeviceCaches(storeId)` on device creation, update, remove, pair, and product assign.
     - In `src/store-wallet/store-wallet.service.ts`: Injected `DashboardCacheService` and added `await this.invalidateWalletCaches(storeId)` on withdrawal request submission.
     - In `src/staff/staff.service.ts`: Cache key format structured as `staff:dashboard:store:${storeId}:user:${userId}:role:${role}`.
  6. **P1 Canonical Domain Order Status Standardization:**
     - Checked PostgreSQL database: verified 0 legacy records with `READY` or `DELIVERING` exist.
     - Replaced all legacy statuses with canonical statuses across `analytics.repository.ts`, `admin.repository.ts`, `customers.repository.ts`, `staff.repository.ts`, and `drivers.service.ts`.
     - Zero occurrences of `'DELIVERING'` or legacy `'READY'` remain in the codebase.
     - Suite 44 Section 8 added, verifying strict domain canonical status invariants.
  7. **P1 Admin & Staff User Metrics Accuracy:**
     - In `src/admin/admin.repository.ts`, counted `admins` through active `store_staff` JOIN `roles` where `role_code IN ('SUPER_ADMIN', 'SYSTEM_ADMIN', 'ADMIN')` and seed admin, and restricted `staff` count to operational roles (`STAFF_ORDER`, `STAFF_INVENTORY`, `STAFF_BUTTON`, `STAFF_DELIVERY`, `STORE_STAFF`), excluding admin memberships.
  8. **Raw SQL Schema Alignment (PostgreSQL/Prisma):**
     - Aligned all column and table names across queries: `c.category_name`, `order_item`, `oi.item_subtotal`, `store_wallets`, `sw.withdrawal_id AS id`, `wt.type AS transaction_type`, `roles.role_code`, `order_status_history.changed_at`, `identity_verification_sessions`.
     - Fixed financial comparison formula: money vs money (GMV to GMV, realized to realized, net to net).
  9. **Suite 44 Contract & Verification Expansion:**
     - Expanded Suite 44 (`tests/analytics-dashboard-e2e.spec.ts`) with Section 6 (RBAC Privilege Escalation Guards on AdminController, 8 matrix checks), Section 7 (Drill-Down DTO Validation Constraints), and Section 8 (Canonical Domain Order Status Invariants). Total assertions: **53/53 PASS**.
- Verification Evidence:
  - `npx tsc --noEmit` — **PASS (0 errors, strict typechecking verified repository-wide)**
  - `npm run build` — **PASS (NestJS production build succeeded)**
  - `npx prisma validate` — **PASS (Prisma schema valid)**
  - `npx prisma migrate status` — **PASS (33 migrations applied, database schema up to date)**
  - `npx tsx tests/analytics-dashboard-e2e.spec.ts` — **PASS (53/53 assertions verified)**
  - `npx tsx tests/analytics-foundation-unit.spec.ts` — **PASS (30/30 assertions verified)**
  - `npx tsx tests/superpower-security-unit.spec.ts` — **PASS (41/41 assertions verified)**
  - `git diff --check` — **PASS (0 whitespace or formatting errors)**
- Current Repository State:
  - Working tree has uncommitted verified changes. No commits or pushes have been performed.
  - Awaiting Tris's review and approval before committing or pushing.

### [2026-10-28] Cache Invalidation Hardening & Acceptance Verification (P1 Resolved)
- Status: VERIFIED & READY FOR REVIEW — all 4 cache invalidation bugs resolved, public business method tests implemented and passing (87/87 in Suite 44).
- Issues Resolved:
  1. **CustomerProfile ID vs User ID in Rentals Cache Invalidation:**
     - In `src/rentals/rentals.repository.ts`, `createRental` now includes `customer: { select: { customerId: true, userId: true } }`.
     - In `src/rentals/rentals.service.ts`, all 5 rental mutations (`createRentalContract`, `extendRentalContract`, `requestRentalReturn`, `activateRental`, `updateRentalStatusAdmin`) invalidate cache using `rental.customer?.userId` (user ID), eliminating all fallbacks to `customerId` (profile ID).
  2. **Device Mutations Owner User ID Invalidation:**
     - In `src/devices/devices.service.ts`, all device mutations (`registerDevice`, `update`, `remove`, `pair`, `assignProduct`, `unassignProduct`, `disable`, `enable`, `toggleStatus`, `customerUpdateConfig`, `updateBattery`, `toggleDeviceStatus`) extract device entity via `assertDeviceAccess` and invalidate cache using `button.customer?.userId` (owner's user ID) and `button.storeId`.
     - Staff/admin performing operations on behalf of customers no longer incorrectly pass operator's user ID.
     - Dual-store invalidation in `customerUpdateConfig`: remap from store A to store B invalidates both `before.storeId` and `after.storeId`, plus owning customer.
  3. **Exact Key vs Prefix Invalidation (Preventing Prefix Collisions):**
     - In `src/common/cache/dashboard-cache.service.ts`, added `invalidateKey(key: string): Promise<void>` for exact key deletion in memory and Redis (`DEL`).
     - In `devices.service.ts` and `rentals.service.ts`, customer cache invalidation uses exact keys: `customer:dashboard:${id}` and drill-down `customer:devices:${id}` / `customer:rentals:${id}`.
     - In `orders.service.ts`, changed customer dashboard invalidation to `invalidateKey('customer:dashboard:' + id)` while keeping prefix for orders with daily dates `customer:orders:${id}:`.
     - Prevents prefix collision where invalidating user `7` mistakenly deletes cache of user `77` or `700`.
  4. **Direct Cache Invalidation on Withdrawal Refund:**
     - In `src/store-wallet/store-wallet.service.ts`, wrapped `runWithTransactionRetry` in `refundFailedWithdrawal` to capture result and execute `await this._invalidateWalletForWithdrawal(rawId)` post-commit.
     - All refund paths (direct call, PayOS payout error webhook, sync status) reliably clear store wallet and admin dashboard caches after transaction commit.
     - Maintained full concurrency guards: row-level locking (`SELECT FOR UPDATE`), terminal status monotonicity, and duplicate ledger prevention.
  5. **Suite 44 Acceptance Test Suite Expansion (Section 9):**
     - Replaced private helper assertions with public business method E2E verification:
       - Creating rental with `customerId: 7`, `userId: 99` clears customer 99 dashboard and rentals drilldown; customer 7 remains intact.
       - All 5 rental mutations verified to clear dashboard and rentals drilldown.
       - Staff 500 modifying device of customer 99 in store 42 clears store 42 and customer 99 cache; staff 500 and other stores stay intact.
       - Device remap clears old store, new store, and device owner.
       - User 7 vs 77: `invalidateKey('customer:dashboard:7')` keeps `customer:dashboard:77`.
       - Direct `refundFailedWithdrawal` call clears store wallet cache post-commit.
       - Cache failure resilience: mutation succeeds even if cache invalidation throws.
       - Unauthorized mutation rejected before DB leaves cache untouched.
       - Read after mutation: fetcher re-runs and returns fresh data.
- Verification Evidence:
  - `npx tsc --noEmit` — **PASS (0 errors, clean repository-wide typecheck)**
  - `npm run build` — **PASS (NestJS production build succeeded)**
  - `npx prisma validate` — **PASS (Prisma schema valid)**
  - `npx prisma migrate status` — **PASS (33 migrations applied, up-to-date)**
  - `npx tsx tests/analytics-dashboard-e2e.spec.ts` (Suite 44) — **PASS (87/87 assertions verified)**
  - `npx tsx tests/analytics-foundation-unit.spec.ts` (Suite 43) — **PASS (30/30 assertions verified)**
  - `npx tsx tests/superpower-security-unit.spec.ts` (Suite 41) — **PASS (41/41 assertions verified)**
  - `git diff --check` — **PASS (0 whitespace or syntax errors, CRLF/LF notices only)**
- Current Repository State:
  - Working tree has uncommitted verified changes. No commits or pushes have been performed.
  - Awaiting Tris's review and instruction before any commit or push.
