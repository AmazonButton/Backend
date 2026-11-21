/**
 * Comprehensive F2 PayOS Order Refund Obligation & Receipt Ledger Hardening Suite.
 * Executes exclusively against guarded test DB (smart_order_test) + mocked PayOS APIs.
 * Run: npx tsx tests/payment-refund-obligations-hardening.spec.ts
 */
import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { getSafeTestPrismaService } from './test-db-guard';
import { ROLES_KEY } from '../src/common/decorators/roles.decorator';
import { AdminController } from '../src/admin/admin.controller';
import { PaymentsController } from '../src/payments/payments.controller';
import { OrdersController } from '../src/orders/orders.controller';
import { PaymentsRepository } from '../src/payments/payments.repository';
import { PaymentsService } from '../src/payments/payments.service';
import { PaymentRefundsRepository } from '../src/payments/payment-refunds.repository';
import { PaymentRefundsService } from '../src/payments/payment-refunds.service';
import { PaymentRefundWorkerService } from '../src/payments/payment-refund-worker.service';
import { PayoutWebhookController } from '../src/payments/payout-webhook.controller';
import { OrdersRepository } from '../src/orders/orders.repository';
import { OrdersService } from '../src/orders/orders.service';
import {
  PayOSPayoutIndeterminateException,
  PayOSPayoutPreDispatchException,
} from '../src/payments/payos-payout.service';
import { OutboxConsumerService } from '../src/rentals/outbox-consumer.service';
import { CryptoVaultUtil } from '../src/common/utils/crypto-vault.util';
import { signPayoutRequest, signWebhookData } from '../src/payments/payos.helper';

type Outcome = { name: string; passed: boolean; detail?: string };
const outcomes: Outcome[] = [];

async function testCase(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    outcomes.push({ name, passed: true });
    console.log(`PASS ${name}`);
  } catch (err: any) {
    const detail = `${err?.constructor?.name || 'Error'}: ${err?.message || err}`;
    outcomes.push({ name, passed: false, detail });
    console.error(`FAIL ${name} -> ${detail}`);
  }
}

