# Smart Order IoT Backend - Calibrated Waterfall Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Execution mode: **Native** (sequential within current context). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remediate architectural debt (6-layer enforcement, contract fixes, pagination envelope, inventory row locking), implement missing P0/P1 endpoints across 43 Prisma models, and establish a release gate with comprehensive regression test suites.

**Architecture:** Strict 6-layer pipeline (`Router Layer` -> `Guards/Middleware` -> `Controller Layer` -> `Service Layer` -> `Repository Layer` -> `PostgreSQL Database`).
- Controllers only inject Services and return standardized uniform response envelopes.
- WebSocket event emission and database transactions reside strictly in Service/Repository layers.
- Multi-instance concurrency protected via PostgreSQL row-level locks (`SELECT FOR UPDATE`) and database partial unique constraints.
- Zero plaintext financial storage (AES-256-GCM + SHA-256 + masked DTOs via `WalletMapper`).

**Tech Stack:** NestJS 10, TypeScript 5, PostgreSQL 15, Prisma ORM, Redis 7 (BullMQ), PayOS, Class-Validator, TSX.

**Spec & Policy References:**
- [`BRD/ERD_Level_3_MultiStore_VN_V2.1.md`](file:///f:/Learning/SEM9-FPTu/backend/BRD/ERD_Level_3_MultiStore_VN_V2.1.md)
- [`Rules/NODEJS_BACKEND_SECURITY_RULES.md`](file:///f:/Learning/SEM9-FPTu/backend/Rules/NODEJS_BACKEND_SECURITY_RULES.md)
- [`Rules/BACKEND_API_DEVELOPMENT_RULES.md`](file:///f:/Learning/SEM9-FPTu/backend/Rules/BACKEND_API_DEVELOPMENT_RULES.md)
- [`AGENTS.md`](file:///f:/Learning/SEM9-FPTu/backend/AGENTS.md)
- [`prisma/schema.prisma`](file:///f:/Learning/SEM9-FPTu/backend/prisma/schema.prisma)

---

## Global Constraints & Canonical Invariants

1. **Uniform Pagination Envelope (Mandatory Across All Endpoints):**
   ```typescript
   {
     success: true,
     message: string,
     data: T[],
     pagination: {
       page: number,
       pageSize: number,
       totalItems: number,
       totalPages: number,
       hasNextPage: boolean,
       hasPrevPage: boolean
     }
   }
   ```
   - Limit `pageSize` strictly to maximum 100 (`pageSize <= 100`).
   - Default: `page = 1`, `pageSize = 20`.
   - Backward compatibility: map legacy `limit` query param to `pageSize` with warning.
2. **Canonical Role Matrix:**
   - Platform Level: `SUPER_ADMIN`, `SYSTEM_ADMIN` (Cross-store, global access).
   - Store Level: `STORE_OWNER` (Full store authority, financial payouts, staff setup), `STORE_MANAGER` (Store operations, category, staff view), `STAFF_ORDER` (Order processing), `STAFF_INVENTORY` (Stock management), `STAFF_DELIVERY` (Store dispatch coordination), `STAFF_BUTTON` (Device setup).
   - End-User Level: `CUSTOMER` (Orders, addresses, personal devices), `DRIVER` (Order claim, shift duty, delivery execution).
   - **Anti-Escalation Rule:** `STORE_OWNER` and `STORE_MANAGER` can ONLY manage store staff within `STORE_*` or `STAFF_*` roles. They are strictly prohibited from assigning or escalating to `SYSTEM_ADMIN` or `SUPER_ADMIN`.
3. **Static vs Parameterized Route Order:**
   - In Express / NestJS, static paths MUST be defined before parameter wildcard `:id` paths (e.g. `GET /orders/delivery-queue` registered BEFORE `GET /orders/:id`).
4. **Observable TDD Methodology:**
   - Integration tests must assert observable HTTP status codes, response envelope shape, database state mutations, and transaction rollback on failure.
   - Do NOT test private internal method delegation or implementation details in integration specs.
   - Concurrency tests must verify:
     - 2 concurrent requests claiming the last inventory item (`quantityOnHand = 1`).
     - 2 concurrent requests toggling `isDefault: true` on different addresses.
     - 2 concurrent requests submitting overlapping product discounts.

---

## Phase 0: Baseline & Architecture Decision Records (ADR)

### Task 0.1: Baseline System Health Verification
- [x] **Step 1: Check Git Status**
  Verify clean working tree with only plan tracked (`docs/superpowers/plans/2026-10-25-backend-waterfall-implementation-plan.md`).
- [x] **Step 2: Validate Prisma Schema**
  Run: `npx prisma validate`
  Result: Schema is valid.
- [x] **Step 3: Run TypeScript Typecheck**
  Run: `npx tsc --noEmit`
  Result: PASS (0 errors).
- [x] **Step 4: Run Production Build**
  Run: `npm run build`
  Result: PASS (Clean build, heap max 2048MB).
- [x] **Step 5: Run Baseline 16 Test Suites**
  Run: `npm run test:all`
  Result: 11/16 suites PASS. 5 failures isolated to pre-existing edge cases (pairing token active query in zero-touch, discount check in stored proc, and Suite 15 order state).

### Task 0.2: Settle Architecture Decision Records (ADR)
- [x] **ADR-1 (Rental Payment Integration):**
  - *Context:* `PaymentTransaction` currently requires `order_id` (`orderId BigInt @map("order_id")`).
  - *Decision:* Create a database migration in Task 4.1 to make `order_id` nullable (`orderId BigInt?`) and add `rental_id BigInt?` with foreign key relation to `ButtonRental`. Update PayOS webhook handler to inspect and route payments for both Orders and Rentals.
- [x] **ADR-2 (Customer Address Default Atomicity):**
  - *Context:* Race conditions when multiple clients toggle `isDefault: true`.
  - *Decision:* Add migration creating a PostgreSQL partial unique index:
    ```sql
    CREATE UNIQUE INDEX uq_customer_single_default ON customer_address(customer_id) WHERE is_default = true;
    ```
    Wrap address default switches in explicit transactions: set existing default to false, then set new default to true.
- [x] **ADR-3 (Customer Address Deletion Policy):**
  - *Context:* Address referenced by `iot_buttons`.
  - *Decision:* Hard-delete is safe because `orders` table persists historical address as text snapshot (`shipping_address`). However, delete MUST check foreign key references: reject with HTTP 400 `ADDRESS_IN_USE_BY_DEVICE` if any `IoTButton` is bound to `addressId`.
- [x] **ADR-4 (Product Discount Integrity Constraints):**
  - *Context:* Discount interval and exclusivity validity.
  - *Decision:* Add PostgreSQL check constraints via migration:
    ```sql
    ALTER TABLE product_discount ADD CONSTRAINT chk_discount_time_range CHECK (start_at < end_at);
    ALTER TABLE product_discount ADD CONSTRAINT chk_discount_exclusivity CHECK (
      (discount_percent IS NOT NULL AND discount_amount IS NULL) OR
      (discount_percent IS NULL AND discount_amount IS NOT NULL)
    );
    ```

---

## Phase 1: Contract & Architecture Remediation

### Task 1.1: Refactor StorefrontController to 6-Layer Architecture & Remove Raw Prisma / EventsGateway
**Files:**
- Modify: `src/orders/storefront.controller.ts`
- Modify: `src/orders/orders.service.ts`
- Modify: `src/orders/orders.repository.ts`
- Test: `tests/storefront-checkout-refactor.spec.ts`

**Interfaces:**
- Consumes: `CreateStorefrontOrderDto`
- Produces: `OrdersService.createStorefrontOrder(dto, customerUserId?)`
- Constraint: `StorefrontController` MUST ONLY inject `OrdersService`. `PrismaService` and `EventsGateway` must be removed from `StorefrontController`. WebSocket events emitted from Service after transaction commits.

- [x] **Step 1: Write integration test**
  In `tests/storefront-checkout-refactor.spec.ts`, test checkout endpoint returns standard envelope, creates order in DB, and rolls back cleanly on invalid inventory.
- [x] **Step 2: Run test to verify it fails**
  Run: `npx tsx tests/storefront-checkout-refactor.spec.ts`
  Expected: FAIL.
- [x] **Step 3: Move logic to Service and Repository**
  Extract transaction to `OrdersRepository.createStorefrontOrderTx`. Move event emission to `OrdersService`. Clean up controller constructor.
- [x] **Step 4: Run test to verify it passes**
  Run: `npx tsx tests/storefront-checkout-refactor.spec.ts`
  Expected: PASS (4/4 PASS).
- [x] **Step 5: Commit**
  ```bash
  git add src/orders/ tests/storefront-checkout-refactor.spec.ts
  git commit -m "refactor(orders): encapsulate storefront checkout in orders service and repository"
  ```

### Task 1.2: Add Explicit Inventory Concurrency Protection & Race Condition Test
**Files:**
- Modify: `src/orders/orders.repository.ts`
- Test: `tests/inventory-concurrency-race.spec.ts`

**Interfaces:**
- Consumes: Inventory rows for ordered products
- Produces: Row-level lock (`SELECT ... FOR UPDATE` or atomic decrement `WHERE quantity_on_hand >= $qty`)

- [x] **Step 1: Write concurrency race test**
  In `tests/inventory-concurrency-race.spec.ts`, set product stock to 1. Fire 2 simultaneous checkout requests. Assert exactly 1 succeeds (HTTP 201) and 1 fails with HTTP 400 `INSUFFICIENT_STOCK`. Stock ends at exactly 0.
- [x] **Step 2: Run test to verify race condition**
  Run: `npx tsx tests/inventory-concurrency-race.spec.ts`
  Expected: FAIL (or over-deduction if lock missing).
- [x] **Step 3: Implement explicit row locking in transaction**
  In `OrdersRepository.createStorefrontOrderTx`, query `inventory` with `SELECT FOR UPDATE` or execute atomic conditional decrement.
- [x] **Step 4: Run test to verify passes**
  Run: `npx tsx tests/inventory-concurrency-race.spec.ts`
  Expected: PASS (2/2 PASS).
- [x] **Step 5: Commit**
  ```bash
  git add src/orders/orders.repository.ts tests/inventory-concurrency-race.spec.ts
  git commit -m "fix(inventory): enforce row-level locking on inventory deduction during order creation"
  ```

### Task 1.3: Fix CreateProductDto & Category Ownership Contract
**Files:**
- Modify: `src/products/dto/create-product.dto.ts`
- Modify: `src/products/dto/update-product.dto.ts`
- Modify: `src/products/products.service.ts`
- Test: `tests/product-contract-validation.spec.ts`

**Interfaces:**
- Consumes: `CreateProductDto`
- Produces: Accepts `categoryId?: string`, removes mandatory `unit` requirement, validates category belongs to same store.

- [x] **Step 1: Write integration test**
  In `tests/product-contract-validation.spec.ts`, verify creating product with `categoryId` and no `unit` succeeds, and cross-store category reference is rejected with HTTP 400.
- [x] **Step 2: Run test to verify failure**
  Run: `npx tsx tests/product-contract-validation.spec.ts`
  Expected: FAIL.
- [x] **Step 3: Update DTO and service**
  Update `CreateProductDto` (`categoryId` string/number, optional `unit`). In `ProductsService`, verify `[storeId, categoryId]` composite relation.
- [x] **Step 4: Run test to verify passes**
  Run: `npx tsx tests/product-contract-validation.spec.ts`
  Expected: PASS (2/2 PASS).
- [x] **Step 5: Commit**
  ```bash
  git add src/products/ tests/product-contract-validation.spec.ts
  git commit -m "fix(products): align product DTO with Prisma schema and enforce category store ownership"
  ```

### Task 1.4: Standardize Canonical Pagination Envelope Across Existing Controllers
**Files:**
- Modify: `src/stores/stores.controller.ts`
- Modify: `src/stores/stores.service.ts`
- Modify: `src/drivers/drivers.controller.ts`
- Modify: `src/driver-shifts/driver-shifts.controller.ts`
- Modify: `src/common/dto/pagination-query.dto.ts`
- Test: `tests/canonical-pagination-envelope.spec.ts`

**Interfaces:**
- Consumes: `PaginationQueryDto` (`page`, `pageSize`, fallback `limit`)
- Produces: Uniform envelope with `{ page, pageSize, totalItems, totalPages, hasNextPage, hasPrevPage }`

- [x] **Step 1: Write failing test**
  Verify `GET /api/v1/stores`, driver shifts, and driver orders return uniform pagination metadata and cap `pageSize` at 100.
- [x] **Step 2: Run test to verify failure**
  Run: `npx tsx tests/canonical-pagination-envelope.spec.ts`
  Expected: FAIL.
- [x] **Step 3: Standardize controllers and services**
  Replace ad-hoc `limit` handling with standardized pagination helper returning uniform structure.
- [x] **Step 4: Run test to verify passes**
  Run: `npx tsx tests/canonical-pagination-envelope.spec.ts`
  Expected: PASS (4/4 PASS).
- [x] **Step 5: Commit**
  ```bash
  git add src/stores/ src/drivers/ src/driver-shifts/ src/common/ tests/canonical-pagination-envelope.spec.ts
  git commit -m "fix(api): standardize canonical pagination envelope and query caps across store and driver controllers"
  ```

---

## Phase 2: Core Entities (Sprint 1)

### Task 2.1: Customer Address CRUD Module & Partial Unique Default Constraint
**Files:**
- Create: `prisma/migrations/20261025100000_customer_address_constraints/migration.sql`
- Create: `src/customer-addresses/customer-addresses.module.ts`
- Create: `src/customer-addresses/customer-addresses.controller.ts`
- Create: `src/customer-addresses/customer-addresses.service.ts`
- Create: `src/customer-addresses/customer-addresses.repository.ts`
- Create: `src/customer-addresses/dto/create-customer-address.dto.ts`
- Create: `src/customer-addresses/dto/update-customer-address.dto.ts`
- Create: `src/customer-addresses/dto/customer-address-response.dto.ts`
- Modify: `src/app.module.ts`
- Test: `tests/customer-addresses-crud.spec.ts`

**Interfaces:**
- Consumes: `CustomerProfile.customerId` from authenticated `req.user.id`
- Produces:
  - `GET /api/v1/customer-addresses`
  - `POST /api/v1/customer-addresses`
  - `GET /api/v1/customer-addresses/:id`
  - `PATCH /api/v1/customer-addresses/:id`
  - `DELETE /api/v1/customer-addresses/:id`

- [x] **Step 1: Migration for partial unique index**
  Add partial index `uq_customer_single_default ON customer_address(customer_id) WHERE is_default = true;`. Run migration.
- [x] **Step 2: Write integration & concurrency test**
  In `tests/customer-addresses-crud.spec.ts`, test full CRUD, BOLA IDOR isolation, blocking delete when bound to `IoTButton`, and 2 concurrent `isDefault: true` requests resolving without duplicate defaults.
- [x] **Step 3: Implement 6-layer module**
  Implement controller, service, repository, DTO mappers. Register in `AppModule`.
- [x] **Step 4: Run test to verify passes**
  Run: `npx tsx tests/customer-addresses-crud.spec.ts`
  Expected: PASS (7/7 PASS).
- [x] **Step 5: Commit**
  ```bash
  git add prisma/migrations/ src/customer-addresses/ src/app.module.ts tests/customer-addresses-crud.spec.ts
  git commit -m "feat(customer-addresses): implement customer address CRUD with atomic default toggle and device reference guard"
  ```

### Task 2.2: Category Tree CRUD Module with Hierarchical Cycle Detection
**Files:**
- Create: `src/categories/categories.module.ts`
- Create: `src/categories/categories.controller.ts`
- Create: `src/categories/categories.service.ts`
- Create: `src/categories/categories.repository.ts`
- Create: `src/categories/dto/create-category.dto.ts`
- Create: `src/categories/dto/update-category.dto.ts`
- Create: `src/categories/dto/category-response.dto.ts`
- Modify: `src/app.module.ts`
- Test: `tests/categories-management.spec.ts`

**Interfaces:**
- Consumes: `Category` (`storeId`, `parentCategoryId`, `categoryName`, `status`)
- Produces:
  - `GET /api/v1/stores/:storeId/categories`
  - `POST /api/v1/stores/:storeId/categories`
  - `GET /api/v1/categories/:id`
  - `PATCH /api/v1/categories/:id`
  - `DELETE /api/v1/categories/:id` (soft-delete to `INACTIVE`)

- [x] **Step 1: Write integration test**
  In `tests/categories-management.spec.ts`, test tree retrieval, composite tenant isolation, cycle detection (rejecting A -> B -> A parent loops), and soft-delete when products exist.
- [x] **Step 2: Implement Category Stack**
  Implement recursive cycle check in `CategoriesService`. Enforce `[storeId, categoryId]` composite check. Register in `AppModule`.
- [x] **Step 3: Run test to verify passes**
  Run: `npx tsx tests/categories-management.spec.ts`
  Expected: PASS (7/7 PASS).
- [x] **Step 4: Commit**
  ```bash
  git add src/categories/ src/app.module.ts tests/categories-management.spec.ts
  git commit -m "feat(categories): implement hierarchical category CRUD with cycle detection and soft-delete"
  ```

### Task 2.3: Product Discount CRUD Module with DB Check Constraints
**Files:**
- Create: `prisma/migrations/20261025110000_product_discount_constraints/migration.sql`
- Create: `src/product-discounts/product-discounts.module.ts`
- Create: `src/product-discounts/product-discounts.controller.ts`
- Create: `src/product-discounts/product-discounts.service.ts`
- Create: `src/product-discounts/product-discounts.repository.ts`
- Create: `src/product-discounts/dto/create-product-discount.dto.ts`
- Create: `src/product-discounts/dto/update-product-discount.dto.ts`
- Create: `src/product-discounts/dto/product-discount-response.dto.ts`
- Modify: `src/app.module.ts`
- Test: `tests/product-discounts-crud.spec.ts`

**Interfaces:**
- Consumes: `ProductDiscount`
- Produces:
  - `GET /api/v1/products/:productId/discounts`
  - `POST /api/v1/products/:productId/discounts`
  - `GET /api/v1/product-discounts/:id`
  - `PATCH /api/v1/product-discounts/:id`
  - `DELETE /api/v1/product-discounts/:id`

- [x] **Step 1: Migration for check constraints**
  Add PostgreSQL check constraints for `start_at < end_at` and mutual exclusivity. Run migration.
- [x] **Step 2: Write integration & overlap test**
  Test percent vs amount mutual exclusivity, time range validity, resulting price non-negative, and transactional rejection of overlapping active intervals.
- [x] **Step 3: Implement Product Discount Stack**
  Implement service validation, repository overlap query with row lock, and register in `AppModule`.
- [x] **Step 4: Run test to verify passes**
  Run: `npx tsx tests/product-discounts-crud.spec.ts`
  Expected: PASS (7/7 PASS).
- [x] **Step 5: Commit**
  ```bash
  git add prisma/migrations/ src/product-discounts/ src/app.module.ts tests/product-discounts-crud.spec.ts
  git commit -m "feat(product-discounts): implement product discount CRUD with DB constraints and overlap defense"
  ```

### Task 2.4: Order List Filters, Timeline Endpoint & Delivery Queue Route Ordering
**Files:**
- Modify: `src/orders/orders.controller.ts`
- Modify: `src/orders/orders.service.ts`
- Modify: `src/orders/orders.repository.ts`
- Create: `src/orders/dto/order-timeline-response.dto.ts`
- Create: `src/orders/dto/order-filter-query.dto.ts`
- Test: `tests/order-filter-and-timeline.spec.ts`

**Interfaces:**
- Consumes: `OrderStatusHistory`, `PaymentTransaction`, `Order`
- Produces:
  - `GET /api/v1/orders/delivery-queue` (CRITICAL: registered BEFORE `:id`)
  - `GET /api/v1/orders` (multi-filter + canonical pagination)
  - `GET /api/v1/orders/:id/timeline`

- [x] **Step 1: Write integration test**
  Test that `GET /orders/delivery-queue` is not swallowed by `GET /orders/:id`, test multi-filter querying (status, paymentStatus, fromDate, toDate, driverId), and test timeline response shape.
- [x] **Step 2: Implement static route order and handlers**
  Place `@Get('delivery-queue')` before `@Get(':id')`. Implement timeline mapping in `OrdersService`. Add parameterized filter query in `OrdersRepository`.
- [x] **Step 3: Run test to verify passes**
  Run: `npx tsx tests/order-filter-and-timeline.spec.ts`
  Expected: PASS (5/5 PASS).
- [x] **Step 4: Commit**
  ```bash
  git add src/orders/ tests/order-filter-and-timeline.spec.ts
  git commit -m "feat(orders): expand order filter query, add timeline endpoint and delivery-queue route"
  ```

---

## Phase 3: Store Operations (Sprint 2)

### Task 3.1: Store Self-Management (`/api/v1/stores/me`) Using Exact ERD Schema Fields
**Files:**
- Modify: `src/stores/stores.controller.ts`
- Modify: `src/stores/stores.service.ts`
- Modify: `src/stores/stores.repository.ts`
- Create: `src/stores/dto/store-me-response.dto.ts`
- Create: `src/stores/dto/update-store-me.dto.ts`
- Test: `tests/store-self-management.spec.ts`

**Interfaces:**
- Consumes: `req.user.storeId`
- Produces:
  - `GET /api/v1/stores/me`: returns `name`, `code`, `email`, `phone`, `address`, `status`, `commissionRate`, product count, active subscription summary, bank account verification status, and wallet summary.
  - `PATCH /api/v1/stores/me`: updates ONLY allowed ERD fields (`name`, `email`, `phone`, `address`). Rejects unmapped fields (no banner/opening hours).

- [ ] **Step 1: Write integration test**
  Test `GET /stores/me` aggregation and `PATCH /stores/me` field restriction.
- [ ] **Step 2: Implement Store Me Service and Repository methods**
  Consolidate store metadata and guard against updating immutable fields.
- [ ] **Step 3: Run test to verify passes**
  Run: `npx tsx tests/store-self-management.spec.ts`
  Expected: PASS.
- [ ] **Step 4: Commit**
  ```bash
  git add src/stores/ tests/store-self-management.spec.ts
  git commit -m "feat(stores): implement store self-management GET and PATCH /stores/me matching ERD schema"
  ```

### Task 3.2: Store Staff Management API with Anti-Role-Escalation Whitelist
**Files:**
- Create: `src/store-staff/store-staff.module.ts`
- Create: `src/store-staff/store-staff.controller.ts`
- Create: `src/store-staff/store-staff.service.ts`
- Create: `src/store-staff/store-staff.repository.ts`
- Create: `src/store-staff/dto/create-store-staff.dto.ts`
- Create: `src/store-staff/dto/update-store-staff.dto.ts`
- Create: `src/store-staff/dto/store-staff-response.dto.ts`
- Modify: `src/app.module.ts`
- Test: `tests/store-staff-management.spec.ts`

**Interfaces:**
- Consumes: `StoreStaff` (`storeId`, `userId`, `roleId`, `status`)
- Produces:
  - `GET /api/v1/stores/:storeId/staff`
  - `POST /api/v1/stores/:storeId/staff`
  - `GET /api/v1/store-staff/:id`
  - `PATCH /api/v1/store-staff/:id`
  - `DELETE /api/v1/store-staff/:id`
  - `GET /api/v1/store-staff-roles`

- [ ] **Step 1: Write integration & anti-escalation test**
  Verify Store Owner can assign `STORE_MANAGER`, `STAFF_ORDER`, `STAFF_INVENTORY`, `STAFF_DELIVERY`, `STAFF_BUTTON`, but assignment of `SYSTEM_ADMIN` or `SUPER_ADMIN` is rejected with HTTP 403 Forbidden.
- [ ] **Step 2: Implement Store Staff Stack**
  Enforce role whitelist, composite unique pair `[storeId, userId]`, and register in `AppModule`.
- [ ] **Step 3: Run test to verify passes**
  Run: `npx tsx tests/store-staff-management.spec.ts`
  Expected: PASS.
- [ ] **Step 4: Commit**
  ```bash
  git add src/store-staff/ src/app.module.ts tests/store-staff-management.spec.ts
  git commit -m "feat(store-staff): implement store staff management with anti-role-escalation guard"
  ```

### Task 3.3: Expand Existing Store Subscriptions Module with Public Catalog & History
**Files:**
- Modify: `src/store-subscriptions/store-subscriptions.controller.ts`
- Modify: `src/store-subscriptions/store-subscriptions.service.ts`
- Modify: `src/store-subscriptions/store-subscriptions.repository.ts`
- Create: `src/store-subscriptions/dto/subscription-plan-response.dto.ts`
- Test: `tests/subscription-catalog-history.spec.ts`

**Interfaces:**
- Consumes: Existing `StoreSubscriptionsModule` in `src/store-subscriptions`
- Produces:
  - `GET /api/v1/subscription-plans` (Public/Store active catalog)
  - `GET /api/v1/store/subscriptions` (Store subscription history)
  - `GET /api/v1/store/subscriptions/:id` (Subscription detail)

- [ ] **Step 1: Write integration test**
  Test public catalog retrieval, store subscription history with canonical pagination, and detail lookup.
- [ ] **Step 2: Implement controller & service methods**
  Expand existing `StoreSubscriptionsModule` without creating duplicate bounded context.
- [ ] **Step 3: Run test to verify passes**
  Run: `npx tsx tests/subscription-catalog-history.spec.ts`
  Expected: PASS.
- [ ] **Step 4: Commit**
  ```bash
  git add src/store-subscriptions/ tests/subscription-catalog-history.spec.ts
  git commit -m "feat(store-subscriptions): expand module with public plan catalog and store subscription history"
  ```

### Task 3.4: Dedicated Bank Verification Polling Controller (`/api/v1/bank-account-verifications`)
**Files:**
- Create: `src/bank-verification/bank-verification-polling.controller.ts`
- Modify: `src/bank-verification/bank-verification.module.ts`
- Modify: `src/bank-verification/bank-verification.service.ts`
- Create: `src/bank-verification/dto/verification-polling-response.dto.ts`
- Test: `tests/bank-verification-polling.spec.ts`

**Interfaces:**
- Consumes: `BankVerificationTransaction`
- Produces:
  - `GET /api/v1/bank-account-verifications/:id`
  - `GET /api/v1/stores/:storeId/bank-account-verifications`

- [ ] **Step 1: Write integration test**
  Verify polling route prefix matches contract, returns masked account number and status, and leaks zero secrets or provider payloads.
- [ ] **Step 2: Implement dedicated polling controller**
  Register in `BankVerificationModule`. Enforce store owner authorization.
- [ ] **Step 3: Run test to verify passes**
  Run: `npx tsx tests/bank-verification-polling.spec.ts`
  Expected: PASS.
- [ ] **Step 4: Commit**
  ```bash
  git add src/bank-verification/ tests/bank-verification-polling.spec.ts
  git commit -m "feat(bank-verification): add dedicated polling controller matching REST route contract"
  ```

---

## Phase 4: Marketplace Ecosystem & Observability (Sprint 3)

### Task 4.1: Button Rental Payment Linking & Lifecycle Expansion
**Files:**
- Create: `prisma/migrations/20261025120000_enable_rental_payment_transactions/migration.sql`
- Modify: `prisma/schema.prisma`
- Modify: `src/rentals/rentals.controller.ts`
- Modify: `src/rentals/rentals.service.ts`
- Modify: `src/rentals/rentals.repository.ts`
- Modify: `src/payments/payments.service.ts`
- Test: `tests/rentals-lifecycle-e2e.spec.ts`

**Interfaces:**
- Consumes: Existing `RentalsModule` in `src/rentals`
- Produces:
  - `GET /api/v1/rentals/:id`
  - `POST /api/v1/rentals/:id/payment-requests` (PayOS payment link for rental)
  - `POST /api/v1/rentals/:id/extensions`
  - `POST /api/v1/rentals/:id/return-requests`
  - `GET /api/v1/admin/rentals`
  - `PATCH /api/v1/admin/rentals/:id/status`

- [ ] **Step 1: Execute Migration for ADR-1**
  Make `orderId` nullable and add `rentalId` to `PaymentTransaction`. Run migration and `prisma generate`.
- [ ] **Step 2: Write E2E integration test**
  Test creating rental order, generating PayOS payment link, simulating payment webhook triggering `PENDING_PAYMENT -> PAID -> ACTIVE`, and rental extension.
- [ ] **Step 3: Implement Rental Payment & Lifecycle in existing module**
  Expand `RentalsService` and `PaymentsService` to support rental payment verification.
- [ ] **Step 4: Run test to verify passes**
  Run: `npx tsx tests/rentals-lifecycle-e2e.spec.ts`
  Expected: PASS.
- [ ] **Step 5: Commit**
  ```bash
  git add prisma/ src/rentals/ src/payments/ tests/rentals-lifecycle-e2e.spec.ts
  git commit -m "feat(rentals): expand existing rentals module with PayOS payment integration and lifecycle management"
  ```

### Task 4.2: Price History & Inventory Read Views in Products Module
**Files:**
- Modify: `src/products/products.controller.ts`
- Modify: `src/products/products.service.ts`
- Modify: `src/products/products.repository.ts`
- Test: `tests/price-history-and-inventory.spec.ts`

**Interfaces:**
- Consumes: `ProductPriceHistory`, `Inventory`
- Produces:
  - `GET /api/v1/products/:id/price-history`
  - `GET /api/v1/stores/:storeId/inventory`
  - `GET /api/v1/stores/:storeId/inventory/low-stock`

- [ ] **Step 1: Write integration test**
  Verify price history records created upon price patch, inventory stock view, and low-stock filter (`quantityOnHand <= minStockAlert`).
- [ ] **Step 2: Implement Read Endpoints in Products Module**
  Avoid creating disconnected inventory controller; integrate cleanly in `ProductsModule`.
- [ ] **Step 3: Run test to verify passes**
  Run: `npx tsx tests/price-history-and-inventory.spec.ts`
  Expected: PASS.
- [ ] **Step 4: Commit**
  ```bash
  git add src/products/ tests/price-history-and-inventory.spec.ts
  git commit -m "feat(products): add price history and inventory low-stock alert views"
  ```

### Task 4.3: Store Wallet & Withdrawal Pagination, Filter & Detail Views
**Files:**
- Modify: `src/store-wallet/store-wallet.controller.ts`
- Modify: `src/store-wallet/store-wallet.service.ts`
- Modify: `src/admin/admin.controller.ts`
- Test: `tests/wallet-pagination-detail.spec.ts`

**Interfaces:**
- Consumes: `StoreWallet`, `WalletTransaction`, `StoreWithdrawal`
- Produces:
  - `GET /api/v1/store/wallet/transactions?page=1&pageSize=20&type=&fromDate=&toDate=`
  - `GET /api/v1/store/wallet/withdrawals?page=1&pageSize=20&status=&fromDate=&toDate=`
  - `GET /api/v1/store/wallet/withdrawals/:id`
  - `GET /api/v1/admin/withdrawals/:id`

- [ ] **Step 1: Write integration test**
  Verify canonical pagination envelope, date filtering, transaction type filtering, and detail endpoint DTO masking (zero plaintext bank account).
- [ ] **Step 2: Implement Pagination & Detail Query**
  Enforce `WalletMapper` across all wallet/withdrawal list and detail responses.
- [ ] **Step 3: Run test to verify passes**
  Run: `npx tsx tests/wallet-pagination-detail.spec.ts`
  Expected: PASS.
- [ ] **Step 4: Commit**
  ```bash
  git add src/store-wallet/ src/admin/ tests/wallet-pagination-detail.spec.ts
  git commit -m "feat(store-wallet): expand wallet transactions and withdrawals with canonical pagination and detail views"
  ```

### Task 4.4a: Driver Shifts Monitoring Module
**Files:**
- Modify: `src/driver-shifts/driver-shifts.controller.ts`
- Modify: `src/driver-shifts/driver-shifts.service.ts`
- Test: `tests/driver-shifts-monitoring.spec.ts`

**Interfaces:**
- Produces:
  - `GET /api/v1/driver-shifts/:id`
  - `GET /api/v1/stores/:storeId/driver-shifts`
  - `GET /api/v1/drivers/me/delivery-summary`

- [ ] **Step 1: Write integration test**
  Test store-level shift viewing and driver personal delivery summary.
- [ ] **Step 2: Implement methods in DriverShiftsModule**
- [ ] **Step 3: Run test to verify passes**
  Run: `npx tsx tests/driver-shifts-monitoring.spec.ts`
  Expected: PASS.
- [ ] **Step 4: Commit**
  ```bash
  git add src/driver-shifts/ tests/driver-shifts-monitoring.spec.ts
  git commit -m "feat(driver-shifts): add store shift monitoring and driver delivery summary endpoints"
  ```

### Task 4.4b: Store-Customer Relationship Module
**Files:**
- Create: `src/store-customers/store-customers.module.ts`
- Create: `src/store-customers/store-customers.controller.ts`
- Create: `src/store-customers/store-customers.service.ts`
- Create: `src/store-customers/store-customers.repository.ts`
- Modify: `src/app.module.ts`
- Test: `tests/store-customers-management.spec.ts`

**Interfaces:**
- Produces:
  - `GET /api/v1/stores/:storeId/customers`
  - `GET /api/v1/stores/:storeId/customers/:customerId`
  - `PATCH /api/v1/stores/:storeId/customers/:customerId/status`
  - `GET /api/v1/customers/me/stores`

- [ ] **Step 1: Write integration test**
  Test customer listing per store, status toggle (`ACTIVE` / `BLOCKED`), and customer viewing stores they've transacted with.
- [ ] **Step 2: Implement StoreCustomersModule**
  Register in `AppModule`.
- [ ] **Step 3: Run test to verify passes**
  Run: `npx tsx tests/store-customers-management.spec.ts`
  Expected: PASS.
- [ ] **Step 4: Commit**
  ```bash
  git add src/store-customers/ src/app.module.ts tests/store-customers-management.spec.ts
  git commit -m "feat(store-customers): implement store-customer relationship and customer store history"
  ```

### Task 4.4c: Analytics Date Range & Grouping Filters
**Files:**
- Modify: `src/analytics/analytics.controller.ts`
- Modify: `src/analytics/analytics.service.ts`
- Test: `tests/analytics-window-filters.spec.ts`

**Interfaces:**
- Produces: `GET /api/v1/analytics/dashboard?fromDate=&toDate=&groupBy=day`

- [ ] **Step 1: Write integration test**
  Test date range filtering, tenant storeId isolation (Store Owner locked to own store), and daily/weekly aggregation.
- [ ] **Step 2: Implement query filters in AnalyticsService**
- [ ] **Step 3: Run test to verify passes**
  Run: `npx tsx tests/analytics-window-filters.spec.ts`
  Expected: PASS.
- [ ] **Step 4: Commit**
  ```bash
  git add src/analytics/ tests/analytics-window-filters.spec.ts
  git commit -m "feat(analytics): add date range and grouping filters with strict tenant isolation"
  ```

---

## Phase 5: Release Gate & Production Handover

### Task 5.1: Master Test Suite Integration & Production Release Handover
**Files:**
- Modify: `tests/run_all_suites.ts`
- Modify: `SESSION_HANDOFF.md`
- Test: All suites

- [ ] **Step 1: Register all new suites in `tests/run_all_suites.ts`**
  Register each verified suite with proper ordering and clean teardown.
- [ ] **Step 2: Run Full Verification Suite**
  Run: `npx tsc --noEmit` -> PASS (0 errors).
  Run: `npm run build` -> PASS (clean build).
  Run: `npm run test:all` -> PASS (100% of all suites).
- [ ] **Step 3: Update `SESSION_HANDOFF.md`**
  Update handoff with verified metrics, files changed, and commands run.
- [ ] **Step 4: Final Git Push**
  Push cleanly to `origin/main`.
