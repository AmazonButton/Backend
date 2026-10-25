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

async function runStoreCustomersSuite() {
  console.log('\n========================================================================');
  console.log('🚀 SUITE: STORE-CUSTOMER CRM & CUSTOMER STORE HISTORY (TASK 4.4b)');
  console.log('========================================================================\n');

  let passed = 0;
  let failed = 0;

  let ownerA: any = null;
  let storeA: any = null;
  let tokenA = '';

  let ownerB: any = null;
  let storeB: any = null;
  let tokenB = '';

  let userCust1: any = null;
  let profile1: any = null;
  let tokenCust1 = '';

  let userCust2: any = null;
  let profile2: any = null;

  let scA1: any = null;
  let scA2: any = null;
  let scB1: any = null;
  let testOrder: any = null;

  try {
    const jwtSecret = process.env.JWT_SECRET || 'smart_order_button_super_secret_jwt_key_2026_prod';

    // 1. Setup Store A & Owner A
    ownerA = await prisma.user.create({
      data: {
        username: `crm_owner_a_${Date.now()}`,
        fullName: 'CRM Store Owner A',
        email: `crm_owner_a_${Date.now()}@test.com`,
        status: 'ACTIVE',
      },
    });

    storeA = await prisma.store.create({
      data: {
        name: `CRM Store A ${Date.now()}`,
        code: `STR_CRM_A_${Date.now().toString().slice(-6)}`,
        phone: '0901234567',
        ownerUserId: ownerA.userId,
        status: 'ACTIVE',
        address: '100 CRM Road A',
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
        username: `crm_owner_b_${Date.now()}`,
        fullName: 'CRM Store Owner B',
        email: `crm_owner_b_${Date.now()}@test.com`,
        status: 'ACTIVE',
      },
    });

    storeB = await prisma.store.create({
      data: {
        name: `CRM Store B ${Date.now()}`,
        code: `STR_CRM_B_${Date.now().toString().slice(-6)}`,
        phone: '0907654321',
        ownerUserId: ownerB.userId,
        status: 'ACTIVE',
        address: '200 CRM Road B',
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

    // 3. Setup Customer 1
    userCust1 = await prisma.user.create({
      data: {
        username: `cust1_${Date.now()}`,
        fullName: 'Nguyễn Văn Khách 1',
        email: `cust1_${Date.now()}@test.com`,
        phone: `0961${Math.floor(Math.random() * 1000000).toString().padStart(6, '0')}`,
        status: 'ACTIVE',
      },
    });

    profile1 = await prisma.customerProfile.create({
      data: {
        userId: userCust1.userId,
        phone: userCust1.phone,
      },
    });

    tokenCust1 = jwt.sign(
      {
        sub: userCust1.userId.toString(),
        userId: userCust1.userId.toString(),
        username: userCust1.username,
        role: 'CUSTOMER',
      },
      jwtSecret,
      { expiresIn: '1h' },
    );

    // 4. Setup Customer 2
    userCust2 = await prisma.user.create({
      data: {
        username: `cust2_${Date.now()}`,
        fullName: 'Trần Thị Khách 2',
        email: `cust2_${Date.now()}@test.com`,
        phone: `0962${Math.floor(Math.random() * 1000000).toString().padStart(6, '0')}`,
        status: 'ACTIVE',
      },
    });

    profile2 = await prisma.customerProfile.create({
      data: {
        userId: userCust2.userId,
        phone: userCust2.phone,
      },
    });

    // 5. Seed StoreCustomer memberships
    scA1 = await prisma.storeCustomer.create({
      data: {
        storeId: storeA.storeId,
        customerId: profile1.customerId,
        status: 'ACTIVE',
        joinedAt: new Date(Date.now() - 48 * 3600 * 1000),
      },
    });

    scA2 = await prisma.storeCustomer.create({
      data: {
        storeId: storeA.storeId,
        customerId: profile2.customerId,
        status: 'ACTIVE',
        joinedAt: new Date(Date.now() - 24 * 3600 * 1000),
      },
    });

    scB1 = await prisma.storeCustomer.create({
      data: {
        storeId: storeB.storeId,
        customerId: profile1.customerId,
        status: 'ACTIVE',
        joinedAt: new Date(Date.now() - 12 * 3600 * 1000),
      },
    });

    // 6. Seed completed order for Customer 1 in Store A
    testOrder = await prisma.order.create({
      data: {
        orderCode: `ORD_CRM_1_${Date.now()}`,
        storeId: storeA.storeId,
        customerId: profile1.customerId,
        orderStatus: 'DELIVERED',
        paymentStatus: 'PAID',
        paymentMethod: 'COD',
        subtotalAmount: 250000,
        totalAmount: 250000,
        shippingRecipientName: 'Nguyễn Văn Khách 1',
        shippingPhone: userCust1.phone || '0909000000',
        shippingAddress: '100 Nguyen Trai',
        deliveredAt: new Date(),
      },
    });

    // Test 1: GET /api/v1/stores/:storeId/customers
    const listRes = await fetch(`${BASE_URL}/stores/${storeA.storeId}/customers?page=1&pageSize=10`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    const listBody: any = await listRes.json();

    const test1Passed =
      listRes.status === 200 &&
      listBody.success === true &&
      Array.isArray(listBody.data) &&
      listBody.data.length === 2 &&
      listBody.pagination?.totalItems === 2 &&
      listBody.data.some((c: any) => c.customerId === profile1.customerId.toString() && c.totalSpent === 250000);

    if (test1Passed) {
      logTest('GET /stores/:storeId/customers returns store customer CRM list with canonical pagination and stats', true);
      passed++;
    } else {
      logTest('GET /stores/:storeId/customers returns store customer CRM list', false, JSON.stringify(listBody));
      failed++;
    }

    // Test 2: GET /api/v1/stores/:storeId/customers/:customerId
    const detailRes = await fetch(`${BASE_URL}/stores/${storeA.storeId}/customers/${profile1.customerId}`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    const detailBody: any = await detailRes.json();

    const test2Passed =
      detailRes.status === 200 &&
      detailBody.success === true &&
      detailBody.data?.customerId === profile1.customerId.toString() &&
      detailBody.data?.fullName === 'Nguyễn Văn Khách 1' &&
      detailBody.data?.totalOrders === 1 &&
      detailBody.data?.totalSpent === 250000;

    if (test2Passed) {
      logTest('GET /stores/:storeId/customers/:customerId returns detailed customer profile and store stats', true);
      passed++;
    } else {
      logTest('GET /stores/:storeId/customers/:customerId returns detailed customer profile', false, JSON.stringify(detailBody));
      failed++;
    }

    // Test 3: PATCH /api/v1/stores/:storeId/customers/:customerId/status to BLOCKED
    const patchRes = await fetch(`${BASE_URL}/stores/${storeA.storeId}/customers/${profile2.customerId}/status`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({ status: 'BLOCKED' }),
    });
    const patchBody: any = await patchRes.json();

    const test3Passed =
      patchRes.status === 200 &&
      patchBody.success === true &&
      patchBody.data?.status === 'BLOCKED';

    if (test3Passed) {
      logTest('PATCH /stores/:storeId/customers/:customerId/status updates membership status (ACTIVE -> BLOCKED)', true);
      passed++;
    } else {
      logTest('PATCH /stores/:storeId/customers/:customerId/status updates membership status', false, JSON.stringify(patchBody));
      failed++;
    }

    // Test 4: BOLA / IDOR Protection: Store Owner B inspecting Store A's customer
    const idorRes = await fetch(`${BASE_URL}/stores/${storeA.storeId}/customers/${profile1.customerId}`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    const test4Passed = idorRes.status === 403;

    if (test4Passed) {
      logTest('BOLA / IDOR Protection: Cross-store customer inspection rejected with HTTP 403', true);
      passed++;
    } else {
      logTest('BOLA / IDOR Protection: Cross-store customer inspection rejected with HTTP 403', false, `Status: ${idorRes.status}`);
      failed++;
    }

    // Test 5: GET /api/v1/customers/me/stores returns customer's participating stores
    const myStoresRes = await fetch(`${BASE_URL}/customers/me/stores?page=1&pageSize=10`, {
      headers: { Authorization: `Bearer ${tokenCust1}` },
    });
    const myStoresBody: any = await myStoresRes.json();

    const test5Passed =
      myStoresRes.status === 200 &&
      myStoresBody.success === true &&
      Array.isArray(myStoresBody.data) &&
      myStoresBody.data.length === 2 &&
      myStoresBody.data.some((s: any) => s.storeId === storeA.storeId.toString()) &&
      myStoresBody.data.some((s: any) => s.storeId === storeB.storeId.toString());

    if (test5Passed) {
      logTest('GET /customers/me/stores returns stores customer has transacted with and canonical pagination', true);
      passed++;
    } else {
      logTest('GET /customers/me/stores returns stores customer has transacted with', false, JSON.stringify(myStoresBody));
      failed++;
    }
  } catch (err: any) {
    console.error('Fatal error during suite:', err);
    failed++;
  } finally {
    // Teardown
    try {
      if (testOrder) {
        await prisma.order.deleteMany({ where: { orderId: testOrder.orderId } });
      }
      if (scA1) await prisma.storeCustomer.deleteMany({ where: { storeCustomerId: scA1.storeCustomerId } });
      if (scA2) await prisma.storeCustomer.deleteMany({ where: { storeCustomerId: scA2.storeCustomerId } });
      if (scB1) await prisma.storeCustomer.deleteMany({ where: { storeCustomerId: scB1.storeCustomerId } });
      if (profile1) await prisma.customerProfile.deleteMany({ where: { customerId: profile1.customerId } });
      if (profile2) await prisma.customerProfile.deleteMany({ where: { customerId: profile2.customerId } });
      if (userCust1) await prisma.user.deleteMany({ where: { userId: userCust1.userId } });
      if (userCust2) await prisma.user.deleteMany({ where: { userId: userCust2.userId } });
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
  runStoreCustomersSuite();
}

export { runStoreCustomersSuite };
