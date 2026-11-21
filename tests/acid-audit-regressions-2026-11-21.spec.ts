/**
 * Focused ACID audit regressions. Assertions express required business behavior;
 * failures on the reviewed source reproduce audit findings, not passing fixes.
 * Run explicitly; intentionally NOT registered in run_all_suites.ts.
 *
 * Mock I/O only: node node_modules/tsx/dist/cli.mjs tests/acid-audit-regressions-2026-11-21.spec.ts
 * Guarded PostgreSQL fixtures: append --live (requires test-db-guard allowlist).
 * No external payment, payout, email or notification provider is called.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { BadRequestException, ForbiddenException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PaymentsRepository } from '../src/payments/payments.repository';
import { PaymentsService } from '../src/payments/payments.service';
import { PaymentRefundsRepository } from '../src/payments/payment-refunds.repository';
import { PaymentRefundsService } from '../src/payments/payment-refunds.service';
import { OrdersRepository } from '../src/orders/orders.repository';
import { OrdersService } from '../src/orders/orders.service';
import { StorefrontController } from '../src/orders/storefront.controller';
import { ProductsRepository } from '../src/products/products.repository';
import { IdempotencyRepository } from '../src/common/idempotency/idempotency.repository';
import { IdempotencyService } from '../src/common/idempotency/idempotency.service';
import { IdempotencyInterceptor } from '../src/common/idempotency/idempotency.interceptor';
import { CryptoVaultUtil } from '../src/common/utils/crypto-vault.util';
import { lastValueFrom } from 'rxjs';
import { signWebhookData } from '../src/payments/payos.helper';

type Outcome = { name: string; passed: boolean; observed?: string };
const outcomes: Outcome[] = [];
async function check(name: string, action: () => Promise<void>) {
  try {
    await action();
    outcomes.push({ name, passed: true });
    console.log(`PASS ${name}`);
  } catch (error: any) {
    const observed = String(error?.message || error).slice(0, 900);
    outcomes.push({ name, passed: false, observed });
    console.log(`FAIL ${name}: ${observed}`);
  }
}

function paymentFixture(orderStatus = 'PENDING', paidSibling = false) {
  const order: any = {
    order_id: 1n, order_code: 'AUDIT-ORDER', store_id: 2n, customer_id: null,
    order_status: orderStatus, payment_status: paidSibling ? 'PAID' : 'UNPAID', payment_method: 'PAYOS',
  };
  const payment: any = { payment_transaction_id: 3n, order_id: 1n,
    status: paidSibling ? 'CANCELLED' : 'PENDING', amount: new Prisma.Decimal(100000) };
  const entity = () => ({ paymentTransactionId: 3n, orderId: 1n, status: payment.status,
    order: { orderId: 1n, orderStatus: order.order_status, paymentStatus: order.payment_status } });
  const tx: any = {
    $queryRawUnsafe: async (sql: string) => {
      if (sql.includes('FROM customer_profile')) return [];
      if (sql.includes('FROM payment_transaction')) return [{ ...payment }];
      if (sql.includes('FROM orders')) return [{ ...order }];
      throw new Error('Unexpected fixture query');
    },
    paymentTransaction: {
      findFirst: async () => paidSibling ? { paymentTransactionId: 4n, status: 'PAID' } : null,
      update: async ({ data }: any) => { Object.assign(payment, data); return entity(); },
      findUnique: async () => entity(),
    },
    order: { update: async ({ data }: any) => {
      if (data.orderStatus) order.order_status = data.orderStatus;
      if (data.paymentStatus) order.payment_status = data.paymentStatus;
      return entity().order;
    } },
    orderStatusHistory: { create: async () => ({}) },
  };
  const repo = new PaymentsRepository({ $transaction: async (fn: any) => fn(tx) } as any);
  return { order, payment, repo };
}

async function runMockChecks() {
  await check('M0 control: payment on PENDING PayOS order becomes PAID/CONFIRMED', async () => {
    const fixture = paymentFixture();
    await fixture.repo.confirmPaymentAtomicTx(3n);
    assert.equal(fixture.order.payment_status, 'PAID');
    assert.equal(fixture.order.order_status, 'CONFIRMED');
  });
  await check('M1 payment on PREPARING PayOS order preserves fulfillment and marks PAID', async () => {
    const fixture = paymentFixture('PREPARING');
    await fixture.repo.confirmPaymentAtomicTx(3n);
    assert.equal(fixture.payment.status, 'PAID');
    assert.equal(fixture.order.order_status, 'PREPARING');
    assert.equal(fixture.order.payment_status, 'PAID', 'Verified payment was incorrectly routed to refund');
  });
  await check('M2 obsolete link receipt does not demote order backed by a PAID replacement', async () => {
    const fixture = paymentFixture('CONFIRMED', true);
    await fixture.repo.confirmPaymentAtomicTx(3n);
    assert.equal(fixture.payment.status, 'REFUND_PENDING');
    assert.equal(fixture.order.payment_status, 'PAID', 'An extra receipt overwrote the main order payment state');
  });
}

async function runLiveChecks() {
  // Import dotenv/guard only for the explicitly requested live mode.
  await import('dotenv/config');
  const { getSafeTestPrismaService } = await import('./test-db-guard');
  const p = getSafeTestPrismaService('ACID audit 2026-11-21 isolated fixtures');
  const prefix = `AA${Date.now()}${randomUUID().slice(0, 5)}`;
  const oldChecksum = process.env.PAYOS_CHECKSUM_KEY;
  let ownerId: bigint | undefined;
  let storeId: bigint | undefined;
  let sequence = 0;
  const paymentRepo = new PaymentsRepository(p);
  const orderRepo = new OrdersRepository(p);
  const newOrder = async (status: string, paymentStatus = 'UNPAID') => p.order.create({ data: {
    orderCode: `${prefix}-${++sequence}`, storeId: storeId!, orderStatus: status,
    paymentStatus, paymentMethod: 'PAYOS', subtotalAmount: 100000, totalAmount: 100000,
    shippingRecipientName: 'Synthetic audit fixture', shippingPhone: '0000000000', shippingAddress: 'Audit fixture',
  } });
  const newPayment = async (orderId: bigint, status = 'PENDING') => p.paymentTransaction.create({ data: {
    orderId, provider: 'PAYOS', transactionCode: `${Date.now()}${String(++sequence).padStart(3, '0')}`,
    amount: 100000, paymentMethod: 'QR', status, paymentLinkId: `${prefix}-link-${sequence}`,
  } });
  const newProduct = async () => p.product.create({ data: {
    storeId: storeId!, productName: `Audit Product ${++sequence}`, productCode: `${prefix}-${sequence}`,
    basePrice: 50000, status: 'ACTIVE',
    inventory: { create: { storeId: storeId!, quantityOnHand: 5, reservedQuantity: 0 } },
  } });
  try {
    await p.$connect();
    const owner = await p.user.create({ data: { username: prefix, email: `${prefix}@example.invalid`,
      passwordHash: 'audit-fixture-not-a-login-hash', fullName: 'Synthetic ACID Audit', status: 'ACTIVE' } });
    ownerId = owner.userId;
    const store = await p.store.create({ data: { code: prefix, name: prefix, ownerUserId: ownerId,
      phone: '0000000000', address: 'Audit fixture', status: 'ACTIVE' } });
    storeId = store.storeId;

    await check('L0 control: insufficient storefront stock creates no order or reservation', async () => {
      const product = await newProduct();
      const before = await p.order.count({ where: { storeId } });
      await assert.rejects(() => orderRepo.createStorefrontOrderTx({ storeId: storeId!,
        items: [{ productId: product.productId.toString(), quantity: 6 }], customerName: 'Audit',
        customerPhone: '0000000000', deliveryAddress: 'Audit', paymentMethod: 'COD' }), BadRequestException);
      assert.equal(await p.order.count({ where: { storeId } }), before);
      assert.equal((await p.inventory.findUniqueOrThrow({ where: { productId: product.productId } })).reservedQuantity, 0);
    });

    await check('L1 verified payment on an already CONFIRMED order is not a refund', async () => {
      const order = await newOrder('CONFIRMED');
      const payment = await newPayment(order.orderId);
      await paymentRepo.confirmPaymentAtomicTx(payment.paymentTransactionId);
      const after = await p.order.findUniqueOrThrow({ where: { orderId: order.orderId } });
      assert.equal(after.orderStatus, 'CONFIRMED');
      assert.equal(after.paymentStatus, 'PAID');
    });

    await check('L1b PayOS status matrix keeps active progression PAID while routing CANCELLED/COD to REFUND_PENDING', async () => {
      for (const st of ['PREPARING', 'READY_FOR_DELIVERY', 'SHIPPING', 'DELIVERED', 'COMPLETED']) {
        const ord = await newOrder(st);
        const pay = await newPayment(ord.orderId);
        await paymentRepo.confirmPaymentAtomicTx(pay.paymentTransactionId, {
          providerTransactionRef: `${prefix}-l1b-${st}`,
          sourceEvidenceStatus: 'MISSING',
        });
        const after = await p.order.findUniqueOrThrow({ where: { orderId: ord.orderId } });
        assert.equal(after.orderStatus, st, `Order in ${st} must preserve fulfillment status`);
        assert.equal(after.paymentStatus, 'PAID', `Order in ${st} must become PAID`);
      }

      for (const failSt of ['CANCELLED', 'REJECTED', 'DELIVERY_FAILED']) {
        const badOrd = await newOrder(failSt);
        const badPay = await newPayment(badOrd.orderId);
        await paymentRepo.confirmPaymentAtomicTx(badPay.paymentTransactionId, {
          providerTransactionRef: `${prefix}-l1b-${failSt}`,
          sourceEvidenceStatus: 'MISSING',
        });
        const badAfter = await p.order.findUniqueOrThrow({ where: { orderId: badOrd.orderId } });
        assert.equal(badAfter.orderStatus, failSt);
        assert.equal(badAfter.paymentStatus, 'REFUND_PENDING', `Late PayOS on ${failSt} must route to REFUND_PENDING`);
      }

      const codOrd = await p.order.create({
        data: {
          orderCode: `${prefix}-cod-switched`,
          storeId: storeId!,
          orderStatus: 'CONFIRMED',
          paymentStatus: 'UNPAID',
          paymentMethod: 'COD',
          subtotalAmount: 100000,
          totalAmount: 100000,
          shippingRecipientName: 'Synthetic audit fixture',
          shippingPhone: '0000000000',
          shippingAddress: 'Audit fixture',
        },
      });
      const codPay = await newPayment(codOrd.orderId);
      await paymentRepo.confirmPaymentAtomicTx(codPay.paymentTransactionId, {
        providerTransactionRef: `${prefix}-l1b-cod`,
        sourceEvidenceStatus: 'MISSING',
      });
      const codAfter = await p.order.findUniqueOrThrow({ where: { orderId: codOrd.orderId } });
      assert.equal(codAfter.paymentStatus, 'REFUND_PENDING', 'PayOS receipt arriving on COD order must route to REFUND_PENDING');
    });

    await check('L2 late old-link payment preserves PAID state and settles verified excess payout strictly as SUPER_ADMIN', async () => {
      const custUser = await p.user.create({
        data: {
          username: `${prefix}_cust`,
          email: `${prefix}_cust@example.invalid`,
          passwordHash: 'audit-fixture-not-a-login-hash',
          fullName: 'L2 Customer',
          status: 'ACTIVE',
        },
      });
      const custProfile = await p.customerProfile.create({ data: { userId: custUser.userId } });
      const rawAcc = `190333${String(Date.now()).slice(-6)}`;
      const bankBin = '970422';
      const verifiedBank = await p.customerBankAccount.create({
        data: {
          customerId: custProfile.customerId,
          bankCode: 'MB',
          bankName: 'MBBank',
          bankBin,
          accountNumberEncrypted: CryptoVaultUtil.encryptAccountNumber(rawAcc),
          accountNumberMasked: CryptoVaultUtil.maskAccountNumber(rawAcc),
          accountNumberHash: CryptoVaultUtil.computeDeterministicAccountHash(rawAcc),
          accountName: 'L2 CUSTOMER',
          verificationStatus: 'VERIFIED',
          isDefault: true,
        },
      });

      const order = await p.order.create({
        data: {
          orderCode: `${prefix}-L2-PAID`,
          storeId: storeId!,
          customerId: custProfile.customerId,
          orderStatus: 'CONFIRMED',
          paymentStatus: 'PAID',
          paymentMethod: 'PAYOS',
          subtotalAmount: 100000,
          totalAmount: 100000,
          shippingRecipientName: 'L2 Customer',
          shippingPhone: '0900000001',
          shippingAddress: 'Audit fixture',
        },
      });
      const validPaid = await newPayment(order.orderId, 'PAID');
      const oldPayment = await newPayment(order.orderId, 'CANCELLED');
      await paymentRepo.confirmPaymentAtomicTx(oldPayment.paymentTransactionId, {
        providerTransactionRef: `${prefix}-l2-excess-ref`,
        sourceBankBin: bankBin,
        sourceAccountHash: CryptoVaultUtil.computeDeterministicAccountHash(rawAcc),
        sourceAccountEncrypted: CryptoVaultUtil.encryptAccountNumber(rawAcc),
        sourceAccountMasked: CryptoVaultUtil.maskAccountNumber(rawAcc),
        sourceAccountName: 'L2 CUSTOMER',
        sourceEvidenceStatus: 'SUFFICIENT',
      });
      const after = await p.order.findUniqueOrThrow({ where: { orderId: order.orderId } });
      assert.equal(after.paymentStatus, 'PAID');

      // Settling only the excess receipt must not touch the valid PAID transaction or order PAID status,
      // while full-order refundOrderAtomicTx must reject blanket-refunding a PAID order.
      await assert.rejects(
        () => orderRepo.refundOrderAtomicTx(order.orderId, 'Should reject blanket refund on PAID order'),
        BadRequestException,
      );

      const mockPayoutSvc = {
        createPayout: async (req: any) => ({
          code: '00',
          data: {
            id: `po_l2_${prefix}`,
            referenceId: req.referenceId,
            amount: req.amount,
            approvalState: 'SUCCEEDED',
            transactions: [
              {
                id: `potx_l2_${prefix}`,
                referenceId: req.referenceId,
                amount: req.amount,
                toBin: bankBin,
                toAccountNumber: rawAcc,
                state: 'SUCCEEDED',
              },
            ],
          },
        }),
        getPayout: async (id: string) => ({ code: '00', data: { id } }),
        getPayouts: async () => ({ code: '00', data: [] }),
      } as any;
      const refundsRepo = new PaymentRefundsRepository(p);
      const refundsService = new PaymentRefundsService(refundsRepo, mockPayoutSvc);
      const service = new PaymentsService(paymentRepo, undefined, undefined, undefined, undefined, undefined, refundsService);

      for (const role of ['STORE_OWNER', 'ADMIN', 'SYSTEM_ADMIN']) {
        await assert.rejects(
          () =>
            service.refundExcessTransaction(
              oldPayment.paymentTransactionId.toString(),
              {},
              { userId: ownerId, storeId, role },
            ),
          ForbiddenException,
          `Role ${role} must be forbidden from dispatching PayOS excess refund`,
        );
      }

      await service.refundExcessTransaction(
        oldPayment.paymentTransactionId.toString(),
        { customerBankAccountId: verifiedBank.id.toString() },
        { userId: ownerId, role: 'SUPER_ADMIN' },
      );
      const orderStillPaid = await p.order.findUniqueOrThrow({ where: { orderId: order.orderId } });
      const validTxStillPaid = await p.paymentTransaction.findUniqueOrThrow({ where: { paymentTransactionId: validPaid.paymentTransactionId } });
      const excessTxRefunded = await p.paymentTransaction.findUniqueOrThrow({ where: { paymentTransactionId: oldPayment.paymentTransactionId } });
      assert.equal(orderStillPaid.paymentStatus, 'PAID');
      assert.equal(validTxStillPaid.status, 'PAID');
      assert.equal(excessTxRefunded.status, 'REFUNDED');
    });

    await check('L3 stale failure callback cannot overwrite a concurrently confirmed PAID transaction', async () => {
      const order = await newOrder('PENDING');
      const payment = await newPayment(order.orderId);
      const service = new PaymentsService(paymentRepo);
      process.env.PAYOS_CHECKSUM_KEY = 'acid-audit-local-signature-fixture';
      const key = process.env.PAYOS_CHECKSUM_KEY;
      const base = { orderCode: Number(payment.transactionCode), amount: 100000, currency: 'VND',
        paymentLinkId: payment.paymentLinkId!, reference: `${prefix}-receipt`, transactionDateTime: new Date().toISOString() };
      const data: any = { ...base, code: '00' };
      const failData: any = { ...base, code: '00' };
      const original = paymentRepo.findTransactionByCode.bind(paymentRepo);
      let release!: () => void;
      let notifyRead!: () => void;
      const hold = new Promise<void>(resolve => { release = resolve; });
      const read = new Promise<void>(resolve => { notifyRead = resolve; });
      let calls = 0;
      paymentRepo.findTransactionByCode = async code => {
        const snapshot = await original(code);
        if (++calls === 1) { notifyRead(); await hold; }
        return snapshot;
      };
      const failure = service.handlePayosWebhook({ success: true, code: '99', data: failData,
        signature: signWebhookData(failData, key) } as any);
      try {
        await read;
        await service.handlePayosWebhook({ success: true, code: '00', data,
          signature: signWebhookData(data, key) } as any);
      } finally { release(); }
      await failure;
      paymentRepo.findTransactionByCode = original;
      const after = await p.paymentTransaction.findUniqueOrThrow({ where: { paymentTransactionId: payment.paymentTransactionId } });
      assert.equal(after.status, 'PAID');

      // Also verify signed non-00 failure webhook cannot downgrade an already PAID transaction
      const signedFailureData: any = { ...base, code: '01' };
      await service.handlePayosWebhook({
        success: true,
        code: '00',
        data: signedFailureData,
        signature: signWebhookData(signedFailureData, key),
      } as any);
      const afterSignedFailure = await p.paymentTransaction.findUniqueOrThrow({ where: { paymentTransactionId: payment.paymentTransactionId } });
      assert.equal(afterSignedFailure.status, 'PAID');

      // Standalone C1: markTransactionFailedIfPendingAtomicTx transitions PENDING -> FAILED cleanly when no PAID exists,
      // and never overwrites PAID under barrier race
      const failOrd = await newOrder('PENDING');
      const failPay = await newPayment(failOrd.orderId);
      const markedFailed = await paymentRepo.markTransactionFailedIfPendingAtomicTx(failPay.paymentTransactionId);
      assert.equal(markedFailed?.status, 'FAILED', 'PENDING transaction must transition to FAILED cleanly');

      const raceOrd = await newOrder('PENDING');
      const racePay = await newPayment(raceOrd.orderId);
      let releaseFailBarrier!: () => void;
      let notifyFailEntered!: () => void;
      const holdFail = new Promise<void>(resolve => { releaseFailBarrier = resolve; });
      const failEntered = new Promise<void>(resolve => { notifyFailEntered = resolve; });
      let failProbeCalls = 0;
      paymentRepo.findTransactionByCode = async code => {
        const snap = await original(code);
        if (++failProbeCalls === 1) { notifyFailEntered(); await holdFail; }
        return snap;
      };
      const raceBase = { orderCode: Number(racePay.transactionCode), amount: 100000, currency: 'VND',
        paymentLinkId: racePay.paymentLinkId!, reference: `${prefix}-c1-race`, transactionDateTime: new Date().toISOString() };
      const raceFailData: any = { ...raceBase, code: '01' };
      const raceOkData: any = { ...raceBase, code: '00' };
      const raceFailPromise = service.handlePayosWebhook({
        success: true, code: '00', data: raceFailData, signature: signWebhookData(raceFailData, key),
      } as any);
      try {
        await failEntered;
        await service.handlePayosWebhook({
          success: true, code: '00', data: raceOkData, signature: signWebhookData(raceOkData, key),
        } as any);
      } finally { releaseFailBarrier(); }
      await raceFailPromise;
      paymentRepo.findTransactionByCode = original;
      const racePayAfter = await p.paymentTransaction.findUniqueOrThrow({ where: { paymentTransactionId: racePay.paymentTransactionId } });
      assert.equal(racePayAfter.status, 'PAID', 'C1 barrier race: delayed failure webhook must NEVER overwrite committed PAID');
    });

    await check('L4 storefront retry after commit/crash window returns the existing order', async () => {
      const product = await newProduct();
      const payload = { storeId: storeId!, items: [{ productId: String(product.productId), quantity: 1 }],
        customerName: 'Audit', customerPhone: '0000000000', deliveryAddress: 'Audit', paymentMethod: 'COD' };
      const idempotency = new IdempotencyService(new IdempotencyRepository(p));
      const acquisition = { actorScope: prefix, idempotencyKey: `${prefix}-checkout`, method: 'POST',
        actualPath: '/api/v1/storefront/orders', route: '/storefront/orders', body: payload };
      const first = await idempotency.acquire(acquisition);
      assert.equal(first.state, 'ACQUIRED');
      const firstOrder = await orderRepo.createStorefrontOrderTx({
        ...payload,
        idempotency: {
          actorScope: acquisition.actorScope,
          idempotencyKey: acquisition.idempotencyKey,
        },
      });
      // Simulate process death after business COMMIT but before interceptor finalizeSuccess.
      await p.apiIdempotencyKey.update({ where: { id: (first as any).recordId },
        data: { lockedUntil: new Date(Date.now() - 1000) } });
      const second = await idempotency.acquire(acquisition);
      let secondOrderId = firstOrder.orderId;
      if (second.state === 'ACQUIRED') {
        const recovered = await orderRepo.createStorefrontOrderTx({
          ...payload,
          idempotency: {
            actorScope: acquisition.actorScope,
            idempotencyKey: acquisition.idempotencyKey,
          },
        });
        secondOrderId = recovered.orderId;
        await idempotency.finalizeSuccess(second.recordId, 201, { orderId: String(secondOrderId) }, second.lockToken);
      }
      assert.equal(secondOrderId, firstOrder.orderId, 'Retry must return existing order without creating duplicate');
      assert.equal(await p.inventory.findUniqueOrThrow({ where: { productId: product.productId } }).then(i => i.reservedQuantity), 1);

      // Reusing same key with different payload must fail closed (422)
      await assert.rejects(
        () => orderRepo.createStorefrontOrderTx({
          ...payload,
          items: [{ productId: String(product.productId), quantity: 2 }],
          idempotency: {
            actorScope: acquisition.actorScope,
            idempotencyKey: acquisition.idempotencyKey,
          },
        }),
        UnprocessableEntityException,
      );

      // HTTP Interceptor post-commit crash recovery: finalizeSuccess failure must not delete idempotency row,
      // and retry through StorefrontController returns existing order ID cleanly.
      const idempRepo = new IdempotencyRepository(p);
      const idempSvc = new IdempotencyService(idempRepo);
      const reflector = { getAllAndOverride: () => ({ required: true, ttlSeconds: 86400 }) } as any;
      const interceptor = new IdempotencyInterceptor(idempSvc, reflector);
      const ordersSvc = new OrdersService(orderRepo, undefined, { emitToStore: () => {}, emitToCustomer: () => {} } as any);
      const ctrl = new StorefrontController(ordersSvc);
      const httpKey = `${prefix}-http-checkout`;
      const origFinalize = idempSvc.finalizeSuccess.bind(idempSvc);
      idempSvc.finalizeSuccess = async () => { throw new Error('Simulated finalize crash after commit'); };
      const mkCtx = () => {
        const req: any = {
          method: 'POST',
          originalUrl: '/api/v1/storefront/orders',
          route: { path: '/storefront/orders' },
          ip: '127.0.0.1',
          headers: { 'x-idempotency-key': httpKey },
          query: {},
          body: { ...payload, storeId: String(storeId!) },
        };
        const res: any = { statusCode: 201, setHeader: () => {}, status: (c: number) => { res.statusCode = c; } };
        return { req, res, ctx: { switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }), getHandler: () => ({}), getClass: () => ({}) } as any };
      };
      const c1 = mkCtx();
      const obs1 = await interceptor.intercept(c1.ctx, { handle: () => new (require('rxjs').Observable)((sub: any) => { ctrl.checkout(c1.req, c1.req.body).then(v => { sub.next(v); sub.complete(); }, e => sub.error(e)); }) });
      await assert.rejects(() => lastValueFrom(obs1), /Simulated finalize crash/);
      const persistedRow = await p.apiIdempotencyKey.findFirst({ where: { idempotencyKey: httpKey } });
      assert.ok(persistedRow && persistedRow.status === 'PROCESSING', 'Post-commit finalize error must NOT delete idempotency row');

      // Expire lease to simulate retry recovery & restore finalizeSuccess
      await p.apiIdempotencyKey.update({ where: { id: persistedRow!.id }, data: { lockedUntil: new Date(Date.now() - 1000) } });
      idempSvc.finalizeSuccess = origFinalize;
      const c2 = mkCtx();
      const obs2 = await interceptor.intercept(c2.ctx, { handle: () => new (require('rxjs').Observable)((sub: any) => { ctrl.checkout(c2.req, c2.req.body).then(v => { sub.next(v); sub.complete(); }, e => sub.error(e)); }) });
      const res2 = await lastValueFrom(obs2);
      const matchingOrders = await p.order.findMany({ where: { storeId: storeId!, checkoutIdempotencyKey: httpKey } });
      assert.equal(matchingOrders.length, 1);
      assert.equal(res2.data.orderId, matchingOrders[0].orderId.toString());
    });

    await check('L5 PATCH inventory race waits on row lock and returns a business conflict instead of a database CHECK error', async () => {
      const product = await newProduct();
      let releaseCheckout!: () => void;
      let notifyLocked!: () => void;
      const holdCheckout = new Promise<void>(resolve => { releaseCheckout = resolve; });
      const locked = new Promise<void>(resolve => { notifyLocked = resolve; });

      const products = new ProductsRepository(p);

      // Hold real PostgreSQL row lock on product -> inventory, reserve 3 units, pause before COMMIT
      const checkoutTx = p.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT product_id FROM product WHERE product_id = ${product.productId} FOR UPDATE`;
        await tx.$queryRaw`SELECT product_id FROM inventory WHERE product_id = ${product.productId} FOR UPDATE`;
        await tx.inventory.update({
          where: { productId: product.productId },
          data: { reservedQuantity: { increment: 3 } },
        });
        notifyLocked();
        await holdCheckout;
      });

      await locked;
      const patchPromise = products.updateInventoryStock(product.productId, storeId!, 2)
        .then(value => ({ value, error: undefined as any }), error => ({ value: undefined, error }));
      // Give PATCH transaction a moment to enter lock wait behind checkoutTx
      await new Promise(r => setTimeout(r, 150));
      releaseCheckout();
      await checkoutTx;

      const result = await patchPromise;
      assert.ok(result.error instanceof BadRequestException,
        `Expected a business BadRequestException; observed ${result.error?.constructor?.name} code=${result.error?.code} msg=${result.error?.message}`);
      const invAfter = await p.inventory.findUniqueOrThrow({ where: { productId: product.productId } });
      assert.equal(invAfter.quantityOnHand, 5);
      assert.equal(invAfter.reservedQuantity, 3);
    });
  } finally {
    if (oldChecksum === undefined) delete process.env.PAYOS_CHECKSUM_KEY;
    else process.env.PAYOS_CHECKSUM_KEY = oldChecksum;
    // Delete only this run's fixture records, preserving all pre-existing users/stores/orders.
    try {
      if (storeId !== undefined) {
        const orders = await p.order.findMany({ where: { storeId }, select: { orderId: true } });
        const orderIds = orders.map(order => order.orderId);
        if (orderIds.length > 0) {
          const obls = await p.paymentRefundObligation.findMany({
            where: { orderId: { in: orderIds } },
            select: { obligationId: true },
          });
          const oblIds = obls.map(o => o.obligationId);
          if (oblIds.length > 0) {
            await p.paymentRefundVerifiedVoucher.deleteMany({ where: { obligationId: { in: oblIds } } });
            await p.paymentRefundObligation.updateMany({
              where: { obligationId: { in: oblIds } },
              data: { activePayoutAttemptId: null, settledAttemptId: null },
            });
            await p.paymentRefundPayoutAttempt.deleteMany({ where: { obligationId: { in: oblIds } } });
            await p.paymentRefundObligation.deleteMany({ where: { obligationId: { in: oblIds } } });
          }
          await p.paymentOrderReceipt.deleteMany({ where: { orderId: { in: orderIds } } });
        }
        for (const oid of orderIds) {
          await p.$executeRawUnsafe(
            `DELETE FROM outbox_events WHERE event_type = 'PAYMENT_REFUND_PAYOUT' AND payload->>'orderId' = $1`,
            oid.toString(),
          ).catch(() => {});
        }
        await p.orderStatusHistory.deleteMany({ where: { orderId: { in: orderIds } } });
        await p.paymentTransaction.deleteMany({ where: { orderId: { in: orderIds } } });
        await p.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
        await p.order.deleteMany({ where: { storeId } });
        await p.inventory.deleteMany({ where: { storeId } });
        await p.product.deleteMany({ where: { storeId } });
        await p.store.delete({ where: { storeId } });
      }
      const fixtureCustUsers = await p.user.findMany({
        where: { username: { startsWith: `${prefix}_` } },
        select: { userId: true },
      });
      if (fixtureCustUsers.length > 0) {
        const uids = fixtureCustUsers.map(u => u.userId);
        const cps = await p.customerProfile.findMany({
          where: { userId: { in: uids } },
          select: { customerId: true },
        });
        const cids = cps.map(c => c.customerId);
        if (cids.length > 0) {
          await p.customerBankAccount.deleteMany({ where: { customerId: { in: cids } } });
          await p.customerProfile.deleteMany({ where: { customerId: { in: cids } } });
        }
        await p.user.deleteMany({ where: { userId: { in: uids } } });
      }
      await p.apiIdempotencyKey.deleteMany({
        where: { OR: [{ actorScope: prefix }, { idempotencyKey: { startsWith: prefix } }] },
      });
      if (ownerId !== undefined) await p.user.delete({ where: { userId: ownerId } });
    } finally { await p.$disconnect(); }
  }
}

async function main() {
  await runMockChecks();
  if (process.argv.includes('--live')) await runLiveChecks();
  console.log(`AUDIT_REGRESSIONS passed=${outcomes.filter(result => result.passed).length} failed=${outcomes.filter(result => !result.passed).length}`);
  if (outcomes.some(result => !result.passed)) process.exitCode = 1;
}
main().catch((error: any) => {
  console.error('AUDIT_RUN_ERROR', error?.code || error?.name, String(error?.message || '').replace(/postgres(?:ql)?:\/\/\S+/g, '[redacted]'));
  process.exitCode = 1;
});
