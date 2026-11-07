# Implementation Plan: Store Bank Verification & Subscription Handoff Fixes

Date: 2026-11-08
Target: Resolution of Frontend Handoff 2026-11-07 issues (`update_required for backend.md` & `STORE_SUBSCRIPTION_BACKEND_HANDOFF_2026-11-07.md`)

## 1. Objectives & Scope
1. **Fix Bank Verification Ownership 403 (Task 1)**:
   - Allow active `STORE_OWNER` staff (`store_staff` table) and admin roles (`SUPER_ADMIN`, `SYSTEM_ADMIN`, `ADMIN`) to manage store bank accounts in `BankVerificationService.verifyStoreOwnership()`.
2. **Enrich Penny Verification Request with Receiving Bank Account Details (Task 2)**:
   - In `BankVerificationService.createVerificationRequest()`, return platform receiving bank details (`recipientBankBin`, `recipientBankName`, `recipientAccountNumber`, `recipientAccountHolder`, `qrCodeUrl`, `instructions`) so frontend can render VietQR and manual transfer instructions for the penny verification.
3. **Fix Current Subscription Period Overwriting (Task 3)**:
   - In `StoreSubscriptionsRepository.getCurrentSubscription()`, prioritize the running period where `startDate <= now AND endDate >= now`.
   - Prevent prepaid / upcoming renewals (`startDate > now`) from masking current active subscription privileges.
   - Add `getUpcomingSubscription()` to repository and enrich service response with `isUpcoming`, `isExpired`, and `upcomingSubscription`.
4. **Provide Route Alias for Frontend Convenience (Task 4)**:
   - Add `@Get('plans')` in `StoreSubscriptionsController` returning `subscriptionsService.listPlans()` with `@Roles('STORE_OWNER', 'STORE_MANAGER', 'SUPER_ADMIN', 'SYSTEM_ADMIN', 'ADMIN', 'CUSTOMER')` so `GET /api/v1/store/subscriptions/plans` works without 404/403.
5. **Comprehensive Verification & TDD Test Suite (Task 5)**:
   - Create `tests/store-bank-and-subscription-handoff-fixes.spec.ts` covering:
     * Staff `STORE_OWNER` and Admin access to store bank accounts without 403.
     * Unauthorized staff rejection (403).
     * Penny verification response includes platform receiving bank details and VietQR link.
     * Concurrent/prepaid subscriptions: `getCurrentSubscription` returns current active period, not future prepaid period.
     * Route alias `GET /store/subscriptions/plans` returns plans catalog.
   - Run type checks, unit/integration tests, and ensure build success.

---

## 2. Detailed Task Breakdown

### Task 1: `BankVerificationService.verifyStoreOwnership` Authorization Enhancement
- **File**: `src/bank-verification/bank-verification.service.ts`
- **Logic**:
  - Accept `userRole?: string`.
  - Admin roles `SUPER_ADMIN`, `SYSTEM_ADMIN`, `ADMIN` are immediately authorized.
  - Check direct ownership: `store.ownerUserId === userId`.
  - If not direct owner, query `storeStaff` table:
    ```typescript
    const staffOwner = await this.prisma.storeStaff.findFirst({
      where: {
        storeId,
        userId,
        status: 'ACTIVE',
        leftAt: null,
        role: { roleCode: { in: ['STORE_OWNER', 'OWNER'] } },
      },
    });
    ```
  - If matched, permit operation; otherwise throw `ForbiddenException`.

### Task 2: Platform Receiving Bank Account in Verification Request
- **File**: `src/bank-verification/bank-verification.service.ts`
- **Logic**:
  - Read platform receiving bank configurations:
    - `PLATFORM_BANK_BIN` (default `970422`)
    - `PLATFORM_BANK_NAME` (default `MBBank`)
    - `PLATFORM_BANK_ACCOUNT_NUMBER` (default `0339898989`)
    - `PLATFORM_BANK_ACCOUNT_HOLDER` (default `CONG TY CP SMART ORDER`)
  - Construct VietQR URL: `https://img.vietqr.io/image/${recipientBankBin}-${recipientAccountNumber}-compact2.png?amount=${expectedAmount}&addInfo=${encodeURIComponent(referenceCode)}&accountName=${encodeURIComponent(recipientAccountHolder)}`
  - Return updated response object containing both store account info and recipient platform bank info.

### Task 3: Subscription Period Resolution & Upcoming Renewals
- **Files**:
  - `src/store-subscriptions/store-subscriptions.repository.ts`
  - `src/store-subscriptions/store-subscriptions.service.ts`
- **Logic**:
  - In `getCurrentSubscription(storeId: bigint)`:
    - Query active running subscription (`status: 'ACTIVE', startDate: { lte: now }, endDate: { gte: now }`).
    - If none running, fallback to upcoming subscription (`startDate: { gt: now }`) ordered by `startDate ASC`.
    - If none, fallback to most recently expired subscription.
  - In `getUpcomingSubscription(storeId: bigint)`:
    - Find first upcoming active subscription (`status: 'ACTIVE', startDate: { gt: now }`, ordered by `startDate ASC`).
  - In `StoreSubscriptionsService.getCurrentSubscription`:
    - Enrich return payload with `daysRemaining`, `isUpcoming`, `isExpired`, and `upcomingSubscription`.

### Task 4: Store Subscription Plans Alias
- **File**: `src/store-subscriptions/store-subscriptions.controller.ts`
- **Logic**:
  - Add `@Get('plans')` before `@Get(':id')` to prevent parameter shadow.
  - Return `{ success: true, message: '...', data: plans }`.

### Task 5: Automated Verification & Test Suite
- **File**: `tests/store-bank-and-subscription-handoff-fixes.spec.ts`
- **Validation**:
  - Execute test suite using `tsx`.
  - Type-check with `npx tsc --noEmit`.
  - Build check with `npm run build`.
