/** In-process repository tests. No DB/network; NOT a concurrency acceptance test. */
import assert from 'node:assert/strict';
import { Prisma } from '@prisma/client';
import { BillingChargesRepository } from '../src/billing-charges/billing-charges.repository';

async function main() {
  const previousFlag = process.env.STORE_CASH_COLLECTION_ENABLED;
  process.env.STORE_CASH_COLLECTION_ENABLED = 'true';
  try {
    let receiptWrites = 0;
    let obligationWrites = 0;
    let deposits = 0;
    const charge = { charge_id: 11n, target_id: 7n, target_type: 'RENTAL', purpose: 'RENTAL_INITIAL',
      status: 'PAID', total_amount: new Prisma.Decimal(230000), currency: 'VND',
      payment_method: 'STORE_CASH_OFFSET', provider_transaction_code: null, payment_link_id: 'link-11' };
    let saved: any = null;
    const tx: any = {
      $queryRawUnsafe: async (sql: string) => sql.includes('billing_charges') ? [charge] : [],
      billingCharge: { findUnique: async () => ({ chargeId: 11n, status: 'PAID' }) },
      billingPaymentReceipt: {
        findUnique: async () => saved,
        create: async ({ data }: any) => { receiptWrites++; saved = { id: 3n, ...data }; return saved; },
      },
      billingOverpaymentObligation: { create: async () => { obligationWrites++; return { id: 4n }; } },
      rentalDeposit: { create: async () => { deposits++; } },
    };
    const prisma: any = { $transaction: async (fn: any) => fn(tx) };
    const repo = new BillingChargesRepository(prisma);
    const receipt: any = { provider: 'PAYOS', providerTransactionCode: 'real-bank-ref', amount: 230000,
      currency: 'VND', verified: true, paymentLinkId: 'link-11' };
    await repo.settleChargeAtomicTx(11n, receipt);
    assert.equal(receiptWrites, 1, 'Late real payment must not disappear behind PAID early return');
    assert.equal(obligationWrites, 1, 'Late payment creates one liability');
    assert.equal(deposits, 0, 'Late payment never increments deposit');
    assert.equal(saved.classification, 'OVERPAYMENT_RECEIPT');
    await repo.settleChargeAtomicTx(11n, receipt);
    assert.equal(receiptWrites, 1, 'Replay reuses receipt');
    assert.equal(obligationWrites, 1, 'Replay does not create another liability');
    await assert.rejects(() => repo.settleChargeAtomicTx(11n, { ...receipt, amount: 240000 }));
    await assert.rejects(() => repo.settleChargeAtomicTx(11n, { ...receipt, paymentLinkId: 'foreign-link' }));
    console.log('PASS: late-payment and replay repository tests (mock transaction only).');
  } finally {
    if (previousFlag === undefined) delete process.env.STORE_CASH_COLLECTION_ENABLED;
    else process.env.STORE_CASH_COLLECTION_ENABLED = previousFlag;
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
