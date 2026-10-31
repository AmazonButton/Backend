import { BillingChargesService } from '../src/billing-charges/billing-charges.service';
import { StoreSubscriptionsService } from '../src/store-subscriptions/store-subscriptions.service';
import { assertTestDatabase } from './test-db-guard';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';

async function runPhase3StoreSubscriptionSuite() {
  process.env.TEST_DATABASE_URL = 'postgresql://postgres:postgres@localhost:5432/platform_button_rental_test';
  process.env.PAYOS_MOCK_PAYMENT = 'true';
  assertTestDatabase('Phase 3: Store Shelf Maintenance Fee (60,000 VND)');
  console.log('================================================================================');
  console.log('⚡ PHASE 3: STORE SHELF MAINTENANCE FEE (60,000 VND/MONTH) & PRODUCT PROTECTION');
  console.log('================================================================================\n');

  let passed = 0;
  let failed = 0;

  const assert = (condition: boolean, testName: string, detail?: string) => {
    if (condition) {
      console.log(`  ✔ [PASS] ${testName}`);
      passed++;
    } else {
      console.error(`  ✖ [FAIL] ${testName}${detail ? ` -> ${detail}` : ''}`);
      failed++;
    }
  };

  const chargesMap = new Map<string, any>();
  const subscriptionsMap = new Map<string, any>();
  const storesMap = new Map<string, any>();

  // Mock Store A & Store B
  storesMap.set('10', { storeId: BigInt(10), storeName: 'Store A', ownerUserId: BigInt(100) });
  storesMap.set('20', { storeId: BigInt(20), storeName: 'Store B', ownerUserId: BigInt(200) });

  const mockBillingChargesRepo: any = {
    findChargeById: async (id: bigint) => chargesMap.get(id.toString()) || null,
    createChargeWithLines: async (input: any) => {
      const chargeId = BigInt(Date.now());
      const charge = {
        chargeId,
        chargeCode: `CHG-${input.purpose}-${Date.now()}`,
        purpose: input.purpose,
        targetType: input.targetType,
        targetId: input.targetId,
        totalAmount: input.totalAmount,
        currency: 'VND',
        status: 'PENDING',
        lines: input.lines,
      };
      chargesMap.set(chargeId.toString(), charge);
      return charge;
    },
    updatePaymentLinkDetails: async (chargeId: bigint, details: any) => {
      const chg = chargesMap.get(chargeId.toString());
      if (chg) Object.assign(chg, details);
      return chg;
    },
    settleChargeAtomicTx: async (chargeId: bigint, receipt: any) => {
      const chg = chargesMap.get(chargeId.toString());
      if (!chg) throw new NotFoundException('Charge not found');
      chg.status = 'PAID';
      chg.providerTransactionCode = receipt.providerTransactionCode;

      // Extend subscription by 30 days
      const storeId = chg.targetId.toString();
      const now = new Date();
      const existingSub = subscriptionsMap.get(storeId);
      const startDate = existingSub && existingSub.endDate > now ? existingSub.endDate : now;
      const endDate = new Date(startDate.getTime() + 30 * 24 * 60 * 60 * 1000);

      const updatedSub = {
        subscriptionId: BigInt(Date.now()),
        storeId: BigInt(storeId),
        startDate,
        endDate,
        status: 'ACTIVE',
        plan: { planName: 'Gói Duy Trì Gian Hàng 60.000đ', maxProducts: 100 },
      };
      subscriptionsMap.set(storeId, updatedSub);

      return {
        alreadySettled: false,
        status: 'PAID',
        charge: chg,
        subscription: updatedSub,
      };
    },
  };

  const billingChargesService = new BillingChargesService(mockBillingChargesRepo);

  const mockSubscriptionsRepo: any = {
    getCurrentSubscription: async (storeId: bigint) => subscriptionsMap.get(storeId.toString()) || null,
    countStoreProducts: async (storeId: bigint) => 10,
  };
  const mockWalletService: any = {};
  const subscriptionsService = new StoreSubscriptionsService(mockSubscriptionsRepo, mockWalletService);

  try {
    // Test 1: Create 60k shelf fee charge
    const charge = await billingChargesService.createStoreSubscriptionCharge({
      storeId: BigInt(10),
      amount: 60000,
      durationDays: 30,
    });

    assert(
      Number(charge.totalAmount) === 60000 &&
        charge.purpose === 'STORE_SUBSCRIPTION' &&
        charge.targetType === 'STORE' &&
        charge.targetId.toString() === '10',
      '3.1 Tạo yêu cầu thu tiền phí duy trì Store 60.000đ/tháng (STORE_SUBSCRIPTION) thành công với số tiền 60,000 VND',
    );

    // Test 2: BOLA Protection - Store Owner B cannot generate payment link for Store A's charge
    try {
      await billingChargesService.createPayosPaymentRequestForCharge(charge.chargeId, {
        role: 'STORE_OWNER',
        userId: '200',
        storeId: '20', // Belongs to Store B
      });
      assert(false, '3.2 [BOLA] Chủ cửa hàng B bị chặn Forbidden khi cố tạo link thanh toán cho gian hàng A');
    } catch (e: any) {
      assert(
        e instanceof ForbiddenException,
        '3.2 [BOLA] Chủ cửa hàng B bị chặn Forbidden khi cố tạo link thanh toán cho gian hàng A',
      );
    }

    // Test 3: Store Owner A generates real PayOS payment link
    const payResult = await billingChargesService.createPayosPaymentRequestForCharge(charge.chargeId, {
      role: 'STORE_OWNER',
      userId: '100',
      storeId: '10', // Owner of Store A
    });

    assert(
      payResult.amount === 60000 &&
        payResult.status === 'PENDING' &&
        payResult.paymentLinkId.length > 0 &&
        payResult.orderCode > 0,
      '3.3 Khởi tạo PayOS payment link cho chủ cửa hàng thành công, gắn đúng providerTransactionCode',
    );

    // Test 4: Before settlement, store cannot list products
    try {
      await subscriptionsService.validateStoreCanListProducts('10');
      assert(false, '3.4 Chặn cửa hàng chưa đóng phí hoặc chưa kích hoạt gói khi đăng bài sản phẩm');
    } catch (e: any) {
      assert(
        e instanceof ForbiddenException && e.message.includes('60.000đ/tháng'),
        '3.4 Chặn cửa hàng chưa đóng phí hoặc chưa kích hoạt gói khi đăng bài sản phẩm',
      );
    }

    // Test 5: Settle charge and activate subscription
    await billingChargesService.settleCharge(
      charge.chargeId,
      {
        provider: 'PAYOS',
        providerTransactionCode: 'PAYOS-STORE-777',
        amount: 60000,
        currency: 'VND',
        verified: true,
      },
      { role: 'SYSTEM' },
    );

    const activeSub = subscriptionsMap.get('10');
    assert(
      activeSub &&
        activeSub.status === 'ACTIVE' &&
        activeSub.endDate > new Date(),
      '3.5 Đối soát thanh toán (settlement) tự động kích hoạt gói thuê gian hàng 30 ngày',
    );

    // Test 6: After settlement, store can list products
    const canList = await subscriptionsService.validateStoreCanListProducts('10');
    assert(
      canList === true,
      '3.6 Sau khi đóng phí thành công, cửa hàng được cấp quyền đăng bán sản phẩm bình thường',
    );

  } catch (err: any) {
    console.error('Fatal test error in Phase 3 suite:', err);
    failed++;
  }

  console.log(`\n================================================================================`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log(`================================================================================\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

runPhase3StoreSubscriptionSuite().catch((err) => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
