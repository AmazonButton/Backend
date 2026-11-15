import { PrismaClient } from '@prisma/client';
import { CustomersRepository } from '../src/customers/customers.repository';

const prisma = new PrismaClient();

async function runCustomerRefundCoolingOffSuite() {
  console.log('================================================================================');
  console.log('⚡ CUSTOMER REFUND COOLING-OFF WINDOW TEST SUITE (12–24h ANTI-FRAUD / SETTLEMENT)');
  console.log('================================================================================\n');

  let passed = 0;
  let failed = 0;

  const assert = (condition: boolean, testName: string, detail?: string) => {
    if (condition) {
      console.log(`  ✔ [PASS] ${testName}`);
      passed++;
    } else {
      console.error(`  ✖ [FAIL] ${testName}${detail ? ` -> ${detail}` : ''}`);
      failed++;
    }
  };

  const ts = Date.now();
  let inboundTxYoung: any = null;
  let inboundTxMature: any = null;
  let obligationYoung: any = null;
  let obligationMature: any = null;

  try {
    const repo = new CustomersRepository(prisma as any);

    // Inbound tx 1: Young (1 hour ago)
    const oneHourAgo = new Date(Date.now() - 1 * 60 * 60 * 1000);
    inboundTxYoung = await prisma.customerBankInboundTransaction.create({
      data: {
        provider: 'PAYOS',
        channel: 'DEFAULT',
        providerTransactionRef: `REF_IN_YOUNG_${ts}`,
        amount: 2000,
        receivedAt: oneHourAgo,
        sourceBankBin: '970407',
        sourceAccountMasked: '******1234',
        sourceAccountHash: `hash_src_${ts}`,
        sourceAccountEncrypted: 'enc_src_test',
        sourceAccountName: 'TEST USER',
        createdAt: oneHourAgo,
      },
    });

    // Inbound tx 2: Mature (13 hours ago)
    const thirteenHoursAgo = new Date(Date.now() - 13 * 60 * 60 * 1000);
    inboundTxMature = await prisma.customerBankInboundTransaction.create({
      data: {
        provider: 'PAYOS',
        channel: 'DEFAULT',
        providerTransactionRef: `REF_IN_MATURE_${ts}`,
        amount: 2000,
        receivedAt: thirteenHoursAgo,
        sourceBankBin: '970407',
        sourceAccountMasked: '******1234',
        sourceAccountHash: `hash_src_mature_${ts}`,
        sourceAccountEncrypted: 'enc_src_mature_test',
        sourceAccountName: 'TEST USER',
        createdAt: thirteenHoursAgo,
      },
    });

    // Obligation 1: Young (1 hour ago)
    obligationYoung = await prisma.customerBankRefundObligation.create({
      data: {
        inboundTransactionId: inboundTxYoung.id,
        refundAmount: 2000,
        refundStatus: 'PENDING_REFUND',
        targetBankBin: '970407',
        targetAccountMasked: '******1234',
        targetAccountHash: `hash_${ts}`,
        targetAccountEncrypted: 'enc_num_test',
        targetAccountName: 'TEST USER',
        refundPayoutReference: `REF_PAYOUT_YOUNG_${ts}`,
        createdAt: oneHourAgo,
      },
    });

    // Obligation 2: Mature (13 hours ago)
    obligationMature = await prisma.customerBankRefundObligation.create({
      data: {
        inboundTransactionId: inboundTxMature.id,
        refundAmount: 2000,
        refundStatus: 'PENDING_REFUND',
        targetBankBin: '970407',
        targetAccountMasked: '******1234',
        targetAccountHash: `hash_mature_${ts}`,
        targetAccountEncrypted: 'enc_num_mature_test',
        targetAccountName: 'TEST USER',
        refundPayoutReference: `REF_PAYOUT_MATURE_${ts}`,
        createdAt: thirteenHoursAgo,
      },
    });

    console.log('--- Test Section 1: 12-Hour Default Cooling-Off Window ---');
    // Query with 12 hours cooling off
    const pending12h = await repo.findPendingRefundObligations(100, 12);
    const hasYoungIn12h = pending12h.some((o) => o.id === obligationYoung.id);
    const hasMatureIn12h = pending12h.some((o) => o.id === obligationMature.id);

    assert(
      !hasYoungIn12h,
      'Obligation created 1 hour ago is BLOCKED by 12h cooling-off window (not eligible for payout)',
      `Actual: young obligation present=${hasYoungIn12h}`,
    );
    assert(
      hasMatureIn12h,
      'Obligation created 13 hours ago is ELIGIBLE for payout (cooling-off window matured)',
      `Actual: mature obligation present=${hasMatureIn12h}`,
    );

    console.log('\n--- Test Section 2: 24-Hour Extended Cooling-Off Window ---');
    // Query with 24 hours cooling off
    const pending24h = await repo.findPendingRefundObligations(100, 24);
    const hasYoungIn24h = pending24h.some((o) => o.id === obligationYoung.id);
    const hasMatureIn24h = pending24h.some((o) => o.id === obligationMature.id);

    assert(
      !hasYoungIn24h && !hasMatureIn24h,
      'Both 1h and 13h obligations are BLOCKED when cooling-off window is extended to 24h',
      `Actual: young=${hasYoungIn24h}, mature=${hasMatureIn24h}`,
    );

    // Create a 25-hour old obligation
    const twentyFiveHoursAgo = new Date(Date.now() - 25 * 60 * 60 * 1000);
    const inboundTx25h = await prisma.customerBankInboundTransaction.create({
      data: {
        provider: 'PAYOS',
        channel: 'DEFAULT',
        providerTransactionRef: `REF_IN_25H_${ts}`,
        amount: 2000,
        receivedAt: twentyFiveHoursAgo,
        sourceBankBin: '970407',
        sourceAccountMasked: '******1234',
        sourceAccountHash: `hash_src_25h_${ts}`,
        sourceAccountEncrypted: 'enc_src_25h_test',
        sourceAccountName: 'TEST USER',
        createdAt: twentyFiveHoursAgo,
      },
    });

    const obligation25h = await prisma.customerBankRefundObligation.create({
      data: {
        inboundTransactionId: inboundTx25h.id,
        refundAmount: 2000,
        refundStatus: 'PENDING_REFUND',
        targetBankBin: '970407',
        targetAccountMasked: '******1234',
        targetAccountHash: `hash_25h_${ts}`,
        targetAccountEncrypted: 'enc_num_25h_test',
        targetAccountName: 'TEST USER',
        refundPayoutReference: `REF_PAYOUT_25H_${ts}`,
        createdAt: twentyFiveHoursAgo,
      },
    });

    const pending24hAfter = await repo.findPendingRefundObligations(100, 24);
    const has25h = pending24hAfter.some((o) => o.id === obligation25h.id);

    assert(
      has25h,
      'Obligation created 25 hours ago IS eligible when cooling-off window is 24h',
      `Actual: 25h obligation present=${has25h}`,
    );

    // Cleanup 25h fixtures
    await prisma.customerBankRefundObligation.delete({ where: { id: obligation25h.id } }).catch(() => {});
    await prisma.customerBankInboundTransaction.delete({ where: { id: inboundTx25h.id } }).catch(() => {});

    console.log('\n--- Test Section 3: Environment Variable Default Fallback ---');
    process.env.CUSTOMER_REFUND_COOLING_OFF_HOURS = '12';
    const pendingDefaultEnv = await repo.findPendingRefundObligations(100);
    const hasYoungDefault = pendingDefaultEnv.some((o) => o.id === obligationYoung.id);
    const hasMatureDefault = pendingDefaultEnv.some((o) => o.id === obligationMature.id);

    assert(
      !hasYoungDefault && hasMatureDefault,
      'Default parameterless call correctly reads CUSTOMER_REFUND_COOLING_OFF_HOURS env variable',
      `Actual: young=${hasYoungDefault}, mature=${hasMatureDefault}`,
    );

    console.log('\n================================================================================');
    console.log(`TEST SUITE RESULTS: ${passed} PASSED, ${failed} FAILED`);
    console.log('================================================================================\n');

    if (failed > 0) {
      process.exit(1);
    }
  } catch (err: any) {
    console.error('Fatal test error:', err);
    process.exit(1);
  } finally {
    // CLEANUP FIXTURES
    if (obligationYoung?.id) await prisma.customerBankRefundObligation.delete({ where: { id: obligationYoung.id } }).catch(() => {});
    if (obligationMature?.id) await prisma.customerBankRefundObligation.delete({ where: { id: obligationMature.id } }).catch(() => {});
    if (inboundTxYoung?.id) await prisma.customerBankInboundTransaction.delete({ where: { id: inboundTxYoung.id } }).catch(() => {});
    if (inboundTxMature?.id) await prisma.customerBankInboundTransaction.delete({ where: { id: inboundTxMature.id } }).catch(() => {});
    await prisma.$disconnect();
  }
}

runCustomerRefundCoolingOffSuite();
