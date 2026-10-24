# Bank Account Verification & Store Withdrawal Payout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement an end-to-end, bank-grade, secure Store Bank Account Verification (via 2,000 VND penny-deposit) and Store Withdrawal Payout system with encrypted credentials, row-level locking (`SELECT FOR UPDATE`), strict idempotency, timing-safe PayOS webhook verification, and zero account number leakage.

**Architecture:** 
- **Layered Architecture:** Follows the 6-layer Security-by-Design standard (`Router -> Guard/Validation -> Controller -> Service -> Repository -> PostgreSQL / Redis`).
- **Data Security:** AES-256-GCM encryption for bank account numbers, SHA-256 hashing for lookups, masking for public displays (`*******12301`). Zero plaintext storage.
- **Financial Concurrency Safety:** Explicit PostgreSQL transactions (`BEGIN ... COMMIT / ROLLBACK`), row-locking (`SELECT FOR UPDATE`) on `store_wallets` and `store_withdrawals`, atomic status transitions, and frozen balance bookkeeping (`balance` -> `frozenBalance` -> release on success or refund on failure).

**Tech Stack:** NestJS 10, TypeScript 5, Prisma ORM, PostgreSQL 15, Redis 7 (ioredis), PayOS Node SDK / REST API, VietQR API, Crypto (AES-256-GCM, SHA-256, timingSafeEqual).

**Spec:** User 8-stage roadmap specification covering Data Modeling, Bank Lookup, Ownership Verification (2,000 VND), Secure Withdrawal Creation, PayOS Payout, PayOS Payout Webhook, Route Decommissioning, and Integration Testing.

## Global Constraints

- **Two-Phase Migration:** Add new encrypted/snapshot columns and backfill existing data first. Cột plaintext `bank_account_number` được giữ lại và chuyển thành nullable/deprecated, chỉ được xóa ở migration riêng sau khi hệ thống production ổn định.
- **Frozen Balance Conservation Invariant:**
  - Tạo withdrawal: `balance -= amount`, `frozenBalance += amount`.
  - Payout thành công: `frozenBalance -= amount` (tuyệt đối không cộng lại vào `balance`).
  - Payout thất bại: `frozenBalance -= amount`, `balance += amount` (hoàn tiền đúng 1 lần, ghi ledger `WITHDRAWAL_REFUND`).
- **Penny-Deposit Ownership:** Tra cứu tên tài khoản (Lookup) chỉ là kiểm tra định dạng và sự tồn tại của tài khoản, tuyệt đối KHÔNG ĐƯỢC coi là đã xác minh quyền sở hữu (`OWNERSHIP_VERIFIED`). Chỉ cấp `OWNERSHIP_VERIFIED` khi người dùng chuyển đúng 2.000 VND và webhook/sync đối soát thành công.
- **Route Decommissioning:** Endpoint `POST /api/v1/admin/withdrawals/:id/transfer` phải được đánh dấu `@deprecated` trước, chuyển đổi giao diện Admin/Frontend sang route PayOS payout, rồi mới gỡ bỏ để tránh breaking change.
- **Webhook Specification:** Payload và chữ ký webhook PayOS phải tuân thủ chuẩn xác tài liệu chính thức của PayOS với HMAC-SHA256 và `crypto.timingSafeEqual`.
- **Database Isolation:** Tất cả test mutation chỉ chạy trên database test cô lập của CI/Staging, tuyệt đối không chạy mutation trên database production.
- **Sequential Execution Gate:** Triển khai tuần tự trong phiên làm việc hiện tại, mỗi task đều chạy typecheck (`npx tsc --noEmit`), migration check và test verification trước khi chuyển sang task kế tiếp. Không bắt đầu chỉnh code cho đến khi có xác nhận.

## Review Focus

1. **Negative Wallet Balance Race:** Two simultaneous withdrawal requests for the same store wallet; must lock row with `SELECT FOR UPDATE` and reject the second with HTTP 400 when available balance is insufficient.
2. **Duplicate Idempotency Key:** Repeating a withdrawal request with the same `Idempotency-Key` header; must return the existing record atomically without deducting balance twice.
3. **Webhook Replay / Out-of-Order Delivery:** Webhook arrives with `FAILED` after status is already `SUCCEEDED`, or arrives repeatedly; must be idempotent and must not downgrade terminal success state or double-refund.
4. **Account Number Leakage in Audit / DTOs:** Full account number exposed in wallet transaction descriptions, error logs, or admin lists; must strictly use masked string (`*******12301`) or DTO mappers.
5. **PayOS Payout Failure Stuck State:** Network failure or PayOS 601 error during payout initiation; must immediately transition to `FAILED`, refund `frozenBalance` to `balance`, and record `WITHDRAWAL_REFUND` ledger entry.