async function runSuite() {
  const prisma = getSafeTestPrismaService('Payment Refund Obligations & Receipt Ledger Hardening');
  const prefix = `PRH${Date.now()}${randomUUID().slice(0, 4).toUpperCase()}`;
  const prevChecksum = process.env.PAYOS_CHECKSUM_KEY;
  const prevPayoutChecksum = process.env.PAYOS_PAYOUT_CHECKSUM_KEY;
  const prevNodeEnv = process.env.NODE_ENV;

  process.env.NODE_ENV = 'test';
  process.env.PAYOS_CHECKSUM_KEY = 'prh-test-payos-checksum-key-32bytes!';
  process.env.PAYOS_PAYOUT_CHECKSUM_KEY = 'prh-test-payout-checksum-key-32bytes';

  let ownerUserId: bigint | undefined;
  let storeId: bigint | undefined;
  let custUserId: bigint | undefined;
  let custProfileId: bigint | undefined;
  let superAdminUserId: bigint | undefined;
  let seq = 0;

  // Dynamic mock PayOS payout provider state
  const createdPayouts = new Map<string, any>();
  const createdPayoutsByRef = new Map<string, any>();
  let createPayoutCallCount = 0;
  let getPayoutsOverride: ((params?: { referenceId?: string }) => Promise<any>) | null = null;
  const defaultCreateBehavior: (req: any) => Promise<any> = async (req) => {
    const payoutId = `po_${prefix}_${createdPayouts.size + 1}`;
    const txId = `potx_${prefix}_${createdPayouts.size + 1}`;
    const rec = {
      id: payoutId,
      referenceId: req.referenceId,
      amount: req.amount,
      approvalState: 'SUCCEEDED',
      transactions: [
        {
          id: txId,
          referenceId: req.referenceId,
          amount: req.amount,
          toBin: req.toBin,
          toAccountNumber: req.toAccountNumber,
          state: 'SUCCEEDED',
        },
      ],
    };
    createdPayouts.set(payoutId, rec);
    createdPayoutsByRef.set(req.referenceId, rec);
    return { code: '00', data: rec };
  };
  let nextCreateBehavior = defaultCreateBehavior;

  const mockPayosPayoutService = {
    createPayout: async (req: any) => {
      createPayoutCallCount++;
      return nextCreateBehavior(req);
    },
    getPayout: async (id: string) => {
      const found = createdPayouts.get(id);
      if (!found) {
        return { code: '01', desc: 'Not found', data: null };
      }
      return { code: '00', data: found };
    },
    getPayouts: async (params?: { referenceId?: string }) => {
      if (getPayoutsOverride) {
        return getPayoutsOverride(params);
      }
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
  const ordersService = new OrdersService(
    ordersRepo,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    refundsService,
  );
  const adminController = new AdminController({} as any, refundsService);
  const mockWalletSvc = { processPayoutWebhook: async () => ({ delegatedToWallet: true }) } as any;
  const payoutWebhookController = new PayoutWebhookController(mockWalletSvc, undefined, refundsService);

  const createdOrderIds: bigint[] = [];
  const createdOutboxIds: bigint[] = [];

  try {
    await prisma.$connect();

    const owner = await prisma.user.create({
      data: {
        username: `${prefix}_owner`,
        email: `${prefix}_owner@example.invalid`,
        passwordHash: 'test-placeholder-not-a-login-hash-padding-to-at-least-60-characters',
        fullName: 'Store Owner Fixture',
        status: 'ACTIVE',
      },
    });
    ownerUserId = owner.userId;

    const superAdmin = await prisma.user.create({
      data: {
        username: `${prefix}_sa`,
        email: `${prefix}_sa@example.invalid`,
        passwordHash: 'test-placeholder-not-a-login-hash-padding-to-at-least-60-characters',
        fullName: 'Super Admin Fixture',
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
        address: 'Fixture Address',
        status: 'ACTIVE',
      },
    });
    storeId = store.storeId;

    const custUser = await prisma.user.create({
      data: {
        username: `${prefix}_cust`,
        email: `${prefix}_cust@example.invalid`,
        passwordHash: 'test-placeholder-not-a-login-hash-padding-to-at-least-60-characters',
        fullName: 'Verified Customer',
        status: 'ACTIVE',
      },
    });
    custUserId = custUser.userId;

    const custProfile = await prisma.customerProfile.create({ data: { userId: custUserId } });
    custProfileId = custProfile.customerId;

    const matchedAccRaw = `190900${String(Date.now()).slice(-6)}`;
    const matchedBank = await prisma.customerBankAccount.create({
      data: {
        customerId: custProfileId,
        bankCode: 'MB',
        bankName: 'MBBank',
        bankBin: '970422',
        accountNumberEncrypted: CryptoVaultUtil.encryptAccountNumber(matchedAccRaw),
        accountNumberMasked: CryptoVaultUtil.maskAccountNumber(matchedAccRaw),
        accountNumberHash: CryptoVaultUtil.computeDeterministicAccountHash(matchedAccRaw),
        accountName: 'NGUYEN VAN TEST',
        verificationStatus: 'VERIFIED',
        isDefault: true,
      },
    });

    const altAccRaw = `290900${String(Date.now()).slice(-6)}`;
    const altVerifiedBank = await prisma.customerBankAccount.create({
      data: {
        customerId: custProfileId,
        bankCode: 'VCB',
        bankName: 'Vietcombank',
        bankBin: '970436',
        accountNumberEncrypted: CryptoVaultUtil.encryptAccountNumber(altAccRaw),
        accountNumberMasked: CryptoVaultUtil.maskAccountNumber(altAccRaw),
        accountNumberHash: CryptoVaultUtil.computeDeterministicAccountHash(altAccRaw),
        accountName: 'NGUYEN VAN ALT',
        verificationStatus: 'VERIFIED',
        isDefault: false,
      },
    });

    const mkOrder = async (opts: {
      customerId?: bigint | null;
      orderStatus?: string;
      paymentStatus?: string;
      amount?: number;
    }) => {
      const amt = opts.amount ?? 120000;
      const ord = await prisma.order.create({
        data: {
          orderCode: `${prefix}-O-${++seq}`,
          storeId: storeId!,
          customerId: opts.customerId === undefined ? custProfileId : opts.customerId,
          orderStatus: opts.orderStatus || 'PENDING',
          paymentStatus: opts.paymentStatus || 'UNPAID',
          paymentMethod: 'PAYOS',
          subtotalAmount: amt,
          totalAmount: amt,
          shippingRecipientName: 'Fixture Recipient',
          shippingPhone: '0911111111',
          shippingAddress: 'Fixture Street',
        },
      });
      createdOrderIds.push(ord.orderId);
      return ord;
    };

    const mkTx = async (orderId: bigint, opts?: { status?: string; amount?: number; linkId?: string }) => {
      const codeNum = BigInt(`${Date.now().toString().slice(-8)}${String(++seq).padStart(4, '0')}`);
      return prisma.paymentTransaction.create({
        data: {
          orderId,
          provider: 'PAYOS',
          transactionCode: codeNum.toString(),
          amount: opts?.amount ?? 120000,
          paymentMethod: 'QR',
          status: opts?.status || 'PENDING',
          paymentLinkId: opts?.linkId || `${prefix}-link-${seq}`,
        },
      });
    };

    const sendSignedWebhook = async (pt: any, overrides: Record<string, any> = {}) => {
      const data: any = {
        orderCode: Number(pt.transactionCode),
        amount: Number(pt.amount),
        description: `Thanh toan ${pt.transactionCode}`,
        accountNumber: '0123456789',
        reference: `FT_${prefix}_${++seq}`,
        transactionDateTime: '2026-11-22 00:10:00',
        currency: 'VND',
        paymentLinkId: pt.paymentLinkId,
        code: '00',
        desc: 'success',
        counterAccountBankId: '970422',
        counterAccountNumber: matchedAccRaw,
        counterAccountName: 'NGUYEN VAN TEST',
        ...overrides,
      };
      const signature = signWebhookData(data, process.env.PAYOS_CHECKSUM_KEY!);
      return paymentsService.handlePayosWebhook({
        code: '00',
        desc: 'success',
        success: true,
        data,
        signature,
      } as any);
    };

    // -------------------------------------------------------------------------
    // T1: Two distinct transfers on SAME paymentLinkId + Replay conflict detection
    // -------------------------------------------------------------------------
    await testCase('T1: Two distinct transfers on SAME payment link create 2 receipts + 1 excess obligation while preserving PAID', async () => {
      const ord = await mkOrder({ orderStatus: 'PENDING' });
      const pt = await mkTx(ord.orderId);

      await sendSignedWebhook(pt, { reference: `FT_SAME_1_${prefix}` });
      await sendSignedWebhook(pt, { reference: `FT_SAME_2_${prefix}`, amount: 85000 });
      // Identical replay of FT_SAME_2 must remain idempotent
      await sendSignedWebhook(pt, { reference: `FT_SAME_2_${prefix}`, amount: 85000 });

      const receipts = await prisma.paymentOrderReceipt.findMany({
        where: { orderId: ord.orderId },
        orderBy: { receiptId: 'asc' },
      });
      assert.equal(receipts.length, 2, 'Expected 2 distinct receipts on same payment link');
      assert.equal(receipts[0].classification, 'ORDER_PAYMENT');
      assert.equal(receipts[0].sourceBankBin, '970422');
      assert.equal(receipts[1].classification, 'EXCESS_DUPLICATE');
      assert.equal(Number(receipts[1].amount), 85000);

      const obls = await prisma.paymentRefundObligation.findMany({ where: { orderId: ord.orderId } });
      assert.equal(obls.length, 1, 'Expected 1 EXCESS_DUPLICATE obligation');
      assert.equal(obls[0].obligationType, 'EXCESS_DUPLICATE');
      assert.equal(obls[0].status, 'READY_FOR_PAYOUT');
      assert.equal(obls[0].recipientVerificationStatus, 'VERIFIED_MATCHED_SOURCE');

      const ptAfter = await prisma.paymentTransaction.findUniqueOrThrow({ where: { paymentTransactionId: pt.paymentTransactionId } });
      const ordAfter = await prisma.order.findUniqueOrThrow({ where: { orderId: ord.orderId } });
      assert.equal(ptAfter.status, 'PAID');
      assert.equal(ordAfter.paymentStatus, 'PAID');
      assert.equal(ordAfter.orderStatus, 'CONFIRMED');
    });

    await testCase('T1b: Conflicting replay on same providerTransactionRef marks SOURCE_CONFLICTING and blocks payout', async () => {
      const ord = await mkOrder({ orderStatus: 'CONFIRMED', paymentStatus: 'PAID' });
      const validPt = await mkTx(ord.orderId, { status: 'PAID' });
      const oldPt = await mkTx(ord.orderId, { status: 'CANCELLED' });
      const conflictRef = `FT_CONFLICT_${prefix}`;
      await sendSignedWebhook(oldPt, { reference: conflictRef });
      // Replay same reference with different counterAccountNumber
      await sendSignedWebhook(oldPt, { reference: conflictRef, counterAccountNumber: altAccRaw, counterAccountBankId: '970436' });

      const receipt = await prisma.paymentOrderReceipt.findFirstOrThrow({
        where: { orderId: ord.orderId, providerTransactionRef: conflictRef },
        include: { refundObligation: true },
      });
      assert.equal(receipt.sourceEvidenceStatus, 'CONFLICTING');
      assert.equal(receipt.refundObligation?.status, 'PENDING_RECIPIENT_VERIFICATION');
      assert.equal(receipt.refundObligation?.recipientVerificationStatus, 'SOURCE_CONFLICTING');

      await assert.rejects(
        () =>
          refundsService.initiateObligationPayout(
            receipt.refundObligation!.obligationId,
            { customerBankAccountId: matchedBank.id.toString() },
            { userId: superAdminUserId, role: 'SUPER_ADMIN' },
          ),
        BadRequestException,
      );
      const validAfter = await prisma.paymentTransaction.findUniqueOrThrow({ where: { paymentTransactionId: validPt.paymentTransactionId } });
      assert.equal(validAfter.status, 'PAID');
    });

    // -------------------------------------------------------------------------
    // T2: Masked / Missing / Unmapped Bank / Arbitrary Bank Override Blocked
    // -------------------------------------------------------------------------
    await testCase('T2: Masked/missing/unmapped source ALWAYS records paid receipt but parks obligation fail-closed', async () => {
      // A: Masked account
      const ordMask = await mkOrder({ orderStatus: 'CANCELLED', paymentStatus: 'UNPAID' });
      const ptMask = await mkTx(ordMask.orderId);
      await sendSignedWebhook(ptMask, {
        reference: `FT_MASK_${prefix}`,
        counterAccountNumber: '1909****1234',
        counterAccountBankId: '970422',
      });
      const recMask = await prisma.paymentOrderReceipt.findFirstOrThrow({
        where: { orderId: ordMask.orderId },
        include: { refundObligation: true },
      });
      assert.equal(recMask.sourceEvidenceStatus, 'MASKED');
      assert.equal(recMask.refundObligation?.status, 'PENDING_RECIPIENT_VERIFICATION');
      assert.equal(recMask.refundObligation?.recipientVerificationStatus, 'SOURCE_INSUFFICIENT');

      // B: Missing account & unmapped bank identifier (must NOT coerce to any BIN)
      const ordUnmap = await mkOrder({ orderStatus: 'CANCELLED', paymentStatus: 'UNPAID' });
      const ptUnmap = await mkTx(ordUnmap.orderId);
      await sendSignedWebhook(ptUnmap, {
        reference: `FT_UNMAP_${prefix}`,
        counterAccountNumber: '999888777',
        counterAccountBankId: 'UNKNOWN_BANK_NO_BIN',
      });
      const recUnmap = await prisma.paymentOrderReceipt.findFirstOrThrow({
        where: { orderId: ordUnmap.orderId },
        include: { refundObligation: true },
      });
      assert.equal(recUnmap.sourceBankBin, null, 'Unmapped bank ID must NEVER coerce to a fake BIN');
      assert.equal(recUnmap.sourceEvidenceStatus, 'UNMAPPED_BANK');
      assert.equal(recUnmap.refundObligation?.status, 'PENDING_RECIPIENT_VERIFICATION');
      assert.equal(recUnmap.refundObligation?.recipientVerificationStatus, 'SOURCE_INSUFFICIENT');

      // C: Valid BIN + account belonging to ANOTHER account (not customer VERIFIED account) + reject arbitrary override
      const ordDiff = await mkOrder({ orderStatus: 'CANCELLED', paymentStatus: 'UNPAID' });
      const ptDiff = await mkTx(ordDiff.orderId);
      await sendSignedWebhook(ptDiff, {
        reference: `FT_DIFF_${prefix}`,
        counterAccountNumber: '777666555444',
        counterAccountBankId: '970422',
      });
      const recDiff = await prisma.paymentOrderReceipt.findFirstOrThrow({
        where: { orderId: ordDiff.orderId },
        include: { refundObligation: true },
      });
      assert.equal(recDiff.sourceEvidenceStatus, 'SUFFICIENT');
      assert.equal(recDiff.refundObligation?.status, 'PENDING_RECIPIENT_VERIFICATION');
      assert.equal(recDiff.refundObligation?.recipientVerificationStatus, 'SOURCE_CONFLICTING');

      // Passing customerBankAccountId pointing to verified altVerifiedBank OR matchedBank must still be rejected!
      await assert.rejects(
        () =>
          refundsService.initiateObligationPayout(
            recDiff.refundObligation!.obligationId,
            { customerBankAccountId: altVerifiedBank.id.toString() },
            { userId: superAdminUserId, role: 'SUPER_ADMIN' },
          ),
        BadRequestException,
      );
      await assert.rejects(
        () =>
          refundsService.initiateObligationPayout(
            recMask.refundObligation!.obligationId,
            { customerBankAccountId: matchedBank.id.toString() },
            { userId: superAdminUserId, role: 'SUPER_ADMIN' },
          ),
        BadRequestException,
      );
    });

    // -------------------------------------------------------------------------
    // T3: Guest Order Quarantine
    // -------------------------------------------------------------------------
    await testCase('T3: Guest order refund obligation stays quarantined even with sufficient sender proof', async () => {
      const guestOrd = await mkOrder({ customerId: null, orderStatus: 'PENDING' });
      const guestPt = await mkTx(guestOrd.orderId);
      await sendSignedWebhook(guestPt, { reference: `FT_GUEST_${prefix}` });

      await ordersRepo.cancelOrderAtomicTx(guestOrd.orderId, 'Guest requested cancel');
      const obls = await refundsRepo.findObligationsForOrder(guestOrd.orderId);
      assert.equal(obls.length, 1);
      assert.equal(obls[0].status, 'PENDING_RECIPIENT_VERIFICATION');
      assert.equal(obls[0].recipientVerificationStatus, 'GUEST_UNVERIFIED');

      // Even SUPER_ADMIN + verified customer bank override cannot auto-payout a guest order
      await assert.rejects(
        () =>
          ordersService.refundOrder(
            guestOrd.orderId,
            { customerBankAccountId: matchedBank.id.toString() },
            { userId: superAdminUserId, role: 'SUPER_ADMIN' },
          ),
        BadRequestException,
      );
      const guestAfter = await prisma.order.findUniqueOrThrow({ where: { orderId: guestOrd.orderId } });
      assert.equal(guestAfter.paymentStatus, 'REFUND_PENDING');
    });

    // -------------------------------------------------------------------------
    // T4: Role Authority & Deprecated Manual Bypass Block
    // -------------------------------------------------------------------------
    await testCase('T4: Financial payout routes and services enforce strict SUPER_ADMIN only & forbid manual bypass', async () => {
      const reflector = new Reflector();
      const adminClassRoles = reflector.get(ROLES_KEY, AdminController);
      assert.deepEqual(adminClassRoles, ['SUPER_ADMIN']);
      for (const methodName of [
        'listPaymentRefundObligations',
        'getPaymentRefundObligation',
        'initiatePaymentRefundPayout',
        'syncPaymentRefundObligation',
      ]) {
        const methodRoles = reflector.get(ROLES_KEY, (AdminController.prototype as any)[methodName]);
        assert.deepEqual(methodRoles, ['SUPER_ADMIN'], `AdminController.${methodName} must require SUPER_ADMIN`);
      }
      assert.deepEqual(reflector.get(ROLES_KEY, PaymentsController.prototype.refundExcessTransaction), ['SUPER_ADMIN']);
      assert.deepEqual(reflector.get(ROLES_KEY, OrdersController.prototype.refund), ['SUPER_ADMIN']);

      for (const nonSuper of [
        { userId: ownerUserId, storeId, role: 'STORE_OWNER' },
        { userId: ownerUserId, role: 'ADMIN' },
        { userId: ownerUserId, role: 'SYSTEM_ADMIN' },
      ]) {
        await assert.rejects(
          () => adminController.initiatePaymentRefundPayout('1', {}, { user: nonSuper }),
          ForbiddenException,
        );
        await assert.rejects(
          () => ordersService.refundOrder(createdOrderIds[0], {}, nonSuper),
          ForbiddenException,
        );
      }

      // Deprecated manual helpers fail closed
      await assert.rejects(
        () => paymentsRepo.refundExcessTransactionAtomicTx(1n, 'bypass attempt'),
        /MANUAL_EXCESS_REFUND_DEPRECATED/,
      );
    });

    // -------------------------------------------------------------------------
    // T5: R2 Resolution (Main->Excess, Excess->Main, Concurrent Race) + DB Trigger
    // -------------------------------------------------------------------------
    await testCase('T5: Main-first & Excess-first & Concurrent settlement succeed without R2 deadlock + Trigger blocks over-budget', async () => {
      // Path B: Main refund FIRST -> Excess refund AFTER (reproduces original R2 scenario cleanly!)
      const ordB = await mkOrder({ orderStatus: 'PENDING' });
      const ptB1 = await mkTx(ordB.orderId, { status: 'PAID' });
      // Settle ptB1 via webhook-style receipt row cleanly
      await prisma.paymentOrderReceipt.create({
        data: {
          orderId: ordB.orderId,
          paymentTransactionId: ptB1.paymentTransactionId,
          provider: 'PAYOS',
          channel: 'ORDER_PAYMENT_LINK',
          providerTransactionRef: `FT_B1_${prefix}`,
          amount: 120000,
          currency: 'VND',
          classification: 'ORDER_PAYMENT',
          sourceBankBin: '970422',
          sourceAccountMasked: CryptoVaultUtil.maskAccountNumber(matchedAccRaw),
          sourceAccountHash: CryptoVaultUtil.computeDeterministicAccountHash(matchedAccRaw),
          sourceAccountEncrypted: CryptoVaultUtil.encryptAccountNumber(matchedAccRaw),
          sourceEvidenceStatus: 'SUFFICIENT',
        },
      });
      await prisma.order.update({
        where: { orderId: ordB.orderId },
        data: { orderStatus: 'CONFIRMED', paymentStatus: 'PAID' },
      });

      const ptB2 = await mkTx(ordB.orderId, { status: 'CANCELLED' });
      await sendSignedWebhook(ptB2, { reference: `FT_B2_${prefix}` });

      // Cancel order FIRST
      await ordersRepo.cancelOrderAtomicTx(ordB.orderId, 'Cancel before refunds');
      // Refund MAIN order FIRST
      const afterMain = await ordersService.refundOrder(
        ordB.orderId,
        {},
        { userId: superAdminUserId, role: 'SUPER_ADMIN' },
      );
      assert.equal(afterMain.paymentStatus, 'REFUNDED');
      const ptB2Mid = await prisma.paymentTransaction.findUniqueOrThrow({ where: { paymentTransactionId: ptB2.paymentTransactionId } });
      assert.equal(ptB2Mid.status, 'REFUND_PENDING', 'Excess sibling remains queued for its own refund');

      // NOW settle ptB2 AFTER main order is already REFUNDED (used to fail in old R2!)
      const excessRes = await paymentsService.refundExcessTransaction(
        ptB2.paymentTransactionId.toString(),
        {},
        { userId: superAdminUserId, role: 'SUPER_ADMIN' },
      );
      assert.equal(excessRes.settled, true);
      const ptB2Final = await prisma.paymentTransaction.findUniqueOrThrow({ where: { paymentTransactionId: ptB2.paymentTransactionId } });
      assert.equal(ptB2Final.status, 'REFUNDED');

      // Path C: Concurrent Main + Excess settlement on SAME payment link (`FT_C1` + `FT_C2`)
      const ordC = await mkOrder({ orderStatus: 'PENDING' });
      const ptC = await mkTx(ordC.orderId);
      await sendSignedWebhook(ptC, { reference: `FT_C1_${prefix}` });
      await sendSignedWebhook(ptC, { reference: `FT_C2_${prefix}`, amount: 65000 });
      await ordersRepo.cancelOrderAtomicTx(ordC.orderId, 'Cancel for concurrent main + excess settlement');
      const oblsC = await refundsRepo.findObligationsForOrder(ordC.orderId);
      assert.equal(oblsC.length, 2);
      const [mainRes, excessCRes] = await Promise.all([
        refundsService.initiateObligationPayout(oblsC[0].obligationId, {}, { userId: superAdminUserId, role: 'SUPER_ADMIN' }),
        refundsService.initiateObligationPayout(oblsC[1].obligationId, {}, { userId: superAdminUserId, role: 'SUPER_ADMIN' }),
      ]);
      assert.equal(mainRes.status, 'REFUNDED');
      assert.equal(excessCRes.status, 'REFUNDED');
      const ptCFinal = await prisma.paymentTransaction.findUniqueOrThrow({ where: { paymentTransactionId: ptC.paymentTransactionId } });
      const ordCFinal = await prisma.order.findUniqueOrThrow({ where: { orderId: ordC.orderId } });
      assert.equal(ptCFinal.status, 'REFUNDED');
      assert.equal(ordCFinal.paymentStatus, 'REFUNDED');

      // Path D: PostgreSQL Trigger blocks over-budget or active-order obligation creation
      const activeOrd = await mkOrder({ orderStatus: 'CONFIRMED', paymentStatus: 'PAID' });
      const activePt = await mkTx(activeOrd.orderId, { status: 'PAID' });
      const activeRec = await prisma.paymentOrderReceipt.create({
        data: {
          orderId: activeOrd.orderId,
          paymentTransactionId: activePt.paymentTransactionId,
          provider: 'PAYOS',
          channel: 'ORDER_PAYMENT_LINK',
          providerTransactionRef: `FT_ACT_${prefix}`,
          amount: 120000,
          currency: 'VND',
          classification: 'ORDER_PAYMENT',
          sourceEvidenceStatus: 'MISSING',
        },
      });
      await assert.rejects(
        () =>
          prisma.paymentRefundObligation.create({
            data: {
              orderId: activeOrd.orderId,
              sourcePaymentTransactionId: activePt.paymentTransactionId,
              receiptId: activeRec.receiptId,
              obligationType: 'ORDER_REFUND',
              refundAmount: 120000,
              currency: 'VND',
              status: 'PENDING_RECIPIENT_VERIFICATION',
              recipientVerificationStatus: 'SOURCE_INSUFFICIENT',
            },
          }),
        /ACTIVE_ORDER_PAYMENT_NOT_REFUNDABLE/,
      );
    });

    // -------------------------------------------------------------------------
    // T6: Global Voucher Uniqueness + Shared Batch Payout Support
    // -------------------------------------------------------------------------
    await testCase('T6: Global voucher blocks duplicate providerTransactionId while supporting shared batch providerPayoutId', async () => {
      const ordV1 = await mkOrder({ orderStatus: 'PENDING' });
      const ptV1 = await mkTx(ordV1.orderId);
      await sendSignedWebhook(ptV1, { reference: `FT_V1_${prefix}` });
      await ordersRepo.cancelOrderAtomicTx(ordV1.orderId, 'Voucher test 1');
      const [oblV1] = await refundsRepo.findObligationsForOrder(ordV1.orderId);

      const ordV2 = await mkOrder({ orderStatus: 'PENDING' });
      const ptV2 = await mkTx(ordV2.orderId);
      await sendSignedWebhook(ptV2, { reference: `FT_V2_${prefix}` });
      await ordersRepo.cancelOrderAtomicTx(ordV2.orderId, 'Voucher test 2');
      const [oblV2] = await refundsRepo.findObligationsForOrder(ordV2.orderId);

      // Force createPayout to reuse the SAME transactions[0].id across both payouts
      const sharedTxId = `potx_reused_${prefix}`;
      nextCreateBehavior = async (req) => {
        const pid = `po_reuse_${prefix}_${createdPayouts.size + 1}`;
        const rec = {
          id: pid,
          referenceId: req.referenceId,
          amount: req.amount,
          approvalState: 'SUCCEEDED',
          transactions: [
            {
              id: sharedTxId,
              referenceId: req.referenceId,
              amount: req.amount,
              toBin: req.toBin,
              toAccountNumber: req.toAccountNumber,
              state: 'SUCCEEDED',
            },
          ],
        };
        createdPayouts.set(pid, rec);
        createdPayoutsByRef.set(req.referenceId, rec);
        return { code: '00', data: rec };
      };

      const v1Done = await refundsService.initiateObligationPayout(
        oblV1.obligationId,
        {},
        { userId: superAdminUserId, role: 'SUPER_ADMIN' },
      );
      assert.equal(v1Done.status, 'REFUNDED');

      await assert.rejects(
        () =>
          refundsService.initiateObligationPayout(
            oblV2.obligationId,
            {},
            { userId: superAdminUserId, role: 'SUPER_ADMIN' },
          ),
        ConflictException,
      );

      // Batch payout sharing ONE providerPayoutId but having DISTINCT transactions[i].id + payoutReference
      const ordB1 = await mkOrder({ orderStatus: 'PENDING' });
      const ptBatch1 = await mkTx(ordB1.orderId);
      await sendSignedWebhook(ptBatch1, { reference: `FT_BATCH_1_${prefix}` });
      await ordersRepo.cancelOrderAtomicTx(ordB1.orderId, 'Batch 1');
      const [oblB1] = await refundsRepo.findObligationsForOrder(ordB1.orderId);

      const ordB2 = await mkOrder({ orderStatus: 'PENDING' });
      const ptBatch2 = await mkTx(ordB2.orderId);
      await sendSignedWebhook(ptBatch2, { reference: `FT_BATCH_2_${prefix}` });
      await ordersRepo.cancelOrderAtomicTx(ordB2.orderId, 'Batch 2');
      const [oblB2] = await refundsRepo.findObligationsForOrder(ordB2.orderId);

      // Simulate batch disbursement settled under shared providerPayoutId
      const claim1 = await refundsRepo.claimObligationForPayoutTx(oblB1.obligationId, superAdminUserId);
      const claim2 = await refundsRepo.claimObligationForPayoutTx(oblB2.obligationId, superAdminUserId);
      if (claim1.outboxEvent?.id) createdOutboxIds.push(claim1.outboxEvent.id);
      if (claim2.outboxEvent?.id) createdOutboxIds.push(claim2.outboxEvent.id);

      const batchPayoutId = `po_shared_batch_${prefix}`;
      const batchPayloads = {
        id: batchPayoutId,
        approvalState: 'SUCCEEDED',
        transactions: [
          {
            id: `potx_batch_1_${prefix}`,
            referenceId: claim1.attempt!.payoutReference,
            amount: 120000,
            toBin: '970422',
            toAccountNumber: matchedAccRaw,
            state: 'SUCCEEDED',
          },
          {
            id: `potx_batch_2_${prefix}`,
            referenceId: claim2.attempt!.payoutReference,
            amount: 120000,
            toBin: '970422',
            toAccountNumber: matchedAccRaw,
            state: 'SUCCEEDED',
          },
        ],
      };
      createdPayouts.set(batchPayoutId, batchPayloads);
      createdPayoutsByRef.set(claim1.attempt!.payoutReference, batchPayloads);
      createdPayoutsByRef.set(claim2.attempt!.payoutReference, batchPayloads);

      await refundsService.dispatchClaimedAttempt(oblB1.obligationId, claim1.attempt!.attemptId);
      await refundsService.dispatchClaimedAttempt(oblB2.obligationId, claim2.attempt!.attemptId);
      const batchOutboxIds = [claim1.outboxEvent?.id, claim2.outboxEvent?.id].filter((x): x is bigint => Boolean(x));
      if (batchOutboxIds.length > 0) {
        await prisma.outboxEvent.updateMany({
          where: { id: { in: batchOutboxIds } },
          data: { status: 'COMPLETED', processedAt: new Date() },
        });
      }

      const oblB1After = await prisma.paymentRefundObligation.findUniqueOrThrow({ where: { obligationId: oblB1.obligationId } });
      const oblB2After = await prisma.paymentRefundObligation.findUniqueOrThrow({ where: { obligationId: oblB2.obligationId } });
      assert.equal(oblB1After.status, 'REFUNDED');
      assert.equal(oblB2After.status, 'REFUNDED');
    });

    // -------------------------------------------------------------------------
    // T7: Concurrency Claim, Crash/Timeout Reconciliation, Webhook Routing, Outbox Exclusion
    // -------------------------------------------------------------------------
    await testCase('T7: Concurrent claims blocked, indeterminate timeout keeps fixed reference on reconcile, signed webhook & outbox work', async () => {
      // Restore default mock
      nextCreateBehavior = async (req) => {
        const payoutId = `po_${prefix}_${createdPayouts.size + 1}`;
        const txId = `potx_${prefix}_${createdPayouts.size + 1}`;
        const rec = {
          id: payoutId,
          referenceId: req.referenceId,
          amount: req.amount,
          approvalState: 'SUCCEEDED',
          transactions: [
            {
              id: txId,
              referenceId: req.referenceId,
              amount: req.amount,
              toBin: req.toBin,
              toAccountNumber: req.toAccountNumber,
              state: 'SUCCEEDED',
            },
          ],
        };
        createdPayouts.set(payoutId, rec);
        createdPayoutsByRef.set(req.referenceId, rec);
        return { code: '00', data: rec };
      };

      // A. Concurrency claim race
      const ordRace = await mkOrder({ orderStatus: 'PENDING' });
      const ptRace = await mkTx(ordRace.orderId);
      await sendSignedWebhook(ptRace, { reference: `FT_RACE_${prefix}` });
      await ordersRepo.cancelOrderAtomicTx(ordRace.orderId, 'Claim race');
      const [oblRace] = await refundsRepo.findObligationsForOrder(ordRace.orderId);

      const [r1, r2] = await Promise.allSettled([
        refundsRepo.claimObligationForPayoutTx(oblRace.obligationId, superAdminUserId),
        refundsRepo.claimObligationForPayoutTx(oblRace.obligationId, superAdminUserId),
      ]);
      const fulfilled = [r1, r2].filter((r) => r.status === 'fulfilled');
      const rejected = [r1, r2].filter((r) => r.status === 'rejected');
      assert.equal(fulfilled.length, 1, 'Only 1 concurrent claim may win');
      assert.equal(rejected.length, 1, 'Loser must receive ConflictException');
      const wonAttempt = (fulfilled[0] as any).value.attempt;
      const raceOutboxId = (fulfilled[0] as any).value.outboxEvent?.id;
      if (raceOutboxId) createdOutboxIds.push(raceOutboxId);

      // Verify Rental OutboxConsumerService does NOT steal PAYMENT_REFUND_PAYOUT events!
      const rentalConsumer = new OutboxConsumerService(prisma, {} as any, {} as any);
      await rentalConsumer.processPendingEvents(20);
      const outboxUntouched = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: raceOutboxId } });
      assert.equal(outboxUntouched.status, 'PENDING', 'Rentals OutboxConsumerService must ignore PAYMENT_REFUND_PAYOUT');

      // B. Simulate PayOS network timeout after provider actually processed payout -> worker reconciles SAME reference!
      const beforeCalls = createPayoutCallCount;
      let leakedRef = '';
      nextCreateBehavior = async (req) => {
        leakedRef = req.referenceId;
        // Provider succeeded remotely, but response timed out before reaching backend!
        const rec = {
          id: `po_timeout_${prefix}`,
          referenceId: req.referenceId,
          amount: req.amount,
          approvalState: 'SUCCEEDED',
          transactions: [
            {
              id: `potx_timeout_${prefix}`,
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
        throw new PayOSPayoutIndeterminateException('NETWORK_ERROR', 'Simulated socket timeout after HTTP send');
      };

      const workerDispatch = await refundWorker.processOutboxDispatchBatch(20);
      assert.ok(workerDispatch.processed >= 1);
      assert.equal(createPayoutCallCount, beforeCalls + 1);
      assert.equal(leakedRef, wonAttempt.payoutReference);

      const oblPendingRec = await prisma.paymentRefundObligation.findUniqueOrThrow({ where: { obligationId: oblRace.obligationId } });
      assert.equal(oblPendingRec.status, 'PENDING_RECONCILIATION');

      // Force nextReconcileAt <= now so worker reconciles WITHOUT calling createPayout a 2nd time!
      await prisma.paymentRefundPayoutAttempt.update({
        where: { attemptId: wonAttempt.attemptId },
        data: { nextReconcileAt: new Date(Date.now() - 1000) },
      });
      await refundWorker.reconcilePendingAttemptsBatch(20);

      assert.equal(createPayoutCallCount, beforeCalls + 1, 'Reconciliation MUST NEVER call createPayout again');
      const oblReconciled = await prisma.paymentRefundObligation.findUniqueOrThrow({
        where: { obligationId: oblRace.obligationId },
        include: { payoutAttempts: true, verifiedVoucher: true },
      });
      assert.equal(oblReconciled.status, 'REFUNDED');
      assert.equal(oblReconciled.payoutAttempts.length, 1, 'Must keep single fixed-reference attempt across timeout recovery');
      assert.equal(oblReconciled.verifiedVoucher?.payoutReference, wonAttempt.payoutReference);

      // C. Pre-dispatch rejection unlocks obligation cleanly for next retry with new attempt
      const ordPre = await mkOrder({ orderStatus: 'PENDING' });
      const ptPre = await mkTx(ordPre.orderId);
      await sendSignedWebhook(ptPre, { reference: `FT_PRE_${prefix}` });
      await ordersRepo.cancelOrderAtomicTx(ordPre.orderId, 'Pre-dispatch retry');
      const [oblPre] = await refundsRepo.findObligationsForOrder(ordPre.orderId);

      nextCreateBehavior = async () => {
        throw new PayOSPayoutPreDispatchException('INVALID_BENEFICIARY', 'Beneficiary rejected before dispatch');
      };
      await assert.rejects(
        () => refundsService.initiateObligationPayout(oblPre.obligationId, {}, { userId: superAdminUserId, role: 'SUPER_ADMIN' }),
        BadRequestException,
      );
      const oblPreAfterReject = await prisma.paymentRefundObligation.findUniqueOrThrow({ where: { obligationId: oblPre.obligationId } });
      assert.equal(oblPreAfterReject.status, 'READY_FOR_PAYOUT');
      nextCreateBehavior = defaultCreateBehavior;

      // D. Signed PayoutWebhookController routing + idempotency
      const ordWh = await mkOrder({ orderStatus: 'PENDING' });
      const ptWh = await mkTx(ordWh.orderId);
      await sendSignedWebhook(ptWh, { reference: `FT_WH_OUT_${prefix}` });
      await ordersRepo.cancelOrderAtomicTx(ordWh.orderId, 'Webhook payout settle');
      const [oblWh] = await refundsRepo.findObligationsForOrder(ordWh.orderId);

      const whClaim = await refundsRepo.claimObligationForPayoutTx(oblWh.obligationId, superAdminUserId);
      if (whClaim.outboxEvent?.id) createdOutboxIds.push(whClaim.outboxEvent.id);
      const whPayloadData: any = {
        id: `po_wh_${prefix}`,
        referenceId: whClaim.attempt!.payoutReference,
        amount: 120000,
        approvalState: 'SUCCEEDED',
        transactions: [
          {
            id: `potx_wh_${prefix}`,
            referenceId: whClaim.attempt!.payoutReference,
            amount: 120000,
            toBin: '970422',
            toAccountNumber: matchedAccRaw,
            state: 'SUCCEEDED',
          },
        ],
      };
      const whSig = signPayoutRequest(whPayloadData, process.env.PAYOS_PAYOUT_CHECKSUM_KEY!);
      const whRes1: any = await payoutWebhookController.handlePayoutWebhook({
        code: '00',
        desc: 'Payout success',
        data: whPayloadData,
        signature: whSig,
      } as any);
      assert.equal(whRes1.handled, true);
      // Duplicate signed payout webhook replay must remain idempotent
      const whRes2: any = await payoutWebhookController.handlePayoutWebhook({
        code: '00',
        desc: 'Payout success replay',
        data: whPayloadData,
        signature: whSig,
      } as any);
      assert.equal(whRes2.handled, true);
      const oblWhDone = await prisma.paymentRefundObligation.findUniqueOrThrow({ where: { obligationId: oblWh.obligationId } });
      assert.equal(oblWhDone.status, 'REFUNDED');
    });

    // -------------------------------------------------------------------------
    // T8: Proof-less / Un-receipted Legacy Protection
    // -------------------------------------------------------------------------
    await testCase('T8: Order marked REFUND_PENDING without any verified receipt is rejected cleanly (never flipped blindly)', async () => {
      const legacyOrd = await mkOrder({ orderStatus: 'CANCELLED', paymentStatus: 'REFUND_PENDING' });
      await assert.rejects(
        () =>
          ordersService.refundOrder(
            legacyOrd.orderId,
            {},
            { userId: superAdminUserId, role: 'SUPER_ADMIN' },
          ),
        BadRequestException,
      );
      const legacyAfter = await prisma.order.findUniqueOrThrow({ where: { orderId: legacyOrd.orderId } });
      assert.equal(legacyAfter.paymentStatus, 'REFUND_PENDING', 'Proof-less REFUND_PENDING must NEVER blindly flip to REFUNDED');
    });

    // -------------------------------------------------------------------------
    // T9: Legacy Backfill Requires Provider Proof (Distinguishing Replay vs Same-Amount 2nd Transfer)
    // -------------------------------------------------------------------------
    await testCase('T9: Legacy backfill never merges by amount alone; distinguishes unverified same-amount, proven excess & proven replay', async () => {
      const origGetLinkInfo = paymentsService.getPaymentLinkInformation.bind(paymentsService);

      try {
        // Case A (Critical Guard): Un-reconciled LEGACY_BACKFILL (120k) receives SAME amount (120k) WITHOUT provider proof
        // -> MUST NOT overwrite LEGACY_BACKFILL ref or auto-promote/payout! Keeps inbound as LEGACY_UNCLASSIFIED awaiting reconciliation.
        const legOrdNoProof = await mkOrder({ orderStatus: 'CONFIRMED', paymentStatus: 'PAID' });
        const legPtNoProof = await mkTx(legOrdNoProof.orderId, { status: 'PAID' });
        const legacyRefOrig = `LEGACY_PT_${legPtNoProof.paymentTransactionId}`;
        await prisma.paymentOrderReceipt.create({
          data: {
            orderId: legOrdNoProof.orderId,
            paymentTransactionId: legPtNoProof.paymentTransactionId,
            provider: 'PAYOS',
            channel: 'LEGACY_BACKFILL',
            providerTransactionRef: legacyRefOrig,
            paymentLinkId: legPtNoProof.paymentLinkId,
            amount: 120000,
            currency: 'VND',
            classification: 'ORDER_PAYMENT',
            sourceEvidenceStatus: 'MISSING',
          },
        });

        const sameAmtNewRef = `FT_LEG_SAMENO_${prefix}`;
        const beforeNoProofPayouts = createPayoutCallCount;
        (paymentsService as any).getPaymentLinkInformation = async () => ({
          code: '00',
          data: { id: legPtNoProof.paymentLinkId, orderCode: Number(legPtNoProof.transactionCode), transactions: [] },
        });
        await sendSignedWebhook(legPtNoProof, { reference: sameAmtNewRef, amount: 120000 });

        const recsNoProof = await prisma.paymentOrderReceipt.findMany({
          where: { orderId: legOrdNoProof.orderId },
          orderBy: { receiptId: 'asc' },
        });
        assert.equal(recsNoProof.length, 2, 'Without provider proof, inbound same-amount webhook must be kept separately awaiting reconciliation');
        assert.equal(recsNoProof[0].channel, 'LEGACY_BACKFILL', 'LEGACY_BACKFILL placeholder must NOT be overwritten by amount match alone');
        assert.equal(recsNoProof[0].providerTransactionRef, legacyRefOrig);
        assert.equal(recsNoProof[0].sourceEvidenceStatus, 'MISSING', 'Legacy placeholder source MUST remain unverified MISSING');
        assert.equal(recsNoProof[1].classification, 'LEGACY_UNCLASSIFIED', 'Unproven inbound receipt must sit in LEGACY_UNCLASSIFIED');
        assert.equal(recsNoProof[1].providerTransactionRef, sameAmtNewRef);
        assert.equal((await refundsRepo.findObligationsForOrder(legOrdNoProof.orderId)).length, 0, 'Must NOT spawn auto-payout obligation before reconciliation');
        assert.equal(createPayoutCallCount, beforeNoProofPayouts);

        // Even if order is cancelled before reconciliation, manual verification gate stays enforced (zero auto-payout)
        await ordersRepo.cancelOrderAtomicTx(legOrdNoProof.orderId, 'Cancel while unverified');
        await assert.rejects(
          () => ordersService.refundOrder(legOrdNoProof.orderId, {}, { userId: superAdminUserId, role: 'SUPER_ADMIN' }),
          BadRequestException,
        );
        const oblsAfterCancelNoProof = await refundsRepo.findObligationsForOrder(legOrdNoProof.orderId);
        assert.equal(oblsAfterCancelNoProof.length, 1);
        assert.equal(oblsAfterCancelNoProof[0].status, 'PENDING_RECIPIENT_VERIFICATION');
        assert.equal(oblsAfterCancelNoProof[0].recipientVerificationStatus, 'SOURCE_INSUFFICIENT');
        assert.equal(createPayoutCallCount, beforeNoProofPayouts);

        // Case B (Opposite Direction with Provider Proof of 2nd Transfer of EXACT same 120k):
        // Customer genuinely transferred another 120k while original LEGACY_BACKFILL ref was un-reconciled -> creates EXCESS_DUPLICATE without overwriting LEGACY_BACKFILL!
        const legOrdExcSame = await mkOrder({ orderStatus: 'CONFIRMED', paymentStatus: 'PAID' });
        const legPtExcSame = await mkTx(legOrdExcSame.orderId, { status: 'PAID' });
        await prisma.paymentOrderReceipt.create({
          data: {
            orderId: legOrdExcSame.orderId,
            paymentTransactionId: legPtExcSame.paymentTransactionId,
            provider: 'PAYOS',
            channel: 'LEGACY_BACKFILL',
            providerTransactionRef: `LEGACY_PT_${legPtExcSame.paymentTransactionId}`,
            paymentLinkId: legPtExcSame.paymentLinkId,
            amount: 120000,
            currency: 'VND',
            classification: 'ORDER_PAYMENT',
            sourceEvidenceStatus: 'MISSING',
          },
        });
        const realSecondSameAmtRef = `FT_LEG_2ND_120K_${prefix}`;
        (paymentsService as any).getPaymentLinkInformation = async () => ({
          code: '00',
          data: {
            id: legPtExcSame.paymentLinkId,
            orderCode: Number(legPtExcSame.transactionCode),
            amount: 120000,
            amountPaid: 240000,
            status: 'PAID',
            transactions: [
              { reference: `FT_ORIG_UNKNOWN_${prefix}`, amount: 120000 },
              { reference: realSecondSameAmtRef, amount: 120000 },
            ],
          },
        });
        await sendSignedWebhook(legPtExcSame, { reference: realSecondSameAmtRef, amount: 120000 });
        const recsExcSame = await prisma.paymentOrderReceipt.findMany({
          where: { orderId: legOrdExcSame.orderId },
          orderBy: { receiptId: 'asc' },
        });
        assert.equal(recsExcSame.length, 2);
        assert.equal(recsExcSame[0].channel, 'LEGACY_BACKFILL');
        assert.equal(recsExcSame[1].classification, 'EXCESS_DUPLICATE');
        const oblsExcSame = await refundsRepo.findObligationsForOrder(legOrdExcSame.orderId);
        assert.equal(oblsExcSame.length, 1);
        assert.equal(oblsExcSame[0].obligationType, 'EXCESS_DUPLICATE');
        assert.equal(oblsExcSame[0].status, 'READY_FOR_PAYOUT');
        const excessSameSettled = await paymentsService.refundExcessTransaction(
          legPtExcSame.paymentTransactionId.toString(),
          {},
          { userId: superAdminUserId, role: 'SUPER_ADMIN' },
        );
        assert.equal(excessSameSettled.settled, true);
        const ordExcSameAfter = await prisma.order.findUniqueOrThrow({ where: { orderId: legOrdExcSame.orderId } });
        assert.equal(ordExcSameAfter.paymentStatus, 'PAID', 'Refunding confirmed 2nd 120k transfer preserves PAID primary order');

        // Case C (Proven Replay via Provider Lookup): first arrive UNVERIFIED -> parked LEGACY_UNCLASSIFIED;
        // then retry arrives with PayOS lookup proving single 120k transfer -> merges cleanly into 1 receipt & refunds main once!
        const legOrdA = await mkOrder({ orderStatus: 'CONFIRMED', paymentStatus: 'PAID' });
        const legPtA = await mkTx(legOrdA.orderId, { status: 'PAID' });
        await prisma.paymentOrderReceipt.create({
          data: {
            orderId: legOrdA.orderId,
            paymentTransactionId: legPtA.paymentTransactionId,
            provider: 'PAYOS',
            channel: 'LEGACY_BACKFILL',
            providerTransactionRef: `LEGACY_PT_${legPtA.paymentTransactionId}`,
            paymentLinkId: legPtA.paymentLinkId,
            amount: 120000,
            currency: 'VND',
            classification: 'ORDER_PAYMENT',
            sourceEvidenceStatus: 'MISSING',
          },
        });
        const realRefA = `FT_LEG_FWD_${prefix}`;
        (paymentsService as any).getPaymentLinkInformation = async () => ({
          code: '00',
          data: { id: legPtA.paymentLinkId, orderCode: Number(legPtA.transactionCode), transactions: [] },
        });
        await sendSignedWebhook(legPtA, { reference: realRefA });
        assert.equal(
          (await prisma.paymentOrderReceipt.findMany({ where: { orderId: legOrdA.orderId } })).length,
          2,
        );

        (paymentsService as any).getPaymentLinkInformation = async () => ({
          code: '00',
          data: {
            id: legPtA.paymentLinkId,
            orderCode: Number(legPtA.transactionCode),
            amount: 120000,
            amountPaid: 120000,
            status: 'PAID',
            transactions: [{ reference: realRefA, amount: 120000 }],
          },
        });
        await sendSignedWebhook(legPtA, { reference: realRefA });

        const recsAfterReplay = await prisma.paymentOrderReceipt.findMany({
          where: { orderId: legOrdA.orderId },
        });
        assert.equal(recsAfterReplay.length, 1, 'Proven single historical replay must merge cleanly into 1 receipt');
        assert.equal(recsAfterReplay[0].channel, 'ORDER_PAYMENT_LINK');
        assert.equal(recsAfterReplay[0].providerTransactionRef, realRefA);
        assert.equal(recsAfterReplay[0].sourceEvidenceStatus, 'SUFFICIENT');
        assert.equal((await refundsRepo.findObligationsForOrder(legOrdA.orderId)).length, 0);

        await ordersRepo.cancelOrderAtomicTx(legOrdA.orderId, 'Cancel after proven legacy replay');
        const refundMainA = await ordersService.refundOrder(
          legOrdA.orderId,
          {},
          { userId: superAdminUserId, role: 'SUPER_ADMIN' },
        );
        assert.equal(refundMainA.paymentStatus, 'REFUNDED');
        const oblsA = await refundsRepo.findObligationsForOrder(legOrdA.orderId);
        assert.equal(oblsA.length, 1);
        assert.equal(oblsA[0].obligationType, 'ORDER_REFUND');
        assert.equal(oblsA[0].status, 'REFUNDED');

        // Case D: Cancelled legacy REFUND_PENDING with existing ORDER_REFUND obligation + proven replay -> keeps quarantine -> genuine 2nd transfer works;
        // plus mismatched amount without provider proof stays LEGACY_UNCLASSIFIED (zero auto-payout).
        const legOrdB = await mkOrder({ orderStatus: 'CANCELLED', paymentStatus: 'REFUND_PENDING' });
        const legPtB = await mkTx(legOrdB.orderId, { status: 'PAID' });
        const legRecB = await prisma.paymentOrderReceipt.create({
          data: {
            orderId: legOrdB.orderId,
            paymentTransactionId: legPtB.paymentTransactionId,
            provider: 'PAYOS',
            channel: 'LEGACY_BACKFILL',
            providerTransactionRef: `LEGACY_PT_${legPtB.paymentTransactionId}`,
            paymentLinkId: legPtB.paymentLinkId,
            amount: 120000,
            currency: 'VND',
            classification: 'ORDER_PAYMENT',
            sourceEvidenceStatus: 'MISSING',
          },
        });
        await prisma.paymentRefundObligation.create({
          data: {
            orderId: legOrdB.orderId,
            sourcePaymentTransactionId: legPtB.paymentTransactionId,
            receiptId: legRecB.receiptId,
            obligationType: 'ORDER_REFUND',
            refundAmount: 120000,
            currency: 'VND',
            status: 'PENDING_RECIPIENT_VERIFICATION',
            recipientVerificationStatus: 'LEGACY_UNCLASSIFIED',
            verificationNote: 'Backfilled unverified legacy obligation',
          },
        });
        const revRef1 = `FT_LEG_REV_1_${prefix}`;
        (paymentsService as any).getPaymentLinkInformation = async () => ({
          code: '00',
          data: {
            id: legPtB.paymentLinkId,
            orderCode: Number(legPtB.transactionCode),
            amount: 120000,
            amountPaid: 120000,
            status: 'PAID',
            transactions: [{ reference: revRef1, amount: 120000 }],
          },
        });
        await sendSignedWebhook(legPtB, { reference: revRef1 });
        const oblsBAfterReplay = await refundsRepo.findObligationsForOrder(legOrdB.orderId);
        assert.equal(oblsBAfterReplay.length, 1);
        assert.equal(oblsBAfterReplay[0].status, 'PENDING_RECIPIENT_VERIFICATION');

        await sendSignedWebhook(legPtB, { reference: `FT_LEG_REV_2_${prefix}`, amount: 45000 });
        const oblsBAfterExtra = await refundsRepo.findObligationsForOrder(legOrdB.orderId);
        assert.equal(oblsBAfterExtra.length, 2);
        assert.equal(oblsBAfterExtra[1].obligationType, 'EXCESS_DUPLICATE');

        const legOrdQ = await mkOrder({ orderStatus: 'CONFIRMED', paymentStatus: 'PAID' });
        const legPtQ = await mkTx(legOrdQ.orderId, { status: 'PAID' });
        await prisma.paymentOrderReceipt.create({
          data: {
            orderId: legOrdQ.orderId,
            paymentTransactionId: legPtQ.paymentTransactionId,
            provider: 'PAYOS',
            channel: 'LEGACY_BACKFILL',
            providerTransactionRef: `LEGACY_PT_${legPtQ.paymentTransactionId}`,
            paymentLinkId: legPtQ.paymentLinkId,
            amount: 120000,
            currency: 'VND',
            classification: 'ORDER_PAYMENT',
            sourceEvidenceStatus: 'MISSING',
          },
        });
        (paymentsService as any).getPaymentLinkInformation = async () => {
          throw new Error('Simulated PayOS lookup error');
        };
        await sendSignedWebhook(legPtQ, { reference: `FT_LEG_Q_${prefix}`, amount: 30000 });
        const recsQ = await prisma.paymentOrderReceipt.findMany({
          where: { orderId: legOrdQ.orderId },
          orderBy: { receiptId: 'asc' },
        });
        assert.equal(recsQ.length, 2);
        assert.equal(recsQ[0].channel, 'LEGACY_BACKFILL');
        assert.equal(recsQ[1].classification, 'LEGACY_UNCLASSIFIED');
        assert.equal((await refundsRepo.findObligationsForOrder(legOrdQ.orderId)).length, 0);
      } finally {
        (paymentsService as any).getPaymentLinkInformation = origGetLinkInfo;
      }
    });

    // -------------------------------------------------------------------------
    // T10: Concurrent Extra Webhook vs Main Webhook Under Lock
    // -------------------------------------------------------------------------
    await testCase('T10: Concurrent extra webhook reading stale PENDING pre-lock still records EXCESS_DUPLICATE once main commits PAID', async () => {
      const ordConc = await mkOrder({ orderStatus: 'PENDING' });
      const ptConc = await mkTx(ordConc.orderId);

      const origFind = paymentsRepo.findTransactionByCode.bind(paymentsRepo);
      let releaseBarrier!: () => void;
      let notifyPaused!: () => void;
      const barrier = new Promise<void>((r) => {
        releaseBarrier = r;
      });
      const paused = new Promise<void>((r) => {
        notifyPaused = r;
      });
      let intercepts = 0;
      (paymentsRepo as any).findTransactionByCode = async (code: string) => {
        const res = await origFind(code);
        if (++intercepts === 1) {
          notifyPaused();
          await barrier;
        }
        return res;
      };

      const extraRef = `FT_CONC_EXC_${prefix}`;
      const extraPromise = sendSignedWebhook(ptConc, { reference: extraRef, amount: 35000 });
      try {
        await paused;
        await sendSignedWebhook(ptConc, { reference: `FT_CONC_MAIN_${prefix}` });
      } finally {
        releaseBarrier();
      }
      try {
        await extraPromise;
      } finally {
        (paymentsRepo as any).findTransactionByCode = origFind;
      }

      const recs = await prisma.paymentOrderReceipt.findMany({
        where: { orderId: ordConc.orderId },
        orderBy: { receiptId: 'asc' },
      });
      assert.equal(recs.length, 2, 'Both primary and concurrent excess receipts must be persisted');
      assert.equal(recs[0].classification, 'ORDER_PAYMENT');
      assert.equal(recs[1].classification, 'EXCESS_DUPLICATE');
      assert.equal(recs[1].providerTransactionRef, extraRef);
      const ordConcAfter = await prisma.order.findUniqueOrThrow({ where: { orderId: ordConc.orderId } });
      assert.equal(ordConcAfter.paymentStatus, 'PAID');
    });

    // -------------------------------------------------------------------------
    // T11: Pre-POST Preflight GET Failure Keeps PREPARING & Recovers via Worker
    // -------------------------------------------------------------------------
    await testCase('T11: Transient GET failure before POST leaves PREPARING attempt retryable and settles via worker batch', async () => {
      const ordPreGet = await mkOrder({ orderStatus: 'PENDING' });
      const ptPreGet = await mkTx(ordPreGet.orderId);
      await sendSignedWebhook(ptPreGet, { reference: `FT_PREGET_${prefix}` });
      await ordersRepo.cancelOrderAtomicTx(ordPreGet.orderId, 'Pre-POST GET error recovery');
      const [oblPreGet] = await refundsRepo.findObligationsForOrder(ordPreGet.orderId);

      const claimPreGet = await refundsRepo.claimObligationForPayoutTx(oblPreGet.obligationId, superAdminUserId);
      if (claimPreGet.outboxEvent?.id) createdOutboxIds.push(claimPreGet.outboxEvent.id);

      const beforeCalls = createPayoutCallCount;
      getPayoutsOverride = async () => {
        throw new Error('Simulated transient PayOS GET timeout before POST');
      };
      const firstTry = await refundsService.dispatchClaimedAttempt(
        oblPreGet.obligationId,
        claimPreGet.attempt!.attemptId,
      );
      getPayoutsOverride = null;

      assert.equal(firstTry.action, 'PREFLIGHT_RETRY_PENDING');
      assert.equal(createPayoutCallCount, beforeCalls, 'POST must not run when preflight GET is indeterminate');
      const attMid = await prisma.paymentRefundPayoutAttempt.findUniqueOrThrow({
        where: { attemptId: claimPreGet.attempt!.attemptId },
      });
      assert.equal(attMid.status, 'PREPARING', 'Unsent attempt must remain PREPARING (never PENDING_RECONCILIATION)');
      assert.equal(attMid.dispatchedAt, null);
      assert.equal(attMid.reconcileAttempts, 1);

      // Worker reconcile batch recovers the retryable PREPARING attempt automatically and calls POST once!
      const batchRes = await refundWorker.reconcilePendingAttemptsBatch(20);
      assert.ok(batchRes.total >= 1);
      assert.equal(createPayoutCallCount, beforeCalls + 1, 'Worker must recover and execute single POST');

      const oblPreGetDone = await prisma.paymentRefundObligation.findUniqueOrThrow({
        where: { obligationId: oblPreGet.obligationId },
        include: { payoutAttempts: true },
      });
      assert.equal(oblPreGetDone.status, 'REFUNDED');
      assert.equal(oblPreGetDone.payoutAttempts.length, 1);
    });

    // -------------------------------------------------------------------------
    // T12: Post-Claim Source Conflict (Pre-POST vs Post-POST)
    // -------------------------------------------------------------------------
    await testCase('T12: Contradictory source blocks pre-POST dispatch without mutating snapshot, while post-POST preserves reconciliation', async () => {
      // Case A: Replay conflict after claim, before dispatchClaimedAttempt
      const ordCfA = await mkOrder({ orderStatus: 'PENDING' });
      const ptCfA = await mkTx(ordCfA.orderId);
      await sendSignedWebhook(ptCfA, { reference: `FT_CFA_MAIN_${prefix}` });
      const extraCfARef = `FT_CFA_EXC_${prefix}`;
      await sendSignedWebhook(ptCfA, { reference: extraCfARef, amount: 30000 });
      const [oblCfA] = await refundsRepo.findObligationsForOrder(ordCfA.orderId);
      const claimCfA = await refundsRepo.claimObligationForPayoutTx(oblCfA.obligationId, superAdminUserId);
      if (claimCfA.outboxEvent?.id) createdOutboxIds.push(claimCfA.outboxEvent.id);

      await sendSignedWebhook(ptCfA, {
        reference: extraCfARef,
        amount: 30000,
        counterAccountNumber: `999${matchedAccRaw.slice(3)}`,
      });
      const beforeA = createPayoutCallCount;
      await refundsService.dispatchClaimedAttempt(oblCfA.obligationId, claimCfA.attempt!.attemptId);
      assert.equal(createPayoutCallCount, beforeA, 'Conflict before POST must block createPayout');
      const oblCfAAfter = await prisma.paymentRefundObligation.findUniqueOrThrow({
        where: { obligationId: oblCfA.obligationId },
        include: { payoutAttempts: true },
      });
      assert.equal(oblCfAAfter.status, 'PENDING_RECIPIENT_VERIFICATION');
      assert.equal(oblCfAAfter.payoutAttempts[0].status, 'FAILED');

      // Case B: Direct DB receipt conflict during preflight window caught atomically inside authorizeAttemptPreflightTx
      const ordCfB = await mkOrder({ orderStatus: 'PENDING' });
      const ptCfB = await mkTx(ordCfB.orderId);
      await sendSignedWebhook(ptCfB, { reference: `FT_CFB_MAIN_${prefix}` });
      await ordersRepo.cancelOrderAtomicTx(ordCfB.orderId, 'Preflight conflict test');
      const [oblCfB] = await refundsRepo.findObligationsForOrder(ordCfB.orderId);
      const claimCfB = await refundsRepo.claimObligationForPayoutTx(oblCfB.obligationId, superAdminUserId);
      if (claimCfB.outboxEvent?.id) createdOutboxIds.push(claimCfB.outboxEvent.id);

      await prisma.paymentOrderReceipt.update({
        where: { receiptId: oblCfB.receiptId },
        data: { sourceEvidenceStatus: 'CONFLICTING' },
      });
      const beforeB = createPayoutCallCount;
      const resB = await refundsService.dispatchClaimedAttempt(oblCfB.obligationId, claimCfB.attempt!.attemptId);
      assert.equal(resB.action, 'BLOCKED_SOURCE_CONFLICT');
      assert.equal(createPayoutCallCount, beforeB);
      const oblCfBAfter = await prisma.paymentRefundObligation.findUniqueOrThrow({
        where: { obligationId: oblCfB.obligationId },
        include: { payoutAttempts: true },
      });
      assert.equal(oblCfBAfter.status, 'PENDING_RECIPIENT_VERIFICATION');
      assert.equal(oblCfBAfter.payoutAttempts[0].status, 'FAILED');

      // Case C: Indeterminate POST followed by conflicting webhook replay MUST keep PENDING_RECONCILIATION
      const ordCfC = await mkOrder({ orderStatus: 'PENDING' });
      const ptCfC = await mkTx(ordCfC.orderId);
      const mainCfCRef = `FT_CFC_MAIN_${prefix}`;
      await sendSignedWebhook(ptCfC, { reference: mainCfCRef });
      await ordersRepo.cancelOrderAtomicTx(ordCfC.orderId, 'Post-POST conflict preserves reconciliation');
      const [oblCfC] = await refundsRepo.findObligationsForOrder(ordCfC.orderId);
      const claimCfC = await refundsRepo.claimObligationForPayoutTx(oblCfC.obligationId, superAdminUserId);
      if (claimCfC.outboxEvent?.id) createdOutboxIds.push(claimCfC.outboxEvent.id);

      nextCreateBehavior = async (req) => {
        await defaultCreateBehavior(req);
        throw new PayOSPayoutIndeterminateException('NETWORK_TIMEOUT', 'Indeterminate after HTTP send');
      };
      await refundsService.dispatchClaimedAttempt(oblCfC.obligationId, claimCfC.attempt!.attemptId);
      nextCreateBehavior = defaultCreateBehavior;

      // Conflicting replay arrives WHILE attempt is already PENDING_RECONCILIATION (post-POST)
      await sendSignedWebhook(ptCfC, {
        reference: mainCfCRef,
        counterAccountNumber: `888${matchedAccRaw.slice(3)}`,
      });
      const oblCfCMid = await prisma.paymentRefundObligation.findUniqueOrThrow({
        where: { obligationId: oblCfC.obligationId },
        include: { payoutAttempts: true },
      });
      assert.equal(oblCfCMid.status, 'PENDING_RECONCILIATION');
      assert.equal(oblCfCMid.payoutAttempts[0].status, 'PENDING_RECONCILIATION');

      // Worker still reconciles the already-sent payout cleanly
      await prisma.paymentRefundPayoutAttempt.update({
        where: { attemptId: claimCfC.attempt!.attemptId },
        data: { nextReconcileAt: new Date(Date.now() - 1000) },
      });
      await refundWorker.reconcilePendingAttemptsBatch(20);
      const oblCfCDone = await prisma.paymentRefundObligation.findUniqueOrThrow({
        where: { obligationId: oblCfC.obligationId },
      });
      assert.equal(oblCfCDone.status, 'REFUNDED');
    });
  } finally {
    if (prevChecksum === undefined) delete process.env.PAYOS_CHECKSUM_KEY;
    else process.env.PAYOS_CHECKSUM_KEY = prevChecksum;
    if (prevPayoutChecksum === undefined) delete process.env.PAYOS_PAYOUT_CHECKSUM_KEY;
    else process.env.PAYOS_PAYOUT_CHECKSUM_KEY = prevPayoutChecksum;
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;

    try {
      if (createdOrderIds.length > 0) {
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
      if (createdOutboxIds.length > 0) {
        await prisma.outboxEvent.deleteMany({ where: { id: { in: createdOutboxIds } } });
      }
        for (const oid of createdOrderIds) {
          await prisma.$executeRawUnsafe(
            `DELETE FROM outbox_events WHERE event_type = 'PAYMENT_REFUND_PAYOUT' AND payload->>'orderId' = $1`,
            oid.toString(),
          ).catch(() => {});
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
    } catch (cleanErr: any) {
      console.warn('Cleanup warning:', cleanErr?.message);
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
}

runSuite();
