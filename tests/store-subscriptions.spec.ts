import { PrismaService } from '../src/prisma/prisma.service';
import { StoreSubscriptionsService } from '../src/store-subscriptions/store-subscriptions.service';
import { StoreSubscriptionsRepository } from '../src/store-subscriptions/store-subscriptions.repository';
import { StoreWalletService } from '../src/store-wallet/store-wallet.service';

async function testStoreSubscriptions() {
  console.log('Testing Store Subscription Purchase & Listing Enforcement (with Zero Residue)...');
  const prisma = new PrismaService();
  await prisma.$connect();

  const walletService = new StoreWalletService(prisma);
  const subService = new StoreSubscriptionsService(new StoreSubscriptionsRepository(prisma), walletService);
  let failed = 0;

  let store: any = null;
  let wallet: any = null;
  let originalBalance: any = null;
  let plan: any = null;
  let subscription: any = null;
  const testStartTime = new Date();

  try {
    // 1. Setup a test Store with sufficient wallet balance (snapshot first)
    store = await prisma.store.findFirst();
    if (!store) throw new Error('No store found');

    wallet = await walletService.getOrCreateStoreWallet(store.storeId);
    originalBalance = wallet.balance;

    await prisma.storeWallet.update({
      where: { walletId: wallet.walletId },
      data: { balance: 500000 },
    });

    // 2. Setup a Subscription Plan
    const planCode = `SUB_TEST_${Date.now()}`;
    plan = await prisma.subscriptionPlan.create({
      data: {
        planCode,
        planName: 'Gói Listing Tiêu Chuẩn',
        price: 200000,
        durationDays: 30,
        maxProducts: 20,
        isActive: true,
      },
    });

    // 3. Subscribe using Wallet Balance
    subscription = await subService.subscribeWithWallet(store.storeId, plan.planId);
    if (
      subscription &&
      subscription.status === 'ACTIVE' &&
      subscription.paymentMethod === 'WALLET'
    ) {
      console.log('  [PASS] subscribeWithWallet created active subscription');
    } else {
      console.log('  [FAIL] subscribeWithWallet failed');
      failed++;
    }

    // Verify wallet balance deducted
    const updatedWallet = await prisma.storeWallet.findUnique({
      where: { walletId: wallet.walletId },
    });
    if (Number(updatedWallet?.balance) === 300000) {
      console.log('  [PASS] Wallet balance deducted by 200,000 VND (300,000 VND remaining)');
    } else {
      console.log(`  [FAIL] Wallet balance incorrect: ${updatedWallet?.balance}`);
      failed++;
    }

    // 4. Get Current Subscription
    const current = await subService.getCurrentSubscription(store.storeId);
    if (current && current.plan?.planCode === planCode && current.daysRemaining >= 29) {
      console.log('  [PASS] getCurrentSubscription returned active plan and days remaining');
    } else {
      console.log('  [FAIL] getCurrentSubscription failed');
      failed++;
    }

    // 5. Listing Enforcement Check
    const canList = await subService.validateStoreCanListProducts(store.storeId);
    if (canList === true) {
      console.log('  [PASS] validateStoreCanListProducts allowed listing within limits');
    } else {
      console.log('  [FAIL] validateStoreCanListProducts failed');
      failed++;
    }
  } catch (error: any) {
    console.log('  [FAIL] Exception during test execution:', error.message);
    failed++;
  } finally {
    console.log('  --- TEARDOWN & ZERO RESIDUE RESTORATION ---');
    try {
      if (subscription?.subscriptionId) {
        await prisma.storeSubscription.delete({
          where: { subscriptionId: subscription.subscriptionId },
        }).catch(() => {});
      }
      if (wallet?.walletId) {
        await prisma.walletTransaction.deleteMany({
          where: {
            walletId: wallet.walletId,
            createdAt: { gte: testStartTime },
          },
        }).catch(() => {});
        if (originalBalance !== null) {
          await prisma.storeWallet.update({
            where: { walletId: wallet.walletId },
            data: { balance: originalBalance },
          }).catch(() => {});
          console.log(`  [RESTORE] Store wallet balance restored to ${originalBalance.toString()}`);
        }
      }
      if (plan?.planId) {
        await prisma.subscriptionPlan.delete({
          where: { planId: plan.planId },
        }).catch(() => {});
      }
      console.log('  [ZERO RESIDUE] Test artifacts cleanly purged.');
    } catch (cleanupErr: any) {
      console.error('Cleanup error:', cleanupErr.message);
    }
    await prisma.$disconnect();
  }

  if (failed > 0) {
    console.error(`Store subscriptions test failed with ${failed} failures.`);
    process.exit(1);
  } else {
    console.log('All Store Subscriptions tests passed successfully!');
  }
}

testStoreSubscriptions().catch((err) => {
  console.error('Test run error:', err);
  process.exit(1);
});
