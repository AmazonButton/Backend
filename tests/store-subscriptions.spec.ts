import { PrismaService } from '../src/prisma/prisma.service';
import { StoreSubscriptionsService } from '../src/store-subscriptions/store-subscriptions.service';
import { StoreSubscriptionsRepository } from '../src/store-subscriptions/store-subscriptions.repository';
import { StoreWalletService } from '../src/store-wallet/store-wallet.service';
import { ConflictException } from '@nestjs/common';

async function testStoreSubscriptions() {
  console.log('Testing Store Subscription Isolation & Idempotency Enforcement (Zero Residue)...');
  const prisma = new PrismaService();
  await prisma.$connect();

  const walletService = new StoreWalletService(prisma);
  const subRepo = new StoreSubscriptionsRepository(prisma);
  const subService = new StoreSubscriptionsService(subRepo, walletService);

  let failed = 0;
  const testRunId = Date.now();

  // Test entities to track for strict, non-silent zero-residue cleanup by exact IDs
  let testUser: any = null;
  let testStore: any = null;
  let testWallet: any = null;
  let planA: any = null;
  let planB: any = null;
  const trackedSubscriptionIds: bigint[] = [];
  const trackedTransactionIds: bigint[] = [];

  try {
    // 1. Setup isolated Test User & Store (never touches production/real stores)
    testUser = await prisma.user.create({
      data: {
        username: `test_sub_owner_${testRunId}`,
        email: `test_sub_owner_${testRunId}@example.com`,
        passwordHash: '$2b$12$' + 'e'.repeat(53), // bcrypt cost 12
        fullName: `Test Sub Owner ${testRunId}`,
        phone: `090${String(testRunId).slice(-7)}`,
        status: 'ACTIVE',
      },
    });

    testStore = await prisma.store.create({
      data: {
        ownerUserId: testUser.userId,
        name: `Isolated Test Store ${testRunId}`,
        code: `STR_SUB_${testRunId}`,
        phone: testUser.phone,
        address: '123 Isolated Test Street, District 1, HCMC',
        status: 'ACTIVE',
      },
    });
    console.log(`  [SETUP] Created isolated test store: ${testStore.name} (ID: ${testStore.storeId})`);

    // 2. Setup isolated Test Wallet with 3,000,000 initial balance to support multiple purchases
    testWallet = await walletService.getOrCreateStoreWallet(testStore.storeId);
    await prisma.storeWallet.update({
      where: { walletId: testWallet.walletId },
      data: { balance: 3000000 },
    });
    console.log(`  [SETUP] Created isolated wallet (ID: ${testWallet.walletId}) with balance 3,000,000`);

    // 3. Create two test subscription plans
    planA = await prisma.subscriptionPlan.create({
      data: {
        planCode: `PLN_A_${testRunId}`,
        planName: 'Gói Listing Tiêu Chuẩn Test A',
        price: 200000,
        durationDays: 30,
        maxProducts: 20,
        isActive: true,
      },
    });

    planB = await prisma.subscriptionPlan.create({
      data: {
        planCode: `PLN_B_${testRunId}`,
        planName: 'Gói Listing Nâng Cao Test B',
        price: 350000,
        durationDays: 60,
        maxProducts: 50,
        isActive: true,
      },
    });
    console.log(`  [SETUP] Created isolated plans: ${planA.planCode} and ${planB.planCode}`);

    // 4. Test Subscribe using Wallet Balance with Idempotency Key
    const idempotencyKey = `idemp_sub_${testRunId}`;
    const sub1 = await subService.subscribeWithWallet(testStore.storeId, planA.planId, idempotencyKey);
    if (sub1 && sub1.status === 'ACTIVE' && sub1.paymentMethod === 'WALLET') {
      trackedSubscriptionIds.push(BigInt(sub1.subscriptionId));
      console.log('  [PASS] subscribeWithWallet created active subscription');
    } else {
      console.error('  [FAIL] subscribeWithWallet failed to create active subscription');
      failed++;
    }

    // Verify balance was deducted exactly once (3,000,000 - 200,000 = 2,800,000)
    const walletAfterSub1 = await prisma.storeWallet.findUnique({
      where: { walletId: testWallet.walletId },
    });
    if (Number(walletAfterSub1?.balance) === 2800000) {
      console.log('  [PASS] Wallet balance correctly deducted to 2,800,000');
    } else {
      console.error(`  [FAIL] Wallet balance incorrect: expected 2800000, got ${walletAfterSub1?.balance}`);
      failed++;
    }

    // 5. Test Idempotency with exact same key and same payload -> MUST NOT double-charge
    const sub1Retry = await subService.subscribeWithWallet(testStore.storeId, planA.planId, idempotencyKey);
    const walletAfterRetry = await prisma.storeWallet.findUnique({
      where: { walletId: testWallet.walletId },
    });
    if (
      sub1Retry &&
      sub1Retry.subscriptionId.toString() === sub1.subscriptionId.toString() &&
      Number(walletAfterRetry?.balance) === 2800000
    ) {
      console.log('  [PASS] Idempotent retry returned original subscription without double deduction');
    } else {
      console.error('  [FAIL] Idempotent retry failed or double deducted balance');
      failed++;
    }

    // 6. Test Idempotency Key Reuse with DIFFERENT Payload -> MUST throw ConflictException (409)
    let caughtConflict = false;
    try {
      await subService.subscribeWithWallet(testStore.storeId, planB.planId, idempotencyKey);
    } catch (err: any) {
      if (err instanceof ConflictException && err.message.includes('IDEMPOTENCY_KEY_REUSED')) {
        caughtConflict = true;
      } else if (err.status === 409 || err.message?.includes('IDEMPOTENCY_KEY_REUSED')) {
        caughtConflict = true;
      }
    }

    if (caughtConflict) {
      console.log('  [PASS] Reusing idempotency key with different planId correctly rejected with HTTP 409 IDEMPOTENCY_KEY_REUSED');
    } else {
      console.error('  [FAIL] Reusing idempotency key with different planId did not throw ConflictException 409');
      failed++;
    }

    // 7. Test Concurrency with real Promise.all using the exact same idempotency key
    const idempConcurrentKey = `idemp_concurrent_${testRunId}`;
    const [concurrentA, concurrentB] = await Promise.all([
      subService.subscribeWithWallet(testStore.storeId, planA.planId, idempConcurrentKey),
      subService.subscribeWithWallet(testStore.storeId, planA.planId, idempConcurrentKey),
    ]);
    if (
      concurrentA &&
      concurrentB &&
      concurrentA.subscriptionId.toString() === concurrentB.subscriptionId.toString()
    ) {
      trackedSubscriptionIds.push(BigInt(concurrentA.subscriptionId));
      console.log('  [PASS] Real Promise.all concurrency: exactly 1 subscription created and returned to both callers');
    } else {
      console.error('  [FAIL] Concurrency test failed to return identical subscription');
      failed++;
    }

    // 8. Test Multiple Subscriptions: Retry keyA MUST return subscription A even after subscription B is created
    const keyOriginal = `key_original_${testRunId}`;
    const subOriginal = await subService.subscribeWithWallet(testStore.storeId, planA.planId, keyOriginal);
    trackedSubscriptionIds.push(BigInt(subOriginal.subscriptionId));

    const keyOther = `key_other_${testRunId}`;
    const subOther = await subService.subscribeWithWallet(testStore.storeId, planA.planId, keyOther);
    trackedSubscriptionIds.push(BigInt(subOther.subscriptionId));

    if (subOriginal.subscriptionId.toString() !== subOther.subscriptionId.toString()) {
      console.log('  [PASS] Distinct keys created distinct subscriptions');
    } else {
      console.error('  [FAIL] Distinct keys returned same subscription');
      failed++;
    }

    // Retry keyOriginal: must return subOriginal, NOT subOther (even though subOther is newer!)
    const retryOriginal = await subService.subscribeWithWallet(testStore.storeId, planA.planId, keyOriginal);
    if (
      retryOriginal.subscriptionId.toString() === subOriginal.subscriptionId.toString() &&
      retryOriginal.subscriptionId.toString() !== subOther.subscriptionId.toString()
    ) {
      console.log('  [PASS] Retrying original key strictly returns subscription A, NOT latest subscription B (Exact Idempotency Table)');
    } else {
      console.error(
        `  [FAIL] Retrying original key returned wrong subscription! Expected ${subOriginal.subscriptionId}, got ${retryOriginal.subscriptionId}`
      );
      failed++;
    }

    // 9. Verify getCurrentSubscription
    const current = await subService.getCurrentSubscription(testStore.storeId);
    if (current && current.plan?.planCode === planA.planCode && current.daysRemaining >= 29) {
      console.log('  [PASS] getCurrentSubscription returned active plan and days remaining');
    } else {
      console.error('  [FAIL] getCurrentSubscription failed');
      failed++;
    }

    // 10. Verify validateStoreCanListProducts
    const canList = await subService.validateStoreCanListProducts(testStore.storeId);
    if (canList === true) {
      console.log('  [PASS] validateStoreCanListProducts allowed listing within limits');
    } else {
      console.error('  [FAIL] validateStoreCanListProducts failed');
      failed++;
    }
  } catch (error: any) {
    console.error('  [FAIL] Exception during test execution:', error);
    failed++;
  } finally {
    console.log('  --- STRICT TARGETED TEARDOWN (NO SILENT CATCH) ---');
    try {
      // Clean up idempotency keys for this test store
      if (testStore?.storeId) {
        await prisma.subscriptionIdempotencyKey.deleteMany({
          where: { storeId: testStore.storeId },
        });
        console.log(`  [TEARDOWN] Purged idempotency keys for test store ID: ${testStore.storeId}.`);
      }

      // Delete wallet transactions for this test store
      if (testWallet?.walletId) {
        await prisma.walletTransaction.deleteMany({
          where: { walletId: testWallet.walletId },
        });
        console.log(`  [TEARDOWN] Deleted wallet transactions for wallet ID: ${testWallet.walletId}.`);
      }

      // Delete tracked subscriptions
      if (trackedSubscriptionIds.length > 0) {
        const deletedSubs = await prisma.storeSubscription.deleteMany({
          where: { subscriptionId: { in: trackedSubscriptionIds } },
        });
        console.log(`  [TEARDOWN] Deleted ${deletedSubs.count} tracked test store subscription(s).`);
      }

      // Delete test plans
      if (planA?.planId || planB?.planId) {
        const planIds = [planA?.planId, planB?.planId].filter(Boolean);
        const deletedPlans = await prisma.subscriptionPlan.deleteMany({
          where: { planId: { in: planIds } },
        });
        console.log(`  [TEARDOWN] Deleted ${deletedPlans.count} test subscription plan(s).`);
      }

      // Delete test wallet
      if (testWallet?.walletId) {
        await prisma.storeWallet.delete({
          where: { walletId: testWallet.walletId },
        });
        console.log(`  [TEARDOWN] Deleted test wallet ID: ${testWallet.walletId}.`);
      }

      // Delete test store
      if (testStore?.storeId) {
        await prisma.store.delete({
          where: { storeId: testStore.storeId },
        });
        console.log(`  [TEARDOWN] Deleted test store ID: ${testStore.storeId}.`);
      }

      // Delete test user
      if (testUser?.userId) {
        await prisma.user.delete({
          where: { userId: testUser.userId },
        });
        console.log(`  [TEARDOWN] Deleted test user ID: ${testUser.userId}.`);
      }

      console.log('  [ZERO RESIDUE] All isolated test artifacts cleanly purged without touching production data.');
    } catch (cleanupErr: any) {
      console.error('  [FATAL TEARDOWN ERROR]:', cleanupErr);
      failed++;
    }
    await prisma.$disconnect();
  }

  if (failed > 0) {
    console.error(`\n❌ Test completed with ${failed} failure(s).`);
    process.exit(1);
  } else {
    console.log('\n✅ All store subscription tests passed successfully!');
    process.exit(0);
  }
}

testStoreSubscriptions();
