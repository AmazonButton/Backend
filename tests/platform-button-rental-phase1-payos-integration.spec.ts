import { BillingChargesService } from '../src/billing-charges/billing-charges.service';
import { PaymentsService } from '../src/payments/payments.service';
import { assertTestDatabase } from './test-db-guard';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { signPaymentRequest, signWebhookData } from '../src/payments/payos.helper';

async function runPhase1PayosIntegrationSuite() {
  process.env.TEST_DATABASE_URL = 'postgresql://postgres:postgres@localhost:5432/platform_button_rental_test';
  assertTestDatabase('Phase 1: PayOS BillingCharge Integration');
  console.log('================================================================================');
  console.log('⚡ PHASE 1: BILLING CHARGE REAL PAYOS PAYMENT & WEBHOOK INTEGRATION');
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

  // Mock repository for BillingCharges
  const chargesMap = new Map<string, any>();
  const mockBillingChargesRepo: any = {
    findChargeById: async (id: bigint) => chargesMap.get(id.toString()) || null,
    findChargeByOrderCode: async (orderCode: string, paymentLinkId?: string) => {
      for (const chg of chargesMap.values()) {
        if (
          chg.providerTransactionCode === orderCode ||
          chg.paymentLinkId === orderCode ||
          (paymentLinkId && chg.paymentLinkId === paymentLinkId)
        ) {
          return chg;
        }
      }
      return null;
    },
    updatePaymentLinkDetails: async (chargeId: bigint, details: any) => {
      const chg = chargesMap.get(chargeId.toString());
      if (chg) {
        Object.assign(chg, details);
      }
      return chg;
    },
    settleChargeAtomicTx: async (chargeId: bigint, receipt: any, actor: any) => {
      const chg = chargesMap.get(chargeId.toString());
      if (!chg) throw new NotFoundException('Charge not found');
      chg.status = 'PAID';
      chg.providerTransactionCode = receipt.providerTransactionCode;
      chg.settledAt = new Date();
      return {
        alreadySettled: false,
        status: 'PAID',
        charge: chg,
        storeWalletCredited: false,
        rentalStatus: chg.purpose === 'RENTAL_INITIAL' ? 'PENDING_HANDOVER' : undefined,
      };
    },
    findRentalWithCustomer: async (rentalId: bigint) => ({
      rentalId,
      customerId: BigInt(55),
      customer: {
        userId: BigInt(500),
      },
    }),
  };

  const billingChargesService = new BillingChargesService(mockBillingChargesRepo);

  // Setup initial test charges
  chargesMap.set('101', {
    chargeId: BigInt(101),
    chargeCode: 'CHG-101',
    customerId: BigInt(55),
    storeId: null,
    purpose: 'RENTAL_INITIAL',
    targetType: 'RENTAL',
    targetId: BigInt(1),
    totalAmount: 230000,
    status: 'PENDING',
    paymentMethod: 'PAYOS',
  });

  chargesMap.set('102', {
    chargeId: BigInt(102),
    chargeCode: 'CHG-102',
    customerId: null,
    storeId: BigInt(77),
    purpose: 'STORE_SUBSCRIPTION',
    targetType: 'STORE',
    targetId: BigInt(77),
    totalAmount: 60000,
    status: 'PENDING',
    paymentMethod: 'PAYOS',
  });

  try {
    // Test 1: BOLA Ownership Check: Customer 99 cannot create payment link for Customer 55 charge
    let bolaBlocked = false;
    try {
      await billingChargesService.createPayosPaymentRequestForCharge(BigInt(101), {
        userId: '999',
        customerProfileId: '99',
        role: 'CUSTOMER',
      });
    } catch (err: any) {
      if (err instanceof ForbiddenException) {
        bolaBlocked = true;
      }
    }
    assert(bolaBlocked, '1.1 [BOLA] Customer B bị chặn Forbidden khi tạo link thanh toán cho khoản thu của Customer A');

    // Test 2: Valid Customer generates real PayOS payment request
    const payResult = await billingChargesService.createPayosPaymentRequestForCharge(BigInt(101), {
      userId: '100',
      customerProfileId: '55',
      role: 'CUSTOMER',
    });

    assert(
      payResult.status === 'PENDING' &&
        payResult.amount === 230000 &&
        typeof payResult.orderCode === 'number' &&
        payResult.orderCode > 0 &&
        payResult.orderCode <= 9007199254740991 &&
        payResult.checkoutUrl.includes('pay.payos.vn') &&
        payResult.paymentLinkId.length > 0,
      '1.2 Khởi tạo PayOS payment link thật từ BillingCharge thành công với orderCode nguyên dương duy nhất',
    );

    // Test 3: Idempotency Replay: calling again returns existing payment link without creating duplicate
    const payResultReplay = await billingChargesService.createPayosPaymentRequestForCharge(BigInt(101), {
      userId: '100',
      customerProfileId: '55',
      role: 'CUSTOMER',
    });

    assert(
      payResultReplay.orderCode === payResult.orderCode &&
        payResultReplay.paymentLinkId === payResult.paymentLinkId &&
        payResultReplay.checkoutUrl === payResult.checkoutUrl,
      '1.3 [Idempotency] Gọi lại yêu cầu thanh toán trên charge PENDING trả lại đúng payment link hiện hữu, không sinh mã trùng',
    );

    // Test 4: Webhook Verification & Routing to BillingCharge Settlement
    const mockPaymentsRepo: any = {
      findTransactionByCode: async () => null, // Order transaction not found -> fallback to BillingCharge
    };

    const paymentsService = new PaymentsService(mockPaymentsRepo, null, null, billingChargesService);
    const checksumKey = process.env.PAYOS_CHECKSUM_KEY?.trim() || 'mock_checksum_key_dev';
    process.env.PAYOS_CHECKSUM_KEY = checksumKey;

    const webhookPayloadData = {
      orderCode: payResult.orderCode,
      amount: 230000,
      description: 'CHG-101',
      accountNumber: '1029384756',
      reference: 'PAYOS-TXN-REAL-777',
      transactionDateTime: new Date().toISOString(),
      currency: 'VND',
      paymentLinkId: payResult.paymentLinkId,
      code: '00',
      desc: 'success',
    };

    const webhookSignature = signWebhookData(webhookPayloadData, checksumKey);

    const webhookResult: any = await paymentsService.handlePayosWebhook({
      code: '00',
      desc: 'success',
      data: webhookPayloadData,
      signature: webhookSignature,
      success: true,
    });

    assert(
      webhookResult.success === true,
      '1.4 Webhook PayOS tự động nhận diện orderCode của BillingCharge, xác thực HMAC-SHA256 và settle thành công',
    );

    const updatedCharge = chargesMap.get('101');
    assert(
      updatedCharge.status === 'PAID' && updatedCharge.providerTransactionCode === 'PAYOS-TXN-REAL-777',
      '1.5 Trạng thái BillingCharge chuyển thành PAID, ghi nhận providerTransactionCode chính thức',
    );

    // Test 5: Idempotent Webhook on already PAID charge
    const repeatWebhook: any = await paymentsService.handlePayosWebhook({
      code: '00',
      desc: 'success',
      data: webhookPayloadData,
      signature: webhookSignature,
      success: true,
    });

    assert(
      repeatWebhook.success === true && repeatWebhook.message === 'Already processed',
      '1.6 Webhook gửi lại lần thứ hai cho charge đã PAID được xử lý Idempotent an toàn (Already processed)',
    );

    // Test 6: Webhook with mismatched amount is rejected
    const tamperedData = {
      ...webhookPayloadData,
      amount: 200000, // Mismatched (charge is 230,000)
    };
    const tamperedSignature = signWebhookData(tamperedData, checksumKey);
    const tamperedWebhook: any = await paymentsService.handlePayosWebhook({
      code: '00',
      desc: 'success',
      data: tamperedData,
      signature: tamperedSignature,
      success: true,
    });

    assert(
      tamperedWebhook.success === false && tamperedWebhook.message?.includes('Amount mismatch'),
      '1.7 Webhook có số tiền lệch với BillingCharge bị từ chối fail-closed (Amount mismatch)',
    );

    // Test 7: Store 60k Shelf Fee PayOS Link Creation
    const storePayResult = await billingChargesService.createPayosPaymentRequestForCharge(BigInt(102), {
      userId: '70',
      storeId: '77',
      role: 'STORE_OWNER',
    });

    assert(
      storePayResult.amount === 60000 &&
        storePayResult.status === 'PENDING' &&
        storePayResult.paymentLinkId.length > 0,
      '1.8 Tạo link PayOS thật cho phí duy trì gian hàng Store 60.000đ/tháng thành công',
    );

  } catch (err: any) {
    console.error('Fatal test error in Phase 1 suite:', err);
    failed++;
  }

  console.log(`\n================================================================================`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log(`================================================================================\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

runPhase1PayosIntegrationSuite().catch((err) => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
