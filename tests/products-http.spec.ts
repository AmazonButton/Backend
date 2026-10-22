import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { PrismaClient } from '@prisma/client';
import * as jwt from 'jsonwebtoken';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function runProductsHttpTestSuite() {
  console.log('================================================================================');
  console.log('⚡ PRODUCTS HTTP INTEGRATION TEST SUITE (ROUTE -> GUARDS -> PIPES -> DB)');
  console.log('================================================================================\n');

  let passed = 0;
  let failed = 0;

  const assert = (condition: boolean, testName: string, detail?: string) => {
    if (condition) {
      console.log(`  ✔ [PASS] ${testName}`);
      passed++;
    } else {
      console.error(`  ✖ [FAIL] ${testName}${detail ? ` -> ${detail}` : ''}`);
      failed++;
    }
  };

  let app: any = null;
  let baseUrl = '';
  const ts = Date.now();
  let customerUser: any = null;
  let storeOwner1: any = null;
  let storeOwner2: any = null;
  let storeOwnerNoStore: any = null;
  let staffInventoryStore1: any = null;
  let testStore1: any = null;
  let testStore2: any = null;
  let testProductStore1: any = null;
  let testProductStore2: any = null;

  try {
    // -------------------------------------------------------------------------
    // 1. BOOTSTRAP REAL NESTJS SERVER ON EPHEMERAL PORT
    // -------------------------------------------------------------------------
    app = await NestFactory.create(AppModule, { logger: ['error'] });
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
      }),
    );
    await app.listen(0);

    const address = app.getHttpServer().address();
    const port = typeof address === 'string' ? address : address?.port;
    baseUrl = `http://localhost:${port}/api/v1`;
    console.log(`[INFO] NestJS Server listening at: ${baseUrl}\n`);

    // -------------------------------------------------------------------------
    // 2. CREATE FIXTURE USERS & STORES
    // -------------------------------------------------------------------------
    const hash = await bcrypt.hash('Test12345!', 10);

    // Customer
    customerUser = await prisma.user.create({
      data: {
        username: `cust_${ts}`,
        email: `cust_${ts}@example.com`,
        fullName: 'Nguyen Van Khach Hang',
        passwordHash: hash,
        status: 'ACTIVE',
      },
    });

    // Store 1 & Owner 1
    storeOwner1 = await prisma.user.create({
      data: {
        username: `owner1_${ts}`,
        email: `owner1_${ts}@example.com`,
        fullName: 'Chu Cua Hang 1',
        passwordHash: hash,
        status: 'ACTIVE',
      },
    });
    testStore1 = await prisma.store.create({
      data: {
        name: `Store 1 ${ts}`,
        code: `ST1_${ts}`,
        ownerUserId: storeOwner1.userId,
        phone: '0901234567',
        address: '123 Test St',
        status: 'ACTIVE',
      },
    });

    // Store 2 & Owner 2
    storeOwner2 = await prisma.user.create({
      data: {
        username: `owner2_${ts}`,
        email: `owner2_${ts}@example.com`,
        fullName: 'Chu Cua Hang 2',
        passwordHash: hash,
        status: 'ACTIVE',
      },
    });
    testStore2 = await prisma.store.create({
      data: {
        name: `Store 2 ${ts}`,
        code: `ST2_${ts}`,
        ownerUserId: storeOwner2.userId,
        phone: '0901234568',
        address: '456 Test St',
        status: 'ACTIVE',
      },
    });

    // Owner without any store linked (Fail-closed check)
    storeOwnerNoStore = await prisma.user.create({
      data: {
        username: `ownernostore_${ts}`,
        email: `ownernostore_${ts}@example.com`,
        fullName: 'Chu Cua Hang Chua Gan Store',
        passwordHash: hash,
        status: 'ACTIVE',
      },
    });

    // Staff Inventory linked to Store 1 in DB
    staffInventoryStore1 = await prisma.user.create({
      data: {
        username: `staff1_${ts}`,
        email: `staff1_${ts}@example.com`,
        fullName: 'Nhan Vien Kho Store 1',
        passwordHash: hash,
        status: 'ACTIVE',
      },
    });

    const staffRole = await prisma.role.findUnique({ where: { roleCode: 'STAFF_INVENTORY' } });
    if (staffRole) {
      await prisma.storeStaff.create({
        data: {
          storeId: testStore1.storeId,
          userId: staffInventoryStore1.userId,
          roleId: staffRole.roleId,
          status: 'ACTIVE',
        },
      });
    }

    // Product of Store 1
    testProductStore1 = await prisma.product.create({
      data: {
        storeId: testStore1.storeId,
        productCode: `P-TEST-ST1-${ts}`,
        productName: `Binh Nuoc Khoang Store 1 ${ts}`,
        basePrice: 55000,
        status: 'ACTIVE',
        images: {
          create: [
            {
              imageUrl: 'https://res.cloudinary.com/daiqbvy5y/image/upload/v1791547378/smart-order/lavie-water-19l.svg',
              cloudinaryPublicId: 'smart-order/lavie-water-19l',
              isThumbnail: true,
              displayOrder: 0,
            },
            {
              imageUrl: 'https://example.com/gallery-extra.jpg',
              cloudinaryPublicId: 'stores/gallery-extra',
              isThumbnail: false,
              displayOrder: 1,
            },
          ],
        },
      },
      include: {
        images: true,
      },
    });

    // Product of Store 2
    testProductStore2 = await prisma.product.create({
      data: {
        storeId: testStore2.storeId,
        productCode: `P-TEST-ST2-${ts}`,
        productName: `Binh Nuoc Tinh Khiet Store 2 ${ts}`,
        basePrice: 60000,
        status: 'ACTIVE',
      },
    });

    const jwtSecret = process.env.JWT_SECRET || 'sob_jwt_secret_dev_2026';
    const jwtCustomer = jwt.sign(
      { userId: customerUser.userId.toString(), email: customerUser.email, username: customerUser.username, role: 'CUSTOMER' },
      jwtSecret,
      { expiresIn: '1h' },
    );
    const jwtOwner1 = jwt.sign(
      { userId: storeOwner1.userId.toString(), email: storeOwner1.email, username: storeOwner1.username, role: 'STORE_OWNER', storeId: testStore1.storeId.toString() },
      jwtSecret,
      { expiresIn: '1h' },
    );
    const jwtOwner2 = jwt.sign(
      { userId: storeOwner2.userId.toString(), email: storeOwner2.email, username: storeOwner2.username, role: 'STORE_OWNER', storeId: testStore2.storeId.toString() },
      jwtSecret,
      { expiresIn: '1h' },
    );
    const jwtOwnerNoStore = jwt.sign(
      { userId: storeOwnerNoStore.userId.toString(), email: storeOwnerNoStore.email, username: storeOwnerNoStore.username, role: 'STORE_OWNER' },
      jwtSecret,
      { expiresIn: '1h' },
    );
    const jwtStaff1 = jwt.sign(
      { userId: staffInventoryStore1.userId.toString(), email: staffInventoryStore1.email, username: staffInventoryStore1.username, role: 'STAFF_INVENTORY', storeId: testStore1.storeId.toString() },
      jwtSecret,
      { expiresIn: '1h' },
    );

    // -------------------------------------------------------------------------
    // TEST 1: THIẾU JWT → 401 UNAUTHORIZED
    // -------------------------------------------------------------------------
    console.log('[SECTION 1] KIỂM THỬ XÁC THỰC BẢO VỆ ROUTE (JWT AUTH GUARD)');
    const resListNoAuth = await fetch(`${baseUrl}/products`);
    assert(resListNoAuth.status === 401, 'GET /api/v1/products thiếu JWT trả 401 Unauthorized');

    const resDetailNoAuth = await fetch(`${baseUrl}/products/${testProductStore1.productId}`);
    assert(resDetailNoAuth.status === 401, 'GET /api/v1/products/:id thiếu JWT trả 401 Unauthorized');

    // -------------------------------------------------------------------------
    // TEST 2: GET /api/v1/products (LIST) VỚI JWT HỢP LỆ & ENVELOPE { success, data }
    // -------------------------------------------------------------------------
    console.log('\n[SECTION 2] KIỂM THỬ ROUTE GET /api/v1/products & RESPONSE ENVELOPE');
    const resList = await fetch(`${baseUrl}/products`, {
      headers: { Authorization: `Bearer ${jwtCustomer}` },
    });
    const listBody = await resList.json();
    assert(resList.status === 200, 'GET /api/v1/products trả HTTP 200 OK');
    assert(listBody.success === true && Array.isArray(listBody.data), 'Response envelope chuẩn dạng { success: true, data: [...] }');
    const foundItem = listBody.data.find((p: any) => p.productId === testProductStore1.productId.toString());
    assert(!!foundItem, 'Danh sách trả về đúng sản phẩm vừa tạo trong database');
    assert(
      foundItem?.imageUrl && foundItem?.thumbnailUrl && Array.isArray(foundItem?.images),
      'Mỗi item trong data có đầy đủ imageUrl, thumbnailUrl và mảng images',
    );

    // -------------------------------------------------------------------------
    // TEST 3: GET /api/v1/products/:id VỚI ID HỢP LỆ & ENVELOPE { success, data }
    // -------------------------------------------------------------------------
    console.log('\n[SECTION 3] KIỂM THỬ ROUTE GET /api/v1/products/:id CHI TIẾT');
    const resDetail = await fetch(`${baseUrl}/products/${testProductStore1.productId}`, {
      headers: { Authorization: `Bearer ${jwtCustomer}` },
    });
    const detailBody = await resDetail.json();
    assert(resDetail.status === 200, 'GET /api/v1/products/:id trả HTTP 200 OK');
    assert(detailBody.success === true && typeof detailBody.data === 'object', 'Response envelope chuẩn dạng { success: true, data: { ... } }');
    assert(detailBody.data.productId === testProductStore1.productId.toString(), 'Chi tiết sản phẩm trả đúng productId');
    assert(
      detailBody.data.images.length === 2 && detailBody.data.imageUrl.includes('lavie-water-19l'),
      'Chi tiết trả về đúng 2 ảnh với imageUrl là ảnh thumbnail chính',
    );

    // -------------------------------------------------------------------------
    // TEST 4: GET /api/v1/products/abc (PARSEINTPIPE) → 400 BAD REQUEST
    // -------------------------------------------------------------------------
    console.log('\n[SECTION 4] KIỂM THỬ VALIDATION ID KHÔNG PHẢI SỐ NGUYÊN (PARSEINTPIPE)');
    const resBadId = await fetch(`${baseUrl}/products/abc`, {
      headers: { Authorization: `Bearer ${jwtCustomer}` },
    });
    const badIdBody = await resBadId.json();
    assert(
      resBadId.status === 400,
      'GET /api/v1/products/abc được ParseIntPipe chặn ngay và trả 400 Bad Request',
    );
    assert(
      badIdBody.statusCode === 400 && JSON.stringify(badIdBody).includes('numeric string is expected'),
      'Lỗi trả về chuẩn xác: numeric string is expected, không xảy ra lỗi 500 parse BigInt',
    );

    // -------------------------------------------------------------------------
    // TEST 5: GET /api/v1/products/9999999 (NOT FOUND) → 404 NOT FOUND
    // -------------------------------------------------------------------------
    console.log('\n[SECTION 5] KIỂM THỬ TRUY VẤN SẢN PHẨM KHÔNG TỒN TẠI (404 NOT FOUND)');
    const resNotFound = await fetch(`${baseUrl}/products/999999999`, {
      headers: { Authorization: `Bearer ${jwtCustomer}` },
    });
    const notFoundBody = await resNotFound.json();
    assert(resNotFound.status === 404, 'GET /api/v1/products/999999999 trả đúng HTTP 404 Not Found');
    assert(
      JSON.stringify(notFoundBody).includes('San pham khong ton tai') || notFoundBody.statusCode === 404,
      'Thông báo lỗi 404 thân thiện',
    );

    // -------------------------------------------------------------------------
    // TEST 6: CHÍNH SÁCH TENANT ISOLATION (STORE_OWNER, STAFF_INVENTORY & FAIL-CLOSED)
    // -------------------------------------------------------------------------
    console.log('\n[SECTION 6] KIỂM THỬ CHÍNH SÁCH TENANT (BOLA / IDOR RESTRICTION & FAIL-CLOSED)');
    // 6.1: Store Owner 1 xem sản phẩm của chính Store 1 -> 200 OK
    const resOwner1Self = await fetch(`${baseUrl}/products/${testProductStore1.productId}`, {
      headers: { Authorization: `Bearer ${jwtOwner1}` },
    });
    assert(resOwner1Self.status === 200, 'Store Owner 1 xem chi tiết sản phẩm của cửa hàng mình: 200 OK');

    // 6.2: Store Owner 2 xem sản phẩm của Store 1 -> 403 Forbidden
    const resOwner2Other = await fetch(`${baseUrl}/products/${testProductStore1.productId}`, {
      headers: { Authorization: `Bearer ${jwtOwner2}` },
    });
    assert(
      resOwner2Other.status === 403,
      'Store Owner 2 truy cập sản phẩm của Store 1 bị chặn với 403 Forbidden (Chống BOLA/IDOR)',
    );

    // 6.3: Store Owner không có storeId -> 403 Forbidden (Fail-Closed)
    const resOwnerNoStore = await fetch(`${baseUrl}/products/${testProductStore1.productId}`, {
      headers: { Authorization: `Bearer ${jwtOwnerNoStore}` },
    });
    assert(
      resOwnerNoStore.status === 403,
      'Store Owner thiếu storeId bị chặn với 403 Forbidden (Fail-Closed bảo mật)',
    );

    // 6.4: Staff Inventory cửa hàng 1 xem sản phẩm cửa hàng 1 -> 200 OK
    const resStaff1Self = await fetch(`${baseUrl}/products/${testProductStore1.productId}`, {
      headers: { Authorization: `Bearer ${jwtStaff1}` },
    });
    assert(resStaff1Self.status === 200, 'Staff Inventory cửa hàng 1 xem sản phẩm cửa hàng 1: 200 OK');

    // 6.5: Staff Inventory cửa hàng 1 xem sản phẩm cửa hàng 2 -> 403 Forbidden
    const resStaff1Other = await fetch(`${baseUrl}/products/${testProductStore2.productId}`, {
      headers: { Authorization: `Bearer ${jwtStaff1}` },
    });
    assert(
      resStaff1Other.status === 403,
      'Staff Inventory cửa hàng 1 xem sản phẩm cửa hàng 2 bị chặn với 403 Forbidden',
    );

    // 6.6: Customer xem sản phẩm của Store 1 -> 200 OK (Catalog công khai cho người mua hàng)
    const resCustomerCatalog = await fetch(`${baseUrl}/products/${testProductStore1.productId}`, {
      headers: { Authorization: `Bearer ${jwtCustomer}` },
    });
    assert(resCustomerCatalog.status === 200, 'Customer xem catalog sản phẩm công khai: 200 OK');

    console.log('--------------------------------------------------------------------------------');
    console.log(`⚡ PRODUCTS HTTP SUITE COMPLETE: ${passed} PASSED, ${failed} FAILED`);
    console.log('--------------------------------------------------------------------------------\n');
  } catch (err: any) {
    console.error('Fatal error in products HTTP test suite:', err);
    failed++;
  } finally {
    // Cleanup fixtures strictly by ID
    try {
      if (testProductStore1?.productId) {
        await prisma.productImage.deleteMany({ where: { productId: testProductStore1.productId } });
        await prisma.product.deleteMany({ where: { productId: testProductStore1.productId } });
      }
      if (testProductStore2?.productId) {
        await prisma.product.deleteMany({ where: { productId: testProductStore2.productId } });
      }
      if (testStore1?.storeId) {
        await prisma.storeStaff.deleteMany({ where: { storeId: testStore1.storeId } });
        await prisma.store.deleteMany({ where: { storeId: testStore1.storeId } });
      }
      if (testStore2?.storeId) {
        await prisma.storeStaff.deleteMany({ where: { storeId: testStore2.storeId } });
        await prisma.store.deleteMany({ where: { storeId: testStore2.storeId } });
      }
      if (storeOwner1?.userId) {
        await prisma.user.deleteMany({ where: { userId: storeOwner1.userId } });
      }
      if (storeOwner2?.userId) {
        await prisma.user.deleteMany({ where: { userId: storeOwner2.userId } });
      }
      if (storeOwnerNoStore?.userId) {
        await prisma.user.deleteMany({ where: { userId: storeOwnerNoStore.userId } });
      }
      if (staffInventoryStore1?.userId) {
        await prisma.user.deleteMany({ where: { userId: staffInventoryStore1.userId } });
      }
      if (customerUser?.userId) {
        await prisma.user.deleteMany({ where: { userId: customerUser.userId } });
      }
    } catch (cleanupErr: any) {
      console.warn('Cleanup warning:', cleanupErr.message);
    }

    if (app) {
      await app.close();
    }
    await prisma.$disconnect();
  }

  if (failed > 0) {
    process.exit(1);
  }
  process.exit(0);
}

runProductsHttpTestSuite();
