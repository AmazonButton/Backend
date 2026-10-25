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

async function runPriceHistoryAndInventorySuite() {
  console.log('\n========================================================================');
  console.log('🚀 SUITE: PRICE HISTORY & INVENTORY READ VIEWS (TASK 4.2)');
  console.log('========================================================================\n');

  let passed = 0;
  let failed = 0;

  let ownerA: any = null;
  let storeA: any = null;
  let tokenA = '';

  let ownerB: any = null;
  let storeB: any = null;
  let tokenB = '';

  let testProduct: any = null;

  try {
    const jwtSecret = process.env.JWT_SECRET || 'smart_order_button_super_secret_jwt_key_2026_prod';

    // 1. Setup Store A & Owner A
    ownerA = await prisma.user.create({
      data: {
        username: `price_owner_a_${Date.now()}`,
        fullName: 'Store A Owner',
        email: `owner_a_${Date.now()}@test.com`,
        status: 'ACTIVE',
      },
    });

    storeA = await prisma.store.create({
      data: {
        name: `Price Store A ${Date.now()}`,
        code: `STR_A_${Date.now().toString().slice(-6)}`,
        phone: '0901234567',
        ownerUserId: ownerA.userId,
        status: 'ACTIVE',
        address: '123 Store A Road',
      },
    });

    const plan = await prisma.subscriptionPlan.upsert({
      where: { planCode: 'PLAN-TEST-BASIC' },
      update: { isActive: true },
      create: {
        planCode: 'PLAN-TEST-BASIC',
        planName: 'Gói Cơ Bản Test',
        description: 'Gói cơ bản cho cửa hàng',
        price: 99000,
        durationDays: 30,
        maxProducts: 50,
        isActive: true,
      },
    });

    const now = new Date();
    const future = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    await prisma.storeSubscription.create({
      data: {
        storeId: storeA.storeId,
        planId: plan.planId,
        startDate: now,
        endDate: future,
        status: 'ACTIVE',
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
        username: `price_owner_b_${Date.now()}`,
        fullName: 'Store B Owner',
        email: `owner_b_${Date.now()}@test.com`,
        status: 'ACTIVE',
      },
    });

    storeB = await prisma.store.create({
      data: {
        name: `Price Store B ${Date.now()}`,
        code: `STR_B_${Date.now().toString().slice(-6)}`,
        phone: '0907654321',
        ownerUserId: ownerB.userId,
        status: 'ACTIVE',
        address: '456 Store B Road',
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

    // 3. Create test product in Store A via API
    const createProdRes = await fetch(`${BASE_URL}/products`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({
        name: 'Trà Sữa Khoai Môn',
        productName: 'Trà Sữa Khoai Môn',
        price: 50000,
        basePrice: 50000,
        stock: 3, // stock 3 <= minStockAlert 5
        brand: 'Antigravity Tea',
      }),
    });

    const createProdBody: any = await createProdRes.json();
    if (!createProdBody.data) {
      throw new Error(`Failed to create product: ${JSON.stringify(createProdBody)}`);
    }
    testProduct = createProdBody.data;

    // Test 1: Price Patch records price history
    const update1 = await fetch(`${BASE_URL}/products/${testProduct.productId || testProduct.id}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({
        productName: 'Trà Sữa Khoai Môn Đặc Biệt',
        basePrice: 60000,
      }),
    });
    const update1Body: any = await update1.json();

    const update2 = await fetch(`${BASE_URL}/products/${testProduct.productId || testProduct.id}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({
        productName: 'Trà Sữa Khoai Môn Thượng Hạng',
        basePrice: 75000,
      }),
    });
    const update2Body: any = await update2.json();

    const test1Passed = update1.status === 200 && update2.status === 200;
    if (test1Passed) {
      logTest('PUT /products/:id updates price and triggers history logging', true);
      passed++;
    } else {
      logTest('PUT /products/:id updates price and triggers history logging', false, `Status: ${update1.status}, ${update2.status}`);
      failed++;
    }

    // Test 2: GET /products/:id/price-history
    const histRes = await fetch(`${BASE_URL}/products/${testProduct.productId || testProduct.id}/price-history?page=1&pageSize=10`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    const histBody: any = await histRes.json();

    const test2Passed =
      histRes.status === 200 &&
      histBody.success === true &&
      Array.isArray(histBody.data) &&
      histBody.data.length >= 2 &&
      histBody.data[0].newPrice === 75000 &&
      histBody.data[0].oldPrice === 60000 &&
      histBody.data[1].newPrice === 60000 &&
      histBody.data[1].oldPrice === 50000 &&
      histBody.pagination?.totalItems >= 2;

    if (test2Passed) {
      logTest('GET /products/:id/price-history returns chronologically descending history with pagination', true);
      passed++;
    } else {
      logTest('GET /products/:id/price-history returns chronologically descending history with pagination', false, JSON.stringify(histBody));
      failed++;
    }

    // Test 3: GET /stores/:storeId/inventory
    const invRes = await fetch(`${BASE_URL}/stores/${storeA.storeId}/inventory?page=1&pageSize=10`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    const invBody: any = await invRes.json();

    const test3Passed =
      invRes.status === 200 &&
      invBody.success === true &&
      Array.isArray(invBody.data) &&
      invBody.data.some((item: any) => item.productId === (testProduct.productId || testProduct.id).toString() && item.isLowStock === true);

    if (test3Passed) {
      logTest('GET /stores/:storeId/inventory returns stock levels and computes isLowStock', true);
      passed++;
    } else {
      logTest('GET /stores/:storeId/inventory returns stock levels and computes isLowStock', false, JSON.stringify(invBody));
      failed++;
    }

    // Test 4: GET /stores/:storeId/inventory/low-stock filters only low stock products
    const lowRes = await fetch(`${BASE_URL}/stores/${storeA.storeId}/inventory/low-stock?page=1&pageSize=10`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    const lowBody: any = await lowRes.json();

    const test4Passed =
      lowRes.status === 200 &&
      lowBody.success === true &&
      Array.isArray(lowBody.data) &&
      lowBody.data.some((item: any) => item.productId === (testProduct.productId || testProduct.id).toString());

    if (test4Passed) {
      logTest('GET /stores/:storeId/inventory/low-stock correctly filters low-stock items (stock <= minAlert)', true);
      passed++;
    } else {
      logTest('GET /stores/:storeId/inventory/low-stock correctly filters low-stock items', false, JSON.stringify(lowBody));
      failed++;
    }

    // Test 5: Replenish stock via PATCH /products/:id/inventory
    const patchInv = await fetch(`${BASE_URL}/products/${testProduct.productId || testProduct.id}/inventory`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({
        availableStock: 50,
      }),
    });
    const patchInvBody: any = await patchInv.json();
    const test5Passed = patchInv.status === 200 && patchInvBody.success === true;

    if (test5Passed) {
      logTest('PATCH /products/:id/inventory restocks item quantity', true);
      passed++;
    } else {
      logTest('PATCH /products/:id/inventory restocks item quantity', false, JSON.stringify(patchInvBody));
      failed++;
    }

    // Test 6: Verify replenished product is NO LONGER in low-stock endpoint
    const lowResAfter = await fetch(`${BASE_URL}/stores/${storeA.storeId}/inventory/low-stock?page=1&pageSize=10`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    const lowBodyAfter: any = await lowResAfter.json();

    const test6Passed =
      lowResAfter.status === 200 &&
      lowBodyAfter.success === true &&
      !lowBodyAfter.data.some((item: any) => item.productId === (testProduct.productId || testProduct.id).toString());

    if (test6Passed) {
      logTest('Replenished product (stock > minAlert) disappears from low-stock view', true);
      passed++;
    } else {
      logTest('Replenished product disappears from low-stock view', false, JSON.stringify(lowBodyAfter));
      failed++;
    }

    // Test 7: BOLA / IDOR protection: Store Owner B accessing Store A inventory is rejected
    const idorRes = await fetch(`${BASE_URL}/stores/${storeA.storeId}/inventory`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    const idorBody: any = await idorRes.json();

    const test7Passed = idorRes.status === 403;
    if (test7Passed) {
      logTest('BOLA / IDOR Protection: Cross-store inventory inspection rejected with HTTP 403', true);
      passed++;
    } else {
      logTest('BOLA / IDOR Protection: Cross-store inventory inspection rejected with HTTP 403', false, `Status: ${idorRes.status}`);
      failed++;
    }
  } catch (err: any) {
    console.error('Fatal error during suite:', err);
    failed++;
  } finally {
    // Teardown
    try {
      if (testProduct) {
        const prodId = BigInt(testProduct.productId || testProduct.id);
        await prisma.productPriceHistory.deleteMany({ where: { productId: prodId } });
        await prisma.inventory.deleteMany({ where: { productId: prodId } });
        await prisma.product.deleteMany({ where: { productId: prodId } });
      }
      if (storeA) {
        await prisma.storeSubscription.deleteMany({ where: { storeId: storeA.storeId } });
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
  runPriceHistoryAndInventorySuite();
}

export { runPriceHistoryAndInventorySuite };