---

### Task 1: Data Model Standardization, Encryption & Safe Two-Phase Migration (Stage 1)

**Files:**
- Modify: `prisma/schema.prisma:562-595,793-815`
- Create: `prisma/migrations/20261024170000_standardize_bank_account_and_withdrawal/migration.sql`
- Test: `tests/bank-account-verification.spec.ts`

**Interfaces:**
- Consumes: Existing `StoreBankAccount` and `StoreWithdrawal` models in Prisma.
- Produces: Updated schema with `accountNumberEncrypted`, `accountNumberHash`, `bankAccountId`, snapshot fields (`bankAccountEncrypted`, `bankAccountHash`, `bankAccountMasked`, `bankAccountNameSnapshot`, `bankBinSnapshot`, `bankNameSnapshot`), indexes on `accountNumberHash`, `idempotencyKey`, `providerReferenceId`. Plaintext `bankAccountNumber` retained as nullable/deprecated.

- [ ] **Step 1: Write failing schema compilation / migration test**
Assert that `StoreWithdrawal` contains `bankAccountEncrypted`, `bankAccountMasked`, and `bankAccountId` relation, and supports encrypted snapshots while retaining backwards-compatible nullable plaintext column.

- [ ] **Step 2: Run test / typecheck to verify failure**
Run: `npx prisma validate`
Expected: Passes once schema is updated; verifies missing fields before edit.

- [ ] **Step 3: Update `prisma/schema.prisma`**
Add encrypted/snapshot columns to `StoreWithdrawal`, update `StoreBankAccount` indexes, and mark old `bankAccountNumber` as nullable/deprecated (không xóa cột plaintext ở phase 1).

- [ ] **Step 4: Create & execute database migration with backfill**
Generate SQL migration that adds snapshot columns, backfills existing rows with encrypted data via `encryption.util.ts`, verifies decryption success, and adds composite indexes on `account_number_hash`, `idempotency_key`, and `provider_reference_id`.
Run: `npx prisma migrate dev --name standardize_bank_account_and_withdrawal` or `npx prisma db push`
Expected: Migration executes cleanly.

- [ ] **Step 5: Run `npx prisma generate` and verify Prisma Client**
Run: `npx prisma generate`
Expected: Prisma Client updated with new model types.

