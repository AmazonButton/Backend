# Delivery Driver Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a production-ready Delivery Driver (Shipper) backend module fulfilling all 11 PRD requirements, including role management, atomic order claim with race-condition prevention, delivery completion with POD/COD validation, delivery failure with evidence, 1.5MB POD upload, WebSocket event contracts, driver duty, shift & cash reconciliation, driver VietQR permission, Google Maps coordinates, and driver order history filters.

**Architecture:** Extend existing NestJS backend architecture using Prisma ORM with PostgreSQL atomic transactions (row locking via FOR UPDATE), modular NestJS modules (Orders, Media, Websocket, Payments, DriverDuty, DriverShifts), strict class-validator DTOs with forbidNonWhitelisted validation, and zero residue test verification.

**Tech Stack:** NestJS, TypeScript, Prisma ORM, PostgreSQL, Socket.io, Cloudinary, Class-Validator, TSX.

**Spec:** F:\Learning\SEM9-FPTu\update-required (summarized in detail by Tris)

## Global Constraints
- Preserve all existing 35 database tables and their relationships without breaking changes.
- STRICTLY DO NOT modify or update the Draw.io ERD diagram (BRD/ERD_Level_3_Editable.drawio) per user instruction.
- Zero remote git pushes (git push prohibited).
- Strict BOLA/IDOR tenant isolation by storeId and assignedDriverId.
- Zero test data residue in database after test runs.
- Max pagination limit 100 for driver query APIs.
- Max file size 1.5MB for POD uploads.

## Review Focus
- Concurrency race conditions: Two drivers claiming the same order at the exact same millisecond. One must succeed (200), the second must fail (409 Conflict).
- Payment integrity: Driver completing a COD delivery with mismatched collected amount or completing a VietQR delivery when PayOS has not confirmed payment.
- Ownership violation: Driver attempting to deliver, fail, or create VietQR link for an order belonging to another driver or store.
- Asset spoofing: Submitting a POD URL that does not belong to the order's store pod folder.
- Shift reconciliation: Inconsistent shift totals if calculated from client inputs rather than database-level queries.

---

### Task 1: Database Schema Expansion (Orders & Roles & Drivers)
**Files:**
- Modify: `prisma/schema.prisma`
- Modify: `prisma/seed.ts`
- Create: `scratch/apply_driver_schema_migration.ts`

- [ ] **Step 1: Update Prisma schema**
  - Add `STAFF_DELIVERY` to Role descriptions.
  - In `Order` model: add `assignedDriverId` (`assigned_driver_id` BigInt?), `podImageUrl` (`pod_image_url` String?), `deliveredAt` (`delivered_at` DateTime?), `failureReasonCode` (`failure_reason_code` String?), `failureNote` (`failure_note` String?), `evidenceImageUrl` (`evidence_image_url` String?), `shippingLatitude` (`shipping_latitude` Decimal(10, 7)?), `shippingLongitude` (`shipping_longitude` Decimal(10, 7)?).
  - In `CustomerAddress` model: add `latitude` (`latitude` Decimal(10, 7)?), `longitude` (`longitude` Decimal(10, 7)?).
  - Add `DriverDuty` and `DriverShift` models.
- [ ] **Step 2: Apply migration to PostgreSQL & Prisma client**
  - Run SQL alter commands safely and run `npx prisma generate`.
  - Upsert `STAFF_DELIVERY` into `roles` table.
- [ ] **Step 3: Verify schema parity and client generation**
  - Ensure `npx prisma validate` succeeds.

---

### Task 2: Role Authorization & Store Isolation for Driver
**Files:**
- Modify: `src/orders/orders.controller.ts`
- Modify: `src/orders/orders.service.ts`
- Modify: `src/auth/jwt.strategy.ts`

- [ ] **Step 1: Update controller & service guards**
  - Add `STAFF_DELIVERY` to `@Roles(...)` where drivers need read or claim access.
  - In `orders.service.ts -> list()`: allow `STAFF_DELIVERY` with store isolation.
  - In `orders.service.ts -> getById()`: allow assigned driver to view their order.
- [ ] **Step 2: Test driver access and store isolation**
  - Run automated test to verify 403 Forbidden for cross-store and 200 OK for same-store.

---

### Task 3: Atomic Order Claim Mechanism (Anti-Race Condition)
**Files:**
- Modify: `src/orders/orders.controller.ts`
- Modify: `src/orders/orders.service.ts`
- Modify: `src/orders/orders.repository.ts`

- [ ] **Step 1: Implement claimOrder in repository with atomic row lock / UPDATE WHERE**
  - `UPDATE orders SET order_status = 'SHIPPING', assigned_driver_id = $driverId WHERE order_id = $orderId AND store_id = $storeId AND order_status = 'READY_FOR_DELIVERY' AND assigned_driver_id IS NULL`.
  - Return 409 Conflict if already claimed or not in READY_FOR_DELIVERY.
- [ ] **Step 2: Add POST /api/v1/orders/:id/claim in controller**
- [ ] **Step 3: Test concurrent claims (simulate 2 drivers claiming at once: 1 200, 1 409)**

---

### Task 4: Delivery Completion with POD & Payment Validation
**Files:**
- Create: `src/orders/dto/deliver-order.dto.ts`
- Modify: `src/orders/orders.controller.ts`
- Modify: `src/orders/orders.service.ts`
- Modify: `src/orders/orders.repository.ts`

- [ ] **Step 1: Create DeliverOrderDto with validation rules**
- [ ] **Step 2: Implement completeDeliveryAtomicTx in repository**
  - Check driver assignment, order status SHIPPING.
  - Verify COD collectedAmount === totalAmount or PayOS paymentStatus === PAID.
  - Verify POD URL begins with `stores/{storeId}/pod/`.
  - Atomically update status to DELIVERED, record deliveredAt, podImageUrl, paymentStatus.
