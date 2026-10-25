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

async function runCanonicalPaginationEnvelopeSuite() {
  console.log('\n========================================================================');
  console.log('🚀 SUITE: CANONICAL PAGINATION ENVELOPE & QUERY CAPS TEST');
  console.log('========================================================================\n');

  let passed = 0;
  let failed = 0;

  let testDriverUser: any = null;
  let driverToken = '';

  try {
    // 0. Setup Driver User for Authenticated Pagination Endpoints
    testDriverUser = await prisma.user.create({
      data: {
        username: `driver_pag_${Date.now()}`,
        email: `driver_pag_${Date.now()}@smartorder.test`,
        passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$fakehashfakehashfakehashfakehashfakehash',
        phone: `0977${Math.floor(Math.random() * 1000000).toString().padStart(6, '0')}`,
        fullName: 'Test Driver Pagination',
        status: 'ACTIVE',
      },
    });

    const jwtSecret = process.env.JWT_SECRET || 'test_super_secret_jwt_key_32_bytes_len_safe!';
    driverToken = jwt.sign(
      {
        userId: testDriverUser.userId.toString(),
        sub: testDriverUser.userId.toString(),
        email: testDriverUser.email,
        role: 'STAFF_DELIVERY',
        storeId: '1',
      },
      jwtSecret,
      { expiresIn: '1h' },
    );

    // -------------------------------------------------------------------------
    // Test 1: GET /stores returns canonical pagination envelope
    // -------------------------------------------------------------------------
    const storesRes = await fetch(`${BASE_URL}/stores?page=1&pageSize=10`);
    const storesBody = (await storesRes.json()) as any;

    const hasPaginationKeys =
      storesBody.pagination &&
      typeof storesBody.pagination.page === 'number' &&
      typeof storesBody.pagination.pageSize === 'number' &&
      typeof storesBody.pagination.totalItems === 'number' &&
      typeof storesBody.pagination.totalPages === 'number' &&
      typeof storesBody.pagination.hasNextPage === 'boolean' &&
      typeof storesBody.pagination.hasPrevPage === 'boolean';

    const isArrayData = Array.isArray(storesBody.data);

    if (storesRes.status === 200 && isArrayData && hasPaginationKeys) {
      logTest('1.1 GET /stores: Returns uniform envelope with data array and canonical pagination', true);
      passed++;
    } else {
      logTest('1.1 GET /stores: Returns uniform envelope with data array and canonical pagination', false, `status=${storesRes.status}, body=${JSON.stringify(storesBody)}`);
      failed++;
    }

    // -------------------------------------------------------------------------
    // Test 2: GET /stores caps pageSize <= 100 (or rejects > 100)
    // -------------------------------------------------------------------------
    const cappedRes = await fetch(`${BASE_URL}/stores?pageSize=999`);
    const cappedBody = (await cappedRes.json()) as any;

    const isCappedOrRejected =
      (cappedRes.status === 400 && cappedBody.success === false) ||
      (cappedRes.status === 200 && cappedBody.pagination?.pageSize <= 100);

    if (isCappedOrRejected) {
      logTest('1.2 Query Cap: pageSize > 100 is capped <= 100 or rejected with 400 Bad Request', true);
      passed++;
    } else {
      logTest('1.2 Query Cap: pageSize > 100 is capped <= 100 or rejected with 400', false, `pageSize=${cappedBody.pagination?.pageSize}`);
      failed++;
    }

    // -------------------------------------------------------------------------
    // Test 3: GET /driver-shifts/history returns canonical pagination envelope
    // -------------------------------------------------------------------------
    const shiftsRes = await fetch(`${BASE_URL}/driver-shifts/history?page=1&pageSize=10`, {
      headers: { Authorization: `Bearer ${driverToken}` },
    });
    const shiftsBody = (await shiftsRes.json()) as any;

    const shiftsPaginationValid =
      shiftsBody.pagination &&
      typeof shiftsBody.pagination.page === 'number' &&
      typeof shiftsBody.pagination.pageSize === 'number' &&
      typeof shiftsBody.pagination.totalItems === 'number' &&
      typeof shiftsBody.pagination.totalPages === 'number' &&
      typeof shiftsBody.pagination.hasNextPage === 'boolean' &&
      typeof shiftsBody.pagination.hasPrevPage === 'boolean' &&
      Array.isArray(shiftsBody.data);

    if (shiftsRes.status === 200 && shiftsPaginationValid) {
      logTest('1.3 GET /driver-shifts/history: Returns canonical pagination metadata and data array', true);
      passed++;
    } else {
      logTest('1.3 GET /driver-shifts/history: Returns canonical pagination metadata', false, `status=${shiftsRes.status}, body=${JSON.stringify(shiftsBody)}`);
      failed++;
    }

    // -------------------------------------------------------------------------
    // Test 4: GET /orders/driver/my-orders returns canonical pagination envelope
    // -------------------------------------------------------------------------
    const ordersRes = await fetch(`${BASE_URL}/orders/driver/my-orders?page=1&pageSize=10`, {
      headers: { Authorization: `Bearer ${driverToken}` },
    });
    const ordersBody = (await ordersRes.json()) as any;

    const ordersPaginationValid =
      ordersBody.pagination &&
      typeof ordersBody.pagination.page === 'number' &&
      typeof ordersBody.pagination.pageSize === 'number' &&
      typeof ordersBody.pagination.totalItems === 'number' &&
      typeof ordersBody.pagination.totalPages === 'number' &&
      typeof ordersBody.pagination.hasNextPage === 'boolean' &&
      typeof ordersBody.pagination.hasPrevPage === 'boolean' &&
      Array.isArray(ordersBody.data);

    if (ordersRes.status === 200 && ordersPaginationValid) {
      logTest('1.4 GET /orders/driver/my-orders: Returns canonical pagination metadata and data array', true);
      passed++;
    } else {
      logTest('1.4 GET /orders/driver/my-orders: Returns canonical pagination metadata', false, `status=${ordersRes.status}, body=${JSON.stringify(ordersBody)}`);
      failed++;
    }

  } catch (err: any) {
    console.error('Unexpected test error:', err);
    failed++;
  } finally {
    console.log('\n🧹 Cleaning up test fixtures...');
    if (testDriverUser) {
      await prisma.user.deleteMany({ where: { userId: testDriverUser.userId } });
    }
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

runCanonicalPaginationEnvelopeSuite();
