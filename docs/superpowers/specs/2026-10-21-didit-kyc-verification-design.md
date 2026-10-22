# Didit KYC Identity Verification Design Specification (Revised v2)

> **Feature:** Hosted eKYC Workflow & Backend Webhook Ingestion  
> **Target Market:** Vietnam (CCCD / National ID Card + Liveness Detection + Face Matching)  
> **Vendor API:** Didit API v3 (`https://verification.didit.me/v3/`) & Delete API v1 (`https://verification.didit.me/v1/`)  
> **Author:** Antigravity (ENI) & Tris  
> **Status:** Approved / Ready for Implementation Planning  
> **Date:** 2026-10-21  

---

## 1. Overview & Business Context

This specification defines the complete architectural design for integrating **Didit eKYC** into the IoT Amazon Button e-commerce platform.

### A. Architectural Approach: Hosted KYC Workflow + Backend Webhook
1. **Hosted Workflow:** Didit manages user camera capture, ID card OCR (Vietnam National ID / CCCD), 3D liveness detection, and facial matching via their hosted web app.
2. **Backend Orchestration:** 
   - The backend server creates sessions via Didit API v3 with `x-api-key` authentication, passing an internal user reference (`vendor_data: user-<userId>`) and a fixed server-side callback URL.
   - The mobile client receives only the temporary `verificationUrl` to open in an in-app browser or external browser.
   - Client applications never receive `DIDIT_API_KEY` or `DIDIT_WEBHOOK_SECRET`.
   - Client cannot override the callback URL (anti open-redirect).
3. **Asynchronous Webhook Settlement:** 
   - Didit notifies backend via signed HTTP POST webhooks (`status.updated` and `data.updated`).
   - The backend uses native NestJS `rawBody: true` to validate HMAC-SHA256 (`X-Signature-V2`) with `crypto.timingSafeEqual`.
   - Handlers are separated: `status.updated` processes lifecycle state transitions with strict anti-downgrade protections, while `data.updated` syncs OCR metadata.
4. **Server-to-Server Fallback:**
   - Exposes `/decision` endpoint that queries Didit's decision API server-to-server (`GET https://verification.didit.me/v3/session/{sessionId}/decision/`) with `x-api-key` for instant reconciliation if the user returns to mobile before the webhook arrives.

### B. Workflow Configuration (Vietnam Minimum Viable KYC)
- **Active Features:**
  - Country: Vietnam
  - Document: National ID Card (CCCD)
  - Document Capture
  - Presence / Liveness Detection
  - Biometric Facial Matching
- **Explicitly Disabled for Phase 1:**
  - NFC chip reading
  - Passport / Driver License / Residence Permit
  - AML screening
  - Proof of Address
  - Telephone verification
  - Share / Import Session

---

## 2. Environment & Configuration

Required environment variables in `.env`:

```env
# Didit KYC Integration
DIDIT_BASE_URL="https://verification.didit.me/v3"
DIDIT_DELETE_URL="https://verification.didit.me/v1"
DIDIT_API_KEY="didit_live_..."
DIDIT_WORKFLOW_ID="wf_..."
DIDIT_WEBHOOK_SECRET="whsec_..."
DIDIT_CALLBACK_URL="https://buttontdash.vercel.app/verification/callback"
```

---

## 3. Database Schema Extensions (PostgreSQL / Prisma)

### A. Model `IdentityVerificationSession` (`identity_verification_sessions`)
Tracks user verification sessions and current lifecycle state.

```prisma
model IdentityVerificationSession {
  id                BigInt    @id @default(autoincrement()) @map("id")
  userId            BigInt    @map("user_id")
  diditSessionId    String    @unique @map("didit_session_id") @db.VarChar(128)
  workflowId        String    @map("workflow_id") @db.VarChar(128)
  vendorData        String    @map("vendor_data") @db.VarChar(128)
  status            String    @default("PENDING") @map("status") @db.VarChar(32) // PENDING, IN_REVIEW, APPROVED, DECLINED, EXPIRED, ABANDONED
  verificationUrl   String    @map("verification_url") @db.VarChar(1024)
  metadata          Json?     @map("metadata")
  expiresAt         DateTime? @map("expires_at") @db.Timestamptz(6)
  completedAt       DateTime? @map("completed_at") @db.Timestamptz(6)
  createdAt         DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt         DateTime  @default(now()) @updatedAt @map("updated_at") @db.Timestamptz(6)

  user              User      @relation(fields: [userId], references: [userId], onDelete: Cascade)
  webhookEvents     DiditWebhookEvent[]

  @@index([userId])
  @@index([status])
  @@map("identity_verification_sessions")
}
```

### B. Model `DiditWebhookEvent` (`didit_webhook_events`)
Guarantees webhook idempotency, replay defense, and an immutable audit log.
`diditSessionId` is nullable to allow `onDelete: SetNull` and to store webhooks referencing unknown sessions safely.

