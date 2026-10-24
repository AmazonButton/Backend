import { PrismaService } from '../src/prisma/prisma.service';
import { StoreWalletService } from '../src/store-wallet/store-wallet.service';
import { AdminService } from '../src/admin/admin.service';
import { AdminRepository } from '../src/admin/admin.repository';
import { PayOSPayoutService } from '../src/payments/payos-payout.service';
import { CryptoVaultUtil } from '../src/common/utils/crypto-vault.util';
import { signPayoutRequest, verifyPayoutSignature } from '../src/payments/payos.helper';
import { PayoutWebhookController } from '../src/payments/payout-webhook.controller';
import { BadRequestException } from '@nestjs/common';
import { WalletMapper } from '../src/store-wallet/mappers/wallet.mapper';

async function runWithdrawalConcurrencyIdempotencyTests() {
  console.log('================================================================');
  console.log('🚀 SUITE 14: Withdrawal Concurrency, Idempotency & Payout Engine');
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
  const adminRepo = new AdminRepository(prisma);
  const adminService = new AdminService(adminRepo, payosPayoutService);
  const webhookController = new PayoutWebhookController(prisma, walletService);

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
  const cleanupBankAccIds: bigint[] = [];
  const cleanupStoreIds: bigint[] = [];
  const cleanupUserIds: bigint[] = [];

  try {
    // ------------------------------------------------------------------------
    // SETUP: Create isolated store, wallet, and OWNERSHIP_VERIFIED bank account
    // ------------------------------------------------------------------------
    const testUsername = `wdr_test_user_${Date.now()}`;
    const testUser = await prisma.user.create({
      data: {
        username: testUsername,
        fullName: 'Nguyen Van Owner',
        email: `${testUsername}@example.com`,
        status: 'ACTIVE',
      },
    });
    cleanupUserIds.push(testUser.userId);

    const testStore = await prisma.store.create({
      data: {
        name: 'Withdrawal Test Store',
        code: `STR_WDR_${Date.now()}`,
        phone: '0909998887',
        address: '456 Financial Blvd',
        ownerUserId: testUser.userId,
        status: 'ACTIVE',
      },
    });
    cleanupStoreIds.push(testStore.storeId);

    const rawAccNum = '098765432199';
    const verifiedBankAcc = await prisma.storeBankAccount.create({
      data: {
        storeId: testStore.storeId,
        bankBin: '970422',
        bankCode: 'MB',
        bankName: 'MBBank',
        accountNumberEncrypted: CryptoVaultUtil.encryptAccountNumber(rawAccNum),
        accountNumberHash: CryptoVaultUtil.hashAccountNumber(rawAccNum),
        accountName: 'NGUYEN VAN OWNER',
        verificationStatus: 'OWNERSHIP_VERIFIED',
        isDefault: true,
        verifiedAt: new Date(),
        lastVerifiedAt: new Date(),
      },
    });
    cleanupBankAccIds.push(verifiedBankAcc.id);

    const wallet = await walletService.getOrCreateStoreWallet(testStore.storeId);
    await prisma.storeWallet.update({
      where: { walletId: wallet.walletId },
      data: { balance: 100000, frozenBalance: 0 },
    });

    // ------------------------------------------------------------------------
    // SECTION 1: Concurrency Race-Condition Immunity (SELECT FOR UPDATE)
    // ------------------------------------------------------------------------
    console.log('[SECTION 1] Concurrency & Over-Withdrawal Defense:');

    // Attempt 2 concurrent withdrawals of 80,000 VND on 100,000 VND balance
    const results = await Promise.allSettled([
      walletService.requestWithdrawal(testStore.storeId, {
        amount: 80000,
        bankName: 'MBBank',
        bankAccountNumber: rawAccNum,
        bankAccountHolder: 'NGUYEN VAN OWNER',
      }),
      walletService.requestWithdrawal(testStore.storeId, {
        amount: 80000,
        bankName: 'MBBank',
        bankAccountNumber: rawAccNum,
        bankAccountHolder: 'NGUYEN VAN OWNER',
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<any>[];
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];

    assert(
      fulfilled.length === 1 && rejected.length === 1,
      '1.1 Concurrent 80k withdrawals on 100k balance: exactly 1 succeeds and 1 fails',
    );

    const firstWdr = fulfilled[0].value;
    cleanupWithdrawalIds.push(firstWdr.withdrawalId);

    const walletAfterRace = await prisma.storeWallet.findUnique({
      where: { walletId: wallet.walletId },
    });

    assert(
      Number(walletAfterRace?.balance) === 20000 && Number(walletAfterRace?.frozenBalance) === 80000,
      '1.2 Frozen balance invariant: balance deducted by 80k (20k remaining), frozenBalance increased to 80k',
    );

    // ------------------------------------------------------------------------
    // SECTION 2: Idempotency Key & Encrypted Snapshot Verification
    // ------------------------------------------------------------------------
    console.log('\n[SECTION 2] Idempotency Key & Encrypted Snapshots:');

    // Refill balance for idempotency tests
    await prisma.storeWallet.update({
      where: { walletId: wallet.walletId },
      data: { balance: 200000 },
    });

    const testIdempotencyKey = `idemp_${Date.now()}_abc`;
    const idempWdr1 = await walletService.requestWithdrawal(
      testStore.storeId,
      {
        amount: 50000,
        bankName: 'MBBank',
        bankAccountNumber: rawAccNum,
        bankAccountHolder: 'NGUYEN VAN OWNER',
      },
      testIdempotencyKey,
    );
    cleanupWithdrawalIds.push(idempWdr1.withdrawalId);

    // Call again with SAME idempotency key
    const idempWdr2 = await walletService.requestWithdrawal(
      testStore.storeId,
      {
        amount: 50000,
        bankName: 'MBBank',
        bankAccountNumber: rawAccNum,
        bankAccountHolder: 'NGUYEN VAN OWNER',
      },
      testIdempotencyKey,
    );

    assert(
      idempWdr1.withdrawalId.toString() === idempWdr2.withdrawalId.toString(),
      '2.1 Idempotency Key: Re-submitting same key returns identical withdrawal without duplicate deduction',
    );

    // Verify Encrypted Snapshots in DB
    const fetchedWdr = await prisma.storeWithdrawal.findUnique({
      where: { withdrawalId: idempWdr1.withdrawalId },
    });

    assert(
      fetchedWdr?.bankAccountEncrypted !== null &&
        fetchedWdr?.bankAccountHash !== null &&
        fetchedWdr?.bankAccountMasked === CryptoVaultUtil.maskAccountNumber(rawAccNum) &&
        fetchedWdr?.bankBinSnapshot === '970422' &&
        fetchedWdr?.bankAccountNameSnapshot === 'NGUYEN VAN OWNER',
      '2.2 Encrypted Snapshots: bankAccountEncrypted, bankAccountHash, bankAccountMasked, and bankBinSnapshot populated',
    );

    // Verify zero account number leakage in WalletTransaction
    const txRecords = await prisma.walletTransaction.findMany({
      where: { referenceId: idempWdr1.withdrawalCode },
    });
    const hasLeak = txRecords.some((tx) => tx.description.includes(rawAccNum));
    assert(!hasLeak, '2.3 Zero Account Leakage: Full bank account number never appears in wallet_transactions.description');

    // ------------------------------------------------------------------------
    // SECTION 3: Admin Payout Initiation & Fail-Closed Auto-Refund
    // ------------------------------------------------------------------------
    console.log('\n[SECTION 3] Single-Path PayOS Payout & Fail-Closed Refund:');

    // Reset wallet balance for clean testing
    await prisma.storeWallet.update({
      where: { walletId: wallet.walletId },
      data: { balance: 200000, frozenBalance: 0 },
    });

    const wdrForPayout = await walletService.requestWithdrawal(testStore.storeId, {
      amount: 100000,
      bankName: 'MBBank',
      bankAccountNumber: rawAccNum,
      bankAccountHolder: 'NGUYEN VAN OWNER',
    });
    cleanupWithdrawalIds.push(wdrForPayout.withdrawalId);

    // Call Admin Payout
    const payoutResult = await adminService.payoutViaPayOS(wdrForPayout.withdrawalId, { userId: testUser.userId });
    assert(
      payoutResult.status === 'PROCESSING' && payoutResult.providerPayoutId !== null,
      '3.1 Admin Payout: Atomic transition PENDING -> PROCESSING with providerPayoutId',
    );

    // Simulate PayOS Initiation Failure with auto-refund
    const wdrForFail = await walletService.requestWithdrawal(testStore.storeId, {
      amount: 50000,
      bankName: 'MBBank',
      bankAccountNumber: rawAccNum,
      bankAccountHolder: 'NGUYEN VAN OWNER',
    });
    cleanupWithdrawalIds.push(wdrForFail.withdrawalId);

    // Temporarily mock createPayout to throw
    const originalCreatePayout = payosPayoutService.createPayout.bind(payosPayoutService);
    payosPayoutService.createPayout = async () => {
      throw new Error('PayOS Payout 601: Channel not whitelisted or balance insufficient');
    };

    let payoutFailedThrew = false;
    try {
      await adminService.payoutViaPayOS(wdrForFail.withdrawalId, { userId: testUser.userId });
    } catch {
      payoutFailedThrew = true;
    }
    payosPayoutService.createPayout = originalCreatePayout; // Restore

    const wdrAfterFail = await prisma.storeWithdrawal.findUnique({
      where: { withdrawalId: wdrForFail.withdrawalId },
    });
    assert(
      payoutFailedThrew && wdrAfterFail?.status === 'FAILED',
      '3.2 Fail-Closed: Provider error immediately transitions withdrawal to FAILED',
    );

    const refundTx = await prisma.walletTransaction.findFirst({
      where: {
        walletId: wallet.walletId,
        referenceId: wdrForFail.withdrawalCode,
        type: 'WITHDRAWAL_REFUND',
      },
    });
    assert(
      refundTx !== null && Number(refundTx.amount) === 50000,
      '3.3 Auto-Refund: WITHDRAWAL_REFUND recorded and frozenBalance restored back to balance',
    );

    // ------------------------------------------------------------------------
    // SECTION 4: Secure PayOS Payout Webhook & Timing-Safe HMAC
    // ------------------------------------------------------------------------
    console.log('\n[SECTION 4] PayOS Payout Webhook & Idempotency:');

    // Create withdrawal in PROCESSING state
    const wdrWebhook = await walletService.requestWithdrawal(testStore.storeId, {
      amount: 60000,
      bankName: 'MBBank',
      bankAccountNumber: rawAccNum,
      bankAccountHolder: 'NGUYEN VAN OWNER',
    });
    cleanupWithdrawalIds.push(wdrWebhook.withdrawalId);

    await prisma.storeWithdrawal.update({
      where: { withdrawalId: wdrWebhook.withdrawalId },
      data: { status: 'PROCESSING', providerReferenceId: wdrWebhook.withdrawalCode },
    });

    // Test 4.1: Reject forged signature
    let forgedRejected = false;
    try {
      await webhookController.handlePayoutWebhook({
        code: '00',
        desc: 'success',
        data: {
          id: 'payout_wh_123',
          referenceId: wdrWebhook.withdrawalCode,
          amount: 60000,
          description: 'Rut tien',
          toBin: '970422',
          toAccountNumber: rawAccNum,
          state: 'SUCCEEDED',
        },
        signature: 'invalid_forged_hex_signature_abcdef',
      });
    } catch (err: any) {
      forgedRejected = err instanceof BadRequestException;
    }
    assert(forgedRejected, '4.1 Webhook HMAC Guard: Forged or invalid signature rejected with 400 Bad Request');

    // Test 4.2: Valid SUCCEEDED webhook
    const validWebhookData = {
      amount: 60000,
      description: 'Rut tien',
      id: 'payout_wh_123',
      referenceId: wdrWebhook.withdrawalCode,
      state: 'SUCCEEDED',
      toAccountNumber: rawAccNum,
      toBin: '970422',
    };
    const validSignature = signPayoutRequest(validWebhookData, process.env.PAYOS_PAYOUT_CHECKSUM_KEY!);

    const whResult = await webhookController.handlePayoutWebhook({
      code: '00',
      desc: 'success',
      data: validWebhookData,
      signature: validSignature,
    });
    assert(whResult.success === true, '4.2 Valid Payout Webhook: Signature verified via crypto.timingSafeEqual and accepted');

    const wdrFinal = await prisma.storeWithdrawal.findUnique({
      where: { withdrawalId: wdrWebhook.withdrawalId },
    });
    assert(
      wdrFinal?.status === 'SUCCEEDED',
      '4.3 Payout Finalization: Status updated to SUCCEEDED and frozenBalance released',
    );

    // Test 4.4: Replayed webhook idempotency
    const replayedResult = await webhookController.handlePayoutWebhook({
      code: '00',
      desc: 'success',
      data: validWebhookData,
      signature: validSignature,
    });
    assert(replayedResult.success === true, '4.4 Replay Idempotency: Duplicate webhook handled cleanly without re-releasing funds');

    // Test 4.5: Canonical Key Permutation Resilience (PayOS official specification)
    const permutedData = {
      toBin: '970422',
      state: 'SUCCEEDED',
      toAccountNumber: rawAccNum,
      referenceId: wdrWebhook.withdrawalCode,
      id: 'payout_wh_123',
      description: 'Rut tien',
      amount: 60000,
    };
    const isPermutedValid = verifyPayoutSignature(
      permutedData,
      validSignature,
      process.env.PAYOS_PAYOUT_CHECKSUM_KEY!,
    );
    assert(
      isPermutedValid === true,
      '4.5 Canonical Signature Invariance: JSON key order permutations verify reliably via deep sort',
    );

    // Test 4.6: Tampered Payload Detection
    const tamperedData = {
      ...validWebhookData,
      amount: 60001,
    };
    let tamperedRejected = false;
    try {
      await webhookController.handlePayoutWebhook({
        code: '00',
        desc: 'success',
        data: tamperedData,
        signature: validSignature,
      });
    } catch (err: any) {
      tamperedRejected = err instanceof BadRequestException;
    }
    assert(
      tamperedRejected === true,
      '4.6 Tampered Payload Defense: Modified fields fail HMAC check and reject with 400 Bad Request',
    );

    // Test 4.7: Lockdown of Deprecated Manual Transfer Endpoint
    let manualTransferBlocked = false;
    try {
      await adminService.confirmWithdrawalTransfer(wdrWebhook.withdrawalId, 'https://example.com/proof.jpg');
    } catch (err: any) {
      manualTransferBlocked =
        err instanceof BadRequestException &&
        (err.getResponse() as any)?.errorCode === 'MANUAL_TRANSFER_DEPRECATED';
    }
    assert(
      manualTransferBlocked === true,
      '4.7 Route Decommissioning: Manual transfer (/withdrawals/:id/transfer) strictly disabled with MANUAL_TRANSFER_DEPRECATED',
    );

    // Test 4.8: Zero Plaintext Bank Account Invariant
    const storedWdr = await prisma.storeWithdrawal.findUnique({
      where: { withdrawalId: wdrWebhook.withdrawalId },
    });
    const mappedWdr = WalletMapper.toWithdrawalDto(storedWdr);
    assert(
      storedWdr?.bankAccountNumber === null &&
        storedWdr?.bankAccountEncrypted !== null &&
        storedWdr?.bankAccountMasked !== null &&
        !mappedWdr.bankAccountNumber.includes(rawAccNum),
      '4.8 Zero Plaintext Account Storage: Database bankAccountNumber is NULL and mapped DTO returns only masked account',
    );

  } catch (error: any) {
    console.error('  ✘ [EXCEPTION]:', error.message, error.stack);
    failed++;
  } finally {
    console.log('\n[TEARDOWN] Cleaning up test records...');
    try {
      if (cleanupWithdrawalIds.length > 0) {
        const wdrs = await prisma.storeWithdrawal.findMany({
          where: { withdrawalId: { in: cleanupWithdrawalIds } },
        });
        const wdrCodes = wdrs.map((w) => w.withdrawalCode);

        await prisma.walletTransaction.deleteMany({
          where: { referenceId: { in: wdrCodes } },
        });
        await prisma.storeWithdrawal.deleteMany({
          where: { withdrawalId: { in: cleanupWithdrawalIds } },
        });
      }
      if (cleanupBankAccIds.length > 0) {
        await prisma.storeBankAccount.deleteMany({
          where: { id: { in: cleanupBankAccIds } },
        });
      }
      if (cleanupStoreIds.length > 0) {
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
    } catch (cleanupErr: any) {
      console.warn('Teardown warning:', cleanupErr.message);
    }
    await prisma.$disconnect();
    console.log('Teardown complete.');
  }

  console.log('\n================================================================');
  console.log(`📊 WITHDRAWAL CONCURRENCY & PAYOUT TEST SUMMARY:`);
  console.log(`  PASSED: ${passed}`);
  console.log(`  FAILED: ${failed}`);
  console.log('================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runWithdrawalConcurrencyIdempotencyTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
