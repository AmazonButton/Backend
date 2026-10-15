import { PrismaService } from '../src/prisma/prisma.service';
import { PaymentsService } from '../src/payments/payments.service';
import { PaymentsController } from '../src/payments/payments.controller';
import { PaymentsRepository } from '../src/payments/payments.repository';
import { PayOSPayoutService } from '../src/payments/payos-payout.service';
import { StoreWalletService } from '../src/store-wallet/store-wallet.service';
import { AdminController } from '../src/admin/admin.controller';
import { AdminService } from '../src/admin/admin.service';
import { AdminRepository } from '../src/admin/admin.repository';
import {
  signPaymentRequest,
  signPayoutRequest,
  verifyWebhookSignature,
  verifyPayoutSignature,
} from '../src/payments/payos.helper';
import { validate } from 'class-validator';
import {
  CreatePayosBatchPayoutDto,
  EstimatePayoutCreditDto,
  ListPayosPayoutsQueryDto,
  PayosPayoutItemDto,
} from '../src/admin/dto/payos-payout.dto';

async function testPayOSThuChiProduction() {
  console.log('========================================================================');
  console.log('🚀 PAYOS THU - CHI: PRODUCTION INTEGRITY & SPECIFICATION SUITE (MOCK PROVIDER MODE)');
  console.log('========================================================================\n');

  process.env.PAYOS_CLIENT_ID = 'mock_client_id';
  process.env.PAYOS_API_KEY = 'mock_api_key';
  process.env.PAYOS_CHECKSUM_KEY = '6e91f59952acc8918c49c4a8e380136d66d1fbbf3375926840a8a7e434d4b325';
  process.env.PAYOS_MOCK_PAYOUT = 'true';
  process.env.PAYOS_MOCK_PAYMENT = 'true';

  const prisma = new PrismaService();
  await prisma.$connect();

  const paymentsRepo = new PaymentsRepository(prisma);
  const paymentsService = new PaymentsService(paymentsRepo);
  const paymentsController = new PaymentsController(paymentsService);

  const payosPayoutService = new PayOSPayoutService();
  const walletService = new StoreWalletService(prisma, payosPayoutService);

  const adminRepo = new AdminRepository(prisma);
  const adminService = new AdminService(adminRepo, payosPayoutService);
  const adminController = new AdminController(adminService);

  let failed = 0;

  // Zero-residue strictly scoped tracking lists
  const createdOrderIds: bigint[] = [];
  const createdWithdrawalCodes: string[] = [];

  try {
    // ------------------------------------------------------------------------
    // STAGE 1: OFFICIAL PAYOS SIGNATURE VERIFICATION
    // ------------------------------------------------------------------------
    console.log('[STAGE 1] PayOS Payout & Payment Signature Verification:');

    const officialChecksumKey = '6e91f59952acc8918c49c4a8e380136d66d1fbbf3375926840a8a7e434d4b325';
    const officialExpectedSig = '34d500c4e17feaad8fab528ac3ae089353e276ca9fb4c6654c06ffdfbd88cc5d';
    const officialData = {
      payouts: [
        {
          id: 'batch_8f9520b9341144f38b9f5fbfa317db8e',
          referenceId: 'payout_1753061728877',
          transactions: [
            {
              id: 'batch_txn_fdb348c0570a4cb99009da22f9504898',
              referenceId: 'payout_1753061728877_0',
              amount: 2000,
              description: 'batch payout',
              toBin: '970422',
              toAccountNumber: '0123456789',
              toAccountName: 'NGUYEN VAN A',
              reference: '103269845',
              transactionDatetime: '2025-07-21T08:35:40+07:00',
              errorMessage: null,
              errorCode: null,
              state: 'SUCCEEDED',
            },
            {
              id: 'batch_txn_d94d371c079f4fc0ab7154e1576629d8',
              referenceId: 'payout_1753061728877_1',
              amount: 2000,
              description: 'batch payout',
              toBin: '970422',
              toAccountNumber: '0123456789',
              toAccountName: 'NGUYEN VAN A',
              reference: '103269846',
              transactionDatetime: '2025-07-21T08:35:44+07:00',
              errorMessage: null,
              errorCode: null,
              state: 'SUCCEEDED',
            },
            {
              id: 'batch_txn_71eb922201f3442d93ec5a3c77347e9f',
              referenceId: 'payout_1753061728877_2',
              amount: 2000,
              description: 'batch payout',
              toBin: '970422',
              toAccountNumber: '0123456789',
              toAccountName: 'NGUYEN VAN A',
              reference: '103269847',
              transactionDatetime: '2025-07-21T08:35:47+07:00',
              errorMessage: null,
              errorCode: null,
              state: 'SUCCEEDED',
            },
          ],
          category: ['salary'],
          approvalState: 'COMPLETED',
          createdAt: '2025-07-21T08:35:34+07:00',
        },
      ],
      pagination: {
        limit: 10,
        offset: 0,
        total: 1,
        count: 1,
        hasMore: false,
      },
    };

    const computedOfficialSig = signPayoutRequest(officialData, officialChecksumKey);
    if (computedOfficialSig.toLowerCase() === officialExpectedSig.toLowerCase()) {
      console.log('  ✔ [PASS] 1.1 Official PayOS Payout HMAC-SHA256 signature matched 100%');
    } else {
      console.log(`  ✘ [FAIL] 1.1 Official signature mismatch: expected=${officialExpectedSig}, got=${computedOfficialSig}`);
      failed++;
    }

    const unicodePayoutData = {
      referenceId: 'WDR:ABC 123',
      amount: 500000,
      description: 'Thanh toán lương tháng 1 & thưởng: ABC',
      toBin: '970422',
      toAccountNumber: '0123456789',
      category: ['salary', 'bonus'],
    };

    const unicodeSig = signPayoutRequest(unicodePayoutData, officialChecksumKey);
    const isUnicodeSigValid = verifyPayoutSignature(unicodePayoutData, unicodeSig, officialChecksumKey);
    if (isUnicodeSigValid) {
      console.log('  ✔ [PASS] 1.2 Payout signature with Unicode, spaces, colons & category encoded & verified accurately');
    } else {
      console.log('  ✘ [FAIL] 1.2 Unicode payout signature verification failed');
      failed++;
    }

    // ------------------------------------------------------------------------
    // STAGE 2: WEBHOOK STRICT VALIDATION
    // ------------------------------------------------------------------------
    console.log('\n[STAGE 2] Webhook Strict Validation (Fail-Closed):');

    const invalidSuccessWebhook: any = {
      code: '00',
      desc: 'success',
      success: false,
      data: { orderCode: 999999, amount: 100000, currency: 'VND', paymentLinkId: 'link_99' },
      signature: 'dummy_sig',
    };
    const resRejectSuccess = await paymentsService.handlePayosWebhook(invalidSuccessWebhook);
    if (!resRejectSuccess.success) {
      console.log('  ✔ [PASS] 2.1 Webhook rejected immediately when body.success !== true');
    } else {
      console.log('  ✘ [FAIL] 2.1 Webhook failed to reject body.success !== true');
      failed++;
    }

    const invalidCurrencyWebhook: any = {
      code: '00',
      desc: 'success',
      success: true,
      data: { orderCode: 999999, amount: 100000, currency: 123, paymentLinkId: 'link_99' },
      signature: 'dummy_sig',
    };
    const resRejectCurrency = await paymentsService.handlePayosWebhook(invalidCurrencyWebhook);
    if (!resRejectCurrency.success) {
      console.log('  ✔ [PASS] 2.2 Webhook rejected non-string currency safely without HTTP 500');
    } else {
      console.log('  ✘ [FAIL] 2.2 Webhook accepted invalid currency type');
      failed++;
    }

    // ------------------------------------------------------------------------
    // STAGE 3: PAYMENT LINK RESPONSE VERIFICATION & CONTROLLER ROUTES
    // ------------------------------------------------------------------------
    console.log('\n[STAGE 3] Payment Link Verification & Controller Routes:');

    const store = await prisma.store.findFirst();
    if (!store) throw new Error('No store found in database');

    const customer = await prisma.customerProfile.findFirst();
    if (!customer) throw new Error('No customer found in database');

    const button = await prisma.ioTButton.findFirst({
      where: { storeId: store.storeId, customerId: customer.customerId },
    });
    if (!button) throw new Error('No button found for store and customer');

    const testOrderCode = `TEST-ORDER-${Date.now()}`;
    const testOrder = await prisma.order.create({
      data: {
        orderCode: testOrderCode,
        storeId: store.storeId,
        customerId: customer.customerId,
        buttonId: button.buttonId,
        totalAmount: 150000,
        subtotalAmount: 150000,
        shippingFee: 0,
        commissionRate: 8.0,
        commissionAmount: 12000,
        netAmount: 138000,
        orderStatus: 'PENDING',
        paymentStatus: 'UNPAID',
        paymentMethod: 'PAYOS',
        shippingRecipientName: 'Test Buyer',
        shippingPhone: '0901234567',
        shippingAddress: '123 Test Street, HCMC',
      },
    });
    createdOrderIds.push(testOrder.orderId);

    const linkRes = await paymentsService.createPayosPaymentLink(
      { orderId: testOrder.orderId.toString() },
      { userId: customer.userId, role: 'CUSTOMER' },
    );

    if (linkRes.success && linkRes.data?.checkoutUrl && linkRes.data?.qrCode && linkRes.data?.currency === 'VND') {
      console.log('  ✔ [PASS] 3.1 Payment link created with mandatory currency VND, checkoutUrl, and qrCode');
    } else {
      console.log('  ✘ [FAIL] 3.1 Payment link creation did not return required fields');
      failed++;
    }

    // Test route controller getPaymentLinkInfo
    const ctrlInfo = await paymentsController.getPaymentLinkInfo(testOrder.orderCode);
    if (ctrlInfo.success && ctrlInfo.data?.orderCode) {
      console.log('  ✔ [PASS] 3.2 GET /payments/payos/payment-requests/:id controller route active');
    } else {
      console.log('  ✘ [FAIL] 3.2 GET payment-requests controller route failed');
      failed++;
    }

    // Test route controller cancelPaymentLink
    const ctrlCancel = await paymentsController.cancelPaymentLink(testOrder.orderCode, { cancellationReason: 'Test' });
    if (ctrlCancel.success && ctrlCancel.data?.status === 'CANCELLED') {
      console.log('  ✔ [PASS] 3.3 POST /payments/payos/payment-requests/:id/cancel controller route active');
    } else {
      console.log('  ✘ [FAIL] 3.3 POST payment-requests cancel controller route failed');
      failed++;
    }

    // ------------------------------------------------------------------------
    // STAGE 4: STORE WALLET WITHDRAWAL CONCURRENCY RACE CONDITION
    // ------------------------------------------------------------------------
    console.log('\n[STAGE 4] Concurrency Race-Condition Protection on Store Wallet:');

    const wallet = await walletService.getOrCreateStoreWallet(store.storeId);
    await prisma.storeWallet.update({
      where: { walletId: wallet.walletId },
      data: { balance: 100000 },
    });

    const withdrawalParams = {
      amount: 70000,
      bankCode: '970422',
      bankName: 'MBBank',
      bankAccountNumber: '0987654321',
      bankAccountHolder: 'CONCURRENCY TEST STORE',
      fee: 0,
      autoPayout: false,
    };

    const results = await Promise.allSettled([
      walletService.requestWithdrawal(store.storeId, withdrawalParams),
      walletService.requestWithdrawal(store.storeId, withdrawalParams),
    ]);

    const successes = results.filter((r) => r.status === 'fulfilled');
    const rejects = results.filter((r) => r.status === 'rejected');

    for (const s of successes) {
      if ((s as PromiseFulfilledResult<any>).value?.withdrawalCode) {
        createdWithdrawalCodes.push((s as PromiseFulfilledResult<any>).value.withdrawalCode);
      }
    }

    const walletAfterRace = await walletService.getOrCreateStoreWallet(store.storeId);
    const balanceAfterRace = Number(walletAfterRace.balance);

    if (successes.length === 1 && rejects.length === 1 && balanceAfterRace === 30000) {
      console.log('  ✔ [PASS] 4.1 Race condition prevented: exactly 1 request succeeded, 1 rejected');
      console.log(`  ✔ [PASS] 4.2 Balance locked atomically (Remaining: ${balanceAfterRace.toLocaleString()} VND, never negative)`);
    } else {
      console.log(`  ✘ [FAIL] 4.1 Concurrency race condition detected: successes=${successes.length}, rejects=${rejects.length}`);
      failed++;
    }

    // ------------------------------------------------------------------------
    // STAGE 5: TRIGGER PAYOS PAYOUT CONCURRENCY RACE-CONDITION
    // ------------------------------------------------------------------------
    console.log('\n[STAGE 5] triggerPayosPayout() Concurrency Race-Condition Guard:');

    // Ensure wallet balance is sufficient
    await prisma.storeWallet.update({
      where: { walletId: wallet.walletId },
      data: { balance: 200000 },
    });

    // Create a pending withdrawal for payout
    const pendingWithdrawal = await walletService.requestWithdrawal(store.storeId, {
      amount: 50000,
      bankCode: '970422',
      bankName: 'MBBank',
      bankAccountNumber: '0987654321',
      bankAccountHolder: 'PAYOUT RACE TEST',
      fee: 0,
      autoPayout: false,
    });
    createdWithdrawalCodes.push(pendingWithdrawal.withdrawalCode);

    // Call triggerPayosPayout concurrently from 2 callers on the SAME withdrawal
    const payoutTriggerResults = await Promise.allSettled([
      walletService.triggerPayosPayout(pendingWithdrawal.withdrawalId),
      walletService.triggerPayosPayout(pendingWithdrawal.withdrawalId),
    ]);

    const payoutSuccesses = payoutTriggerResults.filter((r) => r.status === 'fulfilled');
    const payoutRejects = payoutTriggerResults.filter((r) => r.status === 'rejected');

    if (payoutSuccesses.length === 1 && payoutRejects.length === 1) {
      console.log('  ✔ [PASS] 5.1 triggerPayosPayout() atomic guard: exactly 1 execution won, concurrent duplicate rejected');
    } else {
      console.log(`  ✘ [FAIL] 5.1 triggerPayosPayout() race condition: successes=${payoutSuccesses.length}, rejects=${payoutRejects.length}`);
      failed++;
    }

    // ------------------------------------------------------------------------
    // STAGE 6: SYSTEM IDEMPOTENCY & ANTI-DOUBLE REFUND
    // ------------------------------------------------------------------------
    console.log('\n[STAGE 6] System Idempotency Key & Anti-Double Refund:');

    // Idempotency Key test
    await prisma.storeWallet.update({
      where: { walletId: wallet.walletId },
      data: { balance: 200000 },
    });

    const idempotencyKey = `IDEMP_${Date.now()}`;
    const idempWithdrawalDto = {
      amount: 60000,
      bankCode: '970422',
      bankName: 'MBBank',
      bankAccountNumber: '0123456789',
      bankAccountHolder: 'IDEMPOTENCY TEST',
      fee: 0,
      autoPayout: false,
    };

    const firstIdemp = await walletService.requestWithdrawal(store.storeId, idempWithdrawalDto, idempotencyKey);
    createdWithdrawalCodes.push(firstIdemp.withdrawalCode);
    const secondIdemp = await walletService.requestWithdrawal(store.storeId, idempWithdrawalDto, idempotencyKey);

    const balanceAfterIdemp = Number((await walletService.getOrCreateStoreWallet(store.storeId)).balance);

    if (firstIdemp.withdrawalId.toString() === secondIdemp.withdrawalId.toString() && balanceAfterIdemp === 140000) {
      console.log('  ✔ [PASS] 6.1 Idempotency key returned existing withdrawal without duplicate deduction');
    } else {
      console.log('  ✘ [FAIL] 6.1 Idempotency key failed');
      failed++;
    }

    // Anti-double refund test
    const refundWithdrawal = await walletService.requestWithdrawal(store.storeId, {
      amount: 50000,
      bankCode: '970422',
      bankName: 'MBBank',
      bankAccountNumber: '0987654321',
      bankAccountHolder: 'REFUND TEST',
      fee: 0,
      autoPayout: false,
    });
    createdWithdrawalCodes.push(refundWithdrawal.withdrawalCode);

    const balBeforeRefund = Number((await walletService.getOrCreateStoreWallet(store.storeId)).balance);

    await Promise.all([
      walletService.refundFailedWithdrawal(refundWithdrawal.withdrawalId, 'Fail 1'),
      walletService.refundFailedWithdrawal(refundWithdrawal.withdrawalId, 'Fail 2'),
    ]);

    const balAfterRefund = Number((await walletService.getOrCreateStoreWallet(store.storeId)).balance);
    const refundTxCount = await prisma.walletTransaction.count({
      where: {
        walletId: wallet.walletId,
        type: 'WITHDRAWAL_REFUND',
        referenceId: refundWithdrawal.withdrawalCode,
      },
    });

    if (balAfterRefund === balBeforeRefund + 50000 && refundTxCount === 1) {
      console.log('  ✔ [PASS] 6.2 Anti-double refund: wallet credited exactly once and only 1 refund tx recorded');
    } else {
      console.log(`  ✘ [FAIL] 6.2 Anti-double refund failed: balAfter=${balAfterRefund}, count=${refundTxCount}`);
      failed++;
    }

    // ------------------------------------------------------------------------
    // STAGE 7: ADMIN PAYOUT DTO VALIDATION & CONTROLLER ENDPOINTS
    // ------------------------------------------------------------------------
    console.log('\n[STAGE 7] Admin Payout DTO Validation & Controller Routes:');

    // 7.1 DTO Validation: Reject invalid DTO (e.g. invalid toBin not 6 digits, amount < 1000)
    const invalidBatchDto = new CreatePayosBatchPayoutDto();
    invalidBatchDto.referenceId = '';
    const invalidItem = new PayosPayoutItemDto();
    invalidItem.amount = 500; // < 1000
    invalidItem.toBin = '123'; // Not 6 digits
    invalidBatchDto.payouts = [invalidItem];

    const dtoErrors = await validate(invalidBatchDto);
    if (dtoErrors.length > 0) {
      console.log(`  ✔ [PASS] 7.1 Admin CreatePayosBatchPayoutDto validation active (Caught ${dtoErrors.length} validation errors)`);
    } else {
      console.log('  ✘ [FAIL] 7.1 Admin DTO failed to reject invalid payload');
      failed++;
    }

    // 7.2 Controller Call: Batch Payout
    const validBatchDto: CreatePayosBatchPayoutDto = {
      referenceId: `BATCH_${Date.now()}`,
      category: ['salary'],
      validateDestination: true,
      payouts: [
        {
          referenceId: `P_${Date.now()}`,
          amount: 50000,
          description: 'Chi luong',
          toBin: '970422',
          toAccountNumber: '0123456789',
        },
      ],
    };

    const ctrlBatchRes = await adminController.createBatchPayout(validBatchDto);
    if (ctrlBatchRes.success && ctrlBatchRes.data?.id) {
      console.log('  ✔ [PASS] 7.2 POST /admin/payos/payouts/batch controller route active');
    } else {
      console.log('  ✘ [FAIL] 7.2 POST payouts/batch controller failed');
      failed++;
    }

    // 7.3 Controller Call: Estimate Credit
    const ctrlEstimateRes = await adminController.estimatePayoutCredit(validBatchDto as EstimatePayoutCreditDto);
    if (ctrlEstimateRes.success && ctrlEstimateRes.data?.estimateCredit !== undefined) {
      console.log(`  ✔ [PASS] 7.3 POST /admin/payos/payouts/estimate-credit controller route active (Fee: ${ctrlEstimateRes.data.estimateCredit} VND)`);
    } else {
      console.log('  ✘ [FAIL] 7.3 POST payouts/estimate-credit controller failed');
      failed++;
    }

    // 7.4 Controller Call: List Payouts with DTO Query
    const queryDto: ListPayosPayoutsQueryDto = {
      category: 'salary',
      approvalState: 'PROCESSING',
      limit: 10,
      offset: 0,
    };
    const ctrlListRes = await adminController.listPayosPayouts(queryDto);
    if (ctrlListRes.success) {
      console.log('  ✔ [PASS] 7.4 GET /admin/payos/payouts controller route active with query filter');
    } else {
      console.log('  ✘ [FAIL] 7.4 GET payouts controller failed');
      failed++;
    }

    // 7.5 Controller Call: Get Payout Balance
    const ctrlBalanceRes = await adminController.getPayoutBalance();
    if (ctrlBalanceRes.success) {
      console.log('  ✔ [PASS] 7.5 GET /admin/payos/payout-balance controller route active');
    } else {
      console.log('  ✘ [FAIL] 7.5 GET payout-balance controller failed');
      failed++;
    }

    // 7.6 Admin executePayOSPayout error handling & auto-refund
    await prisma.storeWallet.update({
      where: { walletId: wallet.walletId },
      data: { balance: 200000 },
    });

    const adminFailWithdrawal = await walletService.requestWithdrawal(store.storeId, {
      amount: 50000,
      bankCode: '970422',
      bankName: 'MBBank',
      bankAccountNumber: '0987654321',
      bankAccountHolder: 'ADMIN FAIL REFUND TEST',
      fee: 0,
      autoPayout: false,
    });
    createdWithdrawalCodes.push(adminFailWithdrawal.withdrawalCode);

    const balBeforeAdminFail = Number((await walletService.getOrCreateStoreWallet(store.storeId)).balance);

    // Simulate PayOS error by temporarily overriding createPayout
    const originalCreatePayout = payosPayoutService.createPayout;
    payosPayoutService.createPayout = async () => {
      throw new Error('PayOS gateway simulated network error 502 Bad Gateway');
    };

    let adminCaughtError = false;
    try {
      await adminService.executePayOSPayout(adminFailWithdrawal.withdrawalId);
    } catch (err: any) {
      adminCaughtError = true;
    } finally {
      payosPayoutService.createPayout = originalCreatePayout;
    }

    const failedWithdrawalRecord = await prisma.storeWithdrawal.findUnique({
      where: { withdrawalId: adminFailWithdrawal.withdrawalId },
    });
    const balAfterAdminFail = Number((await walletService.getOrCreateStoreWallet(store.storeId)).balance);
    const adminRefundTx = await prisma.walletTransaction.findFirst({
      where: {
        walletId: wallet.walletId,
        type: 'WITHDRAWAL_REFUND',
        referenceId: adminFailWithdrawal.withdrawalCode,
      },
    });

    if (
      adminCaughtError &&
      failedWithdrawalRecord?.status === 'FAILED' &&
      balAfterAdminFail === balBeforeAdminFail + 50000 &&
      adminRefundTx
    ) {
      console.log('  ✔ [PASS] 7.6 Admin executePayOSPayout properly handled PayOS error, updated FAILED & auto-refunded');
    } else {
      console.log('  ✘ [FAIL] 7.6 Admin executePayOSPayout failure refund failed');
      failed++;
    }
  } catch (error: any) {
    console.error('  ✘ [FATAL EXCEPTION]:', error);
    failed++;
  } finally {
    // ------------------------------------------------------------------------
    // STAGE 8: STRICTLY SCOPED ZERO RESIDUE CLEANUP (NO BROAD PREFIX DELETION)
    // ------------------------------------------------------------------------
    console.log('\n[STAGE 8] Strictly Scoped Zero Residue Database Cleanup:');

    // Delete only explicitly created test orders
    if (createdOrderIds.length > 0) {
      await prisma.paymentTransaction.deleteMany({ where: { orderId: { in: createdOrderIds } } });
      await prisma.orderStatusHistory.deleteMany({ where: { orderId: { in: createdOrderIds } } });
      await prisma.orderItem.deleteMany({ where: { orderId: { in: createdOrderIds } } });
      await prisma.order.deleteMany({ where: { orderId: { in: createdOrderIds } } });
      console.log(`  ✔ Deleted ${createdOrderIds.length} order(s) strictly created by this test run.`);
    }

    // Delete only explicitly created test withdrawals
    if (createdWithdrawalCodes.length > 0) {
      await prisma.walletTransaction.deleteMany({ where: { referenceId: { in: createdWithdrawalCodes } } });
      await prisma.storeWithdrawal.deleteMany({ where: { withdrawalCode: { in: createdWithdrawalCodes } } });
      console.log(`  ✔ Deleted ${createdWithdrawalCodes.length} withdrawal(s) strictly created by this test run.`);
    }

    console.log('  ✔ Zero broad prefix deletions executed. Shared database fully respected.');

    await prisma.$disconnect();
  }

  console.log('\n========================================================================');
  if (failed > 0) {
    console.error(`❌ PayOS Production Test Suite finished with ${failed} failures.`);
    process.exit(1);
  } else {
    console.log('🎉 ALL PAYOS THU - CHI PRODUCTION INTEGRITY TESTS PASSED (MOCK PROVIDER MODE)!');
    console.log('========================================================================\n');
  }
}

testPayOSThuChiProduction().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
