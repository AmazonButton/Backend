import { PrismaClient } from '@prisma/client';

async function testDatabaseSchema() {
  console.log('Testing Database Schema & Prisma Delegates...');
  const prisma = new PrismaClient();
  let failed = 0;

  const delegates = [
    'subscriptionPlan',
    'storeSubscription',
    'rentalPackage',
    'buttonRental',
    'storeWallet',
    'walletTransaction',
    'storeWithdrawal',
  ];

  for (const delegate of delegates) {
    if ((prisma as any)[delegate] && typeof (prisma as any)[delegate].findMany === 'function') {
      console.log(`  [PASS] Prisma has ${delegate} delegate`);
    } else {
      console.log(`  [FAIL] Missing ${delegate} delegate on PrismaClient`);
      failed++;
    }
  }

  await prisma.$disconnect();

  if (failed > 0) {
    console.error(`Schema test failed with ${failed} missing delegates.`);
    process.exit(1);
  } else {
    console.log('All 7 Prisma delegates verified successfully!');
  }
}

testDatabaseSchema().catch((err) => {
  console.error('Test execution error:', err);
  process.exit(1);
});
