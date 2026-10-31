# Platform Button Rental Expansion: Phases 1 to 8 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform the Platform Button Rental foundation into a fully closed, end-to-end production architecture where customers rent and pay through real PayOS links, operators assign fulfillment stores and specific warehouse devices, stores physically hand over buttons, expiry countdowns strictly lock orders, returns trigger immutable recipient deposit payouts, and outbox events reliably notify all parties.

**Architecture:** Layered 6-tier architecture (Router -> Middleware -> Controller -> Service -> Repository -> PostgreSQL Database) with strict BOLA isolation, atomic multi-table transactions (`SELECT FOR UPDATE`), event outbox claim-check pattern with lease fencing, unified PayOS server-to-server signature verification, and zero-bypass test DB guards.

**Tech Stack:** NestJS 10, TypeScript 5, PostgreSQL 15, Prisma ORM, Redis (BullMQ), PayOS API SDK, Crypto AES-256-GCM / SHA-256.

**Spec:** [`docs/superpowers/plans/2026-10-30-platform-button-rental-expansion-plan.md`](file:///f:/Learning/SEM9-FPTu/backend/docs/superpowers/plans/2026-10-30-platform-button-rental-expansion-plan.md)

---

## Global Constraints

- `StoreWallet` balance is strictly decoupled from platform button rentals and deposit liabilities; store wallets are never credited with rental fees or debited for deposit refunds.
- Zero plaintext financial storage: Bank account numbers must be AES-256-GCM encrypted (`accountNumberEncrypted`), SHA-256 hashed for lookup (`accountNumberHash`), and masked for display (`bankAccountMasked`).
- Deposit conservation invariant: For every rental deposit, `held_amount + refund_reserved_amount + refunded_amount == collected_amount`.
- Test database safety: `assertTestDatabase()` must strictly fail closed if the connection string does not point to a local PostgreSQL database ending in `_test`.
- Mock payment prohibition: `PAYOS_MOCK_PAYMENT` is strictly prohibited on Staging and Production; only allowed on `['test', 'development', 'local']`.
- Response envelope uniformity: Every endpoint must return `{ success: true, message: string, data: any }`.

## Review Focus

1. Webhook forgery or tampering: PayOS webhook must reject invalid HMAC-SHA256 signatures, mismatched currencies (not `VND`), or amount deviations from the database charge.
2. Concurrent button assignment: Multiple admins or workers assigning the same button simultaneously must encounter pessimistic row locks (`SELECT FOR UPDATE`) preventing double-allocation.
3. Premature activation bypass: Directly calling activation or setting status to `ACTIVE` without verified physical handover and positive paid duration must be strictly rejected with HTTP 400.
4. Payout without transaction proof: PayOS payout responses lacking a valid `transactions` array, lacking positive finite amounts, or with mismatched recipient bank accounts must remain in `PENDING_PAYOUT` with funds reserved.
5. Expiry race condition: When a rental expires (`effectiveExpiresAt <= NOW()`), both TypeScript application layer and PostgreSQL stored procedure must atomically block new order creation, even if the cron worker is delayed.

---

### Task 1: Phase 1 — Nối thanh toán thật vào BillingCharge

**Files:**
- Modify: `src/billing-charges/billing-charges.service.ts`
- Modify: `src/billing-charges/billing-charges.repository.ts`
- Modify: `src/billing-charges/billing-charges.controller.ts`
- Modify: `src/payments/payments.service.ts`
- Modify: `src/rentals/rentals.service.ts`
- Test: `tests/platform-button-rental-phase1-payos-integration.spec.ts`

**Interfaces:**
- Consumes: `BillingChargesRepository.findChargeById`, `BillingChargesRepository.updateChargePaymentDetails`, `signPaymentRequest`
- Produces: `BillingChargesService.createPayosPaymentRequestForCharge(chargeId: bigint, user: any, returnUrl?: string, cancelUrl?: string): Promise<{ paymentLinkId, orderCode, checkoutUrl, qrCode, amount, status }>`
- Produces: `PaymentsService.handlePayosWebhook`: Extended to route unhandled transaction codes to `BillingChargesService.settleCharge`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/platform-button-rental-phase1-payos-integration.spec.ts
import { assertTestDatabase } from './test-db-guard';
// Verify createPayosPaymentRequestForCharge generates real orderCode, signs request, updates charge, and handlePayosWebhook settles charge atomically
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx ts-node tests/platform-button-rental-phase1-payos-integration.spec.ts`
Expected: FAIL with method not defined or missing webhook routing.

- [ ] **Step 3: Implement PayOS link creation and webhook settlement**

Implement `createPayosPaymentRequestForCharge` in `BillingChargesService`:
- Validate charge exists and user has ownership (customer or store owner or admin).
- Check if existing charge is already `PAID` or has active `PENDING` payment link (idempotent return).
- Generate integer `orderCode <= 9007199254740991`.
- Call PayOS `https://api-merchant.payos.vn/v2/payment-requests` with HMAC signature.
- Save `paymentLinkId`, `orderCode`, `checkoutUrl`, `qrCode` to `billing_charges`.
- Route unhandled `orderCode` in `PaymentsService.handlePayosWebhook` to settle matching `billing_charges`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx ts-node tests/platform-button-rental-phase1-payos-integration.spec.ts`
Expected: PASS with 100% assertions passing.

- [ ] **Step 5: Verify build & typecheck**

Run: `npx tsc --noEmit --incremental false`
Expected: 0 errors.

---

### Task 2: Phase 2 — Gán Store và thiết bị cụ thể vào hợp đồng

**Files:**
- Modify: `src/rentals/admin-rentals.controller.ts`
- Modify: `src/rentals/rentals.service.ts`
- Modify: `src/rentals/rentals.repository.ts`
- Modify: `src/devices/devices.repository.ts`
- Test: `tests/platform-button-rental-phase2-store-device-assignment.spec.ts`

**Interfaces:**
- Consumes: `BillingCharge.status === 'PAID'`, `ButtonRental.status === 'PENDING_HANDOVER'`
- Produces: `RentalsService.assignFulfillmentAndDevicesAdmin(rentalId: bigint, fulfillmentStoreId: bigint, buttonIds: bigint[], actor: any)`
- Produces: `RentalsService.handoverRentalButtons(rentalId: bigint, storeStaffUser: any)`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/platform-button-rental-phase2-store-device-assignment.spec.ts
// Verify assignment locks rental, store, buttons; checks ALLOCATED_TO_STORE and custodyStoreId; logs DeviceMovement; prevents duplicate handover
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx ts-node tests/platform-button-rental-phase2-store-device-assignment.spec.ts`
Expected: FAIL with method not found.

- [ ] **Step 3: Implement fulfillment assignment and handover engine**

- Implement `assignFulfillmentAndDevicesAdminTx` in `RentalsRepository` with row-level locks on rental, store, buttons.
- Ensure all assigned buttons are in `ALLOCATED_TO_STORE` and match store custody.
- Create `DeviceMovement` log for each assigned device.
- In `handoverRentalButtonsTx`: verify charge is paid, button count matches package quantity, set status to `ACTIVE`, and start rental countdown.
- Disable/remove any unverified `activateRental()` bypass.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx ts-node tests/platform-button-rental-phase2-store-device-assignment.spec.ts`
Expected: PASS.

- [ ] **Step 5: Verify build & typecheck**

Run: `npx tsc --noEmit --incremental false`
Expected: 0 errors.

---

### Task 3: Phase 3 — Hoàn tất quản lý phí duy trì Store 60.000đ/tháng

**Files:**
- Modify: `src/store-subscriptions/store-subscriptions.controller.ts`
- Modify: `src/store-subscriptions/store-subscriptions.service.ts`
- Modify: `src/store-subscriptions/store-subscriptions.repository.ts`
- Test: `tests/platform-button-rental-phase3-store-subscription.spec.ts`

**Interfaces:**
- Consumes: `BillingChargesService.createStoreSubscriptionCharge`, `createPayosPaymentRequestForCharge`
- Produces: `POST /api/v1/stores/:storeId/subscriptions/renew-charge`: Generates real PayOS payment link for 60,000 VND shelf fee.
- Produces: Automatic extension upon settlement: stacks 30 days onto `currentExpiresAt` if active, or from `NOW()` if expired.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/platform-button-rental-phase3-store-subscription.spec.ts
// Verify store owner creates 60k renew charge with real PayOS payment link; settlement extends active subscription by 30 days; blocks tampering
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx ts-node tests/platform-button-rental-phase3-store-subscription.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement Store 60k renewal and payment flow**

- Create controller endpoint `POST /api/v1/stores/:storeId/subscriptions/renew-charge`.
- Bind to `BillingChargesService.createStoreSubscriptionCharge`.
- Generate PayOS payment link via `BillingChargesService.createPayosPaymentRequestForCharge`.
- On settlement, atomically update store subscription `expiresAt = max(expiresAt, NOW()) + 30 days`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx ts-node tests/platform-button-rental-phase3-store-subscription.spec.ts`
Expected: PASS.

- [ ] **Step 5: Verify build & typecheck**

Run: `npx tsc --noEmit --incremental false`
Expected: 0 errors.

---

### Task 4: Phase 4 — Khóa hạn rental và xử lý hết hạn nhất quán

**Files:**
- Create: `src/rentals/rental-expiry.cron.ts`
- Modify: `src/rentals/rentals.service.ts`
- Modify: `src/rentals/rentals.repository.ts`
- Modify: `src/orders/orders.service.ts`
- Test: `tests/platform-button-rental-phase4-expiry-and-ordering-lock.spec.ts`

**Interfaces:**
- Consumes: `ButtonRental.effectiveExpiresAt <= NOW()`, `ButtonRental.status === 'ACTIVE'`
- Produces: `RentalExpiryCronService.processExpiredRentals()`: Transitions status to `EXPIRED`, sets `canOrder = false`, dispatches `RENTAL_EXPIRED` outbox event.
- Produces: `OrdersService.validateButtonOrderEligibility`: Atomic check rejecting expired buttons with 400 Bad Request.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/platform-button-rental-phase4-expiry-and-ordering-lock.spec.ts
// Verify cron finds expired active rentals, updates status to EXPIRED atomically, sets canOrder=false, and dispatches outbox event without duplicates
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx ts-node tests/platform-button-rental-phase4-expiry-and-ordering-lock.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement RentalExpiryCronService and dual-guard order locking**

- Implement idempotent cron task that batches expired rentals (`effectiveExpiresAt <= NOW()`).
- Use row-level locking (`SELECT ... FOR UPDATE SKIP LOCKED`).
- Transition status to `EXPIRED`, set `canOrder = false` for linked buttons, and insert `RENTAL_EXPIRED` outbox event in the same transaction.
- In `OrdersService`: preserve fail-closed check on both TypeScript layer and PostgreSQL stored procedure.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx ts-node tests/platform-button-rental-phase4-expiry-and-ordering-lock.spec.ts`
Expected: PASS.

- [ ] **Step 5: Verify build & typecheck**

Run: `npx tsc --noEmit --incremental false`
Expected: 0 errors.

---

### Task 5: Phase 5 — Đóng quy trình trả nút và hoàn cọc thật

**Files:**
- Modify: `src/rentals/rentals.service.ts`
- Modify: `src/rentals/rentals.repository.ts`
- Modify: `src/rentals/outbox-consumer.service.ts`
- Test: `tests/platform-button-rental-phase5-return-and-deposit-payout.spec.ts`

**Interfaces:**
- Consumes: Customer verified bank account, `ButtonReturnRequest.status === 'RECEIVED'`
- Produces: `approveDepositRefundTx`: Snapshots recipient bank account immutably (`bankAccountId`, `bankBin`, `bankAccountNumberEncrypted`, `bankAccountHolderName`).
- Produces: `reconcileDepositRefundPayout`: Shared strict reconciliation engine used by both worker and admin API with zero amount fallback.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/platform-button-rental-phase5-return-and-deposit-payout.spec.ts
// Verify return request -> store receipt -> admin approval snapshots bank account -> worker calls payout -> reconcile strictly matches transaction detail
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx ts-node tests/platform-button-rental-phase5-return-and-deposit-payout.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement immutable recipient snapshot and shared reconcile engine**

- Enforce single active return request per button.
- In `approveDepositRefundTx`: lock verified bank account, snapshot encrypted account and BIN into `deposit_refunds`.
- In `outbox-consumer.service.ts`: pass snapshotted credentials to PayOS payout; do not fallback to mutable profiles.
- Unify `reconcileDepositRefundPayout` between worker and admin endpoint: require transaction detail, matching amount, matching recipient, matching reference.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx ts-node tests/platform-button-rental-phase5-return-and-deposit-payout.spec.ts`
Expected: PASS.

- [ ] **Step 5: Verify build & typecheck**

Run: `npx tsc --noEmit --incremental false`
Expected: 0 errors.

---

### Task 6: Phase 6 — Nối đầy đủ Outbox và Notification Center

**Files:**
- Modify: `src/rentals/rentals.service.ts`
- Modify: `src/notifications/notifications.service.ts`
- Modify: `src/rentals/outbox-consumer.service.ts`
- Test: `tests/platform-button-rental-phase6-outbox-notifications.spec.ts`

**Interfaces:**
- Consumes: Domain events: `RENTAL_RETURN_REQUESTED`, `DEPOSIT_REFUND_APPROVED`, `RENTAL_EXPIRED`, `STORE_SUBSCRIPTION_EXPIRED`, `PAYMENT_RECEIVED`
- Produces: Deterministic notification idempotency keys: `notif:${eventId}:${recipientId}:${channel}`.
- Produces: DLQ inspection and replay audit log.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/platform-button-rental-phase6-outbox-notifications.spec.ts
// Verify all domain events produce outbox records, worker processes with deterministic keys, push failure does not rollback financial transactions
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx ts-node tests/platform-button-rental-phase6-outbox-notifications.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement outbox producers and notification dispatcher**

- Add transactional outbox inserts to return requests, refund approvals, and charge settlements.
- Add event consumer handlers in `OutboxConsumerService` with role-based routing (Customer, Store, Admin).
- Decouple notification dispatch failures from financial transaction results.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx ts-node tests/platform-button-rental-phase6-outbox-notifications.spec.ts`
Expected: PASS.

- [ ] **Step 5: Verify build & typecheck**

Run: `npx tsc --noEmit --incremental false`
Expected: 0 errors.

---

### Task 7: Phase 7 — Hoàn thiện API validation, phân quyền và audit

**Files:**
- Create: `src/rentals/dto/assign-fulfillment.dto.ts`
- Create: `src/rentals/dto/admin-adjust-duration.dto.ts`
- Modify: `src/rentals/rentals.controller.ts`
- Modify: `src/rentals/admin-rentals.controller.ts`
- Test: `tests/platform-button-rental-phase7-validation-and-audit.spec.ts`

**Interfaces:**
- Consumes: Class-validator DTOs, `@Roles` decorators, `RentalAuditLog`
- Produces: Standardized API response envelopes for all rental endpoints.
- Produces: Immutable audit log entries for every lifecycle and financial state mutation.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/platform-button-rental-phase7-validation-and-audit.spec.ts
// Verify DTO validation rejects invalid IDs, missing reasons, negative counts; verify BOLA tenant isolation; verify audit logs recorded
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx ts-node tests/platform-button-rental-phase7-validation-and-audit.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement DTOs, RBAC/BOLA guards, and audit loggers**

- Create `AssignFulfillmentDto` validating storeId and buttonIds array.
- Create `AdminAdjustDurationDto` validating operation (`EXTEND`, `SET_EXPIRY`), reason, and version.
- Enforce `@Roles('SUPER_ADMIN')` on mutation endpoints in `AdminRentalsController`.
- Log all state transitions to `rental_audit_logs`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx ts-node tests/platform-button-rental-phase7-validation-and-audit.spec.ts`
Expected: PASS.

- [ ] **Step 5: Verify build & typecheck**

Run: `npx tsc --noEmit --incremental false`
Expected: 0 errors.

---

### Task 8: Phase 8 — Nghiệm thu và bàn giao

**Files:**
- Modify: `tests/run_all_suites.ts`
- Modify: `SESSION_HANDOFF.md`
- Test: Master test runner and quality gates

**Interfaces:**
- Consumes: All Phase 1–7 test suites, `assertTestDatabase()`
- Produces: Updated Master Runner registration and verified `SESSION_HANDOFF.md` status.

- [ ] **Step 1: Run TypeScript compiler check**

Run: `npx tsc --noEmit --incremental false`
Expected: 0 errors (Exit Code 0).

- [ ] **Step 2: Run Production Build**

Run: `npm run build`
Expected: Exit Code 0.

- [ ] **Step 3: Run Git Formatting Check**

Run: `git diff --check`
Expected: 0 errors.

- [ ] **Step 4: Run Unit and Isolation Test Suites**

Run:
- `npx ts-node tests/superpower-security-unit.spec.ts`
- `npx ts-node tests/platform-button-rental-phase1-payos-integration.spec.ts`
- `npx ts-node tests/platform-button-rental-phase2-store-device-assignment.spec.ts`
- `npx ts-node tests/platform-button-rental-phase3-store-subscription.spec.ts`
- `npx ts-node tests/platform-button-rental-phase4-expiry-and-ordering-lock.spec.ts`
- `npx ts-node tests/platform-button-rental-phase5-return-and-deposit-payout.spec.ts`
- `npx ts-node tests/platform-button-rental-phase6-outbox-notifications.spec.ts`
- `npx ts-node tests/platform-button-rental-phase7-validation-and-audit.spec.ts`
Expected: 100% PASS across all suites.

- [ ] **Step 5: Update Master Runner & SESSION_HANDOFF.md**

Update `tests/run_all_suites.ts` and `SESSION_HANDOFF.md` with verified execution logs and accurate status classifications.