- [ ] **Step 3: Add POST /api/v1/orders/:id/deliver in controller**
- [ ] **Step 4: Test delivery completion with valid & invalid POD/amounts**

---

### Task 5: Delivery Failure with Business Reason Codes & Evidence
**Files:**
- Create: `src/orders/dto/delivery-failure.dto.ts`
- Modify: `src/orders/orders.controller.ts`
- Modify: `src/orders/orders.service.ts`
- Modify: `src/orders/orders.repository.ts`

- [ ] **Step 1: Create DeliveryFailureDto**
  - Allowed codes: CUSTOMER_UNREACHABLE, WRONG_ADDRESS, CUSTOMER_REJECTED, GOODS_DAMAGED_IN_TRANSIT.
  - Mandatory evidenceImageUrl.
- [ ] **Step 2: Implement failDeliveryAtomicTx in repository**
  - Check order is in SHIPPING, assigned to driver.
  - Update status to DELIVERY_FAILED, save reasonCode, note, evidenceImageUrl.
  - Emit failure event to store manager.
- [ ] **Step 3: Add POST /api/v1/orders/:id/fail in controller**
- [ ] **Step 4: Test delivery failure logic and validation**

---

### Task 6: Cloudinary POD Upload (1.5MB Limit & Path Ownership)
**Files:**
- Modify: `src/media/media.controller.ts`
- Modify: `src/media/media.service.ts`

- [ ] **Step 1: Add upload-pod endpoint in media.controller.ts**
  - Allowed roles: STAFF_DELIVERY, STORE_OWNER, STAFF_ORDER, ADMIN.
  - File size limit: 1.5MB (1.5 * 1024 * 1024).
  - Target folder forced to: `stores/{storeId}/pod`.
  - Magic bytes check.
- [ ] **Step 2: Test 1.5MB limit and folder isolation**

---

### Task 7: WebSocket Events Contract Realignment
**Files:**
- Modify: `src/websocket/events.gateway.ts`
- Modify: `src/orders/orders.service.ts`

- [ ] **Step 1: Support dual room names (store_{storeId} and store:{storeId}) & driver room (driver:{userId})**
- [ ] **Step 2: Emit ORDER_READY_FOR_DELIVERY with rich payload when order enters READY_FOR_DELIVERY**
- [ ] **Step 3: Emit ORDER_PAYMENT_CONFIRMED, ORDER_CLAIMED, ORDER_DELIVERY_FAILED**

---

### Task 8: Driver Duty Status (ONLINE / OFFLINE)
**Files:**
- Create: `src/drivers/drivers.module.ts`
- Create: `src/drivers/drivers.controller.ts`
- Create: `src/drivers/drivers.service.ts`
- Create: `src/drivers/dto/update-duty.dto.ts`
- Modify: `src/app.module.ts`

- [ ] **Step 1: Implement duty toggle PATCH /api/v1/drivers/me/duty**
- [ ] **Step 2: Implement GET /api/v1/drivers/me/duty**
- [ ] **Step 3: Test duty status persistence and online check**

---

### Task 9: Driver Shifts & Cash Reconciliation
**Files:**
- Create: `src/driver-shifts/driver-shifts.module.ts`
- Create: `src/driver-shifts/driver-shifts.controller.ts`
- Create: `src/driver-shifts/driver-shifts.service.ts`
- Create: `src/driver-shifts/dto/create-shift.dto.ts`
- Modify: `src/app.module.ts`

- [ ] **Step 1: Implement POST /api/v1/driver-shifts/start**
- [ ] **Step 2: Implement GET /api/v1/driver-shifts/current (live DB aggregation of COD/VietQR/delivered/failed)**
- [ ] **Step 3: Implement GET /api/v1/driver-shifts/history**
- [ ] **Step 4: Implement POST /api/v1/driver-shifts/:id/close**
- [ ] **Step 5: Implement POST /api/v1/driver-shifts/:id/confirm-handover (Cashier/Store Owner only)**
- [ ] **Step 6: Test shift lifecycle and real DB calculation**

---

### Task 10: Driver PayOS Link Creation & Address Coordinates
**Files:**
- Modify: `src/payments/payments.service.ts`
- Modify: `src/orders/dto/order-response.dto.ts`
- Modify: `src/orders/orders.repository.ts`

- [ ] **Step 1: Allow STAFF_DELIVERY to create PayOS link for assigned order in SHIPPING**
- [ ] **Step 2: Snapshot shippingLatitude & shippingLongitude when order is created**
- [ ] **Step 3: Include shippingLatitude & shippingLongitude in toOrderResponseDto**

---

### Task 11: Driver Order History Filters & Query DTO
**Files:**
- Create: `src/orders/dto/driver-orders-query.dto.ts`
- Modify: `src/orders/orders.controller.ts`
- Modify: `src/orders/orders.service.ts`
- Modify: `src/orders/orders.repository.ts`

- [ ] **Step 1: Implement GET /api/v1/orders/driver/my-orders with date filters, status, pagination (max 100)**
- [ ] **Step 2: Include POD thumbnails, failure details, and summary stats**

---

### Task 12: Comprehensive Integration Test Suite & Zero Residue Verification
**Files:**
- Create: `tests/verify_delivery_driver_module.ts`

- [ ] **Step 1: Write end-to-end tests covering all 11 requirements**
- [ ] **Step 2: Run tests with zero residue cleanup**
- [ ] **Step 3: Verify existing build and tests pass**
