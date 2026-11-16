# Dynamic Store Subscription PayOS Checkout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

This plan implements dynamic PayOS payment for store subscription plans configured by admins (supporting arbitrary valid prices like 2.000đ, 30.000đ, 60.000đ, etc.) with plan snapshot immutability, zero-trust backend price validation, webhook replay protection, and frontend contract coordination.

---

## Proposed Changes

### Database Layer (`prisma/schema.prisma` & Migrations)
- Add `planId BigInt? @map("plan_id")` and `planSnapshot Json? @map("plan_snapshot")` to `BillingCharge`.
- Create migration `20261116043000_add_billing_charges_plan_snapshot`.
- Deploy migration across Neon and Supabase multi-cloud databases.

### Backend (`src/billing-charges/`, `src/store-subscriptions/`)
- `RenewSubscriptionChargeDto`: Validate required `planId` (number | string), optional `returnUrl`, `cancelUrl`.
- `StoreSubscriptionsController.createRenewCharge`: Fetch `SubscriptionPlan` by `planId` from database. Validate active status, reject 0đ (guidance to free flow), reject < 2.000đ (PayOS minimum constraint).
- `BillingChargesService.createStoreSubscriptionCharge`: Build charge with snapshot of `{ planId, planCode, planName, price, durationDays, maxProducts, snapshotAt }`.
- `BillingChargesRepository.settleCharge`: In `STORE_SUBSCRIPTION` settlement, read plan details directly from `plan_snapshot` to guarantee that admin plan edits post-checkout creation do not alter granted entitlements.

### Frontend (`F:\Learning\SEM9-FPTu\Frontend`)
- `src/services/store-service-plans.ts`:
  - `eligibleStorePayosPlan`: Replace 60.000đ / 30-day hardcoding with `plan.isActive && plan.price >= 2000`.
  - `createPayosCharge`: Send `planId` in request body; remove `result?.amount !== 60000` assertion.
  - `charge`: Remove `Number(result.totalAmount) !== 60000` assertion.
- `src/components/store/StorePlanPayosPayment.tsx`:
  - Send `selected.planId` to `createPayosCharge`.
  - Render dynamic plan name, price, and duration.

---

## Verification Plan

### Automated Tests
- Test file: `tests/store-subscription-dynamic-payos.spec.ts`
  - Non-existent plan throws `NotFoundException` (404).
  - Inactive plan throws `BadRequestException` (400).
  - 0 VND plan throws `BadRequestException` pointing to free subscription endpoint.
  - Plan price < 2.000 VND throws `BadRequestException` (PayOS minimum constraint).
  - Dynamic price (e.g. 2.000đ, 30.000đ) generates PayOS charge with exact amount and `plan_snapshot`.
  - Post-creation price mutation safety: Changing plan price in DB does not affect existing checkout link or granted subscription.
  - Webhook settlement: Grants exact duration and planId recorded in snapshot.
  - Webhook replay: Idempotent return without duplicate subscription.
- CI/CD & Security regression:
  - Run `tests/store-subscription-dynamic-payos.spec.ts`.
  - Run `npx tsc --noEmit` on Backend & Frontend.
  - Run `npm run build` on Backend.

---

## Tasks

- [x] **Task 1: Database Schema & Multi-Cloud Migration**
  - [x] Update `prisma/schema.prisma` with `planId` and `planSnapshot` on `BillingCharge`.
  - [x] Create migration SQL `prisma/migrations/20261116043000_add_billing_charges_plan_snapshot/migration.sql`.
  - [x] Deploy migration to Neon (`npx prisma migrate deploy`).
  - [x] Create and run `scripts/deploy_supabase_billing_plan_snapshot.js` for Supabase.
  - [x] Verify column parity on both databases.

- [x] **Task 2: Backend Dynamic PayOS Checkout & Settlement**
  - [x] Create `src/store-subscriptions/dto/renew-subscription-charge.dto.ts`.
  - [x] Update `StoreSubscriptionsController.createRenewCharge` with plan lookup, validation (isActive, 0đ, <2k), and DTO binding.
  - [x] Update `BillingChargesService.createStoreSubscriptionCharge` to capture plan snapshot and write `planId`.
  - [x] Update `BillingChargesRepository.settleCharge` to read `plan_snapshot` and grant exact entitlements.
  - [x] Verify backend compilation with `npm run build`.

- [x] **Task 3: Frontend Contract & Component Updates**
  - [x] Update `Frontend/src/services/store-service-plans.ts` to allow dynamic `eligibleStorePayosPlan`, pass `planId`, and eliminate 60k checks.
  - [x] Update `Frontend/src/components/store/StorePlanPayosPayment.tsx` to pass `selected.planId`.
  - [x] Verify frontend typecheck with `npx tsc --noEmit` and build with `npm run build`.

- [x] **Task 4: Automated Integration & Invariant Tests**
  - [x] Write `tests/store-subscription-dynamic-payos.spec.ts` covering all 8 test cases.
  - [x] Run test suite with `npx ts-node tests/store-subscription-dynamic-payos.spec.ts`.
  - [x] Run security regression suites (`tests/security-audit-waves-fixes.spec.ts`, `tests/withdrawal-concurrency-idempotency.spec.ts`).

- [ ] **Task 5: Git Commit, Push & Deployment Verification**
  - [ ] Commit and push Backend to `main`.
  - [ ] Commit and push Frontend to `dev`.
  - [ ] Trigger & verify AWS Node 3 deploy via `npm run aws:deploy`.
  - [ ] Verify Render Node 1 and Node 2 deploy status via Render API.
  - [ ] Verify GitHub Actions CI/CD pipeline completes with green status.
  - [ ] Update `SESSION_HANDOFF.md`.
