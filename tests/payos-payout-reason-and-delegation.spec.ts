import 'dotenv/config';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { BadRequestException } from '@nestjs/common';
import { getSafeTestPrismaService } from './test-db-guard';
import { CryptoVaultUtil } from '../src/common/utils/crypto-vault.util';
import { signWebhookData } from '../src/payments/payos.helper';
import {
  verifyPayosPayoutEvidence,
  verifyPayosPayoutRejectionEvidence,
} from '../src/payments/payos-payout-verifier';
import { PayOSPayoutService } from '../src/payments/payos-payout.service';
import { PaymentRefundsRepository } from '../src/payments/payment-refunds.repository';
import { PaymentRefundsService } from '../src/payments/payment-refunds.service';
import { PaymentRefundWorkerService } from '../src/payments/payment-refund-worker.service';
import { PaymentsRepository } from '../src/payments/payments.repository';
import { PaymentsService } from '../src/payments/payments.service';
import { OrdersRepository } from '../src/orders/orders.repository';

function assertNoTestLeak(cond: any, message: string) {
  assert.ok(cond, message);
}

function loadCloudflareWorkerWithMockFetch(
  fetchImpl: (url: string, init?: any) => Promise<{
    status: number;
    headers?: Record<string, string>;
    body?: string;
  }>,
) {
  const workerPath = path.resolve(process.cwd(), 'cloudflare-worker/worker.js');
  const rawSource = fs.readFileSync(workerPath, 'utf8');
  const rewritten = rawSource.replace(/export\s+default\s*\{/, 'globalThis.__exportedWorker = {');
  assert.ok(rewritten.includes('globalThis.__exportedWorker'), 'Must rewrite export default in worker.js');

  const sandbox: any = {
    URL,
    Request,
    Response,
    Headers,
    AbortSignal,
    AbortController,
    console,
    caches: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
    fetch: async (input: any, init?: any) => {
      const targetUrl = typeof input === 'string' ? input : input.url;
      const res = await fetchImpl(targetUrl, init);
      return new Response(res.body ?? JSON.stringify({ ok: true }), {
        status: res.status,
        headers: res.headers || { 'content-type': 'application/json' },
      });
    },
  };

  vm.runInNewContext(rewritten, sandbox, { filename: 'cloudflare-worker/worker.js' });
  return sandbox.__exportedWorker as {
    fetch: (req: Request, env: Record<string, string>, ctx: { waitUntil: (p: Promise<any>) => void }) => Promise<Response>;
  };
}

async function runSuite() {
  const prisma = getSafeTestPrismaService('PayOS Payout Reason & Static-IP Delegation');
  const prefix = `PAYOUT_DELEG_${Date.now()}`;
  const prevChecksum = process.env.PAYOS_CHECKSUM_KEY;
  const prevPayoutChecksum = process.env.PAYOS_PAYOUT_CHECKSUM_KEY;
  const prevDelegate = process.env.PAYOS_PAYOUT_DELEGATE_TO_WORKER;
  const prevWorkerEnabled = process.env.PAYOS_PAYOUT_WORKER_ENABLED;
  const prevNodeEnv = process.env.NODE_ENV;

  process.env.PAYOS_CHECKSUM_KEY = process.env.PAYOS_CHECKSUM_KEY || 'test_payos_checksum_key_for_refunds_spec_only';
  process.env.PAYOS_PAYOUT_CHECKSUM_KEY =
    process.env.PAYOS_PAYOUT_CHECKSUM_KEY || 'test_payout_checksum_key_for_refunds_spec_only';
  process.env.NODE_ENV = 'test';

  let ownerUserId: bigint | undefined;
  let custUserId: bigint | undefined;
  let superAdminUserId: bigint | undefined;
  let storeId: bigint | undefined;
  let custProfileId: bigint | undefined;
  const createdOrderIds: bigint[] = [];
  let seq = 0;

  const createdPayouts = new Map<string, any>();
  const createdPayoutsByRef = new Map<string, any>();
  let createPayoutCallCount = 0;
  let getPayoutCallCount = 0;
  let nextCreateBehavior: (req: any) => Promise<any> = async () => {
    throw new Error('nextCreateBehavior not configured');
  };

  const mockPayosPayoutService = {
    createPayout: async (req: any) => {
      createPayoutCallCount++;
      return nextCreateBehavior(req);
    },
    getPayout: async (id: string) => {
      getPayoutCallCount++;
      const found = createdPayouts.get(id);
      if (!found) return { code: '01', desc: 'Not found', data: null };
      return { code: '00', data: found };
    },
    getPayouts: async (params?: { referenceId?: string }) => {
      if (params?.referenceId) {
        const hit = createdPayoutsByRef.get(params.referenceId);
        return { code: '00', data: hit ? [hit] : [] };
      }
      return { code: '00', data: Array.from(createdPayouts.values()) };
    },
  } as any;

  const refundsRepo = new PaymentRefundsRepository(prisma);
  const refundsService = new PaymentRefundsService(refundsRepo, mockPayosPayoutService);
  const refundWorker = new PaymentRefundWorkerService(prisma, refundsRepo, refundsService);
  const paymentsRepo = new PaymentsRepository(prisma, refundsRepo);
  const paymentsService = new PaymentsService(
    paymentsRepo,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    refundsService,
  );
  const ordersRepo = new OrdersRepository(prisma, refundsRepo);

  const outcomes: Array<{ name: string; passed: boolean; error?: string }> = [];
  async function testCase(name: string, fn: () => Promise<void> | void) {
    try {
      await fn();
      outcomes.push({ name, passed: true });
      console.log(`PASS: ${name}`);
    } catch (err: any) {
      outcomes.push({ name, passed: false, error: err?.stack || err?.message || String(err) });
      console.error(`FAIL: ${name} -> ${err?.stack || err?.message || err}`);
    }
  }

  try {
    // -------------------------------------------------------------------------
    // T1: Pure verifier guarantees (success path never leaks reason; rejection extracts errorCode: errorMessage)
    // -------------------------------------------------------------------------
    await testCase('T1: Verifier keeps success clean and extracts PayOS errorCode: errorMessage on FAILED', () => {
      const accNum = '000012347488';
      const accHash = CryptoVaultUtil.computeDeterministicAccountHash(accNum);
      const criteria = {
        amount: 2000,
        payoutReference: 'REF_VERIFIER_1',
        targetBankBin: '970423',
        targetAccountHash: accHash,
        expectedPayoutId: 'batch_ok_1',
      };

      const okRes = verifyPayosPayoutEvidence(
        {
          id: 'batch_ok_1',
          approvalState: 'COMPLETED',
          transactions: [
            {
              id: 'txn_ok_1',
              referenceId: 'REF_VERIFIER_1',
              amount: 2000,
              toBin: '970423',
              toAccountNumber: accNum,
              state: 'SUCCEEDED',
            },
          ],
        },
        criteria,
      );
      assertNoTestLeak(okRes.isVerified === true, 'SUCCEEDED payout must verify');
      assert.equal(okRes.matchedTxId, 'txn_ok_1');
      assert.equal('reason' in okRes, false, 'Succeeded verifyPayosPayoutEvidence must not attach a failure reason');

      const rejFailed = verifyPayosPayoutRejectionEvidence(
        {
          id: 'batch_2f96d7b8',
          approvalState: 'FAILED',
          transactions: [
            {
              id: 'txn_fail_1',
              referenceId: 'REF_VERIFIER_1',
              amount: 2000,
              toBin: '970423',
              toAccountNumber: accNum,
              state: 'FAILED',
              errorCode: 'PAYOUT_FAILED',
              errorMessage: 'Chi tiền thất bại',
            },
          ],
        },
        { ...criteria, expectedPayoutId: 'batch_2f96d7b8' },
      );
      assert.equal(rejFailed.isVerified, true);
      assert.equal(rejFailed.reason, 'PAYOUT_FAILED: Chi tiền thất bại');

      const rejInsuff = verifyPayosPayoutRejectionEvidence(
        {
          id: 'batch_0ae2cfec',
          approvalState: 'FAILED',
          transactions: [
            {
              id: 'txn_fail_2',
              referenceId: 'REF_VERIFIER_1',
              amount: 2000,
              toBin: '970423',
              toAccountNumber: accNum,
              state: 'FAILED',
              errorCode: 'PAYOUT_INSUFFICIENT_FUNDS',
              errorMessage: 'Số dư tài khoản không đủ để thực hiện giao dịch',
            },
          ],
        },
        { ...criteria, expectedPayoutId: 'batch_0ae2cfec' },
      );
      assert.equal(rejInsuff.isVerified, true);
      assert.equal(
        rejInsuff.reason,
        'PAYOUT_INSUFFICIENT_FUNDS: Số dư tài khoản không đủ để thực hiện giao dịch',
      );
    });

    // -------------------------------------------------------------------------
    // T2: PayOSPayoutService.onModuleInit skips startup probe on delegated Render nodes
    // -------------------------------------------------------------------------
    await testCase('T2: PayOSPayoutService.onModuleInit skips health probe when PAYOS_PAYOUT_DELEGATE_TO_WORKER=true', async () => {
      process.env.PAYOS_PAYOUT_DELEGATE_TO_WORKER = 'true';
      delete process.env.PAYOS_PAYOUT_WORKER_ENABLED;
      const svc = new PayOSPayoutService();
      let healthCheckCalled = false;
      (svc as any).checkPayoutAccountHealth = async () => {
        healthCheckCalled = true;
      };
      await svc.onModuleInit();
      assert.equal(healthCheckCalled, false, 'Delegated Render node must skip PayOS IP-locked balance probe at boot');
    });

    // -------------------------------------------------------------------------
    // T3: Cloudflare Worker routes payout paths primary to Node-3 & fails over on Render hibernate 429
    // -------------------------------------------------------------------------
    await testCase('T3: cloudflare-worker/worker.js prioritizes node-3 for payout routes & fails over on hibernate 429', async () => {
      const seenTargets: string[] = [];
      const worker = loadCloudflareWorkerWithMockFetch(async (targetUrl) => {
        if (!targetUrl.endsWith('/healthz')) {
          seenTargets.push(targetUrl);
        }
        if (targetUrl.startsWith('https://node1.example')) {
          return {
            status: 429,
            headers: {
              'content-type': 'text/plain',
              'x-render-routing': 'hibernate-rate-limited',
            },
            body: 'rate limited',
          };
        }
        return {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ routedTo: targetUrl }),
        };
      });

      const env = { NODE3_AWS: 'https://node3.example' };
      const ctx = { waitUntil: () => {} };

      seenTargets.length = 0;
      const payoutRes = await worker.fetch(
        new Request('https://api.example/api/v1/admin/payment-refunds/3/payout', { method: 'POST' }),
        env,
        ctx,
      );
      assert.equal(payoutRes.status, 200);
      assert.equal(
        seenTargets[0],
        'https://node3.example/api/v1/admin/payment-refunds/3/payout',
        'Admin payout route must hit AWS static-IP Node-3 first',
      );
      assert.equal(payoutRes.headers.get('X-Cluster-Node'), 'node-3');

      seenTargets.length = 0;
      const wdRes = await worker.fetch(
        new Request('https://api.example/api/v1/admin/withdrawals/1/payout', { method: 'POST' }),
        env,
        ctx,
      );
      assert.equal(wdRes.status, 200);
      assert.equal(
        seenTargets[0],
        'https://node3.example/api/v1/admin/withdrawals/1/payout',
        'Withdrawal payout route must hit AWS static-IP Node-3 first',
      );

      // Simulate Node-1 returning Render hibernate 429 on /payments -> must fail over instead of returning 429
      const hibernateTargets: string[] = [];
      const workerHibernate = loadCloudflareWorkerWithMockFetch(async (targetUrl) => {
        if (!targetUrl.endsWith('/healthz')) {
          hibernateTargets.push(targetUrl);
        }
        if (targetUrl.includes('onrender.com')) {
          return {
            status: 429,
            headers: { 'x-render-routing': 'hibernate-rate-limited' },
            body: 'Render hibernated',
          };
        }
        return { status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' };
      });
      const thirdPartyRes = await workerHibernate.fetch(
        new Request('https://api.example/api/v1/payments/status/1', { method: 'GET' }),
        env,
        ctx,
      );
      assert.equal(thirdPartyRes.status, 200);
      assert.ok(hibernateTargets[0]?.includes('onrender.com'), 'Payments starts on Node-1 Render');
      assert.equal(
        hibernateTargets[1],
        'https://node3.example/api/v1/payments/status/1',
        'Must fail over from Render hibernate 429 to Node-3',
      );
      assert.equal(thirdPartyRes.headers.get('X-Cluster-Node'), 'node-3');

      // Normal API 429 JSON must NOT fail over (never mask real rate limiter responses)
      const api429Targets: string[] = [];
      const workerApi429 = loadCloudflareWorkerWithMockFetch(async (targetUrl) => {
        if (!targetUrl.endsWith('/healthz')) {
          api429Targets.push(targetUrl);
        }
        return {
          status: 429,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ success: false, message: 'Too many requests' }),
        };
      });
      const real429Res = await workerApi429.fetch(
        new Request('https://api.example/api/v1/auth/login', { method: 'POST' }),
        env,
        ctx,
      );
      assert.equal(real429Res.status, 429);
      assert.equal(api429Targets.length, 1, 'Genuine JSON 429 must return directly without failover');
    });

    // -------------------------------------------------------------------------
    // DB Fixture setup for T4 & T5 against PostgreSQL
    // -------------------------------------------------------------------------
    await prisma.$connect();

    const owner = await prisma.user.create({
      data: {
        username: `${prefix}_owner`,
        email: `${prefix}_owner@example.invalid`,
        passwordHash: 'test-placeholder-not-a-login-hash-padding-to-at-least-60-characters',
        fullName: 'Store Owner Deleg Fixture',
        status: 'ACTIVE',
      },
    });
    ownerUserId = owner.userId;

    const superAdmin = await prisma.user.create({
      data: {
        username: `${prefix}_sa`,
        email: `${prefix}_sa@example.invalid`,
        passwordHash: 'test-placeholder-not-a-login-hash-padding-to-at-least-60-characters',
        fullName: 'Super Admin Deleg Fixture',
        status: 'ACTIVE',
      },
    });
    superAdminUserId = superAdmin.userId;

    const store = await prisma.store.create({
      data: {
        code: prefix,
        name: `Store ${prefix}`,
        ownerUserId,
        phone: '0900000000',
        address: 'Fixture Street',
        status: 'ACTIVE',
      },
    });
    storeId = store.storeId;

    const custUser = await prisma.user.create({
      data: {
        username: `${prefix}_cust`,
        email: `${prefix}_cust@example.invalid`,
        passwordHash: 'test-placeholder-not-a-login-hash-padding-to-at-least-60-characters',
        fullName: 'Customer Deleg Fixture',
        status: 'ACTIVE',
      },
    });
    custUserId = custUser.userId;
    const custProfile = await prisma.customerProfile.create({ data: { userId: custUserId } });
    custProfileId = custProfile.customerId;

    const bankAccRaw = `990423${String(Date.now()).slice(-6)}`;
    await prisma.customerBankAccount.create({
      data: {
        customerId: custProfileId,
        bankCode: 'TPB',
        bankName: 'TPBank',
        bankBin: '970423',
        accountNumberEncrypted: CryptoVaultUtil.encryptAccountNumber(bankAccRaw),
        accountNumberMasked: CryptoVaultUtil.maskAccountNumber(bankAccRaw),
        accountNumberHash: CryptoVaultUtil.computeDeterministicAccountHash(bankAccRaw),
        accountName: 'LE HO GIA BAO',
        verificationStatus: 'VERIFIED',
        isDefault: true,
      },
    });

    const createReadyObligation = async (amount = 2000) => {
      const ord = await prisma.order.create({
        data: {
          orderCode: `${prefix}-O-${++seq}`,
          storeId: storeId!,
          customerId: custProfileId!,
          orderStatus: 'PENDING',
          paymentStatus: 'UNPAID',
          paymentMethod: 'PAYOS',
          subtotalAmount: amount,
          totalAmount: amount,
          shippingRecipientName: 'Customer Deleg Fixture',
          shippingPhone: '0911111111',
          shippingAddress: 'Fixture Street',
        },
      });
      createdOrderIds.push(ord.orderId);

      const codeNum = BigInt(`${Date.now().toString().slice(-8)}${String(++seq).padStart(4, '0')}`);
      const pt = await prisma.paymentTransaction.create({
        data: {
          orderId: ord.orderId,
          provider: 'PAYOS',
          transactionCode: codeNum.toString(),
          amount,
          paymentMethod: 'QR',
          status: 'PENDING',
          paymentLinkId: `${prefix}-link-${seq}`,
        },
      });

      const webhookData: any = {
        orderCode: Number(pt.transactionCode),
        amount,
        description: `Thanh toan ${pt.transactionCode}`,
        accountNumber: '0123456789',
        reference: `FT_${prefix}_${++seq}`,
        transactionDateTime: '2026-11-25 10:00:00',
        currency: 'VND',
        paymentLinkId: pt.paymentLinkId,
        code: '00',
        desc: 'success',
        counterAccountBankId: '970423',
        counterAccountNumber: bankAccRaw,
        counterAccountName: 'LE HO GIA BAO',
      };
      const signature = signWebhookData(webhookData, process.env.PAYOS_CHECKSUM_KEY!);
      await paymentsService.handlePayosWebhook({
        code: '00',
        desc: 'success',
        success: true,
        data: webhookData,
        signature,
      } as any);
      await ordersRepo.cancelOrderAtomicTx(ord.orderId, 'Regression test cancel');
      const [obl] = await refundsRepo.findObligationsForOrder(ord.orderId);
      assert.equal(obl.status, 'READY_FOR_PAYOUT');
      return obl;
    };

    const saCtx = { userId: superAdminUserId.toString(), role: 'SUPER_ADMIN' };

    // -------------------------------------------------------------------------
    // T4: PaymentRefundsService persists exact PayOS rejection reason (direct & webhook)
    // -------------------------------------------------------------------------
    await testCase('T4: PaymentRefundsService persists PayOS errorCode: errorMessage instead of generic fallback', async () => {
      process.env.PAYOS_PAYOUT_DELEGATE_TO_WORKER = 'false';
      const oblDirect = await createReadyObligation(2000);

      nextCreateBehavior = async (req) => {
        const rec = {
          id: `batch_insuff_${prefix}`,
          referenceId: req.referenceId,
          amount: req.amount,
          approvalState: 'FAILED',
          transactions: [
            {
              id: `txn_insuff_${prefix}`,
              referenceId: req.referenceId,
              amount: req.amount,
              toBin: req.toBin,
              toAccountNumber: req.toAccountNumber,
              state: 'FAILED',
              errorCode: 'PAYOUT_INSUFFICIENT_FUNDS',
              errorMessage: 'Số dư tài khoản không đủ để thực hiện giao dịch',
            },
          ],
        };
        createdPayouts.set(rec.id, rec);
        createdPayoutsByRef.set(req.referenceId, rec);
        return { code: '00', data: rec };
      };

      const directResDto = await refundsService.initiateObligationPayout(oblDirect.obligationId, {}, saCtx);
      assert.equal(directResDto.status, 'READY_FOR_PAYOUT');
      assert.equal(
        directResDto.failureReason,
        'PAYOUT_INSUFFICIENT_FUNDS: Số dư tài khoản không đủ để thực hiện giao dịch',
      );

      const dbOblAfterDirect = await prisma.paymentRefundObligation.findUniqueOrThrow({
        where: { obligationId: oblDirect.obligationId },
        include: { payoutAttempts: { orderBy: { attemptNumber: 'desc' } } },
      });
      assert.equal(dbOblAfterDirect.status, 'READY_FOR_PAYOUT');
      assert.equal(
        dbOblAfterDirect.failureReason,
        'PAYOUT_INSUFFICIENT_FUNDS: Số dư tài khoản không đủ để thực hiện giao dịch',
      );
      assert.equal(
        dbOblAfterDirect.payoutAttempts[0]?.failureReason,
        'PAYOUT_INSUFFICIENT_FUNDS: Số dư tài khoản không đủ để thực hiện giao dịch',
      );

      // Now test signed webhook reconciliation overriding generic desc ('Thất bại') with PayOS errorCode: errorMessage
      const oblWebhook = await createReadyObligation(2000);
      nextCreateBehavior = async (req) => {
        const rec = {
          id: `batch_wh_${prefix}`,
          referenceId: req.referenceId,
          amount: req.amount,
          approvalState: 'PROCESSING',
          transactions: [
            {
              id: `txn_wh_${prefix}`,
              referenceId: req.referenceId,
              amount: req.amount,
              toBin: req.toBin,
              toAccountNumber: req.toAccountNumber,
              state: 'PROCESSING',
            },
          ],
        };
        createdPayouts.set(rec.id, rec);
        createdPayoutsByRef.set(req.referenceId, rec);
        return { code: '00', data: rec };
      };
      await refundsService.initiateObligationPayout(oblWebhook.obligationId, {}, saCtx);
      const oblWhInitDb = await prisma.paymentRefundObligation.findUniqueOrThrow({
        where: { obligationId: oblWebhook.obligationId },
        include: { payoutAttempts: { orderBy: { attemptNumber: 'desc' } } },
      });
      const whRef = oblWhInitDb.payoutAttempts[0]!.payoutReference;

      // Provider updates payout detail to FAILED with PAYOUT_FAILED
      const updatedRec = {
        id: `batch_wh_${prefix}`,
        referenceId: whRef,
        amount: 2000,
        approvalState: 'FAILED',
        transactions: [
          {
            id: `txn_wh_${prefix}`,
            referenceId: whRef,
            amount: 2000,
            toBin: '970423',
            toAccountNumber: bankAccRaw,
            state: 'FAILED',
            errorCode: 'PAYOUT_FAILED',
            errorMessage: 'Chi tiền thất bại',
          },
        ],
      };
      createdPayouts.set(updatedRec.id, updatedRec);
      createdPayoutsByRef.set(whRef, updatedRec);

      await refundsService.processSignedPayoutWebhook(
        {
          id: updatedRec.id,
          referenceId: whRef,
          amount: 2000,
          approvalState: 'FAILED',
          transactions: updatedRec.transactions,
        },
        'Thất bại',
      );

      const dbOblAfterWh = await prisma.paymentRefundObligation.findUniqueOrThrow({
        where: { obligationId: oblWebhook.obligationId },
        include: { payoutAttempts: { orderBy: { attemptNumber: 'desc' } } },
      });
      assert.equal(dbOblAfterWh.status, 'READY_FOR_PAYOUT');
      assert.equal(dbOblAfterWh.failureReason, 'PAYOUT_FAILED: Chi tiền thất bại');
    });

    // -------------------------------------------------------------------------
    // T5: Delegated worker flow (initiateObligationPayout + syncObligationStatus)
    // -------------------------------------------------------------------------
    await testCase('T5: PAYOS_PAYOUT_DELEGATE_TO_WORKER=true delegates to Node-3 worker & settles via outbox + sync wake', async () => {
      const oblDeleg = await createReadyObligation(2000);

      nextCreateBehavior = async (req) => {
        const rec = {
          id: `batch_deleg_${prefix}`,
          referenceId: req.referenceId,
          amount: req.amount,
          approvalState: 'COMPLETED',
          transactions: [
            {
              id: `txn_deleg_${prefix}`,
              referenceId: req.referenceId,
              amount: req.amount,
              toBin: req.toBin,
              toAccountNumber: req.toAccountNumber,
              state: 'SUCCEEDED',
            },
          ],
        };
        createdPayouts.set(rec.id, rec);
        createdPayoutsByRef.set(req.referenceId, rec);
        return { code: '00', data: rec };
      };

      const callsBeforeInit = createPayoutCallCount;
      process.env.PAYOS_PAYOUT_DELEGATE_TO_WORKER = 'true';
      process.env.PAYOS_PAYOUT_WORKER_ENABLED = 'true';

      // Trigger Node-3 static-IP worker tick only once THIS obligation's outbox PENDING row commits
      let workerPromise: Promise<void> | null = null;
      let workerStarted = false;
      const pollTrigger = setInterval(async () => {
        if (workerStarted) return;
        const rows = await prisma
          .$queryRawUnsafe<Array<{ id: bigint }>>(
            `SELECT id FROM outbox_events WHERE event_type = 'PAYMENT_REFUND_PAYOUT' AND status = 'PENDING' AND payload->>'obligationId' = $1 LIMIT 1`,
            oblDeleg.obligationId.toString(),
          )
          .catch(() => []);
        if (rows.length > 0) {
          workerStarted = true;
          clearInterval(pollTrigger);
          workerPromise = refundWorker.runTick();
        }
      }, 150);

      const dtoAfterInit = await refundsService.initiateObligationPayout(oblDeleg.obligationId, {}, saCtx);
      clearInterval(pollTrigger);
      if (workerPromise) await workerPromise;

      assert.equal(createPayoutCallCount, callsBeforeInit + 1, 'Static-IP worker should perform the single PayOS createPayout call');
      assert.equal(
        dtoAfterInit.status,
        'REFUNDED',
        `Delegated initiateObligationPayout should poll until worker settles REFUNDED (got ${dtoAfterInit.status})`,
      );

      // Part B: syncObligationStatus on a PENDING_RECONCILIATION obligation wakes & settles cleanly without Render direct getPayout
      const oblSync = await createReadyObligation(2000);
      nextCreateBehavior = async (req) => {
        const rec = {
          id: `batch_sync_${prefix}`,
          referenceId: req.referenceId,
          amount: req.amount,
          approvalState: 'PROCESSING',
          transactions: [
            {
              id: `txn_sync_${prefix}`,
              referenceId: req.referenceId,
              amount: req.amount,
              toBin: req.toBin,
              toAccountNumber: req.toAccountNumber,
              state: 'PROCESSING',
            },
          ],
        };
        createdPayouts.set(rec.id, rec);
        createdPayoutsByRef.set(req.referenceId, rec);
        return { code: '00', data: rec };
      };

      process.env.PAYOS_PAYOUT_DELEGATE_TO_WORKER = 'false';
      const pendingDto = await refundsService.initiateObligationPayout(oblSync.obligationId, {}, saCtx);
      assert.equal(pendingDto.status, 'PENDING_RECONCILIATION');

      const oblSyncInitDb = await prisma.paymentRefundObligation.findUniqueOrThrow({
        where: { obligationId: oblSync.obligationId },
        include: { payoutAttempts: { orderBy: { attemptNumber: 'desc' } } },
      });
      const syncRef = oblSyncInitDb.payoutAttempts[0]!.payoutReference;

      // Push nextReconcileAt 60s into future to prove syncObligationStatus bumps it back <= now for Node-3 worker
      await prisma.paymentRefundPayoutAttempt.updateMany({
        where: { obligationId: oblSync.obligationId, status: 'PENDING_RECONCILIATION' },
        data: { nextReconcileAt: new Date(Date.now() + 60_000) },
      });

      // Flip PayOS remote state to COMPLETED
      const doneRec = {
        id: `batch_sync_${prefix}`,
        referenceId: syncRef,
        amount: 2000,
        approvalState: 'COMPLETED',
        transactions: [
          {
            id: `txn_sync_${prefix}`,
            referenceId: syncRef,
            amount: 2000,
            toBin: '970423',
            toAccountNumber: bankAccRaw,
            state: 'SUCCEEDED',
          },
        ],
      };
      createdPayouts.set(doneRec.id, doneRec);
      createdPayoutsByRef.set(syncRef, doneRec);

      process.env.PAYOS_PAYOUT_DELEGATE_TO_WORKER = 'true';
      const getCallsBeforeSync = getPayoutCallCount;
      let syncWorkerPromise: Promise<void> | null = null;
      let syncWorkerStarted = false;
      let reconcileBumpedObserved = false;
      const syncPoll = setInterval(async () => {
        if (syncWorkerStarted) return;
        const bumped = await prisma.paymentRefundPayoutAttempt
          .findFirst({
            where: { obligationId: oblSync.obligationId },
            orderBy: { attemptNumber: 'desc' },
          })
          .catch(() => null);
        if (bumped?.nextReconcileAt && bumped.nextReconcileAt.getTime() <= Date.now() + 2000) {
          reconcileBumpedObserved = true;
          syncWorkerStarted = true;
          clearInterval(syncPoll);
          syncWorkerPromise = refundWorker.runTick();
        }
      }, 150);

      const syncRes = await refundsService.syncObligationStatus(oblSync.obligationId, saCtx);
      clearInterval(syncPoll);
      if (syncWorkerPromise) await syncWorkerPromise;

      assert.equal(
        reconcileBumpedObserved,
        true,
        'syncObligationStatus must reset nextReconcileAt immediately when delegated',
      );
      assert.equal(syncRes.settled, true, 'Delegated syncObligationStatus must return settled=true after worker tick');
      assert.equal(syncRes.obligation.status, 'REFUNDED');
      assert.equal(getPayoutCallCount, getCallsBeforeSync + 1, 'Only static-IP worker should call PayOS getPayout');
    });
  } finally {
    if (prevChecksum === undefined) delete process.env.PAYOS_CHECKSUM_KEY;
    else process.env.PAYOS_CHECKSUM_KEY = prevChecksum;
    if (prevPayoutChecksum === undefined) delete process.env.PAYOS_PAYOUT_CHECKSUM_KEY;
    else process.env.PAYOS_PAYOUT_CHECKSUM_KEY = prevPayoutChecksum;
    if (prevDelegate === undefined) delete process.env.PAYOS_PAYOUT_DELEGATE_TO_WORKER;
    else process.env.PAYOS_PAYOUT_DELEGATE_TO_WORKER = prevDelegate;
    if (prevWorkerEnabled === undefined) delete process.env.PAYOS_PAYOUT_WORKER_ENABLED;
    else process.env.PAYOS_PAYOUT_WORKER_ENABLED = prevWorkerEnabled;
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;

    try {
      if (createdOrderIds.length > 0) {
        for (const oid of createdOrderIds) {
          await prisma.$executeRawUnsafe(
            `DELETE FROM outbox_events WHERE event_type = 'PAYMENT_REFUND_PAYOUT' AND payload->>'orderId' = $1`,
            oid.toString(),
          ).catch(() => {});
        }
        const obls = await prisma.paymentRefundObligation.findMany({
          where: { orderId: { in: createdOrderIds } },
          select: { obligationId: true },
        });
        const oblIds = obls.map((o) => o.obligationId);
        if (oblIds.length > 0) {
          await prisma.paymentRefundVerifiedVoucher.deleteMany({ where: { obligationId: { in: oblIds } } });
          await prisma.paymentRefundObligation.updateMany({
            where: { obligationId: { in: oblIds } },
            data: { activePayoutAttemptId: null, settledAttemptId: null },
          });
          await prisma.paymentRefundPayoutAttempt.deleteMany({ where: { obligationId: { in: oblIds } } });
          await prisma.paymentRefundObligation.deleteMany({ where: { obligationId: { in: oblIds } } });
        }
        await prisma.paymentOrderReceipt.deleteMany({ where: { orderId: { in: createdOrderIds } } });
        await prisma.orderStatusHistory.deleteMany({ where: { orderId: { in: createdOrderIds } } });
        await prisma.paymentTransaction.deleteMany({ where: { orderId: { in: createdOrderIds } } });
        await prisma.orderItem.deleteMany({ where: { orderId: { in: createdOrderIds } } });
        await prisma.order.deleteMany({ where: { orderId: { in: createdOrderIds } } });
      }
      if (custProfileId !== undefined) {
        await prisma.customerBankAccount.deleteMany({ where: { customerId: custProfileId } });
        await prisma.customerProfile.deleteMany({ where: { customerId: custProfileId } });
      }
      if (storeId !== undefined) {
        await prisma.store.deleteMany({ where: { storeId } });
      }
      const uids = [ownerUserId, custUserId, superAdminUserId].filter((x): x is bigint => x !== undefined);
      if (uids.length > 0) {
        await prisma.user.deleteMany({ where: { userId: { in: uids } } });
      }

      const leftoverOrders = await prisma.order.count({ where: { orderCode: { startsWith: prefix } } });
      const leftoverUsers = await prisma.user.count({ where: { username: { startsWith: prefix } } });
      assert.equal(leftoverOrders, 0, 'Zero leftover test orders');
      assert.equal(leftoverUsers, 0, 'Zero leftover test users');
    } catch (cleanErr: any) {
      console.error('Cleanup error:', cleanErr?.stack || cleanErr?.message || cleanErr);
      outcomes.push({ name: 'Cleanup & zero-residue check', passed: false, error: cleanErr?.message });
    } finally {
      await prisma.$disconnect();
    }
  }

  const passed = outcomes.filter((o) => o.passed).length;
  const failed = outcomes.filter((o) => !o.passed).length;
  console.log(`\nSUMMARY: ${passed} PASSED, ${failed} FAILED`);
  if (failed > 0) {
    process.exit(1);
  }
  process.exit(0);
}

runSuite();
