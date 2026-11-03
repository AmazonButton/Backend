import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { PrismaClient, Prisma } from '@prisma/client';
import { CustomersRepository } from '../src/customers/customers.repository';
import { CryptoVaultUtil } from '../src/common/utils/crypto-vault.util';
import { PrismaService } from '../src/prisma/prisma.service';
import { validateTestDatabaseUrl } from './test-db-guard';

/**
 * ============================================================================
 * CLASSIFICATION: PostgreSQL Integration & Concurrency Acceptance Test Suite
 * ============================================================================
 * - Directly instantiates REAL CustomersRepository against live PostgreSQL instance.
 * - Zero mocking of repository methods or transactional database queries.
 * - Uses 2 independent database connection pools to verify row-locking (FOR UPDATE),
 *   unique constraints, idempotency, and concurrent observation reconciliation.
 * - Real repository fault-injection via scoped DB trigger verifying atomic rollback
 *   across all 4 entities in CustomersRepository.reconcileObservationsIntoConfirmedReceiptTx().
 * - MANDATORY SAFETY INVARIANT: Requires explicit TEST_DATABASE_URL ending with '_test'.
 *   Validated via validateTestDatabaseUrl; strictly prohibits fallback to DATABASE_URL
 *   or execution against Supabase production cloud poolers.
 * ============================================================================
 */

const EXPECTED_ASSERTIONS = 11;

