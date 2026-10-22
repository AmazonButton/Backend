import * as crypto from 'crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { BankVerificationRepository } from '../src/bank-verification/bank-verification.repository';
import { PayOSBankVerificationProvider } from '../src/bank-verification/providers/payos-bank-verification.provider';
import { BankVerificationService } from '../src/bank-verification/bank-verification.service';
import { BanksController } from '../src/bank-verification/banks.controller';
import { StoreBankAccountsController } from '../src/bank-verification/store-bank-accounts.controller';
import { BankVerificationWebhookController } from '../src/bank-verification/bank-verification-webhook.controller';
import { StoreWalletService } from '../src/store-wallet/store-wallet.service';
import { CryptoVaultUtil } from '../src/common/utils/crypto-vault.util';
import {
  BadRequestException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';

async function runBankVerificationTests() {
  console.log('================================================================');
  console.log('🚀 SUITE 13: Penny-Deposit Bank Account Verification (2.000 VND)');
  console.log('================================================================\n');

  process.env.BANK_VERIFICATION_AMOUNT_VND = '2000';
  process.env.BANK_VERIFICATION_EXPIRY_MINUTES = '30';
  process.env.BANK_VERIFICATION_WEBHOOK_SECRET = 'test_bank_webhook_secret_key_12345';
  process.env.BANK_VERIFICATION_STRICT = 'true';
  process.env.BANK_VERIFICATION_MOCK = 'true';
  process.env.NODE_ENV = 'test';

  const prisma = new PrismaService();
  await prisma.$connect();

  const repository = new BankVerificationRepository(prisma);
  const provider = new PayOSBankVerificationProvider();
  const service = new BankVerificationService(prisma, repository, provider);
  const banksController = new BanksController(service);
  const storeBankAccountsController = new StoreBankAccountsController(service);
  const webhookController = new BankVerificationWebhookController(service);
  const walletService = new StoreWalletService(prisma);

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
  const cleanupBankAccIds: bigint[] = [];
  const cleanupTxIds: bigint[] = [];
  const cleanupStoreIds: bigint[] = [];
  const cleanupUserIds: bigint[] = [];
  const cleanupStaffIds: bigint[] = [];

  try {
    // ------------------------------------------------------------------------
    // SETUP: Create isolated test store, owner user & active staff user
    // ------------------------------------------------------------------------
    const testUsername = `bank_test_user_${Date.now()}`;
    const testUser = await prisma.user.create({
      data: {
        username: testUsername,
        fullName: 'Nguyen Van Owner',
        email: `${testUsername}@example.com`,
        status: 'ACTIVE',
      },
    });
    cleanupUserIds.push(testUser.userId);

    const staffUsername = `bank_test_staff_${Date.now()}`;
    const staffUser = await prisma.user.create({
      data: {
        username: staffUsername,
        fullName: 'Nguyen Van Staff',
        email: `${staffUsername}@example.com`,
        status: 'ACTIVE',
      },
    });
    cleanupUserIds.push(staffUser.userId);

    const testStore = await prisma.store.create({
      data: {
        name: 'Bank Verification Test Store',
        code: `STR_BV_${Date.now()}`,
        phone: '0901234567',
        address: '123 Testing St',
        ownerUserId: testUser.userId,
        status: 'ACTIVE',
      },
    });
    cleanupStoreIds.push(testStore.storeId);

    let staffRole = await prisma.role.findFirst({ where: { roleCode: 'STAFF' } });
    if (!staffRole) {
      staffRole = await prisma.role.findFirst();
    }
    if (!staffRole) {
      staffRole = await prisma.role.create({
        data: { roleCode: 'STAFF', roleName: 'Staff Member' },
      });
    }

    const staffRecord = await prisma.storeStaff.create({
      data: {
        storeId: testStore.storeId,
        userId: staffUser.userId,
        roleId: staffRole.roleId,
        status: 'ACTIVE',
      },
    });
    cleanupStaffIds.push(staffRecord.storeStaffId);

    // Initialize wallet with balance
    const wallet = await walletService.getOrCreateStoreWallet(testStore.storeId);
    await prisma.storeWallet.update({
      where: { walletId: wallet.walletId },
      data: { balance: 500000 },
    });

    // ------------------------------------------------------------------------
    // SECTION 1: Banks Directory, Lookup & Provider Fail-Closed Tests
    // ------------------------------------------------------------------------
    console.log('[SECTION 1] Banks Directory, Lookup & Fail-Closed Tests:');

    // Test 1.1: GET /banks
    const banksResult = banksController.getBanks();
    assert(
      banksResult.success === true &&
        Array.isArray(banksResult.data) &&
        banksResult.data.length >= 20 &&
        banksResult.data.some((b: any) => b.bin === '970422' && b.shortName === 'MBBank'),
      '1.1 GET /api/v1/banks returns official list of Vietnam banks',
    );

    // Test 1.2: Valid Lookup
    const lookupRes = await storeBankAccountsController.lookupAccount({
      bankBin: '970422',
      accountNumber: '0987654321',
    });
    assert(
      lookupRes.success === true &&
        lookupRes.data.bankName === 'MBBank' &&
        lookupRes.data.accountNumberMasked.includes('***') &&
        lookupRes.data.accountName === 'NGUYEN VAN A',
      '1.2 POST /stores/bank-accounts/lookup successfully returns masked account and owner name',
    );

    // Test 1.3: Invalid BIN
    let invalidBinThrew = false;
    try {
      await storeBankAccountsController.lookupAccount({
        bankBin: '000000',
        accountNumber: '0987654321',
      });
    } catch (err: any) {
      invalidBinThrew = err instanceof BadRequestException;
    }
    assert(invalidBinThrew, '1.3 POST /stores/bank-accounts/lookup rejects invalid BIN with 400 Bad Request');

    // Test 1.4: Invalid Account Number length
    let invalidAccThrew = false;
    try {
      await storeBankAccountsController.lookupAccount({
        bankBin: '970422',
        accountNumber: '12',
      });
    } catch (err: any) {
      invalidAccThrew = err instanceof BadRequestException;
    }
    assert(invalidAccThrew, '1.4 POST /stores/bank-accounts/lookup rejects short account number with 400 Bad Request');

    // Test 1.5 (High 1 & Medium 7): Fail-closed on missing provider when BANK_VERIFICATION_MOCK !== 'true'
    process.env.BANK_VERIFICATION_MOCK = 'false';
    let mockDisabledThrew = false;
    try {
      await provider.createRefund({
        bankBin: '970422',
        accountNumber: '0987654321',
        accountName: 'TEST',
        amount: 2000,
        referenceId: 'REF_TEST_FAIL_CLOSED',
        description: 'Test fail closed',
      });
    } catch (err: any) {
      mockDisabledThrew = err instanceof ServiceUnavailableException;
    }
    process.env.BANK_VERIFICATION_MOCK = 'true'; // Restore for following tests
    assert(
      mockDisabledThrew,
      '1.5 Fail-Closed: Payout throws ServiceUnavailableException when BANK_VERIFICATION_MOCK !== "true"',
    );

    // ------------------------------------------------------------------------
    // SECTION 2: Create Verification Request, Client Zero Trust & RBAC
    // ------------------------------------------------------------------------
    console.log('\n[SECTION 2] Create 2.000 VND Verification, Zero Trust & RBAC Tests:');

    const testAccNumber = '123456789012';

    // Test 2.1 (High 4): Client tries to spoof accountName & bankName -> Server ignores them and uses official provider lookup
    const verifyReq = await storeBankAccountsController.createVerification(
      {
        storeId: testStore.storeId.toString(),
        bankBin: '970422',
        accountNumber: testAccNumber,
        accountName: 'TEN_GIA_MAO',
        bankName: 'BANK_GIA_MAO',
      } as any,
      { user: { userId: testUser.userId.toString() } },
    );

    assert(
      verifyReq.success === true &&
        verifyReq.data.amount === 2000 &&
        verifyReq.data.referenceCode.startsWith('VERIFY_') &&
        verifyReq.data.bankName === 'MBBank' &&
        verifyReq.data.accountName === 'NGUYEN VAN A' &&
        verifyReq.data.accountNumberMasked === '******012',
      '2.1 Zero-Trust Client: Client-supplied accountName & bankName are IGNORED in favor of server lookup',
    );

    const createdTxId = BigInt(verifyReq.data.verificationId);
    const createdAccId = BigInt(verifyReq.data.bankAccountId);
    cleanupTxIds.push(createdTxId);
    cleanupBankAccIds.push(createdAccId);

    // Test 2.2: Verify database record has AES-256 encrypted account number and NOT plaintext
    const dbAcc = await repository.findBankAccountById(createdAccId);
    assert(
      dbAcc !== null &&
        dbAcc.accountNumberEncrypted.includes(':') &&
        !dbAcc.accountNumberEncrypted.includes(testAccNumber) &&
        CryptoVaultUtil.decryptAccountNumber(dbAcc.accountNumberEncrypted) === testAccNumber,
      '2.2 Account number is AES-256-GCM encrypted in database with zero plaintext storage',
    );

    // Test 2.3 (High 5): Staff user cannot manage store bank accounts
    let staffThrew = false;
    try {
      await storeBankAccountsController.createVerification(
        {
          storeId: testStore.storeId.toString(),
          bankBin: '970422',
          accountNumber: '999988887777',
        },
        { user: { userId: staffUser.userId.toString() } },
      );
    } catch (err: any) {
      staffThrew = err instanceof ForbiddenException;
    }
    assert(staffThrew, '2.3 RBAC Security: Active Store Staff is BLOCKED from managing bank accounts (403 Forbidden)');

    // Test 2.4: Non-owner / stranger user rejected with 403 Forbidden
    let bolaThrew = false;
    try {
      await storeBankAccountsController.createVerification(
        {
          storeId: testStore.storeId.toString(),
          bankBin: '970422',
          accountNumber: '999988887777',
        },
        { user: { userId: '999999' } },
      );
    } catch (err: any) {
      bolaThrew = err instanceof ForbiddenException;
    }
    assert(bolaThrew, '2.4 BOLA Protection: Non-owner stranger user rejected with 403 Forbidden');

    // ------------------------------------------------------------------------
    // SECTION 3: Webhook Inbound Verification, Cross-Check & Dynamic Refund
    // ------------------------------------------------------------------------
    console.log('\n[SECTION 3] Webhook Verification, Cross-Check & Dynamic Refund:');

    const secret = process.env.BANK_VERIFICATION_WEBHOOK_SECRET!;
    const refCode = verifyReq.data.referenceCode;

    function signPayload(bodyObj: any): string {
      const raw = Buffer.from(JSON.stringify(bodyObj), 'utf8');
      return crypto.createHmac('sha256', secret).update(raw).digest('hex');
    }

    // Test 3.0 (High 2): Fail-closed on missing providerTransactionId
    let missingTxIdThrew = false;
    try {
      await service.handleVerificationWebhook({
        amount: 2000,
        description: `Thanh toan tien ${refCode}`,
        referenceCode: refCode,
      });
    } catch (err: any) {
      missingTxIdThrew = err instanceof BadRequestException;
    }
    assert(
      missingTxIdThrew,
      '3.0 Fail-Closed: Missing providerTransactionId throws BadRequestException (no dummy random ID)',
    );

    // Test 3.1: Inbound webhook with wrong amount (1.000 VND instead of 2.000 VND)
    const wrongAmountWebhook = {
      providerTransactionId: `txn_wrong_${Date.now()}`,
      amount: 1000,
      description: `Thanh toan tien ${refCode}`,
      referenceCode: refCode,
    };
    const wrongAmountRes = await service.handleVerificationWebhook(wrongAmountWebhook);
    assert(
      wrongAmountRes.success === false && wrongAmountRes.reason === 'AMOUNT_MISMATCH',
      '3.1 Webhook with 1.000 VND rejected: marked FAILED and denied ownership verification',
    );

    // Test 3.2: Verify DB transaction is marked FAILED and account is still PENDING
    const failedTx = await prisma.bankAccountVerificationTransaction.findUnique({
      where: { id: createdTxId },
    });
    const stillPendingAcc = await repository.findBankAccountById(createdAccId);
    assert(
      failedTx?.status === 'FAILED' && stillPendingAcc?.verificationStatus === 'PENDING',
      '3.2 Database transaction status updated to FAILED and account remains PENDING',
    );

    // Reset transaction back to PENDING for subsequent tests
    await prisma.bankAccountVerificationTransaction.update({
      where: { id: createdTxId },
      data: { status: 'PENDING', receivedAmount: null },
    });

    // Test 3.3 (High 3): Webhook with senderAccountNumber mismatch rejected
    const senderMismatchWebhook = {
      providerTransactionId: `txn_mismatch_${Date.now()}`,
      amount: 2000,
      description: `Chuyen tien ${refCode}`,
      referenceCode: refCode,
      senderAccountNumber: '999999999999', // Registered account is testAccNumber: 123456789012
    };
    const senderMismatchRes = await service.handleVerificationWebhook(senderMismatchWebhook);
    assert(
      senderMismatchRes.success === false && senderMismatchRes.reason === 'SENDER_ACCOUNT_MISMATCH',
      '3.3 Webhook Cross-Check: Sender account mismatch rejected with SENDER_ACCOUNT_MISMATCH',
    );

    // Reset back to PENDING
    await prisma.bankAccountVerificationTransaction.update({
      where: { id: createdTxId },
      data: { status: 'PENDING', receivedAmount: null },
    });

    // Test 3.4: Webhook with wrong reference code
    const wrongRefWebhook = {
      providerTransactionId: `txn_wrongref_${Date.now()}`,
      amount: 2000,
      description: 'Chuyen khoan khong co ma',
    };
    const wrongRefRes = await service.handleVerificationWebhook(wrongRefWebhook);
    assert(
      wrongRefRes.success === false && wrongRefRes.message?.includes('Nội dung giao dịch không chứa mã'),
      '3.4 Webhook with missing or invalid referenceCode rejected safely',
    );

    // Test 3.5: Webhook with expired transaction
    await prisma.bankAccountVerificationTransaction.update({
      where: { id: createdTxId },
      data: { expiresAt: new Date(Date.now() - 60000) },
    });
    const expiredWebhook = {
      providerTransactionId: `txn_exp_${Date.now()}`,
      amount: 2000,
      description: `Chuyen khoan ${refCode}`,
      referenceCode: refCode,
    };
    const expiredRes = await service.handleVerificationWebhook(expiredWebhook);
    assert(
      expiredRes.success === false && expiredRes.reason === 'EXPIRED',
      '3.5 Webhook with expired transaction (past 30 mins) marked EXPIRED and rejected',
    );

    // Reset back to future expiry & PENDING
    await prisma.bankAccountVerificationTransaction.update({
      where: { id: createdTxId },
      data: {
        status: 'PENDING',
        expiresAt: new Date(Date.now() + 1800000),
        receivedAmount: null,
      },
    });

    // Test 3.6: Valid Inbound Webhook (with matching senderAccountNumber)
    const validProviderTxId = `txn_valid_${Date.now()}`;
    const validWebhook = {
      providerTransactionId: validProviderTxId,
      amount: 2000,
      description: `Thanh toan xac minh tai khoan ${refCode} MB`,
      referenceCode: refCode,
      senderAccountNumber: testAccNumber,
    };
    const validRes = await service.handleVerificationWebhook(validWebhook);
    assert(
      validRes.success === true && validRes.message?.includes('thành công'),
      '3.6 Valid 2.000 VND webhook with matching sender account processed successfully',
    );

    // Test 3.7 & 3.8 (Medium 6): Verify OWNERSHIP_VERIFIED and dynamic refund
    const verifiedDbAcc = await repository.findBankAccountById(createdAccId);
    const verifiedDbTx = await prisma.bankAccountVerificationTransaction.findUnique({
      where: { id: createdTxId },
    });
    assert(
      verifiedDbAcc?.verificationStatus === 'OWNERSHIP_VERIFIED' &&
        verifiedDbAcc.verifiedAt !== null &&
        verifiedDbTx?.status === 'REFUNDED' &&
        verifiedDbTx?.refundStatus === 'SUCCESS' &&
        Number(verifiedDbTx?.receivedAmount) === 2000 &&
        verifiedDbTx?.refundTransactionId?.startsWith('mock_refund_'),
      '3.7 Account transitioned to OWNERSHIP_VERIFIED and dynamic automated refund completed',
    );

    // Test 3.9: Idempotency (Duplicate webhook delivery)
    const duplicateRes = await service.handleVerificationWebhook(validWebhook);
    assert(
      duplicateRes.success === true && duplicateRes.message?.includes('Idempotent'),
      '3.8 Replayed webhook is idempotent: returns success without duplicate refund',
    );

    // Test 3.10: Webhook Guard Signature Verification
    const rawValidPayload = Buffer.from(JSON.stringify(validWebhook), 'utf8');
    const validSig = signPayload(validWebhook);
    const isWebhookValid = provider.verifyWebhook(rawValidPayload, validSig, {});
    const isWebhookInvalid = provider.verifyWebhook(rawValidPayload, 'invalid_sig_000', {});
    assert(
      isWebhookValid === true && isWebhookInvalid === false,
      '3.9 BankVerificationWebhookGuard verifies HMAC-SHA256 signature and blocks forgery',
    );

    // ------------------------------------------------------------------------
    // SECTION 4: Concurrency & Row Locking Race Condition Tests
    // ------------------------------------------------------------------------
    console.log('\n[SECTION 4] Concurrency Race-Condition Tests (SELECT FOR UPDATE):');

    const concReq = await storeBankAccountsController.createVerification(
      {
        storeId: testStore.storeId.toString(),
        bankBin: '970436',
        accountNumber: '998877665544',
      },
      { user: { userId: testUser.userId.toString() } },
    );
    const concTxId = BigInt(concReq.data.verificationId);
    const concAccId = BigInt(concReq.data.bankAccountId);
    const concRef = concReq.data.referenceCode;
    cleanupTxIds.push(concTxId);
    cleanupBankAccIds.push(concAccId);

    const parallelWebhook1 = {
      providerTransactionId: `txn_conc_1_${Date.now()}`,
      amount: 2000,
      description: `Chuyen tien ${concRef}`,
      referenceCode: concRef,
    };
    const parallelWebhook2 = {
      providerTransactionId: `txn_conc_2_${Date.now()}`,
      amount: 2000,
      description: `Chuyen tien ${concRef}`,
      referenceCode: concRef,
    };

    const concurrentResults = await Promise.all([
      service.handleVerificationWebhook(parallelWebhook1),
      service.handleVerificationWebhook(parallelWebhook2),
    ]);

    const successes = concurrentResults.filter((r) => r.success === true);
    assert(
      successes.length === 2 &&
        (concurrentResults[0].message?.includes('Idempotent') ||
          concurrentResults[1].message?.includes('Idempotent')),
      '4.1 Concurrent parallel webhooks resolved safely via SELECT FOR UPDATE row locking without race conditions',
    );

    // ------------------------------------------------------------------------
    // SECTION 5: Store Wallet Withdrawal Enforcement Guard Tests
    // ------------------------------------------------------------------------
    console.log('\n[SECTION 5] Store Wallet Withdrawal Verification Guard:');

    const unverifiedUser = await prisma.user.create({
      data: {
        username: `unverified_user_${Date.now()}`,
        fullName: 'Unverified Owner',
        email: `unverified_${Date.now()}@example.com`,
        status: 'ACTIVE',
      },
    });
    cleanupUserIds.push(unverifiedUser.userId);

    const unverifiedStore = await prisma.store.create({
      data: {
        name: 'Unverified Test Store',
        code: `STR_UNVER_${Date.now()}`,
        phone: '0909999888',
        address: '456 Unverified St',
        ownerUserId: unverifiedUser.userId,
        status: 'ACTIVE',
      },
    });
    cleanupStoreIds.push(unverifiedStore.storeId);

    const unverifiedWallet = await walletService.getOrCreateStoreWallet(unverifiedStore.storeId);
    await prisma.storeWallet.update({
      where: { walletId: unverifiedWallet.walletId },
      data: { balance: 300000 },
    });

    let unverifiedThrew = false;
    let unverifiedErrorCode = '';
    try {
      await walletService.requestWithdrawal(unverifiedStore.storeId, {
        amount: 100000,
      });
    } catch (err: any) {
      unverifiedThrew = true;
      unverifiedErrorCode = err.response?.errorCode || err.message;
    }
    assert(
      unverifiedThrew && unverifiedErrorCode === 'BANK_ACCOUNT_NOT_VERIFIED',
      '5.1 Withdrawal rejected with BANK_ACCOUNT_NOT_VERIFIED when store has no verified bank account',
    );

    const withdrawalRes = await walletService.requestWithdrawal(testStore.storeId, {
      amount: 100000,
    });
    assert(
      withdrawalRes !== null &&
        Number(withdrawalRes.amount) === 100000 &&
        withdrawalRes.status === 'PENDING' &&
        withdrawalRes.bankAccountNumber.length >= 6,
      '5.2 Withdrawal permitted and created successfully when store bank account is OWNERSHIP_VERIFIED',
    );

    if (withdrawalRes?.withdrawalId) {
      await prisma.walletTransaction.deleteMany({
        where: { walletId: wallet.walletId },
      });
      await prisma.storeWithdrawal.delete({
        where: { withdrawalId: withdrawalRes.withdrawalId },
      });
    }

    // ------------------------------------------------------------------------
    // SECTION 6: Account Management (Set Default, Cancel Pending, Delete)
    // ------------------------------------------------------------------------
    console.log('\n[SECTION 6] Account Management Functional Gap Tests:');

    // Test 6.1: Set Default Bank Account
    const defaultRes = await storeBankAccountsController.setDefaultBankAccount(
      testStore.storeId.toString(),
      createdAccId.toString(),
      { user: { userId: testUser.userId.toString() } },
    );
    const updatedAcc = await repository.findBankAccountById(createdAccId);
    assert(
      defaultRes.success === true && updatedAcc?.isDefault === true,
      '6.1 PATCH /stores/:storeId/bank-accounts/:id/default sets bank account as default',
    );

    // Test 6.2: Cancel Pending Verification Request
    const pendingReq = await storeBankAccountsController.createVerification(
      {
        storeId: testStore.storeId.toString(),
        bankBin: '970407', // Techcombank
        accountNumber: '190399887766',
      },
      { user: { userId: testUser.userId.toString() } },
    );
    const pendingTxId = BigInt(pendingReq.data.verificationId);
    const pendingAccId = BigInt(pendingReq.data.bankAccountId);
    cleanupTxIds.push(pendingTxId);
    cleanupBankAccIds.push(pendingAccId);

    const cancelRes = await storeBankAccountsController.cancelVerification(
      pendingReq.data.verificationId,
      { user: { userId: testUser.userId.toString() } },
    );
    const cancelledTx = await prisma.bankAccountVerificationTransaction.findUnique({
      where: { id: pendingTxId },
    });
    assert(
      cancelRes.success === true && cancelledTx?.status === 'EXPIRED',
      '6.2 POST /stores/bank-accounts/verification/:id/cancel cancels pending verification (EXPIRED)',
    );

    // Test 6.3: Delete Bank Account
    const deleteRes = await storeBankAccountsController.deleteBankAccount(
      testStore.storeId.toString(),
      pendingAccId.toString(),
      { user: { userId: testUser.userId.toString() } },
    );
    const deletedAcc = await repository.findBankAccountById(pendingAccId);
    assert(
      deleteRes.success === true && deletedAcc === null,
      '6.3 DELETE /stores/:storeId/bank-accounts/:id successfully deletes revoked/unverified account',
    );

  } catch (error: any) {
    console.error('Unhandled test suite error:', error);
    failed++;
  } finally {
    // ------------------------------------------------------------------------
    // CLEANUP: Zero-Residue Database Teardown
    // ------------------------------------------------------------------------
    console.log('\n[TEARDOWN] Cleaning up test records...');
    try {
      if (cleanupTxIds.length > 0) {
        await prisma.bankAccountVerificationTransaction.deleteMany({
          where: { id: { in: cleanupTxIds } },
        });
      }
      if (cleanupBankAccIds.length > 0) {
        await prisma.storeBankAccount.deleteMany({
          where: { id: { in: cleanupBankAccIds } },
        });
      }
      if (cleanupStaffIds.length > 0) {
        await prisma.storeStaff.deleteMany({
          where: { storeStaffId: { in: cleanupStaffIds } },
        });
      }
      if (cleanupStoreIds.length > 0) {
        await prisma.walletTransaction.deleteMany({
          where: { wallet: { storeId: { in: cleanupStoreIds } } },
        });
        await prisma.storeWithdrawal.deleteMany({
          where: { storeId: { in: cleanupStoreIds } },
        });
        await prisma.storeWallet.deleteMany({
          where: { storeId: { in: cleanupStoreIds } },
        });
        await prisma.storeBankAccount.deleteMany({
          where: { storeId: { in: cleanupStoreIds } },
        });
        await prisma.storeStaff.deleteMany({
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
      console.log('Teardown complete.');
    } catch (cleanupErr: any) {
      console.warn('Cleanup warning:', cleanupErr?.message);
    }
    await prisma.$disconnect();
  }

  console.log('\n================================================================');
  console.log(`📊 BANK ACCOUNT VERIFICATION TEST SUMMARY:`);
  console.log(`  PASSED: ${passed}`);
  console.log(`  FAILED: ${failed}`);
  console.log('================================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runBankVerificationTests();
