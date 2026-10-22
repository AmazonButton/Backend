# Multi-vendor Marketplace, Button Rental & Store Wallet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform the IoT button e-commerce platform into a multi-vendor marketplace with store listing subscriptions, customer periodic IoT button rentals (with admin pricing & kit config), and marketplace escrow with store wallet balance management & bank withdrawals.

**Architecture:** Extend Prisma schema with 7 models (`SubscriptionPlan`, `StoreSubscription`, `RentalPackage`, `ButtonRental`, `StoreWallet`, `WalletTransaction`, `StoreWithdrawal`). Connect order completion lifecycle in `OrdersService` to `StoreWallet` escrow crediting, and provide dedicated NestJS modules for Admin management, Store wallet operations, and Customer rental contracts.

**Tech Stack:** NestJS, TypeScript, Prisma ORM, PostgreSQL (Supabase), PayOS API v2, Jest.

**Spec:** `docs/superpowers/specs/2026-10-01-marketplace-rental-and-store-wallet-design.md`

## Global Constraints
- All database mutations must use Prisma transactions (`prisma.$transaction`) where multi-step wallet balance changes and transaction logs occur to prevent race conditions or balance drift.
- BigInt values must be serialized to string in API DTO responses to prevent JSON BigInt serialization crashes.
- Do not introduce breaking changes to existing order placement or IoT button event triggers.
- Unit and integration tests must achieve green status before marking any task complete.

## Review Focus
1. Double withdrawal prevention: Submitting a withdrawal request must immediately deduct `balance` to prevent race conditions before admin review.
2. Rejection refund idempotency: Admin rejection of a withdrawal must only refund once, returning the exact amount to the store's wallet with a traceable `REFUND` audit log.
3. Order completion revenue crediting: Only orders that have `paymentStatus == 'PAID'` and `paymentMethod == 'ONLINE'` trigger wallet credit upon transitioning to `COMPLETED`.
4. Subscription validity check: Expired store subscriptions must block new product creation or flag the store as renewal pending.
5. Rental hardware association: Customer rental contract must be able to link multiple physical `IoTButton` records for kit packages (e.g., 3-button bundle).

---

### Task 1: Prisma Schema Migration & Database Sync

**Files:**
- Modify: `prisma/schema.prisma`
- Test: Verification script `tests/database-schema.spec.ts`

**Interfaces:**
- Consumes: Existing `Store`, `CustomerProfile`, `IoTButton`, `Order` models
- Produces: 7 new Prisma models: `SubscriptionPlan`, `StoreSubscription`, `RentalPackage`, `ButtonRental`, `StoreWallet`, `WalletTransaction`, `StoreWithdrawal`

- [ ] **Step 1: Write database schema verification test**
Add assertions checking that Prisma client exports the new delegates (`subscriptionPlan`, `storeSubscription`, `rentalPackage`, `buttonRental`, `storeWallet`, `walletTransaction`, `storeWithdrawal`).

- [ ] **Step 2: Run test to verify it fails**
Run: `npx jest tests/database-schema.spec.ts`
Expected: FAIL due to missing Prisma delegates.

- [ ] **Step 3: Update `prisma/schema.prisma` and run `npx prisma db push`**
Append the 7 models and update relations on `Store`, `IoTButton`, and `CustomerProfile`. Execute `npx prisma db push` to synchronize Supabase database.

- [ ] **Step 4: Run test to verify it passes**
Run: `npx jest tests/database-schema.spec.ts`
Expected: PASS with database models verified.

- [ ] **Step 5: Commit**
```bash
git add prisma/schema.prisma tests/database-schema.spec.ts
git commit -m "feat(db): add marketplace subscriptions, button rentals, and store wallet models"
```

---

### Task 2: Admin Plans & Rental Packages Management

**Files:**
- Create: `src/admin/dto/plans.dto.ts`
- Create: `src/admin/dto/rental-packages.dto.ts`
- Modify: `src/admin/admin.service.ts`
- Modify: `src/admin/admin.controller.ts`
- Test: `tests/admin-plans.spec.ts`

**Interfaces:**
- Consumes: `PrismaService`
- Produces: Admin endpoints for CRUD on `SubscriptionPlan` and `RentalPackage`

