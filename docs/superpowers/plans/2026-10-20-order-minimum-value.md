# Order Minimum Value (2,000 VND) Enforcement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce a strict minimum order value constraint (`totalAmount >= 2,000 VND`) across PostgreSQL Stored Procedure, Repository Fallback Transaction, and Service Layer, rejecting sub-2,000 VND orders with HTTP 400 (`ORDER_TOTAL_BELOW_MINIMUM`).

**Architecture:** Defense-in-depth with 3 layers:
1. Database Stored Procedure (`sp_create_order_from_button`) as primary guardian (ERRCODE = 'P0010') before inserting orders or mutating inventory.
2. Repository Fallback Transaction (`createOrderFallbackTx`) pre-calculating total from live DB prices and throwing `BadRequestException` before order creation or inventory lock.
3. Service Layer (`handleButtonEvent`) defining `MIN_ORDER_TOTAL_VND = 2000` with early checking and error mapping for SP/fallback failures.

**Tech Stack:** PostgreSQL (PL/pgSQL), Prisma ORM, NestJS, TypeScript, tsx test runner.

---

## Global Constraints
- Minimum order total threshold: 2,000 VND (`totalAmount = subtotalAmount + shippingFee - discountAmount >= 2000`).
- Rejection response format: HTTP 400 Bad Request with `{ errorCode: "ORDER_TOTAL_BELOW_MINIMUM", message: "Giá trị đơn hàng tối thiểu là 2.000 VND" }`.
- Do NOT add `CHECK (total_amount >= 2000)` constraint to `orders` table directly yet.
- Zero residue in database on rejection (no order, order item, inventory reservation, or idempotency hit left behind).

---

## Tasks

- [ ] Task 1: Create Prisma migration for `sp_create_order_from_button` minimum order check (ERRCODE P0010)
- [ ] Task 2: Refactor `createOrderFallbackTx` in `OrdersRepository` to pre-calculate total, enforce >= 2000, and remove temporary order write
- [ ] Task 3: Update `OrdersService` with `MIN_ORDER_TOTAL_VND = 2000`, early validation, and SP P0010 error mapping
- [ ] Task 4: Create comprehensive test suite `tests/order-minimum-value.spec.ts` covering 1999 VND, 2000 VND, 2001 VND, subtotal < 2000 + shipping >= 2000, SP & fallback, duplicate IoT request idempotency, and zero residue
- [ ] Task 5: Run migration deploy, tsc verification, build, and test suite verification
