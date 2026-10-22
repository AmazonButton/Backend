# Marketplace V2.2 Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Triển khai đầy đủ phân hệ Sàn Thương Mại Điện Tử V2.2 bao gồm: API duyệt Cửa hàng công khai cho Khách (`GET /stores`), Tính năng chuyển đổi Cửa hàng linh hoạt cho Nút bấm IoT (Store Re-mapping), Tính toán & lưu trữ phí hoa hồng Sàn (8%), và Đồng bộ dòng tiền Ví Store không bị trùng lặp.

**Architecture:** 
- Xây dựng module mới `StoresModule` cung cấp các API công khai cho Khách hàng (`GET /stores`, `GET /stores/:id`).
- Mở rộng `devices.service.ts` để hỗ trợ `storeId` trong `customerUpdateConfig`, tự động dọn sản phẩm cũ và gán Store mới.
- Cập nhật Prisma Schema: bổ sung `commissionRate`, `commissionAmount`, `netAmount` vào model `Order`, và `commissionRate` vào model `Store`.
- Chuẩn hóa `orders.service.ts` và `payments.repository.ts`: tính snapshot hoa hồng sàn, kết chuyển `netAmount` vào `StoreWallet` khi `COMPLETED`, loại bỏ tình trạng cộng tiền trùng lặp (double-credit).
- Viết test suite `tests/marketplace-v2-2.spec.ts` kiểm thử toàn diện các tính năng mới.

**Tech Stack:** NestJS 10, TypeScript 5, Prisma ORM, PostgreSQL, PayOS, tsx.

**Spec:** `BRD/Project_Specification_MultiStore_VN_V2.1.md` và `BRD/ERD_Level_2_MultiStore_VN_V2.1.md`.

## Global Constraints
- Hệ thống áp dụng tỷ lệ hoa hồng mặc định của Sàn là 8.00% (`commission_rate = 8.0`).
- Toàn vẹn toán học tài chính: `net_amount = total_amount - commission_amount`.
- Nút bấm thuộc Khách hàng (`customer_id`), cho phép đổi `store_id` bất kỳ lúc nào.
- Chỉ cộng doanh thu thực nhận (`net_amount`) vào Ví Cửa hàng khi đơn đạt trạng thái `COMPLETED`.

## Review Focus
1. Store Re-mapping dọn dẹp sản phẩm cũ: Khi khách đổi `store_id`, toàn bộ sản phẩm cũ của Store cũ gán trên nút phải bị xóa/thay thế để tránh đơn hàng chứa sản phẩm của 2 shop khác nhau.
2. Đơn hàng COD vs Online: Đơn hàng COD thu tiền mặt tại chỗ không được cộng tiền ví trực tuyến như PayOS.
3. Chống double-credit ví: Khi khách thanh toán qua PayOS và đơn sau đó chuyển `COMPLETED`, ví Store chỉ được cộng đúng 1 lần với số tiền `net_amount`.
4. Danh sách Stores chỉ trả về cửa hàng `ACTIVE`: Khách hàng không được thấy hoặc chọn các Store đang ở trạng thái `PENDING` hoặc `SUSPENDED`.
5. Đơn hàng Snapshot: `commission_rate`, `commission_amount`, `net_amount` phải được lưu snapshot bất biến trên từng đơn hàng.

---

### Task 1: Prisma Schema & Database Migration cho Hoa Hồng Đơn Hàng

**Files:**
- Modify: `prisma/schema.prisma`
- Verify: `npx prisma generate`

**Interfaces:**
- Produces: 
  - `Order.commissionRate: Decimal`
  - `Order.commissionAmount: Decimal`
  - `Order.netAmount: Decimal`
  - `Store.commissionRate: Decimal?`

- [ ] **Step 1: Cập nhật model `Order` và `Store` trong `prisma/schema.prisma`**
- [ ] **Step 2: Chạy `npx prisma db push` hoặc `npx prisma generate` để cập nhật Prisma Client**
- [ ] **Step 3: Kiểm tra TypeScript compilation với Prisma Client mới**

---

### Task 2: Module Cửa Hàng Công Khai (`StoresModule`)

