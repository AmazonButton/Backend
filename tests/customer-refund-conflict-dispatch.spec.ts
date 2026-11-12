import assert from 'node:assert/strict';
import { CustomersRepository } from '../src/customers/customers.repository';

async function run() {
  let flag: string | null = null;
  const obligation: any = { id: 1n, inboundTransactionId: 2n, activePayoutAttemptId: 3n,
    refundStatus: 'PROCESSING_REFUND', inboundTransaction: { reconciliationFlag: null } };
  const attempt: any = { id: 3n, obligationId: 1n, status: 'PREPARING' };
  const tx: any = {
    $queryRaw: async () => [{ id: 1n }],
    customerBankInboundTransaction: { update: async ({ data }: any) => {
      flag = data.reconciliationFlag;
      obligation.inboundTransaction.reconciliationFlag = flag;
      return { id: 2n, ...data };
    } },
    customerBankRefundObligation: {
      findUnique: async () => obligation,
      update: async ({ data }: any) => Object.assign(obligation, data),
      updateMany: async ({ data }: any) => {
        if (obligation.activePayoutAttemptId === null && ['PENDING_REFUND', 'PROCESSING_REFUND'].includes(obligation.refundStatus)) Object.assign(obligation, data);
        return { count: 1 };
      },
    },
    customerBankRefundPayoutAttempt: {
      findUnique: async () => attempt,
      update: async ({ data }: any) => Object.assign(attempt, data),
    },
  };
  const repo = new CustomersRepository({ $transaction: async (fn: any) => fn(tx) } as any);
  await repo.flagConflictingInboundTransaction(2n, 'FLAGGED_CONFLICTING_DUPLICATE_PAYLOAD');
  assert.equal(await repo.authorizeRefundDispatchTx(1n, 3n), false);
  assert.equal(attempt.status, 'FAILED');
  assert.equal(obligation.refundStatus, 'PENDING_MANUAL_REFUND');
  assert.equal(obligation.activePayoutAttemptId, null);

  obligation.inboundTransaction.reconciliationFlag = null;
  obligation.activePayoutAttemptId = 3n;
  obligation.refundStatus = 'PROCESSING_REFUND';
  attempt.status = 'PREPARING';
  assert.equal(await repo.authorizeRefundDispatchTx(1n, 3n), true);
  assert.equal(attempt.status, 'SUBMITTED');
  await repo.flagConflictingInboundTransaction(2n, 'FLAGGED_CONFLICTING_DUPLICATE_PAYLOAD');
  assert.equal(attempt.status, 'SUBMITTED');
  assert.equal(obligation.activePayoutAttemptId, 3n);
  assert.equal(await repo.authorizeRefundDispatchTx(1n, 3n), false);

  obligation.activePayoutAttemptId = null;
  obligation.refundStatus = 'PENDING_REFUND';
  await repo.flagConflictingInboundTransaction(2n, 'FLAGGED_CONFLICTING_DUPLICATE_PAYLOAD');
  assert.equal(obligation.refundStatus, 'PENDING_MANUAL_REFUND');
  console.log('PASS: conflict before dispatch blocks payout; authorized attempts stay reconcilable; pending obligations held.');
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
