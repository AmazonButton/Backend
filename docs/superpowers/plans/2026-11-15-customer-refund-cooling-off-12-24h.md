# Customer Refund Cooling-Off Window (12–24h) & Security Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a configurable 12–24 hour Cooling-off Period (Hold Window) for Customer Bank Verification Refunds and IoT Button Deposit Refunds to protect against fraud, allow bank batch settlement, and provide clear UI/UX feedback to users, followed by a full Backend Security Audit verification.

**Architecture:** 
- Configurable environment variable `CUSTOMER_REFUND_COOLING_OFF_HOURS=12` (default 12 hours, range 12–24 hours).
- In `CustomersRepository.findPendingRefundObligations`: Filter obligations where `createdAt <= NOW() - INTERVAL 'X hours'` so worker only claims matured refund obligations.
- In `CustomerBankRefundWorker`: Log cooling-off statistics and process matured obligations safely.
- In `Frontend`: Update `banking-flow.ts` and `CustomerBankingPage.tsx` / `CustomerRentalsPage.tsx` to communicate the 12–24h processing SLA clearly to customers.
- Security-by-Design verification: Run comprehensive backend security audit test suites covering BOLA, SQL injection, token revocation, rate limiting, and information leakage.

**Tech Stack:** NestJS, TypeScript, Prisma ORM, PostgreSQL, React, Vite, Supertest.

**Spec:** [SESSION_HANDOFF.md](file:///f:/Learning/SEM9-FPTu/backend/SESSION_HANDOFF.md) and User Request on 2026-11-15.

---

## Global Constraints

- Never execute live PayOS Payouts without explicit `FEATURE_CUSTOMER_REFUND_PAYOUT_ENABLED=true` flag.
- Zero Client Trust: The server strictly determines eligibility and cooling-off maturation based on database timestamps (`createdAt`).
- Zero SQL string concatenation; all queries use parameterized inputs or Prisma typed models.
- All errors masked in production; never expose stack traces or DB internals to client.

---

## Review Focus

1. **Premature Payout Prevention**: Ensure obligations created < 12h ago are NOT claimed by `processRefundWorkerBatch`.
2. **Matured Obligation Payout**: Ensure obligations created >= 12h ago ARE claimed and processed normally.
3. **Admin Force/Manual Bypass**: Ensure admin manual refund endpoint still functions if immediate override is required.
4. **UI Clarity**: Ensure the customer is shown `12–24 giờ làm việc` instead of generic confusing statuses.
5. **Security Invariants**: Ensure BOLA tenant isolation and token revocation remain 100% intact.

---

## Tasks

### Task 1: Backend Cooling-Off Window Filter in CustomersRepository & Service

- [ ] Add `coolingOffHours` parameter to `findPendingRefundObligations(limit = 20, minAgeHours?: number)`.
- [ ] Add `eligibleBefore` cutoff calculation using `minAgeHours ?? Number(process.env.CUSTOMER_REFUND_COOLING_OFF_HOURS || 12)`.
- [ ] Update query filter in `prisma.customerBankRefundObligation.findMany` with `createdAt: { lte: cutoff }`.
- [ ] Expose `coolingOffHours` and `estimatedRefundAt` in Customer Bank Verification DTO / response so Frontend can display expected payout time.

### Task 2: Unit & Integration Tests for Cooling-Off Filter

- [ ] Create test in `tests/customer-refund-cooling-off.spec.ts`.
- [ ] Test 1: An obligation created 1 hour ago is IGNORED by the worker (0 claimed).
- [ ] Test 2: An obligation created 13 hours ago is CLAIMED by the worker (1 claimed).
- [ ] Test 3: Environment variable override (e.g. `CUSTOMER_REFUND_COOLING_OFF_HOURS=24`) properly enforces 24h cutoff.
- [ ] Run test suite with `npx ts-node tests/customer-refund-cooling-off.spec.ts` and confirm all pass.

### Task 3: Frontend Messaging & Status SLA Updates

- [ ] Update `Frontend/src/services/banking-flow.ts`:
  - Enhance `bankRefundMessage` for `PENDING` status to: `"Hệ thống đã ghi nhận hoàn tiền; tiền sẽ được đối soát và chuyển về tài khoản của bạn sau 12–24 giờ làm việc."`
  - Enhance `PROCESSING` status to: `"Hệ thống đang tiến hành chi trả chuyển hoàn; đang chờ ngân hàng xác nhận giao dịch."`
- [ ] Update `CustomerBankingPage.tsx` & `CustomerRentalsPage.tsx`:
  - Display helpful tooltip/badge explaining the 12–24h bank settlement window.
- [ ] Run `npx tsc --noEmit` and `npm run build` in Frontend to verify zero regression.

### Task 4: Comprehensive Security Audit Test Suite Execution

- [ ] Run backend security audit test suites:
  - `tests/comprehensive-audit.spec.ts` or `tests/security-audit-waves-fixes.spec.ts`.
  - `tests/data_isolation_bola.spec.ts` (BOLA Tenant Isolation).
  - `tests/auth_authority_hardening.spec.ts` (Authentication & Token Invariants).
- [ ] Verify 100% PASS with evidence and zero security violations.
- [ ] Update `SESSION_HANDOFF.md` with audit evidence and cooling-off flow handoff.
