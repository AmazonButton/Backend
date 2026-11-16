# Business Logic 13-Point Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development and superpowers:verification-before-completion to implement and verify this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remediate all 13 business logic vulnerabilities and state-machine discrepancies across Store Subscriptions, Button Rentals, IoT Warranty, Orders, Devices, Products/Inventory, Store Wallet, Analytics, and Auth.

**Architecture:** Enforces strict 6-layer NestJS + Prisma transactional invariants (`SELECT ... FOR UPDATE`), Zero Client Trust, collateral conservation (`200.000 VND` per active button), and immediate financial/inventory settlement on POD delivery (`DELIVERED`).

**Tech Stack:** NestJS, TypeScript, Prisma ORM, PostgreSQL.

## Global Constraints
- Store trial plans are identified strictly by `Number(plan.price) === 0 || plan.planCode.toUpperCase().includes('TRIAL')` (never by `durationDays <= 7` alone).
- `StoreSubscriptionsController.createRenewCharge` must allow 0 VND trial plans to pass `getPlanForCheckout(..., { allowFreeTrial: true })` and activate directly, while paid short-duration plans (`price >= 2000`, `durationDays <= 7`) proceed to PayOS checkout.
- `validateStoreCanListProducts` must reject upcoming subscriptions (`isUpcoming` / `startDate > now`).
- `Warranty` 1-1 swap (`approveSwap`) is restricted strictly to `GROUP_A` (0% deduction) and must transfer `rentalId`, `addressId`, `buttonProducts`, and set `inventoryState = 'IN_CUSTOMER_CUSTODY'`.
- `Warranty` device lock (`lockDevice`) for damaged/lost devices deducts `deductionAmount` from `rental_deposits.held_amount`, creates a `DepositRefund` (`PENDING_APPROVAL`) for any remaining `refundAmount > 0` of that button's deposit, detaches the button from the rental, and marks the rental `RETURNED` if no buttons remain.
- Store withdrawals remain `PENDING` until Admin approval; `StoreWalletService.syncWithdrawalPayoutStatus` must not auto-trigger PayOS payout on `PENDING` withdrawals.
- First-time 37-day button rental bonus counts only paid/activated prior rentals (`status NOT IN ('CANCELLED', 'PENDING_PAYMENT')`) and auto-cancels stale `PENDING_PAYMENT` draft rentals for that customer upon creating a new rental contract.
- `completeDeliveryAtomicTx` (`DELIVERED` with POD) immediately deducts `quantity_on_hand` & `reserved_quantity` and credits PayOS `ORDER_REVENUE` to `store_wallets`; `completeOrderAtomicTx` (`COMPLETED`) skips inventory deduction if transitioning from `DELIVERED`.

---

### Task 1: Store Subscriptions (`renew-charge` Trial vs Short Paid Plan & `isUpcoming` Guard)
- [x] **Step 1:** Write failing tests in `tests/business-logic-13-fixes.spec.ts` for Points 1 & 2.
- [x] **Step 2:** Update `src/store-subscriptions/store-subscriptions.service.ts`, `src/store-subscriptions/store-subscriptions.controller.ts`, and `src/store-subscriptions/store-subscriptions.repository.ts`.

### Task 2: IoT Warranty Collateral & 1-1 Swap Integrity + Device `canOrder` Guards
- [x] **Step 1:** Write failing tests in `tests/business-logic-13-fixes.spec.ts` for Points 3, 4, & 5.
- [x] **Step 2:** Update `src/warranty/warranty.service.ts`, `src/warranty/warranty.repository.ts`, `src/orders/orders.service.ts`, and `src/devices/devices.service.ts`.

### Task 3: Order Refund Row-Lock & Analytics `paidRevenue` + Store Withdrawal `PENDING` Guard
- [x] **Step 1:** Write failing tests in `tests/business-logic-13-fixes.spec.ts` for Points 6 & 7.
- [x] **Step 2:** Update `src/orders/orders.repository.ts`, `src/analytics/analytics.repository.ts`, and `src/store-wallet/store-wallet.service.ts`.

### Task 4: Button Rentals (37-Day First-Time Bonus Draft Cleanup & Handover Entitlement Days)
- [x] **Step 1:** Write failing tests in `tests/business-logic-13-fixes.spec.ts` for Points 8 & 9.
- [x] **Step 2:** Update `src/rentals/rentals.repository.ts`, `src/rentals/rental-handover.transaction.ts`, and align `tests/trial-and-rental-duration.spec.ts`.

### Task 5: Products Inventory Reservation Floor, `DELIVERED` Settlement, Auth Resend OTP & Admin BOLA
- [x] **Step 1:** Write failing tests in `tests/business-logic-13-fixes.spec.ts` for Points 10, 11, 12, & 13.
- [x] **Step 2:** Update `src/products/products.repository.ts`, `src/orders/orders.repository.ts`, `src/orders/orders.service.ts`, and `src/auth/auth.service.ts`.
