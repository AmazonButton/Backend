import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
  HttpStatus,
} from '@nestjs/common';
import { PrismaService } from '../src/prisma/prisma.service';
import { BankVerificationService } from '../src/bank-verification/bank-verification.service';
import { BankVerificationRepository } from '../src/bank-verification/bank-verification.repository';
import { PayOSBankVerificationProvider } from '../src/bank-verification/providers/payos-bank-verification.provider';
import { StoreBankAccountsController } from '../src/bank-verification/store-bank-accounts.controller';
import { StoreWalletService } from '../src/store-wallet/store-wallet.service';
import { CustomersRepository } from '../src/customers/customers.repository';
import { CustomersService } from '../src/customers/customers.service';
import { CustomerBankPennyVerificationService } from '../src/customers/customer-bank-penny-verification.service';
import { CustomersController } from '../src/customers/customers.controller';
import { CryptoVaultUtil } from '../src/common/utils/crypto-vault.util';

async function runBankingReviewFixesTests() {
  console.log('================================================================');
  console.log('🚀 SUITE 72: Banking Backend Review Fixes (2026-11-08)');
  console.log('================================================================\n');

  process.env.BANK_VERIFICATION_AMOUNT_VND = '2000';
  process.env.BANK_VERIFICATION_EXPIRY_MINUTES = '30';
  process.env.BANK_VERIFICATION_WEBHOOK_SECRET = 'test_bank_webhook_secret_key_12345';
  process.env.PLATFORM_BANK_ACCOUNT_NUMBER = '0339898989';
  process.env.PLATFORM_BANK_BIN = '970422';
  process.env.PLATFORM_BANK_NAME = 'MBBank';
  process.env.PLATFORM_BANK_ACCOUNT_HOLDER = 'CONG TY CP SMART ORDER';
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
  const storeBankAccountsController = new StoreBankAccountsController(service);
  const walletService = new StoreWalletService(prisma);

  const customersRepo = new CustomersRepository(prisma);
  const customersService = new CustomersService(customersRepo);
  const pennyVerificationService = new CustomerBankPennyVerificationService(customersRepo);
  const customersController = new CustomersController(customersService, pennyVerificationService);

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

  const cleanupBankAccIds: bigint[] = [];
  const cleanupTxIds: bigint[] = [];
  const cleanupStoreIds: bigint[] = [];
  const cleanupUserIds: bigint[] = [];
  const cleanupCustomerIds: bigint[] = [];
  const cleanupCustomerBankAccIds: bigint[] = [];
  const cleanupProofIds: bigint[] = [];

  try {
    // ------------------------------------------------------------------------
    // SETUP: Create isolated store and customer test entities
    // ------------------------------------------------------------------------
    const testUsername = `bank_fix_owner_${Date.now()}`;
    const testOwner = await prisma.user.create({
      data: {
        username: testUsername,
        fullName: 'Nguyen Van Owner',
        email: `${testUsername}@example.com`,
        status: 'ACTIVE',
      },
    });
    cleanupUserIds.push(testOwner.userId);

    const testStore = await prisma.store.create({
      data: {
        name: `Test Store ${Date.now()}`,
        code: `STR_FIX_${Date.now()}`,
        phone: '0901234567',
        address: '123 Testing St',
        ownerUserId: testOwner.userId,
        status: 'ACTIVE',
      },
    });
    cleanupStoreIds.push(testStore.storeId);

    await prisma.storeWallet.create({
      data: {
        storeId: testStore.storeId,
        balance: 1000000,
        frozenBalance: 0,
        bankName: 'OLD_BANK',
        bankAccountHolder: 'OLD_HOLDER',
      },
    });

    const custUsername = `cust_bank_fix_${Date.now()}`;
    const custUser = await prisma.user.create({
      data: {
        username: custUsername,
        fullName: 'Tran Van Customer',
        email: `${custUsername}@example.com`,
        status: 'ACTIVE',
      },
    });
    cleanupUserIds.push(custUser.userId);

    const custProfile = await prisma.customerProfile.create({
      data: {
        userId: custUser.userId,
        phone: '0981122334',
      },
    });
    cleanupCustomerIds.push(custProfile.customerId);

    // ========================================================================
    // SECTION 1: Point 1 & Point 2 - Formatter recipient fields & actualAmount
    // ========================================================================
    console.log('[SECTION 1] Store Verification Formatter & Received Amount:');

    // Test 1.1: formatVerificationTransaction maps receivedAmount to actualAmount correctly
    const mockTxPaid = {
      id: BigInt(101),
      bankAccountId: BigInt(201),
      referenceCode: 'VERIFY_TEST123',
      expectedAmount: '2000.00',
      receivedAmount: '2000.00',
      actualAmount: null, // Prisma model has receivedAmount, not actualAmount
      status: 'VERIFIED',
      refundStatus: 'REFUNDED',
      failureReason: null,
      expiresAt: new Date(Date.now() + 1800000),
      verifiedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
      bankAccount: {
        storeId: testStore.storeId,
        bankBin: '970422',
        bankCode: 'MB',
        bankName: 'MBBank',
        accountNumberEncrypted: CryptoVaultUtil.encryptAccountNumber('0123456789'),
        accountName: 'TRAN VAN OWNER',
      },
    };

    const formattedPaid = service.formatVerificationTransaction(mockTxPaid);
    assert(
      formattedPaid.actualAmount === 2000 &&
        formattedPaid.receivedAmount === 2000 &&
        formattedPaid.expectedAmount === 2000 &&
        formattedPaid.recipientBankBin === '970422' &&
        formattedPaid.recipientBankName === 'MBBank' &&
        formattedPaid.recipientAccountNumber === '0339898989' &&
        formattedPaid.recipientAccountHolder === 'CONG TY CP SMART ORDER' &&
        formattedPaid.qrCodeUrl.includes('970422-0339898989-compact2.png') &&
        formattedPaid.instructions.includes('0339898989'),
      '1.1 formatVerificationTransaction returns platform recipient bank fields, QR, instructions, and correct actualAmount from receivedAmount',
    );

    // Test 1.2: Unpaid verification returns actualAmount = null
    const mockTxUnpaid = {
      ...mockTxPaid,
      id: BigInt(102),
      receivedAmount: null,
      status: 'PENDING',
      refundStatus: null,
    };
    const formattedUnpaid = service.formatVerificationTransaction(mockTxUnpaid);
    assert(
      formattedUnpaid.actualAmount === null &&
        formattedUnpaid.receivedAmount === null &&
        formattedUnpaid.status === 'PENDING',
      '1.2 formatVerificationTransaction keeps actualAmount = null for unpaid transactions (no fake amounts)',
    );

    // Test 1.3: Cancel verification sets status = 'EXPIRED' and failureReason = 'USER_CANCELLED'
    const encAcc = CryptoVaultUtil.encryptAccountNumber('1122334455');
    const hashAcc = CryptoVaultUtil.hashAccountNumber('1122334455');
    const testStoreAcc = await prisma.storeBankAccount.create({
      data: {
        storeId: testStore.storeId,
        bankBin: '970422',
        bankName: 'MBBank',
        accountNumberEncrypted: encAcc,
        accountNumberHash: hashAcc,
        accountName: 'NGUYEN VAN OWNER',
        verificationStatus: 'PENDING',
      },
    });
    cleanupBankAccIds.push(testStoreAcc.id);

    const testPendingTx = await prisma.bankAccountVerificationTransaction.create({
      data: {
        bankAccountId: testStoreAcc.id,
        referenceCode: 'VERIFY_CANCEL_ME',
        expectedAmount: 2000,
        status: 'PENDING',
        expiresAt: new Date(Date.now() + 1800000),
      },
    });
    cleanupTxIds.push(testPendingTx.id);

    const cancelRes = await storeBankAccountsController.cancelVerification(
      testPendingTx.id.toString(),
      { user: { userId: testOwner.userId.toString(), role: 'STORE_OWNER' } },
    );
    assert(cancelRes.success === true, '1.3 Cancel verification request returns success: true');

    const cancelledTx = await prisma.bankAccountVerificationTransaction.findUnique({
      where: { id: testPendingTx.id },
    });
    assert(
      cancelledTx?.status === 'EXPIRED' && cancelledTx?.failureReason === 'USER_CANCELLED',
      '1.4 Cancelled verification has status = EXPIRED and failureReason = USER_CANCELLED',
    );

    // ========================================================================
    // SECTION 2: Point 8 - Bank Lookup Error Differentiation & Zero Leakage
    // ========================================================================
    console.log('\n[SECTION 2] VietQR Bank Lookup Error Differentiation:');

    // Test 2.1: Missing credentials in non-mock mode throws ServiceUnavailableException
    const origMock = process.env.BANK_VERIFICATION_MOCK;
    const origClientId = process.env.VIETQR_CLIENT_ID;
    const origApiKey = process.env.VIETQR_API_KEY;
    const origPayosId = process.env.PAYOS_CLIENT_ID;
    const origPayosKey = process.env.PAYOS_API_KEY;

    process.env.BANK_VERIFICATION_MOCK = 'false';
    delete process.env.VIETQR_CLIENT_ID;
    delete process.env.VIETQR_API_KEY;
    delete process.env.PAYOS_CLIENT_ID;
    delete process.env.PAYOS_API_KEY;

    let unconfiguredThrew503 = false;
    try {
      await service.lookupBankAccount({ bankBin: '970422', accountNumber: '0339898989' });
    } catch (err: any) {
      unconfiguredThrew503 = err instanceof ServiceUnavailableException;
    }
    assert(
      unconfiguredThrew503,
      '2.1 Unconfigured VietQR credentials in non-mock mode throws ServiceUnavailableException (503)',
    );

    // Test 2.2: VietQR code 42 (Account not found) throws BadRequestException
    const testProvider = new PayOSBankVerificationProvider();
    const origFetch = global.fetch;

    global.fetch = (async () => {
      return {
        ok: true,
        json: async () => ({ code: '42', desc: 'So tai khoan khong ton tai' }),
      } as any;
    }) as any;

    process.env.VIETQR_CLIENT_ID = 'test_vqr_id';
    process.env.VIETQR_API_KEY = 'test_vqr_key';

    let code42Threw400 = false;
    let code42ErrorCode = '';
    const lookupServiceWithMockFetch = new BankVerificationService(prisma, repository, testProvider);
    try {
      await lookupServiceWithMockFetch.lookupBankAccount({ bankBin: '970422', accountNumber: '0339898989' });
    } catch (err: any) {
      code42Threw400 = err instanceof BadRequestException;
      code42ErrorCode = err.response?.errorCode || err.getResponse()?.errorCode;
    }
    assert(
      code42Threw400 && code42ErrorCode === 'BANK_ACCOUNT_NOT_FOUND',
      '2.2 VietQR code 42 returns 400 Bad Request with errorCode = BANK_ACCOUNT_NOT_FOUND',
    );

    // Test 2.3: VietQR code 41 (Bank not supported) throws BadRequestException
    global.fetch = (async () => {
      return {
        ok: true,
        json: async () => ({ code: '41', desc: 'Ngan hang chua ho tro' }),
      } as any;
    }) as any;

    let code41Threw400 = false;
    let code41ErrorCode = '';
    try {
      await lookupServiceWithMockFetch.lookupBankAccount({ bankBin: '970422', accountNumber: '0339898989' });
    } catch (err: any) {
      code41Threw400 = err instanceof BadRequestException;
      code41ErrorCode = err.response?.errorCode || err.getResponse()?.errorCode;
    }
    assert(
      code41Threw400 && code41ErrorCode === 'BANK_NOT_SUPPORTED_FOR_LOOKUP',
      '2.3 VietQR code 41 returns 400 Bad Request with errorCode = BANK_NOT_SUPPORTED_FOR_LOOKUP',
    );

    // Test 2.4: Upstream 401/403 or 503 throws ServiceUnavailableException (503)
    global.fetch = (async () => {
      return {
        ok: false,
        status: 401,
      } as any;
    }) as any;

    let upstream401Threw503 = false;
    try {
      await lookupServiceWithMockFetch.lookupBankAccount({ bankBin: '970422', accountNumber: '0339898989' });
    } catch (err: any) {
      upstream401Threw503 = err instanceof ServiceUnavailableException;
    }
    assert(
      upstream401Threw503,
      '2.4 Upstream VietQR 401/403 returns 503 Service Unavailable (credential failure does not mislead as client 400)',
    );

    // Test 2.5: Zero Vendor Leakage: unexpected raw error is masked
    global.fetch = (async () => {
      throw new Error('Raw SQL or secret credentials leak from upstream adapter');
    }) as any;

    let rawLeakMasked = false;
    try {
      await lookupServiceWithMockFetch.lookupBankAccount({ bankBin: '970422', accountNumber: '0339898989' });
    } catch (err: any) {
      // Must not contain the sensitive error text
      rawLeakMasked = !err.message.includes('secret credentials');
    }
    assert(
      rawLeakMasked,
      '2.5 Zero Vendor Leakage: raw upstream error is masked and credentials/internals never leak',
    );

    // Restore test environment
    global.fetch = origFetch;
    process.env.BANK_VERIFICATION_MOCK = origMock;
    process.env.VIETQR_CLIENT_ID = origClientId || '';
    process.env.VIETQR_API_KEY = origApiKey || '';
    process.env.PAYOS_CLIENT_ID = origPayosId || '';
    process.env.PAYOS_API_KEY = origPayosKey || '';

    // ========================================================================
    // SECTION 3: Point 3 - Default Bank Account & Withdrawal Source Prioritization
    // ========================================================================
    console.log('\n[SECTION 3] Default Bank Account & Store Withdrawal Prioritization:');

    // Create 2 verified accounts for testStore: Account A (older), Account B (newer, default)
    const accAEnc = CryptoVaultUtil.encryptAccountNumber('97042200000001');
    const accAHash = CryptoVaultUtil.hashAccountNumber('97042200000001');
    const accA = await prisma.storeBankAccount.create({
      data: {
        storeId: testStore.storeId,
        bankBin: '970422',
        bankName: 'MBBank',
        accountNumberEncrypted: accAEnc,
        accountNumberHash: accAHash,
        accountName: 'NGUYEN VAN OWNER A',
        verificationStatus: 'OWNERSHIP_VERIFIED',
        isDefault: false,
        updatedAt: new Date(Date.now() - 60000), // older
      },
    });
    cleanupBankAccIds.push(accA.id);

    const accBEnc = CryptoVaultUtil.encryptAccountNumber('97042200000002');
    const accBHash = CryptoVaultUtil.hashAccountNumber('97042200000002');
    const accB = await prisma.storeBankAccount.create({
      data: {
        storeId: testStore.storeId,
        bankBin: '970415',
        bankName: 'VietinBank',
        accountNumberEncrypted: accBEnc,
        accountNumberHash: accBHash,
        accountName: 'NGUYEN VAN OWNER B',
        verificationStatus: 'OWNERSHIP_VERIFIED',
        isDefault: true,
        updatedAt: new Date(),
      },
    });
    cleanupBankAccIds.push(accB.id);

    // Test 3.1: setDefaultBankAccount syncs store_wallets bankName and bankAccountHolder (Rule 13: zero plaintext)
    await repository.setDefaultBankAccount(testStore.storeId, accA.id);
    const updatedWallet = await prisma.storeWallet.findUnique({
      where: { storeId: testStore.storeId },
    });
    assert(
      updatedWallet?.bankName === 'MBBank' &&
        updatedWallet?.bankAccountHolder === 'NGUYEN VAN OWNER A' &&
        !updatedWallet?.bankAccountNumber?.includes('97042200000001'),
      '3.1 setDefaultBankAccount syncs store_wallets bankName and bankAccountHolder without storing plaintext account number',
    );

    // Set accB back to default
    await repository.setDefaultBankAccount(testStore.storeId, accB.id);

    // Test 3.2: requestWithdrawal picks the default bank account (accB - VietinBank)
    const withdrawal = await walletService.requestWithdrawal(
      testStore.storeId,
      {
        amount: 50000,
      },
      `IDEM_WITHDRAW_${Date.now()}`,
    );

    assert(
      (withdrawal as any).bankName === 'VietinBank' &&
        (withdrawal as any).bankAccountHolder === 'NGUYEN VAN OWNER B',
      '3.2 Store withdrawal automatically selects the verified default bank account (VietinBank)',
    );

    // ========================================================================
    // SECTION 4: Point 6 - Customer Bank Account Default & Safe Deletion
    // ========================================================================
    console.log('\n[SECTION 4] Customer Bank Account Default & Deletion:');

    const custAcc1Enc = CryptoVaultUtil.encryptAccountNumber('11112222333301');
    const custAcc1Hash = CryptoVaultUtil.hashAccountNumber('11112222333301');
    const custAcc1 = await prisma.customerBankAccount.create({
      data: {
        customerId: custProfile.customerId,
        bankBin: '970422',
        bankName: 'MBBank',
        accountNumberEncrypted: custAcc1Enc,
        accountNumberHash: custAcc1Hash,
        accountNumberMasked: '******3301',
        accountName: 'TRAN VAN CUSTOMER 1',
        verificationStatus: 'VERIFIED',
        isDefault: true,
      },
    });
    cleanupCustomerBankAccIds.push(custAcc1.id);

    const custAcc2Enc = CryptoVaultUtil.encryptAccountNumber('11112222333302');
    const custAcc2Hash = CryptoVaultUtil.hashAccountNumber('11112222333302');
    const custAcc2 = await prisma.customerBankAccount.create({
      data: {
        customerId: custProfile.customerId,
        bankBin: '970415',
        bankName: 'VietinBank',
        accountNumberEncrypted: custAcc2Enc,
        accountNumberHash: custAcc2Hash,
        accountNumberMasked: '******3302',
        accountName: 'TRAN VAN CUSTOMER 2',
        verificationStatus: 'VERIFIED',
        isDefault: false,
      },
    });
    cleanupCustomerBankAccIds.push(custAcc2.id);

    // Test 4.1: PATCH /customers/me/bank-accounts/:id/default sets default and clears other accounts
    const patchRes = await customersController.setDefaultMyBankAccount(
      { user: { userId: custUser.userId.toString(), role: 'CUSTOMER' } },
      custAcc2.id.toString(),
    );
    assert(
      patchRes.success === true && patchRes.data.isDefault === true,
      '4.1 PATCH /customers/me/bank-accounts/:id/default returns success: true and isDefault: true',
    );

    const refreshedAcc1 = await prisma.customerBankAccount.findUnique({ where: { id: custAcc1.id } });
    const refreshedAcc2 = await prisma.customerBankAccount.findUnique({ where: { id: custAcc2.id } });
    assert(
      refreshedAcc1?.isDefault === false && refreshedAcc2?.isDefault === true,
      '4.2 Default switch clears previous default account and enables new default account',
    );

    // Test 4.3: Unverified account cannot be set as default
    const unverifiedEnc = CryptoVaultUtil.encryptAccountNumber('11112222333303');
    const unverifiedHash = CryptoVaultUtil.hashAccountNumber('11112222333303');
    const unverifiedAcc = await prisma.customerBankAccount.create({
      data: {
        customerId: custProfile.customerId,
        bankBin: '970422',
        bankName: 'MBBank',
        accountNumberEncrypted: unverifiedEnc,
        accountNumberHash: unverifiedHash,
        accountNumberMasked: '******3303',
        accountName: 'TRAN VAN UNVERIFIED',
        verificationStatus: 'PENDING',
        isDefault: false,
      },
    });
    cleanupCustomerBankAccIds.push(unverifiedAcc.id);

    let unverifiedThrew = false;
    try {
      await customersController.setDefaultMyBankAccount(
        { user: { userId: custUser.userId.toString(), role: 'CUSTOMER' } },
        unverifiedAcc.id.toString(),
      );
    } catch (err: any) {
      unverifiedThrew = err instanceof BadRequestException;
    }
    assert(
      unverifiedThrew,
      '4.3 Setting unverified customer bank account as default is rejected with 400 Bad Request',
    );

    // Test 4.4: Safe deletion of bank account
    const deleteRes = await customersController.deleteMyBankAccount(
      { user: { userId: custUser.userId.toString(), role: 'CUSTOMER' } },
      unverifiedAcc.id.toString(),
    );
    assert(deleteRes.success === true, '4.4 DELETE /customers/me/bank-accounts/:id successfully deletes safe account');

    const deletedRow = await prisma.customerBankAccount.findUnique({ where: { id: unverifiedAcc.id } });
    assert(deletedRow === null, '4.5 Deleted bank account record is removed from database');

    // ========================================================================
    // SECTION 5: Point 5 & 6 - Customer History & Status Enrichment
    // ========================================================================
    console.log('\n[SECTION 5] Customer Verification History & Status Enrichment:');

    // Create a verification proof session for custAcc1
    const testProof = await prisma.customerBankVerificationProof.create({
      data: {
        proofReference: `PROOF_TEST_${Date.now()}`,
        customerId: custProfile.customerId,
        accountId: custAcc1.id,
        bankBin: '970422',
        accountNumberHash: custAcc1Hash,
        status: 'PENDING',
        sessionStatus: 'ACTIVE',
        verificationStatus: 'PENDING',
        expiresAt: new Date(Date.now() + 1800000),
        paymentCheckoutUrl: 'https://pay.payos.vn/web/test_checkout_123',
      },
    });
    cleanupProofIds.push(testProof.id);

    // Test 5.1: getVerificationStatus returns checkoutUrl
    const statusRes = await customersController.getMyBankAccountVerificationStatus(
      { user: { userId: custUser.userId.toString(), role: 'CUSTOMER' } },
      custAcc1.id.toString(),
    );
    assert(
      statusRes.success === true &&
        statusRes.data.session?.checkoutUrl === 'https://pay.payos.vn/web/test_checkout_123',
      '5.1 getVerificationStatus returns checkoutUrl for active verification session',
    );

    // Test 5.2: getVerificationHistory returns accountId, bankBin, bankName, accountNumberMasked, accountName, checkoutUrl
    const historyRes = await customersController.getMyBankAccountVerificationHistory(
      { user: { userId: custUser.userId.toString(), role: 'CUSTOMER' } },
      1,
      10,
    );
    assert(
      historyRes.success === true && historyRes.data.length > 0,
      '5.2 getMyBankAccountVerificationHistory returns list of verification sessions',
    );

    const historyItem = historyRes.data.find((item: any) => item.sessionId === testProof.id.toString());
    assert(
      historyItem !== undefined &&
        historyItem.accountId === custAcc1.id.toString() &&
        historyItem.bankBin === '970422' &&
        historyItem.bankName === 'MBBank' &&
        historyItem.accountNumberMasked === '******3301' &&
        historyItem.accountName === 'TRAN VAN CUSTOMER 1' &&
        historyItem.checkoutUrl === 'https://pay.payos.vn/web/test_checkout_123',
      '5.3 Customer verification history items are enriched with accountId, bank details, masked number, and checkoutUrl',
    );
  } catch (error: any) {
    console.error('Unexpected test error:', error);
    failed++;
  } finally {
    // Cleanup
    for (const id of cleanupProofIds) {
      await prisma.customerBankVerificationProof.deleteMany({ where: { id } }).catch(() => {});
    }
    for (const id of cleanupCustomerBankAccIds) {
      await prisma.customerBankAccount.deleteMany({ where: { id } }).catch(() => {});
    }
    for (const id of cleanupTxIds) {
      await prisma.bankAccountVerificationTransaction.deleteMany({ where: { id } }).catch(() => {});
    }
    for (const id of cleanupBankAccIds) {
      await prisma.storeBankAccount.deleteMany({ where: { id } }).catch(() => {});
    }
    for (const id of cleanupStoreIds) {
      await prisma.storeWallet.deleteMany({ where: { storeId: id } }).catch(() => {});
      await prisma.storeWithdrawal.deleteMany({ where: { storeId: id } }).catch(() => {});
      await prisma.store.deleteMany({ where: { storeId: id } }).catch(() => {});
    }
    for (const id of cleanupCustomerIds) {
      await prisma.customerProfile.deleteMany({ where: { customerId: id } }).catch(() => {});
    }
    for (const id of cleanupUserIds) {
      await prisma.user.deleteMany({ where: { userId: id } }).catch(() => {});
    }

    await prisma.$disconnect();

    console.log('\n================================================================');
    console.log(`Test Execution Finished: ${passed} Passed, ${failed} Failed`);
    console.log('================================================================\n');

    if (failed > 0) {
      process.exit(1);
    }
  }
}

runBankingReviewFixesTests();
