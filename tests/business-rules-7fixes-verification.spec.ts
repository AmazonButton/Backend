/**
 * Comprehensive verification suite for the 7 Business-Rule Hardening fixes:
 *  - Ý 1 & Ý 5: Pre-delivery/doorstep flexible PayOS <-> COD payment timing & simulateButtonPress ACTIVE check
 *  - Ý 2: DELIVERY_FAILED cancellation (REFUND_PENDING + ORDER_REFUND) & 24h auto-cancel worker
 *  - Ý 3: Static-IP Node-3 exclusivity & safe offline queueing for DEPOSIT_REFUND_APPROVED & STORE_WITHDRAWAL_PAYOUT
 *  - Ý 4: Expired-subscription store/product hiding, blocked customer guard, IoT missed-order & customer notifications + zero idempotency residue
 *  - Ý 6: PENDING_HANDOVER return rejection & pre-handover cancellation with button release + 100% DepositRefund
 *  - Ý 7: Automatic remote PayOS link cancellation on order cancellation
 */
import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { getSafeTestPrismaService } from './test-db-guard';
import { PaymentsRepository } from '../src/payments/payments.repository';
import { PaymentsService } from '../src/payments/payments.service';
import { PaymentRefundsRepository } from '../src/payments/payment-refunds.repository';
import { OrdersRepository } from '../src/orders/orders.repository';
import { OrdersService } from '../src/orders/orders.service';
import { OrdersLifecycleWorker } from '../src/orders/orders-lifecycle.worker';
import { IotService } from '../src/iot/iot.service';
import { StoresService } from '../src/stores/stores.service';
import { StoresRepository } from '../src/stores/stores.repository';
import { ProductsRepository } from '../src/products/products.repository';
import { ProductsService } from '../src/products/products.service';
import { StoreSubscriptionsRepository } from '../src/store-subscriptions/store-subscriptions.repository';
import { StoreSubscriptionsService } from '../src/store-subscriptions/store-subscriptions.service';
import { RentalsRepository } from '../src/rentals/rentals.repository';
import { RentalsService } from '../src/rentals/rentals.service';
import { OutboxConsumerService } from '../src/rentals/outbox-consumer.service';
import { AdminRepository } from '../src/admin/admin.repository';
import { AdminService } from '../src/admin/admin.service';
import { StoreWithdrawalPayoutWorkerService } from '../src/admin/store-withdrawal-payout.worker';
import { CryptoVaultUtil } from '../src/common/utils/crypto-vault.util';
import { NotificationsService } from '../src/notifications/notifications.service';

type Outcome = { name: string; passed: boolean; detail?: string };
const outcomes: Outcome[] = [];

async function testCase(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    outcomes.push({ name, passed: true });
    console.log(`PASS ${name}`);
  } catch (err: any) {
    const detail = `${err?.constructor?.name || 'Error'}: ${err?.stack || err?.message || err}`;
    outcomes.push({ name, passed: false, detail });
    console.error(`FAIL ${name} -> ${detail}`);
  }
}