- [ ] **Step 6: Run Typecheck and Test Verification**
Run: `npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 7: Commit Task 1**
```bash
git add prisma/ .
git commit -m "feat(database): standardize bank account and withdrawal models with encrypted snapshots (phase 1 safe migration)"
```

---

### Task 2: Hardened Bank Account Lookup (Stage 2)

**Files:**
- Modify: `src/bank-verification/store-bank-accounts.controller.ts`
- Modify: `src/bank-verification/bank-verification.service.ts`
- Modify: `src/bank-verification/providers/vietqr.provider.ts`
- Modify: `src/bank-verification/dto/bank-verification.dto.ts`
- Test: `tests/bank-account-verification.spec.ts`

**Interfaces:**
- Consumes: VietQR API credentials, Redis rate limiter, encryption utility.
- Produces: `POST /api/v1/stores/bank-accounts/lookup` responding with `{ success: true, data: { bankBin, bankName, accountNumberMasked, accountName } }` or `{ success: false, errorCode: "BANK_LOOKUP_UNAVAILABLE", message: "..." }`.

- [ ] **Step 1: Write failing unit/integration tests for Bank Lookup**
Test cases:
- Lookup returns masked account number (`*******12301`) and verified account name.
- Provider failure returns HTTP 400/503 with `errorCode: BANK_LOOKUP_UNAVAILABLE`.
- Never falls back to user profile name.
- Enforces rate limiting per IP and per user via `BankLookupRateLimitGuard`.
- Redacts account number in all logs.

- [ ] **Step 2: Run test to verify failure**
Run: `npx tsx tests/bank-account-verification.spec.ts`
Expected: Fails on strict error shape or unmasked data.

- [ ] **Step 3: Implement hardened lookup in `bank-verification.service.ts`**
- Remove any fallback logic that populates `accountName` with `user.fullName`.
- Strip sensitive account digits before logging.
- Set timeout on outbound HTTP request (4000ms).
- Add 5-minute Redis cache for identical `(bankBin, accountNumberHash)` lookups to reduce provider load.

- [ ] **Step 4: Run test to verify passes**
Run: `npx tsx tests/bank-account-verification.spec.ts`
Expected: PASS with 0 account leaks.

- [ ] **Step 5: Commit Task 2**
```bash
git add src/bank-verification/ tests/bank-account-verification.spec.ts
git commit -m "feat(bank-lookup): enforce strict provider verification, masking, rate limits, and zero name fallback"
```

---

### Task 3: Ownership Verification via 2,000 VND Penny-Deposit (Stage 3)

**Files:**
- Modify: `src/bank-verification/store-bank-accounts.controller.ts`
- Modify: `src/bank-verification/bank-verification.service.ts`
- Modify: `src/bank-verification/bank-verification.repository.ts`
- Modify: `src/store-wallet/store-wallet.controller.ts`
- Modify: `src/store-wallet/store-wallet.service.ts`
- Test: `tests/bank-account-verification.spec.ts`

**Interfaces:**
- Consumes: Looked-up bank account, PayOS webhook / transfer monitor.
- Produces: 
  - `POST /api/v1/stores/bank-accounts/verification` (Creates 2,000 VND transfer request).
  - `POST /api/v1/webhooks/bank-verification` (Receives 2,000 VND payment, transitions to `OWNERSHIP_VERIFIED`).
  - `POST /api/v1/stores/bank-accounts/verification/:id/cancel`
  - `GET /api/v1/stores/:storeId/bank-accounts`
  - Decommissions/locks arbitrary `PUT /api/v1/store/wallet/bank-account`.

- [ ] **Step 1: Write failing test for ownership verification & PUT route lockdown**
Assert that saving a bank account directly via `PUT /api/v1/store/wallet/bank-account` is rejected or requires prior `OWNERSHIP_VERIFIED` status, and cannot inject arbitrary `accountName`.

- [ ] **Step 2: Run test to verify failure**
Run: `npx tsx tests/bank-account-verification.spec.ts`
Expected: Fails because legacy route accepts arbitrary name.

- [ ] **Step 3: Implement strict verification flow in `bank-verification.service.ts` & `store-wallet.service.ts`**
- Require `lookupId` or verified lookup session before creating verification request.
- Set amount strictly to `2000` VND (`BANK_VERIFICATION_AMOUNT_VND`).
- In `PUT /api/v1/store/wallet/bank-account`, deprecate or require `bankAccountId` of an already `OWNERSHIP_VERIFIED` account.

- [ ] **Step 4: Run test to verify passes**
Run: `npx tsx tests/bank-account-verification.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit Task 3**
```bash
git add src/bank-verification/ src/store-wallet/ tests/bank-account-verification.spec.ts
git commit -m "feat(bank-verification): enforce 2,000 VND penny-deposit ownership flow and lock legacy bank update"
```

---

### Task 4: Secure Idempotent Store Withdrawal Creation (Stage 4)

**Files:**
- Modify: `src/store-wallet/store-wallet.controller.ts`
- Modify: `src/store-wallet/store-wallet.service.ts`
- Modify: `src/store-wallet/dto/store-wallet.dto.ts`
- Test: `tests/e2e-marketplace-ecosystem.spec.ts`
- Create: `tests/withdrawal-concurrency-idempotency.spec.ts`

**Interfaces:**
- Consumes: Header `Idempotency-Key`, `StoreWallet`, `StoreBankAccount` (must be `OWNERSHIP_VERIFIED`).
- Produces: `POST /api/v1/store/wallet/withdrawals` returning masked snapshot, creating `PENDING` withdrawal, moving funds from `balance` to `frozenBalance` within `SELECT FOR UPDATE` transaction.

- [ ] **Step 1: Write failing concurrency and idempotency tests**
- Concurrent requests for 100k balance attempting 2x 80k withdrawals: only 1 succeeds, second fails with HTTP 400 (insufficient balance).
- Same request with identical `Idempotency-Key`: returns existing withdrawal with HTTP 200 without double-deduction.
- Withdrawal rejected if account is not `OWNERSHIP_VERIFIED`.

- [ ] **Step 2: Run test to verify failure**
Run: `npx tsx tests/withdrawal-concurrency-idempotency.spec.ts`
Expected: Fails due to missing `frozenBalance` or balance concurrency check.

