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

async function runProductDiscountsSuite() {
  console.log('\n========================================================================');
  console.log('🚀 SUITE: PRODUCT DISCOUNTS CRUD, EXCLUSIVITY & OVERLAP VALIDATION');
  console.log('========================================================================\n');

  let passed = 0;
  let failed = 0;

  let ownerA: any = null;
  let storeA: any = null;
  let productA: any = null;
  let tokenA = '';

  let ownerB: any = null;
  let storeB: any = null;
  let tokenB = '';

  let discount1: any = null;
  let discount2: any = null;

  try {
    const jwtSecret = process.env.JWT_SECRET || 'test_super_secret_jwt_key_32_bytes_len_safe!';

    // Setup Store A & Product A
    ownerA = await prisma.user.create({
      data: {
        username: `disc_owner_a_${Date.now()}`,
        email: `disc_owner_a_${Date.now()}@test.com`,
        phone: `0965${Math.floor(Math.random() * 1000000).toString().padStart(6, '0')}`,
        fullName: 'Discount Owner A',
        status: 'ACTIVE',
      },
    });

    storeA = await prisma.store.create({
      data: {
        name: 'Discount Test Store A',
        code: `STORE-DISC-A-${Date.now()}`,
        phone: '0901234567',
        address: '123 Discount A St',
        ownerUserId: ownerA.userId,
        status: 'ACTIVE',
      },
    });

    productA = await prisma.product.create({
      data: {
        storeId: storeA.storeId,
        productCode: `PROD-DISC-${Date.now()}`,
        productName: 'Discounted Test Coffee',
        basePrice: 50000.0,
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

    // Setup Store B
    ownerB = await prisma.user.create({
      data: {
        username: `disc_owner_b_${Date.now()}`,
        email: `disc_owner_b_${Date.now()}@test.com`,
        phone: `0966${Math.floor(Math.random() * 1000000).toString().padStart(6, '0')}`,
        fullName: 'Discount Owner B',
        status: 'ACTIVE',
      },
    });

    storeB = await prisma.store.create({
      data: {
        name: 'Discount Test Store B',
        code: `STORE-DISC-B-${Date.now()}`,
        phone: '0901234568',
        address: '456 Discount B St',
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

    const now = new Date();
    const day1 = new Date(now.getTime() + 24 * 3600 * 1000).toISOString();
    const day7 = new Date(now.getTime() + 7 * 24 * 3600 * 1000).toISOString();
    const day10 = new Date(now.getTime() + 10 * 24 * 3600 * 1000).toISOString();

    // -------------------------------------------------------------------------
    // Test 1: POST /products/:productId/discounts creates discount with percent
    // -------------------------------------------------------------------------
    const createRes1 = await fetch(`${BASE_URL}/products/${productA.productId}/discounts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({
        discountPercent: 15,
        startAt: day1,
        endAt: day7,
      }),
    });
    const createBody1 = (await createRes1.json()) as any;
    discount1 = createBody1.data;

    if (createRes1.status === 201 && discount1?.discountId && Number(discount1.discountPercent) === 15) {
      logTest('Test 1: POST /products/:productId/discounts creates valid percentage discount', true);
      passed++;
    } else {
      logTest(
        'Test 1: POST /products/:productId/discounts creates valid percentage discount',
        false,
        `Status: ${createRes1.status}, body: ${JSON.stringify(createBody1)}`,
      );
      failed++;
    }

    // -------------------------------------------------------------------------
    // Test 2: Reject invalid mutual exclusivity (both or neither)
    // -------------------------------------------------------------------------
    const bothRes = await fetch(`${BASE_URL}/products/${productA.productId}/discounts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({
        discountPercent: 20,
        discountAmount: 10000,
        startAt: day7,
        endAt: day10,
      }),
    });

    const neitherRes = await fetch(`${BASE_URL}/products/${productA.productId}/discounts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({
        startAt: day7,
        endAt: day10,
      }),
    });

    if (bothRes.status === 400 && neitherRes.status === 400) {
      logTest('Test 2: Rejects invalid mutual exclusivity (both or neither discount value provided)', true);
      passed++;
    } else {
      logTest(
        'Test 2: Rejects invalid mutual exclusivity',
        false,
        `Both: ${bothRes.status}, Neither: ${neitherRes.status}`,
      );
      failed++;
    }

    // -------------------------------------------------------------------------
    // Test 3: Reject invalid time range (startAt >= endAt)
    // -------------------------------------------------------------------------
    const timeRes = await fetch(`${BASE_URL}/products/${productA.productId}/discounts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({
        discountPercent: 10,
        startAt: day7,
        endAt: day1, // end is earlier than start!
      }),
    });

    if (timeRes.status === 400) {
      logTest('Test 3: Rejects invalid time range (startAt >= endAt) with HTTP 400', true);
      passed++;
    } else {
      logTest('Test 3: Rejects invalid time range', false, `Status: ${timeRes.status}`);
      failed++;
    }

    // -------------------------------------------------------------------------
    // Test 4: Overlapping active interval rejection
    // -------------------------------------------------------------------------
    // Discount 1 is active from day1 to day7. Attempting day3 to day10 must be rejected.
    const day3 = new Date(now.getTime() + 3 * 24 * 3600 * 1000).toISOString();
    const overlapRes = await fetch(`${BASE_URL}/products/${productA.productId}/discounts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({
        discountAmount: 5000,
        startAt: day3,
        endAt: day10,
      }),
    });
    const overlapBody = (await overlapRes.json()) as any;

    if (overlapRes.status === 400 && overlapBody.message?.includes('trùng lặp')) {
      logTest('Test 4: Rejects overlapping active discount intervals for the same product (400)', true);
      passed++;
    } else {
      logTest(
        'Test 4: Rejects overlapping active discount intervals',
        false,
        `Status: ${overlapRes.status}, body: ${JSON.stringify(overlapBody)}`,
      );
      failed++;
    }

    // -------------------------------------------------------------------------
    // Test 5: Tenant Isolation - Store Owner B cannot manage Store A's discounts
    // -------------------------------------------------------------------------
    const day8 = new Date(now.getTime() + 8 * 24 * 3600 * 1000).toISOString();
    const day12 = new Date(now.getTime() + 12 * 24 * 3600 * 1000).toISOString();

    const crossRes = await fetch(`${BASE_URL}/products/${productA.productId}/discounts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenB}`,
      },
      body: JSON.stringify({
        discountPercent: 10,
        startAt: day8,
        endAt: day12,
      }),
    });

    if (crossRes.status === 403) {
      logTest('Test 5: Cross-store tenant isolation blocks unauthorized discount creation (403)', true);
      passed++;
    } else {
      logTest('Test 5: Cross-store tenant isolation blocks unauthorized discount creation', false, `Status: ${crossRes.status}`);
      failed++;
    }

    // -------------------------------------------------------------------------
    // Test 6: Non-overlapping discount succeeds & GET /products/:productId/discounts lists them
    // -------------------------------------------------------------------------
    const createRes2 = await fetch(`${BASE_URL}/products/${productA.productId}/discounts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({
        discountAmount: 10000,
        startAt: day8,
        endAt: day12,
      }),
    });
    const createBody2 = (await createRes2.json()) as any;
    discount2 = createBody2.data;

    const listRes = await fetch(`${BASE_URL}/products/${productA.productId}/discounts`);
    const listBody = (await listRes.json()) as any;

    if (
      createRes2.status === 201 &&
      listRes.status === 200 &&
      Array.isArray(listBody.data) &&
      listBody.data.length === 2
    ) {
      logTest('Test 6: Non-overlapping discount succeeds and GET /products/:id/discounts lists all', true);
      passed++;
    } else {
      logTest(
        'Test 6: Non-overlapping discount succeeds and lists all',
        false,
        `Create2: ${createRes2.status}, List: ${listRes.status}, count: ${listBody.data?.length}`,
      );
      failed++;
    }

    // -------------------------------------------------------------------------
    // Test 7: PATCH and DELETE discount
    // -------------------------------------------------------------------------
    const patchRes = await fetch(`${BASE_URL}/discounts/${discount2.discountId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({ discountAmount: 12000 }),
    });
    const patchBody = (await patchRes.json()) as any;

    const delRes = await fetch(`${BASE_URL}/discounts/${discount2.discountId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tokenA}` },
    });

    const getAfterDel = await prisma.productDiscount.findUnique({
      where: { discountId: BigInt(discount2.discountId) },
    });

    if (
      patchRes.status === 200 &&
      patchBody.data?.discountAmount === 12000 &&
      delRes.status === 200 &&
      !getAfterDel
    ) {
      logTest('Test 7: PATCH and DELETE /discounts/:id mutate and delete discount cleanly', true);
      passed++;
    } else {
      logTest(
        'Test 7: PATCH and DELETE /discounts/:id mutate and delete discount cleanly',
        false,
        `Patch: ${patchRes.status}, Del: ${delRes.status}, remaining: ${!!getAfterDel}`,
      );
      failed++;
    }
  } catch (err: any) {
    console.error('Product discounts test error:', err);
    failed++;
  } finally {
    // Cleanup
    try {
      if (productA) {
        await prisma.productDiscount.deleteMany({ where: { productId: productA.productId } });
        await prisma.inventory.deleteMany({ where: { productId: productA.productId } });
        await prisma.product.deleteMany({ where: { productId: productA.productId } });
      }
      if (storeA) {
        await prisma.store.deleteMany({ where: { storeId: storeA.storeId } });
      }
      if (ownerA) {
        await prisma.user.deleteMany({ where: { userId: ownerA.userId } });
      }
      if (storeB) {
        await prisma.store.deleteMany({ where: { storeId: storeB.storeId } });
      }
      if (ownerB) {
        await prisma.user.deleteMany({ where: { userId: ownerB.userId } });
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

runProductDiscountsSuite();
