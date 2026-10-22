# Didit KYC Identity Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

This plan details the implementation of **Didit eKYC** (Vietnam National ID / CCCD + Liveness + Face Matching) using the Hosted Workflow and Backend Webhook architecture.

**Specification Reference:** [`docs/superpowers/specs/2026-10-21-didit-kyc-verification-design.md`](file:///f:/Learning/SEM9-FPTu/backend/docs/superpowers/specs/2026-10-21-didit-kyc-verification-design.md)  
**Target Completion:** 11/11 Test Scenarios passing in `tests/identity-verification-didit.spec.ts`, clean TypeScript compile, clean build, and updated `SESSION_HANDOFF.md`.

---

## Proposed File Structure

```
backend/
├── prisma/
│   ├── schema.prisma                               # Add IdentityVerificationSession (with deletedAt), DiditWebhookEvent, User.kycStatus
│   └── migrations/20261021160000_add_didit_kyc/    # Migration SQL
├── src/
│   ├── main.ts                                     # Enable rawBody: true
│   ├── app.module.ts                               # Import IdentityVerificationsModule
│   └── identity-verifications/
│       ├── identity-verifications.module.ts
│       ├── identity-verifications.controller.ts    # @Controller('identity-verifications') -> /api/v1/identity-verifications/sessions
│       ├── didit-webhook.controller.ts             # @Controller('webhooks') -> /api/v1/webhooks/didit
│       ├── identity-verifications.service.ts       # Orchestration, anti-downgrade state machine, OCR sanitization
│       ├── identity-verifications.repository.ts    # Prisma database layer (soft-delete status DELETED)
│       ├── didit-client.service.ts                 # External HTTP client with x-api-key (v3 session/decision, v1 delete)
│       ├── guards/
│       │   └── didit-webhook.guard.ts              # Timing-safe HMAC guard with prefix tolerance (v2=, sha256=)
│       └── dto/
│           ├── create-session.dto.ts
│           └── session-query.dto.ts
└── tests/
    └── identity-verification-didit.spec.ts         # Comprehensive automated tests (all 17 test scenarios)
```

---

## Tasks

### Task 1: Database Migration for Didit Identity Verification
- [ ] Add `IdentityVerificationSession` model to `prisma/schema.prisma` with `id BigInt`, `userId BigInt`, `diditSessionId String @unique`, `workflowId String`, `vendorData String`, `status String @default("PENDING")`, `verificationUrl String`, `metadata Json?`, `expiresAt DateTime?`, `completedAt DateTime?`, `deletedAt DateTime?`.
- [ ] Add `DiditWebhookEvent` model with `id BigInt`, `eventId String? @unique`, `diditSessionId String?`, `eventType String`, `status String`, `payloadHash String @unique`, `receivedAt DateTime`, `processedAt DateTime?`, `session IdentityVerificationSession? @relation(fields: [diditSessionId], references: [diditSessionId], onDelete: SetNull)`.
- [ ] Add `kycStatus String @default("UNVERIFIED") @map("kyc_status")` and `identityVerificationSessions IdentityVerificationSession[]` to `User` model.
- [ ] Generate and apply migration via Prisma migrate (`npx prisma migrate dev --name add_didit_kyc`).
- [ ] Verify generated Prisma client (`npx prisma generate`).

### Task 2: NestJS Native Raw Body Configuration & Webhook HMAC Guard
- [ ] Update `src/main.ts` to pass `{ rawBody: true }` in `NestFactory.create(AppModule, { rawBody: true })`.
- [ ] Create `src/identity-verifications/guards/didit-webhook.guard.ts`:
  - Check for header `x-signature-v2`.
  - Strip signature prefixes if present (`v2=`, `sha256=`) to accept raw hex format flexibly.
  - Validate `req.rawBody` buffer presence.
  - Calculate HMAC-SHA256 of `req.rawBody` with `DIDIT_WEBHOOK_SECRET`.
  - Perform timing-safe comparison with `crypto.timingSafeEqual`.
  - Reject with `UnauthorizedException('Chữ ký webhook không hợp lệ')` if signature check fails.
- [ ] Add `.env.example` placeholders for Didit environment variables.

### Task 3: Didit API Client Service (`didit-client.service.ts`)
- [ ] Create `src/identity-verifications/didit-client.service.ts`:
  - Inject `ConfigService` and native `fetch` / `axios`.
  - `createSession(vendorData: string, callbackUrl: string)`:
    - Send `POST https://verification.didit.me/v3/session/` with header `x-api-key: <DIDIT_API_KEY>`.
    - Body: `{ workflow_id, vendor_data, callback }`.
    - Return `{ session_id, url, status, expires_at }`.
  - `getDecision(diditSessionId: string)`:
    - Send `GET https://verification.didit.me/v3/session/{diditSessionId}/decision/` with header `x-api-key: <DIDIT_API_KEY>`.
  - `deleteSession(diditSessionId: string)`:
    - Send `DELETE https://verification.didit.me/v1/session/{diditSessionId}/delete/` with header `x-api-key: <DIDIT_API_KEY>`.
  - Secure error handling: ensure `DIDIT_API_KEY` is never leaked in error logs or exception messages.

### Task 4: Identity Verification Repository & Anti-Downgrade Service
- [ ] Create `src/identity-verifications/identity-verifications.repository.ts`:
  - Create session, find session by ID, find by `diditSessionId`, list sessions by user with pagination, list all sessions (admin).
  - Soft-delete session: set `status = 'DELETED'`, `deletedAt = now()`.
  - Check `hasApprovedSession(userId: bigint)`: returns boolean if user has any `APPROVED` session.
  - Idempotent webhook event logging: check by `payloadHash` or `eventId`, insert audit event.
- [ ] Create `src/identity-verifications/identity-verifications.service.ts`:
  - `createSession(userId: bigint)`:
    - Strict `vendor_data = "user-" + userId`.
    - Fixed server `callback = DIDIT_CALLBACK_URL` (no client override).
    - Call `DiditClientService.createSession()`.
    - Save session with status `PENDING`, update `user.kycStatus = 'PENDING'`.
  - `getSession(sessionId: bigint, user: any)`:
    - BOLA check: verify `session.userId === user.id` or user is `ADMIN`.
  - `getDecision(sessionId: bigint, user: any)`:
    - BOLA check, call `DiditClientService.getDecision()`, sync status if updated.
  - `listSessions(user: any, query: SessionQueryDto)`:
    - Filter by `userId` for regular users; allow all for `ADMIN`.
  - `deleteSession(sessionId: bigint, user: any)`:
    - Admin only. Calls Didit delete API FIRST. Only updates local session status to `DELETED` and sets `deletedAt` after Didit responds successfully.
  - `handleWebhook(rawBody: Buffer, headers: any, payload: any)`:
    - Compute `payloadHash = sha256(rawBody)`.
    - Check duplicate event in `didit_webhook_events`; return early if duplicate.
    - If `status.updated`:
      - Verify state transition: if session is already `APPROVED`, do NOT downgrade to `DECLINED` or `PENDING`.
      - If transition is `APPROVED`: update session to `APPROVED`, update `user.kycStatus = 'APPROVED'`.
      - If transition is `DECLINED`: update session to `DECLINED`; only set `user.kycStatus = 'DECLINED'` if `!hasApprovedSession(userId)`.
    - If `data.updated`:
      - Sanitize and save only essential OCR fields (fullName, documentNumber, dateOfBirth, expiryDate). Never store image/video blobs.
    - Save `DiditWebhookEvent` record with `processedAt = now()`.

### Task 5: Controllers, DTOs & Module Registration
- [ ] Create `src/identity-verifications/dto/session-query.dto.ts` with pagination validation (`page`, `pageSize <= 100`).
- [ ] Create `src/identity-verifications/identity-verifications.controller.ts`:
  - Decorated with `@Controller('identity-verifications')` (maps to `/api/v1/identity-verifications/sessions`).
  - `@Post('sessions')` (`@UseGuards(JwtAuthGuard)`)
  - `@Get('sessions/:sessionId')` (`@UseGuards(JwtAuthGuard)`)
  - `@Get('sessions/:sessionId/decision')` (`@UseGuards(JwtAuthGuard)`)
  - `@Get('sessions')` (`@UseGuards(JwtAuthGuard)`)
  - `@Delete('sessions/:sessionId')` (`@UseGuards(JwtAuthGuard, RolesGuard)`, `@Roles('ADMIN')`)
  - Return uniform response envelope `{ success: true, message, data, pagination? }`.
- [ ] Create `src/identity-verifications/didit-webhook.controller.ts`:
  - Decorated with `@Controller('webhooks')` (maps to `/api/v1/webhooks/didit`).
  - `@Post('didit')` (`@UseGuards(DiditWebhookGuard)`)
  - Extract `(req as any).rawBody`, delegate to service, return HTTP 200 within 2s.
- [ ] Create `src/identity-verifications/identity-verifications.module.ts` and register in `src/app.module.ts`.

### Task 6: Automated Test Suite (Comprehensive Scenarios)
- [ ] Create `tests/identity-verification-didit.spec.ts`:
  - Test 1: Create session with authenticated JWT, verify `vendor_data` matches `user-<userId>` and returns `verificationUrl`.
  - Test 2: BOLA Protection — User B cannot access User A's session (`HTTP 403 / 404`).
  - Test 3: Session Not Found — Non-existent session returns `HTTP 404`.
  - Test 4: Invalid Webhook Signature — Rejected with `HTTP 401`.
  - Test 5: Idempotent Webhook — Duplicate payload does not create duplicate event rows or corrupt state.
  - Test 6: Approved Transition — Webhook `status.updated` (`Approved`) updates session and user `kycStatus` to `APPROVED`.
  - Test 7: Declined Transition — Webhook `status.updated` (`Declined`) updates session and user `kycStatus` to `DECLINED`.
  - Test 8: In Review / Expired Transitions — Correctly updates session without prematurely approving user.
  - Test 9: Anti-Downgrade Defense — Delayed `Declined` webhook cannot downgrade an already `APPROVED` session or user.
  - Test 10: Zero Secret Exposure — Ensure `DIDIT_API_KEY` and `DIDIT_WEBHOOK_SECRET` are never present in responses.
  - Test 11: Mobile Credential Isolation — Client responses contain only `verificationUrl`, never vendor credentials.
  - Test 12: Safe Delete Session — Calls Didit delete API first, then soft-deletes session (`status: DELETED`).
  - Test 13: Webhook Event with Unknown Session — Safely logs audit event without crashing.
  - Test 14: `data.updated` without status — Updates OCR metadata without modifying session status.
  - Test 15: Out-of-order Webhook Events — Respects state machine invariants.
  - Test 16: Signature Prefix Tolerance — Accepts `v2=<hex>` and raw hex signatures seamlessly.
  - Test 17: Vendor 4xx/5xx / Timeout Handling — Gracefully returns HTTP 502/504 with sanitized error envelope.
- [ ] Run test suite: `npx tsx tests/identity-verification-didit.spec.ts`.


### Task 7: Full System Verification & Handoff Update
- [ ] Run `npx tsc --noEmit` — verify 0 TypeScript errors.
- [ ] Run `npm run build` — verify clean production build.
- [ ] Run `npm run test:all` — verify all test suites pass.
- [ ] Update `SESSION_HANDOFF.md` per `docs/AGENT_CONTEXT_POLICY.md` with verified test results and migration details.
