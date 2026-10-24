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
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { BankLookupRateLimitGuard } from '../src/bank-verification/guards/bank-lookup-rate-limit.guard';

async function runBankVerificationTests() {
  console.log('================================================================');
  console.log('🚀 SUITE 13: Penny-Deposit Bank Account Verification (2.000 VND)');
  console.log('================================================================\n');

  process.env.BANK_VERIFICATION_AMOUNT_VND = '2000';
  process.env.BANK_VERIFICATION_EXPIRY_MINUTES = '30';
  process.env.BANK_VERIFICATION_WEBHOOK_SECRET = 'test_bank_webhook_secret_key_12345';
  process.env.PLATFORM_BANK_ACCOUNT_NUMBER = '999888777666';
  process.env.PLATFORM_BANK_BIN = '970422';
  process.env.PAYOS_CLIENT_ID = 'test_payos_client_id_123';
  process.env.PAYOS_API_KEY = 'test_payos_api_key_123';
  process.env.PAYOS_CHECKSUM_KEY = 'test_payos_checksum_key_123';
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

    // Test 1.6 (Risk 7): Lookup Rate Limiting Guard (15 req/min cap)
    const rateLimitGuard = new BankLookupRateLimitGuard();
    BankLookupRateLimitGuard.reset();
    const mockContext = {
      switchToHttp: () => ({
        getRequest: () => ({
          user: { userId: 'rate_limit_test_user' },
          ip: '127.0.0.1',
          headers: {},
        }),
      }),
    } as any;

    let allowedCount = 0;
    for (let i = 0; i < 15; i++) {
      if (await rateLimitGuard.canActivate(mockContext)) {
        allowedCount++;
      }
    }
    let rateLimitBlocked = false;
    try {
      await rateLimitGuard.canActivate(mockContext);
    } catch (err: any) {
      rateLimitBlocked =
        err instanceof HttpException && err.getStatus() === HttpStatus.TOO_MANY_REQUESTS;
    }
    await BankLookupRateLimitGuard.reset();
    assert(
      allowedCount === 15 && rateLimitBlocked,
      '1.6 Anti-Enumeration: BankLookupRateLimitGuard allows 15 lookups/min and blocks 16th with 429 Too Many Requests',
    );

    // Test 1.6b: Production Anti-Bypass (Redis missing/offline in production throws 503 Service Unavailable)
    process.env.NODE_ENV = 'production';
    let prodRedisFailClosed = false;
    try {
      await rateLimitGuard.canActivate(mockContext);
    } catch (err: any) {
      prodRedisFailClosed =
        err instanceof HttpException && err.getStatus() === HttpStatus.SERVICE_UNAVAILABLE;
    }
    process.env.NODE_ENV = 'test';
    assert(
      prodRedisFailClosed,
      '1.6b Production Anti-Bypass: BankLookupRateLimitGuard throws 503 Service Unavailable when Redis is unavailable in production (RAM fallback banned)',
    );

    // Test 1.7 (Risk 4): Lookup Opaque Error Handling (No vendor error leaks to client)
    const originalLookup = provider.lookupAccount.bind(provider);
    provider.lookupAccount = async () => {
      throw new Error('Internal VietQR stack trace leak with secret credentials');
    };
    let opaqueLookupMessage = '';
    try {
      await service.lookupBankAccount({ bankBin: '970422', accountNumber: '0987654321' });
    } catch (err: any) {
      opaqueLookupMessage = err.message;
    }
    provider.lookupAccount = originalLookup;
    assert(
      opaqueLookupMessage === 'Không thể xác minh tài khoản ngân hàng lúc này',
      '1.7 Zero Vendor Leakage: lookupBankAccount returns opaque fixed error and hides vendor error message',
    );

    // Test 1.8 (Risk 6): Fail-Fast Boot: onModuleInit throws fatal Error if BANK_VERIFICATION_MOCK is true in production
    process.env.NODE_ENV = 'production';
    process.env.BANK_VERIFICATION_MOCK = 'true';
    let prodMockBlocked = false;
    try {
      service.onModuleInit();
    } catch (err: any) {
      prodMockBlocked = err.message.includes('BANK_VERIFICATION_MOCK must be disabled in production');
    }
    assert(
      prodMockBlocked,
      '1.8 Production Boot Guard: onModuleInit throws fatal error if BANK_VERIFICATION_MOCK is true in production',
    );

    // Test 1.9 (Risk 5): Fail-Fast Boot: onModuleInit throws fatal Error if any required production secret is missing
    process.env.BANK_VERIFICATION_MOCK = 'false';
    const originalPlatformAcc = process.env.PLATFORM_BANK_ACCOUNT_NUMBER;
    delete process.env.PLATFORM_BANK_ACCOUNT_NUMBER;
    let missingPlatformAccBlocked = false;
    try {
      service.onModuleInit();
    } catch (err: any) {
      missingPlatformAccBlocked = err.message.includes('PLATFORM_BANK_ACCOUNT_NUMBER must be configured in production');
    }
    process.env.PLATFORM_BANK_ACCOUNT_NUMBER = originalPlatformAcc;

    delete process.env.PLATFORM_BANK_BIN;
    let missingPlatformBinBlocked = false;
    try {
      service.onModuleInit();
    } catch (err: any) {
      missingPlatformBinBlocked = err.message.includes('PLATFORM_BANK_BIN must be configured in production');
    }
    process.env.PLATFORM_BANK_BIN = '970422';

    delete process.env.PAYOS_CLIENT_ID;
    let missingPayosClientIdBlocked = false;
    try {
      service.onModuleInit();
    } catch (err: any) {
      missingPayosClientIdBlocked = err.message.includes('PAYOS_CLIENT_ID must be configured in production');
    }
    process.env.PAYOS_CLIENT_ID = 'test_payos_client_id_123';

    delete process.env.REDIS_URL;
    delete process.env.REDIS_CACHE_URL;
    delete process.env.REDIS_HOST;
    let missingRedisBlocked = false;
    try {
      service.onModuleInit();
    } catch (err: any) {
      missingRedisBlocked = err.message.includes('REDIS_URL or REDIS_HOST must be configured in production');
    }
    process.env.REDIS_URL = 'redis://localhost:6379';

    assert(
      missingPlatformAccBlocked &&
        missingPlatformBinBlocked &&
        missingPayosClientIdBlocked &&
        missingRedisBlocked,
      '1.9 Production Boot Guard: onModuleInit throws fatal error if any mandatory secret or REDIS_URL is missing in production',
    );

    // Test 1.10: VietQR Credential Decoupling
    delete process.env.VIETQR_CLIENT_ID;
    delete process.env.VIETQR_API_KEY;
    process.env.BANK_VERIFICATION_MOCK = 'false';
    const originalPayosClient = process.env.PAYOS_CLIENT_ID;
    delete process.env.PAYOS_CLIENT_ID;
    let missingVietQRBlocked = false;
    try {
      await provider.lookupAccount('970422', '0987654321');
    } catch (err: any) {
      missingVietQRBlocked = err instanceof ServiceUnavailableException;
    }
    process.env.PAYOS_CLIENT_ID = originalPayosClient;
    assert(
      missingVietQRBlocked,
      '1.10 VietQR Credential Separation: lookupAccount throws ServiceUnavailableException if both VIETQR and PAYOS credentials are unconfigured in non-mock mode',
    );

    // Restore test environment variables
    process.env.NODE_ENV = 'test';
    process.env.BANK_VERIFICATION_MOCK = 'true';
    process.env.PLATFORM_BANK_ACCOUNT_NUMBER = '999888777666';
    process.env.PLATFORM_BANK_BIN = '970422';

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

    // Test 3.0 (High 2 & Risk 2): Fail-closed on missing providerTransactionId and reject paymentLinkId/orderCode fallback
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

    let fallbackIdRejected = false;
    try {
      await service.handleVerificationWebhook({
        amount: 2000,
        description: `Thanh toan tien ${refCode}`,
        referenceCode: refCode,
        data: {
          paymentLinkId: 'pl_test_123',
          orderCode: 998877,
        },
      } as any);
    } catch (err: any) {
      fallbackIdRejected =
        err instanceof BadRequestException &&
        err.message.includes('Missing provider transaction ID');
    }

    assert(
      missingTxIdThrew && fallbackIdRejected,
      '3.0 Fail-Closed: Missing providerTransactionId throws BadRequestException and paymentLinkId/orderCode are rejected',
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

    // Test 3.3a (Risk 1): Fail-closed when destinationAccountNumber is missing in strict mode + DB audit trail
    const missingDestWebhook = {
      providerTransactionId: `txn_miss_dest_${Date.now()}`,
      amount: 2000,
      description: `Chuyen tien ${refCode}`,
      referenceCode: refCode,
      destinationBankBin: '970422',
      senderBankBin: '970422',
      senderAccountNumber: testAccNumber,
    };
    const missingDestRes = await service.handleVerificationWebhook(missingDestWebhook);
    const dbTxMissingDest = await prisma.bankAccountVerificationTransaction.findUnique({
      where: { id: createdTxId },
    });
    assert(
      missingDestRes.success === false &&
        missingDestRes.reason === 'DESTINATION_ACCOUNT_UNVERIFIABLE' &&
        dbTxMissingDest?.status === 'FAILED' &&
        dbTxMissingDest?.failureReason === 'DESTINATION_ACCOUNT_UNVERIFIABLE',
      '3.3a Webhook Cross-Check: Missing destination account rejected with DESTINATION_ACCOUNT_UNVERIFIABLE and audited in DB',
    );

    // Reset back to PENDING
    await prisma.bankAccountVerificationTransaction.update({
      where: { id: createdTxId },
      data: { status: 'PENDING', receivedAmount: null, failureReason: null },
    });

    // Test 3.3a2 (Tertiary 1 & 6): Fail-closed when destinationBankBin is missing in strict mode + DB audit trail
    const missingDestBinWebhook = {
      providerTransactionId: `txn_miss_dest_bin_${Date.now()}`,
      amount: 2000,
      description: `Chuyen tien ${refCode}`,
      referenceCode: refCode,
      destinationAccountNumber: '999888777666',
      senderBankBin: '970422',
      senderAccountNumber: testAccNumber,
    };
    const missingDestBinRes = await service.handleVerificationWebhook(missingDestBinWebhook);
    const dbTxMissingDestBin = await prisma.bankAccountVerificationTransaction.findUnique({
      where: { id: createdTxId },
    });
    assert(
      missingDestBinRes.success === false &&
        missingDestBinRes.reason === 'DESTINATION_BANK_UNVERIFIABLE' &&
        dbTxMissingDestBin?.status === 'FAILED' &&
        dbTxMissingDestBin?.failureReason === 'DESTINATION_BANK_UNVERIFIABLE',
      '3.3a2 Webhook Cross-Check: Missing destination bank BIN rejected with DESTINATION_BANK_UNVERIFIABLE and audited in DB',
    );

    // Reset back to PENDING
    await prisma.bankAccountVerificationTransaction.update({
      where: { id: createdTxId },
      data: { status: 'PENDING', receivedAmount: null, failureReason: null },
    });

    // Test 3.3b (Risk 1): Fail-closed when senderAccountNumber is missing in strict mode + DB audit trail
    const missingSenderWebhook = {
      providerTransactionId: `txn_miss_sender_${Date.now()}`,
      amount: 2000,
      description: `Chuyen tien ${refCode}`,
      referenceCode: refCode,
      destinationBankBin: '970422',
      destinationAccountNumber: '999888777666',
      senderBankBin: '970422',
    };
    const missingSenderRes = await service.handleVerificationWebhook(missingSenderWebhook);
    const dbTxMissingSender = await prisma.bankAccountVerificationTransaction.findUnique({
      where: { id: createdTxId },
    });
    assert(
      missingSenderRes.success === false &&
        missingSenderRes.reason === 'SENDER_ACCOUNT_UNVERIFIABLE' &&
        dbTxMissingSender?.status === 'FAILED' &&
        dbTxMissingSender?.failureReason === 'SENDER_ACCOUNT_UNVERIFIABLE',
      '3.3b Webhook Cross-Check: Missing sender account rejected with SENDER_ACCOUNT_UNVERIFIABLE and audited in DB',
    );

    // Reset back to PENDING
    await prisma.bankAccountVerificationTransaction.update({
      where: { id: createdTxId },
      data: { status: 'PENDING', receivedAmount: null, failureReason: null },
    });

    // Test 3.3b2 (Tertiary 1 & 6): Fail-closed when senderBankBin is missing in strict mode + DB audit trail
    const missingSenderBinWebhook = {
      providerTransactionId: `txn_miss_sender_bin_${Date.now()}`,
      amount: 2000,
      description: `Chuyen tien ${refCode}`,
      referenceCode: refCode,
      destinationBankBin: '970422',
      destinationAccountNumber: '999888777666',
      senderAccountNumber: testAccNumber,
    };
    const missingSenderBinRes = await service.handleVerificationWebhook(missingSenderBinWebhook);
    const dbTxMissingSenderBin = await prisma.bankAccountVerificationTransaction.findUnique({
      where: { id: createdTxId },
    });
    assert(
      missingSenderBinRes.success === false &&
        missingSenderBinRes.reason === 'SENDER_BANK_UNVERIFIABLE' &&
        dbTxMissingSenderBin?.status === 'FAILED' &&
        dbTxMissingSenderBin?.failureReason === 'SENDER_BANK_UNVERIFIABLE',
      '3.3b2 Webhook Cross-Check: Missing sender bank BIN rejected with SENDER_BANK_UNVERIFIABLE and audited in DB',
    );

    // Reset back to PENDING
    await prisma.bankAccountVerificationTransaction.update({
      where: { id: createdTxId },
      data: { status: 'PENDING', receivedAmount: null, failureReason: null },
    });

    // Test 3.3c (Risk 1): Destination account mismatch rejected + DB audit trail
    const destMismatchWebhook = {
      providerTransactionId: `txn_dest_mismatch_${Date.now()}`,
      amount: 2000,
      description: `Chuyen tien ${refCode}`,
      referenceCode: refCode,
      destinationBankBin: '970422',
      destinationAccountNumber: '000111222333', // Mismatch against PLATFORM_BANK_ACCOUNT_NUMBER (999888777666)
      senderBankBin: '970422',
      senderAccountNumber: testAccNumber,
    };
    const destMismatchRes = await service.handleVerificationWebhook(destMismatchWebhook);
    const dbTxDestMismatch = await prisma.bankAccountVerificationTransaction.findUnique({
      where: { id: createdTxId },
    });
    assert(
      destMismatchRes.success === false &&
        destMismatchRes.reason === 'DESTINATION_ACCOUNT_MISMATCH' &&
        dbTxDestMismatch?.status === 'FAILED' &&
        dbTxDestMismatch?.failureReason === 'DESTINATION_ACCOUNT_MISMATCH',
      '3.3c Webhook Cross-Check: Destination account mismatch rejected with DESTINATION_ACCOUNT_MISMATCH and audited in DB',
    );

    // Reset back to PENDING
    await prisma.bankAccountVerificationTransaction.update({
      where: { id: createdTxId },
      data: { status: 'PENDING', receivedAmount: null, failureReason: null },
    });

    // Test 3.3c2 (Tertiary 1 & 6): Destination Bank BIN mismatch rejected + DB audit trail
    const destBinMismatchWebhook = {
      providerTransactionId: `txn_dest_bin_mismatch_${Date.now()}`,
      amount: 2000,
      description: `Chuyen tien ${refCode}`,
      referenceCode: refCode,
      destinationBankBin: '970407', // Techcombank (970407) vs Platform MBBank (970422)
      destinationAccountNumber: '999888777666',
      senderBankBin: '970422',
      senderAccountNumber: testAccNumber,
    };
    const destBinMismatchRes = await service.handleVerificationWebhook(destBinMismatchWebhook);
    const dbTxDestBinMismatch = await prisma.bankAccountVerificationTransaction.findUnique({
      where: { id: createdTxId },
    });
    assert(
      destBinMismatchRes.success === false &&
        destBinMismatchRes.reason === 'DESTINATION_BANK_MISMATCH' &&
        dbTxDestBinMismatch?.status === 'FAILED' &&
        dbTxDestBinMismatch?.failureReason === 'DESTINATION_BANK_MISMATCH',
      '3.3c2 Webhook Cross-Check: Destination bank BIN mismatch rejected with DESTINATION_BANK_MISMATCH and audited in DB',
    );

    // Reset back to PENDING
    await prisma.bankAccountVerificationTransaction.update({
      where: { id: createdTxId },
      data: { status: 'PENDING', receivedAmount: null, failureReason: null },
    });

    // Test 3.3d (High 3): Webhook with senderAccountNumber mismatch rejected + DB audit trail
    const senderMismatchWebhook = {
      providerTransactionId: `txn_mismatch_${Date.now()}`,
      amount: 2000,
      description: `Chuyen tien ${refCode}`,
      referenceCode: refCode,
      destinationBankBin: '970422',
      destinationAccountNumber: '999888777666',
      senderBankBin: '970422',
      senderAccountNumber: '999999999999', // Registered account is testAccNumber: 123456789012
    };
    const senderMismatchRes = await service.handleVerificationWebhook(senderMismatchWebhook);
    const dbTxSenderMismatch = await prisma.bankAccountVerificationTransaction.findUnique({
      where: { id: createdTxId },
    });
    assert(
      senderMismatchRes.success === false &&
        senderMismatchRes.reason === 'SENDER_ACCOUNT_MISMATCH' &&
        dbTxSenderMismatch?.status === 'FAILED' &&
        dbTxSenderMismatch?.failureReason === 'SENDER_ACCOUNT_MISMATCH',
      '3.3d Webhook Cross-Check: Sender account mismatch rejected with SENDER_ACCOUNT_MISMATCH and audited in DB',
    );

    // Reset back to PENDING
    await prisma.bankAccountVerificationTransaction.update({
      where: { id: createdTxId },
      data: { status: 'PENDING', receivedAmount: null, failureReason: null },
    });

    // Test 3.3d2 (Tertiary 1 & 6): Webhook with senderBankBin mismatch rejected + DB audit trail
    const senderBinMismatchWebhook = {
      providerTransactionId: `txn_sender_bin_mismatch_${Date.now()}`,
      amount: 2000,
      description: `Chuyen tien ${refCode}`,
      referenceCode: refCode,
      destinationBankBin: '970422',
      destinationAccountNumber: '999888777666',
      senderBankBin: '970407', // Techcombank (970407) vs Registered MBBank (970422)
      senderAccountNumber: testAccNumber,
    };
    const senderBinMismatchRes = await service.handleVerificationWebhook(senderBinMismatchWebhook);
    const dbTxSenderBinMismatch = await prisma.bankAccountVerificationTransaction.findUnique({
      where: { id: createdTxId },
    });
    assert(
      senderBinMismatchRes.success === false &&
        senderBinMismatchRes.reason === 'SENDER_BANK_MISMATCH' &&
        dbTxSenderBinMismatch?.status === 'FAILED' &&
        dbTxSenderBinMismatch?.failureReason === 'SENDER_BANK_MISMATCH',
      '3.3d2 Webhook Cross-Check: Sender bank BIN mismatch rejected with SENDER_BANK_MISMATCH and audited in DB',
    );

    // Reset back to PENDING
    await prisma.bankAccountVerificationTransaction.update({
      where: { id: createdTxId },
      data: { status: 'PENDING', receivedAmount: null, failureReason: null },
    });

    // Test 3.3e (Security Hardening): Decryption failure on corrupted ciphertext fails closed -> SENDER_ACCOUNT_UNVERIFIABLE
    const originalAccRecord = await prisma.storeBankAccount.findUnique({
      where: { id: createdAccId },
    });
    const originalCiphertext = originalAccRecord?.accountNumberEncrypted;

    // Tamper ciphertext in DB to simulate corrupted encryption payload
    await prisma.storeBankAccount.update({
      where: { id: createdAccId },
      data: { accountNumberEncrypted: 'corrupted:ciphertext:not:valid:hex' },
    });

    const decryptFailWebhook = {
      providerTransactionId: `txn_decrypt_fail_${Date.now()}`,
      amount: 2000,
      description: `Chuyen tien ${refCode}`,
      referenceCode: refCode,
      destinationBankBin: '970422',
      destinationAccountNumber: '999888777666',
      senderBankBin: '970422',
      senderAccountNumber: testAccNumber,
    };

    const decryptFailRes = await service.handleVerificationWebhook(decryptFailWebhook);
    const dbTxDecryptFail = await prisma.bankAccountVerificationTransaction.findUnique({
      where: { id: createdTxId },
    });
    assert(
      decryptFailRes.success === false &&
        decryptFailRes.reason === 'SENDER_ACCOUNT_UNVERIFIABLE' &&
        dbTxDecryptFail?.status === 'FAILED' &&
        dbTxDecryptFail?.failureReason === 'SENDER_ACCOUNT_UNVERIFIABLE',
      '3.3e Fail-Closed: Decryption failure fails closed with SENDER_ACCOUNT_UNVERIFIABLE and audited in DB',
    );

    // Restore original valid ciphertext and reset transaction
    await prisma.storeBankAccount.update({
      where: { id: createdAccId },
      data: { accountNumberEncrypted: originalCiphertext },
    });
    await prisma.bankAccountVerificationTransaction.update({
      where: { id: createdTxId },
      data: { status: 'PENDING', receivedAmount: null, failureReason: null },
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

    // Test 3.6: Valid Inbound Webhook (with matching sender and destination [bankBin + accountNumber])
    const validProviderTxId = `txn_valid_${Date.now()}`;
    const validWebhook = {
      providerTransactionId: validProviderTxId,
      amount: 2000,
      description: `Thanh toan xac minh tai khoan ${refCode} MB`,
      referenceCode: refCode,
      destinationBankBin: '970422',
      destinationAccountNumber: '999888777666',
      senderBankBin: '970422',
      senderAccountNumber: testAccNumber,
    };
    const validRes = await service.handleVerificationWebhook(validWebhook);
    assert(
      validRes.success === true && validRes.message?.includes('thành công'),
      '3.6 Valid 2.000 VND webhook with matching sender and platform (BIN + AccountNumber) processed successfully',
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
      destinationBankBin: '970422',
      destinationAccountNumber: '999888777666',
      senderBankBin: '970436',
      senderAccountNumber: '998877665544',
    };
    const parallelWebhook2 = {
      providerTransactionId: `txn_conc_2_${Date.now()}`,
      amount: 2000,
      description: `Chuyen tien ${concRef}`,
      referenceCode: concRef,
      destinationBankBin: '970422',
      destinationAccountNumber: '999888777666',
      senderBankBin: '970436',
      senderAccountNumber: '998877665544',
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
        withdrawalRes.bankAccountNumber === null &&
        withdrawalRes.bankAccountEncrypted !== null &&
        withdrawalRes.bankAccountMasked?.startsWith('******'),
      '5.2 Verified withdrawal created with encrypted and masked bank snapshot, without plaintext storage',
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
