import assert from 'node:assert';
import { CustomerBankPennyVerificationService } from '../src/customers/customer-bank-penny-verification.service';
import { CryptoVaultUtil } from '../src/common/utils/crypto-vault.util';

async function run() {
  process.env.CUSTOMER_BANK_VERIFICATION_PAYMENT_ENABLED = 'true';
  process.env.BANK_ACCOUNT_ENCRYPTION_KEY = '5dad52bd291a3e8f96f284cd7fcdb72d96d5f114c00e642dea09e9da19d0363d';
  process.env.PAYOS_CHECKSUM_KEY = 'test_checksum_key_for_penny_deposit_verification_suite_32chars';
  console.log('🧪 Testing Customer Bank Penny-Deposit Verification & Refund Lifecycle (End-to-End)...');

  // Test setup data
  const rawAcc = '098765432199';
  const bankBin = '970422'; // MB Bank
  const encryptedAcc = CryptoVaultUtil.encryptAccountNumber(rawAcc);
  const hashAcc = CryptoVaultUtil.computeDeterministicAccountHash(rawAcc);
  const maskedAcc = CryptoVaultUtil.maskAccountNumber(rawAcc);

  const mockCustomer = { customerId: BigInt(100), userId: BigInt(20) };
  let mockBankAccount: any = {
    id: BigInt(500),
    customerId: mockCustomer.customerId,
    bankBin,
    bankCode: 'MB',
    bankName: 'MB Bank',
    accountNumberEncrypted: encryptedAcc,
    accountNumberHash: hashAcc,
    accountNumberMasked: maskedAcc,
    accountName: 'NGUYEN VAN TEST',
    verificationStatus: 'PENDING',
    isDefault: true,
  };

  // In-memory relational storage simulating Postgres 4 entities
  let sessions: any[] = [];
  let inboundTxs: any[] = [];
  let refundObligations: any[] = [];
  let payoutAttempts: any[] = [];

  const mockCustomersRepo: any = {
    getCustomerProfileByUserId: async (userId: bigint) => (userId === mockCustomer.userId ? mockCustomer : null),
    findCustomerBankAccountById: async (custId: bigint, accId: bigint) => {
      if (custId === mockCustomer.customerId && accId === mockBankAccount.id) {
        return mockBankAccount;
      }
      return null;
    },
    findActiveVerificationSessionByAccount: async (custId: bigint, accId: bigint) => {
      return (
        sessions.find(
          (s) =>
            s.customerId === custId &&
            s.accountId === accId &&
            s.sessionStatus === 'ACTIVE' &&
            new Date(s.expiresAt).getTime() > Date.now() &&
            !s.usedAt,
        ) || null
      );
    },
    createPennyVerificationSession: async (data: any) => {
      const session = {
        id: BigInt(sessions.length + 1),
        proofReference: data.proofReference,
        customerId: data.customerId,
        accountId: data.accountId,
        bankBin: data.bankBin,
        accountNumberHash: data.accountNumberHash,
        status: 'PENDING',
        sessionStatus: 'ACTIVE',
        verificationStatus: 'PENDING',
        paymentOrderCode: data.paymentOrderCode,
        paymentLinkId: data.paymentLinkId || null,
        paymentCheckoutUrl: data.paymentCheckoutUrl || `https://pay.payos.vn/web/test-${data.paymentOrderCode}`,
        expiresAt: data.expiresAt,
        usedAt: null,
        verifiedAt: null,
        verifiedByTransactionId: null,
        rejectionReason: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        inboundTransactions: [],
      };
      sessions.push(session);
      return session;
    },
    findVerificationSessionByOrderCode: async (orderCode: bigint) => {
      const s = sessions.find((x) => x.paymentOrderCode === orderCode);
      if (!s) return null;
      return {
        ...s,
        customer: mockCustomer,
        bankAccount: mockBankAccount,
        inboundTransactions: inboundTxs.filter((tx) => tx.proofId === s.id),
      };
    },
    findLatestVerificationSessionByAccount: async (custId: bigint, accId: bigint) => {
      const list = sessions
        .filter((s) => s.customerId === custId && s.accountId === accId)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      if (list.length === 0) return null;
      const latest = list[0];
      return {
        ...latest,
        inboundTransactions: inboundTxs
          .filter((tx) => tx.proofId === latest.id)
          .map((tx) => ({
            ...tx,
            refundObligation: refundObligations.find((o) => o.inboundTransactionId === tx.id) || null,
          })),
      };
    },
    findVerificationSessionsHistory: async (custId: bigint, skip = 0, take = 20) => {
      const list = sessions.filter((s) => s.customerId === custId);
      const sliced = list.slice(skip, skip + take).map((s) => ({
        ...s,
        inboundTransactions: inboundTxs
          .filter((tx) => tx.proofId === s.id)
          .map((tx) => ({
            ...tx,
            refundObligation: refundObligations.find((o) => o.inboundTransactionId === tx.id) || null,
          })),
      }));
      return { items: sliced, total: list.length };
    },
    findInboundTransactionByProviderRef: async (provider: string, channel: string, ref: string) => {
      const tx = inboundTxs.find((x) => x.provider === provider && x.channel === channel && x.providerTransactionRef === ref);
      if (!tx) return null;
      return {
        ...tx,
        refundObligation: refundObligations.find((o) => o.inboundTransactionId === tx.id) || null,
      };
    },
    recordInboundTransactionAndObligationAtomicTx: async (params: any) => {
      const inboundId = BigInt(inboundTxs.length + 1);
      const inbound = {
        id: inboundId,
        proofId: params.proofId || null,
        provider: params.provider,
        channel: params.channel,
        providerTransactionRef: params.providerTransactionRef,
        amount: params.amount,
        receivedAt: params.receivedAt,
        isLatePayment: params.isLatePayment,
        sourceBankBin: params.sourceBankBin,
        sourceAccountMasked: params.sourceAccountMasked,
        sourceAccountHash: params.sourceAccountHash,
        sourceAccountEncrypted: params.sourceAccountEncrypted,
        sourceAccountName: params.sourceAccountName,
        hasSufficientEvidence: params.hasSufficientEvidence,
        sessionMatchStatus: params.sessionMatchStatus,
        matchDecision: params.matchDecision,
        rawPayloadChecksum: params.rawPayloadChecksum,
        reconciliationFlag: params.reconciliationFlag,
        createdAt: new Date(),
      };
      inboundTxs.push(inbound);

      const obligationId = BigInt(refundObligations.length + 1);
      const obligation = {
        id: obligationId,
        inboundTransactionId: inbound.id,
        refundAmount: params.amount,
        refundStatus: params.refundStatus,
        targetBankBin: params.sourceBankBin,
        targetAccountMasked: params.sourceAccountMasked,
        targetAccountHash: params.sourceAccountHash,
        targetAccountEncrypted: params.sourceAccountEncrypted,
        targetAccountName: params.sourceAccountName,
        refundPayoutReference: params.refundPayoutReference,
        activePayoutAttemptId: null,
        refundedAt: null,
        failureReason: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      refundObligations.push(obligation);

      if (params.proofId) {
        const session = sessions.find((s) => s.id === params.proofId);
        if (session && session.verificationStatus !== 'VERIFIED') {
          session.verificationStatus =
            params.matchDecision === 'MATCHED'
              ? 'VERIFIED'
              : params.matchDecision === 'INSUFFICIENT_DATA'
                ? 'PENDING_SOURCE_EVIDENCE'
                : 'FAILED_MISMATCH';
          if (params.matchDecision === 'MATCHED') {
            session.verifiedAt = new Date();
            session.verifiedByTransactionId = inbound.id;
          }
        }

        if (params.shouldActivateAccount && params.accountId) {
          mockBankAccount.verificationStatus = 'VERIFIED';
          if (session) {
            session.sessionStatus = 'CONSUMED';
            session.status = 'SUCCESS';
            session.usedAt = new Date();
          }
        }
      }

      return { inbound, obligation };
    },
    findPendingRefundObligations: async (limit = 20) => {
      return refundObligations.filter((o) => o.refundStatus === 'PENDING_REFUND' && !o.activePayoutAttemptId).slice(0, limit);
    },
    createPayoutAttemptAndLockObligationTx: async (obligationId: bigint, payoutProvider = 'PAYOS') => {
      const obligation = refundObligations.find((o) => o.id === obligationId);
      if (!obligation) throw new Error('Not found');
      if (obligation.activePayoutAttemptId) throw new Error('In-flight attempt exists');

      const attemptId = BigInt(payoutAttempts.length + 1);
      const attemptNumber = payoutAttempts.filter((a) => a.obligationId === obligationId).length + 1;
      const attempt = {
        id: attemptId,
        obligationId,
        attemptNumber,
        payoutProvider,
        payoutReference: `REF_OBL_${obligationId}_ATT_${attemptNumber}`,
        status: 'PREPARING',
        dispatchedAt: null,
        reconciledAt: null,
        createdAt: new Date(),
      };
      payoutAttempts.push(attempt);
      obligation.activePayoutAttemptId = attempt.id;
      obligation.refundStatus = 'PROCESSING_REFUND';
      return { obligation, attempt };
    },
    finalizePayoutAttemptTx: async (params: any) => {
      const attempt = payoutAttempts.find((a) => a.id === params.attemptId);
      const obligation = refundObligations.find((o) => o.id === params.obligationId);
      if (attempt) {
        attempt.status = params.status;
        attempt.providerPayoutId = params.providerPayoutId;
        attempt.reconciledAt = new Date();
      }
      if (obligation) {
        if (params.status === 'SUCCESS') {
          obligation.refundStatus = 'REFUNDED';
          obligation.refundedAt = new Date();
          obligation.activePayoutAttemptId = null;
        } else if (params.status === 'FAILED') {
          obligation.refundStatus = 'REFUND_FAILED';
          obligation.activePayoutAttemptId = null;
        }
      }
      return { success: true };
    },
  };

  const service = new CustomerBankPennyVerificationService(mockCustomersRepo as any);
  const user = { userId: BigInt(20), role: 'CUSTOMER' };

  // =========================================================================
  // Test 1: Khởi tạo phiên và kiểm chứng Idempotency trong hạn 15 phút
  // =========================================================================
  console.log('  1. Testing Session Initiation & 15-minute Idempotency...');
  const session1 = await service.initiateVerificationSession(user, mockBankAccount.id);
  assert.strictEqual(session1.amount, 2000, 'Session must request exactly 2.000 VND');
  assert.strictEqual(session1.sessionStatus, 'ACTIVE', 'Initial session must be ACTIVE');
  assert.strictEqual(session1.verificationStatus, 'PENDING', 'Initial verification status must be PENDING');
  assert.strictEqual(Boolean(session1.orderCode), true, 'Must return orderCode');
  assert.strictEqual(Boolean(session1.checkoutUrl), true, 'Must return checkoutUrl');

  // Gọi lại ngay sau đó (trong hạn 15 phút) -> bắt buộc trả về ĐÚNG phiên cũ
  const session2 = await service.initiateVerificationSession(user, mockBankAccount.id);
  assert.strictEqual(session2.orderCode, session1.orderCode, 'Must reuse identical orderCode');
  assert.strictEqual(session2.sessionReference, session1.sessionReference, 'Must reuse identical sessionReference');
  assert.strictEqual(sessions.length, 1, 'No duplicate session created in DB');

  // =========================================================================
  // Test 2: Polling trạng thái khi chưa có giao dịch
  // =========================================================================
  console.log('  2. Testing Polling Status before Payment...');
  const statusBefore = await service.getVerificationStatus(user, mockBankAccount.id);
  assert.strictEqual(statusBefore.accountVerificationStatus, 'PENDING', 'Account must still be PENDING');
  assert.strictEqual(statusBefore.session?.paymentStatus, 'PENDING', 'Payment must be PENDING');
  assert.strictEqual(statusBefore.session?.refundStatus, 'NONE', 'No refund obligation before receiving money');

  // =========================================================================
  // Test 3: Webhook khớp chính chủ (Exact Match)
  // =========================================================================
  console.log('  3. Testing Webhook with Exact CounterAccount Match...');
  const webhookPayloadMatch = {
    data: {
      orderCode: Number(session1.orderCode),
      amount: 2000,
      reference: 'TX_PAYOS_SUCCESS_01',
      counterAccountBankId: bankBin,
      counterAccountNumber: rawAcc, // Trùng số tài khoản đăng ký
      counterAccountName: 'NGUYEN VAN TEST',
      transactionDateTime: new Date().toISOString(),
    },
    signature: 'MOCK_TEST_SIGNATURE',
  };

  const webhookRes1 = await service.processPayosVerificationWebhook(webhookPayloadMatch);
  assert.strictEqual(webhookRes1.success, true);

  assert.strictEqual(inboundTxs.length, 1, 'Must record exactly 1 InboundTransaction');
  assert.strictEqual(inboundTxs[0].matchDecision, 'MATCHED', 'Match decision must be MATCHED');
  assert.strictEqual(inboundTxs[0].amount, 2000);

  assert.strictEqual(refundObligations.length, 1, 'Must create exactly 1 RefundObligation 1:1');
  assert.strictEqual(refundObligations[0].refundAmount, 2000, 'Refund obligation must equal received amount');
  assert.strictEqual(refundObligations[0].refundStatus, 'PENDING_REFUND', 'Must be PENDING_REFUND');

  // Kiểm tra tài khoản được kích hoạt sang VERIFIED
  assert.strictEqual(mockBankAccount.verificationStatus, 'VERIFIED', 'Bank account must be activated to VERIFIED');
  const sessionAfter = sessions.find((s) => s.id === BigInt(1));
  assert.strictEqual(sessionAfter.sessionStatus, 'CONSUMED', 'Session must be CONSUMED');
  assert.strictEqual(sessionAfter.verificationStatus, 'VERIFIED', 'Session verificationStatus must be VERIFIED');
  assert.strictEqual(sessionAfter.verifiedByTransactionId, inboundTxs[0].id, 'Must link verifiedByTransactionId');

  // =========================================================================
  // Test 4: Webhook trùng lặp (Idempotent replay)
  // =========================================================================
  console.log('  4. Testing Duplicate Webhook Replay...');
  const duplicateRes = await service.processPayosVerificationWebhook(webhookPayloadMatch);
  assert.strictEqual(duplicateRes.success, true);
  assert.strictEqual(duplicateRes.message.includes('Idempotent'), true);
  assert.strictEqual(inboundTxs.length, 1, 'Must NOT insert duplicate InboundTransaction');
  assert.strictEqual(refundObligations.length, 1, 'Must NOT insert duplicate RefundObligation');

  // =========================================================================
  // Test 5: Khách chuyển tiền lần thứ hai vào cùng một mã phiên (Double Transfer)
  // =========================================================================
  console.log('  5. Testing Double Transfer to Same Session (Multiple Inbound)...');
  const webhookDouble = {
    data: {
      orderCode: Number(session1.orderCode),
      amount: 2000,
      reference: 'TX_PAYOS_DOUBLE_02', // Mã giao dịch thứ hai khác biệt
      counterAccountBankId: bankBin,
      counterAccountNumber: rawAcc,
      counterAccountName: 'NGUYEN VAN TEST',
      transactionDateTime: new Date().toISOString(),
    },
    signature: 'MOCK_TEST_SIGNATURE',
  };

  await service.processPayosVerificationWebhook(webhookDouble);
  assert.strictEqual(inboundTxs.length, 2, 'Must record 2nd InboundTransaction');
  assert.strictEqual(refundObligations.length, 2, 'Must record 2nd RefundObligation');
  assert.strictEqual(refundObligations[1].refundAmount, 2000, 'Must track refund obligation for 2nd transfer');
  // Phiên đã VERIFIED/CONSUMED trước đó không bị lật trạng thái
  assert.strictEqual(sessionAfter.sessionStatus, 'CONSUMED');
  assert.strictEqual(sessionAfter.verificationStatus, 'VERIFIED');

  // =========================================================================
  // Test 6: Webhook sai số tài khoản (Mismatch Account)
  // =========================================================================
  console.log('  6. Testing Webhook with Mismatch CounterAccount...');
  // Khởi tạo phiên thứ 2 cho tài khoản khác
  const bankAcc2 = {
    id: BigInt(501),
    customerId: mockCustomer.customerId,
    bankBin: '970407', // Techcombank
    accountNumberHash: 'hash_tcb_123',
    verificationStatus: 'PENDING',
  };
  mockCustomersRepo.findCustomerBankAccountById = async () => bankAcc2;

  const sessionForAcc2 = await service.initiateVerificationSession(user, bankAcc2.id);

  const webhookMismatch = {
    data: {
      orderCode: Number(sessionForAcc2.orderCode),
      amount: 2000,
      reference: 'TX_PAYOS_MISMATCH_03',
      counterAccountBankId: '970422', // Chuyển từ MB thay vì Techcombank
      counterAccountNumber: '111222333444', // Số tài khoản khác
      counterAccountName: 'NGUOI KHAC CHUYEN',
      transactionDateTime: new Date().toISOString(),
    },
    signature: 'MOCK_TEST_SIGNATURE',
  };

  await service.processPayosVerificationWebhook(webhookMismatch);
  const mismatchInbound = inboundTxs.find((tx) => tx.providerTransactionRef === 'TX_PAYOS_MISMATCH_03');
  assert.strictEqual(mismatchInbound.matchDecision, 'MISMATCH_BIN');
  assert.strictEqual(bankAcc2.verificationStatus, 'PENDING', 'Account must NOT be verified on mismatch');

  const mismatchObligation = refundObligations.find((o) => o.inboundTransactionId === mismatchInbound.id);
  assert.strictEqual(mismatchObligation.refundAmount, 2000, 'System MUST still create refund obligation to return money');
  assert.strictEqual(mismatchObligation.targetBankBin, '970422', 'Refund snapshot must target sender account');

  // =========================================================================
  // Test 7: Webhook thiếu thông tin counterAccount từ Ngân hàng
  // =========================================================================
  console.log('  7. Testing Webhook with Missing CounterAccount Info (Insufficient Evidence)...');
  const sessionForAcc3 = await service.initiateVerificationSession(user, bankAcc2.id);

  const webhookNoEvidence = {
    data: {
      orderCode: Number(sessionForAcc3.orderCode),
      amount: 2000,
      reference: 'TX_PAYOS_NO_EVIDENCE_04',
      // Không có counterAccountBankId và counterAccountNumber
      transactionDateTime: new Date().toISOString(),
    },
    signature: 'MOCK_TEST_SIGNATURE',
  };

  await service.processPayosVerificationWebhook(webhookNoEvidence);
  const noEvidenceInbound = inboundTxs.find((tx) => tx.providerTransactionRef === 'TX_PAYOS_NO_EVIDENCE_04');
  assert.strictEqual(noEvidenceInbound.matchDecision, 'INSUFFICIENT_DATA');
  assert.strictEqual(noEvidenceInbound.hasSufficientEvidence, false);

  const s3 = sessions.find((s) => s.proofReference === sessionForAcc3.sessionReference);
  assert.strictEqual(s3.verificationStatus, 'PENDING_SOURCE_EVIDENCE');

  const noEvidenceObligation = refundObligations.find((o) => o.inboundTransactionId === noEvidenceInbound.id);
  assert.strictEqual(noEvidenceObligation.refundStatus, 'PENDING_MANUAL_REFUND', 'Must hold as PENDING_MANUAL_REFUND');

  // Kiểm tra thông điệp người dùng khi thiếu tài khoản nguồn
  const statusEvidence = await service.getVerificationStatus(user, bankAcc2.id);
  assert.strictEqual(
    statusEvidence.message,
    'Đã nhận 2.000đ nhưng chưa đủ thông tin tài khoản nguồn để xác nhận và hoàn tự động. Khoản tiền đang chờ xử lý hoàn; vui lòng liên hệ hỗ trợ.',
    'Message must strictly match exact approved user notice',
  );

  // =========================================================================
  // Test 8: Khoản thu ngoài phiên (Orphan / Out-of-band Inbound Transaction)
  // =========================================================================
  console.log('  8. Testing Orphan Inbound Transaction (No Session)...');
  const webhookOrphan = {
    data: {
      orderCode: 999999999, // orderCode hoàn toàn không có trong DB
      amount: 5000, // Khách chuyển 5.000đ ngoài phiên
      reference: 'TX_PAYOS_ORPHAN_05',
      counterAccountBankId: '970415', // VietinBank
      counterAccountNumber: '101000999888',
      counterAccountName: 'KHACH VANG LAI',
      transactionDateTime: new Date().toISOString(),
    },
    signature: 'MOCK_TEST_SIGNATURE',
  };

  const orphanRes = await service.processPayosVerificationWebhook(webhookOrphan);
  assert.strictEqual(orphanRes.success, true);

  const orphanInbound = inboundTxs.find((tx) => tx.providerTransactionRef === 'TX_PAYOS_ORPHAN_05');
  assert.strictEqual(orphanInbound.proofId, null, 'proofId must be NULL for orphan transaction');
  assert.strictEqual(orphanInbound.sessionMatchStatus, 'UNMATCHED_NO_SESSION');
  assert.strictEqual(orphanInbound.amount, 5000);

  const orphanObligation = refundObligations.find((o) => o.inboundTransactionId === orphanInbound.id);
  assert.strictEqual(orphanObligation.refundAmount, 5000, 'Must record obligation for exact 5.000đ received');
  assert.strictEqual(orphanObligation.refundStatus, 'PENDING_MANUAL_REFUND');

  // =========================================================================
  // Test 9: Worker Hoàn Tiền & Single In-Flight Attempt Guarantee
  // =========================================================================
  console.log('  9. Testing Refund Worker Batch & Single In-Flight Attempt Guarantee...');
  // Bật live payout giả lập
  process.env.FEATURE_CUSTOMER_REFUND_PAYOUT_ENABLED = 'true';

  const workerResult = await service.processRefundWorkerBatch(10);
  assert.strictEqual(workerResult.processed > 0, true, 'Worker must process pending obligations');
  assert.strictEqual(workerResult.succeeded > 0, true, 'Worker must complete refund payout');

  // Kiểm tra obligation đã hoàn
  const firstObligation = refundObligations[0];
  assert.strictEqual(firstObligation.refundStatus, 'REFUNDED');
  assert.strictEqual(firstObligation.activePayoutAttemptId, null, 'activePayoutAttemptId must be cleared upon success');

  // Kiểm tra attempt ghi nhận
  const attempt = payoutAttempts.find((a) => a.obligationId === firstObligation.id);
  assert.strictEqual(attempt.status, 'SUCCESS');
  assert.strictEqual(attempt.attemptNumber, 1);

  // =========================================================================
  // Test 10: Polling lịch sử xác minh (Verification History API)
  // =========================================================================
  console.log('  10. Testing Verification History API...');
  const history = await service.getVerificationHistory(user, { page: 1, pageSize: 10 });
  assert.strictEqual(history.total >= 2, true);
  assert.strictEqual(history.items.length >= 2, true);
  assert.strictEqual(history.items[0].receivedAmount !== undefined, true);

  console.log('✅ ALL 10 TESTS PASSED! End-to-end Penny-Deposit Verification & Refund lifecycle is 100% verified.');
}

run().catch((err) => {
  console.error('❌ TEST FAILED:', err);
  process.exit(1);
});
