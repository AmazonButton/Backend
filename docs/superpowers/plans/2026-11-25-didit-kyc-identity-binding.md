# Didit eKYC Identity Binding, Name Cross-Check & 1-CCCD-1-Account Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce OCR presence, Vietnamese-aware legal identity cross-checking, 1-CCCD-1-account uniqueness (PostgreSQL + row/advisory locks), display-vs-legal name separation (`User.fullName` vs `verifiedLegalName`), and explicit mismatch/dispute/account-transfer review workflows across both Didit webhook ingestion and `/decision` reconciliation.

**Architecture:**
1. Separate editable display name (`users.full_name`) from verified legal identity (`users.verified_legal_name`, `verified_document_hash`, `verified_document_encrypted`, `verified_document_masked`, `verified_date_of_birth`, `verified_nationality`, `kyc_verified_at`), enforced at DB level via unique index `uq_users_verified_document_hash_active`.
2. Unify decision evaluation inside a single repository transactional helper (`applyKycEvaluationInTx`) used by `executeAtomicWebhookTransaction`, `reconcileDecisionAtomicTx`, and admin `reviewSessionAtomicTx`, preventing blind status-only `APPROVED` transitions without OCR, catching concurrent cross-account CCCD claims via `pg_advisory_xact_lock` + `SAVEPOINT` fallback cleanly into `IN_REVIEW`, and preserving idempotent same-account re-verification.
3. Pass `expected_details` from account/legal name on `DiditClientService.createSession()`, expose admin `/review` and `/users/:userId/revoke` dispute/transfer endpoints, and expose read-only verified KYC fields on `/auth/me` while keeping `updateProfile` scoped strictly to display profile fields.

**Tech Stack:** NestJS 10, Prisma 5, PostgreSQL 15+, Node `crypto` (AES-256-GCM + HMAC-SHA256), `class-validator`, `tsx`.

## Global Constraints
- Zero client trust & anti-mass assignment (`ValidationPipe` whitelist + explicit DTOs).
- Never persist raw plaintext CCCD/ID numbers in response payloads, logs, or searchable columns; use `CryptoVaultUtil` HMAC blind-index hashes (`verified_document_hash`), AES-256-GCM encryption (`verified_document_encrypted`), and masked values (`verified_document_masked`).
- Keep `users.full_name` as editable display name (`updateProfile` never invalidates `APPROVED` KYC and cannot mutate verified legal columns).
- Maintain uniform NestJS response envelopes (`{ success, message, data, pagination? }`) and BOLA/RBAC role separation (`ADMIN | SUPER_ADMIN | SYSTEM_ADMIN` for review/revoke/delete).
- Existing Frontend components (`CustomerIdentityVerification.tsx`, `CustomerVerificationDetails.tsx`) rely on `session.status`, `session.metadata.fullName`, masked `session.metadata.documentNumber` (`slice(-4)`), `session.metadata.nationality`, and `user.kycStatus`.

## Review Focus
- Out-of-order / thin `status.updated` (`Approved`) arriving before `data.updated` without OCR data: must never blindly approve (`IN_REVIEW` `OCR_DATA_MISSING`, recoverable once `data.updated` or `/decision` returns OCR).
- Concurrent race (`Promise.all`) where User A and User B verify the exact same CCCD at the same millisecond: PostgreSQL `pg_advisory_xact_lock` + partial unique index + `SAVEPOINT` fallback ensures exactly one account binds `APPROVED`, and the second lands cleanly in `IN_REVIEW` (`DUPLICATE_DOCUMENT`) with zero `500` or lost webhook audit row.
- Vietnamese diacritics (`đ/Đ`), casing, punctuation, and Western/Vietnamese token order (`"An Nguyễn Văn"` vs `"NGUYEN VAN AN"`) vs true mismatch (`"Tran Thi B"` vs `"NGUYEN VAN A"`, or single-token nickname `"An"` vs `"NGUYEN VAN AN"`).
- Same account re-verification after changing display name `users.full_name`: compares against `verified_legal_name` + `verified_document_hash`, permitting idempotent re-verification while rejecting attempts to overwrite with a different CCCD (`USER_DOCUMENT_CONFLICT`).
- Account transfer / dispute flow: admin cannot force-bind a CCCD still linked to another active account without explicitly revoking the old owner via audited `POST /identity-verifications/users/:userId/revoke` first.

---

### Task 1: Schema, Partial Unique Index Migration & Crypto Identity Document Helpers
- **Files:** `prisma/schema.prisma`, `prisma/migrations/20261125020000_didit_kyc_identity_binding/migration.sql`, `src/common/utils/crypto-vault.util.ts`
- [x] Add `normalizeIdentityDocument`, `hashIdentityDocument`, and `maskIdentityDocument` to `CryptoVaultUtil`.
- [x] Extend `User` and `IdentityVerificationSession` models in `prisma/schema.prisma` and create additive PostgreSQL migration `20261125020000_didit_kyc_identity_binding` with unique index `uq_users_verified_document_hash` and FK/indexes.
- [x] Apply migration to local Neon test database & regenerate Prisma Client.

