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

async function runSubscriptionCatalogHistorySuite() {
  console.log('\n========================================================================');
  console.log('🚀 SUITE: SUBSCRIPTION CATALOG, STORE HISTORY & BOLA PROTECTION');
  console.log('========================================================================\n');

  let passed = 0;
  let failed = 0;

  let ownerA: any = null;
  let storeA: any = null;
  let tokenA = '';

  let ownerB: any = null;
  let storeB: any = null;
  let tokenB = '';

  let plan1: any = null;
  let plan2: any = null;
  let subA: any = null;

  try {
    const jwtSecret = process.env.JWT_SECRET || 'smart_order_button_super_secret_jwt_key_2026_prod';

    // Ensure plans exist
    plan1 = await prisma.subscriptionPlan.upsert({
      where: { planCode: 'PLAN-TEST-BASIC' },
      update: { isActive: true },
      create: {
        planCode: 'PLAN-TEST-BASIC',
        planName: 'Gói Cơ Bản Test',
        description: 'Gói dành cho gian hàng nhỏ',
        price: 99000,
        durationDays: 30,
        maxProducts: 20,
        isActive: true,
      },
    });

    plan2 = await prisma.subscriptionPlan.upsert({
      where: { planCode: 'PLAN-TEST-PRO' },
      update: { isActive: true },
      create: {
        planCode: 'PLAN-TEST-PRO',
        planName: 'Gói Chuyên Nghiệp Test',
        description: 'Gói không giới hạn',
        price: 299000,
        durationDays: 90,
        maxProducts: 100,
        isActive: true,
      },
    });

    // Create Store A
    ownerA = await prisma.user.create({
      data: {
        username: `sub_owner_a_${Date.now()}`,
        email: `sub_owner_a_${Date.now()}@test.com`,
        phone: `0977${Math.floor(Math.random() * 1000000).toString().padStart(6, '0')}`,
        fullName: 'Subscription Owner A',
        status: 'ACTIVE',
      },
    });

    storeA = await prisma.store.create({
      data: {
        name: 'Subscription Test Store A',
        code: `STORE-SUB-A-${Date.now()}`,
        phone: '0901234567',
        address: '123 Sub St A',
        ownerUserId: ownerA.userId,
        status: 'ACTIVE',
      },
    });

    tokenA = jwt.sign(
      {
        userId: ownerA.userId.toString(),
        sub: ownerA.userId.toString(),
        email: ownerA.email,
        role: 'STORE_OWNER',
        storeId: storeA.storeId.toString(),
      },
      jwtSecret,
      { expiresIn: '1h' },
    );

    // Create Store B for BOLA
    ownerB = await prisma.user.create({
      data: {
        username: `sub_owner_b_${Date.now()}`,
        email: `sub_owner_b_${Date.now()}@test.com`,
        phone: `0978${Math.floor(Math.random() * 1000000).toString().padStart(6, '0')}`,
        fullName: 'Subscription Owner B',
        status: 'ACTIVE',
      },
    });

    storeB = await prisma.store.create({
      data: {
        name: 'Subscription Test Store B',
        code: `STORE-SUB-B-${Date.now()}`,
        phone: '0907654321',
        address: '456 Sub St B',
        ownerUserId: ownerB.userId,
        status: 'ACTIVE',
      },
    });

    tokenB = jwt.sign(
      {
        userId: ownerB.userId.toString(),
        sub: ownerB.userId.toString(),
        email: ownerB.email,
        role: 'STORE_OWNER',
        storeId: storeB.storeId.toString(),
      },
      jwtSecret,
      { expiresIn: '1h' },
    );

    // Create active subscription for Store A
    const now = new Date();
    const future = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    subA = await prisma.storeSubscription.create({
      data: {
        storeId: storeA.storeId,
        planId: plan1.planId,
        startDate: now,
        endDate: future,
        status: 'ACTIVE',
        paymentMethod: 'WALLET',
      },
    });

    // Test 1: GET /subscription-plans (Public catalog)
    try {
      const res = await fetch(`${BASE_URL}/subscription-plans`);
      const body = await res.json();

      if (
        res.status === 200 &&
        body.success === true &&
        Array.isArray(body.data) &&
        body.data.length >= 2 &&
        body.data.some((p: any) => p.planCode === 'PLAN-TEST-BASIC')
      ) {
        logTest('GET /subscription-plans returns active catalog for public browsing', true);
        passed++;
      } else {
        logTest('GET /subscription-plans returns active catalog for public browsing', false, JSON.stringify(body));
        failed++;
      }
    } catch (err: any) {
      logTest('GET /subscription-plans returns active catalog for public browsing', false, err.message);
      failed++;
    }

    // Test 2: GET /store/subscriptions returns paginated history with canonical envelope
    try {
      const res = await fetch(`${BASE_URL}/store/subscriptions?page=1&pageSize=20`, {
        headers: { Authorization: `Bearer ${tokenA}` },
      });
      const body = await res.json();

      if (
        res.status === 200 &&
        body.success === true &&
        Array.isArray(body.data) &&
        body.data.length >= 1 &&
        body.pagination !== undefined &&
        body.pagination.totalItems >= 1 &&
        body.data[0].plan !== undefined
      ) {
        logTest('GET /store/subscriptions returns paginated history with canonical envelope', true);
        passed++;
      } else {
        logTest('GET /store/subscriptions returns paginated history with canonical envelope', false, JSON.stringify(body));
        failed++;
      }
    } catch (err: any) {
      logTest('GET /store/subscriptions returns paginated history with canonical envelope', false, err.message);
      failed++;
    }

    // Test 3: GET /store/subscriptions/current returns active subscription
    try {
      const res = await fetch(`${BASE_URL}/store/subscriptions/current`, {
        headers: { Authorization: `Bearer ${tokenA}` },
      });
      const body = await res.json();

      if (
        res.status === 200 &&
        body.success === true &&
        body.data !== null &&
        String(body.data.subscriptionId) === subA.subscriptionId.toString()
      ) {
        logTest('GET /store/subscriptions/current returns active store subscription', true);
        passed++;
      } else {
        logTest('GET /store/subscriptions/current returns active store subscription', false, JSON.stringify(body));
        failed++;
      }
    } catch (err: any) {
      logTest('GET /store/subscriptions/current returns active store subscription', false, err.message);
      failed++;
    }

    // Test 4: GET /store/subscriptions/:id returns subscription detail
    try {
      const res = await fetch(`${BASE_URL}/store/subscriptions/${subA.subscriptionId}`, {
        headers: { Authorization: `Bearer ${tokenA}` },
      });
      const body = await res.json();

      if (
        res.status === 200 &&
        body.success === true &&
        body.data.subscriptionId === subA.subscriptionId.toString() &&
        body.data.plan.planCode === 'PLAN-TEST-BASIC'
      ) {
        logTest('GET /store/subscriptions/:id returns subscription detail', true);
        passed++;
      } else {
        logTest('GET /store/subscriptions/:id returns subscription detail', false, JSON.stringify(body));
        failed++;
      }
    } catch (err: any) {
      logTest('GET /store/subscriptions/:id returns subscription detail', false, err.message);
      failed++;
    }

    // Test 5: BOLA: Store B cannot access Store A's subscription
    try {
      const res = await fetch(`${BASE_URL}/store/subscriptions/${subA.subscriptionId}`, {
        headers: { Authorization: `Bearer ${tokenB}` },
      });
      const body = await res.json();

      if (res.status === 404 && body.success === false) {
        logTest('BOLA: Store B cannot access Store A subscription detail (404)', true);
        passed++;
      } else {
        logTest('BOLA: Store B cannot access Store A subscription detail (404)', false, `Status: ${res.status}`);
        failed++;
      }
    } catch (err: any) {
      logTest('BOLA: Store B cannot access Store A subscription detail (404)', false, err.message);
      failed++;
    }

    // Test 6: Unauthenticated access to /store/subscriptions returns 401
    try {
      const res = await fetch(`${BASE_URL}/store/subscriptions`);
      if (res.status === 401) {
        logTest('Unauthenticated access to /store/subscriptions returns 401', true);
        passed++;
      } else {
        logTest('Unauthenticated access to /store/subscriptions returns 401', false, `Status: ${res.status}`);
        failed++;
      }
    } catch (err: any) {
      logTest('Unauthenticated access to /store/subscriptions returns 401', false, err.message);
      failed++;
    }

  } finally {
    // Cleanup
    if (subA) {
      await prisma.subscriptionIdempotencyKey.deleteMany({ where: { subscriptionId: subA.subscriptionId } }).catch(() => {});
      await prisma.storeSubscription.delete({ where: { subscriptionId: subA.subscriptionId } }).catch(() => {});
    }
    if (storeA) {
      await prisma.store.delete({ where: { storeId: storeA.storeId } }).catch(() => {});
    }
    if (storeB) {
      await prisma.store.delete({ where: { storeId: storeB.storeId } }).catch(() => {});
    }
    if (ownerA) {
      await prisma.user.delete({ where: { userId: ownerA.userId } }).catch(() => {});
    }
    if (ownerB) {
      await prisma.user.delete({ where: { userId: ownerB.userId } }).catch(() => {});
    }
    await prisma.$disconnect();
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) {
    process.exit(1);
  }
}

runSubscriptionCatalogHistorySuite().catch((e) => {
  console.error(e);
  process.exit(1);
});
