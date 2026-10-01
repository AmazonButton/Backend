import { PrismaService } from '../src/prisma/prisma.service';
import { StoreWalletService } from '../src/store-wallet/store-wallet.service';

async function testStoreWallet() {
  console.log('Testing Store Wallet & Order Revenue Settlement...');
  const prisma = new PrismaService();
  await prisma.$connect();

  const walletService = new StoreWalletService(prisma);
  let failed = 0;

  try {
    // 1. Setup a test Store
    let store = await prisma.store.findFirst();
    if (!store) {
      let owner = await prisma.user.findFirst();
      if (!owner) {
        owner = await prisma.user.create({
          data: {
            username: `store_owner_${Date.now()}`,
            email: `store_owner_${Date.now()}@example.com`,
            passwordHash: 'dummy',
            fullName: 'Owner Tester',
          },
        });
      }
      store = await prisma.store.create({
        data: {
          name: 'Wallet Test Store',
          code: `STORE_WLT_${Date.now()}`,
          phone: '0901234567',
          address: '123 Test St',
          ownerUserId: owner.userId,
        },
      });
    }

    // 2. Get or Create Store Wallet
    const wallet = await walletService.getOrCreateStoreWallet(store.storeId);
    if (wallet && wallet.storeId === store.storeId) {
      console.log('  [PASS] getOrCreateStoreWallet returned store wallet');
    } else {
      console.log('  [FAIL] getOrCreateStoreWallet failed');
      failed++;
    }

    // 3. Update Bank Account Info
    const bankDto = {
      bankName: 'Vietcombank',
      bankAccountNumber: '9876543210',
      bankAccountHolder: 'NGUYEN VAN A',
    };
    const updatedWallet = await walletService.updateBankAccount(store.storeId, bankDto);
    if (
      updatedWallet.bankName === bankDto.bankName &&
      updatedWallet.bankAccountNumber === bankDto.bankAccountNumber &&
      updatedWallet.bankAccountHolder === bankDto.bankAccountHolder
    ) {
      console.log('  [PASS] updateBankAccount persisted bank details');
    } else {
      console.log('  [FAIL] updateBankAccount failed');
      failed++;
    }

    // 4. Credit Order Revenue (Escrow settlement)
    const initialBalance = Number(updatedWallet.balance);
    const revenueAmount = 350000;
    const testOrderCode = `ORD-${Date.now()}`;

    const creditedWallet = await walletService.creditOrderRevenue(
      store.storeId,
      revenueAmount,
      testOrderCode
    );

    const expectedBalance = initialBalance + revenueAmount;
    if (Number(creditedWallet.balance) === expectedBalance) {
      console.log('  [PASS] creditOrderRevenue credited exact amount');
    } else {
      console.log(`  [FAIL] creditOrderRevenue expected ${expectedBalance}, got ${creditedWallet.balance}`);
      failed++;
    }

    // 5. Verify WalletTransaction Audit Ledger
    const transactions = await walletService.listTransactions(store.storeId);
    const foundTx = transactions.find((t: any) => t.referenceId === testOrderCode);
    if (
      foundTx &&
      Number(foundTx.amount) === revenueAmount &&
      foundTx.type === 'ORDER_REVENUE' &&
      Number(foundTx.balanceAfter) === expectedBalance
    ) {
      console.log('  [PASS] WalletTransaction ledger recorded ORDER_REVENUE with accurate balance audit');
    } else {
      console.log('  [FAIL] WalletTransaction record missing or incorrect');
      failed++;
    }
  } catch (error: any) {
    console.log('  [FAIL] Exception during test execution:', error.message);
    failed++;
  } finally {
    await prisma.$disconnect();
  }

  if (failed > 0) {
    console.error(`Store wallet test failed with ${failed} failures.`);
    process.exit(1);
  } else {
    console.log('All Store Wallet tests passed successfully!');
  }
}

testStoreWallet().catch((err) => {
  console.error('Test run error:', err);
  process.exit(1);
});