async function runSuite() {
  const prisma = getSafeTestPrismaService('7 Business-Rule Hardening Verification');
  const tag = `BR7_${Date.now()}_${randomUUID().slice(0, 5).toUpperCase()}`;

  const prevNodeEnv = process.env.NODE_ENV;
  const prevStrictSub = process.env.ENFORCE_STORE_SUBSCRIPTION_STRICT;
  const prevPayoutWorkerEnabled = process.env.PAYOS_PAYOUT_WORKER_ENABLED;
  const prevPayoutDelegate = process.env.PAYOS_PAYOUT_DELEGATE_TO_WORKER;
  const prevPayoutWait = process.env.PAYOS_PAYOUT_DELEGATE_WAIT_MS;
  const prevPayosClientId = process.env.PAYOS_CLIENT_ID;
  const prevPayosApiKey = process.env.PAYOS_API_KEY;
  const prevPayosChecksum = process.env.PAYOS_CHECKSUM_KEY;
  const prevPayosMock = process.env.PAYOS_MOCK_PAYMENT;

  process.env.NODE_ENV = 'test';
  delete process.env.ENFORCE_STORE_SUBSCRIPTION_STRICT;
  process.env.PAYOS_CLIENT_ID = 'ci_test_client';
  process.env.PAYOS_API_KEY = 'ci_test_api_key';
  process.env.PAYOS_CHECKSUM_KEY = 'ci_test_checksum_key_32bytes_12345';
  process.env.PAYOS_MOCK_PAYMENT = 'true';

  const cancelledRemoteLinks: Array<{ linkId: string; reason?: string }> = [];
  const payoutCalls: any[] = [];
  const createdUserIds: bigint[] = [];
  const createdStoreIds: bigint[] = [];
  const createdProductIds: bigint[] = [];
  const createdCategoryIds: bigint[] = [];
  const createdButtonIds: bigint[] = [];
  const createdOrderIds: bigint[] = [];
  const createdRentalIds: bigint[] = [];
  const createdPackageIds: bigint[] = [];
  const createdPlanIds: bigint[] = [];
  const createdOutboxIds: bigint[] = [];
  const createdWithdrawalIds: bigint[] = [];

  try {
    // Shared fixtures
    const owner1 = await prisma.user.create({
      data: {
        username: `${tag}_owner1`,
        email: `${tag}_owner1@test.local`,
        passwordHash: 'hash',
        fullName: 'Owner Active Sub',
        status: 'ACTIVE',
      },
    });
    const owner2 = await prisma.user.create({
      data: {
        username: `${tag}_owner2`,
        email: `${tag}_owner2@test.local`,
        passwordHash: 'hash',
        fullName: 'Owner Expired Sub',
        status: 'ACTIVE',
      },
    });
    const owner3 = await prisma.user.create({
      data: {
        username: `${tag}_owner3`,
        email: `${tag}_owner3@test.local`,
        passwordHash: 'hash',
        fullName: 'Owner Zero Sub',
        status: 'ACTIVE',
      },
    });
    const custUser = await prisma.user.create({
      data: {
        username: `${tag}_cust`,
        email: `${tag}_cust@test.local`,
        passwordHash: 'hash',
        fullName: 'Customer Seven Fixes',
        phone: '0909111222',
        status: 'ACTIVE',
      },
    });
    createdUserIds.push(owner1.userId, owner2.userId, owner3.userId, custUser.userId);

    const custProfile = await prisma.customerProfile.create({
      data: { userId: custUser.userId, phone: '0909111222' },
    });
    const custAddr = await prisma.customerAddress.create({
      data: {
        customerId: custProfile.customerId,
        recipientName: 'Customer Seven Fixes',
        phone: '0909111222',
        addressDetail: '100 Nguyen Hue, Q1',
        latitude: 10.7769,
        longitude: 106.7009,
        isDefault: true,
      },
    });

    const accEnc = CryptoVaultUtil.encryptAccountNumber('1234567890');
    const accHash = CryptoVaultUtil.computeDeterministicAccountHash('1234567890');
    const custBank = await prisma.customerBankAccount.create({
      data: {
        customerId: custProfile.customerId,
        bankBin: '970422',
        bankCode: 'MB',
        bankName: 'MB Bank',
        accountNumberEncrypted: accEnc,
        accountNumberHash: accHash,
        accountNumberMasked: '******7890',
        accountName: 'CUSTOMER SEVEN FIXES',
        verificationStatus: 'VERIFIED',
        isDefault: true,
      },
    });

    const store1 = await prisma.store.create({
      data: {
        ownerUserId: owner1.userId,
        name: `${tag} Active Store`,
        code: `${tag}_S1`,
        phone: '0901111111',
        address: '100 Le Loi, Q1',
        latitude: 10.775,
        longitude: 106.7,
        status: 'ACTIVE',
      },
    });
    const store2 = await prisma.store.create({
      data: {
        ownerUserId: owner2.userId,
        name: `${tag} Expired Store`,
        code: `${tag}_S2`,
        phone: '0902222222',
        address: '200 Le Loi, Q1',
        latitude: 10.775,
        longitude: 106.7,
        status: 'ACTIVE',
      },
    });
    const store3 = await prisma.store.create({
      data: {
        ownerUserId: owner3.userId,
        name: `${tag} Zero Sub Store`,
        code: `${tag}_S3`,
        phone: '0903333333',
        address: '300 Le Loi, Q1',
        latitude: 10.775,
        longitude: 106.7,
        status: 'ACTIVE',
      },
    });
    createdStoreIds.push(store1.storeId, store2.storeId, store3.storeId);

    const plan = await prisma.subscriptionPlan.create({
      data: {
        planCode: `${tag}_PLAN`,
        planName: 'Test Sub Plan',
        price: 100000,
        durationDays: 30,
        maxProducts: 100,
        isActive: true,
      },
    });
    createdPlanIds.push(plan.planId);

    const now = new Date();
    await prisma.storeSubscription.create({
      data: {
        storeId: store1.storeId,
        planId: plan.planId,
        startDate: new Date(now.getTime() - 86_400_000),
        endDate: new Date(now.getTime() + 30 * 86_400_000),
        status: 'ACTIVE',
      },
    });
    await prisma.storeSubscription.create({
      data: {
        storeId: store2.storeId,
        planId: plan.planId,
        startDate: new Date(now.getTime() - 40 * 86_400_000),
        endDate: new Date(now.getTime() - 86_400_000),
        status: 'EXPIRED',
      },
    });

    const cat1 = await prisma.category.create({
      data: { storeId: store1.storeId, categoryName: `${tag}_CAT1`, status: 'ACTIVE' },
    });
    const cat2 = await prisma.category.create({
      data: { storeId: store2.storeId, categoryName: `${tag}_CAT2`, status: 'ACTIVE' },
    });
    createdCategoryIds.push(cat1.categoryId, cat2.categoryId);

    const prod1 = await prisma.product.create({
      data: {
        storeId: store1.storeId,
        categoryId: cat1.categoryId,
        productCode: `${tag}_P1`,
        productName: `${tag} Active Product`,
        brand: 'Lavie',
        basePrice: 50000,
        status: 'ACTIVE',
        inventory: {
          create: { storeId: store1.storeId, quantityOnHand: 100, reservedQuantity: 0, minStockAlert: 5 },
        },
      },
    });
    const prod2 = await prisma.product.create({
      data: {
        storeId: store2.storeId,
        categoryId: cat2.categoryId,
        productCode: `${tag}_P2`,
        productName: `${tag} Expired Store Product`,
        brand: 'Lavie',
        basePrice: 50000,
        status: 'ACTIVE',
        inventory: {
          create: { storeId: store2.storeId, quantityOnHand: 50, reservedQuantity: 0, minStockAlert: 5 },
        },
      },
    });
    createdProductIds.push(prod1.productId, prod2.productId);

    // Wire real Repositories & Services with guarded mock PayOS client
    const mockEventsGateway = {
      emitToStore: () => {},
      emitToCustomer: () => {},
      emitToDriver: () => {},
      emitGlobal: () => {},
    } as any;
    const notificationsService = new NotificationsService(prisma as any, {} as any);
    const paymentsRepo = new PaymentsRepository(prisma as any);
    const refundsRepo = new PaymentRefundsRepository(prisma as any);
    const paymentsService = new PaymentsService(paymentsRepo, mockEventsGateway, notificationsService);
    const origCancelPaymentLink = paymentsService.cancelPaymentLink.bind(paymentsService);
    (paymentsService as any).cancelPaymentLink = async (id: number | string, reason?: string) => {
      cancelledRemoteLinks.push({ linkId: String(id), reason });
      return origCancelPaymentLink(id, reason);
    };

    const ordersRepo = new OrdersRepository(prisma as any, refundsRepo);
    const ordersService = new OrdersService(
      ordersRepo,
      undefined,
      mockEventsGateway,
      undefined,
      notificationsService,
      undefined,
      undefined,
      undefined,
      undefined,
      paymentsService,
    );
    const ordersLifecycleWorker = new OrdersLifecycleWorker(
      prisma as any,
      ordersRepo,
      ordersService,
      mockEventsGateway,
      notificationsService,
      paymentsService,
    );

    const storesRepo = new StoresRepository(prisma as any);
    const storesService = new StoresService(prisma as any, storesRepo);
    const productsRepo = new ProductsRepository(prisma as any);
    const subRepo = new StoreSubscriptionsRepository(prisma as any);
    const subService = new StoreSubscriptionsService(subRepo, { getOrCreateStoreWallet: async () => null } as any);
    const productsService = new ProductsService(productsRepo, subService, {} as any, mockEventsGateway);

    const mockPayosPayoutService = {
      createPayout: async (payload: any) => {
        payoutCalls.push(payload);
        const payoutId = `po_${tag}_${payoutCalls.length}`;
        return {
          code: '00',
          data: {
            id: payoutId,
            referenceId: payload.referenceId,
            amount: payload.amount,
            approvalState: 'SUCCEEDED',
            transactions: [
              {
                id: `potx_${tag}_${payoutCalls.length}`,
                referenceId: payload.referenceId,
                amount: payload.amount,
                toBin: payload.toBin,
                toAccountNumber: payload.toAccountNumber,
                state: 'SUCCEEDED',
              },
            ],
          },
        };
      },
      getPayouts: async () => ({ code: '00', data: { payouts: [] } }),
      getPayout: async () => ({ code: '00', data: null }),
    } as any;

    const rentalsRepo = new RentalsRepository(prisma as any);
    const rentalsService = new RentalsService(rentalsRepo, undefined, mockPayosPayoutService, undefined, paymentsService);
    const outboxConsumer = new OutboxConsumerService(
      prisma as any,
      rentalsRepo,
      notificationsService,
      mockPayosPayoutService,
    );

    const adminRepo = new AdminRepository(prisma as any);
    const adminService = new AdminService(adminRepo, mockPayosPayoutService, undefined, mockEventsGateway);
    const withdrawalWorker = new StoreWithdrawalPayoutWorkerService(prisma as any, adminService);

    const custActor = {
      userId: custUser.userId.toString(),
      id: custUser.userId.toString(),
      role: 'CUSTOMER',
      customerProfileId: custProfile.customerId.toString(),
    };
    const owner1Actor = {
      userId: owner1.userId.toString(),
      id: owner1.userId.toString(),
      role: 'STORE_OWNER',
      storeId: store1.storeId.toString(),
    };
    const owner2Actor = {
      userId: owner2.userId.toString(),
      id: owner2.userId.toString(),
      role: 'STORE_OWNER',
      storeId: store2.storeId.toString(),
    };

    // T1: Flexible Payment Timing (Ý 1)
    await testCase('T1: Pre-delivery payment switching, QR payment on COD order, cancelled link refund guard, doorstep COD', async () => {
      // 1a + 1b: COD order in SHIPPING -> customer creates PayOS link & pays it -> flips PAYOS + PAID
      const order1 = await ordersRepo.createStorefrontOrderTx({
        storeId: store1.storeId,
        items: [{ productId: prod1.productId.toString(), quantity: 1 }],
        customerName: 'Cust',
        customerPhone: '0909111222',
        deliveryAddress: '100 Nguyen Hue',
        paymentMethod: 'COD',
        customerUserId: custUser.userId,
      });
      createdOrderIds.push(order1.orderId);
      await prisma.order.update({ where: { orderId: order1.orderId }, data: { orderStatus: 'PREPARING' } });

      // Switch COD -> PAYOS in PREPARING (pre-delivery flexibility)
      const switched = await paymentsService.changeOrderPaymentMethod(
        order1.orderId.toString(),
        { paymentMethod: 'PAYOS' },
        custActor,
      );
      assert.equal(switched.data.paymentMethod, 'PAYOS');

      // Flip back to COD in SHIPPING and still scan an ACTIVE QR link created via createPayosPaymentLink
      await prisma.order.update({
        where: { orderId: order1.orderId },
        data: { orderStatus: 'SHIPPING', paymentMethod: 'COD' },
      });
      const linkRes = await paymentsService.createPayosPaymentLink(
        { orderId: order1.orderId.toString(), description: 'Pre-deliv QR' },
        custActor,
      );
      const txId = BigInt(linkRes.data.paymentTransactionId);

      const confirmed = await paymentsRepo.confirmPaymentAtomicTx(txId, {
        providerTransactionRef: `ref_${tag}_1b`,
        amount: 50000,
        sourceEvidenceStatus: 'SUFFICIENT',
      });
      assert.equal(confirmed.order.paymentMethod, 'PAYOS');
      assert.equal(confirmed.order.paymentStatus, 'PAID');

      // 1c: Cancelled QR link paid late after explicit PAYOS -> COD switch MUST still enter REFUND_PENDING
      const order2 = await ordersRepo.createStorefrontOrderTx({
        storeId: store1.storeId,
        items: [{ productId: prod1.productId.toString(), quantity: 1 }],
        customerName: 'Cust',
        customerPhone: '0909111222',
        deliveryAddress: '100 Nguyen Hue',
        paymentMethod: 'PAYOS',
        customerUserId: custUser.userId,
      });
      createdOrderIds.push(order2.orderId);
      const linkRes2 = await paymentsService.createPayosPaymentLink(
        { orderId: order2.orderId.toString() },
        custActor,
      );
      await paymentsService.changeOrderPaymentMethod(
        order2.orderId.toString(),
        { paymentMethod: 'COD' },
        custActor,
      );
      assert.ok(
        cancelledRemoteLinks.some((c) => c.linkId === linkRes2.data.paymentLinkId),
        'Remote PayOS link must be cancelled when switching PAYOS -> COD',
      );
      const lateConfirmed = await paymentsRepo.confirmPaymentAtomicTx(BigInt(linkRes2.data.paymentTransactionId), {
        providerTransactionRef: `ref_${tag}_1c`,
        amount: 50000,
        sourceEvidenceStatus: 'SUFFICIENT',
      });
      assert.equal(lateConfirmed.order.paymentStatus, 'REFUND_PENDING');

      // 1d: Unpaid PAYOS order settled at doorstep via COD cancels lingering PENDING link
      const order3 = await ordersRepo.createStorefrontOrderTx({
        storeId: store1.storeId,
        items: [{ productId: prod1.productId.toString(), quantity: 1 }],
        customerName: 'Cust',
        customerPhone: '0909111222',
        deliveryAddress: '100 Nguyen Hue',
        paymentMethod: 'PAYOS',
        customerUserId: custUser.userId,
      });
      createdOrderIds.push(order3.orderId);
      const linkRes3 = await paymentsService.createPayosPaymentLink(
        { orderId: order3.orderId.toString() },
        custActor,
      );
      await prisma.order.update({
        where: { orderId: order3.orderId },
        data: { orderStatus: 'SHIPPING', assignedDriverId: owner1.userId },
      });
      const beforeCancelCalls = cancelledRemoteLinks.length;
      const delivered = await ordersService.completeDelivery(
        order3.orderId.toString(),
        {
          status: 'DELIVERED',
          podObjectKey: `stores/${store1.storeId}/pod/proof_${tag}.jpg`,
          paymentMethod: 'COD',
          collectedAmount: 50000,
        },
        owner1Actor,
      );
      assert.equal(delivered.orderStatus, 'DELIVERED');
      assert.equal(delivered.paymentMethod, 'COD');
      assert.equal(delivered.paymentStatus, 'PAID');
      const pt3 = await prisma.paymentTransaction.findUnique({
        where: { paymentTransactionId: BigInt(linkRes3.data.paymentTransactionId) },
      });
      assert.equal(pt3?.status, 'CANCELLED');
      assert.ok(
        cancelledRemoteLinks.slice(beforeCancelCalls).some((c) => c.linkId === linkRes3.data.paymentLinkId),
        'Doorstep COD settlement must cancel lingering remote PayOS link',
      );
    });

    // T2: DELIVERY_FAILED Cancellation + 24h Worker (Ý 2 - Hướng B)
    await testCase('T2: DELIVERY_FAILED paid order manual cancel & 24h auto-cancel create ORDER_REFUND obligation without double stock release', async () => {
      const orderManual = await ordersRepo.createStorefrontOrderTx({
        storeId: store1.storeId,
        items: [{ productId: prod1.productId.toString(), quantity: 1 }],
        customerName: 'Cust',
        customerPhone: '0909111222',
        deliveryAddress: '100 Nguyen Hue',
        paymentMethod: 'PAYOS',
        customerUserId: custUser.userId,
      });
      createdOrderIds.push(orderManual.orderId);
      const linkM = await paymentsService.createPayosPaymentLink({ orderId: orderManual.orderId.toString() }, custActor);
      await paymentsRepo.confirmPaymentAtomicTx(BigInt(linkM.data.paymentTransactionId), {
        providerTransactionRef: `ref_${tag}_2a`,
        amount: 50000,
        sourceEvidenceStatus: 'SUFFICIENT',
      });
      await prisma.order.update({ where: { orderId: orderManual.orderId }, data: { orderStatus: 'SHIPPING' } });
      await ordersRepo.failDeliveryAtomicTx(orderManual.orderId, owner1Actor, {
        failureReasonCode: 'CUSTOMER_UNREACHABLE',
        failureNote: 'Goi 3 lan khong nghe',
        evidenceImageUrl: `https://res.cloudinary.com/demo/image/upload/stores/${store1.storeId}/pod/fail1.jpg`,
      });

      const invBeforeCancel = await prisma.inventory.findUnique({ where: { productId: prod1.productId } });
      const cancelledManual = await ordersService.cancelOrder(orderManual.orderId.toString(), 'Huy do giao that bai', custActor);
      assert.equal(cancelledManual.orderStatus, 'CANCELLED');
      assert.equal(cancelledManual.paymentStatus, 'REFUND_PENDING');
      const invAfterCancel = await prisma.inventory.findUnique({ where: { productId: prod1.productId } });
      assert.equal(invAfterCancel?.reservedQuantity, invBeforeCancel?.reservedQuantity, 'Must NOT double-release reserved stock');
      const oblManual = await prisma.paymentRefundObligation.findFirst({
        where: { orderId: orderManual.orderId, obligationType: 'ORDER_REFUND' },
      });
      assert.ok(oblManual, 'ORDER_REFUND obligation must be created automatically for cancelled DELIVERY_FAILED paid order');

      // 24h stuck safety net
      const orderAuto = await ordersRepo.createStorefrontOrderTx({
        storeId: store1.storeId,
        items: [{ productId: prod1.productId.toString(), quantity: 1 }],
        customerName: 'Cust',
        customerPhone: '0909111222',
        deliveryAddress: '100 Nguyen Hue',
        paymentMethod: 'PAYOS',
        customerUserId: custUser.userId,
      });
      createdOrderIds.push(orderAuto.orderId);
      const linkA = await paymentsService.createPayosPaymentLink({ orderId: orderAuto.orderId.toString() }, custActor);
      await paymentsRepo.confirmPaymentAtomicTx(BigInt(linkA.data.paymentTransactionId), {
        providerTransactionRef: `ref_${tag}_2b`,
        amount: 50000,
        sourceEvidenceStatus: 'SUFFICIENT',
      });
      await prisma.order.update({ where: { orderId: orderAuto.orderId }, data: { orderStatus: 'SHIPPING' } });
      await ordersRepo.failDeliveryAtomicTx(orderAuto.orderId, owner1Actor, {
        failureReasonCode: 'CUSTOMER_UNREACHABLE',
        failureNote: 'Fail 25h ago',
        evidenceImageUrl: `https://res.cloudinary.com/demo/image/upload/stores/${store1.storeId}/pod/fail2.jpg`,
      });
      await prisma.$executeRawUnsafe(
        `UPDATE orders SET updated_at = NOW() - INTERVAL '25 hours' WHERE order_id = $1`,
        orderAuto.orderId,
      );

      await ordersLifecycleWorker.processPendingOrdersLifecycle(4000, 50);
      const updatedAuto = await prisma.order.findUnique({ where: { orderId: orderAuto.orderId } });
      assert.equal(updatedAuto?.orderStatus, 'CANCELLED');
      assert.equal(updatedAuto?.paymentStatus, 'REFUND_PENDING');
      const oblAuto = await prisma.paymentRefundObligation.findFirst({
        where: { orderId: orderAuto.orderId, obligationType: 'ORDER_REFUND' },
      });
      assert.ok(oblAuto, '24h worker must create ORDER_REFUND obligation');
    });

    // T3: Static-IP Node-3 Exclusivity (Ý 3)
    await testCase('T3: Render skips DEPOSIT_REFUND_APPROVED & delegates STORE_WITHDRAWAL_PAYOUT safely; Node-3 drains both', async () => {
      const pkg = await prisma.rentalPackage.create({
        data: {
          packageCode: `${tag}_PKG3`,
          packageName: 'Pkg 3',
          buttonQuantity: 1,
          monthlyPrice: 30000,
          depositFee: 100000,
          isActive: true,
        },
      });
      createdPackageIds.push(pkg.packageId);
      const rental3 = await prisma.buttonRental.create({
        data: {
          rentalCode: `${tag}_R3`,
          customerId: custProfile.customerId,
          packageId: pkg.packageId,
          monthsRented: 1,
          totalRentAmount: 30000,
          depositAmount: 100000,
          buttonQuantity: 1,
          depositPerButton: 100000,
          rentPerButton: 30000,
          monthlyRentPerButtonSnapshot: 30000,
          pricingReviewRequired: false,
          status: 'RETURNED',
          startDate: now,
          endDate: now,
        },
      });
      createdRentalIds.push(rental3.rentalId);
      await prisma.rentalDeposit.create({
        data: {
          rentalId: rental3.rentalId,
          collectedAmount: 100000,
          heldAmount: 0,
          refundReservedAmount: 100000,
          refundedAmount: 0,
        },
      });
      const depRefund = await prisma.depositRefund.create({
        data: {
          refundCode: `${tag}_DRF3`,
          rentalId: rental3.rentalId,
          customerId: custProfile.customerId,
          bankAccountId: custBank.id,
          recipientBin: '970422',
          recipientAccountNumberEncrypted: accEnc,
          recipientAccountNumberHash: accHash,
          recipientAccountHolderName: 'CUSTOMER SEVEN FIXES',
          recipientAccountNumberMasked: '******7890',
          amount: 100000,
          deductionAmount: 0,
          status: 'PENDING_PAYOUT',
        },
      });
      const depOutbox = await prisma.outboxEvent.create({
        data: {
          eventType: 'DEPOSIT_REFUND_APPROVED',
          payload: { refundId: depRefund.refundId.toString() },
          status: 'PENDING',
        },
      });
      const nonPayoutOutbox = await prisma.outboxEvent.create({
        data: {
          eventType: 'STORE_SUBSCRIPTION_EXPIRED',
          payload: { storeId: store1.storeId.toString() },
          status: 'PENDING',
        },
      });
      createdOutboxIds.push(depOutbox.id, nonPayoutOutbox.id);

      // Simulate Render dynamic-IP node
      process.env.PAYOS_PAYOUT_WORKER_ENABLED = 'false';
      process.env.PAYOS_PAYOUT_DELEGATE_TO_WORKER = 'true';
      const beforePayouts = payoutCalls.length;
      await outboxConsumer.processPendingEvents(10);

      const depOutboxAfterRender = await prisma.outboxEvent.findUnique({ where: { id: depOutbox.id } });
      const nonPayoutAfterRender = await prisma.outboxEvent.findUnique({ where: { id: nonPayoutOutbox.id } });
      assert.equal(nonPayoutAfterRender?.status, 'COMPLETED', 'Non-payout outbox must still run on Render');
      assert.equal(depOutboxAfterRender?.status, 'PENDING', 'DEPOSIT_REFUND_APPROVED must stay PENDING on Render');
      assert.equal(payoutCalls.length, beforePayouts, 'Render must NEVER call PayOS payout');

      // Store withdrawal delegation when Node-3 is offline, then Node-3 online
      const wallet = await prisma.storeWallet.create({
        data: { storeId: store1.storeId, balance: 200000, frozenBalance: 100000 },
      });
      const wdHash = CryptoVaultUtil.hashAccountNumber('1234567890');
      const withdrawal = await prisma.storeWithdrawal.create({
        data: {
          walletId: wallet.walletId,
          storeId: store1.storeId,
          withdrawalCode: `${tag}_WD3`,
          amount: 100000,
          fee: 0,
          netAmount: 100000,
          bankName: 'MB Bank',
          bankAccountHolder: 'OWNER ONE',
          bankNameSnapshot: 'MB Bank',
          bankBinSnapshot: '970422',
          bankAccountEncrypted: accEnc,
          bankAccountHash: wdHash,
          bankAccountMasked: '******7890',
          bankAccountNameSnapshot: 'OWNER ONE',
          status: 'PENDING',
        },
      });
      createdWithdrawalIds.push(withdrawal.withdrawalId);

      process.env.PAYOS_PAYOUT_DELEGATE_WAIT_MS = '1000';
      const queuedWd = await adminService.executePayOSPayout(withdrawal.withdrawalId, { userId: owner1.userId, role: 'SUPER_ADMIN' });
      assert.equal(queuedWd.status, 'PROCESSING');
      assert.equal(payoutCalls.length, beforePayouts, 'Render must enqueue withdrawal instead of calling PayOS directly');

      // Simulate Node-3 coming online
      process.env.PAYOS_PAYOUT_WORKER_ENABLED = 'true';
      process.env.PAYOS_PAYOUT_DELEGATE_TO_WORKER = 'false';
      await outboxConsumer.processPendingEvents(10);
      await withdrawalWorker.processOutboxDispatchBatch(10);

      const depRefundDone = await prisma.depositRefund.findUnique({ where: { refundId: depRefund.refundId } });
      const wdDone = await prisma.storeWithdrawal.findUnique({ where: { withdrawalId: withdrawal.withdrawalId } });
      assert.equal(depRefundDone?.status, 'REFUNDED');
      assert.ok(wdDone?.providerPayoutId, 'Node-3 worker must dispatch queued STORE_WITHDRAWAL_PAYOUT');
      assert.equal(payoutCalls.length, beforePayouts + 2);
    });

    // T4: Store Subscription Hiding, Blocked Customer Guard, IoT Missed-Order Notification + Zero Residue (Ý 4 & Ý 5)
    await testCase('T4: Expired store hidden from catalog, blocks ordering & notifies customer+owner on IoT press with zero idempotency residue', async () => {
      // Visibility checks
      const storesRes = await storesService.listActiveStores({ search: tag, page: 1, pageSize: 20 });
      const returnedIds = storesRes.items.map((s: any) => s.storeId);
      assert.ok(returnedIds.includes(store1.storeId.toString()), 'Active-sub store must be visible');
      assert.ok(!returnedIds.includes(store2.storeId.toString()), 'Expired-sub store MUST be hidden');

      await assert.rejects(() => storesService.getStoreById(store2.storeId.toString()), NotFoundException);

      const publicProds = await productsRepo.findMany(undefined, { search: tag, onlyActivePublic: true });
      const publicProdIds = publicProds.items.map((p: any) => p.productId.toString());
      assert.ok(publicProdIds.includes(prod1.productId.toString()));
      assert.ok(!publicProdIds.includes(prod2.productId.toString()));

      const storefrontCatalog = await productsRepo.findStorefrontCatalog({ search: tag });
      assert.ok(storefrontCatalog.some((p: any) => p.productId === prod1.productId));
      assert.ok(!storefrontCatalog.some((p: any) => p.productId === prod2.productId));

      await assert.rejects(() => productsService.getById(prod2.productId.toString(), custActor), NotFoundException);
      const ownerView = await productsService.getById(prod2.productId.toString(), owner2Actor);
      assert.equal(ownerView?.productId, prod2.productId.toString(), 'Store owner can still inspect own product to renew');

      // Storefront order on expired store blocked
      await assert.rejects(
        () =>
          ordersRepo.createStorefrontOrderTx({
            storeId: store2.storeId,
            items: [{ productId: prod2.productId.toString(), quantity: 1 }],
            customerName: 'Cust',
            customerPhone: '0909111222',
            deliveryAddress: '200 Le Loi',
            paymentMethod: 'COD',
            customerUserId: custUser.userId,
          }),
        (err: any) => err instanceof BadRequestException && (err.getResponse() as any)?.errorCode === 'STORE_SUBSCRIPTION_EXPIRED',
      );

      // Strict mode blocks 0-subscription store3 too
      process.env.ENFORCE_STORE_SUBSCRIPTION_STRICT = 'true';
      try {
        const strictStores = await storesService.listActiveStores({ search: tag, page: 1, pageSize: 20 });
        assert.ok(!strictStores.items.some((s: any) => s.storeId === store3.storeId.toString()));
      } finally {
        delete process.env.ENFORCE_STORE_SUBSCRIPTION_STRICT;
      }

      // Blocked customer check on store1
      await prisma.storeCustomer.upsert({
        where: { uq_store_customer: { storeId: store1.storeId, customerId: custProfile.customerId } },
        update: { status: 'BLOCKED' },
        create: { storeId: store1.storeId, customerId: custProfile.customerId, status: 'BLOCKED' },
      });
      await assert.rejects(
        () =>
          ordersRepo.createStorefrontOrderTx({
            storeId: store1.storeId,
            items: [{ productId: prod1.productId.toString(), quantity: 1 }],
            customerName: 'Cust',
            customerPhone: '0909111222',
            deliveryAddress: '100 Nguyen Hue',
            paymentMethod: 'COD',
            customerUserId: custUser.userId,
          }),
        ForbiddenException,
      );
      await prisma.storeCustomer.update({
        where: { uq_store_customer: { storeId: store1.storeId, customerId: custProfile.customerId } },
        data: { status: 'ACTIVE' },
      });

      // IoT button press on Store 2 (expired subscription) -> notifies customer & owner + leaves zero idempotency residue
      const btn2 = await prisma.ioTButton.create({
        data: {
          storeId: store2.storeId,
          customerId: custProfile.customerId,
          addressId: custAddr.addressId,
          deviceId: `${tag}_BTN_EXP`,
          buttonCode: `${tag}_BTN_EXP`,
          buttonName: 'Nút Nước Hết Hạn',
          status: 'ACTIVE',
          inventoryState: 'IN_CUSTOMER_CUSTODY',
          canOrder: true,
          hmacSecret: 'sec_test_1234',
        },
      });
      createdButtonIds.push(btn2.buttonId);
      await prisma.buttonProduct.create({
        data: { buttonId: btn2.buttonId, productId: prod2.productId, quantity: 1 },
      });

      const iotService = new IotService(prisma as any, ordersService);
      const reqIdExp = `req_exp_${tag}`;
      await assert.rejects(
        () =>
          iotService.handleEvent(btn2, {
            eventType: 'SINGLE_PRESS',
            requestId: reqIdExp,
            paymentMethod: 'COD',
          }),
        (err: any) => err instanceof BadRequestException && (err.getResponse() as any)?.errorCode === 'STORE_SUBSCRIPTION_EXPIRED',
      );

      const residue = await prisma.iotIdempotencyKey.findFirst({
        where: { deviceId: btn2.buttonId, requestId: reqIdExp },
      });
      assert.equal(residue, null, 'iot_idempotency_keys must have ZERO residue on expired store rejection');

      const custNotif = await prisma.notification.findFirst({
        where: { userId: custUser.userId, type: 'ORDER_REJECTED_STORE_INACTIVE' },
        orderBy: { createdAt: 'desc' },
      });
      const ownerNotif = await prisma.notification.findFirst({
        where: { userId: owner2.userId, type: 'STORE_MISSED_IOT_ORDER' },
        orderBy: { createdAt: 'desc' },
      });
      assert.ok(custNotif, 'Customer notification must be created on expired store IoT press');
      assert.ok(ownerNotif, 'Store owner missed-order notification must be created on expired store IoT press');

      // Ý 5: simulateButtonPress rejects rental in status PAID
      const pkgPaid = await prisma.rentalPackage.create({
        data: {
          packageCode: `${tag}_PKGP`,
          packageName: 'Pkg Paid Check',
          buttonQuantity: 1,
          monthlyPrice: 30000,
          depositFee: 100000,
          isActive: true,
        },
      });
      createdPackageIds.push(pkgPaid.packageId);
      const rentalPaid = await prisma.buttonRental.create({
        data: {
          rentalCode: `${tag}_RPAID`,
          customerId: custProfile.customerId,
          packageId: pkgPaid.packageId,
          monthsRented: 1,
          totalRentAmount: 30000,
          depositAmount: 100000,
          status: 'PAID',
          startDate: now,
          endDate: new Date(now.getTime() + 30 * 86_400_000),
          effectiveExpiresAt: new Date(now.getTime() + 30 * 86_400_000),
        },
      });
      createdRentalIds.push(rentalPaid.rentalId);
      const btnPaid = await prisma.ioTButton.create({
        data: {
          storeId: store1.storeId,
          customerId: custProfile.customerId,
          rentalId: rentalPaid.rentalId,
          deviceId: `${tag}_BTN_PAID`,
          buttonCode: `${tag}_BTN_PAID`,
          buttonName: 'Btn Paid Rental',
          status: 'ACTIVE',
          inventoryState: 'IN_CUSTOMER_CUSTODY',
          canOrder: true,
          hmacSecret: 'sec_paid_123',
        },
      });
      createdButtonIds.push(btnPaid.buttonId);
      await prisma.buttonProduct.create({
        data: { buttonId: btnPaid.buttonId, productId: prod1.productId, quantity: 1 },
      });

      await assert.rejects(
        () => ordersService.simulateButtonPress({ buttonId: btnPaid.buttonId.toString() } as any, custActor),
        BadRequestException,
      );
    });

    // T5: Button Rental PENDING_HANDOVER Guards & Pre-Handover Cancel + 100% Deposit Refund (Ý 6)
    await testCase('T5: PENDING_HANDOVER blocks return request; pre-handover cancel releases button & creates 100% DepositRefund', async () => {
      const pkg6 = await prisma.rentalPackage.create({
        data: {
          packageCode: `${tag}_PKG6`,
          packageName: 'Pkg 6',
          buttonQuantity: 1,
          monthlyPrice: 30000,
          depositFee: 100000,
          isActive: true,
        },
      });
      createdPackageIds.push(pkg6.packageId);

      const rental6 = await prisma.buttonRental.create({
        data: {
          rentalCode: `${tag}_R6`,
          customerId: custProfile.customerId,
          packageId: pkg6.packageId,
          fulfillmentStoreId: store1.storeId,
          monthsRented: 1,
          totalRentAmount: 30000,
          depositAmount: 100000,
          buttonQuantity: 1,
          depositPerButton: 100000,
          rentPerButton: 30000,
          monthlyRentPerButtonSnapshot: 30000,
          pricingReviewRequired: false,
          status: 'PENDING_HANDOVER',
          startDate: now,
          endDate: new Date(now.getTime() + 30 * 86_400_000),
        },
      });
      createdRentalIds.push(rental6.rentalId);

      await prisma.rentalDeposit.create({
        data: {
          rentalId: rental6.rentalId,
          collectedAmount: 100000,
          heldAmount: 100000,
          refundReservedAmount: 0,
          refundedAmount: 0,
        },
      });

      const btn6 = await prisma.ioTButton.create({
        data: {
          storeId: store1.storeId,
          custodyStoreId: store1.storeId,
          rentalId: rental6.rentalId,
          deviceId: `${tag}_BTN6`,
          buttonCode: `${tag}_BTN6`,
          buttonName: 'Btn Pending Handover',
          status: 'INACTIVE',
          inventoryState: 'ASSIGNED_TO_RENTAL',
          canOrder: false,
          hmacSecret: 'sec_btn6',
        },
      });
      createdButtonIds.push(btn6.buttonId);

      // Customer MUST NOT be able to request return while PENDING_HANDOVER / ASSIGNED_TO_RENTAL
      await assert.rejects(
        () => rentalsService.createReturnRequest(rental6.rentalId.toString(), btn6.buttonId.toString(), custActor),
        BadRequestException,
      );

      // Pre-handover cancel releases button to ALLOCATED_TO_STORE & creates 100% PENDING_APPROVAL DepositRefund
      const cancelRes = await rentalsService.cancelRentalBeforeHandover(
        rental6.rentalId.toString(),
        custActor,
        'Khach huy truoc khi nhan nut',
      );
      assert.equal(cancelRes.rental.status, 'CANCELLED');
      assert.ok(cancelRes.depositRefund, '100% DepositRefund must be created');
      assert.equal(Number(cancelRes.depositRefund?.amount), 100000);
      assert.equal(cancelRes.depositRefund?.status, 'PENDING_APPROVAL');

      const releasedBtn = await prisma.ioTButton.findUnique({ where: { buttonId: btn6.buttonId } });
      assert.equal(releasedBtn?.inventoryState, 'ALLOCATED_TO_STORE');
      assert.equal(releasedBtn?.rentalId, null);
      assert.equal(releasedBtn?.canOrder, false);
    });

    // T6: Cancel Order Auto-Cancels Remote PayOS Link (Ý 7)
    await testCase('T6: Cancelling unpaid PAYOS order marks DB transaction CANCELLED & cancels remote PayOS link', async () => {
      const order7 = await ordersRepo.createStorefrontOrderTx({
        storeId: store1.storeId,
        items: [{ productId: prod1.productId.toString(), quantity: 1 }],
        customerName: 'Cust',
        customerPhone: '0909111222',
        deliveryAddress: '100 Nguyen Hue',
        paymentMethod: 'PAYOS',
        customerUserId: custUser.userId,
      });
      createdOrderIds.push(order7.orderId);
      const link7 = await paymentsService.createPayosPaymentLink({ orderId: order7.orderId.toString() }, custActor);
      const countBefore = cancelledRemoteLinks.length;

      const cancelled = await ordersService.cancelOrder(order7.orderId.toString(), 'Doi y khong mua nua', custActor);
      assert.equal(cancelled.orderStatus, 'CANCELLED');

      const pt7 = await prisma.paymentTransaction.findUnique({
        where: { paymentTransactionId: BigInt(link7.data.paymentTransactionId) },
      });
      assert.equal(pt7?.status, 'CANCELLED');
      assert.ok(
        cancelledRemoteLinks.slice(countBefore).some((c) => c.linkId === link7.data.paymentLinkId),
        'Remote PayOS link must be cancelled on order cancellation',
      );
    });
  } finally {
    // Restore env
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;
    if (prevStrictSub === undefined) delete process.env.ENFORCE_STORE_SUBSCRIPTION_STRICT;
    else process.env.ENFORCE_STORE_SUBSCRIPTION_STRICT = prevStrictSub;
    if (prevPayoutWorkerEnabled === undefined) delete process.env.PAYOS_PAYOUT_WORKER_ENABLED;
    else process.env.PAYOS_PAYOUT_WORKER_ENABLED = prevPayoutWorkerEnabled;
    if (prevPayoutDelegate === undefined) delete process.env.PAYOS_PAYOUT_DELEGATE_TO_WORKER;
    else process.env.PAYOS_PAYOUT_DELEGATE_TO_WORKER = prevPayoutDelegate;
    if (prevPayoutWait === undefined) delete process.env.PAYOS_PAYOUT_DELEGATE_WAIT_MS;
    else process.env.PAYOS_PAYOUT_DELEGATE_WAIT_MS = prevPayoutWait;
    if (prevPayosClientId === undefined) delete process.env.PAYOS_CLIENT_ID;
    else process.env.PAYOS_CLIENT_ID = prevPayosClientId;
    if (prevPayosApiKey === undefined) delete process.env.PAYOS_API_KEY;
    else process.env.PAYOS_API_KEY = prevPayosApiKey;
    if (prevPayosChecksum === undefined) delete process.env.PAYOS_CHECKSUM_KEY;
    else process.env.PAYOS_CHECKSUM_KEY = prevPayosChecksum;
    if (prevPayosMock === undefined) delete process.env.PAYOS_MOCK_PAYMENT;
    else process.env.PAYOS_MOCK_PAYMENT = prevPayosMock;

    // Scoped reverse-dependency cleanup (zero residue)
    try {
      if (createdOutboxIds.length) {
        await prisma.outboxEvent.deleteMany({ where: { id: { in: createdOutboxIds } } });
      }
      if (createdStoreIds.length) {
        await prisma.outboxEvent.deleteMany({
          where: { eventType: 'STORE_WITHDRAWAL_PAYOUT' },
        });
      }
      if (createdOrderIds.length) {
        await prisma.paymentRefundPayoutAttempt.deleteMany({
          where: { obligation: { orderId: { in: createdOrderIds } } },
        });
        await prisma.paymentRefundObligation.deleteMany({ where: { orderId: { in: createdOrderIds } } });
        await prisma.paymentOrderReceipt.deleteMany({ where: { orderId: { in: createdOrderIds } } });
        await prisma.paymentTransaction.deleteMany({ where: { orderId: { in: createdOrderIds } } });
        await prisma.orderStatusHistory.deleteMany({ where: { orderId: { in: createdOrderIds } } });
        await prisma.orderItem.deleteMany({ where: { orderId: { in: createdOrderIds } } });
        await prisma.order.deleteMany({ where: { orderId: { in: createdOrderIds } } });
      }
      if (createdWithdrawalIds.length) {
        await prisma.storeWithdrawal.deleteMany({ where: { withdrawalId: { in: createdWithdrawalIds } } });
      }
      if (createdRentalIds.length) {
        await prisma.deviceMovement.deleteMany({ where: { rentalId: { in: createdRentalIds } } });
        await prisma.depositRefund.deleteMany({ where: { rentalId: { in: createdRentalIds } } });
        await prisma.rentalDeposit.deleteMany({ where: { rentalId: { in: createdRentalIds } } });
        await prisma.rentalAuditLog.deleteMany({ where: { targetId: { in: createdRentalIds }, targetType: 'RENTAL' } });
      }
      if (createdButtonIds.length) {
        await prisma.iotIdempotencyKey.deleteMany({ where: { deviceId: { in: createdButtonIds } } });
        await prisma.buttonProduct.deleteMany({ where: { buttonId: { in: createdButtonIds } } });
        await prisma.ioTButton.deleteMany({ where: { buttonId: { in: createdButtonIds } } });
      }
      if (createdRentalIds.length) {
        await prisma.buttonRental.deleteMany({ where: { rentalId: { in: createdRentalIds } } });
      }
      if (createdPackageIds.length) {
        await prisma.rentalPackage.deleteMany({ where: { packageId: { in: createdPackageIds } } });
      }
      if (createdStoreIds.length) {
        await prisma.storeCustomer.deleteMany({ where: { storeId: { in: createdStoreIds } } });
        await prisma.storeWallet.deleteMany({ where: { storeId: { in: createdStoreIds } } });
        await prisma.storeSubscription.deleteMany({ where: { storeId: { in: createdStoreIds } } });
      }
      if (createdProductIds.length) {
        await prisma.inventory.deleteMany({ where: { productId: { in: createdProductIds } } });
        await prisma.product.deleteMany({ where: { productId: { in: createdProductIds } } });
      }
      if (createdCategoryIds.length) {
        await prisma.category.deleteMany({ where: { categoryId: { in: createdCategoryIds } } });
      }
      if (createdStoreIds.length) {
        await prisma.store.deleteMany({ where: { storeId: { in: createdStoreIds } } });
      }
      if (createdPlanIds.length) {
        await prisma.subscriptionPlan.deleteMany({ where: { planId: { in: createdPlanIds } } });
      }
      if (createdUserIds.length) {
        await prisma.notification.deleteMany({ where: { userId: { in: createdUserIds } } });
        await prisma.customerBankAccount.deleteMany({ where: { customer: { userId: { in: createdUserIds } } } });
        await prisma.customerAddress.deleteMany({ where: { customer: { userId: { in: createdUserIds } } } });
        await prisma.customerProfile.deleteMany({ where: { userId: { in: createdUserIds } } });
        await prisma.user.deleteMany({ where: { userId: { in: createdUserIds } } });
      }
    } catch (cleanupErr: any) {
      console.warn('Cleanup warning:', cleanupErr?.message);
    }

    await prisma.$disconnect();
  }

  const passedCount = outcomes.filter((o) => o.passed).length;
  const failedCount = outcomes.length - passedCount;
  console.log(`\n=== SUMMARY: ${passedCount} PASSED, ${failedCount} FAILED ===`);
  process.exit(failedCount > 0 ? 1 : 0);
}

runSuite().catch((err) => {
  console.error('Fatal suite error:', err);
  process.exit(1);
});
