# Goong 5 km Free Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the Backend Handoff specification for Free Delivery within 5 km (5,000 meters) using Goong Distance Matrix V2 (`vehicle=motorcycle`), including store coordinates, order delivery snapshot fields, `POST /api/v1/orders/delivery-quote`, `POST /api/v1/orders/quick-reorder` with mandatory `addressId`, physical IoT button eligibility check with residue cleanup and customer notification on failure, and full unit/integration/contract test coverage.

**Architecture:** 6-Layer NestJS + Prisma + PostgreSQL architecture (`Router/Controller -> Middleware/Guards -> Service -> Repository -> PostgreSQL`). Both mobile (`delivery-quote` & `quick-reorder`) and physical IoT button events (`handleButtonEvent` / `IotService.handleEvent`) delegate distance & coordinate validation to a single shared `DeliveryEligibilityService`.

**Tech Stack:** TypeScript, NestJS, Prisma ORM, PostgreSQL (Neon + Supabase), Goong REST API V2 (`/v2/distancematrix`), DashboardCacheService (Redis + memory fallback).

---

### Task 1: Database Schema & Multi-Cloud Migration (Store Coordinates & Order Delivery Snapshot)

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20261116160000_add_store_coords_and_order_delivery_distance/migration.sql`
- Create: `scripts/deploy_supabase_goong_5km.js`

- [x] **Step 1: Update `prisma/schema.prisma`**
  - Add `latitude Decimal? @map("latitude") @db.Decimal(10, 7)` and `longitude Decimal? @map("longitude") @db.Decimal(10, 7)` to model `Store`.
  - Add `deliveryAddressId BigInt? @map("delivery_address_id")`, `deliveryDistanceMeters Int? @map("delivery_distance_meters")`, and `deliveryDistanceSource String? @map("delivery_distance_source") @db.VarChar(50)` to model `Order`.
- [x] **Step 2: Create migration SQL and apply to Neon & Supabase**
  - Add nullable columns to `"store"` and `"orders"`.
  - Seed default coordinates (`10.7768890`, `106.7008060` - Ho Chi Minh City center) for existing active stores where `latitude IS NULL` or `longitude IS NULL` so active stores are ready for production testing.
  - Run `npx prisma migrate deploy` and `npx prisma generate` on Neon, and run `node scripts/deploy_supabase_goong_5km.js` on Supabase.

---

### Task 2: Preserve Error `data` Envelope in `AllExceptionsFilter` & Update Store DTOs

**Files:**
- Modify: `src/common/filters/http-exception.filter.ts`
- Modify: `src/stores/dto/update-store-me.dto.ts`
- Modify: `src/stores/dto/store-me-response.dto.ts`
- Modify: `src/stores/stores.repository.ts`
- Modify: `src/stores/stores.service.ts`
- Modify: `src/admin/dto/update-admin-store.dto.ts`
- Modify: `src/admin/admin.repository.ts`
- Modify: `src/orders/dto/order-response.dto.ts`

- [x] **Step 1: Update `AllExceptionsFilter`**
  - Preserve `resObj.data` in the JSON error response when thrown by `HttpException` (required for `409 ADDRESS_OUTSIDE_DELIVERY_AREA` returning `data: { distanceMeters, maxDistanceMeters }`).
  - Strip any `api_key=[^&\s]+` pattern from error messages as defense-in-depth against secret leakage.
- [x] **Step 2: Expose & allow updating `latitude` and `longitude` on Store**
  - Allow `latitude` and `longitude` in `UpdateStoreMeDto` and `UpdateAdminStoreDto`.
  - Return `latitude` and `longitude` in `StoreMeResponseDto` and active stores list.
  - Map `deliveryAddressId`, `deliveryDistanceMeters`, and `deliveryDistanceSource` in `OrderResponseDto`.

---

### Task 3: Write Failing Tests (TDD RED Phase)

**Files:**
- Create: `tests/goong-5km-delivery.spec.ts`

- [x] **Step 1: Write comprehensive test suite covering all specification requirements**
  - **Unit Tests**:
    - `distance.value = 5000` -> `eligible = true`, `shippingFee = 0`, `reasonCode = null`.
    - `distance.value = 5001` -> `eligible = false`, `reasonCode = 'ADDRESS_OUTSIDE_DELIVERY_AREA'` on quote; `409 ADDRESS_OUTSIDE_DELIVERY_AREA` with `data: { distanceMeters: 5001, maxDistanceMeters: 5000 }` on create.
    - Negative, float, NaN, or missing `distance.value` -> `503 DELIVERY_DISTANCE_UNAVAILABLE`.
    - Goong timeout / HTTP 500 / malformed JSON -> `503 DELIVERY_DISTANCE_UNAVAILABLE`.
    - Goong `ZERO_RESULTS` or `NOT_FOUND` -> `422 DELIVERY_ROUTE_NOT_FOUND`.
    - Missing `addressId` on mobile -> `400 DELIVERY_ADDRESS_REQUIRED`.
    - Missing store coordinates -> `400 STORE_COORDINATES_MISSING`.
    - Missing address coordinates -> `400 ADDRESS_COORDINATES_MISSING`.
  - **Service / Integration Tests**:
    - `POST /orders/delivery-quote` with address belonging to another customer -> `403 DELIVERY_ADDRESS_ACCESS_DENIED` (BOLA).
    - `POST /orders/delivery-quote` with button belonging to another customer -> `403`.
    - `POST /orders/delivery-quote` <= 5 km -> HTTP 200 `{ eligible: true, distanceMeters, maxDistanceMeters: 5000, shippingFee: 0, reasonCode: null }`.
    - `POST /orders/delivery-quote` > 5 km -> HTTP 200 `{ eligible: false, distanceMeters, maxDistanceMeters: 5000, shippingFee: 0, reasonCode: 'ADDRESS_OUTSIDE_DELIVERY_AREA' }`.
    - `POST /orders/quick-reorder` without `addressId` -> `400 DELIVERY_ADDRESS_REQUIRED`.
    - `POST /orders/quick-reorder` <= 5 km -> creates order with `shippingFee = 0` and persists snapshot (`deliveryAddressId`, `shippingLatitude`, `shippingLongitude`, `deliveryDistanceMeters`, `deliveryDistanceSource = 'GOONG_DISTANCE_MATRIX_V2'`).
    - `POST /orders/quick-reorder` > 5 km -> `409 ADDRESS_OUTSIDE_DELIVERY_AREA`, creates no order, does not deduct stock.
    - Address coordinates changed from <= 5 km (at quote time) to > 5 km (before `quick-reorder`) -> cache invalidated by coordinate change, `quick-reorder` rejects with `409 ADDRESS_OUTSIDE_DELIVERY_AREA`.
    - Physical IoT button press (`IotService.handleEvent`) with default address <= 5 km -> creates order with `shippingFee = 0` and snapshot.
    - Physical IoT button press (`IotService.handleEvent`) with default address > 5 km -> rejected with `409 ADDRESS_OUTSIDE_DELIVERY_AREA`, cleans up `iot_idempotency_keys` (no residue), deducts no stock, and creates a customer `Notification` guiding them to update their default address.
    - Concurrent `quick-reorder` requests -> does not create duplicate orders beyond idempotency/stock rules.
  - **Contract & Security Tests**:
    - Client-supplied `shippingFee`, `distanceMeters`, `storeLatitude`, `addressLatitude` are ignored (Zero Client Trust).
    - Error responses and logs never contain `GOONG_API_KEY` or `api_key=`.

---

### Task 4: Implement `DeliveryEligibilityService` & Goong Client + Order/IoT Integration (TDD GREEN Phase)

**Files:**
- Create: `src/orders/delivery-eligibility.service.ts`
- Create: `src/orders/dto/delivery-quote.dto.ts`
- Create: `src/orders/dto/quick-reorder.dto.ts`
- Modify: `src/orders/orders.controller.ts`
- Modify: `src/orders/orders.service.ts`
- Modify: `src/orders/orders.repository.ts`
- Modify: `src/orders/orders.module.ts`
- Modify: `src/iot/iot.service.ts`

- [x] **Step 1: Implement `DeliveryEligibilityService`**
  - Export `MAX_FREE_DELIVERY_DISTANCE_METERS = 5_000` and `DELIVERY_DISTANCE_SOURCE = 'GOONG_DISTANCE_MATRIX_V2'`.
  - Implement Goong Distance Matrix V2 HTTP client (`GET https://rsapi.goong.io/v2/distancematrix?origins=...&destinations=...&vehicle=motorcycle&api_key=...`) with `AbortController` timeout (6,000 ms), strict validation of `rows[0].elements[0].status` and `Number.isInteger(distance.value) && distance.value >= 0`, and coordinate-versioned cache (`15 minutes` TTL).
  - Implement `evaluateQuote(...)`, `verifyAndResolveForOrder(...)`, and `verifyForPhysicalButton(...)`.
- [x] **Step 2: Wire `POST /api/v1/orders/delivery-quote` and `POST /api/v1/orders/quick-reorder`**
  - Add rate-limited `POST /api/v1/orders/delivery-quote` endpoint and update `POST /api/v1/orders/quick-reorder` in `OrdersController`.
  - Update `OrdersService.quickReorder`, `OrdersService.handleButtonEvent`, and `OrdersRepository.createOrderWithItems` to persist `deliveryAddressId`, `shippingLatitude`, `shippingLongitude`, `deliveryDistanceMeters`, `deliveryDistanceSource`, and `shippingFee = 0`.
  - Update `IotService.handleEvent` & `OrdersService.handleButtonEvent` so physical button press failures due to delivery eligibility send a customer notification and leave no idempotency residue.

---

### Task 5: Full Verification & Handoff Update

**Files:**
- Modify: `SESSION_HANDOFF.md`

- [x] **Step 1: Run `npx tsx tests/goong-5km-delivery.spec.ts` and verify 100% PASS**
- [x] **Step 2: Run regression suites and `npm run build`**
- [x] **Step 3: Update `SESSION_HANDOFF.md` following `docs/AGENT_CONTEXT_POLICY.md`**