```prisma
model DiditWebhookEvent {
  id                BigInt    @id @default(autoincrement()) @map("id")
  eventId           String?   @unique @map("event_id") @db.VarChar(128)
  diditSessionId    String?   @map("didit_session_id") @db.VarChar(128)
  eventType         String    @map("event_type") @db.VarChar(64) // status.updated, data.updated
  status            String    @map("status") @db.VarChar(32)
  payloadHash       String    @unique @map("payload_hash") @db.VarChar(64) // Unique SHA-256 hex
  receivedAt        DateTime  @default(now()) @map("received_at") @db.Timestamptz(6)
  processedAt       DateTime? @map("processed_at") @db.Timestamptz(6)

  session           IdentityVerificationSession? @relation(fields: [diditSessionId], references: [diditSessionId], onDelete: SetNull)

  @@index([diditSessionId])
  @@map("didit_webhook_events")
}
```

### C. Extension to Model `User` (`users`)
Exposes `kycStatus` for O(1) authorization checks in store approvals and driver dispatching.

```prisma
// In model User:
kycStatus   String    @default("UNVERIFIED") @map("kyc_status") @db.VarChar(32) // UNVERIFIED, PENDING, APPROVED, DECLINED
identityVerificationSessions IdentityVerificationSession[]
```

---

## 4. State Machine & Status Downgrade Protections

### A. Session State Transitions
```
[PENDING] ────┬───> [IN_REVIEW] ───┬───> [APPROVED] (Terminal Success)
              │                    └───> [DECLINED] (Terminal Failure)
              ├───> [APPROVED]
              ├───> [DECLINED]
              ├───> [EXPIRED]
              └───> [ABANDONED]
```

- **Invariant 1:** Once a session reaches `APPROVED`, it **CANNOT** transition back to `PENDING`, `IN_REVIEW`, or `DECLINED`. Any delayed or out-of-order webhook attempting to downgrade an `APPROVED` session is safely ignored and logged.
- **Invariant 2:** `user.kycStatus` is updated to `APPROVED` upon session approval. If an older or concurrent session receives `DECLINED`, the system checks:
  ```typescript
  const hasApprovedSession = await this.repo.hasApprovedSession(userId);
  if (!hasApprovedSession) {
    await this.userRepo.updateKycStatus(userId, 'DECLINED');
  }
  ```
  This ensures a previously validated user's KYC status is never revoked by an out-of-sequence failing session webhook.

---

## 5. Backend REST API Specifications

All responses follow the project envelope: `{ success: boolean, message: string, data?: any, pagination?: any }`.

### 1. `POST /api/v1/identity-verifications/sessions`
- **Description:** Initiates a new Didit verification session.
- **Auth:** Bearer JWT required.
- **Security Invariant:** Client **cannot** supply `callback` or `vendor_data`. 
  - `vendor_data` is strictly composed on the server: `user-${req.user.id}`.
  - `callback` is strictly read from `DIDIT_CALLBACK_URL`.
- **Vendor Request:**
  - `POST https://verification.didit.me/v3/session/`
  - Headers:
    - `x-api-key: <DIDIT_API_KEY>`
    - `Content-Type: application/json`
  - Body:
    ```json
    {
      "workflow_id": "<DIDIT_WORKFLOW_ID>",
      "vendor_data": "user-<userId>",
      "callback": "https://buttontdash.vercel.app/verification/callback"
    }
    ```
- **Response (HTTP 201):**
  ```json
  {
    "success": true,
    "message": "Phiên xác minh danh tính đã được tạo thành công",
    "data": {
      "sessionId": "1",
      "diditSessionId": "01J...",
      "verificationUrl": "https://verify.didit.me/session/01J...",
      "status": "PENDING",
      "expiresAt": "2026-10-21T16:41:25.000Z"
    }
  }
  ```

### 2. `GET /api/v1/identity-verifications/sessions/:sessionId`
- **Description:** Retrieves internal session record and KYC status.
- **Auth:** Bearer JWT required.
- **BOLA Defense:** `session.userId === req.user.id` unless caller has `ADMIN` role.
- **Response (HTTP 200):**
  ```json
  {
    "success": true,
    "message": "Lấy thông tin phiên xác minh thành công",
    "data": {
      "sessionId": "1",
      "diditSessionId": "01J...",
      "status": "APPROVED",
      "verificationUrl": "https://verify.didit.me/session/01J...",
      "expiresAt": "...",
      "completedAt": "...",
      "createdAt": "..."
    }
  }
  ```

### 3. `GET /api/v1/identity-verifications/sessions/:sessionId/decision`
- **Description:** Server-to-server fallback querying Didit decision API.
- **Auth:** Bearer JWT required (BOLA protected).
- **Vendor Request:**
  - `GET https://verification.didit.me/v3/session/{diditSessionId}/decision/`
  - Headers:
    - `x-api-key: <DIDIT_API_KEY>`
