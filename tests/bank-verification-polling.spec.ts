import * as dotenv from 'dotenv';
dotenv.config();
import { PrismaClient } from '@prisma/client';
import jwt from 'jsonwebtoken';
import { CryptoVaultUtil } from '../src/common/utils/crypto-vault.util';

const prisma = new PrismaClient();
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000/api/v1';

function logTest(name: string, passed: boolean, detail?: string) {
  if (passed) {
    console.log(`\x1b[32m  ✔ [PASS]\x1b[0m ${name}`);
  } else {
    console.log(`\x1b[31m  ✖ [FAIL]\x1b[0m ${name}${detail ? ` -> ${detail}` : ''}`);
  }
}

async function runBankVerificationPollingSuite() {
  console.log('\n========================================================================');
  console.log('🚀 SUITE: BANK ACCOUNT VERIFICATION POLLING & BOLA ENFORCEMENT');
  console.log('========================================================================\n');

  let passed = 0;
  let failed = 0;

  let ownerA: any = null;
  let storeA: any = null;
  let bankAccountA: any = null;
  let verificationTxA: any = null;
  let tokenA = '';

  let ownerB: any = null;
  let storeB: any = null;
  let tokenB = '';

  try {
    const jwtSecret = process.env.JWT_SECRET || 'smart_order_button_super_secret_jwt_key_2026_prod';

    // Create Owner A & Store A
    ownerA = await prisma.user.create({
      data: {
        username: `bank_poll_owner_a_${Date.now()}`,
        email: `bank_poll_owner_a_${Date.now()}@test.com`,
        phone: `0979${Math.floor(Math.random() * 1000000).toString().padStart(6, '0')}`,
        fullName: 'Bank Polling Owner A',
        status: 'ACTIVE',
      },
    });

    storeA = await prisma.store.create({
      data: {
        name: 'Bank Polling Store A',
        code: `STORE-BANK-A-${Date.now()}`,
        phone: '0901234567',
        address: '123 Bank St A',
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

    // Create Owner B & Store B
    ownerB = await prisma.user.create({
      data: {
        username: `bank_poll_owner_b_${Date.now()}`,
        email: `bank_poll_owner_b_${Date.now()}@test.com`,
        phone: `0980${Math.floor(Math.random() * 1000000).toString().padStart(6, '0')}`,
        fullName: 'Bank Polling Owner B',
        status: 'ACTIVE',
      },
    });

    storeB = await prisma.store.create({
      data: {
        name: 'Bank Polling Store B',
        code: `STORE-BANK-B-${Date.now()}`,
        phone: '0907654321',
        address: '456 Bank St B',
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

    // Create Bank Account for Store A with encrypted account number
    const rawAccountNumber = '1029384756';
    const encrypted = CryptoVaultUtil.encryptAccountNumber(rawAccountNumber);
    const hashed = CryptoVaultUtil.hashAccountNumber(rawAccountNumber);

    bankAccountA = await prisma.storeBankAccount.create({
      data: {
        storeId: storeA.storeId,
        bankBin: '970422',
        bankCode: 'MB',
        bankName: 'MBBank Quân Đội',
        accountNumberEncrypted: encrypted,
        accountNumberHash: hashed,
        accountName: 'NGUYEN VAN A',
        verificationStatus: 'PENDING',
        isDefault: true,
      },
    });

    // Create Verification Transaction for Store A
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
    verificationTxA = await prisma.bankAccountVerificationTransaction.create({
      data: {
        bankAccountId: bankAccountA.id,
        referenceCode: 'VERIFY_TEST123',
        expectedAmount: 2000,
        status: 'PENDING',
        expiresAt,
      },
    });

    // Test 1: GET /bank-account-verifications/:id returns 200 with masked account number
    try {
      const res = await fetch(`${BASE_URL}/bank-account-verifications/${verificationTxA.id}`, {
        headers: { Authorization: `Bearer ${tokenA}` },
      });
      const body = await res.json();

      if (
        res.status === 200 &&
        body.success === true &&
        body.data.id === verificationTxA.id.toString() &&
        body.data.referenceCode === 'VERIFY_TEST123' &&
        body.data.status === 'PENDING' &&
        body.data.accountNumberMasked.includes('****') &&
        !JSON.stringify(body).includes(rawAccountNumber)
      ) {
        logTest('GET /bank-account-verifications/:id returns status and masked account number', true);
        passed++;
      } else {
        logTest('GET /bank-account-verifications/:id returns status and masked account number', false, JSON.stringify(body));
        failed++;
      }
    } catch (err: any) {
      logTest('GET /bank-account-verifications/:id returns status and masked account number', false, err.message);
      failed++;
    }

    // Test 2: GET /stores/:storeId/bank-account-verifications returns paginated history
    try {
      const res = await fetch(`${BASE_URL}/stores/${storeA.storeId}/bank-account-verifications?page=1&pageSize=20`, {
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
        body.data[0].accountNumberMasked.includes('****')
      ) {
        logTest('GET /stores/:storeId/bank-account-verifications returns paginated history', true);
        passed++;
      } else {
        logTest('GET /stores/:storeId/bank-account-verifications returns paginated history', false, JSON.stringify(body));
        failed++;
      }
    } catch (err: any) {
      logTest('GET /stores/:storeId/bank-account-verifications returns paginated history', false, err.message);
      failed++;
    }

    // Test 3: BOLA: Store B cannot access Store A's verification transaction by ID
    try {
      const res = await fetch(`${BASE_URL}/bank-account-verifications/${verificationTxA.id}`, {
        headers: { Authorization: `Bearer ${tokenB}` },
      });
      const body = await res.json();

      if (res.status === 403 && body.success === false) {
        logTest('BOLA: Store B cannot access Store A verification transaction (403)', true);
        passed++;
      } else {
        logTest('BOLA: Store B cannot access Store A verification transaction (403)', false, `Status: ${res.status}`);
        failed++;
      }
    } catch (err: any) {
      logTest('BOLA: Store B cannot access Store A verification transaction (403)', false, err.message);
      failed++;
    }

    // Test 4: BOLA: Store B cannot list Store A's verification transactions
    try {
      const res = await fetch(`${BASE_URL}/stores/${storeA.storeId}/bank-account-verifications`, {
        headers: { Authorization: `Bearer ${tokenB}` },
      });
      const body = await res.json();

      if (res.status === 403 && body.success === false) {
        logTest('BOLA: Store B cannot list Store A verification transactions (403)', true);
        passed++;
      } else {
        logTest('BOLA: Store B cannot list Store A verification transactions (403)', false, `Status: ${res.status}`);
        failed++;
      }
    } catch (err: any) {
      logTest('BOLA: Store B cannot list Store A verification transactions (403)', false, err.message);
      failed++;
    }

    // Test 5: Unauthenticated access returns 401
    try {
      const res = await fetch(`${BASE_URL}/bank-account-verifications/${verificationTxA.id}`);
      if (res.status === 401) {
        logTest('Unauthenticated access to /bank-account-verifications/:id returns 401', true);
        passed++;
      } else {
        logTest('Unauthenticated access to /bank-account-verifications/:id returns 401', false, `Status: ${res.status}`);
        failed++;
      }
    } catch (err: any) {
      logTest('Unauthenticated access to /bank-account-verifications/:id returns 401', false, err.message);
      failed++;
    }

  } finally {
    // Cleanup
    if (verificationTxA) {
      await prisma.bankAccountVerificationTransaction.delete({ where: { id: verificationTxA.id } }).catch(() => {});
    }
    if (bankAccountA) {
      await prisma.storeBankAccount.delete({ where: { id: bankAccountA.id } }).catch(() => {});
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

runBankVerificationPollingSuite().catch((e) => {
  console.error(e);
  process.exit(1);
});