### Task 2: Vietnamese Identity Name Matcher & Didit v3 OCR Payload Extractor
- **Files:** `src/identity-verifications/identity-match.util.ts`
- [x] Implement `normalizeVietnameseIdentityName`, `splitVietnameseExpectedName`, `compareIdentityNames`, and `extractDiditOcrIdentity` (supporting Didit v3 `id_verifications[]`, nested `decision`, and `data.updated` webhooks cleanly).
- [x] Verify unit edge cases via failing-first TDD tests.

### Task 3: Unified Atomic KYC Evaluation Engine (`applyKycEvaluationInTx`) & `DiditClientService`
- **Files:** `src/identity-verifications/didit-client.service.ts`, `src/identity-verifications/identity-verifications.repository.ts`
- [x] Support optional `expected_details` in `DiditClientService.createSession()`.
- [x] Build single shared transactional evaluator `applyKycEvaluationInTx(tx, params)` enforcing OCR completeness, Didit provider status, `pg_advisory_xact_lock` 1-CCCD-1-account guard + `SAVEPOINT` duplicate handling, `verifiedLegalName`/`fullName` matching, and anti-downgrade invariants across webhook and `/decision`.
- [x] Add `reviewSessionAtomicTx` and `revokeUserIdentityAtomicTx` for explicit admin mismatch resolution and account transfer disputes.

### Task 4: Service Orchestration, Admin Review/Revoke DTOs & Endpoints, Auth Profile Separation
- **Files:** `src/identity-verifications/dto/review-kyc-session.dto.ts`, `src/identity-verifications/dto/revoke-user-kyc.dto.ts`, `src/identity-verifications/identity-verifications.service.ts`, `src/identity-verifications/identity-verifications.controller.ts`, `src/auth/auth.service.ts`, `src/admin/admin.repository.ts`
- [x] Update `createSession` (pass `expectedDetails`), `getDecision` (extract OCR & pass to atomic reconcile), `handleWebhook` (extract `id_verifications[]`/`decision`/`data`, optional `/decision` pre-TX fallback on thin `Approved` webhook, mask `documentNumber` in JSON metadata), and normalize `ADMIN | SUPER_ADMIN | SYSTEM_ADMIN` access check.
- [x] Expose `POST /identity-verifications/sessions/:sessionId/review` and `POST /identity-verifications/users/:userId/revoke` with `RolesGuard`.
- [x] Expose read-only `kycStatus`, `verifiedLegalName`, `verifiedDocumentMasked`, `kycVerifiedAt` in `AuthService.getMe` (plus `kycStatus` in auth responses) while confirming `updateProfile` leaves legal KYC fields immutable and `fullName` stays display name.
- [x] Include `IN_REVIEW` in `admin.repository.ts` `pending_kyc` alert query.

### Task 5: Comprehensive Verification (TDD + Real PostgreSQL Concurrency + Nest HTTP Pipeline)
- **Files:** `tests/identity-verification-didit.spec.ts`
- [x] Run `npx tsc --noEmit --incremental false`, `npm run build`, `npx tsx tests/identity-verification-didit.spec.ts`, `npx tsx tests/user-avatar-profile.spec.ts`, `npx tsx tests/http-contract-validation.spec.ts`, and `npx tsx tests/analytics-dashboard-e2e.spec.ts`.

### Task 6: Post-Review Hardening (Legacy Backfill, Admin Decline Lock, Revocation Watermark, Canonical Lock Order & Response Sanitization)
- **Files:** `prisma/schema.prisma`, `prisma/migrations/20261125020000_didit_kyc_identity_binding/migration.sql`, `scripts/backfill_didit_kyc_identities.js`, `.github/workflows/ci-cd.yml`, `src/identity-verifications/identity-verifications.repository.ts`, `src/identity-verifications/identity-verifications.service.ts`, `tests/identity-verification-didit.spec.ts`, `tests/batch1-postgres-concurrency.spec.ts`, `tests/batch1-9fixes-verification.spec.ts`
- [x] Guard legacy `APPROVED` short-circuit with `hasMatchingBoundSession`; add idempotent migration quarantine SQL & `scripts/backfill_didit_kyc_identities.js` (`--dry-run`, `--fetch-didit`, dedup, masking, `IN_REVIEW` quarantine) wired into CI.
- [x] Protect manual `ADMIN_DECLINED` / `reviewedByUserId` decisions against subsequent `/decision` polling and provider webhook overrides unless explicitly re-reviewed by an admin.
- [x] Add `users.kyc_revoked_at` watermark, revoke ALL non-deleted statuses (`DECLINED`, `EXPIRED`, `ABANDONED`, `IN_REVIEW`, `PENDING`, `APPROVED`), and keep pre-revoke sessions terminally `REVOKED` while allowing post-revoke sessions cleanly.
- [x] Standardize strict canonical lock order (`discovery read -> users FOR UPDATE -> sessions ORDER BY id ASC FOR UPDATE -> didit_webhook_events -> pg_advisory_xact_lock`) across all KYC transactional entrypoints and test parallel PostgreSQL races.
- [x] Replace raw `decisionResponse` echo and partial metadata filtering with strict `sanitizeDecisionForResponse()` and `sanitizeMetadataForResponse()` whitelists masking any legacy unmasked document numbers and stripping vendor media URLs/ciphertexts.
