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

async function runWalletPaginationDetailSuite() {
  console.log('\n========================================================================');
  console.log('🚀 SUITE: STORE WALLET & WITHDRAWALS PAGINATION, FILTERS & DETAILS (TASK 4.3)');
  console.log('========================================================================\n');

  let passed = 0;
  let failed = 0;

  let ownerA: any = null;
  let storeA: any = null;
  let walletA: any = null;
  let tokenA = '';

  let ownerB: any = null;
  let storeB: any = null;
  let walletB: any = null;
  let tokenB = '';

  let adminUser: any = null;
  let adminToken = '';

  let withdrawalA1: any = null;
  let withdrawalA2: any = null;

  try {
    const jwtSecret = process.env.JWT_SECRET || 'smart_order_button_super_secret_jwt_key_2026_prod';

    // 1. Setup Store A & Owner A
    ownerA = await prisma.user.create({
      data: {
        username: `wal_owner_a_${Date.now()}`,
        fullName: 'Wallet Owner A',
        email: `wal_owner_a_${Date.now()}@test.com`,
        status: 'ACTIVE',
      },
    });

    storeA = await prisma.store.create({
      data: {
        name: `Wallet Store A ${Date.now()}`,
        code: `STR_WAL_A_${Date.now().toString().slice(-6)}`,
        phone: '0901234567',
        ownerUserId: ownerA.userId,
        status: 'ACTIVE',
        address: '123 Wallet Road A',
      },
    });

    walletA = await prisma.storeWallet.create({
      data: {
        storeId: storeA.storeId,
        balance: 5000000,
        frozenBalance: 200000,
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
        username: `wal_owner_b_${Date.now()}`,
        fullName: 'Wallet Owner B',
        email: `wal_owner_b_${Date.now()}@test.com`,
        status: 'ACTIVE',
      },
    });

    storeB = await prisma.store.create({
      data: {
        name: `Wallet Store B ${Date.now()}`,
        code: `STR_WAL_B_${Date.now().toString().slice(-6)}`,
        phone: '0907654321',
        ownerUserId: ownerB.userId,
        status: 'ACTIVE',
        address: '456 Wallet Road B',
      },
    });

    walletB = await prisma.storeWallet.create({
      data: {
        storeId: storeB.storeId,
        balance: 1000000,
        frozenBalance: 0,
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

    // 3. Setup Admin User
    adminUser = await prisma.user.create({
      data: {
        username: `wal_admin_${Date.now()}`,
        fullName: 'Wallet System Admin',
        email: `wal_admin_${Date.now()}@test.com`,
        status: 'ACTIVE',
      },
    });

    adminToken = jwt.sign(
      {
        sub: adminUser.userId.toString(),
        userId: adminUser.userId.toString(),
        username: adminUser.username,
        role: 'SYSTEM_ADMIN',
      },
      jwtSecret,
      { expiresIn: '1h' },
    );

    // 4. Seed Wallet Transactions for Store A
    const t1 = await prisma.walletTransaction.create({
      data: {
        walletId: walletA.walletId,
        amount: 250000,
        type: 'ORDER_REVENUE',
        balanceBefore: 4500000,
        balanceAfter: 4750000,
        referenceId: 'ORD-TEST-001',
        description: 'Doanh thu đơn hàng 1',
        createdAt: new Date(Date.now() - 48 * 3600 * 1000), // 2 days ago
      },
    });

    const t2 = await prisma.walletTransaction.create({
      data: {
        walletId: walletA.walletId,
        amount: 350000,
        type: 'ORDER_REVENUE',
        balanceBefore: 4750000,
        balanceAfter: 5100000,
        referenceId: 'ORD-TEST-002',
        description: 'Doanh thu đơn hàng 2',
        createdAt: new Date(Date.now() - 24 * 3600 * 1000), // 1 day ago
      },
    });

    const t3 = await prisma.walletTransaction.create({
      data: {
        walletId: walletA.walletId,
        amount: -100000,
        type: 'WITHDRAWAL_DEBIT',
        balanceBefore: 5100000,
        balanceAfter: 5000000,
        referenceId: 'WTH-TEST-001',
        description: 'Rút tiền về tài khoản ngân hàng',
        createdAt: new Date(),
      },
    });

    // 5. Seed Withdrawals for Store A
    withdrawalA1 = await prisma.storeWithdrawal.create({
      data: {
        walletId: walletA.walletId,
        storeId: storeA.storeId,
        withdrawalCode: `WTH_A1_${Date.now()}`,
        amount: 100000,
        fee: 0,
        netAmount: 100000,
        bankName: 'MBBank',
        bankAccountHolder: 'NGUYEN VAN A',
        bankAccountNameSnapshot: 'NGUYEN VAN A',
        bankBinSnapshot: '970422',
        bankNameSnapshot: 'MBBank',
        bankAccountEncrypted: 'enc_dummy_1234',
        bankAccountHash: 'hash_dummy_1234',
        bankAccountMasked: '******1234',
        status: 'PENDING',
        provider: 'PAYOS',
        providerReferenceId: `PAYOS_REF_${Date.now()}`,
        requestedAt: new Date(Date.now() - 12 * 3600 * 1000),
      },
    });

    withdrawalA2 = await prisma.storeWithdrawal.create({
      data: {
        walletId: walletA.walletId,
        storeId: storeA.storeId,
        withdrawalCode: `WTH_A2_${Date.now()}`,
        amount: 200000,
        fee: 0,
        netAmount: 200000,
        bankName: 'MBBank',
        bankAccountHolder: 'NGUYEN VAN A',
        bankAccountNameSnapshot: 'NGUYEN VAN A',
        bankBinSnapshot: '970422',
        bankNameSnapshot: 'MBBank',
        bankAccountEncrypted: 'enc_dummy_5678',
        bankAccountHash: 'hash_dummy_5678',
        bankAccountMasked: '******5678',
        status: 'SUCCEEDED',
        provider: 'PAYOS',
        providerReferenceId: `PAYOS_REF_SUCC_${Date.now()}`,
        requestedAt: new Date(Date.now() - 36 * 3600 * 1000),
        processedAt: new Date(),
      },
    });

    // Test 1: GET /api/v1/store/wallet/transactions with type filter and pagination
    const txRes = await fetch(`${BASE_URL}/store/wallet/transactions?page=1&pageSize=5&type=ORDER_REVENUE`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    const txBody: any = await txRes.json();

    const test1Passed =
      txRes.status === 200 &&
      txBody.success === true &&
      Array.isArray(txBody.data) &&
      txBody.data.length === 2 &&
      txBody.data.every((t: any) => t.type === 'ORDER_REVENUE') &&
      txBody.pagination?.totalItems === 2 &&
      txBody.pagination?.page === 1;

    if (test1Passed) {
      logTest('GET /store/wallet/transactions filters by type and returns canonical pagination envelope', true);
      passed++;
    } else {
      logTest('GET /store/wallet/transactions filters by type and returns canonical pagination envelope', false, JSON.stringify(txBody));
      failed++;
    }

    // Test 2: GET /api/v1/store/wallet/transactions with date range filter
    const fromDate = new Date(Date.now() - 30 * 3600 * 1000).toISOString(); // 30h ago (excludes t1, includes t2 and t3)
    const txDateRes = await fetch(`${BASE_URL}/store/wallet/transactions?fromDate=${fromDate}`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    const txDateBody: any = await txDateRes.json();

    const test2Passed =
      txDateRes.status === 200 &&
      txDateBody.success === true &&
      Array.isArray(txDateBody.data) &&
      txDateBody.data.length === 2 &&
      txDateBody.data.some((t: any) => t.referenceId === 'ORD-TEST-002') &&
      txDateBody.data.some((t: any) => t.referenceId === 'WTH-TEST-001') &&
      !txDateBody.data.some((t: any) => t.referenceId === 'ORD-TEST-001');

    if (test2Passed) {
      logTest('GET /store/wallet/transactions filters by fromDate window', true);
      passed++;
    } else {
      logTest('GET /store/wallet/transactions filters by fromDate window', false, JSON.stringify(txDateBody));
      failed++;
    }

    // Test 3: GET /api/v1/store/wallet/withdrawals with status filter and pagination
    const wthRes = await fetch(`${BASE_URL}/store/wallet/withdrawals?page=1&pageSize=5&status=PENDING`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    const wthBody: any = await wthRes.json();

    const test3Passed =
      wthRes.status === 200 &&
      wthBody.success === true &&
      Array.isArray(wthBody.data) &&
      wthBody.data.length === 1 &&
      wthBody.data[0].status === 'PENDING' &&
      wthBody.data[0].withdrawalId === withdrawalA1.withdrawalId.toString() &&
      wthBody.pagination?.totalItems === 1;

    if (test3Passed) {
      logTest('GET /store/wallet/withdrawals filters by status and returns canonical pagination envelope', true);
      passed++;
    } else {
      logTest('GET /store/wallet/withdrawals filters by status and returns canonical pagination envelope', false, JSON.stringify(wthBody));
      failed++;
    }

    // Test 4: GET /api/v1/store/wallet/withdrawals/:id detail view with masked bank account
    const detailRes = await fetch(`${BASE_URL}/store/wallet/withdrawals/${withdrawalA1.withdrawalId}`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    const detailBody: any = await detailRes.json();

    const test4Passed =
      detailRes.status === 200 &&
      detailBody.success === true &&
      detailBody.data?.withdrawalId === withdrawalA1.withdrawalId.toString() &&
      detailBody.data?.bankAccountMasked === '******1234' &&
      !detailBody.data?.bankAccountEncrypted &&
      !detailBody.data?.bankAccountHash;

    if (test4Passed) {
      logTest('GET /store/wallet/withdrawals/:id returns detail view with masked bank account and zero plaintext leak', true);
      passed++;
    } else {
      logTest('GET /store/wallet/withdrawals/:id returns detail view with masked bank account', false, JSON.stringify(detailBody));
      failed++;
    }

    // Test 5: IDOR Protection: Owner B accessing Store A withdrawal is rejected with HTTP 403
    const idorRes = await fetch(`${BASE_URL}/store/wallet/withdrawals/${withdrawalA1.withdrawalId}`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    const idorBody: any = await idorRes.json();

    const test5Passed = idorRes.status === 403;
    if (test5Passed) {
      logTest('BOLA / IDOR Protection: Cross-store withdrawal inspection rejected with HTTP 403', true);
      passed++;
    } else {
      logTest('BOLA / IDOR Protection: Cross-store withdrawal inspection rejected with HTTP 403', false, `Status: ${idorRes.status}`);
      failed++;
    }

    // Test 6: GET /api/v1/admin/withdrawals/:id detail view for Admin
    const adminDetailRes = await fetch(`${BASE_URL}/admin/withdrawals/${withdrawalA1.withdrawalId}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const adminDetailBody: any = await adminDetailRes.json();

    const test6Passed =
      adminDetailRes.status === 200 &&
      adminDetailBody.success === true &&
      adminDetailBody.data?.withdrawalId === withdrawalA1.withdrawalId.toString() &&
      adminDetailBody.data?.bankAccountMasked === '******1234';

    if (test6Passed) {
      logTest('GET /admin/withdrawals/:id returns admin withdrawal detail view with masked account', true);
      passed++;
    } else {
      logTest('GET /admin/withdrawals/:id returns admin withdrawal detail view with masked account', false, JSON.stringify(adminDetailBody));
      failed++;
    }
  } catch (err: any) {
    console.error('Fatal error during suite:', err);
    failed++;
  } finally {
    // Teardown
    try {
      if (withdrawalA1) {
        await prisma.storeWithdrawal.deleteMany({ where: { withdrawalId: withdrawalA1.withdrawalId } });
      }
      if (withdrawalA2) {
        await prisma.storeWithdrawal.deleteMany({ where: { withdrawalId: withdrawalA2.withdrawalId } });
      }
      if (walletA) {
        await prisma.walletTransaction.deleteMany({ where: { walletId: walletA.walletId } });
        await prisma.storeWallet.deleteMany({ where: { walletId: walletA.walletId } });
      }
      if (walletB) {
        await prisma.walletTransaction.deleteMany({ where: { walletId: walletB.walletId } });
        await prisma.storeWallet.deleteMany({ where: { walletId: walletB.walletId } });
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
      if (adminUser) {
        await prisma.user.deleteMany({ where: { userId: adminUser.userId } });
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
  runWalletPaginationDetailSuite();
}

export { runWalletPaginationDetailSuite };
