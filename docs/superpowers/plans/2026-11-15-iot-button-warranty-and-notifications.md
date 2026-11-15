# IoT Button Warranty & Notifications Subsystem Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and integrate a production-ready Warranty Management & Real-time Notification subsystem for IoT Buttons across Backend and Frontend, establishing persistent database records (`warranty_tickets`), server-side financial deduction calculations (4 fault groups A/B/C/D), atomic device swaps, and multi-channel real-time notifications (DB + WebSocket + FCM Push).

**Architecture:** Layered 6-tier pattern (Router -> Middleware -> Controller -> Service -> Repository -> PostgreSQL Database). Frontend `WarrantyPanel` and `warranty.ts` transition from simulated `localStorage` to authenticated REST APIs with WebSocket telemetry integration.

**Tech Stack:** NestJS, TypeScript, Prisma ORM, PostgreSQL (Neon & Supabase), WebSocket (Socket.io / EventsGateway), React (Vite, TailwindCSS).

**Spec:** Frontend specification images and requirements from `F:\Learning\SEM9-FPTu\update-required` and conversation session on 2026-11-15.

## Global Constraints
- Zero Client Trust: All deductions, deposit math, and status transitions must be verified and calculated on the Backend.
- BOLA / IDOR Defense: Store owners/staff can only access warranty tickets matching `ticket.store_id === req.user.storeId`; Admin can view and manage all.
- Transactional Integrity: Device swaps (`approve-swap`) must execute inside atomic PostgreSQL transactions (`$transaction`) updating both `IoTButton` states and inserting audit records in `device_movements`.
- Uniform API Envelopes: All API responses must follow `{ success: boolean, message: string, data: any, pagination?: any }`.

## Review Focus
1. Client Tampering Defense: A malicious client submits manipulated `deductionAmount: 0` for Group C or D; Backend must recalculate server-side from `faultGroup` and enforce strict rules.
2. Concurrent Swap Race Condition: Two admin requests simultaneously attempt to swap the same button; row-level locking or optimistic check must prevent double-swap.
3. Multi-Cloud Migration Sync: New model `WarrantyTicket` must be applied cleanly to both Neon (local dev) and Supabase (Render production) databases.
4. Information Leakage Immunity: Exception filter must sanitize any Prisma errors or database paths from being returned to the client.
5. Realtime Routing Isolation: WebSocket events for store-specific device faults must only emit to authorized Store rooms and Admin rooms, never to other stores.

---

### Task 1: Database Schema & Migration for `warranty_tickets`

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20261115143000_add_warranty_tickets_table/migration.sql`
- Test: `scripts/verify_warranty_schema.js`

- [ ] Step 1.1: Add `WarrantyTicket` model to `prisma/schema.prisma` with relationships to `IoTButton` (`button`, `replacementButton`), `Store`, `CustomerProfile`, and `User` (`reportedByUser`).
- [ ] Step 1.2: Generate Prisma Client: `npx prisma generate`.
- [ ] Step 1.3: Generate migration SQL and deploy to Neon: `npx prisma migrate deploy`.
- [ ] Step 1.4: Deploy migration to live Supabase database via automated script.
- [ ] Step 1.5: Verify both Neon and Supabase contain table `warranty_tickets` with correct column types and foreign keys.

---

### Task 2: Backend Warranty Module Scaffolding & Business Logic

**Files:**
- Create: `src/warranty/dto/create-warranty-ticket.dto.ts`
- Create: `src/warranty/dto/query-warranty-ticket.dto.ts`
- Create: `src/warranty/dto/warranty-ticket-response.dto.ts`
- Create: `src/warranty/dto/approve-swap-ticket.dto.ts`
- Create: `src/warranty/dto/resolve-reject-ticket.dto.ts`
- Create: `src/warranty/warranty.repository.ts`
- Create: `src/warranty/warranty.service.ts`
- Create: `src/warranty/warranty.controller.ts`
- Create: `src/warranty/warranty.module.ts`
- Modify: `src/app.module.ts`

- [ ] Step 2.1: Implement DTOs with class-validator decorators for all warranty requests and responses.
- [ ] Step 2.2: Implement `WarrantyRepository` with parameterized Prisma queries, pagination, and transactional support.
- [ ] Step 2.3: Implement `WarrantyService` with:
  - Server-side calculation of `calculateDeduction(faultGroup, depositAmount, customPercent)`.
  - `createTicket`: generates ticket code `WRT-YYMMDD-XXXX`, links device, stores initial status `PENDING`.
  - `approveSwap`: validates replacement button availability, swaps device assignments, updates `inventoryState`, inserts `device_movements` record, marks ticket `APPROVED_SWAP`.
  - `lockDevice`: marks button as `DISABLED` with `inventoryState = 'DEFECTIVE_RETURN'`, marks ticket `RESOLVED`.
  - `resolveTicket` and `rejectTicket`.
  - BOLA tenant isolation for Store / Staff vs Admin.
- [ ] Step 2.4: Implement `WarrantyController` binding `/api/v1/warranty/tickets` with `@Roles` guards and standard response envelopes.
- [ ] Step 2.5: Register `WarrantyModule` in `AppModule`.

---

### Task 3: Backend Notifications Module & Real-time Event Wiring

**Files:**
- Create: `src/notifications/dto/query-notification.dto.ts`
- Create: `src/notifications/dto/notification-response.dto.ts`
- Create: `src/notifications/notifications.repository.ts`
- Create: `src/notifications/notifications.service.ts`
- Create: `src/notifications/notifications.controller.ts`
- Create: `src/notifications/notifications.module.ts`
- Modify: `src/app.module.ts`
- Modify: `src/warranty/warranty.service.ts` (inject notifications and socket emit)
- Create: `tests/warranty-and-notifications.spec.ts`

- [ ] Step 3.1: Create Notifications DTOs, Repository, Service, and Controller for `/api/v1/notifications`.
- [ ] Step 3.2: Implement `getNotifications`, `markAsRead`, and `markAllAsRead` with user tenant security.
- [ ] Step 3.3: Wire Notifications creation and WebSocket broadcast into `WarrantyService` on ticket creation and status updates.
- [ ] Step 3.4: Write comprehensive integration test suite `tests/warranty-and-notifications.spec.ts` covering 4 fault groups, deposit calculations, swap transactions, and notifications.
- [ ] Step 3.5: Run test suite and verify 100% PASS.

---

### Task 4: Frontend Live API Integration & Production Verification

**Files:**
- Modify: `F:\Learning\SEM9-FPTu\Frontend\src\services\warranty.ts`
- Modify: `F:\Learning\SEM9-FPTu\Frontend\src\components\devices\WarrantyPanel.tsx`
- Test: `F:\Learning\SEM9-FPTu\Frontend\tests\warranty-integration.test.mjs`

- [ ] Step 4.1: Refactor `Frontend/src/services/warranty.ts` to call backend APIs (`GET /warranty/tickets`, `POST /warranty/tickets`, `PATCH /warranty/tickets/:id/approve-swap`, etc.) with graceful fallback.
- [ ] Step 4.2: Update `WarrantyPanel.tsx` to fetch tickets from backend, handle live creation, swap approval, and listen for real-time WebSocket events.
- [ ] Step 4.3: Run Frontend TypeScript check `npx tsc --noEmit` to ensure 0 type errors.
- [ ] Step 4.4: Run Frontend production build `npm run build` to ensure clean bundling.
- [ ] Step 4.5: Commit and push both Backend and Frontend, deploy to AWS Node-3, and update `SESSION_HANDOFF.md`.