- [ ] **Step 3: Implement transactional withdrawal creation with `frozenBalance` in `store-wallet.service.ts`**
- Enforce `@Headers('Idempotency-Key')`.
- Start explicit transaction: `SELECT * FROM store_wallets WHERE store_id = $1 FOR UPDATE`.
- Verify `balance >= amount` and `amount >= 50000`.
- Deduct `amount` from `balance`, add `amount` to `frozenBalance`.
- Fetch `StoreBankAccount` with `verificationStatus === 'OWNERSHIP_VERIFIED'`.
- Insert `StoreWithdrawal` with encrypted snapshot, masked account, status `PENDING`.
- Create `WalletTransaction` with type `WITHDRAWAL_HOLD` (no account digits in description).

- [ ] **Step 4: Run test to verify passes**
Run: `npx tsx tests/withdrawal-concurrency-idempotency.spec.ts`
Expected: PASS (concurrency and idempotency immune).

- [ ] **Step 5: Commit Task 4**
```bash
git add src/store-wallet/ tests/withdrawal-concurrency-idempotency.spec.ts
git commit -m "feat(withdrawals): implement frozen balance locking, idempotency check, and encrypted snapshots"
```

---

### Task 5: Single-Path PayOS Payout Execution (Stage 5)

**Files:**
- Modify: `src/admin/admin.controller.ts`
- Modify: `src/admin/admin.service.ts`
- Modify: `src/admin/admin.repository.ts`
- Modify: `src/payments/payments.service.ts`
- Test: `tests/withdrawal-concurrency-idempotency.spec.ts`

**Interfaces:**
- Consumes: Admin user JWT, `withdrawalId`, PayOS Payout credentials.
- Produces: `POST /api/v1/admin/withdrawals/:id/payout` executing atomic transition `PENDING -> PROCESSING`, calling PayOS, or rolling back to `FAILED` with instant refund on initiation error.

- [ ] **Step 1: Write failing test for payout initiation**
- Transition from `PENDING` to `PROCESSING` is atomic (cannot trigger twice).
- If PayOS returns an error (e.g. 601 / not configured), status transitions to `FAILED`, `frozenBalance` is released back to `balance`, and ledger record `WITHDRAWAL_REFUND` is created.
- Never leaves withdrawal stuck in `PROCESSING` on initiation failure.

- [ ] **Step 2: Run test to verify failure**
Run: `npx tsx tests/withdrawal-concurrency-idempotency.spec.ts`
Expected: Fails.

- [ ] **Step 3: Implement atomic payout trigger in `admin.service.ts`**
- Use `UPDATE store_withdrawals SET status = 'PROCESSING' WHERE withdrawal_id = $1 AND status = 'PENDING' RETURNING *`.
- If 0 rows updated, throw ConflictException (`Yêu cầu rút tiền không ở trạng thái PENDING hoặc đang được xử lý`).
- Call PayOS API with fixed unique reference: `providerReferenceId`.
- On PayOS success: record `providerPayoutId`.
- On PayOS catch/error: run refund transaction restoring `frozenBalance` -> `balance` and set status `FAILED`.

- [ ] **Step 4: Run test to verify passes**
Run: `npx tsx tests/withdrawal-concurrency-idempotency.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit Task 5**
```bash
git add src/admin/ src/payments/ tests/withdrawal-concurrency-idempotency.spec.ts
git commit -m "feat(payout): implement atomic PENDING to PROCESSING flow with fail-closed refund on provider error"
```

---

### Task 6: Secure PayOS Payout Webhook (Stage 6)

**Files:**
- Create: `src/payments/payout-webhook.controller.ts`
- Modify: `src/payments/payments.module.ts`
- Modify: `src/payments/payments.service.ts`
- Test: `tests/withdrawal-concurrency-idempotency.spec.ts`

**Interfaces:**
- Consumes: `POST /api/v1/webhooks/payos/payout` with raw body and HMAC-SHA256 signature header.
- Produces: Idempotent processing of payout finalization (`SUCCEEDED` / `FAILED`), releasing `frozenBalance`, recording audit log.

- [ ] **Step 1: Write failing tests for Payout Webhook**
- Invalid signature returns HTTP 401/400.
- Duplicate webhook execution does not release or refund twice.
- Webhook cannot downgrade a `SUCCEEDED` withdrawal to `FAILED`.
- `SUCCEEDED`: decrements `frozenBalance`, leaves `balance` unchanged.
- `FAILED`: refunds `frozenBalance` back to `balance` exactly once.

- [ ] **Step 2: Run test to verify failure**
Run: `npx tsx tests/withdrawal-concurrency-idempotency.spec.ts`
Expected: Fails due to missing endpoint.

- [ ] **Step 3: Implement `payout-webhook.controller.ts` & handler in `payments.service.ts`**
- Read raw payload buffer, compute HMAC-SHA256 using `PAYOS_PAYOUT_CHECKSUM_KEY`.
- Compare signatures using `crypto.timingSafeEqual`.
- In transaction with `SELECT FOR UPDATE` on `store_withdrawals`:
  - If already in target status, return 200 (idempotent).
  - If currently `SUCCEEDED`, ignore `FAILED` events.
  - If event is `PAID` / `SUCCEEDED`: update `status = 'SUCCEEDED'`, `frozenBalance -= amount`.
  - If event is `FAILED`: update `status = 'FAILED'`, `frozenBalance -= amount`, `balance += amount`, write `WITHDRAWAL_REFUND` ledger.

- [ ] **Step 4: Run test to verify passes**
Run: `npx tsx tests/withdrawal-concurrency-idempotency.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit Task 6**
```bash
git add src/payments/ tests/withdrawal-concurrency-idempotency.spec.ts
git commit -m "feat(webhooks): implement timing-safe idempotent PayOS payout webhook with balance reconciliation"
```

