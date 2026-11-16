import { PrismaService } from '../src/prisma/prisma.service';
import { StoreSubscriptionsRepository } from '../src/store-subscriptions/store-subscriptions.repository';
import { StoreSubscriptionsService } from '../src/store-subscriptions/store-subscriptions.service';
import { StoreSubscriptionsController } from '../src/store-subscriptions/store-subscriptions.controller';
import { StoreWalletService } from '../src/store-wallet/store-wallet.service';
import { PayOSPayoutService } from '../src/payments/payos-payout.service';
import { BillingChargesRepository, VerifiedPaymentReceipt } from '../src/billing-charges/billing-charges.repository';
import { BillingChargesService } from '../src/billing-charges/billing-charges.service';
import { NotFoundException, BadRequestException } from '@nestjs/common';

async function runDynamicStoreSubscriptionPayosTests() {
  console.log('================================================================');
  console.log('🚀 TEST SUITE: Dynamic Store Subscription PayOS Checkout & Settlement');
  console.log('================================================================\n');

  process.env.NODE_ENV = 'test';
  const prisma = new PrismaService();
  await prisma.$connect();

  const payosPayoutService = new PayOSPayoutService();
  const walletService = new StoreWalletService(prisma, payosPayoutService);
  const subscriptionsRepo = new StoreSubscriptionsRepository(prisma);
  const subscriptionsService = new StoreSubscriptionsService(subscriptionsRepo, walletService);
  const billingRepo = new BillingChargesRepository(prisma);
  const billingService = new BillingChargesService(billingRepo, prisma as any);
  const controller = new StoreSubscriptionsController(subscriptionsService, billingService);

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, testName: string, detail?: string) {
    if (condition) {
      console.log(`  ✔ [PASS] ${testName}`);
      passed++;
    } else {
      console.error(`  ✘ [FAIL] ${testName}${detail ? ` -> ${detail}` : ''}`);
      failed++;
    }
  }

  const cleanupPlanIds: bigint[] = [];
  const cleanupStoreIds: bigint[] = [];
  const cleanupUserIds: bigint[] = [];
  const cleanupChargeIds: bigint[] = [];
  const cleanupSubIds: bigint[] = [];

  try {
    // 0. Setup test store & user
    const testUsername = `sub_owner_${Date.now()}`;
    const testUser = await prisma.user.create({
      data: {
        username: testUsername,
        fullName: 'Test Subscription Store Owner',
        email: `${testUsername}@example.com`,
        status: 'ACTIVE',
      },
    });
    cleanupUserIds.push(testUser.userId);

    const testStore = await prisma.store.create({
      data: {
        name: `Test Dynamic Sub Store ${Date.now()}`,
        code: `STR_SUB_${Date.now()}`,
        phone: '0901234567',
        address: '123 Subscription St',
        ownerUserId: testUser.userId,
        status: 'ACTIVE',
      },
    });
    cleanupStoreIds.push(testStore.storeId);

    // Create test plans:
    // 1. Free plan (0đ)
    const freePlan = await prisma.subscriptionPlan.create({
      data: {
        planCode: `PLAN_FREE_${Date.now()}`,
        planName: 'Gói Miễn Phí Test',
        price: 0,
        durationDays: 30,
        maxProducts: 10,
        isActive: true,
      },
    });
    cleanupPlanIds.push(freePlan.planId);

    // 2. Inactive plan
    const inactivePlan = await prisma.subscriptionPlan.create({
      data: {
        planCode: `PLAN_INACTIVE_${Date.now()}`,
        planName: 'Gói Tạm Dừng Test',
        price: 50000,
        durationDays: 30,
        maxProducts: 50,
        isActive: false,
      },
    });
    cleanupPlanIds.push(inactivePlan.planId);

    // 3. Below PayOS minimum plan (1.000đ)
    const lowPricePlan = await prisma.subscriptionPlan.create({
      data: {
        planCode: `PLAN_LOW_${Date.now()}`,
        planName: 'Gói Dưới 2k Test',
        price: 1000,
        durationDays: 7,
        maxProducts: 5,
        isActive: true,
      },
    });
    cleanupPlanIds.push(lowPricePlan.planId);

    // 4. Valid 2.000đ plan (PayOS minimum)
    const minPayosPlan = await prisma.subscriptionPlan.create({
      data: {
        planCode: `PLAN_2K_${Date.now()}`,
        planName: 'Gói Khởi Động 2.000đ',
        price: 2000,
        durationDays: 14,
        maxProducts: 25,
        isActive: true,
      },
    });
    cleanupPlanIds.push(minPayosPlan.planId);

    // 5. Valid 30.000đ / 90 days plan
    const customPlan = await prisma.subscriptionPlan.create({
      data: {
        planCode: `PLAN_30K_${Date.now()}`,
        planName: 'Gói Quý 30.000đ',
        price: 30000,
        durationDays: 90,
        maxProducts: 200,
        isActive: true,
      },
    });
    cleanupPlanIds.push(customPlan.planId);

    console.log('\n--- Test 1: Plan Validation Invariants (Zero Client Trust) ---');

    // 1.1 Non-existent plan throws 404
    try {
      await subscriptionsService.getPlanForCheckout(BigInt(999999999));
      assert(false, '1.1 Non-existent plan throws NotFoundException');
    } catch (err: any) {
      assert(err instanceof NotFoundException, '1.1 Non-existent plan throws NotFoundException', err.message);
    }

    // 1.2 Inactive plan throws 400
    try {
      await subscriptionsService.getPlanForCheckout(inactivePlan.planId);
      assert(false, '1.2 Inactive plan throws BadRequestException');
    } catch (err: any) {
      assert(
        err instanceof BadRequestException && err.message.includes('tạm dừng'),
        '1.2 Inactive plan throws BadRequestException with clear reason',
        err.message,
      );
    }

    // 1.3 0 VND plan throws 400 with guidance
    try {
      await subscriptionsService.getPlanForCheckout(freePlan.planId);
      assert(false, '1.3 0 VND plan throws BadRequestException');
    } catch (err: any) {
      assert(
        err instanceof BadRequestException && err.message.includes('miễn phí'),
        '1.3 0 VND plan throws BadRequestException with guidance to free flow',
        err.message,
      );
    }

    // 1.4 Plan < 2.000 VND throws 400 with PayOS minimum notice
    try {
      await subscriptionsService.getPlanForCheckout(lowPricePlan.planId);
      assert(false, '1.4 Plan < 2000 VND throws BadRequestException');
    } catch (err: any) {
      assert(
        err instanceof BadRequestException && err.message.includes('2.000đ'),
        '1.4 Plan < 2000 VND throws BadRequestException with PayOS minimum note',
        err.message,
      );
    }

    // 1.5 Valid 2.000đ plan returns plan details
    const valid2k = await subscriptionsService.getPlanForCheckout(minPayosPlan.planId);
    assert(
      Number(valid2k.price) === 2000 && valid2k.durationDays === 14,
      '1.5 Valid 2.000đ plan successfully fetched from database',
    );

    // 1.6 Valid 30.000đ plan returns plan details
    const valid30k = await subscriptionsService.getPlanForCheckout(customPlan.planId);
    assert(
      Number(valid30k.price) === 30000 && valid30k.durationDays === 90,
      '1.6 Valid 30.000đ / 90 days plan successfully fetched from database',
    );

    console.log('\n--- Test 2: Dynamic Charge Creation & Snapshot Immutability ---');

    // 2.1 Create charge for 30.000đ / 90 days plan
    const charge = await billingService.createStoreSubscriptionCharge({
      storeId: testStore.storeId,
      planId: customPlan.planId,
      planCode: customPlan.planCode,
      planName: customPlan.planName,
      amount: Number(customPlan.price),
      durationDays: customPlan.durationDays,
      maxProducts: customPlan.maxProducts,
    });
    cleanupChargeIds.push(charge.chargeId);

    assert(
      Number(charge.totalAmount) === 30000 && charge.purpose === 'STORE_SUBSCRIPTION',
      '2.1 Charge created with exact plan price (30.000đ)',
    );

    // Verify raw DB columns
    const rawCharge = await prisma.billingCharge.findUnique({
      where: { chargeId: charge.chargeId },
    });
    assert(
      rawCharge?.planId === customPlan.planId,
      '2.2 rawCharge.planId correctly recorded in database',
    );

    const snapshot = rawCharge?.planSnapshot as any;
    assert(
      snapshot &&
      snapshot.planId === customPlan.planId.toString() &&
      snapshot.price === 30000 &&
      snapshot.durationDays === 90 &&
      snapshot.maxProducts === 200,
      '2.3 planSnapshot contains complete plan snapshot at checkout creation time',
    );

    // 2.4 Immutability test: Modify plan in DB, verify charge snapshot remains unchanged
    await prisma.subscriptionPlan.update({
      where: { planId: customPlan.planId },
      data: {
        price: 99000,
        durationDays: 10,
        maxProducts: 1,
        isActive: false,
      },
    });

    const refreshedCharge = await prisma.billingCharge.findUnique({
      where: { chargeId: charge.chargeId },
    });
    const refreshedSnapshot = refreshedCharge?.planSnapshot as any;
    assert(
      refreshedSnapshot.price === 30000 &&
      refreshedSnapshot.durationDays === 90 &&
      refreshedSnapshot.maxProducts === 200,
      '2.4 Modifying or disabling plan in database does NOT mutate existing charge snapshot',
    );

    console.log('\n--- Test 3: Webhook Settlement & Entitlement Granting ---');

    // 3.1 Settle the 30.000đ charge via verified receipt
    const receipt: VerifiedPaymentReceipt = {
      provider: 'PAYOS',
      providerTransactionCode: `TX-PAYOS-${Date.now()}`,
      amount: 30000,
      currency: 'VND',
      verified: true,
      paidAt: new Date(),
    };

    const settlementResult = await billingRepo.settleChargeAtomicTx(charge.chargeId, receipt);
    assert(
      settlementResult.charge?.status === 'PAID',
      '3.1 Charge status transitioned to PAID after settlement',
    );

    // Verify subscription created
    const createdSub = await prisma.storeSubscription.findFirst({
      where: {
        storeId: testStore.storeId,
        planId: customPlan.planId,
        status: 'ACTIVE',
      },
      orderBy: { subscriptionId: 'desc' },
    });
    if (createdSub) cleanupSubIds.push(createdSub.subscriptionId);

    assert(Boolean(createdSub), '3.2 StoreSubscription record created for store');

    if (createdSub) {
      const startMs = new Date(createdSub.startDate).getTime();
      const endMs = new Date(createdSub.endDate).getTime();
      const grantedDays = Math.round((endMs - startMs) / (24 * 60 * 60 * 1000));

      assert(
        grantedDays === 90,
        `3.3 Granted duration matches snapshot duration (90 days vs ${grantedDays} days, NOT hardcoded 30 days)`,
      );
      assert(
        createdSub.planId === customPlan.planId,
        '3.4 Granted planId matches snapshot planId (NOT hardcoded 60k plan)',
      );
    }

    console.log('\n--- Test 4: Idempotency & Replay Attack Defense ---');

    // 4.1 Replaying the exact same settlement
    const replayResult = await billingRepo.settleChargeAtomicTx(charge.chargeId, receipt);
    assert(
      (replayResult as any).alreadySettled === true,
      '4.1 Webhook replay returns alreadySettled: true idempotently',
    );

    // Verify no duplicate subscription was created
    const subsCount = await prisma.storeSubscription.count({
      where: {
        storeId: testStore.storeId,
        planId: customPlan.planId,
      },
    });
    assert(
      subsCount === 1,
      '4.2 Webhook replay does NOT create duplicate StoreSubscription records',
    );

    console.log('\n--- Test 5: Legacy Historical Fallback Protection ---');

    // 5.1 Create a legacy charge with NO plan_id and NO plan_snapshot
    const legacyCharge = await prisma.billingCharge.create({
      data: {
        chargeCode: `CHG-LEGACY-${Date.now()}`,
        purpose: 'STORE_SUBSCRIPTION',
        targetType: 'STORE',
        targetId: testStore.storeId,
        payerStoreId: testStore.storeId,
        currency: 'VND',
        totalAmount: 2000,
        status: 'PENDING',
        paymentMethod: 'PAYOS',
        lines: {
          create: [
            {
              lineType: 'STORE_SUBSCRIPTION',
              amount: 2000,
              description: 'Legacy Store Subscription Charge',
              quantity: 1,
              unitPrice: 2000,
            },
          ],
        },
      },
    });
    cleanupChargeIds.push(legacyCharge.chargeId);

    const legacyReceipt: VerifiedPaymentReceipt = {
      provider: 'PAYOS',
      providerTransactionCode: `TX-LEGACY-${Date.now()}`,
      amount: 2000,
      currency: 'VND',
      verified: true,
      paidAt: new Date(),
    };

    const legacySettlement = await billingRepo.settleChargeAtomicTx(legacyCharge.chargeId, legacyReceipt);
    assert(
      legacySettlement.charge?.status === 'PAID',
      '5.1 Legacy charge settles safely using fallback mechanism',
    );

    const legacySub = await prisma.storeSubscription.findFirst({
      where: {
        storeId: testStore.storeId,
        status: 'ACTIVE',
      },
      orderBy: { subscriptionId: 'desc' },
    });
    if (legacySub) cleanupSubIds.push(legacySub.subscriptionId);
    assert(
      Boolean(legacySub),
      '5.2 Legacy charge safely grants fallback subscription without runtime crash',
    );

  } catch (err: any) {
    console.error('Unexpected test error:', err);
    failed++;
  } finally {
    console.log('\n--- Cleaning up test artifacts ---');
    if (cleanupSubIds.length > 0) {
      await prisma.storeSubscription.deleteMany({ where: { subscriptionId: { in: cleanupSubIds } } }).catch(() => {});
    }
    if (cleanupChargeIds.length > 0) {
      await prisma.billingChargeLine.deleteMany({ where: { chargeId: { in: cleanupChargeIds } } }).catch(() => {});
      await prisma.billingCharge.deleteMany({ where: { chargeId: { in: cleanupChargeIds } } }).catch(() => {});
    }
    if (cleanupPlanIds.length > 0) {
      await prisma.subscriptionPlan.deleteMany({ where: { planId: { in: cleanupPlanIds } } }).catch(() => {});
    }
    if (cleanupStoreIds.length > 0) {
      await prisma.store.deleteMany({ where: { storeId: { in: cleanupStoreIds } } }).catch(() => {});
    }
    if (cleanupUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { userId: { in: cleanupUserIds } } }).catch(() => {});
    }
    await prisma.$disconnect();
  }

  console.log('\n================================================================');
  console.log(`Dynamic Store Subscription PayOS Test Summary: ${passed} PASSED | ${failed} FAILED`);
  console.log('================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runDynamicStoreSubscriptionPayosTests().catch((e) => {
  console.error('Fatal test runner error:', e);
  process.exit(1);
});
