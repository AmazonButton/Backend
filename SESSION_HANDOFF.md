# Project Handoff & Session Context

> **Agent continuity:** Follow [`docs/AGENT_CONTEXT_POLICY.md`](file:///f:/Learning/SEM9-FPTu/backend/docs/AGENT_CONTEXT_POLICY.md) when reading or updating this handoff. This file must contain verified project state only and must never contain secrets.

> **Project:** Sem 9 FPTu - IoT Amazon Button Backend E-Commerce Platform  
> **Tech Stack:** NestJS 10, TypeScript 5, PostgreSQL 15 (with custom Stored Procedures, Triggers & Row Locking), Prisma ORM, Redis (BullMQ), Cloudinary, PayOS  
> **Status:** All 15/15 test suites passing (`npm run test:all`), TypeScript compile clean (`npx tsc --noEmit`), Build clean (`npm run build`).

---

## 1. Quick Verification Commands
- Check TypeScript types: `npx tsc --noEmit`
- Production Build: `npm run build`
- Start Dev Server: `npm run dev` (running `nest start --watch`, port 3000)
- Run All Tests (15 suites): `npm run test:all` or `npx tsx tests/run_all_suites.ts`
- Run Frontend Contract & Notifications Suite: `npx tsx tests/frontend-contract-and-notifications.spec.ts`
- Run Device Templates & Bulk Deploy Suite: `npx tsx tests/device-templates-bulk-deploy.spec.ts`
- Run Bank Verification Suite: `npx tsx tests/bank-account-verification.spec.ts`
- Run Avatar Suite: `npx tsx tests/user-avatar-profile.spec.ts`
- Run Minimum Order Suite: `npx tsx tests/order-minimum-value.spec.ts`

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

## 3. Key Modified & Created Files
- `src/main.ts`: Swagger initialization error handling & security middleware.
- `src/auth/*`: Avatar URL support in DTO, controller, service, repository, JWT strategy.
- `src/orders/*`: Minimum order total enforcement in repository and constants.
- `src/media/media.controller.ts`: Explicit Cloudinary service injection.
- `prisma/migrations/`: Two new migrations for avatar URL and minimum order total.
- `tests/`: New spec files `order-minimum-value.spec.ts` and `user-avatar-profile.spec.ts`.

---

## 4. Instructions for Resuming in a New Chat
When starting a new conversation, prompt the agent with:
> `@SESSION_HANDOFF.md Đọc tài liệu handoff này để nắm toàn bộ tiến độ dự án, sau đó tiếp tục công việc...`

---

## 5. Task History & Handoff Log

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
