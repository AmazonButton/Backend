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

async function runAnalyticsWindowFiltersSuite() {
  console.log('\n========================================================================');
  console.log('🚀 SUITE: ANALYTICS DATE RANGE & GROUPING FILTERS (TASK 4.4c)');
  console.log('========================================================================\n');

  let passed = 0;
  let failed = 0;

  let ownerA: any = null;
  let storeA: any = null;
  let tokenA = '';

  let ownerB: any = null;
  let storeB: any = null;
  let tokenB = '';

  let order1: any = null;
  let order2: any = null;
  let order3: any = null;
  let orderB1: any = null;

  try {
    const jwtSecret = process.env.JWT_SECRET || 'smart_order_button_super_secret_jwt_key_2026_prod';

    // 1. Setup Store A & Owner A
    ownerA = await prisma.user.create({
      data: {
        username: `an_owner_a_${Date.now()}`,
        fullName: 'Analytics Owner A',
        email: `an_owner_a_${Date.now()}@test.com`,
        status: 'ACTIVE',
      },
    });

    storeA = await prisma.store.create({
      data: {
        name: `Analytics Store A ${Date.now()}`,
        code: `STR_AN_A_${Date.now().toString().slice(-6)}`,
        phone: '0901234567',
        ownerUserId: ownerA.userId,
        status: 'ACTIVE',
        address: '100 Analytics Way A',
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

    // 2. Setup Store B & Owner B
    ownerB = await prisma.user.create({
      data: {
        username: `an_owner_b_${Date.now()}`,
        fullName: 'Analytics Owner B',
        email: `an_owner_b_${Date.now()}@test.com`,
        status: 'ACTIVE',
      },
    });

    storeB = await prisma.store.create({
      data: {
        name: `Analytics Store B ${Date.now()}`,
        code: `STR_AN_B_${Date.now().toString().slice(-6)}`,
        phone: '0907654321',
        ownerUserId: ownerB.userId,
        status: 'ACTIVE',
        address: '200 Analytics Way B',
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

    // 3. Ensure customer profile and seed orders for Store A across dates
    let testCustomer = await prisma.customerProfile.findFirst();
    if (!testCustomer) {
      const custUser = await prisma.user.create({
        data: {
          username: `cust_an_${Date.now()}`,
          fullName: 'Customer Analytics Test',
          email: `cust_an_${Date.now()}@test.com`,
          status: 'ACTIVE',
        },
      });
      testCustomer = await prisma.customerProfile.create({
        data: {
          userId: custUser.userId,
        },
      });
    }

    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 3600 * 1000);
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 3600 * 1000);
    const today = new Date();

    order1 = await prisma.order.create({
      data: {
        orderCode: `ORD_AN_1_${Date.now()}`,
        storeId: storeA.storeId,
        customerId: testCustomer.customerId,
        orderStatus: 'DELIVERED',
        paymentStatus: 'PAID',
        paymentMethod: 'COD',
        subtotalAmount: 100000,
        totalAmount: 100000,
        shippingRecipientName: 'Customer 1',
        shippingPhone: '0909000001',
        shippingAddress: '100 Street 1',
        orderDate: threeDaysAgo,
        createdAt: threeDaysAgo,
        updatedAt: threeDaysAgo,
      },
    });

    order2 = await prisma.order.create({
      data: {
        orderCode: `ORD_AN_2_${Date.now()}`,
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
        orderDate: twoDaysAgo,
        createdAt: twoDaysAgo,
        updatedAt: twoDaysAgo,
      },
    });

    order3 = await prisma.order.create({
      data: {
        orderCode: `ORD_AN_3_${Date.now()}`,
        storeId: storeA.storeId,
        customerId: testCustomer.customerId,
        orderStatus: 'DELIVERED',
        paymentStatus: 'PAID',
        paymentMethod: 'COD',
        subtotalAmount: 300000,
        totalAmount: 300000,
        shippingRecipientName: 'Customer 3',
        shippingPhone: '0909000003',
        shippingAddress: '300 Street 3',
        orderDate: today,
        createdAt: today,
        updatedAt: today,
      },
    });

    // 4. Seed order for Store B
    orderB1 = await prisma.order.create({
      data: {
        orderCode: `ORD_AN_B1_${Date.now()}`,
        storeId: storeB.storeId,
        customerId: testCustomer.customerId,
        orderStatus: 'DELIVERED',
        paymentStatus: 'PAID',
        paymentMethod: 'COD',
        subtotalAmount: 500000,
        totalAmount: 500000,
        shippingRecipientName: 'Customer B',
        shippingPhone: '0909000009',
        shippingAddress: '900 Street B',
        orderDate: today,
        createdAt: today,
        updatedAt: today,
      },
    });

    // Test 1: GET /api/v1/analytics/dashboard?groupBy=day returns store total and chart data
    const res1 = await fetch(`${BASE_URL}/analytics/dashboard?groupBy=day`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    const body1: any = await res1.json();

    const test1Passed =
      res1.status === 200 &&
      body1.success === true &&
      body1.data?.totalOrders === 3 &&
      body1.data?.totalRevenue === 600000 &&
      Array.isArray(body1.data?.chartData) &&
      body1.data.chartData.length >= 2;

    if (test1Passed) {
      logTest('GET /analytics/dashboard?groupBy=day returns store revenue metrics and daily chartData', true);
      passed++;
    } else {
      logTest('GET /analytics/dashboard?groupBy=day returns store revenue metrics', false, JSON.stringify(body1));
      failed++;
    }

    // Test 2: GET /api/v1/analytics/dashboard with fromDate filter
    const fromDateStr = new Date(Date.now() - 2.5 * 24 * 3600 * 1000).toISOString(); // excludes order1 (3 days ago)
    const res2 = await fetch(`${BASE_URL}/analytics/dashboard?fromDate=${fromDateStr}&groupBy=day`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    const body2: any = await res2.json();

    const test2Passed =
      res2.status === 200 &&
      body2.success === true &&
      body2.data?.totalOrders === 2 &&
      body2.data?.totalRevenue === 500000;

    if (test2Passed) {
      logTest('GET /analytics/dashboard?fromDate=... correctly filters orders by date range', true);
      passed++;
    } else {
      logTest('GET /analytics/dashboard?fromDate=... correctly filters orders by date range', false, JSON.stringify(body2));
      failed++;
    }

    // Test 3: GET /api/v1/analytics/dashboard?groupBy=month
    const res3 = await fetch(`${BASE_URL}/analytics/dashboard?groupBy=month`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    const body3: any = await res3.json();

    const currentYearMonth = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
    const test3Passed =
      res3.status === 200 &&
      body3.success === true &&
      Array.isArray(body3.data?.chartData) &&
      body3.data.chartData.some((c: any) => c.period === currentYearMonth && c.revenue === 600000);

    if (test3Passed) {
      logTest('GET /analytics/dashboard?groupBy=month aggregates revenue into monthly period buckets', true);
      passed++;
    } else {
      logTest('GET /analytics/dashboard?groupBy=month aggregates into monthly period buckets', false, JSON.stringify(body3));
      failed++;
    }

    // Test 4: BOLA / IDOR Protection: Store Owner A attempting to query Store B analytics
    const res4 = await fetch(`${BASE_URL}/analytics/dashboard?storeId=${storeB.storeId}`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    const body4: any = await res4.json();

    const test4Passed = res4.status === 403;

    if (test4Passed) {
      logTest('BOLA / IDOR Protection: Cross-store analytics access rejected with HTTP 403', true);
      passed++;
    } else {
      logTest('BOLA / IDOR Protection: Cross-store analytics access rejected with HTTP 403', false, `Status: ${res4.status}`);
      failed++;
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
      if (orderB1) await prisma.order.deleteMany({ where: { orderId: orderB1.orderId } });
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
  runAnalyticsWindowFiltersSuite();
}

export { runAnalyticsWindowFiltersSuite };
