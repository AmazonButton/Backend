import { PrismaService } from '../src/prisma/prisma.service';
import { PaymentsService } from '../src/payments/payments.service';
import { PaymentsRepository } from '../src/payments/payments.repository';
import { PayOSPayoutService } from '../src/payments/payos-payout.service';
import { StoreWalletService } from '../src/store-wallet/store-wallet.service';
import {
  signPaymentRequest,
  signPayoutRequest,
  verifyWebhookSignature,
  verifyPayoutSignature,
  deepSortObj,
  buildPayoutQueryString,
} from '../src/payments/payos.helper';

async function testPayOSThuChiProduction() {
  console.log('========================================================================');
  console.log('🚀 PAYOS THU - CHI: PRODUCTION INTEGRITY & CONCURRENCY TEST SUITE');
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
  const payosPayoutService = new PayOSPayoutService();
  const walletService = new StoreWalletService(prisma, payosPayoutService);

  let failed = 0;

  // Zero-residue tracking lists
  const createdOrderIds: bigint[] = [];
  const createdWithdrawalCodes: string[] = [];

  try {
    // ------------------------------------------------------------------------
    // POINT 1: CHỮ KÝ PAYOS PAYOUT VỚI DỮ LIỆU THỰC TẾ (UNICODE, URL-ENCODING, OFFICIAL FIXTURE)
    // ------------------------------------------------------------------------
    console.log('[STAGE 1] PayOS Payout & Payment Signature Verification:');

    // 1.1 PayOS Official Documentation Fixture Verification
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

    // 1.2 Unicode, Spaces, Colons, Ampersands, Category Payout Signature
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
    const isTamperedSigRejected = !verifyPayoutSignature(unicodePayoutData, 'invalid_sig_abc123', officialChecksumKey);

    if (isUnicodeSigValid && isTamperedSigRejected) {
      console.log('  ✔ [PASS] 1.2 Payout signature with Unicode, spaces, colons & category encoded & verified accurately');
    } else {
      console.log('  ✘ [FAIL] 1.2 Unicode payout signature verification failed');
      failed++;
    }

    // ------------------------------------------------------------------------
    // POINT 5: WEBHOOK BẮT BUỘC success === true & VALIDATE CURRENCY STRING
    // ------------------------------------------------------------------------
    console.log('\n[STAGE 2] Webhook Strict Validation (Fail-Closed):');

    // 2.1 Reject if body.success !== true
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

    // 2.2 Reject non-string currency safely (No HTTP 500)
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
    // POINT 6: TẠO PAYMENT LINK & LƯU ĐẦY ĐỦ checkoutUrl, qrCode
    // ------------------------------------------------------------------------
    console.log('\n[STAGE 3] Payment Link Response Verification & Field Persistence:');

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

    if (linkRes.success && linkRes.data?.checkoutUrl && linkRes.data?.qrCode) {
      console.log('  ✔ [PASS] 3.1 Payment link created and returned complete checkoutUrl & qrCode');
    } else {
      console.log('  ✘ [FAIL] 3.1 Payment link creation did not return checkoutUrl or qrCode');
      failed++;
    }

    // Verify DB persisted checkoutUrl and qrCode
    const persistedTx = await paymentsRepo.findTransactionById(BigInt(linkRes.data.paymentTransactionId));
    if ((persistedTx as any)?.checkoutUrl && (persistedTx as any)?.qrCode) {
      console.log('  ✔ [PASS] 3.2 Database PaymentTransaction persisted full checkoutUrl and qrCode');
    } else {
      console.log('  ✘ [FAIL] 3.2 PaymentTransaction did not persist checkoutUrl or qrCode');
      failed++;
    }

    // ------------------------------------------------------------------------
    // POINT 2: RACE CONDITION RÚT TIỀN (CONCURRENT WITHDRAWALS CANNOT OVERDRAW)
    // ------------------------------------------------------------------------
    console.log('\n[STAGE 4] Concurrency Race-Condition Protection on Store Wallet:');

    const wallet = await walletService.getOrCreateStoreWallet(store.storeId);
    // Explicitly set store wallet balance to 100,000 VND
    await prisma.storeWallet.update({
      where: { walletId: wallet.walletId },
      data: { balance: 100000 },
    });

    // Launch 2 concurrent withdrawal requests for 70,000 VND each (Total = 140,000 > 100,000)
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
      console.log(`  ✔ [PASS] 4.1 Race condition prevented: exactly 1 request succeeded, 1 rejected with insufficient funds`);
      console.log(`  ✔ [PASS] 4.2 Balance locked atomically (100,000 - 70,000 = ${balanceAfterRace.toLocaleString()} VND, never negative)`);
    } else {
      console.log(`  ✘ [FAIL] 4.1 Concurrency race condition detected: successes=${successes.length}, rejects=${rejects.length}, balance=${balanceAfterRace}`);
      failed++;
    }

    // ------------------------------------------------------------------------
    // POINT 3: ENDPOINT RÚT TIỀN IDEMPOTENCY KEY PHÍA HỆ THỐNG
    // ------------------------------------------------------------------------
    console.log('\n[STAGE 5] System-Side Idempotency Key on Withdrawals:');

    // Give wallet 200,000 balance
    await prisma.storeWallet.update({
      where: { walletId: wallet.walletId },
      data: { balance: 200000 },
    });

    const idempotencyKey = `IDEMP_KEY_TEST_${Date.now()}`;
    const idempWithdrawalDto = {
      amount: 60000,
      bankCode: '970422',
      bankName: 'MBBank',
      bankAccountNumber: '0123456789',
      bankAccountHolder: 'IDEMPOTENCY TEST',
      fee: 0,
      autoPayout: false,
    };

    const firstIdempReq = await walletService.requestWithdrawal(store.storeId, idempWithdrawalDto, idempotencyKey);
    createdWithdrawalCodes.push(firstIdempReq.withdrawalCode);

    const balanceAfterFirst = Number((await walletService.getOrCreateStoreWallet(store.storeId)).balance);

    // Retry with SAME idempotencyKey
    const secondIdempReq = await walletService.requestWithdrawal(store.storeId, idempWithdrawalDto, idempotencyKey);
    const balanceAfterSecond = Number((await walletService.getOrCreateStoreWallet(store.storeId)).balance);

    if (
      firstIdempReq.withdrawalId.toString() === secondIdempReq.withdrawalId.toString() &&
      balanceAfterFirst === 140000 &&
      balanceAfterSecond === 140000
    ) {
      console.log('  ✔ [PASS] 5.1 Duplicate withdrawal request with same Idempotency-Key returned existing withdrawal');
      console.log(`  ✔ [PASS] 5.2 Wallet was not debited a second time (Balance remained at ${balanceAfterSecond.toLocaleString()} VND)`);
    } else {
      console.log('  ✘ [FAIL] 5.1 Idempotency key failed to prevent duplicate withdrawal');
      failed++;
    }

    // ------------------------------------------------------------------------
    // POINT 4: AUTO-REFUND CHỐNG GỌI TRÙNG (ANTI-DOUBLE REFUND CONCURRENCY)
    // ------------------------------------------------------------------------
    console.log('\n[STAGE 6] Anti-Double Refund Concurrency & Ledger Integrity:');

    // Create a withdrawal to test refund
    const refundTestWithdrawal = await walletService.requestWithdrawal(store.storeId, {
      amount: 50000,
      bankCode: '970422',
      bankName: 'MBBank',
      bankAccountNumber: '0987654321',
      bankAccountHolder: 'REFUND TEST',
      fee: 0,
      autoPayout: false,
    });
    createdWithdrawalCodes.push(refundTestWithdrawal.withdrawalCode);

    const balanceBeforeRefund = Number((await walletService.getOrCreateStoreWallet(store.storeId)).balance);

    // Call refundFailedWithdrawal concurrently from 2 callers
    const refundResults = await Promise.all([
      walletService.refundFailedWithdrawal(refundTestWithdrawal.withdrawalId, 'Concurrent failure 1'),
      walletService.refundFailedWithdrawal(refundTestWithdrawal.withdrawalId, 'Concurrent failure 2'),
    ]);

    const balanceAfterDoubleRefund = Number((await walletService.getOrCreateStoreWallet(store.storeId)).balance);

    // Check ledger transactions for WITHDRAWAL_REFUND
    const refundTxs = await prisma.walletTransaction.findMany({
      where: {
        walletId: wallet.walletId,
        type: 'WITHDRAWAL_REFUND',
        referenceId: refundTestWithdrawal.withdrawalCode,
      },
    });

    if (balanceAfterDoubleRefund === balanceBeforeRefund + 50000 && refundTxs.length === 1) {
      console.log(`  ✔ [PASS] 6.1 Concurrent auto-refund calls credited wallet exactly once (+50,000 VND)`);
      console.log(`  ✔ [PASS] 6.2 Unique ledger reference prevented double refund transactions (Found exactly 1 refund tx)`);
    } else {
      console.log(`  ✘ [FAIL] 6.1 Anti-double refund failed: balanceAfter=${balanceAfterDoubleRefund}, refundTxsCount=${refundTxs.length}`);
      failed++;
    }

    // ------------------------------------------------------------------------
    // POINT 7: TRIỂN KHAI TOÀN BỘ PAYOS APIS (PAYMENT LINK & PAYOUT BATCH / ESTIMATE)
    // ------------------------------------------------------------------------
    console.log('\n[STAGE 7] Full PayOS API Implementation Coverage:');

    // 7.1 Get Payment Link Information
    const linkInfo = await paymentsService.getPaymentLinkInformation(testOrder.orderCode);
    if (linkInfo?.code === '00') {
      console.log('  ✔ [PASS] 7.1 getPaymentLinkInformation API operational');
    } else {
      console.log('  ✘ [FAIL] 7.1 getPaymentLinkInformation failed');
      failed++;
    }

    // 7.2 Cancel Payment Link
    const cancelRes = await paymentsService.cancelPaymentLink(testOrder.orderCode, 'Test cancellation');
    if (cancelRes?.code === '00' && cancelRes.data?.status === 'CANCELLED') {
      console.log('  ✔ [PASS] 7.2 cancelPaymentLink API operational');
    } else {
      console.log('  ✘ [FAIL] 7.2 cancelPaymentLink failed');
      failed++;
    }

    // 7.3 Create Batch Payout
    const batchPayload = {
      referenceId: `BATCH_${Date.now()}`,
      category: ['salary'],
      validateDestination: true,
      payouts: [
        {
          referenceId: `P1_${Date.now()}`,
          amount: 50000,
          description: 'Luong 1',
          toBin: '970422',
          toAccountNumber: '0123456789',
        },
      ],
    };
    const batchRes = await payosPayoutService.createBatchPayout(batchPayload);
    if (batchRes?.code === '00' && batchRes.data?.id) {
      console.log('  ✔ [PASS] 7.3 createBatchPayout API operational');
    } else {
      console.log('  ✘ [FAIL] 7.3 createBatchPayout failed');
      failed++;
    }

    // 7.4 Estimate Credit Fee
    const estimateRes = await payosPayoutService.estimateCredit(batchPayload);
    if (estimateRes?.code === '00' && estimateRes.data?.estimateCredit !== undefined) {
      console.log(`  ✔ [PASS] 7.4 estimateCredit API operational (Estimated fee: ${estimateRes.data.estimateCredit} VND)`);
    } else {
      console.log('  ✘ [FAIL] 7.4 estimateCredit failed');
      failed++;
    }

    // 7.5 List Payouts with full query filters
    const listRes = await payosPayoutService.getPayouts({
      category: 'salary',
      approvalState: 'PROCESSING',
      fromDate: '2026-01-01T00:00:00Z',
      toDate: '2026-12-31T23:59:59Z',
      limit: 5,
      offset: 0,
    });
    if (listRes?.code === '00') {
      console.log('  ✔ [PASS] 7.5 getPayouts with category, fromDate, toDate filters operational');
    } else {
      console.log('  ✘ [FAIL] 7.5 getPayouts failed');
      failed++;
    }

    // 7.6 Get Payout Balance
    const balanceRes = await payosPayoutService.getPayoutBalance();
    if (balanceRes?.code === '00') {
      console.log('  ✔ [PASS] 7.6 getPayoutBalance API operational');
    } else {
      console.log('  ✘ [FAIL] 7.6 getPayoutBalance failed');
      failed++;
    }
  } catch (error: any) {
    console.error('  ✘ [FATAL EXCEPTION]:', error);
    failed++;
  } finally {
    // ------------------------------------------------------------------------
    // POINT 8: ZERO RESIDUE CLEANUP (XÓA SẠCH DỮ LIỆU TEST TRÊN DATABASE)
    // ------------------------------------------------------------------------
    console.log('\n[STAGE 8] Zero Residue Database Cleanup:');

    // Clean up created orders & related payment transactions
    for (const orderId of createdOrderIds) {
      await prisma.paymentTransaction.deleteMany({ where: { orderId } });
      await prisma.orderStatusHistory.deleteMany({ where: { orderId } });
      await prisma.orderItem.deleteMany({ where: { orderId } });
      await prisma.order.delete({ where: { orderId } });
    }
    console.log(`  ✔ Cleaned up ${createdOrderIds.length} test order(s) and related payment transactions.`);

    // Clean up created withdrawals & related ledger transactions
    for (const code of createdWithdrawalCodes) {
      await prisma.walletTransaction.deleteMany({ where: { referenceId: code } });
      await prisma.storeWithdrawal.deleteMany({ where: { withdrawalCode: code } });
    }
    console.log(`  ✔ Cleaned up ${createdWithdrawalCodes.length} test withdrawal(s) and related wallet transactions.`);

    // Sweep any lingering TEST-ORDER-% or WDR-% test records
    const leftoverOrders = await prisma.order.deleteMany({
      where: { orderCode: { startsWith: 'TEST-ORDER-' } },
    });
    const leftoverWithdrawals = await prisma.storeWithdrawal.deleteMany({
      where: { withdrawalCode: { startsWith: 'WDR-' } },
    });
    console.log(`  ✔ Final sweep: removed ${leftoverOrders.count} leftover orders & ${leftoverWithdrawals.count} leftover withdrawals.`);

    await prisma.$disconnect();
  }

  console.log('\n========================================================================');
  if (failed > 0) {
    console.error(`❌ PayOS Thu - Chi Test Suite failed with ${failed} failures.`);
    process.exit(1);
  } else {
    console.log('🎉 ALL PAYOS THU - CHI PRODUCTION TESTS PASSED (8/8 CRITERIA SATISFIED)!');
    console.log('========================================================================\n');
  }
}

testPayOSThuChiProduction().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
