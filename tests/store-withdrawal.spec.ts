import { PrismaService } from '../src/prisma/prisma.service';
import { StoreWalletService } from '../src/store-wallet/store-wallet.service';
import { AdminService } from '../src/admin/admin.service';
import { AdminRepository } from '../src/admin/admin.repository';

async function testStoreWithdrawal() {
  console.log('Testing Store Withdrawal Flow & Admin Transfer Approval...');
  const prisma = new PrismaService();
  await prisma.$connect();

  const walletService = new StoreWalletService(prisma);
  const adminRepo = new AdminRepository(prisma);
  const adminService = new AdminService(adminRepo);
  let failed = 0;

  try {
    // 1. Setup a test store with funds
    let store = await prisma.store.findFirst();
    if (!store) throw new Error('No store found');

    const wallet = await walletService.getOrCreateStoreWallet(store.storeId);
    // Ensure store has at least 1,000,000 VND
    await prisma.storeWallet.update({
      where: { walletId: wallet.walletId },
      data: { balance: 1000000 },
    });

    // 2. Request Withdrawal of 400,000 VND
    const withdrawAmount = 400000;
    const reqDto = {
      amount: withdrawAmount,
      bankName: 'MBBank',
      bankAccountNumber: '0987654321',
      bankAccountHolder: 'CHU CUA HANG TEST',
    };

    const withdrawal = await (walletService as any).requestWithdrawal(store.storeId, reqDto);
    if (
      withdrawal &&
      Number(withdrawal.amount) === withdrawAmount &&
      withdrawal.status === 'PENDING'
    ) {
      console.log('  [PASS] requestWithdrawal created pending withdrawal record');
    } else {
      console.log('  [FAIL] requestWithdrawal failed');
      failed++;
    }

    // Check balance deducted immediately
    const walletAfterReq = await prisma.storeWallet.findUnique({
      where: { walletId: wallet.walletId },
    });
    if (Number(walletAfterReq?.balance) === 600000) {
      console.log('  [PASS] Balance deducted immediately upon withdrawal request (600,000 VND)');
    } else {
      console.log(`  [FAIL] Balance not deducted correctly: ${walletAfterReq?.balance}`);
      failed++;
    }

    // 3. Admin Rejection with Auto-Refund
    const rejected = await (adminService as any).rejectWithdrawal(
      withdrawal.withdrawalId,
      'Sai số tài khoản ngân hàng'
    );
    if (rejected && rejected.status === 'REJECTED') {
      console.log('  [PASS] Admin rejectWithdrawal set status to REJECTED');
    } else {
      console.log('  [FAIL] Admin rejectWithdrawal failed');
      failed++;
    }

    // Verify refund back to 1,000,000 VND
    const walletAfterRefund = await prisma.storeWallet.findUnique({
      where: { walletId: wallet.walletId },
    });
    if (Number(walletAfterRefund?.balance) === 1000000) {
      console.log('  [PASS] Auto-refund restored balance back to 1,000,000 VND');
    } else {
      console.log(`  [FAIL] Auto-refund failed to restore balance: ${walletAfterRefund?.balance}`);
      failed++;
    }

    // 4. Second Withdrawal & Admin Transfer Approval
    const secondReq = await (walletService as any).requestWithdrawal(store.storeId, {
      ...reqDto,
      amount: 250000,
    });
    const transferred = await (adminService as any).confirmWithdrawalTransfer(
      secondReq.withdrawalId,
      'https://evidence.cloudinary.com/sample_bill.jpg'
    );

    if (
      transferred &&
      transferred.status === 'TRANSFERRED' &&
      transferred.transferEvidenceUrl === 'https://evidence.cloudinary.com/sample_bill.jpg'
    ) {
      console.log('  [PASS] confirmWithdrawalTransfer confirmed bank payout successfully');
    } else {
      console.log('  [FAIL] confirmWithdrawalTransfer failed');
      failed++;
    }
  } catch (error: any) {
    console.log('  [FAIL] Exception during test execution:', error.message);
    failed++;
  } finally {
    await prisma.$disconnect();
  }

  if (failed > 0) {
    console.error(`Store withdrawal test failed with ${failed} failures.`);
    process.exit(1);
  } else {
    console.log('All Store Withdrawal tests passed successfully!');
  }
}

testStoreWithdrawal().catch((err) => {
  console.error('Test run error:', err);
  process.exit(1);
});
