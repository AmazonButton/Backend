import * as dotenv from 'dotenv';
dotenv.config();
import { PrismaClient } from '@prisma/client';
import jwt from 'jsonwebtoken';

const prisma = new PrismaClient();
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000/api/v1';

function logTest(name: string, passed: boolean, detail?: string) {
  if (passed) {
    console.log(`\x1b[32m  ✔ [PASS]\x1b[0m ${name}`);
  } else {
    console.log(`\x1b[31m  ✖ [FAIL]\x1b[0m ${name}${detail ? ` -> ${detail}` : ''}`);
  }
}

async function runDriverShiftsMonitoringSuite() {
  console.log('\n========================================================================');
  console.log('🚀 SUITE: DRIVER SHIFTS MONITORING & DELIVERY SUMMARY (TASK 4.4a)');
  console.log('========================================================================\n');

  let passed = 0;
  let failed = 0;

  let ownerA: any = null;
  let storeA: any = null;
  let tokenA = '';

  let driverUserA: any = null;
  let driverTokenA = '';

  let ownerB: any = null;
  let storeB: any = null;
  let tokenB = '';

  let shiftA: any = null;
  let order1: any = null;
  let order2: any = null;
  let order3: any = null;

  try {
    const jwtSecret = process.env.JWT_SECRET || 'smart_order_button_super_secret_jwt_key_2026_prod';

    // 1. Setup Store A & Owner A
    ownerA = await prisma.user.create({
      data: {
        username: `shift_owner_a_${Date.now()}`,
        fullName: 'Shift Owner A',
        email: `shift_owner_a_${Date.now()}@test.com`,
        status: 'ACTIVE',
      },
    });

    storeA = await prisma.store.create({
      data: {
        name: `Shift Store A ${Date.now()}`,
        code: `STR_SHF_A_${Date.now().toString().slice(-6)}`,
        phone: '0901234567',
        ownerUserId: ownerA.userId,
        status: 'ACTIVE',
        address: '123 Shift Road A',
      },
    });

    tokenA = jwt.sign(
      {
        sub: ownerA.userId.toString(),
        userId: ownerA.userId.toString(),
        username: ownerA.username,
        role: 'STORE_OWNER',
        storeId: storeA.storeId.toString(),
      },
      jwtSecret,
      { expiresIn: '1h' },
    );

    // 2. Setup Driver A
    driverUserA = await prisma.user.create({
      data: {
        username: `shift_driver_a_${Date.now()}`,
        fullName: 'Driver A Nguyễn',
        email: `shift_driver_a_${Date.now()}@test.com`,
        phone: `0981${Math.floor(Math.random() * 1000000).toString().padStart(6, '0')}`,
        status: 'ACTIVE',
      },
    });

    driverTokenA = jwt.sign(
      {
        sub: driverUserA.userId.toString(),
        userId: driverUserA.userId.toString(),
        username: driverUserA.username,
        role: 'STAFF_DELIVERY',
        storeId: storeA.storeId.toString(),
      },
      jwtSecret,
      { expiresIn: '1h' },
    );

    // 3. Setup Store B & Owner B
    ownerB = await prisma.user.create({
      data: {
        username: `shift_owner_b_${Date.now()}`,
        fullName: 'Shift Owner B',
        email: `shift_owner_b_${Date.now()}@test.com`,
        status: 'ACTIVE',
      },
    });

    storeB = await prisma.store.create({
      data: {
        name: `Shift Store B ${Date.now()}`,
        code: `STR_SHF_B_${Date.now().toString().slice(-6)}`,
        phone: '0907654321',
        ownerUserId: ownerB.userId,
        status: 'ACTIVE',
        address: '456 Shift Road B',
      },
    });

    tokenB = jwt.sign(
      {
        sub: ownerB.userId.toString(),
        userId: ownerB.userId.toString(),
        username: ownerB.username,
        role: 'STORE_OWNER',
        storeId: storeB.storeId.toString(),
      },
      jwtSecret,
      { expiresIn: '1h' },
    );

    // 4. Deprecated STAFF_DELIVERY role MUST be rejected (403), while STORE_OWNER manages delivery shift directly
    const deprecatedRes = await fetch(`${BASE_URL}/driver-shifts/start`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${driverTokenA}`,
      },
    });
    if (deprecatedRes.status === 403) {
      logTest('Deprecated STAFF_DELIVERY rejected with HTTP 403 on POST /driver-shifts/start', true);
      passed++;
    } else {
      logTest('Deprecated STAFF_DELIVERY rejected with HTTP 403 on POST /driver-shifts/start', false, `Status: ${deprecatedRes.status}`);
      failed++;
    }

    const startShiftRes = await fetch(`${BASE_URL}/driver-shifts/start`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenA}`,
      },
    });
    const startShiftBody: any = await startShiftRes.json();
    shiftA = startShiftBody.data;

    // 5. Ensure customer profile and create test orders assigned to Driver A
    let testCustomer = await prisma.customerProfile.findFirst();
    if (!testCustomer) {
      const custUser = await prisma.user.create({
        data: {
          username: `cust_shf_${Date.now()}`,
          fullName: 'Customer Shift Test',
          email: `cust_shf_${Date.now()}@test.com`,
          status: 'ACTIVE',
        },
      });
      testCustomer = await prisma.customerProfile.create({
        data: {
          userId: custUser.userId,
        },
      });
    }

    order1 = await prisma.order.create({
      data: {
        orderCode: `ORD_SHF_1_${Date.now()}`,
        storeId: storeA.storeId,
        customerId: testCustomer.customerId,
        orderStatus: 'DELIVERED',
        paymentStatus: 'PAID',
        paymentMethod: 'COD',
        subtotalAmount: 150000,
        totalAmount: 150000,
        shippingRecipientName: 'Customer 1',
        shippingPhone: '0909000001',
        shippingAddress: '100 Street 1',
        assignedDriverId: ownerA.userId,
        deliveredAt: new Date(),
        updatedAt: new Date(),
      },
    });

    order2 = await prisma.order.create({
      data: {
        orderCode: `ORD_SHF_2_${Date.now()}`,
        storeId: storeA.storeId,
        customerId: testCustomer.customerId,
        orderStatus: 'DELIVERED',
        paymentStatus: 'PAID',
        paymentMethod: 'COD',
        subtotalAmount: 200000,
        totalAmount: 200000,
        shippingRecipientName: 'Customer 2',
        shippingPhone: '0909000002',
        shippingAddress: '200 Street 2',
        assignedDriverId: ownerA.userId,
        deliveredAt: new Date(),
        updatedAt: new Date(),
      },
    });

    order3 = await prisma.order.create({
      data: {
        orderCode: `ORD_SHF_3_${Date.now()}`,
        storeId: storeA.storeId,
        customerId: testCustomer.customerId,
        orderStatus: 'SHIPPING',
        paymentStatus: 'UNPAID',
        paymentMethod: 'COD',
        subtotalAmount: 100000,
        totalAmount: 100000,
        shippingRecipientName: 'Customer 3',
        shippingPhone: '0909000003',
        shippingAddress: '300 Street 3',
        assignedDriverId: ownerA.userId,
        updatedAt: new Date(),
      },
    });

    // Test 1: GET /api/v1/driver-shifts/:id returns shift detail and live stats for STORE_OWNER
    const shiftDetailRes = await fetch(`${BASE_URL}/driver-shifts/${shiftA.shiftId}`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    const shiftDetailBody: any = await shiftDetailRes.json();

    const test1Passed =
      shiftDetailRes.status === 200 &&
      shiftDetailBody.success === true &&
      shiftDetailBody.data?.shiftId === shiftA.shiftId.toString() &&
      shiftDetailBody.data?.status === 'OPEN' &&
      shiftDetailBody.data?.totalOrdersDelivered === 2 &&
      shiftDetailBody.data?.totalCodCollected === 350000;

    if (test1Passed) {
      logTest('GET /driver-shifts/:id returns detailed shift with live delivery and COD statistics', true);
      passed++;
    } else {
      logTest('GET /driver-shifts/:id returns detailed shift with live delivery stats', false, JSON.stringify(shiftDetailBody));
      failed++;
    }

    // Test 2: GET /api/v1/stores/:storeId/driver-shifts with store owner token
    const storeShiftsRes = await fetch(`${BASE_URL}/stores/${storeA.storeId}/driver-shifts?page=1&pageSize=10`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    const storeShiftsBody: any = await storeShiftsRes.json();

    const test2Passed =
      storeShiftsRes.status === 200 &&
      storeShiftsBody.success === true &&
      Array.isArray(storeShiftsBody.data) &&
      storeShiftsBody.data.some((s: any) => s.shiftId === shiftA.shiftId.toString()) &&
      storeShiftsBody.pagination?.totalItems >= 1;

    if (test2Passed) {
      logTest('GET /stores/:storeId/driver-shifts returns store driver shifts with canonical pagination', true);
      passed++;
    } else {
      logTest('GET /stores/:storeId/driver-shifts returns store driver shifts', false, JSON.stringify(storeShiftsBody));
      failed++;
    }

    // Test 3: BOLA / IDOR protection: Store Owner B accessing Store A's shifts is rejected
    const idorRes = await fetch(`${BASE_URL}/stores/${storeA.storeId}/driver-shifts`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    const test3Passed = idorRes.status === 403;

    if (test3Passed) {
      logTest('BOLA / IDOR Protection: Cross-store driver shifts monitoring rejected with HTTP 403', true);
      passed++;
    } else {
      logTest('BOLA / IDOR Protection: Cross-store driver shifts monitoring rejected with HTTP 403', false, `Status: ${idorRes.status}`);
      failed++;
    }

    // Test 4: GET /api/v1/drivers/me/delivery-summary returns personal stats for STORE_OWNER
    const summaryRes = await fetch(`${BASE_URL}/drivers/me/delivery-summary`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    const summaryBody: any = await summaryRes.json();

    const test4Passed =
      summaryRes.status === 200 &&
      summaryBody.success === true &&
      summaryBody.data?.driverId === ownerA.userId.toString() &&
      summaryBody.data?.todayCompletedDeliveries === 2 &&
      summaryBody.data?.todayPendingDeliveries === 1 &&
      summaryBody.data?.todayCashCollected === 350000;

    if (test4Passed) {
      logTest('GET /drivers/me/delivery-summary computes today completed/pending deliveries and collected COD', true);
      passed++;
    } else {
      logTest('GET /drivers/me/delivery-summary computes delivery summary', false, JSON.stringify(summaryBody));
      failed++;
    }

    // Test 5: Legacy shipper open shift & in-flight SHIPPING order reconciliation by STORE_OWNER
    const legacyOrder = await prisma.order.create({
      data: {
        orderCode: `ORD_LEG_${Date.now()}`,
        storeId: storeA.storeId,
        customerId: testCustomer.customerId,
        orderStatus: 'SHIPPING',
        paymentStatus: 'UNPAID',
        paymentMethod: 'COD',
        subtotalAmount: 85000,
        totalAmount: 85000,
        shippingRecipientName: 'Legacy Recipient',
        shippingPhone: '0909000099',
        shippingAddress: '999 Legacy Rd',
        assignedDriverId: driverUserA.userId,
      },
    });
    const legacyShift = await prisma.driverShift.create({
      data: {
        storeId: storeA.storeId,
        driverId: driverUserA.userId,
        status: 'OPEN',
        startedAt: new Date(Date.now() - 1800_000),
        handoverCode: `HO-LEG-${Date.now()}`,
      },
    });
    try {
      const statusRes = await fetch(`${BASE_URL}/stores/${storeA.storeId}/legacy-handover-status`, {
        headers: { Authorization: `Bearer ${tokenA}` },
      });
      const statusBody: any = await statusRes.json();

      const settleRes = await fetch(`${BASE_URL}/stores/${storeA.storeId}/legacy-handover/settle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenA}` },
        body: JSON.stringify({ note: 'Thu hoi don & ban giao ca cu' }),
      });
      const settleBody: any = await settleRes.json();
      const updatedLegacyOrder = await prisma.order.findUnique({ where: { orderId: legacyOrder.orderId } });
      const updatedLegacyShift = await prisma.driverShift.findUnique({ where: { shiftId: legacyShift.shiftId } });

      if (
        statusRes.status === 200 &&
        statusBody.data?.inFlightShipperOrders?.length === 1 &&
        settleRes.status === 200 &&
        settleBody.data?.reclaimedShippingOrdersCount === 1 &&
        updatedLegacyOrder?.assignedDriverId === ownerA.userId &&
        updatedLegacyShift?.status === 'HANDED_OVER'
      ) {
        logTest('GET/POST /stores/:storeId/legacy-handover reclaims legacy SHIPPING orders & settles open shifts', true);
        passed++;
      } else {
        logTest('GET/POST /stores/:storeId/legacy-handover', false, JSON.stringify({ statusBody, settleBody }));
        failed++;
      }
    } finally {
      await prisma.order.deleteMany({ where: { orderId: legacyOrder.orderId } }).catch(() => {});
      await prisma.driverShift.deleteMany({ where: { shiftId: legacyShift.shiftId } }).catch(() => {});
    }
  } catch (err: any) {
    console.error('Fatal error during suite:', err);
    failed++;
  } finally {
    // Teardown
    try {
      if (order1) await prisma.order.deleteMany({ where: { orderId: order1.orderId } });
      if (order2) await prisma.order.deleteMany({ where: { orderId: order2.orderId } });
      if (order3) await prisma.order.deleteMany({ where: { orderId: order3.orderId } });
      if (shiftA) {
        await prisma.driverShift.deleteMany({ where: { shiftId: BigInt(shiftA.shiftId) } });
      }
      if (driverUserA) {
        await prisma.driverDuty.deleteMany({ where: { driverId: driverUserA.userId } });
        await prisma.driverShift.deleteMany({ where: { driverId: driverUserA.userId } });
        await prisma.user.deleteMany({ where: { userId: driverUserA.userId } });
      }
      if (storeA) await prisma.store.deleteMany({ where: { storeId: storeA.storeId } });
      if (ownerA) await prisma.user.deleteMany({ where: { userId: ownerA.userId } });
      if (storeB) await prisma.store.deleteMany({ where: { storeId: storeB.storeId } });
      if (ownerB) await prisma.user.deleteMany({ where: { userId: ownerB.userId } });
      await prisma.$disconnect();
    } catch (_) {}
  }

  console.log(`\n========================================================================`);
  console.log(`SUITE RESULTS: ${passed} PASSED | ${failed} FAILED`);
  console.log(`========================================================================\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

if (require.main === module) {
  runDriverShiftsMonitoringSuite();
}

export { runDriverShiftsMonitoringSuite };
