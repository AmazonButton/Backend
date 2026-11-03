# Backend Security & Invariant Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve prioritized P0 & P1 vulnerabilities, state machine deadlocks, financial refund risks, and functional gaps identified in `STATIC-CODE-REVIEW.md`, and add the Store Rename/Update Admin API.

**Architecture:** Layered 6-layer defense (Router -> Guard -> Controller -> Service -> Repository -> Database). All mutations run in explicit PostgreSQL transactions with row-level locking (`SELECT FOR UPDATE`). Data isolation enforced via strict DTO whitelisting and fail-closed BOLA checks.

**Tech Stack:** NestJS 10, TypeScript 5, PostgreSQL 15, Prisma ORM, PayOS SDK, bcryptjs, crypto (timingSafeEqual).

**Spec:** [STATIC-CODE-REVIEW.md](file:///c:/Users/ttphatt_2403/security-audit-skill/backend/run-2/STATIC-CODE-REVIEW.md) and [RULES-182-MATRIX.md](file:///c:/Users/ttphatt_2403/security-audit-skill/backend/run-2/RULES-182-MATRIX.md).

## Global Constraints

- Never persist plaintext bank account numbers: use AES-256-GCM encryption, SHA-256 hash lookup, and masked display (`******1234`).
- Multi-table mutations and state changes must run inside explicit `prisma.$transaction()` with `SELECT ... FOR UPDATE` row locks.
- Controllers must never query Prisma directly; all database interactions belong in Repositories.
- Responses must always adhere to the uniform response envelope `{ success, message, data, pagination }`.
- Production error responses must never expose internal database stack traces or SQL snippets.

## Review Focus

1. **Role Escalation in Refresh Token:** Ensure `SYSTEM_ADMIN` does not get promoted to `SUPER_ADMIN` during token refresh.
2. **Payout Network Failure:** Ensure wallet balance is NOT refunded if PayOS payout dispatch status is unknown or timed out.
3. **BOLA on Cancelled Orders:** Ensure callers without order ownership cannot view order details even when status is `CANCELLED`.
4. **Rental Device Handover Deadlock:** Ensure devices transitioning through `ASSIGNED_TO_RENTAL` can be handed over to customers into `IN_CUSTOMER_CUSTODY`.
5. **CORS Idempotency Headers:** Ensure browser requests with `x-idempotency-key` or `idempotency-key` succeed during CORS preflight.

---

### Task 1: CORS & Runtime Hygiene (API-01, NOTIFY-01)

**Files:**
- Modify: `src/main.ts:114-120`
- Modify: `src/notifications/notifications.repository.ts:95-125`
- Modify: `src/notifications/notifications.service.ts:360-385`
- Test: `tests/cors_and_notification.spec.ts`

**Interfaces:**
- Consumes: CORS configuration and Raw Notification SQL insertion.
- Produces: Whitelisted `x-idempotency-key` and `idempotency-key` headers; camelCase normalized notification entities.

- [ ] **Step 1: Write failing test for CORS allowed headers and Notification snake_case to camelCase mapping**
- [ ] **Step 2: Run test to verify failure**
- [ ] **Step 3: Update `src/main.ts` allowedHeaders to include `x-idempotency-key, idempotency-key`**
- [ ] **Step 4: Update `src/notifications/notifications.repository.ts` raw query to alias snake_case columns to camelCase**
- [ ] **Step 5: Run tests and verify all pass**
- [ ] **Step 6: Commit changes**

---

### Task 2: Identity & System Authority Hardening (AUTH-01, AUTH-04)

**Files:**
- Modify: `src/auth/auth.service.ts:500-580`
- Modify: `src/auth/jwt.strategy.ts:70-110`
- Test: `tests/auth_authority_hardening.spec.ts`

**Interfaces:**
- Consumes: Database User role and status.
- Produces: Tamper-proof role resolution in refresh token flow and inactive account protection.

- [ ] **Step 1: Write failing test verifying `SYSTEM_ADMIN` is not elevated to `SUPER_ADMIN` upon refresh token**
- [ ] **Step 2: Write failing test verifying OTP verification rejects inactive/blocked accounts**
- [ ] **Step 3: Refactor role resolution in `src/auth/auth.service.ts` to derive strictly from database role code**
- [ ] **Step 4: Add active status verification in email OTP verification pipeline**
- [ ] **Step 5: Run tests and verify all pass**
- [ ] **Step 6: Commit changes**

---

### Task 3: Financial & Payout Invariant Hardening (PAY-01, PAY-02, PAY-03)

**Files:**
- Modify: `src/admin/admin.service.ts:250-380`
- Modify: `src/admin/admin.repository.ts:260-350`
- Test: `tests/admin_payout_invariants.spec.ts`

**Interfaces:**
- Consumes: PayOS Payout responses and Store Wallet transactions.
- Produces: Safe payout status transition (`PENDING_RECONCILIATION`), atomic withdrawal row locking.

- [ ] **Step 1: Write failing test for PayOS timeout scenario asserting balance is NOT refunded**
- [ ] **Step 2: Write failing test for concurrent reject vs payout asserting withdrawal row-lock serialization**
- [ ] **Step 3: Update `admin.service.ts` to retain `PENDING_RECONCILIATION` when PayOS result is uncertain instead of auto-refunding**
- [ ] **Step 4: Add `SELECT ... FOR UPDATE` on `store_withdrawal` row in `admin.repository.ts` prior to status check and wallet mutation**
- [ ] **Step 5: Run tests and verify all pass**
- [ ] **Step 6: Commit changes**

---

### Task 4: Data Isolation & BOLA Protections (DATA-01, DATA-04, DATA-05, DEV-01)

**Files:**
- Modify: `src/orders/orders.service.ts:180-230`
- Modify: `src/stores/stores.service.ts:25-50`
- Modify: `src/devices/devices.service.ts:120-170`
- Modify: `src/devices/dto/device-response.dto.ts`
- Test: `tests/data_isolation_bola.spec.ts`

**Interfaces:**
- Consumes: User context and entity query functions.
- Produces: Whitelisted StoreMe DTO without wallet leaks to non-owner staff, masked `hmacSecret`, fail-closed order ownership.

- [ ] **Step 1: Write failing test asserting non-owner cannot read cancelled order**
- [ ] **Step 2: Write failing test asserting Store Staff cannot see wallet balance in `GET /stores/me`**
- [ ] **Step 3: Write failing test asserting Device endpoints do not leak `hmacSecret`**
- [ ] **Step 4: Update `orders.service.ts` to enforce ownership check before any status-based early return**
- [ ] **Step 5: Update `stores.service.ts` to strip wallet information from `StoreMeResponseDto` when user is not Store Owner or Manager**
- [ ] **Step 6: Ensure `hmacSecret` is excluded from all device response DTOs**
- [ ] **Step 7: Enforce store ownership check when assigning products to buttons in `devices.service.ts`**
- [ ] **Step 8: Run tests and verify all pass**
- [ ] **Step 9: Commit changes**

---

### Task 5: Delivery Order Status Transition Invariant (ORDER-01)

**Files:**
- Modify: `src/orders/orders.controller.ts:110-140`
- Modify: `src/orders/orders.service.ts:400-470`
- Test: `tests/order_delivery_transition.spec.ts`

**Interfaces:**
- Consumes: Order status transition request.
- Produces: Enforced delivery proof and assigned driver check when changing order status to `DELIVERED`.

- [ ] **Step 1: Write failing test asserting generic PATCH status cannot mark order `DELIVERED` without POD and assigned driver check**
- [ ] **Step 2: Implement validation in `orders.service.ts` routing delivery transitions through dedicated delivery validation rules**
- [ ] **Step 3: Run tests and verify all pass**
- [ ] **Step 4: Commit changes**

---

### Task 6: Button Rental FSM & Customer Bank Account Onboarding (RENT-01, RENT-02, RENT-04, RENT-05)

**Files:**
- Modify: `src/rentals/rentals.repository.ts:880-920, 1180-1230`
- Modify: `src/rentals/rentals.service.ts:250-320`
- Create: `src/customers/customer-bank-accounts.controller.ts`
- Create: `src/customers/customer-bank-accounts.service.ts`
- Create: `src/customers/dto/create-customer-bank-account.dto.ts`
- Modify: `src/customers/customers.module.ts`
- Create: `prisma/migrations/20261101000000_rental_multi_button_deposit_fix/migration.sql`
- Test: `tests/rental_fsm_and_bank_onboarding.spec.ts`

**Interfaces:**
- Consumes: Rental Handover request, Customer bank account registration.
- Produces: Aligned rental device state machine (`ASSIGNED_TO_RENTAL` -> `IN_CUSTOMER_CUSTODY`), AES-encrypted customer bank account onboarding endpoints.

- [ ] **Step 1: Write failing test for rental device handover from `ASSIGNED_TO_RENTAL` state**
- [ ] **Step 2: Write failing test for customer bank account creation and retrieval**
- [ ] **Step 3: Update `rentals.repository.ts` handover logic to accept `ASSIGNED_TO_RENTAL` and transition to `IN_CUSTOMER_CUSTODY` with customerId binding**
- [ ] **Step 4: Implement Customer Bank Accounts controller and service with AES-256 encryption and SHA-256 hash indexing**
- [ ] **Step 5: Create corrective additive migration for multi-button rental deposit tracking**
- [ ] **Step 6: Run tests and verify all pass**
- [ ] **Step 7: Commit changes**

---

### Task 7: Admin Store Rename & Update API (Feature Addition)

**Files:**
- Create: `src/admin/dto/update-admin-store.dto.ts`
- Modify: `src/admin/admin.controller.ts:35-50`
- Modify: `src/admin/admin.service.ts:60-90`
- Modify: `src/admin/admin.repository.ts:70-100`
- Test: `tests/admin_store_update.spec.ts`

**Interfaces:**
- Consumes: `PATCH /api/v1/admin/stores/:id` with `UpdateAdminStoreDto`.
- Produces: Super Admin ability to rename or update any store's profile by ID.

- [ ] **Step 1: Write failing test for `PATCH /api/v1/admin/stores/:id` (Super Admin updates store name, address, phone)**
- [ ] **Step 2: Create `UpdateAdminStoreDto` with class-validator decorators (`@IsOptional`, `@IsString`, `@MaxLength`)**
- [ ] **Step 3: Add `PATCH /admin/stores/:id` endpoint in `admin.controller.ts` guarded by `@Roles('SUPER_ADMIN')`**
- [ ] **Step 4: Implement `updateStoreById` in `admin.service.ts` and `admin.repository.ts`**
- [ ] **Step 5: Run tests and verify all pass**
- [ ] **Step 6: Commit changes**
