import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import * as jwt from 'jsonwebtoken';
import * as bcrypt from 'bcryptjs';
import { assertTestDatabase, getSafeTestPrismaClient } from './test-db-guard';

async function runRentalBolaHttpTestSuite() {
  assertTestDatabase('Suite 51: Real HTTP BOLA');
  console.log('================================================================================');
  console.log('🛡️ PLATFORM BUTTON RENTAL: HTTP BOLA & AUTH INVARIANTS TEST SUITE');
  console.log('================================================================================\n');

  const prisma = getSafeTestPrismaClient('Suite 51: Real HTTP BOLA');

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

  let userCustA: any = null;
  let userCustB: any = null;
  let custProfileA: any = null;
  let custProfileB: any = null;

  let userOwnerA: any = null;
  let userOwnerB: any = null;
  let storeA: any = null;
  let storeB: any = null;

  let userAdmin: any = null;

  let chargeRentalCustA: any = null;
  let chargeRentalCustB: any = null;
  let chargeStoreA: any = null;
  let chargeStoreB: any = null;

  let rentalA: any = null;
  let rentalB: any = null;

  try {
    // 1. Boot NestJS Server on ephemeral port
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

    // 2. Setup fixtures
    const hash = await bcrypt.hash('Test12345!', 10);
    const jwtSecret = process.env.JWT_SECRET || 'sob_jwt_secret_dev_2026';

    // Users & Customers
    userCustA = await prisma.user.create({
      data: {
        username: `custA_${ts}`,
        email: `custA_${ts}@example.com`,
        fullName: 'Khach Hang A',
        passwordHash: hash,
        status: 'ACTIVE',
      },
    });
    custProfileA = await prisma.customerProfile.create({
      data: {
        userId: userCustA.userId,
      },
    });

    userCustB = await prisma.user.create({
      data: {
        username: `custB_${ts}`,
        email: `custB_${ts}@example.com`,
        fullName: 'Khach Hang B',
        passwordHash: hash,
        status: 'ACTIVE',
      },
    });
    custProfileB = await prisma.customerProfile.create({
      data: {
        userId: userCustB.userId,
      },
    });

    // Store Owners & Stores
    userOwnerA = await prisma.user.create({
      data: {
        username: `ownerA_${ts}`,
        email: `ownerA_${ts}@example.com`,
        fullName: 'Chu Cua Hang A',
        passwordHash: hash,
        status: 'ACTIVE',
      },
    });
    storeA = await prisma.store.create({
      data: {
        name: `Store A ${ts}`,
        code: `STA_${ts}`,
        ownerUserId: userOwnerA.userId,
        phone: '0901234561',
        address: '123 Test A St',
        status: 'ACTIVE',
      },
    });

    userOwnerB = await prisma.user.create({
      data: {
        username: `ownerB_${ts}`,
        email: `ownerB_${ts}@example.com`,
        fullName: 'Chu Cua Hang B',
        passwordHash: hash,
        status: 'ACTIVE',
      },
    });
    storeB = await prisma.store.create({
      data: {
        name: `Store B ${ts}`,
        code: `STB_${ts}`,
        ownerUserId: userOwnerB.userId,
        phone: '0901234562',
        address: '456 Test B St',
        status: 'ACTIVE',
      },
    });

    // Super Admin
    userAdmin = await prisma.user.create({
      data: {
        username: `admin_${ts}`,
        email: `admin_${ts}@example.com`,
        fullName: 'Quan Tri Vien He Thong',
        passwordHash: hash,
        status: 'ACTIVE',
      },
    });

    // Create Package & Rentals
    let pkg = await prisma.rentalPackage.findFirst();
    if (!pkg) {
      pkg = await prisma.rentalPackage.create({
        data: {
          packageCode: `PKG-TEST-${ts}`,
          packageName: 'Gói Thử Nghiệm 1 Nút',
          buttonQuantity: 1,
          monthlyPrice: 30000,
          depositFee: 200000,
        },
      });
    }

    const startDate = new Date();
    const endDate = new Date(startDate.getTime() + 30 * 24 * 3600 * 1000);

    rentalA = await prisma.buttonRental.create({
      data: {
        rentalCode: `RNT-A-${ts}`,
        customerId: custProfileA.customerId,
        packageId: pkg.packageId,
        monthsRented: 1,
        totalRentAmount: 30000,
        depositAmount: 200000,
        startDate,
        endDate,
        status: 'PENDING_PAYMENT',
        fulfillmentStoreId: storeA.storeId,
      },
    });

    rentalB = await prisma.buttonRental.create({
      data: {
        rentalCode: `RNT-B-${ts}`,
        customerId: custProfileB.customerId,
        packageId: pkg.packageId,
        monthsRented: 1,
        totalRentAmount: 30000,
        depositAmount: 200000,
        startDate,
        endDate,
        status: 'PENDING_PAYMENT',
        fulfillmentStoreId: storeB.storeId,
      },
    });

    // Create Billing Charges
    chargeRentalCustA = await prisma.billingCharge.create({
      data: {
        chargeCode: `CHG-RNT-A-${ts}`,
        purpose: 'RENTAL_INITIAL',
        targetType: 'RENTAL',
        targetId: rentalA.rentalId,
        totalAmount: 230000,
        status: 'PENDING',
      },
    });

    chargeRentalCustB = await prisma.billingCharge.create({
      data: {
        chargeCode: `CHG-RNT-B-${ts}`,
        purpose: 'RENTAL_INITIAL',
        targetType: 'RENTAL',
        targetId: rentalB.rentalId,
        totalAmount: 230000,
        status: 'PENDING',
      },
    });

    chargeStoreA = await prisma.billingCharge.create({
      data: {
        chargeCode: `CHG-SUB-A-${ts}`,
        purpose: 'STORE_SUBSCRIPTION',
        targetType: 'STORE_SUBSCRIPTION',
        targetId: storeA.storeId,
        totalAmount: 500000,
        status: 'PENDING',
      },
    });

    chargeStoreB = await prisma.billingCharge.create({
      data: {
        chargeCode: `CHG-SUB-B-${ts}`,
        purpose: 'STORE_SUBSCRIPTION',
        targetType: 'STORE_SUBSCRIPTION',
        targetId: storeB.storeId,
        totalAmount: 500000,
        status: 'PENDING',
      },
    });

    // Create JWT Tokens
    const tokenCustA = jwt.sign(
      {
        userId: userCustA.userId.toString(),
        customerId: custProfileA.customerId.toString(),
        email: userCustA.email,
        username: userCustA.username,
        role: 'CUSTOMER',
      },
      jwtSecret,
      { expiresIn: '1h' },
    );

    const tokenCustB = jwt.sign(
      {
        userId: userCustB.userId.toString(),
        customerId: custProfileB.customerId.toString(),
        email: userCustB.email,
        username: userCustB.username,
        role: 'CUSTOMER',
      },
      jwtSecret,
      { expiresIn: '1h' },
    );

    const tokenOwnerA = jwt.sign(
      {
        userId: userOwnerA.userId.toString(),
        storeId: storeA.storeId.toString(),
        email: userOwnerA.email,
        username: userOwnerA.username,
        role: 'STORE_OWNER',
      },
      jwtSecret,
      { expiresIn: '1h' },
    );

    const tokenOwnerB = jwt.sign(
      {
        userId: userOwnerB.userId.toString(),
        storeId: storeB.storeId.toString(),
        email: userOwnerB.email,
        username: userOwnerB.username,
        role: 'STORE_OWNER',
      },
      jwtSecret,
      { expiresIn: '1h' },
    );

    const tokenAdmin = jwt.sign(
      {
        userId: userAdmin.userId.toString(),
        email: userAdmin.email,
        username: userAdmin.username,
        role: 'SUPER_ADMIN',
      },
      jwtSecret,
      { expiresIn: '1h' },
    );

    // =========================================================================
    // TEST SUITE 1: GET /api/v1/billing-charges/:id (BOLA)
    // =========================================================================
    console.log('--- TEST SUITE 1: GET /api/v1/billing-charges/:id (BOLA) ---');

    // 1.1 Unauthenticated request returns 401
    const resNoAuth = await fetch(`${baseUrl}/billing-charges/${chargeRentalCustA.chargeId}`);
    assert(
      resNoAuth.status === 401,
      '1.1 [HTTP 401] Request thiếu Bearer Token bị từ chối 401 Unauthorized',
      `Got status ${resNoAuth.status}`,
    );

    // 1.2 Customer A attempts to access Customer B's charge -> 403 Forbidden
    const resCustAToB = await fetch(`${baseUrl}/billing-charges/${chargeRentalCustB.chargeId}`, {
      headers: { Authorization: `Bearer ${tokenCustA}` },
    });
    assert(
      resCustAToB.status === 403,
      '1.2 [HTTP 403] Customer A truy cập khoản thu của Customer B bị chặn 403 Forbidden (BOLA)',
      `Got status ${resCustAToB.status}`,
    );

    // 1.3 Store Owner A attempts to access Store B's subscription charge -> 403 Forbidden
    const resOwnerAToB = await fetch(`${baseUrl}/billing-charges/${chargeStoreB.chargeId}`, {
      headers: { Authorization: `Bearer ${tokenOwnerA}` },
    });
    assert(
      resOwnerAToB.status === 403,
      '1.3 [HTTP 403] Store Owner A truy cập khoản thu của Store B bị chặn 403 Forbidden (BOLA)',
      `Got status ${resOwnerAToB.status}`,
    );

    // 1.4 Customer A accesses Customer A's own charge -> 200 OK
    const resCustAToA = await fetch(`${baseUrl}/billing-charges/${chargeRentalCustA.chargeId}`, {
      headers: { Authorization: `Bearer ${tokenCustA}` },
    });
    const jsonCustAToA: any = await resCustAToA.json();
    assert(
      resCustAToA.status === 200 && jsonCustAToA.success === true,
      "1.4 [HTTP 200] Customer A truy cập khoản thu chính chủ của mình thành công 200 OK",
      `Got status ${resCustAToA.status}`,
    );

    // 1.5 Store Owner A accesses Store A's own charge -> 200 OK
    const resOwnerAToA = await fetch(`${baseUrl}/billing-charges/${chargeStoreA.chargeId}`, {
      headers: { Authorization: `Bearer ${tokenOwnerA}` },
    });
    const jsonOwnerAToA: any = await resOwnerAToA.json();
    assert(
      resOwnerAToA.status === 200 && jsonOwnerAToA.success === true,
      "1.5 [HTTP 200] Store Owner A truy cập khoản thu chính chủ của Store mình thành công 200 OK",
      `Got status ${resOwnerAToA.status}`,
    );

    // 1.6 Super Admin accesses Customer B's charge -> 200 OK
    const resAdminToB = await fetch(`${baseUrl}/billing-charges/${chargeRentalCustB.chargeId}`, {
      headers: { Authorization: `Bearer ${tokenAdmin}` },
    });
    const jsonAdminToB: any = await resAdminToB.json();
    assert(
      resAdminToB.status === 200 && jsonAdminToB.success === true,
      '1.6 [HTTP 200] Super Admin có quyền truy cập khoản thu của Customer B',
      `Got status ${resAdminToB.status}`,
    );

    // =========================================================================
    // TEST SUITE 2: GET /api/v1/devices/stores/:storeId/inventory (BOLA)
    // =========================================================================
    console.log('\n--- TEST SUITE 2: GET /api/v1/devices/stores/:storeId/inventory (BOLA) ---');

    // 2.1 Unauthenticated request returns 401
    const resInvNoAuth = await fetch(`${baseUrl}/devices/stores/${storeA.storeId}/inventory`);
    assert(
      resInvNoAuth.status === 401,
      '2.1 [HTTP 401] Request xem kho nút thiếu Bearer Token bị từ chối 401 Unauthorized',
      `Got status ${resInvNoAuth.status}`,
    );

    // 2.2 Customer attempts to read store inventory -> 403 Forbidden (Role Guard)
    const resInvCust = await fetch(`${baseUrl}/devices/stores/${storeA.storeId}/inventory`, {
      headers: { Authorization: `Bearer ${tokenCustA}` },
    });
    assert(
      resInvCust.status === 403,
      '2.2 [HTTP 403] Customer truy cập kho nút cửa hàng bị chặn 403 Forbidden',
      `Got status ${resInvCust.status}`,
    );

    // 2.3 Store Owner A attempts to access Store B's inventory -> 403 Forbidden
    const resInvOwnerAToB = await fetch(`${baseUrl}/devices/stores/${storeB.storeId}/inventory`, {
      headers: { Authorization: `Bearer ${tokenOwnerA}` },
    });
    assert(
      resInvOwnerAToB.status === 403,
      '2.3 [HTTP 403] Store Owner A truy cập kho nút của Store B bị chặn 403 Forbidden (BOLA)',
      `Got status ${resInvOwnerAToB.status}`,
    );

    // 2.4 Store Owner A accesses Store A's own inventory -> 200 OK
    const resInvOwnerAToA = await fetch(`${baseUrl}/devices/stores/${storeA.storeId}/inventory`, {
      headers: { Authorization: `Bearer ${tokenOwnerA}` },
    });
    const jsonInvOwnerAToA: any = await resInvOwnerAToA.json();
    assert(
      resInvOwnerAToA.status === 200 && jsonInvOwnerAToA.success === true,
      "2.4 [HTTP 200] Store Owner A truy cập kho nút chính chủ của Store mình thành công 200 OK",
      `Got status ${resInvOwnerAToA.status}`,
    );

    // 2.5 Super Admin accesses Store B's inventory -> 200 OK
    const resInvAdminToB = await fetch(`${baseUrl}/devices/stores/${storeB.storeId}/inventory`, {
      headers: { Authorization: `Bearer ${tokenAdmin}` },
    });
    const jsonInvAdminToB: any = await resInvAdminToB.json();
    assert(
      resInvAdminToB.status === 200 && jsonInvAdminToB.success === true,
      '2.5 [HTTP 200] Super Admin có quyền xem kho nút của Store B',
      `Got status ${resInvAdminToB.status}`,
    );

  } catch (err: any) {
    console.error('Test execution error:', err);
    failed++;
  } finally {
    // Teardown test fixtures
    try {
      if (chargeRentalCustA?.chargeId) await prisma.billingCharge.deleteMany({ where: { chargeId: chargeRentalCustA.chargeId } });
      if (chargeRentalCustB?.chargeId) await prisma.billingCharge.deleteMany({ where: { chargeId: chargeRentalCustB.chargeId } });
      if (chargeStoreA?.chargeId) await prisma.billingCharge.deleteMany({ where: { chargeId: chargeStoreA.chargeId } });
      if (chargeStoreB?.chargeId) await prisma.billingCharge.deleteMany({ where: { chargeId: chargeStoreB.chargeId } });
      if (rentalA?.rentalId) await prisma.buttonRental.deleteMany({ where: { rentalId: rentalA.rentalId } });
      if (rentalB?.rentalId) await prisma.buttonRental.deleteMany({ where: { rentalId: rentalB.rentalId } });
      if (storeA?.storeId) await prisma.store.deleteMany({ where: { storeId: storeA.storeId } });
      if (storeB?.storeId) await prisma.store.deleteMany({ where: { storeId: storeB.storeId } });
      if (custProfileA?.customerId) await prisma.customerProfile.deleteMany({ where: { customerId: custProfileA.customerId } });
      if (custProfileB?.customerId) await prisma.customerProfile.deleteMany({ where: { customerId: custProfileB.customerId } });
      if (userCustA?.userId) await prisma.user.deleteMany({ where: { userId: userCustA.userId } });
      if (userCustB?.userId) await prisma.user.deleteMany({ where: { userId: userCustB.userId } });
      if (userOwnerA?.userId) await prisma.user.deleteMany({ where: { userId: userOwnerA.userId } });
      if (userOwnerB?.userId) await prisma.user.deleteMany({ where: { userId: userOwnerB.userId } });
      if (userAdmin?.userId) await prisma.user.deleteMany({ where: { userId: userAdmin.userId } });
    } catch (cleanupErr: any) {
      console.warn('Cleanup warning:', cleanupErr.message);
    }

    if (app) {
      await app.close();
    }
    await prisma.$disconnect();
  }

  console.log('\n================================================================================');
  console.log(`SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log('================================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
  process.exit(0);
}

runRentalBolaHttpTestSuite();