**Files:**
- Create: `src/stores/stores.controller.ts`
- Create: `src/stores/stores.service.ts`
- Create: `src/stores/stores.module.ts`
- Modify: `src/app.module.ts`

**Interfaces:**
- Produces:
  - `GET /api/v1/stores`: Danh sách cửa hàng `ACTIVE` với phân trang, tìm kiếm.
  - `GET /api/v1/stores/:id`: Thông tin chi tiết cửa hàng và sản phẩm khả dụng.

- [ ] **Step 1: Viết `stores.service.ts` truy vấn danh sách stores `ACTIVE`**
- [ ] **Step 2: Viết `stores.controller.ts` cung cấp endpoint `GET /stores` và `GET /stores/:id`**
- [ ] **Step 3: Đăng ký `StoresModule` vào `AppModule`**
- [ ] **Step 4: Kiểm tra endpoints hoạt động**

---

### Task 3: Chuyển Đổi Cửa Hàng Cho Nút Bấm (Universal Store Re-mapping)

**Files:**
- Modify: `src/devices/devices.service.ts`
- Modify: `src/devices/devices.repository.ts`

**Interfaces:**
- Consumes: `PUT /api/v1/devices/:id/customer-config`
- Produces: Cho phép truyền `storeId` và `productId`, tự động chuyển đổi Cửa hàng của nút bấm và làm mới mapping sản phẩm.

- [ ] **Step 1: Mở rộng `customerUpdateConfig` trong `devices.service.ts` để tiếp nhận `storeId`**
- [ ] **Step 2: Kiểm tra nếu `storeId` thay đổi, xóa sạch cấu hình sản phẩm cũ và liên kết sang Store mới**
- [ ] **Step 3: Gán sản phẩm mới của Store mới (nếu truyền `productId`)**
- [ ] **Step 4: Ghi nhận lịch sử thay đổi cấu hình**

---

### Task 4: Tính Toán Hoa Hồng Sàn & Đồng Bộ Dòng Tiền Ví Cửa Hàng

**Files:**
- Modify: `src/orders/orders.service.ts`
- Modify: `src/orders/orders.repository.ts`
- Modify: `src/payments/payments.repository.ts`

**Interfaces:**
- Consumes: `simulateButtonPress`, `updateOrderStatus`, `processPaymentCreditToWallet`
- Produces: Tự động tính toán và lưu `commission_rate`, `commission_amount`, `net_amount` trên từng Order; kết chuyển `net_amount` vào Ví Store khi `COMPLETED`; không ghi có ví trùng lặp ở PayOS Webhook.

- [ ] **Step 1: Cập nhật hàm tạo đơn trong `orders.repository.ts` để lưu `commissionRate`, `commissionAmount`, `netAmount`**
- [ ] **Step 2: Cập nhật `orders.service.ts` để truyền `netAmount` vào `storeWalletService.creditOrderRevenue` khi `COMPLETED`**
- [ ] **Step 3: Cập nhật `payments.repository.ts` để Webhook PayOS chỉ cập nhật trạng thái đơn sang `CONFIRMED` / `PAID` mà không ghi có ví sớm (tránh double-credit)**

---

### Task 5: Kiểm Thử Toàn Diện (Integration Tests)

**Files:**
- Create: `tests/marketplace-v2-2.spec.ts`

- [ ] **Step 1: Viết test case cho `GET /stores` và `GET /stores/:id`**
- [ ] **Step 2: Viết test case cho Store Re-mapping trên Nút Bấm IoT**
- [ ] **Step 3: Viết test case cho Đơn hàng tính hoa hồng 8% và kết chuyển `netAmount` vào Ví Cửa Hàng**
- [ ] **Step 4: Chạy test suite `npx tsx tests/marketplace-v2-2.spec.ts` và đảm bảo 100% Pass**

---

### Task 6: Commit & Push Lên GitHub

**Files:**
- Git: Tất cả các file sửa đổi và tạo mới.

- [ ] **Step 1: Kiểm tra `git status` và `git diff`**
- [ ] **Step 2: Tạo git commit với thông điệp rõ ràng theo chuẩn Conventional Commits**
- [ ] **Step 3: Chạy `git push origin main`**
