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

async function runOrderFilterAndTimelineSuite() {
  console.log('\n========================================================================');
  console.log('🚀 SUITE: ORDER FILTERS, TIMELINE & DELIVERY QUEUE ROUTE ORDERING');
  console.log('========================================================================\n');

  let passed = 0;
  let failed = 0;

  let ownerUser: any = null;
  let store: any = null;
  let driverUser: any = null;
  let custUserA: any = null;
  let custProfileA: any = null;
  let custUserB: any = null;
  let custProfileB: any = null;

  let ownerToken = '';
  let driverToken = '';
  let custTokenA = '';
  let custTokenB = '';

  let order1: any = null;
  let order2: any = null;

  try {
    const jwtSecret = process.env.JWT_SECRET || 'test_super_secret_jwt_key_32_bytes_len_safe!';

    // 1. Setup Store Owner & Store
    ownerUser = await prisma.user.create({
      data: {
        username: `ord_owner_${Date.now()}`,
        email: `ord_owner_${Date.now()}@test.com`,
        phone: `0967${Math.floor(Math.random() * 1000000).toString().padStart(6, '0')}`,
        fullName: 'Order Test Store Owner',
        status: 'ACTIVE',
      },
    });

    store = await prisma.store.create({
      data: {
        name: 'Order Test Store',
        code: `STORE-ORD-${Date.now()}`,
        phone: '0901234567',
        address: '123 Order St',
        ownerUserId: ownerUser.userId,
        status: 'ACTIVE',
      },
    });

    ownerToken = jwt.sign(
      {
        userId: ownerUser.userId.toString(),
        sub: ownerUser.userId.toString(),
        email: ownerUser.email,
        role: 'STORE_OWNER',
        storeId: store.storeId.toString(),
      },
      jwtSecret,
      { expiresIn: '1h' },
    );

    // 2. Setup Driver
    driverUser = await prisma.user.create({
      data: {
        username: `ord_driver_${Date.now()}`,
        email: `ord_driver_${Date.now()}@test.com`,
        phone: `0968${Math.floor(Math.random() * 1000000).toString().padStart(6, '0')}`,
        fullName: 'Order Test Driver',
        status: 'ACTIVE',
      },
    });

    driverToken = jwt.sign(
      {
        userId: driverUser.userId.toString(),
        sub: driverUser.userId.toString(),
        email: driverUser.email,
        role: 'STAFF_DELIVERY',
        storeId: store.storeId.toString(),
      },
      jwtSecret,
      { expiresIn: '1h' },
    );

    // 3. Setup Customer A
    custUserA = await prisma.user.create({
      data: {
        username: `ord_cust_a_${Date.now()}`,
        email: `ord_cust_a_${Date.now()}@test.com`,
        phone: `0969${Math.floor(Math.random() * 1000000).toString().padStart(6, '0')}`,
        fullName: 'Customer User A',
        status: 'ACTIVE',
      },
    });

    custProfileA = await prisma.customerProfile.create({
      data: {
        userId: custUserA.userId,
        phone: custUserA.phone,
      },
    });

    custTokenA = jwt.sign(
      {
        userId: custUserA.userId.toString(),
        sub: custUserA.userId.toString(),
        email: custUserA.email,
        role: 'CUSTOMER',
        customerProfileId: custProfileA.customerId.toString(),
      },
      jwtSecret,
      { expiresIn: '1h' },
    );

    // 4. Setup Customer B
    custUserB = await prisma.user.create({
      data: {
        username: `ord_cust_b_${Date.now()}`,
        email: `ord_cust_b_${Date.now()}@test.com`,
        phone: `0970${Math.floor(Math.random() * 1000000).toString().padStart(6, '0')}`,
        fullName: 'Customer User B',
        status: 'ACTIVE',
      },
    });

    custProfileB = await prisma.customerProfile.create({
      data: {
        userId: custUserB.userId,
        phone: custUserB.phone,
      },
    });

    custTokenB = jwt.sign(
      {
        userId: custUserB.userId.toString(),
        sub: custUserB.userId.toString(),
        email: custUserB.email,
        role: 'CUSTOMER',
        customerProfileId: custProfileB.customerId.toString(),
      },
      jwtSecret,
      { expiresIn: '1h' },
    );

    // 5. Seed Order 1 for Customer A (PENDING, UNPAID, unassigned)
    order1 = await prisma.order.create({
      data: {
        orderCode: `ORD-TEST-1-${Date.now()}`,
        storeId: store.storeId,
        customerId: custProfileA.customerId,
        orderStatus: 'PENDING',
        paymentStatus: 'UNPAID',
        paymentMethod: 'COD',
        subtotalAmount: 100000,
        totalAmount: 115000,
        shippingFee: 15000,
        shippingRecipientName: 'Customer A',
        shippingPhone: '0969123456',
        shippingAddress: '123 Test St',
      },
    });

    // Seed Order 2 for Customer A (CONFIRMED, PAID, ready for delivery)
    order2 = await prisma.order.create({
      data: {
        orderCode: `ORD-TEST-2-${Date.now()}`,
        storeId: store.storeId,
        customerId: custProfileA.customerId,
        orderStatus: 'CONFIRMED',
        paymentStatus: 'PAID',
        paymentMethod: 'PAYOS',
        subtotalAmount: 200000,
        totalAmount: 215000,
        shippingFee: 15000,
        shippingRecipientName: 'Customer A',
        shippingPhone: '0969123456',
        shippingAddress: '123 Test St',
      },
    });

    // Add status history to order 2
    await prisma.orderStatusHistory.create({
      data: {
        orderId: order2.orderId,
        oldStatus: 'PENDING',
        newStatus: 'CONFIRMED',
        reason: 'Cửa hàng đã xác nhận đơn hàng',
        changedByUserId: ownerUser.userId,
      },
    });

    // Add payment transaction to order 2
    await prisma.paymentTransaction.create({
      data: {
        orderId: order2.orderId,
        provider: 'PAYOS',
        transactionCode: `TX-${Date.now()}`,
        amount: 215000,
        paymentMethod: 'PAYOS',
        status: 'PAID',
        paidAt: new Date(),
      },
    });

    // -------------------------------------------------------------------------
    // Test 1: Route Ordering Invariant - GET /orders/delivery-queue is not swallowed
    // -------------------------------------------------------------------------
    const queueRes = await fetch(`${BASE_URL}/orders/delivery-queue?page=1&pageSize=10`, {
      headers: { Authorization: `Bearer ${driverToken}` },
    });
    const queueBody = (await queueRes.json()) as any;

    if (
      queueRes.status === 200 &&
      queueBody.success === true &&
      Array.isArray(queueBody.data) &&
      queueBody.pagination?.page === 1
    ) {
      logTest('Test 1: GET /orders/delivery-queue resolves successfully without route swallowing by :id', true);
      passed++;
    } else {
      logTest(
        'Test 1: GET /orders/delivery-queue resolves successfully without route swallowing',
        false,
        `Status: ${queueRes.status}, body: ${JSON.stringify(queueBody)}`,
      );
      failed++;
    }

    // -------------------------------------------------------------------------
    // Test 2: GET /orders multi-filter querying by status & paymentStatus
    // -------------------------------------------------------------------------
    const filterRes = await fetch(
      `${BASE_URL}/orders?status=CONFIRMED&paymentStatus=PAID&page=1&pageSize=10`,
      {
        headers: { Authorization: `Bearer ${ownerToken}` },
      },
    );
    const filterBody = (await filterRes.json()) as any;

    const matchedOnlyConfirmedPaid =
      filterBody.data?.length === 1 &&
      filterBody.data[0]?.orderCode === order2.orderCode &&
      filterBody.data[0]?.orderStatus === 'CONFIRMED' &&
      filterBody.data[0]?.paymentStatus === 'PAID';

    if (filterRes.status === 200 && matchedOnlyConfirmedPaid) {
      logTest('Test 2: GET /orders multi-filter querying by status & paymentStatus returns exact match', true);
      passed++;
    } else {
      logTest(
        'Test 2: GET /orders multi-filter querying by status & paymentStatus returns exact match',
        false,
        `Status: ${filterRes.status}, count: ${filterBody.data?.length}`,
      );
      failed++;
    }

    // -------------------------------------------------------------------------
    // Test 3: Canonical Pagination Envelope & Caps
    // -------------------------------------------------------------------------
    const pagRes = await fetch(`${BASE_URL}/orders?page=1&pageSize=1`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const pagBody = (await pagRes.json()) as any;

    const validPagination =
      pagBody.pagination &&
      pagBody.pagination.page === 1 &&
      pagBody.pagination.pageSize === 1 &&
      pagBody.pagination.totalItems >= 2 &&
      pagBody.pagination.totalPages >= 2 &&
      pagBody.pagination.hasNextPage === true &&
      pagBody.pagination.hasPrevPage === false;

    if (pagRes.status === 200 && validPagination) {
      logTest('Test 3: GET /orders returns canonical pagination envelope with valid page metrics', true);
      passed++;
    } else {
      logTest(
        'Test 3: GET /orders returns canonical pagination envelope',
        false,
        `Status: ${pagRes.status}, pag: ${JSON.stringify(pagBody.pagination)}`,
      );
      failed++;
    }

    // -------------------------------------------------------------------------
    // Test 4: GET /orders/:id/timeline returns chronological order events
    // -------------------------------------------------------------------------
    const timelineRes = await fetch(`${BASE_URL}/orders/${order2.orderId}/timeline`, {
      headers: { Authorization: `Bearer ${custTokenA}` },
    });
    const timelineBody = (await timelineRes.json()) as any;
    const timelineData = timelineBody.data;

    const hasPlaced = timelineData?.timeline?.some((t: any) => t.type === 'ORDER_PLACED');
    const hasStatus = timelineData?.timeline?.some(
      (t: any) => t.type === 'STATUS_CHANGE' && t.status === 'CONFIRMED',
    );
    const hasPayment = timelineData?.timeline?.some(
      (t: any) => t.type === 'PAYMENT' && t.status === 'PAID',
    );

    if (timelineRes.status === 200 && hasPlaced && hasStatus && hasPayment) {
      logTest('Test 4: GET /orders/:id/timeline returns chronological timeline events (placed, status, payment)', true);
      passed++;
    } else {
      logTest(
        'Test 4: GET /orders/:id/timeline returns chronological timeline events',
        false,
        `Status: ${timelineRes.status}, items: ${timelineData?.timeline?.length}`,
      );
      failed++;
    }

    // -------------------------------------------------------------------------
    // Test 5: BOLA / IDOR Isolation on Order Timeline
    // -------------------------------------------------------------------------
    // Customer B tries to view Customer A's order timeline -> 403 Forbidden
    const idorTimelineRes = await fetch(`${BASE_URL}/orders/${order2.orderId}/timeline`, {
      headers: { Authorization: `Bearer ${custTokenB}` },
    });

    if (idorTimelineRes.status === 403) {
      logTest('Test 5: BOLA/IDOR protection blocks unauthorized customer from viewing order timeline (403)', true);
      passed++;
    } else {
      logTest(
        'Test 5: BOLA/IDOR protection blocks unauthorized customer from viewing order timeline',
        false,
        `Status: ${idorTimelineRes.status}`,
      );
      failed++;
    }
  } catch (err: any) {
    console.error('Order filter & timeline test error:', err);
    failed++;
  } finally {
    // Cleanup
    try {
      if (order2) {
        await prisma.paymentTransaction.deleteMany({ where: { orderId: order2.orderId } });
        await prisma.orderStatusHistory.deleteMany({ where: { orderId: order2.orderId } });
        await prisma.order.deleteMany({ where: { orderId: order2.orderId } });
      }
      if (order1) {
        await prisma.order.deleteMany({ where: { orderId: order1.orderId } });
      }
      if (custProfileA) {
        await prisma.customerProfile.deleteMany({ where: { customerId: custProfileA.customerId } });
      }
      if (custUserA) {
        await prisma.user.deleteMany({ where: { userId: custUserA.userId } });
      }
      if (custProfileB) {
        await prisma.customerProfile.deleteMany({ where: { customerId: custProfileB.customerId } });
      }
      if (custUserB) {
        await prisma.user.deleteMany({ where: { userId: custUserB.userId } });
      }
      if (driverUser) {
        await prisma.user.deleteMany({ where: { userId: driverUser.userId } });
      }
      if (store) {
        await prisma.store.deleteMany({ where: { storeId: store.storeId } });
      }
      if (ownerUser) {
        await prisma.user.deleteMany({ where: { userId: ownerUser.userId } });
      }
      await prisma.$disconnect();
    } catch (cleanupErr) {
      console.error('Cleanup error:', cleanupErr);
    }
  }

  console.log('\n------------------------------------------------------------------------');
  console.log(`Summary: ${passed} passed, ${failed} failed`);
  console.log('------------------------------------------------------------------------\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runOrderFilterAndTimelineSuite();
