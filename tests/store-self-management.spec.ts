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

async function runStoreSelfManagementSuite() {
  console.log('\n========================================================================');
  console.log('🚀 SUITE: STORE SELF-MANAGEMENT (/stores/me) & BOLA ISOLATION');
  console.log('========================================================================\n');

  let passed = 0;
  let failed = 0;

  let owner: any = null;
  let nonOwner: any = null;
  let store: any = null;
  let ownerToken = '';
  let nonOwnerToken = '';

  try {
    const jwtSecret = process.env.JWT_SECRET || 'smart_order_button_super_secret_jwt_key_2026_prod';

    owner = await prisma.user.create({
      data: {
        username: `store_owner_${Date.now()}`,
        email: `store_owner_${Date.now()}@test.com`,
        phone: `0971${Math.floor(Math.random() * 1000000).toString().padStart(6, '0')}`,
        fullName: 'Store Self Owner',
        status: 'ACTIVE',
      },
    });

    nonOwner = await prisma.user.create({
      data: {
        username: `non_owner_${Date.now()}`,
        email: `non_owner_${Date.now()}@test.com`,
        phone: `0972${Math.floor(Math.random() * 1000000).toString().padStart(6, '0')}`,
        fullName: 'Regular Customer',
        status: 'ACTIVE',
      },
    });

    store = await prisma.store.create({
      data: {
        name: 'Original Store Name',
        code: `STORE-ME-${Date.now()}`,
        phone: '0901112233',
        email: 'original@store.com',
        address: '100 Nguyen Van Linh, Da Nang',
        ownerUserId: owner.userId,
        status: 'ACTIVE',
      },
    });

    // Create wallet for store
    await prisma.storeWallet.create({
      data: {
        storeId: store.storeId,
        balance: 500000,
        frozenBalance: 0,
      },
    });

    ownerToken = jwt.sign(
      {
        userId: owner.userId.toString(),
        sub: owner.userId.toString(),
        username: owner.username,
        role: 'STORE_OWNER',
        storeId: store.storeId.toString(),
      },
      jwtSecret,
      { expiresIn: '1h' },
    );

    nonOwnerToken = jwt.sign(
      {
        userId: nonOwner.userId.toString(),
        sub: nonOwner.userId.toString(),
        username: nonOwner.username,
        role: 'CUSTOMER',
      },
      jwtSecret,
      { expiresIn: '1h' },
    );

    // Test 1: GET /stores/me returns 200 with aggregated StoreMeResponseDto
    try {
      const res = await fetch(`${BASE_URL}/stores/me`, {
        headers: { Authorization: `Bearer ${ownerToken}` },
      });
      const body = await res.json();

      if (
        res.status === 200 &&
        body.success === true &&
        body.data.storeId === store.storeId.toString() &&
        body.data.name === 'Original Store Name' &&
        body.data.wallet.balance === 500000 &&
        body.data.owner.userId === owner.userId.toString() &&
        body.data.bankVerification !== undefined
      ) {
        logTest('GET /stores/me aggregates profile, owner, and wallet details', true);
        passed++;
      } else {
        logTest('GET /stores/me aggregates profile, owner, and wallet details', false, JSON.stringify(body));
        failed++;
      }
    } catch (err: any) {
      logTest('GET /stores/me aggregates profile, owner, and wallet details', false, err.message);
      failed++;
    }

    // Test 2: PATCH /stores/me updates allowed profile fields
    try {
      const updatePayload = {
        name: 'Updated Store Brand Name',
        email: 'newemail@store.com',
        phone: '0909998877',
        address: '200 Vo Van Kiet, Da Nang',
      };

      const res = await fetch(`${BASE_URL}/stores/me`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ownerToken}`,
        },
        body: JSON.stringify(updatePayload),
      });
      const body = await res.json();

      if (
        res.status === 200 &&
        body.success === true &&
        body.data.name === updatePayload.name &&
        body.data.email === updatePayload.email &&
        body.data.phone === updatePayload.phone &&
        body.data.address === updatePayload.address
      ) {
        logTest('PATCH /stores/me updates name, email, phone, and address', true);
        passed++;
      } else {
        logTest('PATCH /stores/me updates name, email, phone, and address', false, JSON.stringify(body));
        failed++;
      }
    } catch (err: any) {
      logTest('PATCH /stores/me updates name, email, phone, and address', false, err.message);
      failed++;
    }

    // Test 3: PATCH /stores/me rejects mass-assignment of sensitive fields
    try {
      const exploitPayload = {
        status: 'SUSPENDED',
        code: 'HACKED-CODE',
        commissionRate: 0.1,
      };

      const res = await fetch(`${BASE_URL}/stores/me`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ownerToken}`,
        },
        body: JSON.stringify(exploitPayload),
      });

      // Verify db was NOT modified for sensitive fields
      const storeInDb = await prisma.store.findUnique({ where: { storeId: store.storeId } });
      if (
        storeInDb?.status === 'ACTIVE' &&
        storeInDb?.code === store.code
      ) {
        logTest('PATCH /stores/me ignores/disallows mass-assignment to status and store code', true);
        passed++;
      } else {
        logTest('PATCH /stores/me ignores/disallows mass-assignment to status and store code', false, `Status: ${storeInDb?.status}, Code: ${storeInDb?.code}`);
        failed++;
      }
    } catch (err: any) {
      logTest('PATCH /stores/me ignores/disallows mass-assignment to status and store code', false, err.message);
      failed++;
    }

    // Test 4: Non-owner gets 404
    try {
      const res = await fetch(`${BASE_URL}/stores/me`, {
        headers: { Authorization: `Bearer ${nonOwnerToken}` },
      });
      const body = await res.json();

      if ((res.status === 403 || res.status === 404) && body.success === false) {
        logTest('GET /stores/me returns 403/404 for users with no linked store', true);
        passed++;
      } else {
        logTest('GET /stores/me returns 403/404 for users with no linked store', false, `Status: ${res.status}`);
        failed++;
      }
    } catch (err: any) {
      logTest('GET /stores/me returns 404 for users with no linked store', false, err.message);
      failed++;
    }

    // Test 5: Unauthenticated returns 401
    try {
      const res = await fetch(`${BASE_URL}/stores/me`);
      if (res.status === 401) {
        logTest('GET /stores/me rejects unauthenticated requests with 401', true);
        passed++;
      } else {
        logTest('GET /stores/me rejects unauthenticated requests with 401', false, `Status: ${res.status}`);
        failed++;
      }
    } catch (err: any) {
      logTest('GET /stores/me rejects unauthenticated requests with 401', false, err.message);
      failed++;
    }

  } finally {
    // Cleanup
    if (store) {
      await prisma.storeWallet.deleteMany({ where: { storeId: store.storeId } }).catch(() => {});
      await prisma.store.delete({ where: { storeId: store.storeId } }).catch(() => {});
    }
    if (owner) {
      await prisma.user.delete({ where: { userId: owner.userId } }).catch(() => {});
    }
    if (nonOwner) {
      await prisma.user.delete({ where: { userId: nonOwner.userId } }).catch(() => {});
    }
    await prisma.$disconnect();
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) {
    process.exit(1);
  }
}

runStoreSelfManagementSuite().catch((e) => {
  console.error(e);
  process.exit(1);
});
