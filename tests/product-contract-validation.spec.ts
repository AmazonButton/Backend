import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000/api/v1';

function logTest(name: string, passed: boolean, detail?: string) {
  if (passed) {
    console.log(`\x1b[32m  ✔ [PASS]\x1b[0m ${name}`);
  } else {
    console.log(`\x1b[31m  ✖ [FAIL]\x1b[0m ${name}${detail ? ` -> ${detail}` : ''}`);
  }
}

async function runProductContractValidationSuite() {
  console.log('\n========================================================================');
  console.log('🚀 SUITE: PRODUCT CONTRACT & CATEGORY OWNERSHIP VALIDATION TEST');
  console.log('========================================================================\n');

  let passed = 0;
  let failed = 0;

  let storeOwnerToken = '';
  let ownerUser: any = null;
  let testStoreA: any = null;
  let testStoreB: any = null;
  let testCategoryA: any = null;
  let testCategoryB: any = null;
  const createdProductIds: bigint[] = [];

  try {
    // 0. Setup test stores and owner
    const ownerEmail = `owner_contract_${Date.now()}@smartorder.test`;
    ownerUser = await prisma.user.create({
      data: {
        username: `owner_${Date.now()}`,
        email: ownerEmail,
        passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$fakehashfakehashfakehashfakehashfakehash',
        phone: `0987${Math.floor(Math.random() * 1000000).toString().padStart(6, '0')}`,
        fullName: 'Store Owner Contract Test',
        status: 'ACTIVE',
      },
    });

    testStoreA = await prisma.store.create({
      data: {
        name: 'Store A Contract Test',
        code: `STR-A-${Date.now()}`,
        phone: '0912345671',
        address: '123 Đường Test, Quận 1, TP.HCM',
        status: 'ACTIVE',
        ownerUserId: ownerUser.userId,
      },
    });

    testStoreB = await prisma.store.create({
      data: {
        name: 'Store B Contract Test',
        code: `STR-B-${Date.now()}`,
        phone: '0912345672',
        address: '456 Đường Test, Quận 2, TP.HCM',
        status: 'ACTIVE',
        ownerUserId: ownerUser.userId,
      },
    });

    // Create active store subscription for testStoreA to list products
    const plan = await prisma.subscriptionPlan.findFirst({ where: { isActive: true } });
    if (plan) {
      await prisma.storeSubscription.create({
        data: {
          storeId: testStoreA.storeId,
          planId: plan.planId,
          startDate: new Date(),
          endDate: new Date(Date.now() + 30 * 24 * 3600 * 1000),
          status: 'ACTIVE',
        },
      });
    }

    // Create Category in Store A
    testCategoryA = await prisma.category.create({
      data: {
        storeId: testStoreA.storeId,
        categoryName: 'Category In Store A',
        status: 'ACTIVE',
      },
    });

    // Create Category in Store B
    testCategoryB = await prisma.category.create({
      data: {
        storeId: testStoreB.storeId,
        categoryName: 'Category In Store B',
        status: 'ACTIVE',
      },
    });

    // Login Store Owner
    const jwt = require('jsonwebtoken');
    const jwtSecret = process.env.JWT_SECRET || 'test_super_secret_jwt_key_32_bytes_len_safe!';
    storeOwnerToken = jwt.sign(
      {
        userId: ownerUser.userId.toString(),
        sub: ownerUser.userId.toString(),
        email: ownerUser.email,
        role: 'STORE_OWNER',
        storeId: testStoreA.storeId.toString(),
      },
      jwtSecret,
      { expiresIn: '1h' },
    );

    // -------------------------------------------------------------------------
    // Test 1: Create Product with categoryId and WITHOUT unit (should SUCCEED)
    // -------------------------------------------------------------------------
    const validProductPayload = {
      name: 'Contract Valid Product Without Unit',
      sku: `SKU-VAL-${Date.now()}`,
      categoryId: testCategoryA.categoryId.toString(),
      price: 120000,
      stock: 50,
      brand: 'TestBrand',
      description: 'Product test without unit field',
    };

    const resValid = await fetch(`${BASE_URL}/products`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${storeOwnerToken}`,
      },
      body: JSON.stringify(validProductPayload),
    });

    const bodyValid = (await resValid.json()) as any;
    const isSuccessValid = (resValid.status === 200 || resValid.status === 201) && bodyValid.data?.id;

    if (isSuccessValid) {
      logTest('1.1 Product DTO: Create product with categoryId and no unit succeeded (200/201)', true);
      passed++;
      createdProductIds.push(BigInt(bodyValid.data.id));
    } else {
      logTest('1.1 Product DTO: Create product with categoryId and no unit succeeded', false, `status=${resValid.status}, body=${JSON.stringify(bodyValid)}`);
      failed++;
    }

    // -------------------------------------------------------------------------
    // Test 2: Create Product referencing Category of ANOTHER Store (should FAIL with 400)
    // -------------------------------------------------------------------------
    const crossStorePayload = {
      name: 'Cross-Store Category Hack Product',
      sku: `SKU-CROSS-${Date.now()}`,
      categoryId: testCategoryB.categoryId.toString(), // Category of Store B!
      price: 150000,
      brand: 'CrossBrand',
    };

    const resCross = await fetch(`${BASE_URL}/products`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${storeOwnerToken}`,
      },
      body: JSON.stringify(crossStorePayload),
    });

    const bodyCross = (await resCross.json()) as any;
    if (resCross.status === 400 && bodyCross.success === false) {
      logTest('1.2 Category Ownership Guard: Cross-store categoryId rejected with 400 Bad Request', true);
      passed++;
    } else {
      logTest('1.2 Category Ownership Guard: Cross-store categoryId rejected with 400', false, `status=${resCross.status}, body=${JSON.stringify(bodyCross)}`);
      failed++;
      if (bodyCross.data?.id) createdProductIds.push(BigInt(bodyCross.data.id));
    }

  } catch (err: any) {
    console.error('Unexpected test error:', err);
    failed++;
  } finally {
    console.log('\n🧹 Cleaning up test fixtures...');
    for (const pid of createdProductIds) {
      await prisma.inventory.deleteMany({ where: { productId: pid } });
      await prisma.product.deleteMany({ where: { productId: pid } });
    }
    if (testCategoryA) await prisma.category.deleteMany({ where: { categoryId: testCategoryA.categoryId } });
    if (testCategoryB) await prisma.category.deleteMany({ where: { categoryId: testCategoryB.categoryId } });
    if (testStoreA) {
      await prisma.storeSubscription.deleteMany({ where: { storeId: testStoreA.storeId } });
      await prisma.store.deleteMany({ where: { storeId: testStoreA.storeId } });
    }
    if (testStoreB) await prisma.store.deleteMany({ where: { storeId: testStoreB.storeId } });
    if (ownerUser) await prisma.user.deleteMany({ where: { userId: ownerUser.userId } });
    await prisma.$disconnect();
    console.log('Cleanup complete.');
  }

  console.log('\n========================================================================');
  console.log(`📊 SUMMARY: PASSED: ${passed} | FAILED: ${failed}`);
  console.log('========================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runProductContractValidationSuite();
