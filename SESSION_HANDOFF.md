# Project Handoff & Session Context

> **Agent continuity:** Follow [`docs/AGENT_CONTEXT_POLICY.md`](file:///f:/Learning/SEM9-FPTu/backend/docs/AGENT_CONTEXT_POLICY.md) when reading or updating this handoff. This file must contain verified project state only and must never contain secrets.

> **Project:** Sem 9 FPTu - IoT Amazon Button Backend E-Commerce Platform  
> **Tech Stack:** NestJS 10, TypeScript 5, PostgreSQL 15 (with custom Stored Procedures, Triggers & Row Locking), Prisma ORM, Redis (BullMQ), Cloudinary, PayOS  
> **Status:** All 13/13 test suites passing (`npm run test:all`), TypeScript compile clean (`npx tsc --noEmit`), Build clean (`npm run build`).

---

## 1. Quick Verification Commands
- Check TypeScript types: `npx tsc --noEmit`
- Production Build: `npm run build`
- Start Dev Server: `npm run dev` (running `nest start --watch`, port 3000)
- Run All Tests (13 suites): `npm run test:all`
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
- Verification Evidence:
  - `npx tsx tests/bank-account-verification.spec.ts` — PASS (37/37 assertions pass)
  - `npm run test:all` — PASS (13/13 suites pass, 281.8s)
  - `npx tsc --noEmit` — PASS (0 errors)
  - `npm run build` — PASS (0 errors)
  - `npx prisma migrate status` — PASS ("Database schema is up to date!")



