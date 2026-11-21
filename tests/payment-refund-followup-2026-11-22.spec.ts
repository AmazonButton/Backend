/** Follow-up audit reproductions. Guarded test DB + in-memory payout provider only.
 * Assertions express the intended invariants; failures are audit evidence.
 * Not registered in the normal CI suite runner.
 */
import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getSafeTestPrismaService } from './test-db-guard';
import { PaymentsRepository } from '../src/payments/payments.repository';
import { PaymentsService } from '../src/payments/payments.service';
import { PaymentRefundsRepository } from '../src/payments/payment-refunds.repository';
import { PaymentRefundsService } from '../src/payments/payment-refunds.service';
import { CryptoVaultUtil } from '../src/common/utils/crypto-vault.util';
import { signWebhookData } from '../src/payments/payos.helper';

async function main() {
  const p = getSafeTestPrismaService('Payment refund follow-up audit isolated fixtures');
  const prefix = `RFA${Date.now()}${randomUUID().slice(0, 4)}`;
  const originalChecksum = process.env.PAYOS_CHECKSUM_KEY;
  process.env.PAYOS_CHECKSUM_KEY = 'refund-followup-local-signature-only';
  let ownerId: bigint | undefined;
  let userId: bigint | undefined;
  let customerId: bigint | undefined;
  let storeId: bigint | undefined;
  let seq = 0;
  let creates = 0;
  let lookupErrors = 0;
  let failed = 0;
  let passed = 0;
  const account = `000${String(Date.now()).slice(-9)}`;
  const providerData = new Map<string, any>();
  const refunds = new PaymentRefundsRepository(p);
  const provider = {
    getPayouts: async ({ referenceId }: any) => {
      if (lookupErrors > 0) { lookupErrors--; throw new Error('Simulated pre-dispatch GET timeout'); }
      return { code: '00', data: { payouts: [...providerData.values()].filter(x => x.referenceId === referenceId) } };
    },
    getPayout: async (id: string) => ({ code: '00', data: providerData.get(id) || null }),
    createPayout: async (request: any) => {
      creates++;
      const result = { id: `${prefix}-payout-${creates}`, referenceId: request.referenceId,
        approvalState: 'SUCCEEDED', transactions: [{ id: `${prefix}-detail-${creates}`,
          referenceId: request.referenceId, amount: request.amount, toBin: request.toBin,
          toAccountNumber: request.toAccountNumber, state: 'SUCCEEDED' }] };
      providerData.set(result.id, result);
      return { code: '00', data: result };
    },
  };
  const refundService = new PaymentRefundsService(refunds, provider as any);
  const payments = new PaymentsRepository(p, refunds);
  const service = new PaymentsService(payments, undefined, undefined, undefined, undefined, undefined, refundService);
  const check = async (name: string, fn: () => Promise<void>) => {
    try { await fn(); passed++; console.log(`PASS ${name}`); }
    catch (error: any) { failed++; console.log(`FAIL ${name}: ${error.message}`); }
  };
  const mk = async (alreadyPaid = false) => {
    const order = await p.order.create({ data: { orderCode: `${prefix}-${++seq}`, storeId: storeId!, customerId,
      orderStatus: alreadyPaid ? 'CONFIRMED' : 'PENDING', paymentStatus: alreadyPaid ? 'PAID' : 'UNPAID',
      paymentMethod: 'PAYOS', subtotalAmount: 100000, totalAmount: 100000,
      shippingRecipientName: 'Synthetic audit', shippingPhone: '0000000000', shippingAddress: 'Audit fixture' } });
    const payment = await p.paymentTransaction.create({ data: { orderId: order.orderId,
      provider: 'PAYOS', transactionCode: `${Date.now()}${String(++seq).padStart(3, '0')}`,
      amount: 100000, status: alreadyPaid ? 'PAID' : 'PENDING', paymentMethod: 'QR',
      paymentLinkId: `${prefix}-link-${seq}` } });
    return { order, payment };
  };
  const send = async (payment: any, reference: string, amount = 100000, source = account) => {
    const data = { code: '00', orderCode: Number(payment.transactionCode), amount, currency: 'VND',
      paymentLinkId: payment.paymentLinkId, reference, transactionDateTime: new Date().toISOString(),
      counterAccountBankId: '970422', counterAccountNumber: source, counterAccountName: 'Synthetic audit' };
    return service.handlePayosWebhook({ code: '00', desc: 'success', success: true, data,
      signature: signWebhookData(data, process.env.PAYOS_CHECKSUM_KEY!) } as any);
  };
  const excessCase = async () => {
    const fixture = await mk();
    await send(fixture.payment, `${prefix}-main-${seq}`);
    const extraRef = `${prefix}-extra-${seq}`;
    await send(fixture.payment, extraRef, 30000);
    const [obligation] = await refunds.findObligationsForOrder(fixture.order.orderId);
    assert.ok(obligation, 'Fixture must contain one excess obligation');
    return { ...fixture, obligation, extraRef };
  };
  try {
    await p.$connect();
    ownerId = (await p.user.create({ data: { username: `${prefix}-owner`, email: `${prefix}-owner@example.invalid`,
      fullName: 'Synthetic refund audit', passwordHash: 'test-placeholder-not-a-login-hash-padding-to-at-least-60-characters', status: 'ACTIVE' } })).userId;
    storeId = (await p.store.create({ data: { code: prefix, name: prefix, ownerUserId: ownerId,
      phone: '0000000000', address: 'Audit fixture', status: 'ACTIVE' } })).storeId;
    userId = (await p.user.create({ data: { username: `${prefix}-customer`, email: `${prefix}-customer@example.invalid`,
      fullName: 'Synthetic refund audit', passwordHash: 'test-placeholder-not-a-login-hash-padding-to-at-least-60-characters', status: 'ACTIVE' } })).userId;
    customerId = (await p.customerProfile.create({ data: { userId } })).customerId;
    await p.customerBankAccount.create({ data: { customerId, bankCode: 'MB', bankName: 'MBBank', bankBin: '970422',
      accountNumberEncrypted: CryptoVaultUtil.encryptAccountNumber(account),
      accountNumberHash: CryptoVaultUtil.computeDeterministicAccountHash(account),
      accountNumberMasked: CryptoVaultUtil.maskAccountNumber(account), accountName: 'Synthetic audit',
      verificationStatus: 'VERIFIED', isDefault: true } });
    const actor = { userId: ownerId, role: 'SUPER_ADMIN' };

    await check('R1 legacy primary receipt plus replay does not become new refundable cash', async () => {
      const { order, payment } = await mk(true);
      // Reproduce exactly the identity/classification emitted by migration backfill 6a; no DDL.
      await p.paymentOrderReceipt.create({ data: { orderId: order.orderId,
        paymentTransactionId: payment.paymentTransactionId, provider: 'PAYOS', channel: 'LEGACY_BACKFILL',
        providerTransactionRef: `LEGACY_PT_${payment.paymentTransactionId}`, paymentLinkId: payment.paymentLinkId,
        amount: 100000, currency: 'VND', classification: 'ORDER_PAYMENT', sourceEvidenceStatus: 'MISSING' } });
      await send(payment, `${prefix}-original-bank-reference`);
      const receipts = await p.paymentOrderReceipt.findMany({ where: { orderId: order.orderId } });
      const obligations = await refunds.findObligationsForOrder(order.orderId);
      const before = creates;
      if (obligations[0]?.status === 'READY_FOR_PAYOUT') {
        await refundService.initiateObligationPayout(obligations[0].obligationId, {}, actor);
      }
      console.log('R1_OBSERVED', JSON.stringify({ receipts: receipts.length,
        ledgerAmount: receipts.reduce((sum, r) => sum + Number(r.amount), 0),
        newObligations: obligations.length, mockPayouts: creates - before }));
      assert.equal(obligations.length, 0, 'Replay of pre-migration payment must not create an automatic excess refund');
    });

    await check('R2 concurrent extra transfer uses payment state after lock for amount handling', async () => {
      const { order, payment } = await mk();
      const original = payments.findTransactionByCode.bind(payments);
      let release!: () => void;
      let notify!: () => void;
      const gate = new Promise<void>(r => { release = r; });
      const read = new Promise<void>(r => { notify = r; });
      let calls = 0;
      payments.findTransactionByCode = async code => {
        const value = await original(code);
        if (++calls === 1) { notify(); await gate; }
        return value;
      };
      const extraRef = `${prefix}-concurrent-extra`;
      const extra = send(payment, extraRef, 30000);
      try { await read; await send(payment, `${prefix}-concurrent-main`); }
      finally { release(); }
      let response: any;
      try { response = await extra; } finally { payments.findTransactionByCode = original; }
      console.log('R2_OBSERVED', JSON.stringify(response));
      assert.equal(await p.paymentOrderReceipt.count({ where: { orderId: order.orderId, providerTransactionRef: extraRef } }),
        1, 'Verified extra receipt must survive a stale pre-lock PENDING snapshot');
    });

    await check('R3 failed GET before POST leaves a recoverable dispatch after lookup becomes healthy', async () => {
      const { obligation } = await excessCase();
      const claim = await refunds.claimObligationForPayoutTx(obligation.obligationId, ownerId);
      const before = creates;
      lookupErrors = 1;
      await refundService.dispatchClaimedAttempt(obligation.obligationId, claim.attempt!.attemptId);
      // All provider lookups are now healthy and prove no payout with this reference exists.
      await refundService.dispatchClaimedAttempt(obligation.obligationId, claim.attempt!.attemptId);
      const after = await refunds.findObligationById(obligation.obligationId);
      console.log('R3_OBSERVED', JSON.stringify({ status: after?.status, mockPayouts: creates - before,
        attemptStatus: after?.payoutAttempts[0]?.status }));
      assert.equal(creates - before, 1, 'No POST was attempted: a transient pre-lookup error must not strand the obligation forever');
    });

    await check('R4 contradictory receipt discovered after claim blocks payout before POST', async () => {
      const { payment, obligation, extraRef } = await excessCase();
      const claim = await refunds.claimObligationForPayoutTx(obligation.obligationId, ownerId);
      await send(payment, extraRef, 30000, `111${account.slice(3)}`);
      const receipt = await p.paymentOrderReceipt.findUniqueOrThrow({ where: { receiptId: obligation.receiptId } });
      assert.equal(receipt.sourceEvidenceStatus, 'CONFLICTING');
      const before = creates;
      await refundService.dispatchClaimedAttempt(obligation.obligationId, claim.attempt!.attemptId);
      const after = await refunds.findObligationById(obligation.obligationId);
      console.log('R4_OBSERVED', JSON.stringify({ evidence: receipt.sourceEvidenceStatus,
        status: after?.status, mockPayouts: creates - before }));
      assert.equal(creates - before, 0, 'Source conflict was known before dispatch but payout still proceeded');
    });
  } finally {
    if (originalChecksum === undefined) delete process.env.PAYOS_CHECKSUM_KEY;
    else process.env.PAYOS_CHECKSUM_KEY = originalChecksum;
    try {
      if (storeId !== undefined) {
        const orders = await p.order.findMany({ where: { storeId }, select: { orderId: true } });
        const ids = orders.map(o => o.orderId);
        const obligations = await p.paymentRefundObligation.findMany({ where: { orderId: { in: ids } }, select: { obligationId: true } });
        const obligationIds = obligations.map(o => o.obligationId);
        await p.paymentRefundVerifiedVoucher.deleteMany({ where: { obligationId: { in: obligationIds } } });
        await p.paymentRefundObligation.updateMany({ where: { obligationId: { in: obligationIds } }, data: { activePayoutAttemptId: null, settledAttemptId: null } });
        await p.paymentRefundPayoutAttempt.deleteMany({ where: { obligationId: { in: obligationIds } } });
        await p.paymentRefundObligation.deleteMany({ where: { obligationId: { in: obligationIds } } });
        for (const id of ids) await p.$executeRawUnsafe(
          `DELETE FROM outbox_events WHERE event_type = 'PAYMENT_REFUND_PAYOUT' AND payload->>'orderId' = $1`, String(id));
        await p.paymentOrderReceipt.deleteMany({ where: { orderId: { in: ids } } });
        await p.orderStatusHistory.deleteMany({ where: { orderId: { in: ids } } });
        await p.paymentTransaction.deleteMany({ where: { orderId: { in: ids } } });
        await p.orderItem.deleteMany({ where: { orderId: { in: ids } } });
        await p.order.deleteMany({ where: { storeId } });
        await p.store.delete({ where: { storeId } });
      }
      if (customerId !== undefined) {
        await p.customerBankAccount.deleteMany({ where: { customerId } });
        await p.customerProfile.delete({ where: { customerId } });
      }
      if (userId !== undefined) { await p.notification.deleteMany({ where: { userId } }); await p.user.delete({ where: { userId } }); }
      if (ownerId !== undefined) await p.user.delete({ where: { userId: ownerId } });
      console.log(`FOLLOWUP_CLEANUP_OK ${prefix}`);
    } finally { await p.$disconnect(); }
  }
  console.log(`FOLLOWUP_RESULTS passed=${passed} failed=${failed}`);
  if (failed) process.exitCode = 1;
}
main().catch((e: any) => {
  console.error('FOLLOWUP_FATAL', e?.code || e?.name, String(e?.message || '').replace(/postgres(?:ql)?:\/\/\S+/g, '[redacted]'));
  process.exitCode = 1;
});
