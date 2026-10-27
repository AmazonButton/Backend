import { PrismaService } from '../src/prisma/prisma.service';
import { StoreWalletService } from '../src/store-wallet/store-wallet.service';
import { PayOSPayoutService } from '../src/payments/payos-payout.service';
import { CryptoVaultUtil } from '../src/common/utils/crypto-vault.util';
import { Decimal } from '@prisma/client/runtime/library';

async function runP0SecurityAndConcurrencyTests() {
  console.log('================================================================');
  console.log('🚀 SUITE 24: P0 Security & Concurrency Invariants Verification');
  console.log('================================================================\n');

  process.env.PAYOS_CLIENT_ID = 'test_payos_client_id_123';
  process.env.PAYOS_API_KEY = 'test_payos_api_key_123';
  process.env.PAYOS_CHECKSUM_KEY = 'test_payos_checksum_key_123';
  process.env.PAYOS_PAYOUT_CHECKSUM_KEY = 'test_payos_checksum_key_123';
  process.env.PAYOS_MOCK_PAYOUT = 'true';
  process.env.BANK_VERIFICATION_STRICT = 'true';
  process.env.NODE_ENV = 'test';

  const prisma = new PrismaService();
  await prisma.$connect();

  const payosPayoutService = new PayOSPayoutService();
  const walletService = new StoreWalletService(prisma, payosPayoutService);

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, testName: string, detail?: string) {
    if (condition) {
      console.log(`  ✔ [PASS] ${testName}`);
      passed++;
    } else {
      console.error(`  ✘ [FAIL] ${testName}${detail ? ` -> ${detail}` : ''}`);
      failed++;
    }
  }

  // Cleanup tracking lists
  const cleanupWithdrawalIds: bigint[] = [];
  const cleanupOrderIds: bigint[] = [];
  const cleanupStoreIds: bigint[] = [];
  const cleanupUserIds: bigint[] = [];

  try {
    // ------------------------------------------------------------------------
    // SETUP: Isolated User & Store & Wallet
    // ------------------------------------------------------------------------
    const timestamp = Date.now();
    const testUser = await prisma.user.create({
      data: {
        username: `p0_test_user_${timestamp}`,
        fullName: 'P0 Test Security User',
        status: 'ACTIVE',
      },
    });
    cleanupUserIds.push(testUser.userId);

    const testStore = await prisma.store.create({
      data: {
        name: `P0 Security Test Store ${timestamp}`,
        code: `STR_P0_${timestamp}`,
        phone: '0901234567',
        address: '123 Test St',
        ownerUserId: testUser.userId,
        status: 'ACTIVE',
      },
    });
    cleanupStoreIds.push(testStore.storeId);

    const testWallet = await prisma.storeWallet.create({
      data: {
        storeId: testStore.storeId,
        balance: new Decimal(900000),
        frozenBalance: new Decimal(100000),
      },
    });

    // ========================================================================
    // TEST 1: TX-01 Payout Failure Automatic Refund Invariant
    // ========================================================================
    console.log('\n--- 1. TX-01: Payout Failure Automatic Refund & Ledger Invariant ---');
    const withdrawalCode = `WDR-P0-${timestamp}`;
    const testWithdrawal = await prisma.storeWithdrawal.create({
      data: {
        walletId: testWallet.walletId,
        storeId: testStore.storeId,
        withdrawalCode,
        amount: new Decimal(100000),
        fee: new Decimal(0),
        netAmount: new Decimal(100000),
        status: 'PROCESSING',
        bankName: 'MBBank',
        bankAccountHolder: 'NGUYEN VAN TEST',
        bankAccountNameSnapshot: 'NGUYEN VAN TEST',
        bankBinSnapshot: '970422',
        bankNameSnapshot: 'MBBank',
        bankAccountEncrypted: 'v1:iv:tag:data',
        bankAccountHash: 'hash_test_p0_123',
        bankAccountMasked: '******1234',
        provider: 'PAYOS',
      },
    });
    cleanupWithdrawalIds.push(testWithdrawal.withdrawalId);

    // Call refundFailedWithdrawal
    await walletService.refundFailedWithdrawal(testWithdrawal.withdrawalId, 'PAYOS_API_TIMEOUT');

    const refundedWithdrawal = await prisma.storeWithdrawal.findUnique({
      where: { withdrawalId: testWithdrawal.withdrawalId },
    });
    const updatedWallet = await prisma.storeWallet.findUnique({
      where: { walletId: testWallet.walletId },
    });
    const refundLedger = await prisma.walletTransaction.findFirst({
      where: {
        walletId: testWallet.walletId,
        type: 'WITHDRAWAL_REFUND',
      },
    });

    assert(
      refundedWithdrawal?.status === 'FAILED',
      'Withdrawal marked FAILED after payout failure',
      `Expected FAILED, got ${refundedWithdrawal?.status}`,
    );
    assert(
      refundedWithdrawal?.failureReason === 'PAYOS_API_TIMEOUT',
      'Withdrawal failureReason recorded and sanitized',
      `Expected PAYOS_API_TIMEOUT, got ${refundedWithdrawal?.failureReason}`,
    );
    assert(
      Number(updatedWallet?.balance) === 1000000 && Number(updatedWallet?.frozenBalance) === 0,
      'Wallet balances correctly restored (frozen decremented, balance incremented)',
      `balance: ${updatedWallet?.balance}, frozen: ${updatedWallet?.frozenBalance}`,
    );
    assert(
      refundLedger !== null && Number(refundLedger.amount) === 100000,
      'WITHDRAWAL_REFUND ledger transaction created with correct amount',
    );

    // Test Idempotency: Re-calling refundFailedWithdrawal must not re-refund or throw
    await walletService.refundFailedWithdrawal(testWithdrawal.withdrawalId, 'PAYOS_API_TIMEOUT');
    const recheckWallet = await prisma.storeWallet.findUnique({
      where: { walletId: testWallet.walletId },
    });
    const ledgerCount = await prisma.walletTransaction.count({
      where: {
        walletId: testWallet.walletId,
        type: 'WITHDRAWAL_REFUND',
      },
    });
    assert(
      Number(recheckWallet?.balance) === 1000000 && ledgerCount === 1,
      'Idempotency guard: duplicate refund invocation does not duplicate funds or ledger entries',
    );

    // Test P0 Terminal Guard: A FAILED/refunded withdrawal must NEVER be finalized as SUCCEEDED
    let terminalConflictCaught = false;
    try {
      await (walletService as any).repo.finalizePayoutSuccessTx(testWithdrawal.withdrawalId);
    } catch (err: any) {
      if (err?.message?.includes('CRITICAL_PAYOUT_CONFLICT') || err?.status === 409) {
        terminalConflictCaught = true;
      }
    }
    assert(
      terminalConflictCaught === true,
      'P0 Terminal State Guard: finalizePayoutSuccessTx on refunded/FAILED withdrawal blocked with ConflictException',
    );

    // ========================================================================
    // TEST 2: CC-01 Active Payment Constraint (uq_payment_active_per_order)
    // ========================================================================
    console.log('\n--- 2. CC-01: Active Payment Invariant per Order (uq_payment_active_per_order) ---');
    const sampleCustomer = await prisma.customerProfile.findFirst();
    const sampleButton = await prisma.ioTButton.findFirst();

    const testOrder = await prisma.order.create({
      data: {
        storeId: testStore.storeId,
        customerId: sampleCustomer ? sampleCustomer.customerId : testUser.userId,
        buttonId: sampleButton ? sampleButton.buttonId : null,
        orderCode: `ORD-P0-${timestamp}`,
        subtotalAmount: 200000,
        totalAmount: 200000,
        orderStatus: 'PENDING',
        paymentStatus: 'UNPAID',
        paymentMethod: 'PAYOS',
        shippingRecipientName: 'P0 Test Recipient',
        shippingPhone: '0901234567',
        shippingAddress: '123 Test Street, HCM',
      },
    });
    cleanupOrderIds.push(testOrder.orderId);

    // Create first active payment
    const payment1 = await prisma.paymentTransaction.create({
      data: {
        orderId: testOrder.orderId,
        provider: 'PAYOS',
        transactionCode: `TX-${timestamp}-1`,
        amount: new Decimal(200000),
        paymentMethod: 'QR',
        status: 'PENDING',
      },
    });

    // Attempt to create second active payment on same order -> Must fail with unique constraint violation
    let duplicatePrevented = false;
    let constraintName = '';
    let errorCode = '';
    try {
      await prisma.paymentTransaction.create({
        data: {
          orderId: testOrder.orderId,
          provider: 'PAYOS',
          transactionCode: `TX-${timestamp}-2`,
          amount: new Decimal(200000),
          paymentMethod: 'QR',
          status: 'PENDING',
        },
      });
    } catch (err: any) {
      duplicatePrevented = true;
      errorCode = err.code || '';
      constraintName = err.message || '';
    }

    assert(
      duplicatePrevented && (errorCode === 'P2002' || constraintName.includes('uq_payment_active_per_order') || constraintName.includes('order_id')),
      'Database constraint uq_payment_active_per_order blocks concurrent active payments on identical order',
      `Error detail: code=${errorCode}, message=${constraintName}`,
    );

    // After updating payment1 to CANCELLED, creating a new PENDING payment must succeed
    await prisma.paymentTransaction.update({
      where: { paymentTransactionId: payment1.paymentTransactionId },
      data: { status: 'CANCELLED' },
    });

    const payment2 = await prisma.paymentTransaction.create({
      data: {
        orderId: testOrder.orderId,
        provider: 'PAYOS',
        transactionCode: `TX-${timestamp}-3`,
        amount: new Decimal(200000),
        paymentMethod: 'QR',
        status: 'PENDING',
      },
    });

    assert(
      payment2.paymentTransactionId !== undefined,
      'Partial unique index allows new PENDING payment after prior active payment is CANCELLED',
    );

    // ========================================================================
    // TEST 3: CC-01 Single Default Bank Account Invariant per Store
    // ========================================================================
    console.log('\n--- 3. CC-01: Single Default Bank Account Invariant (uq_default_bank_account_per_store) ---');
    const bankAcc1 = await prisma.storeBankAccount.create({
      data: {
        storeId: testStore.storeId,
        bankBin: '970422',
        bankCode: 'VCB',
        bankName: 'Vietcombank',
        accountName: 'STORE PRIMARY',
        accountNumberHash: `hash_bank_1_${timestamp}`,
        accountNumberEncrypted: 'v1:iv:tag:data1',
        isDefault: true,
      },
    });

    let secondDefaultPrevented = false;
    let bankConstraintName = '';
    let bankErrorCode = '';
    try {
      await prisma.storeBankAccount.create({
        data: {
          storeId: testStore.storeId,
          bankBin: '970407',
          bankCode: 'TCB',
          bankName: 'Techcombank',
          accountName: 'STORE SECONDARY',
          accountNumberHash: `hash_bank_2_${timestamp}`,
          accountNumberEncrypted: 'v1:iv:tag:data2',
          isDefault: true, // Second default for same store
        },
      });
    } catch (err: any) {
      secondDefaultPrevented = true;
      bankErrorCode = err.code || '';
      bankConstraintName = err.message || '';
    }

    assert(
      secondDefaultPrevented && (bankErrorCode === 'P2002' || bankConstraintName.includes('uq_default_bank_account_per_store') || bankConstraintName.includes('store_id')),
      'Database constraint uq_default_bank_account_per_store prevents multiple default bank accounts for single store',
      `Error detail: code=${bankErrorCode}, message=${bankConstraintName}`,
    );

    // ========================================================================
    // TEST 4: SEC-01 Fail-Fast Crypto Secrets (No Hardcoded Fallback in Non-Test)
    // ========================================================================
    console.log('\n--- 4. SEC-01: Secrets Hardening & Fail-Fast Verification ---');
    const originalEnv = process.env.NODE_ENV;
    const originalKey = process.env.BANK_ACCOUNT_ENCRYPTION_KEY;
    const originalSalt = process.env.BANK_ACCOUNT_HASH_SALT;

    try {
      // Simulate non-test environment with missing encryption key
      process.env.NODE_ENV = 'production';
      delete process.env.BANK_ACCOUNT_ENCRYPTION_KEY;

      let keyThrew = false;
      let keyErrorMsg = '';
      try {
        CryptoVaultUtil.encryptAccountNumber('123456789');
      } catch (e: any) {
        keyThrew = true;
        keyErrorMsg = e.message;
      }
      assert(
        keyThrew && keyErrorMsg.includes('BANK_ACCOUNT_ENCRYPTION_KEY'),
        'CryptoVaultUtil fails fast in production when BANK_ACCOUNT_ENCRYPTION_KEY is missing (no fallback)',
        `Error: ${keyErrorMsg}`,
      );

      // Simulate missing salt in production
      process.env.BANK_ACCOUNT_ENCRYPTION_KEY = '5dad52bd291a3e8f96f284cd7fcdb72d96d5f114c00e642dea09e9da19d0363d';
      delete process.env.BANK_ACCOUNT_HASH_SALT;

      let saltThrew = false;
      let saltErrorMsg = '';
      try {
        CryptoVaultUtil.hashAccountNumber('123456789');
      } catch (e: any) {
        saltThrew = true;
        saltErrorMsg = e.message;
      }
      assert(
        saltThrew && saltErrorMsg.includes('BANK_ACCOUNT_HASH_SALT'),
        'CryptoVaultUtil fails fast in production when BANK_ACCOUNT_HASH_SALT is missing (no fallback)',
        `Error: ${saltErrorMsg}`,
      );
    } finally {
      process.env.NODE_ENV = originalEnv;
      if (originalKey) process.env.BANK_ACCOUNT_ENCRYPTION_KEY = originalKey;
      if (originalSalt) process.env.BANK_ACCOUNT_HASH_SALT = originalSalt;
    }

  } catch (error: any) {
    console.error('Unexpected test error:', error);
    failed++;
  } finally {
    // Teardown created resources
    console.log('\n--- Cleaning up test artifacts ---');
    try {
      if (cleanupWithdrawalIds.length > 0) {
        await prisma.walletTransaction.deleteMany({
          where: { description: { contains: 'WDR-P0-' } },
        });
        await prisma.storeWithdrawal.deleteMany({
          where: { withdrawalId: { in: cleanupWithdrawalIds } },
        });
      }
      if (cleanupOrderIds.length > 0) {
        await prisma.paymentTransaction.deleteMany({
          where: { orderId: { in: cleanupOrderIds } },
        });
        await prisma.order.deleteMany({
          where: { orderId: { in: cleanupOrderIds } },
        });
      }
      if (cleanupStoreIds.length > 0) {
        await prisma.storeBankAccount.deleteMany({
          where: { storeId: { in: cleanupStoreIds } },
        });
        await prisma.storeWallet.deleteMany({
          where: { storeId: { in: cleanupStoreIds } },
        });
        await prisma.store.deleteMany({
          where: { storeId: { in: cleanupStoreIds } },
        });
      }
      if (cleanupUserIds.length > 0) {
        await prisma.user.deleteMany({
          where: { userId: { in: cleanupUserIds } },
        });
      }
    } catch (cleanupErr) {
      console.warn('Cleanup warning:', cleanupErr);
    }
    await prisma.$disconnect();
  }

  console.log('\n================================================================');
  console.log(`SUMMARY: ${passed} passed, ${failed} failed`);
  console.log('================================================================');
  if (failed > 0) {
    process.exit(1);
  }
  process.exit(0);
}

runP0SecurityAndConcurrencyTests();
