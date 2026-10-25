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

async function runCategoriesManagementSuite() {
  console.log('\n========================================================================');
  console.log('🚀 SUITE: CATEGORIES HIERARCHY, CYCLE DETECTION & TENANT ISOLATION');
  console.log('========================================================================\n');

  let passed = 0;
  let failed = 0;

  let ownerUserA: any = null;
  let storeA: any = null;
  let tokenA = '';

  let ownerUserB: any = null;
  let storeB: any = null;
  let tokenB = '';

  let cat1: any = null;
  let cat2: any = null;
  let cat3: any = null;

  try {
    const jwtSecret = process.env.JWT_SECRET || 'test_super_secret_jwt_key_32_bytes_len_safe!';

    // Setup Store A and Owner A
    ownerUserA = await prisma.user.create({
      data: {
        username: `cat_owner_a_${Date.now()}`,
        email: `cat_owner_a_${Date.now()}@test.com`,
        phone: `0963${Math.floor(Math.random() * 1000000).toString().padStart(6, '0')}`,
        fullName: 'Category Test Owner A',
        status: 'ACTIVE',
      },
    });

    storeA = await prisma.store.create({
      data: {
        name: 'Category Test Store A',
        code: `STORE-CAT-A-${Date.now()}`,
        phone: '0901234567',
        address: '123 Store A St',
        ownerUserId: ownerUserA.userId,
        status: 'ACTIVE',
      },
    });

    tokenA = jwt.sign(
      {
        userId: ownerUserA.userId.toString(),
        sub: ownerUserA.userId.toString(),
        email: ownerUserA.email,
        role: 'STORE_OWNER',
        storeId: storeA.storeId.toString(),
      },
      jwtSecret,
      { expiresIn: '1h' },
    );

    // Setup Store B and Owner B
    ownerUserB = await prisma.user.create({
      data: {
        username: `cat_owner_b_${Date.now()}`,
        email: `cat_owner_b_${Date.now()}@test.com`,
        phone: `0964${Math.floor(Math.random() * 1000000).toString().padStart(6, '0')}`,
        fullName: 'Category Test Owner B',
        status: 'ACTIVE',
      },
    });

    storeB = await prisma.store.create({
      data: {
        name: 'Category Test Store B',
        code: `STORE-CAT-B-${Date.now()}`,
        phone: '0901234568',
        address: '456 Store B St',
        ownerUserId: ownerUserB.userId,
        status: 'ACTIVE',
      },
    });

    tokenB = jwt.sign(
      {
        userId: ownerUserB.userId.toString(),
        sub: ownerUserB.userId.toString(),
        email: ownerUserB.email,
        role: 'STORE_OWNER',
        storeId: storeB.storeId.toString(),
      },
      jwtSecret,
      { expiresIn: '1h' },
    );

    // -------------------------------------------------------------------------
    // Test 1: POST /stores/:storeId/categories creates root and child categories
    // -------------------------------------------------------------------------
    const res1 = await fetch(`${BASE_URL}/stores/${storeA.storeId}/categories`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({ categoryName: 'Điện tử' }),
    });
    const body1 = (await res1.json()) as any;
    cat1 = body1.data;

    const res2 = await fetch(`${BASE_URL}/stores/${storeA.storeId}/categories`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({
        categoryName: 'Điện thoại',
        parentCategoryId: cat1.categoryId,
      }),
    });
    const body2 = (await res2.json()) as any;
    cat2 = body2.data;

    if (
      res1.status === 201 &&
      res2.status === 201 &&
      cat1?.categoryId &&
      cat2?.parentCategoryId === cat1.categoryId
    ) {
      logTest('Test 1: POST /stores/:storeId/categories creates root and hierarchical child category', true);
      passed++;
    } else {
      logTest(
        'Test 1: POST /stores/:storeId/categories creates root and hierarchical child category',
        false,
        `Res1: ${res1.status}, Res2: ${res2.status}`,
      );
      failed++;
    }

    // -------------------------------------------------------------------------
    // Test 2: Cross-store Access Guard - Owner B cannot create category in Store A
    // -------------------------------------------------------------------------
    const crossStoreRes = await fetch(`${BASE_URL}/stores/${storeA.storeId}/categories`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenB}`,
      },
      body: JSON.stringify({ categoryName: 'Illegal Cross Category' }),
    });

    if (crossStoreRes.status === 403) {
      logTest('Test 2: Cross-store tenant guard blocks unauthorized user from creating category (403)', true);
      passed++;
    } else {
      logTest(
        'Test 2: Cross-store tenant guard blocks unauthorized user',
        false,
        `Status: ${crossStoreRes.status}`,
      );
      failed++;
    }

    // -------------------------------------------------------------------------
    // Test 3: Tree Retrieval - GET /stores/:storeId/categories?mode=tree
    // -------------------------------------------------------------------------
    const treeRes = await fetch(`${BASE_URL}/stores/${storeA.storeId}/categories?mode=tree`);
    const treeBody = (await treeRes.json()) as any;

    const rootFound = treeBody.data?.find((c: any) => c.categoryId === cat1.categoryId);
    const childFound = rootFound?.subCategories?.find((c: any) => c.categoryId === cat2.categoryId);

    if (treeRes.status === 200 && rootFound && childFound) {
      logTest('Test 3: GET /stores/:storeId/categories?mode=tree returns nested hierarchical category tree', true);
      passed++;
    } else {
      logTest(
        'Test 3: GET /stores/:storeId/categories?mode=tree returns nested hierarchical category tree',
        false,
        `Status: ${treeRes.status}, body: ${JSON.stringify(treeBody)}`,
      );
      failed++;
    }

    // -------------------------------------------------------------------------
    // Test 4: Self-parent rejection - Cat 1 cannot be parent of Cat 1
    // -------------------------------------------------------------------------
    const selfParentRes = await fetch(`${BASE_URL}/categories/${cat1.categoryId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({ parentCategoryId: cat1.categoryId }),
    });

    if (selfParentRes.status === 400) {
      logTest('Test 4: PATCH /categories/:id rejects self as parent (400)', true);
      passed++;
    } else {
      logTest('Test 4: PATCH /categories/:id rejects self as parent', false, `Status: ${selfParentRes.status}`);
      failed++;
    }

    // -------------------------------------------------------------------------
    // Test 5: Cycle Detection - Reject circular loop (Cat1 -> Cat2 -> Cat3 -> Cat1)
    // -------------------------------------------------------------------------
    // Create Cat 3 (child of Cat 2)
    const res3 = await fetch(`${BASE_URL}/stores/${storeA.storeId}/categories`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({
        categoryName: 'Điện thoại thông minh',
        parentCategoryId: cat2.categoryId,
      }),
    });
    cat3 = ((await res3.json()) as any).data;

    // Now try to set Cat 1's parent to Cat 3!
    const cycleRes = await fetch(`${BASE_URL}/categories/${cat1.categoryId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({ parentCategoryId: cat3.categoryId }),
    });
    const cycleBody = (await cycleRes.json()) as any;

    const cycleRejected =
      cycleRes.status === 400 &&
      (cycleBody.message?.includes('vòng lặp') || cycleBody.message?.includes('cycle'));

    if (cycleRejected) {
      logTest('Test 5: PATCH /categories/:id detects and rejects hierarchical circular loops (400)', true);
      passed++;
    } else {
      logTest(
        'Test 5: PATCH /categories/:id detects and rejects hierarchical circular loops',
        false,
        `Status: ${cycleRes.status}, body: ${JSON.stringify(cycleBody)}`,
      );
      failed++;
    }

    // -------------------------------------------------------------------------
    // Test 6: Cross-store Parent Rejection
    // -------------------------------------------------------------------------
    const crossParentRes = await fetch(`${BASE_URL}/stores/${storeB.storeId}/categories`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenB}`,
      },
      body: JSON.stringify({
        categoryName: 'Store B Category',
        parentCategoryId: cat1.categoryId, // Belongs to Store A!
      }),
    });

    if (crossParentRes.status === 400) {
      logTest('Test 6: Cross-store parent category reference is rejected with HTTP 400', true);
      passed++;
    } else {
      logTest(
        'Test 6: Cross-store parent category reference is rejected',
        false,
        `Status: ${crossParentRes.status}`,
      );
      failed++;
    }

    // -------------------------------------------------------------------------
    // Test 7: Soft-delete Category
    // -------------------------------------------------------------------------
    const delRes = await fetch(`${BASE_URL}/categories/${cat3.categoryId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tokenA}` },
    });

    const getAfterDel = await prisma.category.findUnique({
      where: { categoryId: BigInt(cat3.categoryId) },
    });

    if (delRes.status === 200 && getAfterDel?.status === 'INACTIVE') {
      logTest('Test 7: DELETE /categories/:id performs soft-delete setting status to INACTIVE', true);
      passed++;
    } else {
      logTest(
        'Test 7: DELETE /categories/:id performs soft-delete',
        false,
        `Status: ${delRes.status}, DB status: ${getAfterDel?.status}`,
      );
      failed++;
    }
  } catch (err: any) {
    console.error('Categories test error:', err);
    failed++;
  } finally {
    // Cleanup
    try {
      if (storeA) {
        await prisma.category.deleteMany({ where: { storeId: storeA.storeId } });
        await prisma.store.deleteMany({ where: { storeId: storeA.storeId } });
      }
      if (ownerUserA) {
        await prisma.user.deleteMany({ where: { userId: ownerUserA.userId } });
      }
      if (storeB) {
        await prisma.category.deleteMany({ where: { storeId: storeB.storeId } });
        await prisma.store.deleteMany({ where: { storeId: storeB.storeId } });
      }
      if (ownerUserB) {
        await prisma.user.deleteMany({ where: { userId: ownerUserB.userId } });
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

runCategoriesManagementSuite();
