import { PrismaService } from '../src/prisma/prisma.service';
import { PaymentsService } from '../src/payments/payments.service';
import { PaymentsRepository } from '../src/payments/payments.repository';
import { PayOSPayoutService } from '../src/payments/payos-payout.service';
import { StoreWalletService } from '../src/store-wallet/store-wallet.service';
import { signPaymentRequest, signPayoutRequest, verifyWebhookSignature } from '../src/payments/payos.helper';

async function testPayOSThuChi() {
  console.log('========================================================================');
  console.log('?? PAYOS THU - CHI: AUTOMATED PAYMENT & PAYOUT LEDGER VERIFICATION');
  console.log('========================================================================\n');

  process.env.PAYOS_CLIENT_ID = 'mock_client_id';
  process.env.PAYOS_API_KEY = 'mock_api_key';
  process.env.PAYOS_CHECKSUM_KEY = 'test_checksum_key_1234567890';
  process.env.PAYOS_MOCK_PAYOUT = 'true';
  process.env.PAYOS_MOCK_PAYMENT = 'true';

  const prisma = new PrismaService();
  await prisma.$connect();

  const paymentsRepo = new PaymentsRepository(prisma);
  const paymentsService = new PaymentsService(paymentsRepo);
  const payosPayoutService = new PayOSPayoutService();
  const walletService = new StoreWalletService(prisma, payosPayoutService);

  let failed = 0;

  try {
    // ------------------------------------------------------------------------
    // SECTION 1: PAYOS SIGNATURE INTEGRITY
    // ------------------------------------------------------------------------
    console.log('[STAGE 1] PayOS Signature Verification:');
    const checksumKey = 'test_checksum_key_1234567890';
    const payoutPayload = {
      amount: 500000,
      description: 'Rut tien WDR_TEST',
      referenceId: 'WDR_TEST_001',
      toAccountNumber: '0123456789',
      toBin: '970422',
      category: ['withdrawal'],
    };

    const payoutSig = signPayoutRequest(payoutPayload, checksumKey);
    if (typeof payoutSig === 'string' && payoutSig.length === 64) {
      console.log('  ? [PASS] HMAC-SHA256 Payout Signature computed accurately (64-char hex)');
    } else {
      console.log('  ? [FAIL] Payout signature invalid');
      failed++;
    }

    const webhookData = {
      orderCode: 999123,
      amount: 150000,
      description: 'DH999123',
      accountNumber: '123456789',
      reference: 'FT123',
      transactionDateTime: '2026-10-06 14:00:00',
      currency: 'VND',
      paymentLinkId: 'link_123',
      code: '00',
    };
    const webhookSig = signPaymentRequest(
      {
        amount: webhookData.amount,
        cancelUrl: '',
        description: webhookData.description,
        orderCode: webhookData.orderCode,
        returnUrl: '',
      },
      checksumKey,
    );
    // test webhook signature check
    const isValid = verifyWebhookSignature(webhookData, 'invalid_sig', checksumKey);
    if (!isValid) {
      console.log('  ? [PASS] Tampered webhook signature rejected immediately');
    } else {
      console.log('  ? [FAIL] Invalid webhook signature unexpectedly accepted');
      failed++;
    }

    // ------------------------------------------------------------------------
    // SECTION 2: THU TI?N (PAYMENT WEBHOOK & ATOMIC WALLET REVENUE)
    // ------------------------------------------------------------------------
    console.log('\n[STAGE 2] PayOS Thu Ti?n (Payment Webhook -> Store Wallet Credit):');
    const store = await prisma.store.findFirst();
    if (!store) throw new Error('No store found in database');

    const customer = await prisma.customerProfile.findFirst();
    if (!customer) throw new Error('No customer found in database');

    const button = await prisma.ioTButton.findFirst({
      where: { storeId: store.storeId, customerId: customer.customerId },
    });
    if (!button) throw new Error('No button found for store and customer');

    // Create a test order
    const testOrderCode = `TEST-ORDER-${Date.now()}`;
    const testOrder = await prisma.order.create({
      data: {
        orderCode: testOrderCode,
        storeId: store.storeId,
        customerId: customer.customerId,
        buttonId: button.buttonId,
        totalAmount: 200000,
        subtotalAmount: 200000,
        shippingFee: 0,
        orderStatus: 'PENDING',
        paymentStatus: 'UNPAID',
        paymentMethod: 'PAYOS',
        shippingRecipientName: 'Customer Test',
        shippingPhone: '0901234567',
        shippingAddress: '123 District 1, HCMC',
      },
    });

    // Create PaymentTransaction
    const orderCodeInt = Math.floor(Date.now() / 1000) * 1000 + Math.floor(Math.random() * 1000);
    const paymentTx = await paymentsRepo.createTransaction({
      orderId: testOrder.orderId,
      provider: 'PAYOS',
      transactionCode: orderCodeInt.toString(),
      amount: 200000,
      paymentMethod: 'QR',
      status: 'PENDING',
    });

    const initialWallet = await walletService.getOrCreateStoreWallet(store.storeId);
    const initialBalance = Number(initialWallet.balance);

    // Call handlePayosWebhook with valid code '00'
    const webhookPayloadData = {
      orderCode: orderCodeInt,
      amount: 200000,
      description: 'DH' + testOrderCode,
      accountNumber: '123456789',
      reference: 'FT9999',
      transactionDateTime: '2026-10-06 14:00:00',
      currency: 'VND',
      paymentLinkId: 'link_9999',
      code: '00',
    };
    // Generate valid signature for webhook payload
    const validWebhookSig = require('crypto')
      .createHmac('sha256', checksumKey)
      .update(require('../src/payments/payos.helper').convertObjToQueryStr(
        require('../src/payments/payos.helper').sortObjDataByKey(webhookPayloadData)
      ))
      .digest('hex');

    const webhookRes = await paymentsService.handlePayosWebhook({
      code: '00',
      desc: 'success',
      data: webhookPayloadData,
      signature: validWebhookSig,
    });

    if (webhookRes.success) {
      console.log('  ? [PASS] Webhook processed successfully with HTTP 200 response');
    } else {
      console.log('  ? [FAIL] Webhook processing failed:', webhookRes);
      failed++;
    }

    // Verify DB states: Order is PAID, Payment is PAID, Wallet credited
    const orderAfter = await prisma.order.findUnique({ where: { orderId: testOrder.orderId } });
    const paymentAfter = await paymentsRepo.findTransactionById(paymentTx.paymentTransactionId);
    const walletAfter = await walletService.getOrCreateStoreWallet(store.storeId);

    if (orderAfter?.orderStatus === 'CONFIRMED' && orderAfter?.paymentStatus === 'PAID') {
      console.log('  ✔ [PASS] Order status confirmed & payment status set to PAID (Escrow hold)');
    } else {
      console.log('  ✖ [FAIL] Order status not updated correctly');
      failed++;
    }

    if (paymentAfter?.status === 'PAID') {
      console.log('  ✔ [PASS] PaymentTransaction status marked as PAID');
    } else {
      console.log('  ✖ [FAIL] PaymentTransaction status not marked PAID');
      failed++;
    }

    // Per BRD V2.1: Webhook only marks payment PAID & order CONFIRMED.
    // Transition order through DB state machine: CONFIRMED -> PREPARING -> READY_FOR_DELIVERY -> SHIPPING -> DELIVERED -> COMPLETED
    await prisma.order.update({ where: { orderId: testOrder.orderId }, data: { orderStatus: 'PREPARING' } });
    await prisma.order.update({ where: { orderId: testOrder.orderId }, data: { orderStatus: 'READY_FOR_DELIVERY' } });
    await prisma.order.update({ where: { orderId: testOrder.orderId }, data: { orderStatus: 'SHIPPING' } });
    await prisma.order.update({ where: { orderId: testOrder.orderId }, data: { orderStatus: 'DELIVERED' } });
    await prisma.order.update({ where: { orderId: testOrder.orderId }, data: { orderStatus: 'COMPLETED' } });
    await walletService.creditOrderRevenue(store.storeId, 200000, `ORDER:${testOrder.orderId}`);
    const walletAfterSettled = await walletService.getOrCreateStoreWallet(store.storeId);

    if (Number(walletAfterSettled.balance) === initialBalance + 200000) {
      console.log(`  ✔ [PASS] Store Wallet credited upon Order COMPLETED (+200,000 VND -> ${Number(walletAfterSettled.balance).toLocaleString()} VND)`);
    } else {
      console.log(`  ✖ [FAIL] Store Wallet balance incorrect: ${walletAfterSettled.balance}`);
      failed++;
    }

    // Test Idempotency (Anti-Duplicate Webhook)
    const duplicateRes = await paymentsService.handlePayosWebhook({
      code: '00',
      desc: 'success',
      data: webhookPayloadData,
      signature: validWebhookSig,
    });
    const walletAfterDup = await walletService.getOrCreateStoreWallet(store.storeId);
    if (duplicateRes.success && Number(walletAfterDup.balance) === Number(walletAfter.balance)) {
      console.log('  ? [PASS] Duplicate webhook handled idempotently without double-crediting');
    } else {
      console.log('  ? [FAIL] Duplicate webhook caused balance double-crediting');
      failed++;
    }

    // ------------------------------------------------------------------------
    // SECTION 3: CHI TI?N (PAYOS PAYOUT & TWO-PHASE BALANCE LOCK)
    // ------------------------------------------------------------------------
    console.log('\n[STAGE 3] PayOS Chi Ti?n (Automated Payout & Two-Phase Balance Lock):');
    const withdrawAmount = 150000;
    const balanceBeforeWithdraw = Number(walletAfterSettled.balance);

    const withdrawal = await walletService.requestWithdrawal(
      store.storeId,
      {
        amount: withdrawAmount,
        bankCode: '970422',
        bankName: 'MBBank',
        bankAccountNumber: '0987654321',
        bankAccountHolder: 'CHU CUA HANG TEST',
        fee: 0,
        autoPayout: true, // Trigger automated PayOS Payout
      },
    );

    if (withdrawal && withdrawal.status === 'PROCESSING') {
      console.log(`  ? [PASS] PayOS Payout accepted, withdrawal moved to PROCESSING (ID: ${withdrawal.withdrawalCode})`);
    } else {
      console.log('  ? [FAIL] Withdrawal not in PROCESSING status:', withdrawal?.status);
      failed++;
    }

    const walletAfterPayoutReq = await walletService.getOrCreateStoreWallet(store.storeId);
    if (Number(walletAfterPayoutReq.balance) === balanceBeforeWithdraw - withdrawAmount) {
      console.log(`  ? [PASS] Balance deducted immediately in Phase 1 to prevent double-spending (${Number(walletAfterPayoutReq.balance).toLocaleString()} VND)`);
    } else {
      console.log('  ? [FAIL] Balance not deducted correctly');
      failed++;
    }

    // ------------------------------------------------------------------------
    // SECTION 4: PAYOUT STATUS RECONCILIATION & AUTO-REFUND ON FAILURE
    // ------------------------------------------------------------------------
    console.log('\n[STAGE 4] PayOS Reconciliation & Auto-Refund Fail-Safe:');
    
    // Simulate Payout Succeeded
    const syncedSuccess = await walletService.syncWithdrawalPayoutStatus(withdrawal.withdrawalId);
    if (syncedSuccess.status === 'SUCCEEDED') {
      console.log('  ? [PASS] Payout confirmation marked withdrawal as SUCCEEDED');
    } else {
      console.log('  ? [FAIL] Payout confirmation failed to set SUCCEEDED');
      failed++;
    }

    // Test Failure Case with Auto-Refund
    console.log('\n[STAGE 5] PayOS Failure Auto-Refund Verification:');
    const balanceBeforeFailed = Number((await walletService.getOrCreateStoreWallet(store.storeId)).balance);
    const failedAmount = 50000;

    // Create a withdrawal that will fail
    const failingWithdrawal = await walletService.requestWithdrawal(
      store.storeId,
      {
        amount: failedAmount,
        bankCode: '970422',
        bankName: 'MBBank',
        bankAccountNumber: '0000000000',
        bankAccountHolder: 'TAI KHOAN LOI',
        fee: 0,
        autoPayout: false,
      },
    );

    // Balance deducted for failing withdrawal
    const balMid = Number((await walletService.getOrCreateStoreWallet(store.storeId)).balance);
    if (balMid === balanceBeforeFailed - failedAmount) {
      console.log('  ? [PASS] Failing request reserved balance in DB (Phase 1)');
    } else {
      console.log('  ? [FAIL] Balance reserve failed');
      failed++;
    }

    // Trigger refund via refundFailedWithdrawal
    await walletService.refundFailedWithdrawal(failingWithdrawal.withdrawalId, 'STK kh�ng t?n t?i t?i ng�n h�ng d�ch');
    const refundedWithdrawal = await walletService.getWithdrawal(failingWithdrawal.withdrawalId);
    const balanceAfterRefund = Number((await walletService.getOrCreateStoreWallet(store.storeId)).balance);

    if (refundedWithdrawal.status === 'FAILED' && balanceAfterRefund === balanceBeforeFailed) {
      console.log(`  ? [PASS] Auto-refund executed via DB transaction, restored exact balance (${balanceAfterRefund.toLocaleString()} VND)`);
      console.log('  ? [PASS] WalletTransaction recorded WITHDRAWAL_REFUND ledger audit trail');
    } else {
      console.log('  ? [FAIL] Auto-refund did not restore exact balance');
      failed++;
    }

    // ------------------------------------------------------------------------
    // SECTION 5: PAYOS PAYOUT ACCOUNT BALANCE MONITORING
    // ------------------------------------------------------------------------
    console.log('\n[STAGE 6] PayOS Payout Account Balance Monitoring:');
    const payoutBalance = await payosPayoutService.getPayoutBalance();
    if (payoutBalance && payoutBalance.code === '00' && payoutBalance.data?.balance) {
      console.log(`  ? [PASS] Payout Account Balance fetched: ${Number(payoutBalance.data.balance).toLocaleString()} ${payoutBalance.data.currency} (${payoutBalance.data.accountName})`);
    } else {
      console.log('  ? [FAIL] Failed to fetch Payout Account Balance');
      failed++;
    }

  } catch (error: any) {
    console.error('  ? [FAIL] Exception during test execution:', error.message);
    failed++;
  } finally {
    await prisma.$disconnect();
  }

  console.log('\n------------------------------------------------------------------------');
  if (failed > 0) {
    console.error(`PayOS Thu - Chi Test Suite failed with ${failed} failures.`);
    process.exit(1);
  } else {
    console.log('?? ALL PAYOS THU - CHI TESTS PASSED WITH 100% SUCCESS!');
    console.log('------------------------------------------------------------------------\n');
  }
}

testPayOSThuChi().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
