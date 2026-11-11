import assert from 'assert';
import * as crypto from 'crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { CryptoVaultUtil } from '../src/common/utils/crypto-vault.util';
import { StoreWalletService } from '../src/store-wallet/store-wallet.service';
import { StoreWalletRepository } from '../src/store-wallet/store-wallet.repository';
import { AdminService } from '../src/admin/admin.service';
import { AdminRepository } from '../src/admin/admin.repository';
import { BankVerificationService } from '../src/bank-verification/bank-verification.service';
import { BankVerificationRepository } from '../src/bank-verification/bank-verification.repository';
import { PayOSBankVerificationProvider } from '../src/bank-verification/providers/payos-bank-verification.provider';
import { verifyPayosPayoutEvidence, verifyPayosPayoutRejectionEvidence } from '../src/payments/payos-payout-verifier';
import { RentalsService } from '../src/rentals/rentals.service';
import { RentalsRepository } from '../src/rentals/rentals.repository';
import { CustomersRepository } from '../src/customers/customers.repository';
import { CustomerBankPennyVerificationService } from '../src/customers/customer-bank-penny-verification.service';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ✔ [PASS] ${name}`);
    passed++;
  } catch (err: any) {
    console.error(`  ✖ [FAIL] ${name}: ${err?.message || err}`);
    if (err.stack) {
      console.error(err.stack.split('\n').slice(1, 4).join('\n'));
    }
    failed++;
  }
}

async function run() {
  console.log('========================================================================');
  console.log('🛡️ MASTER TEST SUITE: Financial Payout, Verification & Refund Hardening');
  console.log('========================================================================\n');

  // Guard database: MUST be explicitly a test database
  const dbUrl = process.env.DATABASE_URL || '';
  const testDbUrl = process.env.TEST_DATABASE_URL || '';
  const isExplicitTestDb =
    dbUrl.includes('_test') ||
    testDbUrl.includes('_test') ||
    process.env.NODE_ENV === 'test' ||
    process.env.RENTAL_ACCEPTANCE_DISPOSABLE_DB === 'true';

  if (!isExplicitTestDb) {
    throw new Error(
      'DATABASE_GUARD_FAILED: Refusing to run financial hardening test suite against non-test database! (DATABASE_URL must point to a test database or NODE_ENV must be "test")',
    );
  }

  process.env.BANK_VERIFICATION_MOCK = 'true';
  process.env.BANK_ACCOUNT_ENCRYPTION_KEY =
    process.env.BANK_ACCOUNT_ENCRYPTION_KEY || '5dad52bd291a3e8f96f284cd7fcdb72d96d5f114c00e642dea09e9da19d0363d';
  process.env.BANK_ACCOUNT_HASH_SALT = process.env.BANK_ACCOUNT_HASH_SALT || '9a532ece4926c8cf15015651729b0c1e';

  const prisma = new PrismaService();
  await prisma.$connect();

  // Registry of specifically created fixture IDs for surgical teardown
  const created = {
    userIds: [] as any[],
    storeIds: [] as any[],
    bankAccountIds: [] as any[],
    withdrawalIds: [] as any[],
    obligationIds: [] as any[],
    receiptIds: [] as any[],
    customerProfileIds: [] as any[],
    packageIds: [] as any[],
    rentalIds: [] as any[],
    buttonIds: [] as any[],
    depositIds: [] as any[],
    returnIds: [] as any[],
    refundIds: [] as any[],
    inboundTxIds: [] as any[],
    customerObligationIds: [] as any[],
    customerAttemptIds: [] as any[],
    verificationTxIds: [] as any[],
  };

  const storeWalletRepo = new StoreWalletRepository(prisma);
  const storeWalletService = new StoreWalletService(prisma, undefined, storeWalletRepo);
  const adminRepo = new AdminRepository(prisma);
  const adminService = new AdminService(adminRepo);

  const bankVerificationRepo = new BankVerificationRepository(prisma);
  const bankVerificationProvider = new PayOSBankVerificationProvider();
  const bankVerificationService = new BankVerificationService(prisma, bankVerificationRepo, bankVerificationProvider);

  const rentalsRepo = new RentalsRepository(prisma);
  const rentalsService = new RentalsService(rentalsRepo);

  const customersRepo = new CustomersRepository(prisma);
  const customerPennyService = new CustomerBankPennyVerificationService(customersRepo);

  let testReceipt: any = null;

  try {
    // Setup test tenant & entities
    const rand = Math.floor(Math.random() * 100000);
    const testUser = await prisma.user.create({
      data: {
        username: `fin_test_user_${rand}`,
        fullName: 'Financial Security Test User',
        email: `fin_test_${rand}@example.com`,
        status: 'ACTIVE',
      },
    });
    created.userIds.push(testUser.userId);

    const testStore = await prisma.store.create({
      data: {
        name: `Fin Security Store ${rand}`,
        code: `STR_FIN_${rand}`,
        phone: `0987${rand.toString().padStart(6, '0')}`,
        address: '123 Security Blvd',
        ownerUserId: testUser.userId,
        status: 'ACTIVE',
      },
    });
    created.storeIds.push(testStore.storeId);

    const rawAcc = '098765432109';
    const encAcc = CryptoVaultUtil.encryptAccountNumber(rawAcc);
    const hashAcc = CryptoVaultUtil.hashAccountNumber(rawAcc);
    const bankBin = '970422'; // MBBank

    const testBankAcc = await prisma.storeBankAccount.create({
      data: {
        storeId: testStore.storeId,
        bankBin,
        bankName: 'MBBank',
        accountNumberEncrypted: encAcc,
        accountNumberHash: hashAcc,
        accountName: 'NGUYEN VAN FIN',
        verificationStatus: 'OWNERSHIP_VERIFIED',
        isDefault: true,
        verifiedAt: new Date(),
      },
    });
    created.bankAccountIds.push(testBankAcc.id);

    const wallet = await storeWalletService.getOrCreateStoreWallet(testStore.storeId);
    await prisma.storeWallet.update({
      where: { walletId: wallet.walletId },
      data: { balance: 2000000, frozenBalance: 0 },
    });

    console.log('[SECTION 1] Withdrawal CAS Concurrency, Fee Authority & Fail-Closed Tests');

    // TC-01: Concurrent pending withdrawal claim across independent DB connections
    await test('TC-01 Concurrent pending withdrawal claim across independent DB connections (Exactly 1 winner via CAS)', async () => {
      const prisma2 = new PrismaService();
      await prisma2.$connect();
      const adminRepo2 = new AdminRepository(prisma2);

      try {
        const withdrawal = await storeWalletService.requestWithdrawal(
          testStore.storeId,
          { amount: 500000, bankAccountId: testBankAcc.id.toString() },
        );
        created.withdrawalIds.push(withdrawal.withdrawalId);

        // Simulate 2 parallel connections on separate clients claiming PENDING -> PROCESSING
        const claim1 = adminRepo.claimPendingWithdrawal(withdrawal.withdrawalId);
        const claim2 = adminRepo2.claimPendingWithdrawal(withdrawal.withdrawalId);

        const [winner1, winner2] = await Promise.all([claim1, claim2]);
        assert.strictEqual(
          (winner1 ? 1 : 0) + (winner2 ? 1 : 0),
          1,
          'Exactly one connection must succeed in claiming PENDING withdrawal via CAS',
        );

        const refreshed = await prisma.storeWithdrawal.findUnique({
          where: { withdrawalId: withdrawal.withdrawalId },
        });
        assert.strictEqual(refreshed?.status, 'PROCESSING');
      } finally {
        await prisma2.$disconnect();
      }
    });

    // TC-02: Server Fee Authority & Tampering Immunity
    await test('TC-02 Server Fee Authority: client-supplied fee is ignored, server computes fee and integer netAmount', async () => {
      const rawWithdrawal = await storeWalletService.requestWithdrawal(
        testStore.storeId,
        { amount: 300000, bankAccountId: testBankAcc.id.toString(), fee: 999999 } as any,
      );
      created.withdrawalIds.push(rawWithdrawal.withdrawalId);

      assert.strictEqual(Number(rawWithdrawal.fee), 0, 'Server must enforce fee authority (fee = 0)');
      assert.strictEqual(Number(rawWithdrawal.netAmount), 300000, 'Server netAmount must be amount - fee');
      assert.ok(Number.isInteger(Number(rawWithdrawal.netAmount)), 'netAmount must be an integer VND value');
    });

    // TC-03: PayOS Network Timeout leaves withdrawal in PENDING_RECONCILIATION
    await test('TC-03 PayOS Network Timeout: leaves withdrawal in PENDING_RECONCILIATION, zero balance leakage', async () => {
      const withdrawal = await storeWalletService.requestWithdrawal(
        testStore.storeId,
        { amount: 200000, bankAccountId: testBankAcc.id.toString() },
      );
      created.withdrawalIds.push(withdrawal.withdrawalId);

      // Mock PayOS Payout service throwing network timeout
      const mockTimeoutPayoutService: any = {
        createPayout: async () => {
          throw new Error('ETIMEDOUT: Connection to PayOS gateway timed out after 10000ms');
        },
      };

      const walletServiceWithTimeout = new StoreWalletService(
        prisma,
        mockTimeoutPayoutService,
        storeWalletRepo,
      );

      let caughtError: any = null;
      try {
        await walletServiceWithTimeout.triggerPayosPayout(withdrawal.withdrawalId);
      } catch (e: any) {
        caughtError = e;
      }

      assert.ok(caughtError, 'Must throw error on timeout');
      const checked = await prisma.storeWithdrawal.findUnique({
        where: { withdrawalId: withdrawal.withdrawalId },
      });

      assert.strictEqual(
        checked?.status,
        'PENDING_RECONCILIATION',
        'Status must remain PENDING_RECONCILIATION, never auto-refunded to wallet on timeout',
      );

      const walletCheck = await prisma.storeWallet.findUnique({
        where: { walletId: wallet.walletId },
      });
      // Balance must not be refunded prematurely
      assert.ok(
        Number(walletCheck?.frozenBalance) >= 200000,
        'Frozen balance must remain locked until explicit terminal reconciliation',
      );
    });

    // TC-04: Store & Admin Reconciliation Rejection on Tampered BIN, Amount, Contradictory Hash, or Missing Transactions Array
    await test('TC-04 Unified Verifier rejects payout evidence with tampered amount, mismatched BIN, contradictory hash, or missing transactions array', async () => {
      const criteria = {
        amount: 100000,
        payoutReference: 'REF_TEST_001',
        targetBankBin: '970422',
        targetAccountHash: hashAcc,
        expectedPayoutId: 'payout_123',
      };

      // 1. Missing detailed transactions array (Flat summary rejected)
      const flatSummaryData = {
        id: 'payout_123',
        referenceId: 'REF_TEST_001',
        amount: 100000,
        toBin: '970422',
        toAccountNumber: rawAcc,
        state: 'SUCCEEDED',
      };
      const resFlat = verifyPayosPayoutEvidence(flatSummaryData, criteria);
      assert.strictEqual(resFlat.isVerified, false, 'Must reject flat payout data without transactions array');
      assert.ok(resFlat.reason?.includes('transactions'), 'Reason must indicate missing transactions');

      // 2. Tampered Amount inside transaction
      const tamperedAmountData = {
        id: 'payout_123',
        approvalState: 'COMPLETED',
        transactions: [
          {
            id: 'tx_01',
            referenceId: 'REF_TEST_001',
            amount: 90000, // Expected 100000
            toBin: '970422',
            toAccountNumber: rawAcc,
            state: 'SUCCEEDED',
          },
        ],
      };
      const resAmount = verifyPayosPayoutEvidence(tamperedAmountData, criteria);
      assert.strictEqual(resAmount.isVerified, false, 'Must reject tampered amount');

      // 3. Tampered Bank BIN
      const tamperedBinData = {
        id: 'payout_123',
        approvalState: 'COMPLETED',
        transactions: [
          {
            id: 'tx_01',
            referenceId: 'REF_TEST_001',
            amount: 100000,
            toBin: '970407', // Techcombank instead of MBBank
            toAccountNumber: rawAcc,
            state: 'SUCCEEDED',
          },
        ],
      };
      const resBin = verifyPayosPayoutEvidence(tamperedBinData, criteria);
      assert.strictEqual(resBin.isVerified, false, 'Must reject mismatched recipient BIN');

      // 4. Contradictory Data: accountNumber is provided alongside conflicting accountNumberHash
      const contradictoryData = {
        id: 'payout_123',
        approvalState: 'COMPLETED',
        transactions: [
          {
            id: 'tx_01',
            referenceId: 'REF_TEST_001',
            amount: 100000,
            toBin: '970422',
            toAccountNumber: rawAcc,
            accountNumberHash: 'conflicting_wrong_hash_9999999',
            state: 'SUCCEEDED',
          },
        ],
      };
      const resContradict = verifyPayosPayoutEvidence(contradictoryData, criteria);
      assert.strictEqual(resContradict.isVerified, false, 'Must reject contradictory account number and hash');

      // 5. Valid Structured Evidence with transactions array
      const validData = {
        id: 'payout_123',
        approvalState: 'COMPLETED',
        transactions: [
          {
            id: 'tx_01',
            referenceId: 'REF_TEST_001',
            amount: 100000,
            toBin: '970422',
            toAccountNumber: rawAcc,
            state: 'SUCCEEDED',
          },
        ],
      };
      const resValid = verifyPayosPayoutEvidence(validData, criteria);
      assert.strictEqual(resValid.isVerified, true, 'Must verify valid terminal evidence with detailed transactions');
    });

    // TC-05: Payout Webhook & Delayed Response Race: CAS update does NOT overwrite terminal status
    await test('TC-05 Payout Webhook & Delayed Response Race: CAS update does NOT overwrite terminal status or revert to PROCESSING', async () => {
      const withdrawal = await storeWalletService.requestWithdrawal(
        testStore.storeId,
        { amount: 150000, bankAccountId: testBankAcc.id.toString() },
      );
      created.withdrawalIds.push(withdrawal.withdrawalId);

      // 1. Worker/Admin claims PENDING -> PROCESSING
      await adminRepo.claimPendingWithdrawal(withdrawal.withdrawalId);

      // 2. Webhook arrives FIRST and confirms payout, transitioning withdrawal to COMPLETED
      await prisma.storeWithdrawal.update({
        where: { withdrawalId: withdrawal.withdrawalId },
        data: {
          status: 'COMPLETED',
          providerPayoutId: 'payos_webhook_first_111',
        },
      });

      // 3. Delayed API response arrives LATER attempting to supplement payout ID
      const delayedResponseSupplement = await adminRepo.supplementPayoutIdIfAllowed(
        withdrawal.withdrawalId,
        withdrawal.withdrawalCode,
        'payos_delayed_response_222',
        testUser.userId,
      );
      assert.strictEqual(
        delayedResponseSupplement,
        false,
        'Delayed response must be rejected via CAS because status is already terminal COMPLETED',
      );

      // 4. Verify terminal status and webhook payout ID were NOT corrupted
      const terminalCheck = await prisma.storeWithdrawal.findUnique({
        where: { withdrawalId: withdrawal.withdrawalId },
      });
      assert.strictEqual(terminalCheck?.status, 'COMPLETED', 'Status must remain COMPLETED, never reverted to PROCESSING');
      assert.strictEqual(terminalCheck?.providerPayoutId, 'payos_webhook_first_111', 'Webhook payout ID must be preserved');

      // 5. Concurrent webhook race on PROCESSING state: exactly one updates payout ID idempotently
      const withdrawal2 = await storeWalletService.requestWithdrawal(
        testStore.storeId,
        { amount: 160000, bankAccountId: testBankAcc.id.toString() },
      );
      created.withdrawalIds.push(withdrawal2.withdrawalId);
      await adminRepo.claimPendingWithdrawal(withdrawal2.withdrawalId);

      const [raceRes1, raceRes2] = await Promise.all([
        adminRepo.supplementPayoutIdIfAllowed(
          withdrawal2.withdrawalId,
          withdrawal2.withdrawalCode,
          'payos_shared_payout_333',
          testUser.userId,
        ),
        adminRepo.supplementPayoutIdIfAllowed(
          withdrawal2.withdrawalId,
          withdrawal2.withdrawalCode,
          'payos_shared_payout_333',
          testUser.userId,
        ),
      ]);
      assert.strictEqual(raceRes1, true);
      assert.strictEqual(raceRes2, true, 'Idempotent replay of same payout ID must safely succeed without duplicating or corrupting');
    });

    console.log('\n[SECTION 2] Store Bank Penny Verification, Atomic Outbox & Lease Tests');

    // TC-06: Store Bank 2.000đ Penny Verification Atomic Receipt & Outbox Creation
    await test('TC-06 Store Bank Penny Verification: Atomic inbound receipt & refund obligation in single DB transaction', async () => {
      const rawNumber = '091234567890';
      const verifyAcc = await prisma.storeBankAccount.create({
        data: {
          storeId: testStore.storeId,
          bankBin: '970422',
          bankName: 'MBBank',
          accountNumberEncrypted: CryptoVaultUtil.encryptAccountNumber(rawNumber),
          accountNumberHash: CryptoVaultUtil.hashAccountNumber(rawNumber),
          accountName: 'TEST SENDER',
          verificationStatus: 'PENDING',
          isDefault: false,
        },
      });
      created.bankAccountIds.push(verifyAcc.id);

      const refCode = `VERIFY_${rand}`;
      const verifyTx = await prisma.bankAccountVerificationTransaction.create({
        data: {
          bankAccountId: verifyAcc.id,
          referenceCode: refCode,
          expectedAmount: 2000,
          status: 'PENDING',
          expiresAt: new Date(Date.now() + 1800000),
        },
      });
      created.verificationTxIds.push(verifyTx.id);

      const txResult = await bankVerificationRepo.executeAtomicWebhookVerificationTx({
        referenceCode: refCode,
        receivedAmount: 2000,
        providerTransactionId: `payos_tx_${rand}`,
        senderAccountNumber: rawNumber,
        senderBankBin: '970422',
        destinationAccountNumber: '999888777666',
        destinationBankBin: '970422',
      });

      assert.strictEqual(txResult.success, true);
      assert.strictEqual(txResult.alreadyProcessed, false);
      assert.strictEqual(txResult.needsRefund, true);

      const savedReceipt = await prisma.storeBankInboundReceipt.findFirst({
        where: { verificationTxId: verifyTx.id },
      });
      assert.ok(savedReceipt, 'Receipt must persist in store_bank_inbound_receipts');
      assert.strictEqual(Number(savedReceipt?.amount), 2000);
      created.receiptIds.push(savedReceipt!.id);
      testReceipt = savedReceipt;

      const savedObligation = await prisma.storeBankRefundObligation.findFirst({
        where: { receiptId: savedReceipt!.id },
      });
      assert.ok(savedObligation, 'Obligation must persist in store_bank_refund_obligations');
      assert.strictEqual(savedObligation?.refundStatus, 'PENDING_REFUND');
      created.obligationIds.push(savedObligation!.id);
    });

    // TC-07: Worker Concurrency Lease via Atomic SQL CAS across independent DB connections
    await test('TC-07 Worker Concurrency Lease across independent DB connections: Exactly 1 worker acquires lease token, affectedRows === 1', async () => {
      const prisma2 = new PrismaService();
      await prisma2.$connect();
      const bankVerificationRepo2 = new BankVerificationRepository(prisma2);

      try {
        const obligation = await prisma.storeBankRefundObligation.findFirst({
          where: { id: { in: created.obligationIds } },
        });
        assert.ok(obligation, 'Must have in-flight obligation from TC-06');

        // Expire lease so both workers can contest it
        await prisma.storeBankRefundObligation.update({
          where: { id: obligation.id },
          data: {
            leaseExpiresAt: new Date(Date.now() - 1000),
          },
        });

        const token1 = `worker_conn1_${Date.now()}`;
        const token2 = `worker_conn2_${Date.now()}`;

        const claim1 = bankVerificationRepo.claimRefundObligationForDispatch(obligation.id, token1, 60000);
        const claim2 = bankVerificationRepo2.claimRefundObligationForDispatch(obligation.id, token2, 60000);

        const [res1, res2] = await Promise.all([claim1, claim2]);
        assert.strictEqual((res1 ? 1 : 0) + (res2 ? 1 : 0), 1, 'Only one worker connection can acquire lease token');

        const winnerToken = res1 ? token1 : token2;
        const refreshed = await prisma.storeBankRefundObligation.findUnique({
          where: { id: obligation.id },
        });
        assert.strictEqual(refreshed?.leaseToken, winnerToken);
        assert.strictEqual(refreshed?.refundStatus, 'PROCESSING');

        // Conclude obligation from TC-06/07 so it does not linger in pending worker queue
        await prisma.storeBankRefundObligation.update({
          where: { id: obligation.id },
          data: { refundStatus: 'REFUNDED', leaseToken: null, leaseExpiresAt: null },
        });
      } finally {
        await prisma2.$disconnect();
      }
    });

    // TC-08: Worker Crash Recovery before Saving Payout ID: Worker queries PayOS by reference and does NOT double-dispatch
    await test('TC-08 Worker Crash Recovery: Worker queries PayOS by reference before dispatching and avoids double payout', async () => {
      // 1. Create obligation that crashed: attemptCount = 1, providerPayoutId = NULL, lease expired
      const crashedRef = `REF_CRASH_${rand}_${Date.now()}`;
      const rawNumber = '091234567890';
      const crashedReceipt = await prisma.storeBankInboundReceipt.create({
        data: {
          verificationTxId: testReceipt.verificationTxId,
          providerTransactionId: `crashed_tx_${rand}_${Date.now()}`,
          amount: 2000,
          senderAccountNumberEncrypted: CryptoVaultUtil.encryptAccountNumber(rawNumber),
          senderAccountHash: CryptoVaultUtil.hashAccountNumber(rawNumber),
          senderBankBin: '970422',
          matchStatus: 'MATCHED',
        },
      });
      created.receiptIds.push(crashedReceipt.id);

      const crashedObligation = await prisma.storeBankRefundObligation.create({
        data: {
          receiptId: crashedReceipt.id,
          refundReference: crashedRef,
          refundAmount: 2000,
          targetBankBin: '970422',
          targetAccountEncrypted: CryptoVaultUtil.encryptAccountNumber(rawNumber),
          targetAccountHash: CryptoVaultUtil.hashAccountNumber(rawNumber),
          refundStatus: 'PROCESSING',
          attemptCount: 1, // simulated previous crashed attempt
          providerPayoutId: null, // CRASH happened BEFORE saving payout ID to DB!
          leaseToken: 'crashed_worker_token_dead',
          leaseExpiresAt: new Date(Date.now() - 10000), // lease expired 10s ago
          nextReconcileAt: new Date(Date.now() - 5000), // ready for takeover
        },
      });
      created.obligationIds.push(crashedObligation.id);

      let createRefundCallCount = 0;
      const mockCrashRecoveryPayos: any = {
        // getPayouts by reference finds the payout dispatched prior to the crash
        getPayouts: async (filter: { referenceId: string }) => {
          if (filter.referenceId === crashedRef) {
            return {
              code: '00',
              data: {
                payouts: [
                  {
                    id: 'payos_recovered_payout_id_888',
                    referenceId: crashedRef,
                  },
                ],
              },
            };
          }
          return { code: '00', data: { payouts: [] } };
        },
        // getPayout returns terminal SUCCEEDED evidence with detailed transactions
        getPayout: async (id: string) => ({
          code: '00',
          data: {
            id,
            approvalState: 'COMPLETED',
            transactions: [
              {
                id: 'tx_recov_001',
                referenceId: crashedRef,
                amount: 2000,
                toBin: '970422',
                toAccountNumber: rawNumber,
                state: 'SUCCEEDED',
              },
            ],
          },
        }),
        // Provider createRefund MUST NOT be called! If called, count it
        createRefund: async () => {
          createRefundCallCount++;
          throw new Error('FATAL: Double payout attempted! createRefund should not be called for existing reference.');
        },
      };

      const mockProviderNoDoubleSpend: any = {
        createRefund: async () => {
          createRefundCallCount++;
          throw new Error('FATAL: Double payout attempted via provider.createRefund!');
        },
      };

      const targetedRepo: any = Object.create(bankVerificationRepo);
      targetedRepo.findPendingStoreRefundObligations = async () => {
        const row = await prisma.storeBankRefundObligation.findUnique({
          where: { id: crashedObligation.id },
        });
        return row ? [{
          id: row.id,
          receipt_id: row.receiptId,
          refund_amount: row.refundAmount,
          refund_status: row.refundStatus,
          refund_reference: row.refundReference,
          target_bank_bin: row.targetBankBin,
          target_account_encrypted: row.targetAccountEncrypted,
          target_account_hash: row.targetAccountHash,
          attempt_count: row.attemptCount,
          provider_payout_id: row.providerPayoutId,
        }] : [];
      };

      const crashWorkerService = new BankVerificationService(
        prisma,
        targetedRepo,
        mockProviderNoDoubleSpend,
        mockCrashRecoveryPayos,
      );

      // Process worker batch: worker takes over expired lease
      await crashWorkerService.processStoreRefundWorkerBatch(10);

      // Assertions: zero double spending, obligation reconciled by reference
      assert.strictEqual(createRefundCallCount, 0, 'Zero money must be re-dispatched when reference was found on gateway');
      const recoveredRecord = await prisma.storeBankRefundObligation.findUnique({
        where: { id: crashedObligation.id },
      });
      assert.strictEqual(
        recoveredRecord?.refundStatus,
        'REFUNDED',
        'Crash recovery must finalize obligation to REFUNDED using evidence found by reference',
      );
      assert.strictEqual(
        recoveredRecord?.providerPayoutId,
        'payos_recovered_payout_id_888',
        'Payout ID discovered via reference lookup must be persisted',
      );
    });

    console.log('\n[SECTION 3] Rental Deposit & Anti-Head-of-Line Queue Tests');

    // TC-09: Single-Button Deposit Refund Reconciliation without Closing Multi-Button Contract
    await test('TC-09 Rental Contract Integrity: Reconciling 1 button refund updates ledger without closing parent rental', async () => {
      const packagePlan = await prisma.rentalPackage.create({
        data: {
          packageCode: `PKG_TEST_${rand}`,
          packageName: 'Test Package Multi-Button',
          monthlyPrice: 100000,
          depositFee: 500000,
          buttonQuantity: 2,
          isActive: true,
        },
      });
      created.packageIds.push(packagePlan.packageId);

      const customer = await prisma.customerProfile.create({
        data: {
          userId: testUser.userId,
          phone: `0911${rand.toString().padStart(6, '0')}`,
        },
      });
      created.customerProfileIds.push(customer.customerId);

      const rental = await prisma.buttonRental.create({
        data: {
          rentalCode: `RNT_MULTI_${rand}`,
          customerId: customer.customerId,
          packageId: packagePlan.packageId,
          fulfillmentStoreId: testStore.storeId,
          billingPolicy: 'STORE_RENT_CUSTOMER_DEPOSIT',
          status: 'ACTIVE',
          buttonQuantity: 2,
          totalRentAmount: 200000,
          startDate: new Date(),
          endDate: new Date(Date.now() + 30 * 86400000),
        },
      });
      created.rentalIds.push(rental.rentalId);

      const btn1 = await prisma.ioTButton.create({
        data: {
          deviceId: `dev-btn1-${rand}`,
          buttonCode: `BTN1_${rand}`,
          hmacSecret: crypto.randomBytes(32).toString('hex'),
          rentalId: rental.rentalId,
          customerId: customer.customerId,
          storeId: testStore.storeId,
          status: 'ACTIVE',
          inventoryState: 'IN_CUSTOMER_CUSTODY',
        },
      });
      created.buttonIds.push(btn1.buttonId);

      const btn2 = await prisma.ioTButton.create({
        data: {
          deviceId: `dev-btn2-${rand}`,
          buttonCode: `BTN2_${rand}`,
          hmacSecret: crypto.randomBytes(32).toString('hex'),
          rentalId: rental.rentalId,
          customerId: customer.customerId,
          storeId: testStore.storeId,
          status: 'ACTIVE',
          inventoryState: 'IN_CUSTOMER_CUSTODY',
        },
      });
      created.buttonIds.push(btn2.buttonId);

      const depositLedger = await prisma.rentalDeposit.create({
        data: {
          rentalId: rental.rentalId,
          collectedAmount: 1000000,
          heldAmount: 500000,
          refundReservedAmount: 500000,
          refundedAmount: 0,
        },
      });
      created.depositIds.push(depositLedger.depositId);

      const returnReq = await prisma.rentalReturn.create({
        data: {
          returnCode: `RET_BTN1_${rand}`,
          rentalId: rental.rentalId,
          buttonId: btn1.buttonId,
          status: 'INSPECTED',
        },
      });
      created.returnIds.push(returnReq.returnId);

      const depositRefund = await prisma.depositRefund.create({
        data: {
          refundCode: `REF_DEP_${rand}`,
          returnId: returnReq.returnId,
          rentalId: rental.rentalId,
          customerId: customer.customerId,
          amount: 500000,
          status: 'PENDING_PAYOUT',
          providerReferenceId: `payout_dep_${rand}`,
        },
      });
      created.refundIds.push(depositRefund.refundId);

      // Reconcile terminal payout for Button 1
      await rentalsRepo.confirmDepositRefundPayoutTx(
        depositRefund.refundId,
        `payout_dep_${rand}`,
        { userId: testUser.userId },
      );

      const checkedRefund = await prisma.depositRefund.findUnique({
        where: { refundId: depositRefund.refundId },
      });
      assert.strictEqual(checkedRefund?.status, 'REFUNDED');

      const updatedLedger = await prisma.rentalDeposit.findUnique({
        where: { rentalId: rental.rentalId },
      });
      assert.strictEqual(Number(updatedLedger?.refundedAmount), 500000);
      assert.strictEqual(Number(updatedLedger?.refundReservedAmount), 0);

      const checkedRental = await prisma.buttonRental.findUnique({
        where: { rentalId: rental.rentalId },
      });
      assert.strictEqual(
        checkedRental?.status,
        'ACTIVE',
        'Parent rental contract must remain ACTIVE because Button 2 is still in custody',
      );
    });

    // TC-10: Customer & Store Queue Anti-Head-of-Line Blocking with Exponential Backoff
    await test('TC-10 Anti-Head-of-Line Blocking: Items waiting on PayOS get nextReconcileAt backoff, allowing items behind to proceed', async () => {
      const inboundTx = await prisma.customerBankInboundTransaction.create({
        data: {
          provider: 'PAYOS',
          channel: 'BANK_TRANSFER',
          providerTransactionRef: `inbound_ref_${rand}`,
          amount: 2000,
          sourceAccountMasked: '******2109',
          sourceAccountHash: hashAcc,
          sourceBankBin: '970422',
          sessionMatchStatus: 'MATCHED',
          receivedAt: new Date(),
        },
      });
      created.inboundTxIds.push(inboundTx.id);

      const obligation = await prisma.customerBankRefundObligation.create({
        data: {
          inboundTransactionId: inboundTx.id,
          refundAmount: 2000,
          refundStatus: 'PENDING_REFUND',
          targetBankBin: '970422',
          targetAccountEncrypted: encAcc,
          targetAccountHash: hashAcc,
          refundPayoutReference: `REF_CUST_OBL_${rand}`,
        },
      });
      created.customerObligationIds.push(obligation.id);

      // Item 1: Stuck in PROCESSING on PayOS
      const attempt1 = await prisma.customerBankRefundPayoutAttempt.create({
        data: {
          obligationId: obligation.id,
          attemptNumber: 1,
          providerPayoutId: `payout_cust_stuck_${rand}`,
          payoutReference: `${obligation.refundPayoutReference}_att1`,
          dispatchedAt: new Date(Date.now() - 30000),
          status: 'PROCESSING',
          reconcileAttempts: 0,
        },
      });
      created.customerAttemptIds.push(attempt1.id);
      await prisma.customerBankRefundObligation.update({
        where: { id: obligation.id },
        data: { activePayoutAttemptId: attempt1.id },
      });

      // Item 2: Separate obligation behind Item 1, ready with terminal success
      const inboundTx2 = await prisma.customerBankInboundTransaction.create({
        data: {
          provider: 'PAYOS',
          channel: 'BANK_TRANSFER',
          providerTransactionRef: `inbound_ref2_${rand}`,
          amount: 2000,
          sourceAccountMasked: '******2109',
          sourceAccountHash: hashAcc,
          sourceBankBin: '970422',
          sessionMatchStatus: 'MATCHED',
          receivedAt: new Date(),
        },
      });
      created.inboundTxIds.push(inboundTx2.id);

      const obligation2 = await prisma.customerBankRefundObligation.create({
        data: {
          inboundTransactionId: inboundTx2.id,
          refundAmount: 2000,
          refundStatus: 'PENDING_REFUND',
          targetBankBin: '970422',
          targetAccountEncrypted: encAcc,
          targetAccountHash: hashAcc,
          refundPayoutReference: `REF_CUST_OBL2_${rand}`,
        },
      });
      created.customerObligationIds.push(obligation2.id);

      const attempt2 = await prisma.customerBankRefundPayoutAttempt.create({
        data: {
          obligationId: obligation2.id,
          attemptNumber: 1,
          providerPayoutId: `payout_cust_behind_${rand}`,
          payoutReference: `${obligation2.refundPayoutReference}_att1`,
          dispatchedAt: new Date(Date.now() - 10000),
          status: 'PROCESSING',
          reconcileAttempts: 0,
        },
      });
      created.customerAttemptIds.push(attempt2.id);
      await prisma.customerBankRefundObligation.update({
        where: { id: obligation2.id },
        data: { activePayoutAttemptId: attempt2.id },
      });

      // Mock PayOS returning PROCESSING for attempt 1
      const mockBackoffProvider: any = {
        getPayout: async (payoutId: string) => {
          if (payoutId === attempt1.providerPayoutId) {
            return {
              code: '00',
              data: {
                id: payoutId,
                approvalState: 'PROCESSING',
                transactions: [],
              },
            };
          }
          return {
            code: '00',
            data: {
              id: payoutId,
              approvalState: 'COMPLETED',
              transactions: [
                {
                  id: 'tx_cust_done',
                  referenceId: attempt2.payoutReference,
                  amount: 2000,
                  toBin: '970422',
                  toAccountNumber: rawAcc,
                  state: 'SUCCEEDED',
                },
              ],
            },
          };
        },
      };

      const customerServiceWithMock = new CustomerBankPennyVerificationService(
        customersRepo,
        mockBackoffProvider,
      );

      // Run reconciliation cycle
      await customerServiceWithMock.reconcilePendingRefundPayouts(10);

      // Check that Attempt 1 received backoff into the future
      const refreshedAttempt1 = await prisma.customerBankRefundPayoutAttempt.findUnique({
        where: { id: attempt1.id },
      });
      assert.ok(refreshedAttempt1?.nextReconcileAt, 'Attempt 1 must have nextReconcileAt assigned');
      assert.ok(
        refreshedAttempt1!.nextReconcileAt! > new Date(),
        'Attempt 1 nextReconcileAt must be pushed into the future',
      );
      assert.strictEqual(refreshedAttempt1?.reconcileAttempts, 1);

      // Check that Attempt 2 behind stuck Attempt 1 successfully completed to SUCCESS
      const refreshedAttempt2 = await prisma.customerBankRefundPayoutAttempt.findUnique({
        where: { id: attempt2.id },
      });
      assert.strictEqual(
        refreshedAttempt2?.status,
        'SUCCESS',
        'Attempt 2 behind stuck Attempt 1 must successfully complete and not be blocked',
      );

      // Now query pending queue again: Attempt 1 must be skipped (blocked by backoff), allowing behind items to proceed
      const pendingQueue = await customersRepo.findPendingReconciliationAttempts(10);
      const isAttempt1Included = pendingQueue.some((a) => a.id === attempt1.id);
      assert.strictEqual(
        isAttempt1Included,
        false,
        'Attempt 1 must NOT block head-of-line: it is deferred to nextReconcileAt',
      );
    });
  } finally {
    // Surgical fixture teardown: strictly restricted to IDs created by this test run
    console.log('\n[TEARDOWN] Cleaning up specific test fixtures by created ID...');
    try {
      if (created.refundIds.length > 0) {
        await prisma.depositRefund.deleteMany({ where: { refundId: { in: created.refundIds } } });
      }
      if (created.returnIds.length > 0) {
        await prisma.rentalReturn.deleteMany({ where: { returnId: { in: created.returnIds } } });
      }
      if (created.depositIds.length > 0) {
        await prisma.rentalDeposit.deleteMany({ where: { depositId: { in: created.depositIds } } });
      }
      if (created.buttonIds.length > 0) {
        await prisma.ioTButton.deleteMany({ where: { buttonId: { in: created.buttonIds } } });
      }
      if (created.rentalIds.length > 0) {
        await prisma.buttonRental.deleteMany({ where: { rentalId: { in: created.rentalIds } } });
      }
      if (created.packageIds.length > 0) {
        await prisma.rentalPackage.deleteMany({ where: { packageId: { in: created.packageIds } } });
      }
      if (created.obligationIds.length > 0) {
        await prisma.storeBankRefundObligation.deleteMany({ where: { id: { in: created.obligationIds } } });
      }
      if (created.receiptIds.length > 0) {
        await prisma.storeBankInboundReceipt.deleteMany({ where: { id: { in: created.receiptIds } } });
      }
      if (created.withdrawalIds.length > 0) {
        await prisma.storeWithdrawal.deleteMany({ where: { withdrawalId: { in: created.withdrawalIds } } });
      }
      if (created.bankAccountIds.length > 0) {
        await prisma.storeBankAccount.deleteMany({ where: { id: { in: created.bankAccountIds } } });
      }
      if (created.storeIds.length > 0) {
        await prisma.storeWallet.deleteMany({ where: { storeId: { in: created.storeIds } } });
        await prisma.store.deleteMany({ where: { storeId: { in: created.storeIds } } });
      }
      if (created.customerProfileIds.length > 0) {
        await prisma.customerProfile.deleteMany({ where: { customerId: { in: created.customerProfileIds } } });
      }
      if (created.customerObligationIds.length > 0) {
        await prisma.customerBankRefundObligation.updateMany({
          where: { id: { in: created.customerObligationIds } },
          data: { activePayoutAttemptId: null },
        });
      }
      if (created.customerAttemptIds.length > 0) {
        await prisma.customerBankRefundPayoutAttempt.deleteMany({ where: { id: { in: created.customerAttemptIds } } });
      }
      if (created.customerObligationIds.length > 0) {
        await prisma.customerBankRefundObligation.deleteMany({ where: { id: { in: created.customerObligationIds } } });
      }
      if (created.inboundTxIds.length > 0) {
        await prisma.customerBankInboundTransaction.deleteMany({ where: { id: { in: created.inboundTxIds } } });
      }
      if (created.verificationTxIds.length > 0) {
        await prisma.bankAccountVerificationTransaction.deleteMany({ where: { id: { in: created.verificationTxIds } } });
      }
      if (created.userIds.length > 0) {
        await prisma.user.deleteMany({ where: { userId: { in: created.userIds } } });
      }
      console.log('  ✔ Surgical cleanup completed cleanly.');
    } catch (cleanupErr: any) {
      console.error('Fatal cleanup error during teardown:', cleanupErr);
      throw cleanupErr; // Do not swallow cleanup errors!
    } finally {
      await prisma.$disconnect();
    }
  }

  console.log('\n========================================================================');
  console.log(`📊 MASTER TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('========================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

run().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