- **Response (HTTP 200):**
  ```json
  {
    "success": true,
    "message": "Lấy kết quả đối chiếu Didit thành công",
    "data": {
      "status": "APPROVED",
      "decision": { ... }
    }
  }
  ```

### 4. `GET /api/v1/identity-verifications/sessions?page=1&pageSize=20`
- **Description:** Lists verification sessions with pagination.
- **Auth:** Bearer JWT required.
- **Access Control:**
  - Non-admin users: filtered strictly by `userId = req.user.id`.
  - Admins: view all sessions.
- **Response (HTTP 200):**
  ```json
  {
    "success": true,
    "message": "Lấy danh sách phiên xác minh thành công",
    "data": [ ... ],
    "pagination": {
      "page": 1,
      "pageSize": 20,
      "totalItems": 1,
      "totalPages": 1
    }
  }
  ```

### 5. `DELETE /api/v1/identity-verifications/sessions/:sessionId`
- **Description:** Deletes verification session locally and on Didit.
- **Auth:** Bearer JWT required.
- **Role Guard:** `ADMIN` role only.
- **Vendor Request:**
  - `DELETE https://verification.didit.me/v1/session/{diditSessionId}/delete/`
  - Headers:
    - `x-api-key: <DIDIT_API_KEY>`
- **Response (HTTP 200):**
  ```json
  {
    "success": true,
    "message": "Xóa phiên xác minh thành công",
    "data": null
  }
  ```

### 6. `POST /api/v1/webhooks/didit`
- **Description:** Ingests asynchronous status and data webhooks from Didit.
- **Auth:** Signature verification via header `X-Signature-V2`.
- **Processing Pipeline:**
  1. **Raw Body Extraction:** Read `(req as any).rawBody` enabled via NestJS `{ rawBody: true }`.
  2. **Signature Verification:**
     - Signature header: `req.headers['x-signature-v2']`.
     - Compute: `expected = crypto.createHmac('sha256', DIDIT_WEBHOOK_SECRET).update(req.rawBody).digest('hex')`.
     - Verify with `crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))`.
     - If invalid: Reject with HTTP 401 Unauthorized immediately.
  3. **Idempotency Guard:**
     - Compute `payloadHash = crypto.createHash('sha256').update(req.rawBody).digest('hex')`.
     - Query `didit_webhook_events` for `payloadHash` or `eventId`.
     - If found: return HTTP 200 (`{ success: true, message: 'Event already processed' }`).
  4. **Event Routing:**
     - If `event_type === 'status.updated'`:
       * Extract `session_id`, `status`.
       * Execute state transition check (reject downgrade).
       * Update `identity_verification_sessions` and `users.kycStatus` within a database transaction.
     - If `event_type === 'data.updated'`:
       * Extract OCR/document details and update `identity_verification_sessions.metadata`.
  5. **Audit Record:** Insert into `didit_webhook_events` with `processedAt = now()`.
  6. **Response:** Return HTTP 200 within 2s.

---

## 6. NestJS Configuration & Security Architecture

### A. Native Raw Body Enablement (`src/main.ts`)
```typescript
const app = await NestFactory.create(AppModule, {
  rawBody: true,
});
```

### B. Timing-Safe Webhook Guard (`didit-webhook.guard.ts`)
Injectable guard verifying `req.rawBody` against `process.env.DIDIT_WEBHOOK_SECRET` before passing control to the controller.

---

## 7. Testing Strategy (11 Core Tests)

Test suite `tests/identity-verification-didit.spec.ts` covers:
1. **Create Session (Success):** Authenticated user creates session; receives `verificationUrl` and `diditSessionId`.
2. **BOLA Protection:** User B cannot read or access User A's session (`HTTP 403 / 404`).
3. **Session Not Found:** Request for non-existent session ID returns `HTTP 404`.
4. **Invalid Webhook Signature:** Webhook with altered payload or tampered signature is rejected (`HTTP 401`).
5. **Idempotent Webhooks:** Duplicate delivery of identical webhook payload does not create duplicate event rows or corrupt state.
6. **Approved Transition:** Webhook `Approved` updates session to `APPROVED` and user `kycStatus` to `APPROVED`.
7. **Declined Transition:** Webhook `Declined` updates session to `DECLINED` and user `kycStatus` to `DECLINED` (when no other approved session exists).
8. **In Review / Expired Transitions:** Properly updates session status without prematurely approving user.
9. **Anti-Downgrade Defense:** Late webhook attempting to change `APPROVED` to `DECLINED` is safely ignored.
10. **Zero Secret Exposure:** Responses and server logs never leak `DIDIT_API_KEY` or `DIDIT_WEBHOOK_SECRET`.
11. **Mobile Credential Isolation:** Mobile response contains only `verificationUrl`, never API secrets.