- [ ] **Step 1: Write the failing test for Admin Plans & Rental Packages**
Test creating, listing, and updating a store subscription plan and an IoT button rental package (single vs kit of 3).

- [ ] **Step 2: Run test to verify it fails**
Run: `npx jest tests/admin-plans.spec.ts`
Expected: FAIL with method not found.

- [ ] **Step 3: Implement Plans and Packages CRUD in `admin.service.ts` and `admin.controller.ts`**
Implement methods:
- `createSubscriptionPlan(dto)`, `listSubscriptionPlans()`, `updateSubscriptionPlan(id, dto)`
- `createRentalPackage(dto)`, `listRentalPackages()`, `updateRentalPackage(id, dto)`

- [ ] **Step 4: Run test to verify it passes**
Run: `npx jest tests/admin-plans.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**
```bash
git add src/admin/ tests/admin-plans.spec.ts
git commit -m "feat(admin): implement subscription plans and button rental packages management"
```

---

### Task 3: Customer Button Rental System & PayOS Checkout

**Files:**
- Create: `src/rentals/dto/rentals.dto.ts`
- Create: `src/rentals/rentals.service.ts`
- Create: `src/rentals/rentals.controller.ts`
- Create: `src/rentals/rentals.module.ts`
- Modify: `src/app.module.ts`
- Test: `tests/customer-rentals.spec.ts`

**Interfaces:**
- Consumes: `PaymentsService` (PayOS link generation), `PrismaService`
- Produces: `GET /api/v1/rentals/packages`, `POST /api/v1/rentals/order`, `GET /api/v1/rentals/my-rentals`

- [ ] **Step 1: Write the failing test for Customer Rentals**
Test customer viewing packages, creating a rental contract for 1 or 3 months, and receiving a PayOS payment URL with contract status `PENDING_PAYMENT`.

- [ ] **Step 2: Run test to verify it fails**
Run: `npx jest tests/customer-rentals.spec.ts`
Expected: FAIL

- [ ] **Step 3: Implement `RentalsModule`**
Implement `RentalsService` to calculate rental total (`monthlyPrice * months + depositFee`), persist `ButtonRental`, and generate PayOS payment link.

- [ ] **Step 4: Run test to verify it passes**
Run: `npx jest tests/customer-rentals.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**
```bash
git add src/rentals/ src/app.module.ts tests/customer-rentals.spec.ts
git commit -m "feat(rentals): implement customer IoT button rental flow"
```

---

### Task 4: Store Wallet & Escrow Revenue Settlement Module

**Files:**
- Create: `src/store-wallet/dto/wallet.dto.ts`
- Create: `src/store-wallet/store-wallet.service.ts`
- Create: `src/store-wallet/store-wallet.controller.ts`
- Create: `src/store-wallet/store-wallet.module.ts`
- Modify: `src/orders/orders.service.ts` (hook into order completion)
- Modify: `src/app.module.ts`
- Test: `tests/store-wallet.spec.ts`

**Interfaces:**
- Consumes: `OrdersService`, `PrismaService`
- Produces: `GET /api/v1/store/wallet`, `PUT /api/v1/store/wallet/bank-account`, `GET /api/v1/store/wallet/transactions`

- [ ] **Step 1: Write the failing test for Store Wallet and Revenue Settlement**
Verify that completing an order with online payment automatically increments `StoreWallet.balance` and records an `ORDER_REVENUE` transaction.

- [ ] **Step 2: Run test to verify it fails**
Run: `npx jest tests/store-wallet.spec.ts`
Expected: FAIL

- [ ] **Step 3: Implement `StoreWalletService` and integrate with `OrdersService.updateOrderStatus`**
In `OrdersService`, when `newStatus === 'COMPLETED'`, call `storeWalletService.creditOrderRevenue(storeId, totalAmount, orderCode)`.