async function runPostgresRepositoryConcurrencySuite() {
  console.log('================================================================================');
  console.log('🐘 CUSTOMERS REPOSITORY POSTGRESQL REAL CONCURRENCY & TRANSACTION AUDIT');
  console.log('   (Real DB Integration: Multi-Connection Row-Locking & Fault-Injection)');
  console.log('================================================================================\n');

  // 1. [P1 Guard]: Mandatory TEST_DATABASE_URL, strictly validated with test-db-guard
  const testDbUrlRaw = process.env.TEST_DATABASE_URL;
  if (!testDbUrlRaw || testDbUrlRaw.trim().length === 0) {
    throw new Error(
      '❌ [FATAL]: TEST_DATABASE_URL environment variable is mandatory for running PostgreSQL integration tests. Fallback to DATABASE_URL is strictly prohibited.',
    );
  }

  const validation = validateTestDatabaseUrl(testDbUrlRaw, process.env.DATABASE_URL);
  if (!validation.isValid || !validation.normalizedTestUrl) {
    throw new Error(`❌ [FATAL: TEST_DB_GUARD VIOLATION]: ${validation.error}`);
  }

  const validatedTestUrl = validation.normalizedTestUrl;

  // Two independent connection pools to simulate concurrent processes
  const prismaClient1 = new PrismaClient({ datasources: { db: { url: validatedTestUrl } } });
  const prismaClient2 = new PrismaClient({ datasources: { db: { url: validatedTestUrl } } });

  const repoClient1 = new CustomersRepository(prismaClient1 as unknown as PrismaService);
  const repoClient2 = new CustomersRepository(prismaClient2 as unknown as PrismaService);

  let passed = 0;
  let failed = 0;

  const testAssert = (condition: boolean, testName: string, detail?: string) => {
    if (condition) {
      console.log(`  ✔ [PASS] ${testName}`);
      passed++;
    } else {
      console.error(`  ✖ [FAIL] ${testName}${detail ? ` -> ${detail}` : ''}`);
      failed++;
    }
  };

  const ts = randomUUID().replace(/-/g, '');
  // Identifiers originate only from a UUID, never from input or connection URLs.
  const triggerName = `trg_recon_${ts}`;
  const functionName = `fn_recon_${ts}`;
  let functionCreated = false;
  let triggerCreated = false;
  const rawAccNumber = '098765432199';
  const testBankBin = '970422'; // MB Bank
  const accHash = CryptoVaultUtil.computeDeterministicAccountHash(rawAccNumber);
  const accMasked = CryptoVaultUtil.maskAccountNumber(rawAccNumber);
  const accEncrypted = CryptoVaultUtil.encryptAccountNumber(rawAccNumber);

  // Tracking entities for teardown
  let createdUserId: bigint | null = null;
  let createdCustomerId: bigint | null = null;
  let createdAccountId: bigint | null = null;
  let createdSessionId: bigint | null = null;
  let faultSessionId: bigint | null = null;
  let faultAccountId: bigint | null = null;

  let setupOrExecutionError: any = null;
  let cleanupError: any = null;

  try {
    await prismaClient1.$connect();
    await prismaClient2.$connect();

    // ------------------------------------------------------------------------
    // SETUP: Create isolated test user, customer profile, and bank account
    // ------------------------------------------------------------------------
    const user = await prismaClient1.user.create({
      data: {
        username: `repo_test_user_${ts}`,
        email: `repo_test_${ts}@antigravity.test`,
        passwordHash: 'dummy_hash_for_test',
        fullName: 'NGUYEN VAN REPO TEST',
      },
    });
    createdUserId = user.userId;

    const customer = await prismaClient1.customerProfile.create({
      data: {
        userId: user.userId,
      },
    });
    createdCustomerId = customer.customerId;

    const bankAccount = await prismaClient1.customerBankAccount.create({
      data: {
        customerId: customer.customerId,
        bankBin: testBankBin,
        bankCode: 'MB',
        bankName: 'MB Bank',
        accountNumberEncrypted: accEncrypted,
        accountNumberHash: accHash,
        accountNumberMasked: accMasked,
        accountName: 'NGUYEN VAN REPO TEST',
        verificationStatus: 'PENDING',
        isDefault: true,
      },
    });
    createdAccountId = bankAccount.id;

    const proof = await prismaClient1.customerBankVerificationProof.create({
      data: {
        customerId: customer.customerId,
        accountId: bankAccount.id,
        bankBin: testBankBin,
        accountNumberHash: accHash,
        proofReference: `PROOF_REPO_TEST_${ts}`,
        sessionStatus: 'ACTIVE',
        verificationStatus: 'PENDING',
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      },
    });
    createdSessionId = proof.id;

    // Create 2 unreferenced observations in PostgreSQL
    const obs1 = await prismaClient1.customerBankInboundTransaction.create({
      data: {
        proof: { connect: { id: proof.id } },
        provider: 'PAYOS',
        channel: 'PAYOS_WEBHOOK',
        providerTransactionRef: `UNREF_OBS_${ts}_1`,
        amount: new Prisma.Decimal(2000),
        receivedAt: new Date(),
        sourceBankBin: testBankBin,
        sourceAccountHash: accHash,
        sourceAccountMasked: accMasked,
        sourceAccountEncrypted: accEncrypted,
        hasSufficientEvidence: true,
        matchDecision: 'MISSING_TRANSACTION_REF',
        reconciliationFlag: 'FLAGGED_MISSING_PROVIDER_REF',
      },
    });

    const obs2 = await prismaClient1.customerBankInboundTransaction.create({
      data: {
        proof: { connect: { id: proof.id } },
        provider: 'PAYOS',
        channel: 'PAYOS_WEBHOOK',
        providerTransactionRef: `UNREF_OBS_${ts}_2`,
        amount: new Prisma.Decimal(2000),
        receivedAt: new Date(),
        sourceBankBin: testBankBin,
        sourceAccountHash: accHash,
        sourceAccountMasked: accMasked,
        sourceAccountEncrypted: accEncrypted,
        hasSufficientEvidence: true,
        matchDecision: 'MISSING_TRANSACTION_REF',
        reconciliationFlag: 'FLAGGED_MISSING_PROVIDER_REF',
      },
    });

    // ========================================================================
    // TEST 1: Hai kết nối độc lập đồng thời ghép cùng session & ref
    // ========================================================================
    console.log('--- TEST 1: Concurrency trên PostgreSQL: 2 Client đồng thời ghép cùng giao dịch ---');
    const confirmedRef = `FT_REAL_PG_${ts}`;

    // Wait for both concurrent operations to settle before any inspection or cleanup
    const concurrentResults = await Promise.allSettled([
      repoClient1.reconcileObservationsIntoConfirmedReceiptTx({
        sessionId: proof.id,
        observationIds: [obs1.id, obs2.id],
        confirmedTransactionRef: confirmedRef,
        amount: 2000,
        sourceBankBin: testBankBin,
        sourceAccountHash: accHash,
        sourceAccountMasked: accMasked,
        sourceAccountEncrypted: accEncrypted,
      }),
      repoClient2.reconcileObservationsIntoConfirmedReceiptTx({
        sessionId: proof.id,
        observationIds: [obs1.id, obs2.id],
        confirmedTransactionRef: confirmedRef,
        amount: 2000,
        sourceBankBin: testBankBin,
        sourceAccountHash: accHash,
        sourceAccountMasked: accMasked,
        sourceAccountEncrypted: accEncrypted,
      }),
    ]);

    const res1 = concurrentResults[0].status === 'fulfilled' ? concurrentResults[0].value : null;
    const res2 = concurrentResults[1].status === 'fulfilled' ? concurrentResults[1].value : null;

    testAssert(
      (res1 !== null && res2 !== null) &&
        ((res1.idempotent === false && res2.idempotent === true) ||
          (res1.idempotent === true && res2.idempotent === false)),
      'Hai request đồng thời qua 2 kết nối: Một request tạo mới, request kia nhận idempotent: true',
    );

    // Check DB state directly using raw query
    const confirmedInbounds = await prismaClient1.customerBankInboundTransaction.findMany({
      where: {
        providerTransactionRef: confirmedRef,
      },
      include: {
        refundObligation: true,
      },
    });

    testAssert(
      confirmedInbounds.length === 1,
      'PostgreSQL Unique Constraint & Row-Locking: Đúng 1 confirmed inbound transaction được tạo',
    );

    const obligations = await prismaClient1.customerBankRefundObligation.findMany({
      where: {
        inboundTransactionId: confirmedInbounds[0]?.id || BigInt(-1),
      },
    });
    testAssert(
      obligations.length === 1 && Number(obligations[0].refundAmount) === 2000,
      'PostgreSQL Concurrency: Đúng 1 refund obligation duy nhất được tạo cho giao dịch xác nhận (1:1)',
    );

    // Verify linked observations in DB
    const linkedObs = await prismaClient1.customerBankInboundTransaction.findMany({
      where: {
        mergedIntoInboundId: confirmedInbounds[0]?.id || BigInt(-1),
      },
    });
    testAssert(
      linkedObs.length === 2 && linkedObs.every((o) => o.matchDecision === 'MERGED_INTO_CONFIRMED'),
      'Hai observation được liên kết chính xác bằng Foreign Key merged_into_inbound_id trên PostgreSQL',
    );

    // ========================================================================
    // TEST 2: Fault-Injection qua DB Trigger: Gọi reconcileObservationsIntoConfirmedReceiptTx thật
    // ========================================================================
    console.log('\n--- TEST 2: Fault-Injection: Gọi trực tiếp repo, kích hoạt lỗi DB để xác minh Rollback toàn diện ---');
    // Independent ACTIVE/PENDING fixture: test 1 has already consumed its session.
    const faultHash = CryptoVaultUtil.computeDeterministicAccountHash('098765432198');
    const faultEncrypted = CryptoVaultUtil.encryptAccountNumber('098765432198');
    const faultMasked = CryptoVaultUtil.maskAccountNumber('098765432198');
    const faultAccount = await prismaClient1.customerBankAccount.create({
      data: {
        customerId: customer.customerId, bankBin: testBankBin, bankName: 'MB Bank',
        accountNumberEncrypted: faultEncrypted, accountNumberHash: faultHash,
        accountNumberMasked: faultMasked, accountName: 'REPO ROLLBACK TEST',
        verificationStatus: 'PENDING', isDefault: false,
      },
    });
    faultAccountId = faultAccount.id;
    const faultProof = await prismaClient1.customerBankVerificationProof.create({
      data: {
        customerId: customer.customerId, accountId: faultAccount.id,
        bankBin: testBankBin, accountNumberHash: faultHash,
        proofReference: `FAULT_PROOF_${ts}`, sessionStatus: 'ACTIVE',
        verificationStatus: 'PENDING', expiresAt: new Date(Date.now() + 900_000),
      },
    });
    faultSessionId = faultProof.id;
    const obsFault = await prismaClient1.customerBankInboundTransaction.create({
      data: {
        proof: { connect: { id: faultProof.id } },
        provider: 'PAYOS',
        channel: 'PAYOS_WEBHOOK',
        providerTransactionRef: `UNREF_OBS_FAULT_${ts}`,
        amount: new Prisma.Decimal(2000),
        receivedAt: new Date(),
        sourceBankBin: testBankBin,
        sourceAccountHash: faultHash,
        sourceAccountMasked: faultMasked,
        sourceAccountEncrypted: faultEncrypted,
        hasSufficientEvidence: true,
        matchDecision: 'MISSING_TRANSACTION_REF',
        reconciliationFlag: 'FLAGGED_MISSING_PROVIDER_REF',
      },
    });

    // Deferred failure occurs at commit, AFTER linking, obligation creation and
    // activation. One SQL statement per call; never replace another run's trigger.
    await prismaClient1.$executeRawUnsafe(`
      CREATE FUNCTION "${functionName}"()
      RETURNS TRIGGER AS $$
      BEGIN
        IF NEW.refund_payout_reference LIKE '%FAULT_TEST%' THEN
          RAISE EXCEPTION 'CONTROLLED_ROLLBACK_INDUCED_FOR_TEST';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    functionCreated = true;
    await prismaClient1.$executeRawUnsafe(`
      CREATE TRIGGER "${triggerName}"
      BEFORE INSERT ON customer_bank_refund_obligations
      FOR EACH ROW EXECUTE FUNCTION "${functionName}"()
    `);
    triggerCreated = true;

    const faultRef = `FT_FAULT_TEST_${ts}`;
    let faultError: any = null;

    try {
      await repoClient1.reconcileObservationsIntoConfirmedReceiptTx({
        sessionId: faultProof.id,
        observationIds: [obsFault.id],
        confirmedTransactionRef: faultRef,
        amount: 2000,
        sourceBankBin: testBankBin,
        sourceAccountHash: faultHash,
        sourceAccountMasked: faultMasked,
        sourceAccountEncrypted: faultEncrypted,
      });
    } catch (err: any) {
      faultError = err;
    }

    testAssert(
      faultError !== null &&
        `${faultError.message || ''} ${JSON.stringify(faultError.meta || {})}`.includes('CONTROLLED_ROLLBACK_INDUCED_FOR_TEST'),
      'Real repository reaches activation and fails at deferred commit trigger',
    );

    // Verify rollback 1: confirmed inbound must NOT exist
    const crashedInbound = await prismaClient1.customerBankInboundTransaction.findFirst({
      where: { providerTransactionRef: faultRef },
    });
    testAssert(
      crashedInbound === null,
      'PostgreSQL Rollback: Giao dịch xác nhận bị hủy hoàn toàn, không có bản ghi ma trong customer_bank_inbound_transactions',
    );

    // Verify rollback 2: no obligation created
    const crashedObligation = await prismaClient1.customerBankRefundObligation.findFirst({
      where: { inboundTransaction: { proofId: faultProof.id } },
    });
    testAssert(
      crashedObligation === null,
      'PostgreSQL Rollback: Không có nghĩa vụ hoàn tiền nào bị tạo dở dang trong customer_bank_refund_obligations',
    );

    // Verify rollback 3: observation must NOT be updated
    const untouchedObs = await prismaClient1.customerBankInboundTransaction.findUnique({
      where: { id: obsFault.id },
    });
    testAssert(
      untouchedObs !== null &&
        untouchedObs.mergedIntoInboundId === null &&
        untouchedObs.matchDecision === 'MISSING_TRANSACTION_REF' &&
        untouchedObs.reconciliationFlag === 'FLAGGED_MISSING_PROVIDER_REF',
      'PostgreSQL Rollback: Bản ghi observation giữ nguyên trạng thái ban đầu (mergedIntoInboundId = null, FLAGGED_MISSING_PROVIDER_REF)',
    );

    // Verify rollback 4: proof session state must not be consumed or altered
    const sessionAfterFault = await prismaClient1.customerBankVerificationProof.findUnique({
      where: { id: faultProof.id },
    });
    testAssert(
      sessionAfterFault !== null &&
        sessionAfterFault.sessionStatus === 'ACTIVE' &&
        sessionAfterFault.verificationStatus === 'PENDING' &&
        sessionAfterFault.status === 'PENDING' &&
        sessionAfterFault.verifiedAt === null &&
        sessionAfterFault.usedAt === null &&
        sessionAfterFault.verifiedByTransactionId === null,
      'PostgreSQL Rollback: Phiên xác minh giữ nguyên trạng thái ACTIVE, không bị tiêu thụ hay đổi con trỏ giao dịch xác minh',
    );
    const accountAfterFault = await prismaClient1.customerBankAccount.findUnique({
      where: { id: faultAccount.id },
    });
    testAssert(accountAfterFault?.verificationStatus === 'PENDING',
      'Account activation is rolled back to PENDING');

    // Positive control: identical input must succeed when fault is removed.
    await prismaClient1.$executeRawUnsafe(
      `DROP TRIGGER "${triggerName}" ON customer_bank_refund_obligations`,
    );
    triggerCreated = false;
    const recovered = await repoClient1.reconcileObservationsIntoConfirmedReceiptTx({
      sessionId: faultProof.id, observationIds: [obsFault.id],
      confirmedTransactionRef: faultRef, amount: 2000, sourceBankBin: testBankBin,
      sourceAccountHash: faultHash, sourceAccountMasked: faultMasked,
      sourceAccountEncrypted: faultEncrypted,
    });
    testAssert(recovered.shouldActivate === true && recovered.idempotent === false,
      'Same real repository call succeeds after removing the injected fault');
  } catch (error: any) {
    setupOrExecutionError = error;
    console.error('❌ Lỗi không lường trước trong quá trình setup/kiểm thử PostgreSQL:', error);
  } finally {
    // ------------------------------------------------------------------------
    // TEARDOWN: Dọn dẹp trigger và các bản ghi test
    // ------------------------------------------------------------------------
    console.log('\n--- Dọn dẹp trigger và dữ liệu kiểm thử an toàn ---');
    try {
      if (triggerCreated) await prismaClient1.$executeRawUnsafe(
        `DROP TRIGGER "${triggerName}" ON customer_bank_refund_obligations`,
      );
      if (functionCreated) await prismaClient1.$executeRawUnsafe(
        `DROP FUNCTION "${functionName}"()`,
      );
      const sessionIds = [createdSessionId, faultSessionId].filter((id): id is bigint => id !== null);
      // Recover every row owned by this run, including commits followed by failed assertions.
      if (sessionIds.length > 0) {
        await prismaClient1.customerBankVerificationProof.updateMany({
          where: { id: { in: sessionIds } }, data: { verifiedByTransactionId: null },
        });
        await prismaClient1.customerBankRefundObligation.deleteMany({
          where: { inboundTransaction: { proofId: { in: sessionIds } } },
        });
        await prismaClient1.customerBankInboundTransaction.updateMany({
          where: { proofId: { in: sessionIds } }, data: { mergedIntoInboundId: null },
        });
        await prismaClient1.customerBankInboundTransaction.deleteMany({
          where: { proofId: { in: sessionIds } },
        });
      }
      if (sessionIds.length > 0) {
        await prismaClient1.customerBankVerificationProof.deleteMany({
          where: { id: { in: sessionIds } },
        });
      }
      const accountIds = [createdAccountId, faultAccountId].filter((id): id is bigint => id !== null);
      if (accountIds.length > 0) {
        await prismaClient1.customerBankAccount.deleteMany({
          where: { id: { in: accountIds } },
        });
      }
      if (createdCustomerId) {
        await prismaClient1.customerProfile.deleteMany({
          where: { customerId: createdCustomerId },
        });
      }
      if (createdUserId) {
        await prismaClient1.user.deleteMany({
          where: { userId: createdUserId },
        });
      }
    } catch (err: any) {
      cleanupError = err;
      console.error('❌ Lỗi khi dọn dẹp dữ liệu test:', err);
    }

    const disconnects = await Promise.allSettled([prismaClient1.$disconnect(), prismaClient2.$disconnect()]);
    for (const result of disconnects) {
      if (result.status === 'rejected') cleanupError = cleanupError || result.reason;
    }
  }

  // Rethrow setup/execution or cleanup errors so the test runner fails reliably
  if (setupOrExecutionError) {
    throw setupOrExecutionError;
  }
  if (cleanupError) {
    throw new Error(`[CLEANUP_FAILURE]: Teardown failed: ${cleanupError.message || cleanupError}`);
  }

  console.log('\n================================================================================');
  console.log(`📊 SUMMARY: Total Passed: ${passed} | Failed: ${failed} (Expected: ${EXPECTED_ASSERTIONS})`);
  console.log('================================================================================\n');

  assert.strictEqual(failed, 0, 'Có lỗi kiểm thử trong bộ kiểm thử PostgreSQL!');
  assert.strictEqual(passed, EXPECTED_ASSERTIONS, `Số lượng assertion thực tế (${passed}) không khớp kỳ vọng (${EXPECTED_ASSERTIONS})!`);
}

runPostgresRepositoryConcurrencySuite().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
