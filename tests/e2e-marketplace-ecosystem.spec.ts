import { PrismaService } from '../src/prisma/prisma.service';
import { AdminService } from '../src/admin/admin.service';
import { AdminRepository } from '../src/admin/admin.repository';
import { RentalsService } from '../src/rentals/rentals.service';
import { StoreWalletService } from '../src/store-wallet/store-wallet.service';
import { StoreSubscriptionsService } from '../src/store-subscriptions/store-subscriptions.service';

async function testFullMarketplaceE2E() {
  console.log('========================================================================');
  console.log('🚀 MASTER E2E: MULTI-VENDOR MARKETPLACE, BUTTON RENTAL & ESCROW WALLET');
  console.log('========================================================================\n');

  const prisma = new PrismaService();
  await prisma.$connect();

  const adminRepo = new AdminRepository(prisma);
  const adminService = new AdminService(adminRepo);
  const rentalsService = new RentalsService(prisma);
  const walletService = new StoreWalletService(prisma);
  const subscriptionsService = new StoreSubscriptionsService(prisma, walletService);

  let passed = 0;
  let failed = 0;

  function assert(title: string, condition: boolean, detail?: string) {
    if (condition) {
      console.log(`\x1b[32m  ✔ [PASS]\x1b[0m ${title}`);
      passed++;
    } else {
      console.log(`\x1b[31m  ✖ [FAIL]\x1b[0m ${title} - ${detail || ''}`);
      failed++;
    }
  }

  try {
    const timestamp = Date.now();

    // ----------------------------------------------------
    // STAGE 1: ADMIN CONFIGURES PLANS & PACKAGES
    // ----------------------------------------------------
    console.log('[STAGE 1] Admin Configuration:');
    const listingPlan = await adminService.createSubscriptionPlan({
      planCode: `PLAN_E2E_${timestamp}`,
      planName: 'Gói Listing Sàn 30 Ngày',
      description: 'Đăng bán tối đa 30 sản phẩm',
      price: 150000,
      durationDays: 30,
      maxProducts: 30,
    });
    assert('Admin creates SubscriptionPlan', !!listingPlan && Number(listingPlan.price) === 150000);

    const rentalPkg = await adminService.createRentalPackage({
      packageCode: `KIT3_E2E_${timestamp}`,
      packageName: 'Bộ Kit 3 Nút Bấm Thông Minh',
      description: 'Combo 3 nút IoT đặt hàng',
      buttonQuantity: 3,
      monthlyPrice: 120000,
      depositFee: 300000,
    });
    assert('Admin creates RentalPackage for Kit of 3 buttons', !!rentalPkg && rentalPkg.buttonQuantity === 3);

    // ----------------------------------------------------
    // STAGE 2: SETUP STORE & INITIAL WALLET SEED
    // ----------------------------------------------------
    console.log('\n[STAGE 2] Store & Wallet Setup:');
    let owner = await prisma.user.create({
      data: {
        username: `owner_e2e_${timestamp}`,
        email: `owner_e2e_${timestamp}@example.com`,
        passwordHash: '$2b$10$EixZaYVK1fsbw1ZfbX3OXePaWxn96p36WQmG6FeEwE8.AoF2F11/K',
        fullName: 'E2E Store Owner',
      },
    });

    const store = await prisma.store.create({
      data: {
        name: `E2E Tech Store ${timestamp}`,
        code: `STR_E2E_${timestamp}`,
        phone: '0912345678',
        address: '456 Le Duan, Da Nang',
        ownerUserId: owner.userId,
      },
    });

    const wallet = await walletService.getOrCreateStoreWallet(store.storeId);
    assert('Store Wallet created automatically', !!wallet && wallet.storeId === store.storeId);

    // Seed initial balance 500k to wallet
    await prisma.storeWallet.update({
      where: { walletId: wallet.walletId },
      data: { balance: 500000 },
    });

    // ----------------------------------------------------
    // STAGE 3: STORE SUBSCRIBES TO LISTING PLAN
    // ----------------------------------------------------
    console.log('\n[STAGE 3] Store Listing Subscription:');
    const storeSub = await subscriptionsService.subscribeWithWallet(store.storeId, listingPlan.planId);
    assert(
      'Store subscribes using Wallet (500k - 150k = 300k remaining)',
      storeSub.status === 'ACTIVE' && storeSub.paymentMethod === 'WALLET'
    );

    const walletAfterSub = await prisma.storeWallet.findUnique({ where: { walletId: wallet.walletId } });
    assert('Wallet balance matches after deduction (350,000 VND)', Number(walletAfterSub?.balance) === 350000);

    const canList = await subscriptionsService.validateStoreCanListProducts(store.storeId);
    assert('Store product listing verified and unlocked', canList === true);

    // ----------------------------------------------------
    // STAGE 4: CUSTOMER RENTS BUTTON KIT
    // ----------------------------------------------------
    console.log('\n[STAGE 4] Customer Button Rental:');
    const custUser = await prisma.user.create({
      data: {
        username: `cust_e2e_${timestamp}`,
        email: `cust_e2e_${timestamp}@example.com`,
        passwordHash: '$2b$10$EixZaYVK1fsbw1ZfbX3OXePaWxn96p36WQmG6FeEwE8.AoF2F11/K',
        fullName: 'E2E Customer Consumer',
      },
    });
    const customer = await prisma.customerProfile.create({
      data: { userId: custUser.userId },
    });

    const rentalMonths = 2;
    const rentalContract = await rentalsService.createRentalContract(customer.customerId, {
      packageId: rentalPkg.packageId.toString(),
      monthsRented: rentalMonths,
    });
    const expectedRentTotal = 120000 * rentalMonths;
    assert(
      'Customer rental contract created with accurate total rent',
      Number(rentalContract.totalRentAmount) === expectedRentTotal && rentalContract.status === 'PENDING_PAYMENT'
    );

    const activatedRental = await rentalsService.activateRental(rentalContract.rentalId);
    assert('Customer rental contract activated upon payment confirmation', activatedRental.status === 'ACTIVE');

    // ----------------------------------------------------
    // STAGE 5: ORDER REVENUE SETTLEMENT (ESCROW)
    // ----------------------------------------------------
    console.log('\n[STAGE 5] Marketplace Escrow Order Completion:');
    const orderRevenue = 850000;
    const e2eOrderCode = `E2E-ORD-${timestamp}`;

    const creditedWallet = await walletService.creditOrderRevenue(store.storeId, orderRevenue, e2eOrderCode);
    // Initial 350k + 850k = 1,200,000 VND
    assert(
      'Order completion automatically credits 850,000 VND revenue to Store Wallet (Total: 1,200,000 VND)',
      Number(creditedWallet.balance) === 1200000
    );

    const txLogs = await walletService.listTransactions(store.storeId);
    const orderTx = txLogs.find((t: any) => t.referenceId === e2eOrderCode);
    assert(
      'WalletTransaction audit log recorded with correct ORDER_REVENUE type and balance trace',
      !!orderTx && Number(orderTx.amount) === orderRevenue && orderTx.type === 'ORDER_REVENUE'
    );

    // ----------------------------------------------------
    // STAGE 6: STORE WITHDRAWAL & ADMIN CONFIRMATION
    // ----------------------------------------------------
    console.log('\n[STAGE 6] Store Withdrawal & Admin Payout:');
    const withdrawAmount = 700000;
    const withdrawal = await walletService.requestWithdrawal(store.storeId, {
      amount: withdrawAmount,
      bankName: 'Techcombank',
      bankAccountNumber: '19034567890123',
      bankAccountHolder: 'NGUYEN VAN E2E',
    });

    assert(
      'Store submits withdrawal request for 700,000 VND',
      withdrawal.status === 'PENDING' && Number(withdrawal.amount) === withdrawAmount
    );

    const walletAfterWithdrawReq = await prisma.storeWallet.findUnique({ where: { walletId: wallet.walletId } });
    assert(
      'Store balance immediately deducted by 700,000 VND to prevent double-spending (Remaining: 500,000 VND)',
      Number(walletAfterWithdrawReq?.balance) === 500000
    );

    const transferred = await adminService.confirmWithdrawalTransfer(
      withdrawal.withdrawalId,
      'https://res.cloudinary.com/demo/image/upload/v1/bank_transfer_proof.jpg',
      owner
    );
    assert(
      'Admin approves and records bank transfer proof receipt (Status: TRANSFERRED)',
      transferred.status === 'TRANSFERRED' && !!transferred.transferEvidenceUrl
    );
  } catch (err: any) {
    console.error('E2E execution caught unexpected error:', err);
    failed++;
  } finally {
    await prisma.$disconnect();
  }

  console.log('\n------------------------------------------------------------------------');
  console.log(`Master E2E Test Results: ${passed} Passed, ${failed} Failed`);
  console.log('------------------------------------------------------------------------\n');

  if (failed > 0) {
    process.exit(1);
  }
}

testFullMarketplaceE2E().catch((err) => {
  console.error('Fatal E2E error:', err);
  process.exit(1);
});