---

### Task 7: Decommission Dangerous Routes & DTO Response Sanitization (Stage 7)

**Files:**
- Modify: `src/admin/admin.controller.ts`
- Modify: `src/admin/admin.service.ts`
- Modify: `src/store-wallet/store-wallet.controller.ts`
- Modify: `src/store-wallet/dto/withdrawal-response.dto.ts`
- Test: `tests/verify_all_8_audit_fixes.js`

**Interfaces:**
- Consumes: Admin & Store withdrawal controllers.
- Produces: Removed `POST /api/v1/admin/withdrawals/:id/transfer`, standardized status set (`PENDING`, `PROCESSING`, `SUCCEEDED`, `FAILED`, `CANCELLED`), DTO response sanitization (no full account numbers or entity leaks).

- [ ] **Step 1: Write failing test for removed transfer route and sanitized responses**
- Verify `POST /api/v1/admin/withdrawals/:id/transfer` returns HTTP 404 or 405.
- Verify GET withdrawals list returns `bankAccountMasked` and does not leak `bankAccountNumber` or secrets.

- [ ] **Step 2: Run test to verify failure**
Run: `node tests/verify_all_8_audit_fixes.js`
Expected: Flags legacy transfer endpoint or unmasked field if present.

- [ ] **Step 3: Remove `transfer` route and sanitize DTOs**
- Delete or deprecate `transfer` endpoint in `admin.controller.ts` that manually set `TRANSFERRED`.
- Map all withdrawal queries through `WithdrawalResponseDto` with masked bank accounts.
- Remove raw bank account numbers from `wallet_transactions.description`.

- [ ] **Step 4: Run test to verify passes**
Run: `node tests/verify_all_8_audit_fixes.js`
Expected: PASS.

- [ ] **Step 5: Commit Task 7**
```bash
git add src/admin/ src/store-wallet/ tests/
git commit -m "fix(security): remove manual transfer route and enforce sanitized withdrawal DTO response mapping"
```

---

### Task 8: Full Integration Verification & CI/CD Pipeline Deployment (Stage 8)

**Files:**
- Test: `tests/withdrawal-concurrency-idempotency.spec.ts`
- Test: `tests/bank-account-verification.spec.ts`
- Test: `tests/run_all_suites.ts`
- Modify: `SESSION_HANDOFF.md`

**Interfaces:**
- Consumes: All 8 completed stages.
- Produces: 16/16 test suites passing cleanly, TypeScript 0 errors, Clean Build, Documented in Session Handoff.

- [ ] **Step 1: Run complete integration test suite**
Run: `npm run test:all`
Expected: All suites PASS cleanly (16/16).

- [ ] **Step 2: Static Type Check & Production Build**
Run: `npx tsc --noEmit && npm run build`
Expected: 0 errors, build succeeds cleanly.

- [ ] **Step 3: Update `SESSION_HANDOFF.md`**
Record Stage 1–8 implementation, test outcomes, schema updates, and Render environment variables.

- [ ] **Step 4: Commit and Push to Main**
```bash
git add .
git commit -m "feat(payout): complete 8-stage bank verification and payout system with zero-residue tests"
git push origin main
```
Verify GitHub Actions CI/CD pipeline triggers and completes with all 3 layers green.
