import 'dotenv/config';
import assert from 'node:assert';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { getSafeTestPrismaService } from './test-db-guard';
import { StoreWalletService } from '../src/store-wallet/store-wallet.service';
import { StoreWalletRepository } from '../src/store-wallet/store-wallet.repository';
import { OrdersRepository } from '../src/orders/orders.repository';
import { OrdersService } from '../src/orders/orders.service';
import { ProductsRepository } from '../src/products/products.repository';
import { StoreSubscriptionsRepository } from '../src/store-subscriptions/store-subscriptions.repository';
import { StoreSubscriptionsService } from '../src/store-subscriptions/store-subscriptions.service';
import { PaymentsRepository } from '../src/payments/payments.repository';
import { PaymentsService } from '../src/payments/payments.service';
import { signWebhookData } from '../src/payments/payos.helper';
import { CryptoVaultUtil } from '../src/common/utils/crypto-vault.util';

const SUITE_NAME = 'Suite 86: ACID Wallet, Order, Inventory, Trial & Payment Concurrency Hardening';

async function run() {
  console.log(`\n🧪 Running ${SUITE_NAME}...\n`);
  const prisma = getSafeTestPrismaService(SUITE_NAME);
  await prisma.$connect();

  const walletRepo = new StoreWalletRepository(prisma);
  const walletService = new StoreWalletService(prisma, undefined, walletRepo);
  const ordersRepo = new OrdersRepository(prisma);
  const productsRepo = new ProductsRepository(prisma);
  const subsRepo = new StoreSubscriptionsRepository(prisma);
  const subsService = new StoreSubscriptionsService(subsRepo, walletService);
  const paymentsRepo = new PaymentsRepository(prisma);
  const paymentsService = new PaymentsService(paymentsRepo);

  const ts = `${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  const cleanupStoreIds: bigint[] = [];
  const cleanupUserIds: bigint[] = [];
  const cleanupPlanIds: bigint[] = [];
  let passed = 0;

  try {
    // Seed owner user + 2 stores (to verify cross-store trial abuse + wallet/order isolation)
    const ownerUser = await prisma.user.create({
      data: {
        username: `acid_owner_${ts}`,
        email: `acid_owner_${ts}@example.com`,
        passwordHash: 'hashed_pw',
        fullName: 'ACID Test Owner',
        phone: `099${String(Date.now()).slice(-7)}`,
        status: 'ACTIVE',
      },
    });
    cleanupUserIds.push(ownerUser.userId);

    const storeA = await prisma.store.create({
      data: {
        name: `ACID Store A ${ts}`,
        code: `ACIDA_${ts}`,
        phone: '0900001111',
        address: '100 ACID Street',
        ownerUserId: ownerUser.userId,
        status: 'ACTIVE',
      },
    });
    cleanupStoreIds.push(storeA.storeId);

    const storeB = await prisma.store.create({
      data: {
        name: `ACID Store B ${ts}`,
        code: `ACIDB_${ts}`,
        phone: '0900002222',
        address: '200 ACID Street',
        ownerUserId: ownerUser.userId,
        status: 'ACTIVE',
      },
    });
    cleanupStoreIds.push(storeB.storeId);

    // =====================================================================
    // 1. Concurrent creditOrderRevenue + requestWithdrawal (Zero Lost Update)
    // =====================================================================
    {
      const wallet = await walletService.getOrCreateStoreWallet(storeA.storeId);
      await prisma.storeWallet.update({
        where: { walletId: wallet.walletId },
        data: { balance: 1000000, frozenBalance: 0 },
      });

      const plainAcc = '123456789012';
      const bankAcc = await prisma.storeBankAccount.create({
        data: {
          storeId: storeA.storeId,
          bankBin: '970422',
          bankCode: 'MB',
          bankName: 'MBBank',
          accountNumberEncrypted: CryptoVaultUtil.encryptAccountNumber(plainAcc),
          accountNumberHash: CryptoVaultUtil.hashAccountNumber(plainAcc),
          accountName: 'ACID TEST OWNER',
          verificationStatus: 'OWNERSHIP_VERIFIED',
          isDefault: true,
          verifiedAt: new Date(),
          lastVerifiedAt: new Date(),
        },
      });

      await Promise.all([
        walletService.creditOrderRevenue(storeA.storeId, 250000, `ORD-ACID-1-${ts}`),
        walletService.creditOrderRevenue(storeA.storeId, 250000, `ORD-ACID-1-${ts}`), // duplicate orderCode
        walletService.creditOrderRevenue(storeA.storeId, 150000, `ORD-ACID-2-${ts}`),
        walletService.requestWithdrawal(storeA.storeId, {
          amount: 400000,
          bankAccountId: bankAcc.id.toString(),
        } as any),
      ]);

      const finalWallet = await prisma.storeWallet.findUnique({ where: { walletId: wallet.walletId } });
      assert.strictEqual(
        Number(finalWallet?.balance),
        1000000, // 1,000,000 + 250,000 + 150,000 - 400,000
        `Expected final balance 1000000 (zero lost updates / double credit), got ${finalWallet?.balance}`,
      );
      assert.strictEqual(Number(finalWallet?.frozenBalance), 400000);

      const ledgerTxs = await prisma.walletTransaction.findMany({
        where: { walletId: wallet.walletId },
        orderBy: { transactionId: 'asc' },
      });
      assert.strictEqual(ledgerTxs.length, 3, `Expected exactly 3 ledger rows (2 credits + 1 debit), got ${ledgerTxs.length}`);

      passed++;
      console.log('  ✔ [PASS] Group 1: Concurrent creditOrderRevenue + duplicate orderCode + requestWithdrawal has zero lost updates');
    }

    // =====================================================================
    // 2. Concurrent createStorefrontOrderTx vs updateProductAtomicTx (Stock & Reserved Bound)
    // =====================================================================
    {
      const product = await prisma.product.create({
        data: {
          storeId: storeA.storeId,
          productName: `ACID Rice Bag ${ts}`,
          productCode: `PRD-ACID-${ts.slice(-6)}`,
          basePrice: 50000,
          status: 'ACTIVE',
        },
      });
      await prisma.inventory.create({
        data: {
          storeId: storeA.storeId,
          productId: product.productId,
          quantityOnHand: 5,
          reservedQuantity: 0,
        },
      });

      const results = await Promise.allSettled([
        ordersRepo.createStorefrontOrderTx({
          storeId: storeA.storeId,
          items: [{ productId: product.productId.toString(), quantity: 3 }],
          customerName: 'Guest 1',
          customerPhone: '0901111111',
          deliveryAddress: 'Addr 1',
          paymentMethod: 'COD',
        }),
        ordersRepo.createStorefrontOrderTx({
          storeId: storeA.storeId,
          items: [{ productId: product.productId.toString(), quantity: 3 }],
          customerName: 'Guest 2',
          customerPhone: '0902222222',
          deliveryAddress: 'Addr 2',
          paymentMethod: 'COD',
        }),
        productsRepo.updateProductAtomicTx({
          productId: product.productId,
          storeId: storeA.storeId,
          data: { productName: `ACID Rice Bag Updated ${ts}` },
          stock: 2,
        }),
      ]);

      // Rejections must ONLY be explicit business BadRequestExceptions (never unhandled crashes/deadlocks/constraint escapes)
      for (const [idx, r] of results.entries()) {
        if (r.status === 'rejected') {
          assert.ok(
            r.reason instanceof BadRequestException,
            `Operation #${idx} rejected with unexpected non-business error: ${r.reason?.message || r.reason}`,
          );
        }
      }

      const orderSuccessCount = [results[0], results[1]].filter((r) => r.status === 'fulfilled').length;
      const fulfilledCount = results.filter((r) => r.status === 'fulfilled').length;
      assert.strictEqual(
        fulfilledCount,
        1,
        `Exactly one conflicting writer (1 order OR the stock=2 update) should succeed cleanly, got fulfilled=${fulfilledCount}`,
      );
      assert.ok(orderSuccessCount <= 1, `Cannot oversell 5 units across two 3-unit orders (got ${orderSuccessCount})`);

      const invAfter = await prisma.inventory.findUnique({ where: { productId: product.productId } });
      assert.ok(invAfter, 'Inventory must exist');
      assert.ok(
        invAfter.quantityOnHand >= invAfter.reservedQuantity && invAfter.reservedQuantity >= 0,
        `Inventory invariant broken: onHand=${invAfter.quantityOnHand}, reserved=${invAfter.reservedQuantity}`,
      );

      if (orderSuccessCount === 1) {
        assert.strictEqual(invAfter.quantityOnHand, 5);
        assert.strictEqual(invAfter.reservedQuantity, 3);
        assert.strictEqual(results[2].status, 'rejected', 'Stock reduction to 2 must fail while 3 units reserved');
      } else {
        assert.strictEqual(results[2].status, 'fulfilled', 'If both 3-unit orders failed, stock=2 update must have succeeded first');
        assert.strictEqual(invAfter.quantityOnHand, 2);
        assert.strictEqual(invAfter.reservedQuantity, 0);
      }

      // Direct DB CHECK constraint enforcement test
      await assert.rejects(
        () =>
          prisma.$executeRawUnsafe(
            `UPDATE inventory SET reserved_quantity = quantity_on_hand + 1 WHERE product_id = $1`,
            product.productId,
          ),
        (err: any) =>
          String(err?.code || '').includes('23514') ||
          String(err?.meta?.code || '').includes('23514') ||
          String(err?.message || '').includes('chk_inventory_non_negative_and_reserved_bound'),
      );

      passed++;
      console.log('  ✔ [PASS] Group 2: Concurrent Storefront Orders vs Stock Edit + DB CHECK constraint strictly prevent negative availability');
    }

    // =====================================================================
    // 3. releaseReservedInventory & deductInventoryOnCompleted Transactional Consistency
    // =====================================================================
    {
      const prod2 = await prisma.product.create({
        data: {
          storeId: storeA.storeId,
          productName: `ACID Water ${ts}`,
          productCode: `PRD-W2-${ts.slice(-6)}`,
          basePrice: 25000,
          status: 'ACTIVE',
        },
      });
      await prisma.inventory.create({
        data: {
          storeId: storeA.storeId,
          productId: prod2.productId,
          quantityOnHand: 2,
          reservedQuantity: 1,
        },
      });

      // Deducting 5 when quantityOnHand is 2 must throw BadRequestException atomically (0 changes)
      await assert.rejects(
        () => ordersRepo.deductInventoryOnCompleted([{ productId: prod2.productId, quantity: 5 }]),
        (err: any) => err instanceof BadRequestException,
      );
      const invAfterFailedDeduct = await prisma.inventory.findUnique({ where: { productId: prod2.productId } });
      assert.strictEqual(invAfterFailedDeduct?.quantityOnHand, 2);
      assert.strictEqual(invAfterFailedDeduct?.reservedQuantity, 1);

      // Releasing 5 reserved when only 1 reserved clamps safely to 0 without violating CHECK constraint
      await ordersRepo.releaseReservedInventory([{ productId: prod2.productId, quantity: 5 }]);
      const invAfterRelease = await prisma.inventory.findUnique({ where: { productId: prod2.productId } });
      assert.strictEqual(invAfterRelease?.reservedQuantity, 0);

      passed++;
      console.log('  ✔ [PASS] Group 3: releaseReservedInventory & deductInventoryOnCompleted enforce atomic FOR UPDATE & bounds');
    }

    // =====================================================================
    // 4. Cross-Store Concurrent Trial Subscription Abuse Blocked in TX
    // =====================================================================
    {
      let trialPlan = await prisma.subscriptionPlan.findFirst({
        where: { isActive: true, price: 0 },
      });
      if (!trialPlan) {
        trialPlan = await prisma.subscriptionPlan.create({
          data: {
            planCode: `TRIAL_ACID_${ts}`,
            planName: 'Goi Dung Thu 7 Ngay ACID',
            price: 0,
            durationDays: 7,
            isActive: true,
          },
        });
        cleanupPlanIds.push(trialPlan.planId);
      }

      const [resA, resB] = await Promise.allSettled([
        subsService.subscribeWithWallet(storeA.storeId, trialPlan.planId),
        subsService.subscribeWithWallet(storeB.storeId, trialPlan.planId),
      ]);

      const successes = [resA, resB].filter((r) => r.status === 'fulfilled');
      const failures = [resA, resB].filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
      assert.strictEqual(
        successes.length,
        1,
        `Exactly 1 trial subscription should succeed across owner stores concurrently, got ${successes.length}`,
      );
      assert.strictEqual(failures.length, 1);
      assert.ok(
        failures[0].reason instanceof BadRequestException &&
          String(failures[0].reason.message).includes('Mỗi tài khoản chỉ được dùng thử 1 lần duy nhất'),
      );

      passed++;
      console.log('  ✔ [PASS] Group 4: Concurrent multi-store Trial registration serialized per owner inside TX');
    }

    // =====================================================================
    // 5. Payments Lock-First Guard, Concurrency & OrdersService.quickReorder Key Safety
    // =====================================================================
    {
      const prevClientId = process.env.PAYOS_CLIENT_ID;
      const prevApiKey = process.env.PAYOS_API_KEY;
      const prevChecksum = process.env.PAYOS_CHECKSUM_KEY;
      const prevMock = process.env.PAYOS_MOCK_PAYMENT;
      const origFetch = globalThis.fetch;

      process.env.PAYOS_CLIENT_ID = 'acid_test_client';
      process.env.PAYOS_API_KEY = 'acid_test_api_key';
      process.env.PAYOS_CHECKSUM_KEY = 'acid_test_checksum_key';
      process.env.PAYOS_MOCK_PAYMENT = 'false';

      try {
        // 5A: CANCELLED order rejects + changeOrderPaymentMethod on PAID order fails BEFORE PayOS cancel
        const cancelledOrder = await prisma.order.create({
          data: {
            orderCode: `ORD-PAY-LCK-${ts}`,
            storeId: storeA.storeId,
            orderStatus: 'CANCELLED',
            paymentStatus: 'UNPAID',
            paymentMethod: 'PAYOS',
            subtotalAmount: 100000,
            totalAmount: 100000,
            shippingRecipientName: 'Test Buyer',
            shippingPhone: '0900000000',
            shippingAddress: '123 Test',
          },
        });
        await assert.rejects(
          () => paymentsService.createPayosPaymentLink({ orderId: cancelledOrder.orderId.toString() }),
          (err: any) => err instanceof BadRequestException,
        );
        const pendingCount = await prisma.paymentTransaction.count({ where: { orderId: cancelledOrder.orderId } });
        assert.strictEqual(pendingCount, 0, 'CANCELLED order must never persist PENDING PaymentTransaction');

        const paidOrder = await prisma.order.create({
          data: {
            orderCode: `ORD-PAID-LCK-${ts}`,
            storeId: storeA.storeId,
            orderStatus: 'PENDING',
            paymentStatus: 'PAID',
            paymentMethod: 'PAYOS',
            subtotalAmount: 100000,
            totalAmount: 100000,
            shippingRecipientName: 'Paid Buyer',
            shippingPhone: '0900000000',
            shippingAddress: '123 Test',
            paymentTransactions: {
              create: {
                provider: 'PAYOS',
                transactionCode: `${Date.now()}99`,
                amount: 100000,
                paymentMethod: 'QR',
                status: 'PENDING',
                paymentLinkId: `link_paid_${ts}`,
              },
            },
          },
        });

        let cancelCallCount = 0;
        const origCancel = (paymentsService as any).cancelPaymentLink;
        (paymentsService as any).cancelPaymentLink = async () => {
          cancelCallCount++;
        };
        try {
          await assert.rejects(
            () =>
              paymentsService.changeOrderPaymentMethod(
                paidOrder.orderId.toString(),
                { paymentMethod: 'COD' } as any,
                { userId: '1', role: 'ADMIN' },
              ),
            (err: any) => err instanceof BadRequestException,
          );
          assert.strictEqual(cancelCallCount, 0, 'Must NOT call PayOS cancel API when locked DB order is already PAID');
        } finally {
          (paymentsService as any).cancelPaymentLink = origCancel;
        }

        // 5B: Concurrent createPayosPaymentLink x 2 on real PG (verifies uq_payment_active_per_order + link reuse)
        const concurrentOrder = await prisma.order.create({
          data: {
            orderCode: `ORD-CONC-PAY-${ts}`,
            storeId: storeA.storeId,
            orderStatus: 'PENDING',
            paymentStatus: 'UNPAID',
            paymentMethod: 'PAYOS',
            subtotalAmount: 100000,
            totalAmount: 100000,
            shippingRecipientName: 'Concurrent Buyer',
            shippingPhone: '0900000001',
            shippingAddress: '124 Test',
          },
        });

        let createFetchCount = 0;
        (globalThis as any).fetch = async (url: string, init?: any) => {
          if (String(url).includes('/v2/payment-requests') && !String(url).includes('/cancel')) {
            createFetchCount++;
            const body = JSON.parse(init?.body || '{}');
            await new Promise((r) => setTimeout(r, 150));
            return {
              ok: true,
              status: 200,
              json: async () => ({
                code: '00',
                desc: 'success',
                data: {
                  orderCode: body.orderCode,
                  amount: body.amount,
                  currency: 'VND',
                  paymentLinkId: `conc_link_${body.orderCode}`,
                  checkoutUrl: `https://pay.payos.vn/web/conc_${body.orderCode}`,
                  qrCode: `000201conc_${body.orderCode}`,
                },
              }),
            } as any;
          }
          return origFetch(url as any, init);
        };

        const [payRes1, payRes2] = await Promise.all([
          paymentsService.createPayosPaymentLink({ orderId: concurrentOrder.orderId.toString() }),
          paymentsService.createPayosPaymentLink({ orderId: concurrentOrder.orderId.toString() }),
        ]);

        assert.strictEqual(createFetchCount, 1, `Concurrent createPayosPaymentLink should hit PayOS once, got ${createFetchCount}`);
        assert.strictEqual(payRes1.data.paymentLinkId, payRes2.data.paymentLinkId, 'Both callers must share same PayOS link');
        assert.strictEqual(payRes1.data.paymentTransactionId, payRes2.data.paymentTransactionId);
        const activeRowsForConc = await prisma.paymentTransaction.count({
          where: { orderId: concurrentOrder.orderId, status: { in: ['PENDING', 'PAID'] } },
        });
        assert.strictEqual(activeRowsForConc, 1, 'uq_payment_active_per_order allows only 1 active PaymentTransaction');

        // 5C: Deterministic race: Request A waiting on PayOS create vs Request B changeOrderPaymentMethod(COD)
        const raceOrder = await prisma.order.create({
          data: {
            orderCode: `ORD-RACE-COD-${ts}`,
            storeId: storeA.storeId,
            orderStatus: 'PENDING',
            paymentStatus: 'UNPAID',
            paymentMethod: 'PAYOS',
            subtotalAmount: 100000,
            totalAmount: 100000,
            shippingRecipientName: 'Race Buyer',
            shippingPhone: '0900000002',
            shippingAddress: '125 Test',
          },
        });

        let signalPayosStarted!: () => void;
        const payosStartedPromise = new Promise<void>((resolve) => {
          signalPayosStarted = resolve;
        });
        let releasePayosHttp!: () => void;
        const payosHttpGate = new Promise<void>((resolve) => {
          releasePayosHttp = resolve;
        });
        const cancelledRemoteLinks: string[] = [];

        (globalThis as any).fetch = async (url: string, init?: any) => {
          const urlStr = String(url);
          if (urlStr.endsWith('/cancel')) {
            cancelledRemoteLinks.push(urlStr);
            return {
              ok: true,
              status: 200,
              json: async () => ({
                code: '00',
                desc: 'success',
                data: { status: 'CANCELLED' },
              }),
            } as any;
          }
          if (urlStr.includes('/v2/payment-requests')) {
            const body = JSON.parse(init?.body || '{}');
            signalPayosStarted();
            await payosHttpGate;
            return {
              ok: true,
              status: 200,
              json: async () => ({
                code: '00',
                desc: 'success',
                data: {
                  orderCode: body.orderCode,
                  amount: body.amount,
                  currency: 'VND',
                  paymentLinkId: `race_stale_link_${body.orderCode}`,
                  checkoutUrl: `https://pay.payos.vn/web/race_${body.orderCode}`,
                  qrCode: `000201race_${body.orderCode}`,
                },
              }),
            } as any;
          }
          return origFetch(url as any, init);
        };

        // Start Request A and pause inside external PayOS HTTP call
        const reqAPromise = paymentsService
          .createPayosPaymentLink({ orderId: raceOrder.orderId.toString() })
          .then(
            (val) => ({ ok: true as const, val }),
            (err) => ({ ok: false as const, err }),
          );

        await payosStartedPromise;

        // While Request A is in-flight at PayOS, Request B switches order to COD
        const switchRes = await paymentsService.changeOrderPaymentMethod(
          raceOrder.orderId.toString(),
          { paymentMethod: 'COD' } as any,
          { userId: ownerUser.userId.toString(), role: 'ADMIN' },
        );
        assert.strictEqual(switchRes.data.paymentMethod, 'COD');

        // Unblock Request A's PayOS HTTP response
        releasePayosHttp();
        const reqAResult = await reqAPromise;

        assert.strictEqual(reqAResult.ok, false, 'Stale createPayosPaymentLink must NOT return active PENDING link after COD switch');
        assert.ok(
          reqAResult.err instanceof ConflictException,
          `Expected ConflictException when saving link for cancelled tx, got ${reqAResult.err?.constructor?.name}: ${reqAResult.err?.message}`,
        );
        assert.strictEqual(
          cancelledRemoteLinks.some((u) => u.includes('/v2/payment-requests/race_stale_link_') && u.endsWith('/cancel')),
          true,
          `Expected best-effort PayOS remote cancel for stale link, got ${JSON.stringify(cancelledRemoteLinks)}`,
        );

        const raceTxs = await prisma.paymentTransaction.findMany({ where: { orderId: raceOrder.orderId } });
        assert.strictEqual(raceTxs.length, 1);
        assert.strictEqual(raceTxs[0].status, 'CANCELLED', 'Cancelled payment transaction must stay CANCELLED');
        assert.ok(
          raceTxs[0].paymentLinkId?.startsWith('race_stale_link_'),
          'Cancelled transaction should retain paymentLinkId for webhook/reconciliation',
        );
        const raceOrderAfter = await prisma.order.findUnique({ where: { orderId: raceOrder.orderId } });
        assert.strictEqual(raceOrderAfter?.paymentMethod, 'COD');

        // 5D-Lock: Concurrent savePaymentLinkIfStillActiveTx vs confirmPaymentAtomicTx (unified orders -> payment_transaction lock order, zero deadlock)
        const lockRaceOrder = await prisma.order.create({
          data: {
            orderCode: `ORD-SAVE-CONF-${ts}`,
            storeId: storeA.storeId,
            orderStatus: 'PENDING',
            paymentStatus: 'UNPAID',
            paymentMethod: 'PAYOS',
            subtotalAmount: 100000,
            totalAmount: 100000,
            shippingRecipientName: 'Lock Race Buyer',
            shippingPhone: '0900000003',
            shippingAddress: '126 Test',
          },
        });
        const createdPendingForLock = await paymentsRepo.createPendingTransactionCheckedTx({
          orderId: lockRaceOrder.orderId,
          transactionCode: `${Date.now()}11`,
          paymentMethod: 'QR',
        });
        const lockRaceTxId = createdPendingForLock.transaction.paymentTransactionId;

        const [saveSettled, confirmSettled] = await Promise.allSettled([
          paymentsRepo.savePaymentLinkIfStillActiveTx({
            orderId: lockRaceOrder.orderId,
            paymentTransactionId: lockRaceTxId,
            paymentLinkId: `lock_race_link_${ts}`,
            checkoutUrl: `https://pay.payos.vn/web/lock_race_${ts}`,
            qrCode: '000201lockrace',
          }),
          paymentsRepo.confirmPaymentAtomicTx(lockRaceTxId),
        ]);

        assert.strictEqual(saveSettled.status, 'fulfilled', `savePaymentLinkIfStillActiveTx must not deadlock/fail: ${(saveSettled as any).reason?.message}`);
        assert.strictEqual(confirmSettled.status, 'fulfilled', `confirmPaymentAtomicTx must not deadlock/fail: ${(confirmSettled as any).reason?.message}`);

        const lockRaceOrderAfter = await prisma.order.findUnique({ where: { orderId: lockRaceOrder.orderId } });
        const lockRaceTxAfter = await prisma.paymentTransaction.findUnique({ where: { paymentTransactionId: lockRaceTxId } });
        assert.strictEqual(lockRaceOrderAfter?.paymentStatus, 'PAID');
        assert.strictEqual(lockRaceOrderAfter?.orderStatus, 'CONFIRMED');
        assert.strictEqual(lockRaceTxAfter?.status, 'PAID');

        // Deterministic PAID-before-save check: savePaymentLinkIfStillActiveTx rejects & does NOT overwrite PAID or trigger PayOS /cancel
        const paidFirstOrder = await prisma.order.create({
          data: {
            orderCode: `ORD-PAID-FIRST-${ts}`,
            storeId: storeA.storeId,
            orderStatus: 'PENDING',
            paymentStatus: 'UNPAID',
            paymentMethod: 'PAYOS',
            subtotalAmount: 100000,
            totalAmount: 100000,
            shippingRecipientName: 'Paid First Buyer',
            shippingPhone: '0900000004',
            shippingAddress: '127 Test',
          },
        });
        const paidFirstCreated = await paymentsRepo.createPendingTransactionCheckedTx({
          orderId: paidFirstOrder.orderId,
          transactionCode: `${Date.now()}22`,
          paymentMethod: 'QR',
        });
        await paymentsRepo.confirmPaymentAtomicTx(paidFirstCreated.transaction.paymentTransactionId);
        let cancelCalledOnPaid = 0;
        (globalThis as any).fetch = async (url: string, init?: any) => {
          if (String(url).endsWith('/cancel')) {
            cancelCalledOnPaid++;
            return { ok: true, status: 200, json: async () => ({ code: '00', data: { status: 'CANCELLED' } }) } as any;
          }
          return origFetch(url as any, init);
        };
        await assert.rejects(
          () =>
            (paymentsService as any).persistLinkOrCancelOnRace({
              orderId: paidFirstOrder.orderId,
              paymentTransactionId: paidFirstCreated.transaction.paymentTransactionId,
              paymentLinkId: `never_overwrite_${ts}`,
              checkoutUrl: 'https://pay.payos.vn/web/never',
              qrCode: '000201never',
            }),
          (err: any) => err instanceof ConflictException,
        );
        assert.strictEqual(cancelCalledOnPaid, 0, 'Must NOT call PayOS /cancel when transaction is already PAID');
        const paidFirstTxAfter = await prisma.paymentTransaction.findUnique({
          where: { paymentTransactionId: paidFirstCreated.transaction.paymentTransactionId },
        });
        assert.strictEqual(paidFirstTxAfter?.status, 'PAID');
        assert.strictEqual(paidFirstTxAfter?.paymentLinkId, null, 'Already PAID transaction must not be overwritten with late link');

        // 5E-Webhook-COD: Concurrent PayOS webhook confirmation vs changeOrderPaymentMethod('COD') on real PostgreSQL
        const whRaceOrder = await prisma.order.create({
          data: {
            orderCode: `ORD-WH-COD-${ts}`,
            storeId: storeA.storeId,
            orderStatus: 'PENDING',
            paymentStatus: 'UNPAID',
            paymentMethod: 'PAYOS',
            subtotalAmount: 100000,
            totalAmount: 100000,
            shippingRecipientName: 'Webhook Race Buyer',
            shippingPhone: '0900000005',
            shippingAddress: '128 Test',
          },
        });
        (globalThis as any).fetch = async (url: string, init?: any) => {
          const u = String(url);
          if (u.endsWith('/cancel')) {
            return { ok: true, status: 200, json: async () => ({ code: '00', data: { status: 'CANCELLED' } }) } as any;
          }
          if (u.includes('/v2/payment-requests')) {
            const body = JSON.parse(init?.body || '{}');
            return {
              ok: true,
              status: 200,
              json: async () => ({
                code: '00',
                desc: 'success',
                data: {
                  orderCode: body.orderCode,
                  amount: body.amount,
                  currency: 'VND',
                  paymentLinkId: `wh_race_link_${body.orderCode}`,
                  checkoutUrl: `https://pay.payos.vn/web/wh_${body.orderCode}`,
                  qrCode: `000201wh_${body.orderCode}`,
                },
              }),
            } as any;
          }
          return origFetch(url as any, init);
        };

        const whLinkRes = await paymentsService.createPayosPaymentLink({ orderId: whRaceOrder.orderId.toString() });
        const whData = {
          orderCode: whLinkRes.data.orderCode,
          amount: 100000,
          currency: 'VND',
          paymentLinkId: whLinkRes.data.paymentLinkId,
          code: '00',
          desc: 'success',
          transactionDateTime: '2026-11-20 13:55:00',
        };
        const whSig = signWebhookData(whData, process.env.PAYOS_CHECKSUM_KEY!);

        const [whSettled, codSettled] = await Promise.allSettled([
          paymentsService.handlePayosWebhook({
            code: '00',
            desc: 'success',
            success: true,
            data: whData,
            signature: whSig,
          } as any),
          paymentsService.changeOrderPaymentMethod(
            whRaceOrder.orderId.toString(),
            { paymentMethod: 'COD' } as any,
            { userId: ownerUser.userId.toString(), role: 'ADMIN' },
          ),
        ]);

        assert.strictEqual(whSettled.status, 'fulfilled', `handlePayosWebhook must succeed cleanly under concurrent COD switch: ${(whSettled as any).reason?.message}`);
        assert.strictEqual((whSettled.value as any)?.success, true);

        const whOrderAfter = await prisma.order.findUnique({ where: { orderId: whRaceOrder.orderId } });
        const whTxAfter = await prisma.paymentTransaction.findFirst({ where: { orderId: whRaceOrder.orderId } });
        assert.strictEqual(whTxAfter?.status, 'PAID', 'Verified webhook payment must NEVER be lost');

        if (codSettled.status === 'fulfilled') {
          // COD switch acquired orders lock first -> webhook routed payment safely to REFUND_PENDING
          assert.strictEqual(whOrderAfter?.paymentMethod, 'COD');
          assert.strictEqual(whOrderAfter?.orderStatus, 'PENDING');
          assert.strictEqual(whOrderAfter?.paymentStatus, 'REFUND_PENDING');
        } else {
          // Webhook acquired orders lock first -> COD switch cleanly rejected with BadRequestException
          assert.ok(codSettled.reason instanceof BadRequestException);
          assert.strictEqual(whOrderAfter?.paymentMethod, 'PAYOS');
          assert.strictEqual(whOrderAfter?.orderStatus, 'CONFIRMED');
          assert.strictEqual(whOrderAfter?.paymentStatus, 'PAID');
        }

        // Deterministic COD-first-then-webhook serialization verification (ensures both branches tested)
        const codFirstOrder = await prisma.order.create({
          data: {
            orderCode: `ORD-COD-WH-${ts}`,
            storeId: storeA.storeId,
            orderStatus: 'PENDING',
            paymentStatus: 'UNPAID',
            paymentMethod: 'PAYOS',
            subtotalAmount: 100000,
            totalAmount: 100000,
            shippingRecipientName: 'COD First Buyer',
            shippingPhone: '0900000006',
            shippingAddress: '129 Test',
          },
        });
        const codFirstLink = await paymentsService.createPayosPaymentLink({ orderId: codFirstOrder.orderId.toString() });
        await paymentsService.changeOrderPaymentMethod(
          codFirstOrder.orderId.toString(),
          { paymentMethod: 'COD' } as any,
          { userId: ownerUser.userId.toString(), role: 'ADMIN' },
        );
        const codFirstWhData = {
          orderCode: codFirstLink.data.orderCode,
          amount: 100000,
          currency: 'VND',
          paymentLinkId: codFirstLink.data.paymentLinkId,
          code: '00',
          desc: 'success',
          transactionDateTime: '2026-11-20 13:56:00',
        };
        const codFirstWhRes = await paymentsService.handlePayosWebhook({
          code: '00',
          desc: 'success',
          success: true,
          data: codFirstWhData,
          signature: signWebhookData(codFirstWhData, process.env.PAYOS_CHECKSUM_KEY!),
        } as any);
        assert.strictEqual(codFirstWhRes.success, true);
        const codFirstOrderAfter = await prisma.order.findUnique({ where: { orderId: codFirstOrder.orderId } });
        assert.strictEqual(codFirstOrderAfter?.paymentMethod, 'COD');
        assert.strictEqual(codFirstOrderAfter?.orderStatus, 'PENDING');
        assert.strictEqual(codFirstOrderAfter?.paymentStatus, 'REFUND_PENDING');

        // 5F-Retry: Transient DB deadlock (40P01 / P2034) retried inside DB TX ONLY without re-calling PayOS HTTP create
        const retryOrder = await prisma.order.create({
          data: {
            orderCode: `ORD-TX-RETRY-${ts}`,
            storeId: storeA.storeId,
            orderStatus: 'PENDING',
            paymentStatus: 'UNPAID',
            paymentMethod: 'PAYOS',
            subtotalAmount: 100000,
            totalAmount: 100000,
            shippingRecipientName: 'Retry Buyer',
            shippingPhone: '0900000007',
            shippingAddress: '130 Test',
          },
        });

        let payosHttpCreateHits = 0;
        (globalThis as any).fetch = async (url: string, init?: any) => {
          if (String(url).includes('/v2/payment-requests') && !String(url).endsWith('/cancel')) {
            payosHttpCreateHits++;
            const body = JSON.parse(init?.body || '{}');
            return {
              ok: true,
              status: 200,
              json: async () => ({
                code: '00',
                desc: 'success',
                data: {
                  orderCode: body.orderCode,
                  amount: body.amount,
                  currency: 'VND',
                  paymentLinkId: `retry_link_${body.orderCode}`,
                  checkoutUrl: `https://pay.payos.vn/web/retry_${body.orderCode}`,
                  qrCode: `000201retry_${body.orderCode}`,
                },
              }),
            } as any;
          }
          return origFetch(url as any, init);
        };

        let txAttemptCounter = 0;
        let saveDeadlockInjected = false;
        let confirmConflictInjected = false;
        const retryPrismaProxy = new Proxy(prisma, {
          get(target, prop, receiver) {
            if (prop === '$transaction') {
              return async (cb: any, opts?: any) => {
                txAttemptCounter++;
                // #1 = createPendingTransactionCheckedTx; #2 = first savePaymentLinkIfStillActiveTx attempt
                if (txAttemptCounter === 2 && !saveDeadlockInjected) {
                  saveDeadlockInjected = true;
                  const err: any = new Error('deadlock detected');
                  err.code = '40P01';
                  throw err;
                }
                // #4 = first confirmPaymentAtomicTx attempt (after retry succeeded at #3)
                if (txAttemptCounter === 4 && !confirmConflictInjected) {
                  confirmConflictInjected = true;
                  const err: any = new Error('Transaction failed due to a write conflict');
                  err.code = 'P2034';
                  throw err;
                }
                return target.$transaction(cb, opts);
              };
            }
            return Reflect.get(target, prop, receiver);
          },
        });

        const retryPaymentsRepo = new PaymentsRepository(retryPrismaProxy as any);
        const retryPaymentsSvc = new PaymentsService(retryPaymentsRepo);
        const retryLinkRes = await retryPaymentsSvc.createPayosPaymentLink({ orderId: retryOrder.orderId.toString() });
        assert.strictEqual(saveDeadlockInjected, true);
        assert.strictEqual(payosHttpCreateHits, 1, 'PayOS HTTP link creation must NOT be retried when savePaymentLinkIfStillActiveTx retries 40P01');
        assert.strictEqual(retryLinkRes.data.status, 'PENDING');

        await retryPaymentsRepo.confirmPaymentAtomicTx(BigInt(retryLinkRes.data.paymentTransactionId));
        assert.strictEqual(confirmConflictInjected, true);
        const retryOrderAfter = await prisma.order.findUnique({ where: { orderId: retryOrder.orderId } });
        assert.strictEqual(retryOrderAfter?.paymentStatus, 'PAID');
        assert.strictEqual(retryOrderAfter?.orderStatus, 'CONFIRMED');
      } finally {
        (globalThis as any).fetch = origFetch;
        if (prevClientId === undefined) delete process.env.PAYOS_CLIENT_ID;
        else process.env.PAYOS_CLIENT_ID = prevClientId;
        if (prevApiKey === undefined) delete process.env.PAYOS_API_KEY;
        else process.env.PAYOS_API_KEY = prevApiKey;
        if (prevChecksum === undefined) delete process.env.PAYOS_CHECKSUM_KEY;
        else process.env.PAYOS_CHECKSUM_KEY = prevChecksum;
        if (prevMock === undefined) delete process.env.PAYOS_MOCK_PAYMENT;
        else process.env.PAYOS_MOCK_PAYMENT = prevMock;
      }

      // 5D: Quick-reorder idempotency key hash safety (zero collision on 128-char keys sharing 120-char prefix)
      const capturedRequests: string[] = [];
      const mockOrdersByReq = new Map<string, any>();
      const mockButtonObj = {
        buttonId: BigInt(1),
        deviceId: 'SOB-1',
        buttonCode: 'BTN-1',
        status: 'ACTIVE',
        inventoryState: 'IN_CUSTOMER_CUSTODY',
        canOrder: true,
        customerId: BigInt(9),
        storeId: BigInt(10),
        store: { storeId: BigInt(10), name: 'S', ownerUserId: BigInt(2) },
        customer: { userId: BigInt(5), user: { fullName: 'C', phone: '090' } },
        buttonProducts: [{ productId: BigInt(1), quantity: 1, product: { basePrice: 50000 } }],
      };
      const mockOrdersSvc = new OrdersService(
        {
          findButtonByDeviceId: async () => mockButtonObj,
          findButtonByIdentifier: async () => mockButtonObj,
          findOrderByButtonAndRequestId: async (_bid: bigint, reqId: string) =>
            mockOrdersByReq.get(reqId) || null,
          createOrderFallbackTx: async (_b: any, _pm: any, _sf: any, reqId: string) => {
            capturedRequests.push(reqId);
            const nextId = BigInt(777 + capturedRequests.length);
            mockOrdersByReq.set(reqId, {
              orderId: nextId,
              orderCode: `ORD-${nextId}`,
              iotRequestId: reqId,
              storeId: BigInt(10),
              customerId: BigInt(9),
              orderStatus: 'PENDING',
              paymentStatus: 'UNPAID',
              paymentMethod: 'COD',
              subtotalAmount: 50000,
              totalAmount: 50000,
              items: [],
            });
            return nextId;
          },
          findOrderById: async (id: bigint) => {
            for (const val of mockOrdersByReq.values()) {
              if (val.orderId === id) return val;
            }
            return {
              orderId: id,
              orderCode: `ORD-${id}`,
              storeId: BigInt(10),
              customerId: BigInt(9),
              orderStatus: 'PENDING',
              paymentStatus: 'UNPAID',
              paymentMethod: 'COD',
              subtotalAmount: 50000,
              totalAmount: 50000,
              items: [],
            };
          },
        } as any,
        undefined,
        { emitToStore() {}, emitToCustomer() {} } as any,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          verifyAndResolveForMobileOrder: async () => ({ shippingAddress: 'Mock Addr' }),
        } as any,
      );

      const sharedPrefix = 'k'.repeat(120);
      const longKeyA = `${sharedPrefix}1234567A`; // 128 chars
      const longKeyB = `${sharedPrefix}1234567B`; // 128 chars, identical 127 prefix

      const qrA1 = await mockOrdersSvc.quickReorder({ deviceId: 'SOB-1' }, { role: 'CUSTOMER', customerProfileId: '9' }, longKeyA);
      const qrA2 = await mockOrdersSvc.quickReorder({ deviceId: 'SOB-1' }, { role: 'CUSTOMER', customerProfileId: '9' }, longKeyA);
      const qrB1 = await mockOrdersSvc.quickReorder({ deviceId: 'SOB-1' }, { role: 'CUSTOMER', customerProfileId: '9' }, longKeyB);

      assert.strictEqual(qrA1.isDuplicate, false);
      assert.strictEqual(qrA2.isDuplicate, true);
      assert.strictEqual(qrB1.isDuplicate, false, 'Distinct 128-char keys sharing 127 prefix must NOT collide');
      assert.strictEqual(capturedRequests.length, 2, `Expected 2 distinct orders created, got ${capturedRequests.length}`);
      assert.notStrictEqual(capturedRequests[0], capturedRequests[1]);
      assert.ok(capturedRequests[0].length <= 128 && capturedRequests[1].length <= 128);

      await assert.rejects(
        () => mockOrdersSvc.quickReorder({ deviceId: 'SOB-1' }, { role: 'CUSTOMER', customerProfileId: '9' }, 'invalid key!'),
        (err: any) => err instanceof BadRequestException,
      );

      passed++;
      console.log('  ✔ [PASS] Group 5: Payments concurrency, PayOS vs COD race recovery & 128-char non-colliding quickReorder pass');
    }

    console.log(`\n🎉 ALL ${passed}/5 ACID HARDENING GROUPS PASSED!\n`);
  } finally {
    // Cleanup seeded records safely in dependency order
    try {
      for (const sId of cleanupStoreIds) {
        const orders = await prisma.order.findMany({ where: { storeId: sId }, select: { orderId: true } });
        const oIds = orders.map((o) => o.orderId);
        if (oIds.length) {
          await prisma.paymentRefundVerifiedVoucher.deleteMany({ where: { obligation: { orderId: { in: oIds } } } });
          await prisma.paymentRefundObligation.updateMany({ where: { orderId: { in: oIds } }, data: { activePayoutAttemptId: null, settledAttemptId: null } });
          await prisma.paymentRefundPayoutAttempt.deleteMany({ where: { obligation: { orderId: { in: oIds } } } });
          await prisma.paymentRefundObligation.deleteMany({ where: { orderId: { in: oIds } } });
          await prisma.paymentOrderReceipt.deleteMany({ where: { orderId: { in: oIds } } });
          await prisma.orderStatusHistory.deleteMany({ where: { orderId: { in: oIds } } });
          await prisma.paymentTransaction.deleteMany({ where: { orderId: { in: oIds } } });
          await prisma.orderItem.deleteMany({ where: { orderId: { in: oIds } } });
          await prisma.order.deleteMany({ where: { orderId: { in: oIds } } });
        }
        await prisma.inventory.deleteMany({ where: { storeId: sId } });
        await prisma.product.deleteMany({ where: { storeId: sId } });
        await prisma.storeSubscription.deleteMany({ where: { storeId: sId } });
        const wallets = await prisma.storeWallet.findMany({ where: { storeId: sId }, select: { walletId: true } });
        const wIds = wallets.map((w) => w.walletId);
        if (wIds.length) {
          await prisma.storeWithdrawal.deleteMany({ where: { walletId: { in: wIds } } });
          await prisma.walletTransaction.deleteMany({ where: { walletId: { in: wIds } } });
          await prisma.storeWallet.deleteMany({ where: { walletId: { in: wIds } } });
        }
        await prisma.storeBankAccount.deleteMany({ where: { storeId: sId } });
        await prisma.store.deleteMany({ where: { storeId: sId } });
      }
      if (cleanupPlanIds.length) {
        await prisma.subscriptionPlan.deleteMany({ where: { planId: { in: cleanupPlanIds } } });
      }
      if (cleanupUserIds.length) {
        await prisma.user.deleteMany({ where: { userId: { in: cleanupUserIds } } });
      }
    } catch (cleanupErr) {
      console.warn('Cleanup warning (non-fatal):', cleanupErr);
    }
    await prisma.$disconnect();
  }
}

run().catch((err) => {
  console.error('❌ Suite 86 failed:', err);
  process.exit(1);
});
