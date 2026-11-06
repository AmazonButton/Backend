# API Pagination & Latency Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate sluggish list responses across the platform by enforcing bounded database pagination on all GET list endpoints, preventing unbounded Prisma queries, and optimizing frontend notification and page-level fetching.

**Architecture:** Apply Rule 11 of `NODEJS_BACKEND_SECURITY_RULES.md` (default `page=1&pageSize=20`, max 100) across backend controllers, services, and repositories. Replace unbounded Prisma queries with parameterized `skip`/`take` limits and trimmed column selections. Add client-side request caching and query parameters to the frontend Notification Bell and Store pages.

**Tech Stack:** NestJS, TypeScript, Prisma ORM, PostgreSQL (Supabase Tokyo), React, Axios.

**Spec:** `NODEJS_BACKEND_SECURITY_RULES.md` & `BACKEND_API_DEVELOPMENT_RULES.md`

## Global Constraints
- Every pagination query MUST default to `page=1, pageSize=20` and cap `pageSize` at 100.
- All API responses must follow the uniform envelope `{ success: true, message?: string, data: [...], pagination?: {...} }`.
- Backward compatibility: Existing frontend components that expect `res.data.data` as an array must continue to function without breaking.
- Zero plaintext secrets in logs or code.

---

### Task 1: Fix Products Pagination Defaults & Unbounded Queries
**Files:**
- Modify: `src/products/dto/query-product.dto.ts`
- Modify: `src/products/products.repository.ts:17-45`
- Modify: `src/products/products.controller.ts:47-67`

- [ ] **Step 1:** In `src/products/dto/query-product.dto.ts`, add default values: `page?: number = 1;` and `pageSize?: number = 20;`.
- [ ] **Step 2:** In `src/products/products.repository.ts`, ensure `findMany` enforces `page = Math.max(1, Number(pagination?.page) || 1)` and `pageSize = Math.min(100, Math.max(1, Number(pagination?.pageSize) || 20))`, passing explicit `skip` and `take` to Prisma.
- [ ] **Step 3:** In `src/products/products.controller.ts`, ensure `pagination` is passed with `{ page, pageSize }` and returns `{ success: true, data: res.data, pagination: res.pagination }`.

---

### Task 2: Implement Pagination & Caps for Devices Fleet Endpoints
**Files:**
- Modify: `src/devices/devices.repository.ts:1-45`
- Modify: `src/devices/devices.service.ts:30-45`
- Modify: `src/devices/devices.controller.ts:55-65`

- [ ] **Step 1:** In `src/devices/devices.repository.ts`, update `findMany` to accept optional `pagination?: { page?: number; pageSize?: number }` with defaults `page = 1, pageSize = 20` (max 100). Return `{ items, total, page, pageSize }`. Cap `getUnassigned` at `take: 50`.
- [ ] **Step 2:** In `src/devices/devices.service.ts`, update `list(user, query)` to extract `page` and `pageSize`, calling `findMany` with pagination.
- [ ] **Step 3:** In `src/devices/devices.controller.ts`, return `{ success: true, data: result.items, pagination: result.pagination }`. Ensure `data` remains an array for frontend compatibility.

---

### Task 3: Cap Admin Unbounded List Endpoints
**Files:**
- Modify: `src/admin/admin.repository.ts:25-40, 140-160, 255-275`

- [ ] **Step 1:** In `src/admin/admin.repository.ts`, add safe `take: 100` and `skip: 0` to `findUsers()` to prevent memory exhaustion.
- [ ] **Step 2:** In `findAllStores()`, add `take: 50` and `skip: 0` ordered by `name asc`.
- [ ] **Step 3:** In `findWithdrawals()`, add `take: 50` and `skip: 0` ordered by `requestedAt desc`.

---

### Task 4: Optimize Prisma Query Payload on Orders (`orders.repository.ts`)
**Files:**
- Modify: `src/orders/orders.repository.ts:320-350`

- [ ] **Step 1:** In `findPaginatedOrders`, replace full entity includes with selected fields:
  - `customer: { select: { customerId: true, fullName: true, phone: true, email: true, user: { select: { userId: true, fullName: true, phone: true } } } }`
  - `store: { select: { storeId: true, name: true, phone: true, code: true, address: true } }`
- [ ] **Step 2:** Verify that `toOrderResponseDto` receives all required properties without missing fields.

---

### Task 5: Frontend Notification Bell & Store Pages Optimization
**Files:**
- Modify: `../Frontend/src/components/common/NotificationBellPopover.tsx`
- Modify: `../Frontend/src/pages/store/StoreProductsPage.tsx`
- Modify: `../Frontend/src/pages/store/StoreDevicesPage.tsx`

- [ ] **Step 1:** In `NotificationBellPopover.tsx`, pass `{ params: { pageSize: 15, page: 1 } }` for `api.get('/orders')`, `api.get('/devices')`, `api.get('/admin/stores/pending')`, and `api.get('/admin/withdrawals')`.
- [ ] **Step 2:** Add a 60-second debounce / in-memory cache timer so switching tabs does not re-fetch all 4 endpoints on every render.
- [ ] **Step 3:** In `StoreProductsPage.tsx` and `StoreDevicesPage.tsx`, pass `{ params: { pageSize: 50, page: 1 } }` on initial fetch.

---

### Task 6: Build & Verification
- [ ] **Step 1:** Run `npm run build` in `backend` to guarantee zero compilation errors.
- [ ] **Step 2:** Run existing test suites `npm test` or targeted specs to ensure zero regressions.
- [ ] **Step 3:** Benchmark endpoint response times using `curl.exe` before and after.
- [ ] **Step 4:** Update `SESSION_HANDOFF.md` per `docs/AGENT_CONTEXT_POLICY.md`.

