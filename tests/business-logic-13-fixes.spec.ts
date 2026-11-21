import { PrismaService } from '../src/prisma/prisma.service';
import { StoreSubscriptionsRepository } from '../src/store-subscriptions/store-subscriptions.repository';
import { StoreSubscriptionsService } from '../src/store-subscriptions/store-subscriptions.service';
import { StoreSubscriptionsController } from '../src/store-subscriptions/store-subscriptions.controller';
import { BillingChargesRepository } from '../src/billing-charges/billing-charges.repository';
import { BillingChargesService } from '../src/billing-charges/billing-charges.service';
import { StoreWalletService } from '../src/store-wallet/store-wallet.service';
import { WarrantyRepository } from '../src/warranty/warranty.repository';
import { WarrantyService } from '../src/warranty/warranty.service';
import { WarrantyFaultGroupEnum } from '../src/warranty/dto/create-warranty-ticket.dto';
import { OrdersRepository } from '../src/orders/orders.repository';
import { OrdersService } from '../src/orders/orders.service';
import { DevicesRepository } from '../src/devices/devices.repository';
import { DevicesService } from '../src/devices/devices.service';
import { AnalyticsRepository } from '../src/analytics/analytics.repository';
import { RentalsRepository } from '../src/rentals/rentals.repository';
import { RentalsService } from '../src/rentals/rentals.service';
import { ProductsRepository } from '../src/products/products.repository';
import { ProductsService } from '../src/products/products.service';
import { AuthRepository } from '../src/auth/auth.repository';
import { AuthService } from '../src/auth/auth.service';
import { PaymentRefundsRepository } from '../src/payments/payment-refunds.repository';
import { PaymentRefundsService } from '../src/payments/payment-refunds.service';
import { CryptoVaultUtil } from '../src/common/utils/crypto-vault.util';
import { BadRequestException, ForbiddenException } from '@nestjs/common';