- [ ] **Step 4: Run test to verify it passes**
Run: `npx jest tests/store-wallet.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**
```bash
git add src/store-wallet/ src/orders/orders.service.ts src/app.module.ts tests/store-wallet.spec.ts
git commit -m "feat(wallet): implement store wallet balance and order completion escrow settlement"
```

---

### Task 5: Store Withdrawal Requests & Admin Approval/Transfer

**Files:**
- Create: `src/store-wallet/dto/withdrawal.dto.ts`
- Modify: `src/store-wallet/store-wallet.service.ts`
- Modify: `src/store-wallet/store-wallet.controller.ts`
- Modify: `src/admin/admin.service.ts`
- Modify: `src/admin/admin.controller.ts`
- Test: `tests/store-withdrawal.spec.ts`

**Interfaces:**
- Consumes: `StoreWalletService`, `PrismaService`
- Produces: `POST /api/v1/store/wallet/withdrawals`, `GET /api/v1/admin/withdrawals`, `POST /api/v1/admin/withdrawals/:id/transfer`, `POST /api/v1/admin/withdrawals/:id/reject`

- [ ] **Step 1: Write the failing test for Withdrawal Flow**
Test:
1. Store owner requests withdrawal of 500,000 VND -> wallet balance decreases immediately by 500,000 VND, withdrawal status is `PENDING`.
2. Admin rejects with reason -> 500,000 VND is refunded back to wallet balance with `REFUND` transaction.
3. Store re-requests and Admin marks as `TRANSFERRED` -> status changes to `TRANSFERRED`.

- [ ] **Step 2: Run test to verify it fails**
Run: `npx jest tests/store-withdrawal.spec.ts`
Expected: FAIL

- [ ] **Step 3: Implement Withdrawal Request & Admin Approval logic**
Ensure atomic updates inside `prisma.$transaction`.

- [ ] **Step 4: Run test to verify it passes**
Run: `npx jest tests/store-withdrawal.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**
```bash
git add src/store-wallet/ src/admin/ tests/store-withdrawal.spec.ts
git commit -m "feat(withdrawal): implement store withdrawal and admin bank transfer workflow"
```

---

### Task 6: Store Subscription Purchase & Listing Enforcement

**Files:**
- Create: `src/store-subscriptions/store-subscriptions.service.ts`
- Create: `src/store-subscriptions/store-subscriptions.controller.ts`
- Create: `src/store-subscriptions/store-subscriptions.module.ts`
- Modify: `src/products/products.service.ts`
- Modify: `src/app.module.ts`
- Test: `tests/store-subscriptions.spec.ts`

**Interfaces:**
- Consumes: `StoreWalletService`, `PrismaService`
- Produces: `POST /api/v1/store/subscriptions/subscribe`, `GET /api/v1/store/subscriptions/current`

- [ ] **Step 1: Write the failing test for Store Subscription**
Test subscribing with wallet balance: deducts wallet balance, creates active `StoreSubscription` with valid `endDate`, and verifies product creation is permitted.

- [ ] **Step 2: Run test to verify it fails**
Run: `npx jest tests/store-subscriptions.spec.ts`
Expected: FAIL

- [ ] **Step 3: Implement `StoreSubscriptionsModule` and check store subscription in `ProductsService.createProduct`**
Deduct plan fee from wallet balance, persist `StoreSubscription`, and log `SUBSCRIPTION_PAYMENT` in `WalletTransaction`.

- [ ] **Step 4: Run test to verify it passes**
Run: `npx jest tests/store-subscriptions.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**
```bash
git add src/store-subscriptions/ src/products/ tests/store-subscriptions.spec.ts
git commit -m "feat(subscriptions): implement store subscription purchase and listing enforcement"
```

---

### Task 7: Full End-to-End Integration & Master Verification

**Files:**
- Create: `tests/e2e-marketplace-ecosystem.spec.ts`

- [ ] **Step 1: Write full lifecycle E2E test**
Simulate complete business loop:
1. Admin configures Listing Plan (200k/mo) and Rental Package (50k/mo).
2. Store owner subscribes to listing plan.
3. Customer rents IoT Button and links to address.
4. Customer creates order via IoT button.
5. Customer pays online via PayOS.
6. Store marks order as `COMPLETED`.
7. Revenue is credited to Store Wallet.
8. Store requests bank withdrawal.
9. Admin confirms transfer.

- [ ] **Step 2: Run test to verify entire flow passes**
Run: `npx jest tests/e2e-marketplace-ecosystem.spec.ts`
Expected: ALL PASS with 100% assertions green.

- [ ] **Step 3: Run entire project test suite**
Run: `npm test`
Expected: All existing and new tests pass cleanly.

- [ ] **Step 4: Commit and push to GitHub repository**
```bash
git push origin main
```