async function runBusinessLogic13FixesSuite() {
  console.log('================================================================================');
  console.log('🧪 TEST SUITE: 13-Point Business Logic Remediation (TDD Red -> Green)');
  console.log('================================================================================\n');

  process.env.NODE_ENV = 'test';
  process.env.PAYOS_MOCK_PAYMENT = 'true';

  const prisma = new PrismaService();
  await prisma.$connect();

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, name: string, detail?: string) {
    if (condition) {
      console.log(`  ✔ [PASS] ${name}`);
      passed++;
    } else {
      console.error(`  ✘ [FAIL] ${name}${detail ? ` -> ${detail}` : ''}`);
      failed++;
    }
  }

  const ts = Date.now();

  try {
    // Setup shared test user & store
    const ownerUser = await prisma.user.create({
      data: {
        username: `bl13_owner_${ts}`,
        fullName: 'BL13 Store Owner',
        email: `bl13_owner_${ts}@example.com`,
        status: 'ACTIVE',
      },
    });

    const store = await prisma.store.create({
      data: {
        name: `BL13 Store ${ts}`,
        code: `BL13_STR_${ts}`,
        phone: '0901112233',
        address: '123 BL13 Street',
        ownerUserId: ownerUser.userId,
        status: 'ACTIVE',
      },
    });

    const custUser = await prisma.user.create({
      data: {
        username: `bl13_cust_${ts}`,
        fullName: 'BL13 Customer',
        email: `bl13_cust_${ts}@example.com`,
        status: 'ACTIVE',
      },
    });

    const custProfile = await prisma.customerProfile.create({
      data: {
        userId: custUser.userId,
        phone: '0909998877',
      },
    });

    const custAddress = await prisma.customerAddress.create({
      data: {
        customerId: custProfile.customerId,
        recipientName: 'BL13 Customer',
        phone: '0909998877',
        addressDetail: '456 Customer Rd',
        isDefault: true,
      },
    });

    // Instantiate services
    const mockPayosPayout = {
      createPayout: async () => ({ code: '00', data: { id: `po_${ts}` } }),
      getPayout: async () => ({ code: '00', data: { id: `po_${ts}`, approvalState: 'COMPLETED' } }),
    } as any;

    const walletService = new StoreWalletService(prisma, mockPayosPayout);
    const subRepo = new StoreSubscriptionsRepository(prisma);
    const subService = new StoreSubscriptionsService(subRepo, walletService);
    const billingRepo = new BillingChargesRepository(prisma);
    const billingService = new BillingChargesService(billingRepo);
    const subController = new StoreSubscriptionsController(subService, billingService);

    // =========================================================================
    // POINT 1 & 2: Store Subscriptions (renew-charge Trial vs Short Paid Plan & isUpcoming)
    // =========================================================================
    console.log('\n--- Point 1 & 2: Store Subscriptions Trial, Short Paid Plan & Upcoming Guard ---');

    const paidShortPlan = await prisma.subscriptionPlan.create({
      data: {
        planCode: `EVENT_5D_${ts}`,
        planName: 'Gói Sự Kiện 5 Ngày (Có Phí)',
        price: 15000,
        durationDays: 5,
        maxProducts: 999999,
        isActive: true,
      },
    });

    const trialPlan = await prisma.subscriptionPlan.findUnique({ where: { planCode: 'TRIAL_7D' } })
      || await prisma.subscriptionPlan.create({
        data: {
          planCode: 'TRIAL_7D',
          planName: 'Gói Dùng Thử 7 Ngày',
          price: 0,
          durationDays: 7,
          maxProducts: 999999,
          isActive: true,
        },
      });

    // 1.A Paid short plan (5 days, 15.000đ) via createRenewCharge MUST return PayOS checkout link, NOT free trial
    const reqContext = { user: { userId: ownerUser.userId, role: 'STORE_OWNER', storeId: store.storeId } };
    let shortPaidRes: any = null;
    try {
      shortPaidRes = await subController.createRenewCharge(reqContext, {
        planId: paidShortPlan.planId.toString(),
      });
    } catch (e: any) {
      shortPaidRes = { error: e.message };
    }
    assert(
      Boolean(shortPaidRes?.data?.checkoutUrl) && !shortPaidRes?.data?.isTrial,
      'Point 1A: Paid short plan (5 days, 15.000đ) creates PayOS link instead of triggering trial flow',
      JSON.stringify(shortPaidRes),
    );

    // 1.B 0 VND Trial plan via createRenewCharge MUST activate trial directly without throwing 400 in getPlanForCheckout
    let trialRenewRes: any = null;
    try {
      trialRenewRes = await subController.createRenewCharge(reqContext, {
        planId: trialPlan.planId.toString(),
      });
    } catch (e: any) {
      trialRenewRes = { error: e.message };
    }
    assert(
      trialRenewRes?.success === true && trialRenewRes?.data?.isTrial === true,
      'Point 1B: 0 VND Trial plan via createRenewCharge activates directly without dead-code 400 error',
      JSON.stringify(trialRenewRes),
    );

    // 2.A Store with only an UPCOMING subscription (startDate in future) cannot list products yet
    const upcomingStore = await prisma.store.create({
      data: {
        name: `Upcoming Store ${ts}`,
        code: `UP_STR_${ts}`,
        phone: '0901112244',
        address: '789 Upcoming St',
        ownerUserId: ownerUser.userId,
        status: 'ACTIVE',
      },
    });
    await prisma.storeSubscription.create({
      data: {
        storeId: upcomingStore.storeId,
        planId: paidShortPlan.planId,
        startDate: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
        endDate: new Date(Date.now() + 8 * 24 * 60 * 60 * 1000),
        status: 'ACTIVE',
        paymentMethod: 'PAYOS',
      },
    });

    let upcomingBlocked = false;
    try {
      await subService.validateStoreCanListProducts(upcomingStore.storeId);
    } catch (e: any) {
      if (e instanceof ForbiddenException) upcomingBlocked = true;
    }
    assert(
      upcomingBlocked,
      'Point 2A: validateStoreCanListProducts blocks store whose subscription has not started yet (isUpcoming)',
    );

    // 2.B Store owner who only bought a paid 5-day plan is NOT marked as having used the free trial
    const freshOwner = await prisma.user.create({
      data: {
        username: `fresh_owner_${ts}`,
        fullName: 'Fresh Owner',
        email: `fresh_owner_${ts}@example.com`,
        status: 'ACTIVE',
      },
    });
    const freshStore = await prisma.store.create({
      data: {
        name: `Fresh Store ${ts}`,
        code: `FR_STR_${ts}`,
        phone: '0901112255',
        address: 'Fresh St',
        ownerUserId: freshOwner.userId,
        status: 'ACTIVE',
      },
    });
    await prisma.storeSubscription.create({
      data: {
        storeId: freshStore.storeId,
        planId: paidShortPlan.planId,
        startDate: new Date(),
        endDate: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
        status: 'ACTIVE',
        paymentMethod: 'PAYOS',
      },
    });
    const hasUsedTrialAfterPaidShort = await subService.hasUsedTrialSubscription(freshStore.storeId);
    assert(
      hasUsedTrialAfterPaidShort === false,
      'Point 2B: Purchasing a paid <=7 day plan does NOT consume the 1-time free trial eligibility',
    );

    // =========================================================================
    // POINT 3: Warranty 200k Deposit, Group A Swap Integrity & Group C/D Collateral Deduction
    // =========================================================================
    console.log('\n--- Point 3: Warranty 200k Deposit, Group A 1-1 Swap & Group C/D Ledger Deduction ---');

    const warrantyRepo = new WarrantyRepository(prisma);
    const warrantyService = new WarrantyService(warrantyRepo);

    const sampleProduct = await prisma.product.create({
      data: {
        storeId: store.storeId,
        productCode: `PRD_WRT_${ts}`,
        productName: 'Nước khoáng Lavie 19L',
        basePrice: 65000,
        status: 'ACTIVE',
      },
    });
    await prisma.inventory.create({
      data: {
        storeId: store.storeId,
        productId: sampleProduct.productId,
        quantityOnHand: 50,
        reservedQuantity: 0,
      },
    });

    const rentalPkg = await prisma.rentalPackage.findUnique({ where: { packageCode: 'KIT1_STANDARD' } })
      || await prisma.rentalPackage.create({
        data: {
          packageCode: `KIT1_WRT_${ts}`,
          packageName: 'Gói 1 Nút',
          buttonQuantity: 1,
          monthlyPrice: 40000,
          depositFee: 200000,
          isActive: true,
        },
      });

    const activeRental = await prisma.buttonRental.create({
      data: {
        rentalCode: `RNT-WRT-${ts}`,
        customerId: custProfile.customerId,
        packageId: rentalPkg.packageId,
        fulfillmentStoreId: store.storeId,
        buttonQuantity: 1,
        depositPerButton: 200000,
        rentPerButton: 40000,
        monthlyRentPerButtonSnapshot: 40000,
        pricingReviewRequired: false,
        depositAmount: 200000,
        totalRentAmount: 40000,
        startDate: new Date(),
        endDate: new Date(Date.now() + 30 * 86400000),
        effectiveExpiresAt: new Date(Date.now() + 30 * 86400000),
        status: 'ACTIVE',
      },
    });

    await prisma.rentalDeposit.create({
      data: {
        rentalId: activeRental.rentalId,
        collectedAmount: 200000,
        heldAmount: 200000,
        refundReservedAmount: 0,
        refundedAmount: 0,
      },
    });

    const oldBtn = await prisma.ioTButton.create({
      data: {
        storeId: store.storeId,
        customerId: custProfile.customerId,
        addressId: custAddress.addressId,
        rentalId: activeRental.rentalId,
        deviceId: `SOB-OLD-${ts}`,
        buttonCode: `BTN-OLD-${ts}`,
        buttonName: 'Nút Cũ Đang Thuê',
        hmacSecret: 'secret_old',
        status: 'ACTIVE',
        inventoryState: 'IN_CUSTOMER_CUSTODY',
        canOrder: true,
      },
    });

    await prisma.buttonProduct.create({
      data: {
        buttonId: oldBtn.buttonId,
        productId: sampleProduct.productId,
        quantity: 2,
      },
    });

    const replacementBtn = await prisma.ioTButton.create({
      data: {
        storeId: store.storeId,
        deviceId: `SOB-NEW-${ts}`,
        buttonCode: `BTN-NEW-${ts}`,
        buttonName: 'Nút Mới Trong Kho',
        hmacSecret: 'secret_new',
        status: 'INACTIVE',
        inventoryState: 'IN_PLATFORM_WAREHOUSE',
        canOrder: false,
      },
    });

    // 3.A Create Group A ticket -> depositAmount must be taken from rental.depositPerButton (200.000đ), ignoring client 50.000đ
    const ticketA = await warrantyService.createTicket(
      {
        deviceId: oldBtn.deviceId,
        faultGroup: WarrantyFaultGroupEnum.GROUP_A,
        faultCode: 'BUTTON_STUCK',
        depositAmount: 50000,
      },
      { userId: ownerUser.userId, role: 'STORE_OWNER', storeId: store.storeId },
    );
    assert(
      Number(ticketA.depositAmount) === 200000 && Number(ticketA.refundAmount) === 200000,
      'Point 3A: Warranty ticket enforces server-side 200.000đ deposit from rental instead of client-supplied 50.000đ',
      `depositAmount=${ticketA.depositAmount}`,
    );

    // 3.B Approve 1-1 swap on Group A -> transfers rentalId, addressId, buttonProducts, sets IN_CUSTOMER_CUSTODY
    await warrantyService.approveSwap(
      ticketA.ticketId,
      { replacementDeviceId: replacementBtn.deviceId, adminNote: 'Đổi 1-1 nút liệt phím' },
      { userId: ownerUser.userId, role: 'SUPER_ADMIN' },
    );

    const checkOldBtn = await prisma.ioTButton.findUnique({ where: { buttonId: oldBtn.buttonId } });
    const checkNewBtn = await prisma.ioTButton.findUnique({
      where: { buttonId: replacementBtn.buttonId },
      include: { buttonProducts: true },
    });

    assert(
      checkOldBtn?.rentalId === null &&
      checkNewBtn?.rentalId === activeRental.rentalId &&
      checkNewBtn?.addressId === custAddress.addressId &&
      checkNewBtn?.inventoryState === 'IN_CUSTOMER_CUSTODY' &&
      checkNewBtn?.buttonProducts.length === 1 &&
      checkNewBtn?.buttonProducts[0].productId === sampleProduct.productId,
      'Point 3B: Group A 1-1 swap transfers rentalId, addressId, buttonProducts and sets IN_CUSTOMER_CUSTODY',
      JSON.stringify({
        oldRentalId: checkOldBtn?.rentalId?.toString(),
        newRentalId: checkNewBtn?.rentalId?.toString(),
        newInvState: checkNewBtn?.inventoryState,
        newProductsCount: checkNewBtn?.buttonProducts.length,
      }),
    );

    // 3.C Group C ticket (30% deduction = 60k fee, 140k refund) -> approveSwap MUST be blocked; lockDevice MUST deduct 60k and reserve 140k DepositRefund
    const ticketC = await warrantyService.createTicket(
      {
        deviceId: replacementBtn.deviceId,
        faultGroup: WarrantyFaultGroupEnum.GROUP_C,
        faultCode: 'TIER_C_SHELL_CRACK_30%',
      },
      { userId: ownerUser.userId, role: 'STORE_OWNER', storeId: store.storeId },
    );

    let swapGroupCBlocked = false;
    try {
      await warrantyService.approveSwap(
        ticketC.ticketId,
        {},
        { userId: ownerUser.userId, role: 'SUPER_ADMIN' },
      );
    } catch (e: any) {
      if (e instanceof BadRequestException) swapGroupCBlocked = true;
    }
    assert(
      swapGroupCBlocked,
      'Point 3C-1: approveSwap rejects Group C/D user-damaged tickets to prevent collateral deficit',
    );

    await warrantyService.lockDevice(
      ticketC.ticketId,
      { userId: ownerUser.userId, role: 'SUPER_ADMIN' },
      'Thu hồi nút vỡ vỏ, khấu trừ 30% cọc (60k) và hoàn 140k',
    );

    const updatedDepositLedger = await prisma.rentalDeposit.findUnique({
      where: { rentalId: activeRental.rentalId },
    });
    const createdPartialRefund = await prisma.depositRefund.findFirst({
      where: { rentalId: activeRental.rentalId },
    });
    const updatedRentalAfterLock = await prisma.buttonRental.findUnique({
      where: { rentalId: activeRental.rentalId },
    });

    assert(
      Number(updatedDepositLedger?.heldAmount) === 0 &&
      Number(updatedDepositLedger?.refundReservedAmount) === 140000 &&
      Number(createdPartialRefund?.amount) === 140000 &&
      updatedRentalAfterLock?.status === 'RETURNED',
      'Point 3C-2: lockDevice deducts 60k fee, reserves 140k in DepositRefund, and marks rental RETURNED',
      JSON.stringify({
        held: updatedDepositLedger?.heldAmount,
        reserved: updatedDepositLedger?.refundReservedAmount,
        refundAmt: createdPartialRefund?.amount,
        rentalStatus: updatedRentalAfterLock?.status,
      }),
    );

    // =========================================================================
    // POINT 4 & 5: Child Lock Error Message in OrdersService & canOrder Guard in DevicesService
    // =========================================================================
    console.log('\n--- Point 4 & 5: Child Lock Error Message & DevicesService canOrder Guard ---');

    const mockOrdersPayoutService = {
      createPayout: async (req: any) => ({
        code: '00',
        data: {
          id: `po_bl13_${ts}`,
          referenceId: req.referenceId,
          amount: req.amount,
          approvalState: 'SUCCEEDED',
          transactions: [
            {
              id: `potx_bl13_${ts}`,
              referenceId: req.referenceId,
              amount: req.amount,
              toBin: req.toBin,
              toAccountNumber: req.toAccountNumber,
              state: 'SUCCEEDED',
            },
          ],
        },
      }),
      getPayout: async (id: string) => ({ code: '00', data: { id } }),
      getPayouts: async () => ({ code: '00', data: [] }),
    } as any;
    const paymentRefundsRepo = new PaymentRefundsRepository(prisma);
    const paymentRefundsService = new PaymentRefundsService(paymentRefundsRepo, mockOrdersPayoutService);
    const ordersRepo = new OrdersRepository(prisma, paymentRefundsRepo);
    const mockEvents = { emitToStore: () => {}, emitToCustomer: () => {}, emitToAdmin: () => {} } as any;
    const ordersService = new OrdersService(
      ordersRepo,
      {} as any,
      mockEvents,
      walletService,
      undefined,
      undefined,
      undefined,
      undefined,
      paymentRefundsService,
    );

    const childLockedBtn = await prisma.ioTButton.create({
      data: {
        storeId: store.storeId,
        customerId: custProfile.customerId,
        addressId: custAddress.addressId,
        deviceId: `SOB-CHILD-${ts}`,
        buttonCode: `BTN-CHILD-${ts}`,
        hmacSecret: 'secret_child',
        status: 'ACTIVE',
        inventoryState: 'IN_CUSTOMER_CUSTODY',
        canOrder: false,
      },
    });

    let childLockMsg = '';
    try {
      await ordersService.handleButtonEvent(childLockedBtn, {
        eventType: 'SINGLE_PRESS',
        requestId: `req_child_${ts}`,
      });
    } catch (e: any) {
      childLockMsg = e.message || '';
    }
    assert(
      childLockMsg.includes('tạm khóa') && !childLockMsg.includes('hết hạn thuê'),
      'Point 4: OrdersService.handleButtonEvent reports Child Lock / paused ordering instead of expired lease when canOrder=false',
      `Actual message: ${childLockMsg}`,
    );

    const devicesRepo = new DevicesRepository(prisma);
    const devicesService = new DevicesService(devicesRepo, mockEvents);

    const transitBtn = await prisma.ioTButton.create({
      data: {
        storeId: store.storeId,
        customerId: custProfile.customerId,
        deviceId: `SOB-TRANSIT-${ts}`,
        buttonCode: `BTN-TRANSIT-${ts}`,
        hmacSecret: 'secret_tr',
        status: 'ACTIVE',
        inventoryState: 'RETURN_IN_TRANSIT',
        canOrder: false,
      },
    });

    let unlockTransitBlocked = false;
    try {
      await devicesService.update(
        transitBtn.buttonId,
        { canOrder: true },
        { userId: custUser.userId, role: 'CUSTOMER', customerProfileId: custProfile.customerId },
      );
    } catch (e: any) {
      if (e instanceof BadRequestException) unlockTransitBlocked = true;
    }
    assert(
      unlockTransitBlocked,
      'Point 5: DevicesService.update blocks setting canOrder=true when device is RETURN_IN_TRANSIT or rental expired',
    );

    // =========================================================================
    // POINT 6 & 7: Order Refund paidRevenue Exclusion & Store Withdrawal PENDING Guard
    // =========================================================================
    console.log('\n--- Point 6 & 7: Refunded Order Analytics Exclusion & Withdrawal PENDING Guard ---');

    const analyticsStore = await prisma.store.create({
      data: {
        name: `Analytics Store ${ts}`,
        code: `ANA_STR_${ts}`,
        phone: '0901112266',
        address: 'Analytics St',
        ownerUserId: ownerUser.userId,
        status: 'ACTIVE',
      },
    });

    const refundedOrder = await prisma.order.create({
      data: {
        orderCode: `ORD-REF-${ts}`,
        storeId: analyticsStore.storeId,
        customerId: custProfile.customerId,
        orderStatus: 'CANCELLED',
        paymentStatus: 'REFUND_PENDING',
        paymentMethod: 'PAYOS',
        subtotalAmount: 100000,
        totalAmount: 100000,
        shippingRecipientName: 'Cust',
        shippingPhone: '0909998877',
        shippingAddress: 'Address',
      },
    });

    const refAcc = `0988${String(ts).slice(-6)}`;
    const refBank = await prisma.customerBankAccount.create({
      data: {
        customerId: custProfile.customerId,
        bankCode: 'MB',
        bankName: 'MBBank',
        bankBin: '970422',
        accountNumberEncrypted: CryptoVaultUtil.encryptAccountNumber(refAcc),
        accountNumberMasked: CryptoVaultUtil.maskAccountNumber(refAcc),
        accountNumberHash: CryptoVaultUtil.computeDeterministicAccountHash(refAcc),
        accountName: 'CUSTOMER POINT 6',
        verificationStatus: 'VERIFIED',
        isDefault: true,
      },
    });

    const refPt = await prisma.paymentTransaction.create({
      data: {
        orderId: refundedOrder.orderId,
        provider: 'PAYOS',
        transactionCode: `PT-REF-${ts}`,
        amount: 100000,
        paymentMethod: 'QR',
        status: 'PAID',
      },
    });

    await prisma.paymentOrderReceipt.create({
      data: {
        orderId: refundedOrder.orderId,
        paymentTransactionId: refPt.paymentTransactionId,
        provider: 'PAYOS',
        channel: 'ORDER_PAYMENT_LINK',
        providerTransactionRef: `FT-REF-${ts}`,
        amount: 100000,
        currency: 'VND',
        classification: 'ORDER_PAYMENT',
        sourceBankBin: '970422',
        sourceAccountMasked: CryptoVaultUtil.maskAccountNumber(refAcc),
        sourceAccountHash: CryptoVaultUtil.computeDeterministicAccountHash(refAcc),
        sourceAccountEncrypted: CryptoVaultUtil.encryptAccountNumber(refAcc),
        sourceAccountName: 'CUSTOMER POINT 6',
        sourceEvidenceStatus: 'SUFFICIENT',
      },
    });

    await ordersService.refundOrder(
      refundedOrder.orderId,
      { customerBankAccountId: refBank.id.toString(), adminNote: 'Hoàn tiền đơn hủy' },
      { userId: ownerUser.userId, role: 'SUPER_ADMIN' },
    );

    const analyticsRepo = new AnalyticsRepository(prisma);
    const dashData = await analyticsRepo.getDashboardData(analyticsStore.storeId);
    assert(
      Number(dashData.summary.paidRevenue) === 0,
      'Point 6: Refunded order payment transaction is marked REFUNDED and excluded from Analytics paidRevenue',
      `paidRevenue=${dashData.summary.paidRevenue}`,
    );

    // Point 7: StoreWalletService.syncWithdrawalPayoutStatus does NOT auto-trigger PayOS payout on PENDING withdrawal
    const storeWallet = await walletService.getOrCreateStoreWallet(analyticsStore.storeId);
    const pendingWithdrawal = await prisma.storeWithdrawal.create({
      data: {
        withdrawalCode: `WDR-PEND-${ts}`,
        walletId: storeWallet.walletId,
        storeId: analyticsStore.storeId,
        amount: 100000,
        fee: 0,
        netAmount: 100000,
        bankName: 'MBBank',
        bankAccountHolder: 'CHU QUAN',
        status: 'PENDING',
        provider: 'PAYOS',
      },
    });

    const syncedWithdrawal = await walletService.syncWithdrawalPayoutStatus(
      pendingWithdrawal.withdrawalId,
      analyticsStore.storeId,
    );
    assert(
      syncedWithdrawal.status === 'PENDING',
      'Point 7: Store syncWithdrawalPayoutStatus keeps PENDING withdrawal in PENDING waiting for Admin approval',
      `status=${syncedWithdrawal.status}`,
    );

    // =========================================================================
    // POINT 8 & 9: Button Rentals (37-Day Draft Cleanup & Handover Entitlement Days)
    // =========================================================================
    console.log('\n--- Point 8 & 9: Button Rentals 37-Day Draft Cleanup & Handover Entitlement Math ---');

    const rentalsRepo = new RentalsRepository(prisma);
    const rentalsService = new RentalsService(rentalsRepo);

    const newRenterUser = await prisma.user.create({
      data: {
        username: `renter8_${ts}`,
        fullName: 'Renter 8',
        email: `renter8_${ts}@example.com`,
        status: 'ACTIVE',
      },
    });
    const newRenterProfile = await prisma.customerProfile.create({
      data: { userId: newRenterUser.userId, phone: '0908887766' },
    });

    // Create draft #1 (unpaid PENDING_PAYMENT)
    const draft1 = await rentalsService.createRentalContract(newRenterProfile.customerId, {
      packageId: rentalPkg.packageId.toString(),
      monthsRented: 1,
    });

    // Create contract #2 while draft #1 is still unpaid PENDING_PAYMENT
    const contract2 = await rentalsService.createRentalContract(newRenterProfile.customerId, {
      packageId: rentalPkg.packageId.toString(),
      monthsRented: 1,
    });

    const checkDraft1 = await prisma.buttonRental.findUnique({
      where: { rentalId: BigInt(draft1.rentalId) },
    });
    const c2Days = Math.round(
      (new Date(contract2.endDate).getTime() - new Date(contract2.startDate).getTime()) / 86400000,
    );

    assert(
      checkDraft1?.status === 'CANCELLED' && c2Days === 37,
      'Point 8: Creating a new rental auto-cancels unpaid PENDING_PAYMENT drafts and preserves the 37-day first-time bonus',
      `draft1.status=${checkDraft1?.status}, c2Days=${c2Days}`,
    );

    // Point 9: Handover with pre-handover extension does not double-count extensionMonths
    const handoverRental = await prisma.buttonRental.create({
      data: {
        rentalCode: `RNT-HND-${ts}`,
        customerId: newRenterProfile.customerId,
        packageId: rentalPkg.packageId,
        fulfillmentStoreId: store.storeId,
        buttonQuantity: 1,
        depositPerButton: 200000,
        rentPerButton: 40000,
        monthlyRentPerButtonSnapshot: 40000,
        pricingReviewRequired: false,
        depositAmount: 200000,
        totalRentAmount: 80000,
        monthsRented: 2, // 1 initial month + 1 extension month
        // Simulate end_date already having 67 days (37 initial + 30 extension)
        startDate: new Date(Date.now() - 3600000),
        endDate: new Date(Date.now() - 3600000 + 67 * 86400000),
        status: 'PENDING_HANDOVER',
        billingPolicyReviewRequired: false,
      },
    });

    // Create PAID initial deposit charge & PAID 1-month extension charge
    await prisma.billingCharge.create({
      data: {
        chargeCode: `CHG-INIT-HND-${ts}`,
        purpose: 'RENTAL_INITIAL',
        targetType: 'RENTAL',
        targetId: handoverRental.rentalId,
        totalAmount: 200000,
        status: 'PAID',
        lines: {
          create: [{ lineType: 'DEPOSIT', amount: 200000, quantity: 1, unitPrice: 200000 }],
        },
      },
    });
    await prisma.billingCharge.create({
      data: {
        chargeCode: `CHG-EXT-HND-${ts}`,
        purpose: 'RENTAL_EXTENSION',
        targetType: 'RENTAL',
        targetId: handoverRental.rentalId,
        totalAmount: 40000,
        status: 'PAID',
        lines: {
          create: [
            {
              lineType: 'STORE_RENT',
              amount: 40000,
              durationUnit: 'MONTH',
              durationCount: 1,
              quantity: 1,
              unitPrice: 40000,
            },
          ],
        },
      },
    });

    await prisma.ioTButton.create({
      data: {
        storeId: store.storeId,
        custodyStoreId: store.storeId,
        rentalId: handoverRental.rentalId,
        deviceId: `SOB-HND-${ts}`,
        buttonCode: `BTN-HND-${ts}`,
        hmacSecret: 'secret_hnd',
        status: 'INACTIVE',
        inventoryState: 'ASSIGNED_TO_RENTAL',
        canOrder: false,
      },
    });

    const handoverNow = new Date();
    const handoverRes = await rentalsRepo.handoverRentalButtonsTx(
      handoverRental.rentalId,
      { userId: ownerUser.userId, role: 'STORE_OWNER' },
      handoverNow,
    );
    const grantedHandoverDays = Math.round(
      (new Date(handoverRes.effectiveExpiresAt).getTime() - handoverNow.getTime()) / 86400000,
    );
    assert(
      grantedHandoverDays === 67,
      `Point 9: Handover with 1 initial month (37d) + 1 extension month (30d) grants 67 days (not 97 days), got ${grantedHandoverDays}`,
    );

    // =========================================================================
    // POINT 10 & 11: Inventory Reservation Floor & DELIVERED Immediate Settlement
    // =========================================================================
    console.log('\n--- Point 10 & 11: Inventory Reservation Floor & DELIVERED Immediate Settlement ---');

    const productsRepo = new ProductsRepository(prisma);
    const productsService = new ProductsService(
      productsRepo,
      subService,
      {} as any,
      mockEvents,
    );

    const invProduct = await prisma.product.create({
      data: {
        storeId: store.storeId,
        productCode: `PRD_INV_${ts}`,
        productName: 'Gạo ST25 5Kg',
        basePrice: 150000,
        status: 'ACTIVE',
      },
    });
    await prisma.inventory.create({
      data: {
        storeId: store.storeId,
        productId: invProduct.productId,
        quantityOnHand: 10,
        reservedQuantity: 4,
      },
    });

    let stockBelowReservedBlocked = false;
    try {
      await productsService.updateStock(
        invProduct.productId,
        { availableStock: 2 },
        { userId: ownerUser.userId, role: 'STORE_OWNER', storeId: store.storeId },
      );
    } catch (e: any) {
      if (e instanceof BadRequestException) stockBelowReservedBlocked = true;
    }
    assert(
      stockBelowReservedBlocked,
      'Point 10: ProductsService.updateStock blocks setting quantityOnHand (2) below reservedQuantity (4)',
    );

    // Point 11: completeDeliveryAtomicTx (DELIVERED) immediately deducts inventory and credits StoreWallet for PayOS order
    const delivStore = await prisma.store.create({
      data: {
        name: `Deliv Store ${ts}`,
        code: `DLV_STR_${ts}`,
        phone: '0901112277',
        address: 'Deliv St',
        ownerUserId: ownerUser.userId,
        status: 'ACTIVE',
      },
    });
    const delivProduct = await prisma.product.create({
      data: {
        storeId: delivStore.storeId,
        productCode: `PRD_DLV_${ts}`,
        productName: 'Thùng Bia Tiger',
        basePrice: 100000,
        status: 'ACTIVE',
      },
    });
    await prisma.inventory.create({
      data: {
        storeId: delivStore.storeId,
        productId: delivProduct.productId,
        quantityOnHand: 10,
        reservedQuantity: 2,
      },
    });

    const shippingOrder = await prisma.order.create({
      data: {
        orderCode: `ORD-DLV-${ts}`,
        storeId: delivStore.storeId,
        customerId: custProfile.customerId,
        assignedDriverId: ownerUser.userId,
        orderStatus: 'SHIPPING',
        paymentStatus: 'PAID',
        paymentMethod: 'PAYOS',
        subtotalAmount: 200000,
        totalAmount: 200000,
        commissionRate: 8,
        commissionAmount: 16000,
        netAmount: 184000,
        shippingRecipientName: 'Cust',
        shippingPhone: '0909998877',
        shippingAddress: 'Address',
        items: {
          create: [
            {
              productId: delivProduct.productId,
              productNameSnapshot: 'Thùng Bia Tiger',
              unitPriceSnapshot: 100000,
              finalUnitPrice: 100000,
              quantity: 2,
              itemSubtotal: 200000,
            },
          ],
        },
      },
    });

    await prisma.paymentTransaction.create({
      data: {
        orderId: shippingOrder.orderId,
        provider: 'PAYOS',
        transactionCode: `PT-DLV-${ts}`,
        amount: 200000,
        paymentMethod: 'QR',
        status: 'PAID',
      },
    });

    await ordersRepo.completeDeliveryAtomicTx(
      shippingOrder.orderId,
      { userId: ownerUser.userId, role: 'STORE_OWNER', storeId: delivStore.storeId },
      {
        status: 'DELIVERED',
        podObjectKey: `stores/${delivStore.storeId}/pod/2026/11/order_${shippingOrder.orderId}_proof.webp`,
        paymentMethod: 'PAYOS' as any,
      },
    );

    const invAfterDelivered = await prisma.inventory.findUnique({
      where: { productId: delivProduct.productId },
    });
    const walletAfterDelivered = await prisma.storeWallet.findUnique({
      where: { storeId: delivStore.storeId },
    });

    assert(
      invAfterDelivered?.quantityOnHand === 8 &&
      invAfterDelivered?.reservedQuantity === 0 &&
      Number(walletAfterDelivered?.balance) === 184000,
      'Point 11A: completeDeliveryAtomicTx (DELIVERED) immediately deducts inventory (10->8, reserved 2->0) and credits StoreWallet (184.000đ)',
      JSON.stringify({
        onHand: invAfterDelivered?.quantityOnHand,
        reserved: invAfterDelivered?.reservedQuantity,
        walletBalance: walletAfterDelivered?.balance,
      }),
    );

    // Calling completeOrderAtomicTx (COMPLETED) afterwards must NOT deduct inventory or credit wallet a second time
    await ordersRepo.completeOrderAtomicTx(shippingOrder.orderId);
    const invAfterCompleted = await prisma.inventory.findUnique({
      where: { productId: delivProduct.productId },
    });
    const walletAfterCompleted = await prisma.storeWallet.findUnique({
      where: { storeId: delivStore.storeId },
    });

    assert(
      invAfterCompleted?.quantityOnHand === 8 &&
      Number(walletAfterCompleted?.balance) === 184000,
      'Point 11B: Transitioning DELIVERED -> COMPLETED does NOT double-deduct inventory or double-credit wallet',
    );

    // =========================================================================
    // POINT 12 & 13: Auth resendVerification & OrdersService ADMIN Role Access
    // =========================================================================
    console.log('\n--- Point 12 & 13: Auth resendVerification & OrdersService ADMIN Role ---');

    let sentOtpEmail = '';
    const mockMailService = {
      sendRegistrationOtp: async (email: string) => {
        sentOtpEmail = email;
      },
    } as any;
    const authRepo = new AuthRepository(prisma);
    const authService = new AuthService(
      mockMailService,
      authRepo,
      {} as any,
      {} as any,
    );

    const unverifiedActiveUser = await prisma.user.create({
      data: {
        username: `unver_${ts}`,
        fullName: 'Unverified Active User',
        email: `unver_${ts}@example.com`,
        status: 'ACTIVE', // Created as ACTIVE by register()
        emailVerifiedAt: null,
      },
    });
    await authRepo.createAuthOtp({
      userId: unverifiedActiveUser.userId,
      email: unverifiedActiveUser.email!,
      purpose: 'EMAIL_VERIFICATION',
      tokenHash: `old_hash_${ts}`,
      expiresAt: new Date(Date.now() + 600000),
    });

    await authService.resendVerification({ email: unverifiedActiveUser.email! });

    const oldOtpRecord = await prisma.authOtp.findFirst({
      where: { tokenHash: `old_hash_${ts}` },
    });
    assert(
      sentOtpEmail === unverifiedActiveUser.email && oldOtpRecord?.consumedAt !== null,
      'Point 12: resendVerification dispatches OTP for ACTIVE unverified user and invalidates prior EMAIL_VERIFICATION OTPs',
      JSON.stringify({ sentOtpEmail, oldConsumedAt: oldOtpRecord?.consumedAt }),
    );

    // Point 13: OrdersService allows ADMIN role on getById, getTimeline, getPodViewUrl
    let adminAccessAllowed = false;
    try {
      const orderDto = await ordersService.getById(shippingOrder.orderId, {
        userId: BigInt(999999),
        role: 'ADMIN',
      });
      const timelineDto = await ordersService.getTimeline(shippingOrder.orderId.toString(), {
        userId: BigInt(999999),
        role: 'ADMIN',
      });
      const podDto = await ordersService.getPodViewUrl(shippingOrder.orderId.toString(), {
        userId: BigInt(999999),
        role: 'ADMIN',
      });
      if (orderDto && timelineDto && podDto) {
        adminAccessAllowed = true;
      }
    } catch (e: any) {
      adminAccessAllowed = false;
    }
    assert(
      adminAccessAllowed,
      'Point 13: OrdersService allows ADMIN role on getById, getTimeline, and getPodViewUrl',
    );
  } catch (err: any) {
    console.error('Unexpected fatal error in test suite:', err);
    failed++;
  } finally {
    await prisma.$disconnect();
  }

  console.log('\n================================================================================');
  console.log(`SUMMARY: ${passed} PASSED | ${failed} FAILED`);
  console.log('================================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runBusinessLogic13FixesSuite();
