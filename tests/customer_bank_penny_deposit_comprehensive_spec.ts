import assert from 'node:assert';
import * as crypto from 'crypto';
import { CryptoVaultUtil } from '../src/common/utils/crypto-vault.util';
import { CustomerBankPennyVerificationService } from '../src/customers/customer-bank-penny-verification.service';
import { signWebhookData } from '../src/payments/payos.helper';
import { PayOSPayoutService } from '../src/payments/payos-payout.service';
import {
  BadRequestException,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import {
  verifyPayosPayoutEvidence,
  verifyPayosPayoutRejectionEvidence,
} from '../src/payments/payos-payout-verifier';

// ============================================================================
// CLASSIFICATION: Unit / Service Mock Test Suite
// - Tests service-level business rules, domain invariants, state machines, and CAS handlers.
// - Uses high-fidelity in-memory transactional mock repository.
// - Covers all 6 P0/P1 invariants: Anti-Replay, Fail-Closed Verifier, Failure Reconciler,
//   State Machine Active Pointer, Payment Link Recovery, and Unreferenced Intake Separation.
// ============================================================================

async function runComprehensivePennyVerificationTestSuite() {
  console.log('================================================================================');
  console.log('🛡️ CUSTOMER BANK PENNY-DEPOSIT (2.000đ) VERIFICATION & REFUND LIFECYCLE AUDIT');
  console.log('   (Unit / Service Domain & State Machine Invariant Verification Suite)');
  console.log('================================================================================\n');

  let passed = 0;
  let failed = 0;

  const testAssert = (condition: boolean, testName: string, detail?: string) => {
    if (condition) {
      console.log(`  ✔ [PASS] ${testName}`);
      passed++;
    } else {
      console.error(`  ✖ [FAIL] ${testName}${detail ? ` -> ${detail}` : ''}`);
      failed++;
    }
  };

  const ts = Date.now();
  const testChecksumKey = 'test_checksum_key_for_penny_deposit_verification_suite_32chars';
  process.env.BANK_ACCOUNT_ENCRYPTION_KEY = '5dad52bd291a3e8f96f284cd7fcdb72d96d5f114c00e642dea09e9da19d0363d';
  process.env.PAYOS_CHECKSUM_KEY = testChecksumKey;
  process.env.PAYOS_CLIENT_ID = 'test_client_id';
  process.env.PAYOS_API_KEY = 'test_api_key';

  const rawAccNumber = '098765432199';
  const testBankBin = '970422'; // MB Bank
  const accHash = CryptoVaultUtil.computeDeterministicAccountHash(rawAccNumber);
  const accEncrypted = CryptoVaultUtil.encryptAccountNumber(rawAccNumber);
  const accMasked = `******${rawAccNumber.slice(-4)}`;

  const testUser = { userId: BigInt(100), username: `penny_user_${ts}`, status: 'ACTIVE' };
  const testCustomer = { customerId: BigInt(200), userId: testUser.userId };
  let testBankAccount: any = {
    id: BigInt(300),
    customerId: testCustomer.customerId,
    bankBin: testBankBin,
    bankCode: 'MB',
    bankName: 'MB Bank',
    accountNumberHash: accHash,
    accountNumberEncrypted: accEncrypted,
    accountNumberMasked: accMasked,
    accountName: 'NGUYEN VAN PENNY TEST',
    verificationStatus: 'PENDING',
    isDefault: true,
  };

  // State-machine & Transactional In-Memory Storage enforcing Postgres Table & Lock Semantics
  const accountsTable: any[] = [
    testBankAccount,
    { ...testBankAccount, id: BigInt(301), verificationStatus: 'PENDING' },
    { ...testBankAccount, id: BigInt(302), verificationStatus: 'PENDING' },
  ];
  const sessionsTable: any[] = [];
  const inboundsTable: any[] = [];
  const obligationsTable: any[] = [];
  const attemptsTable: any[] = [];

  const mockRepo: any = {
    getCustomerProfileByUserId: async (userId: bigint) => (userId === testUser.userId ? testCustomer : null),
    findCustomerBankAccountById: async (custId: bigint, accId: bigint) => {
      return accountsTable.find((a) => a.customerId === custId && a.id === accId) || null;
    },
    findActiveVerificationSessionByAccount: async (custId: bigint, accId: bigint) => {
      return (
        sessionsTable.find(
          (s) =>
            s.customerId === custId &&
            s.accountId === accId &&
            s.sessionStatus === 'ACTIVE' &&
            new Date(s.expiresAt).getTime() > Date.now() &&
            s.usedAt === null,
        ) || null
      );
    },
    getOrCreatePennyVerificationSessionTx: async (data: any) => {
      const existing = sessionsTable.find(
        (s) =>
          s.customerId === data.customerId &&
          s.accountId === data.accountId &&
          s.sessionStatus === 'ACTIVE' &&
          new Date(s.expiresAt).getTime() > Date.now() &&
          s.usedAt === null,
      );
      if (existing) {
        return { session: existing, isReused: true };
      }

      const paymentOrderCode = data.generateOrderCode();
      const proofReference = data.generateProofReference();

      const session = {
        id: BigInt(sessionsTable.length + 1),
        proofReference,
        customerId: data.customerId,
        accountId: data.accountId,
        bankBin: data.bankBin,
        accountNumberHash: data.accountNumberHash,
        status: 'PENDING',
        sessionStatus: 'ACTIVE',
        verificationStatus: 'PENDING',
        paymentOrderCode,
        paymentLinkId: null,
        paymentCheckoutUrl: null,
        expiresAt: data.expiresAt,
        usedAt: null,
        verifiedAt: null,
        verifiedByTransactionId: null,
        rejectionReason: null,
        inboundTransactions: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      sessionsTable.push(session);
      return { session, isReused: false };
    },
    attachPaymentLinkToSessionCAS: async (sessionId: bigint, paymentLinkId: string, paymentCheckoutUrl: string) => {
      const sess = sessionsTable.find((s) => s.id === sessionId);
      if (sess && sess.sessionStatus === 'ACTIVE') {
        sess.paymentLinkId = paymentLinkId;
        sess.paymentCheckoutUrl = paymentCheckoutUrl;
        sess.updatedAt = new Date();
        return true;
      }
      return false;
    },
    findVerificationSessionByOrderCode: async (orderCode: bigint) => {
      const sess = sessionsTable.find((s) => s.paymentOrderCode === orderCode);
      if (!sess) return null;
      sess.inboundTransactions = inboundsTable.filter((tx) => tx.proofId === sess.id);
      return sess;
    },
    findLatestVerificationSessionByAccount: async (custId: bigint, accId: bigint) => {
      const matched = sessionsTable.filter((s) => s.customerId === custId && s.accountId === accId);
      if (matched.length === 0) return null;
      const latest = matched[matched.length - 1];
      latest.inboundTransactions = inboundsTable
        .filter((tx) => tx.proofId === latest.id)
        .map((tx) => ({
          ...tx,
          refundObligation: obligationsTable.find((o) => o.inboundTransactionId === tx.id) || null,
        }));
      return latest;
    },
    findVerificationSessionsHistory: async (custId: bigint, skip = 0, take = 20) => {
      const matched = sessionsTable
        .filter((s) => s.customerId === custId)
        .map((sess) => ({
          ...sess,
          inboundTransactions: inboundsTable
            .filter((tx) => tx.proofId === sess.id)
            .map((tx) => ({
              ...tx,
              refundObligation: obligationsTable.find((o) => o.inboundTransactionId === tx.id) || null,
            })),
        }));
      return {
        items: matched.slice(skip, skip + take),
        total: matched.length,
      };
    },
    findInboundTransactionByProviderRef: async (provider: string, channel: string, ref: string) => {
      const tx = inboundsTable.find(
        (t) => t.provider === provider && t.channel === channel && t.providerTransactionRef === ref,
      );
      if (!tx) return null;
      return {
        ...tx,
        refundObligation: obligationsTable.find((o) => o.inboundTransactionId === tx.id) || null,
      };
    },
    flagConflictingInboundTransaction: async (txId: bigint, reconciliationFlag: string) => {
      const tx = inboundsTable.find((t) => t.id === txId);
      if (tx) tx.reconciliationFlag = reconciliationFlag;
      return tx;
    },
    recordInboundTransactionAndObligationAtomicTx: async (params: any) => {
      const amountNum = Number(params.amount);
      let isLate = false;
      let sessionMatchStatus = params.proofId ? 'MATCHED_SESSION' : 'UNMATCHED_NO_SESSION';
      let matchDecision = 'PENDING';
      let reconciliationFlag = params.reconciliationFlag || null;
      let shouldActivate = false;

      const session = params.proofId ? sessionsTable.find((s) => s.id === params.proofId) : null;
      if (session) {
        const isSessionActive = session.sessionStatus === 'ACTIVE';
        const isSessionUnused = session.usedAt === null;
        const isSessionUnexpired =
          new Date(session.expiresAt).getTime() > params.receivedAt.getTime() &&
          new Date(session.expiresAt).getTime() > Date.now();
        isLate = !isSessionUnexpired;

        const isExactPolicyAmount = amountNum === 2000;
        const isAccountUnverified = testBankAccount.verificationStatus !== 'VERIFIED';
        const isBinMatched = Boolean(params.sourceBankBin && params.sourceBankBin === session.bankBin);
        const isAccountMatched = Boolean(
          params.sourceAccountHash && params.sourceAccountHash === session.accountNumberHash,
        );

        if (params.reconciliationFlag === 'FLAGGED_MISSING_PROVIDER_REF') {
          matchDecision = 'MISSING_TRANSACTION_REF';
        } else if (!params.hasSufficientEvidence) {
          matchDecision = 'INSUFFICIENT_DATA';
        } else if (!isBinMatched) {
          matchDecision = 'MISMATCH_BIN';
        } else if (!isAccountMatched) {
          matchDecision = 'MISMATCH_ACCOUNT';
        } else if (!isExactPolicyAmount) {
          matchDecision = 'INVALID_AMOUNT';
        } else {
          matchDecision = 'MATCHED';
        }

        if (isLate) {
          reconciliationFlag = reconciliationFlag || 'FLAGGED_LATE_PAYMENT';
        } else if (!isExactPolicyAmount) {
          reconciliationFlag = reconciliationFlag || 'FLAGGED_INVALID_AMOUNT';
        }

        shouldActivate =
          matchDecision === 'MATCHED' &&
          isExactPolicyAmount &&
          !isLate &&
          isSessionActive &&
          isSessionUnused &&
          isAccountUnverified;
      } else {
        if (params.reconciliationFlag === 'FLAGGED_MISSING_PROVIDER_REF') {
          matchDecision = 'MISSING_TRANSACTION_REF';
          reconciliationFlag = 'FLAGGED_MISSING_PROVIDER_REF';
        } else {
          matchDecision = 'UNMATCHED_SESSION';
          reconciliationFlag = params.reconciliationFlag || 'FLAGGED_UNMATCHED_SESSION';
        }
      }

      const inbound = {
        id: BigInt(inboundsTable.length + 1),
        proofId: params.proofId || null,
        provider: params.provider,
        channel: params.channel,
        providerTransactionRef: params.providerTransactionRef,
        amount: params.amount,
        receivedAt: params.receivedAt,
        isLatePayment: isLate,
        sourceBankBin: params.sourceBankBin,
        sourceAccountMasked: params.sourceAccountMasked,
        sourceAccountHash: params.sourceAccountHash,
        sourceAccountEncrypted: params.sourceAccountEncrypted,
        sourceAccountName: params.sourceAccountName,
        hasSufficientEvidence: params.hasSufficientEvidence,
        sessionMatchStatus,
        matchDecision,
        rawPayloadChecksum: params.rawPayloadChecksum,
        reconciliationFlag,
        createdAt: new Date(),
      };
      inboundsTable.push(inbound);

      // BẮT BUỘC (P1): Intake thiếu reference không tự động tạo nghĩa vụ hoàn trả (chỉ lưu quan sát đối soát)
      const isMissingRef = params.reconciliationFlag === 'FLAGGED_MISSING_PROVIDER_REF';
      let obligation: any = null;
      if (!isMissingRef) {
        obligation = {
          id: BigInt(obligationsTable.length + 1),
          inboundTransactionId: inbound.id,
          refundAmount: params.amount,
          refundStatus: params.hasSufficientEvidence ? 'PENDING_REFUND' : 'PENDING_MANUAL_REFUND',
          targetBankBin: params.sourceBankBin,
          targetAccountMasked: params.sourceAccountMasked,
          targetAccountHash: params.sourceAccountHash,
          targetAccountEncrypted: params.sourceAccountEncrypted,
          targetAccountName: params.sourceAccountName,
          refundPayoutReference: params.refundPayoutReference,
          activePayoutAttemptId: null,
          refundedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        obligationsTable.push(obligation);
      }

      if (session && shouldActivate) {
        session.sessionStatus = 'CONSUMED';
        session.verificationStatus = 'VERIFIED';
        session.status = 'SUCCESS';
        session.usedAt = new Date();
        session.verifiedAt = new Date();
        session.verifiedByTransactionId = inbound.id;
        const acc = accountsTable.find((a) => a.id === session.accountId);
        if (acc) acc.verificationStatus = 'VERIFIED';
        testBankAccount.verificationStatus = 'VERIFIED';
      }

      return { inbound, obligation, shouldActivate, matchDecision };
    },
    findPendingRefundObligations: async (limit = 20) => {
      return obligationsTable.filter((o) => o.refundStatus === 'PENDING_REFUND' && o.activePayoutAttemptId === null);
    },
    findPendingReconciliationAttempts: async (limit = 20) => {
      return attemptsTable.filter((a) => ['PREPARING', 'SUBMITTED', 'PENDING_RECONCILIATION'].includes(a.status));
    },
    createPayoutAttemptAndLockObligationTx: async (obligationId: bigint, payoutProvider = 'PAYOS') => {
      const obl = obligationsTable.find((o) => o.id === obligationId);
      if (!obl) throw new Error('Obligation not found');
      if (obl.activePayoutAttemptId !== null) throw new Error('Attempt already active');

      const attemptNumber = attemptsTable.filter((a) => a.obligationId === obligationId).length + 1;
      const attempt = {
        id: BigInt(attemptsTable.length + 1),
        obligationId,
        attemptNumber,
        payoutProvider,
        payoutReference: `REF_OBL_${obl.id}_ATT_${attemptNumber}_${Date.now()}`,
        status: 'PREPARING',
        createdAt: new Date(),
        obligation: obl,
      };
      attemptsTable.push(attempt);
      obl.activePayoutAttemptId = attempt.id;
      obl.refundStatus = 'PROCESSING_REFUND';
      return { obligation: obl, attempt };
    },
    finalizePayoutAttemptTx: async (params: any) => {
      const obl = obligationsTable.find((o) => o.id === params.obligationId);
      const att = attemptsTable.find((a) => a.id === params.attemptId);
      if (!obl || !att) throw new Error('Obligation or attempt not found');

      if (att.obligationId !== obl.id) {
        throw new Error('Attempt does not belong to obligation');
      }

      // a) Kiểm tra trạng thái kết thúc của chính attempt (Idempotency & Terminal Lock)
      const isAttemptTerminal = att.status === 'SUCCESS' || att.status === 'FAILED';
      if (isAttemptTerminal) {
        if (params.status === att.status) {
          return { success: true, idempotent: true };
        }
        const err: any = new Error(
          `Lượt chi trả #${att.id} đã ở trạng thái kết thúc (${att.status}), không thể ghi đè sang ${params.status}`,
        );
        err.status = 409;
        throw err;
      }

      // b) Anti-reversal protection: Không bao giờ đảo ngược REFUNDED
      if (obl.refundStatus === 'REFUNDED') {
        if (params.status === 'SUCCESS') return { success: true, idempotent: true };
        const err: any = new Error('Không thể đảo ngược trạng thái nghĩa vụ hoàn tiền đã hoàn thành (REFUNDED)');
        err.status = 409;
        throw err;
      }

      // c) Với chuyển trạng thái đang hoạt động: bắt buộc active pointer khớp chính xác!
      if (!obl.activePayoutAttemptId || obl.activePayoutAttemptId.toString() !== att.id.toString()) {
        const err: any = new Error(
          `Lượt chi trả #${att.id} không phải là lượt chi trả đang hoạt động của nghĩa vụ (active pointer: ${obl.activePayoutAttemptId || 'null'})`,
        );
        err.status = 409;
        throw err;
      }

      att.status = params.status;
      att.providerPayoutId = params.providerPayoutId;
      att.failureReason = params.failureReason;

      if (params.status === 'SUCCESS') {
        obl.refundStatus = 'REFUNDED';
        obl.refundedAt = new Date();
        obl.activePayoutAttemptId = null;
      } else if (params.status === 'FAILED') {
        if (att.attemptNumber < 3) {
          obl.refundStatus = 'PENDING_REFUND';
          obl.activePayoutAttemptId = null;
        } else {
          obl.refundStatus = 'PENDING_MANUAL_REFUND';
          obl.failureReason = `Vượt quá 3 lần: ${params.failureReason}`;
          obl.activePayoutAttemptId = null;
        }
      }
      return { success: true, idempotent: false };
    },
    reconcileObservationsIntoConfirmedReceiptTx: async (params: any) => {
      const provider = params.provider || 'PAYOS';
      const channel = params.channel || 'PAYOS_WEBHOOK';
      const confirmedRef = params.confirmedTransactionRef.trim();
      const amountNum = Number(params.amount);
      const receivedAt = params.receivedAt || new Date();

      if (!Array.isArray(params.observationIds) || params.observationIds.length === 0) {
        throw new BadRequestException('Danh sách observationIds cần ghép không được rỗng');
      }

      // 1. Strict Lock Order (account -> proof) & Validation
      const session = sessionsTable.find((s) => s.id === params.sessionId);
      if (!session) throw new NotFoundException('Session not found');

      const account = accountsTable.find((a) => a.id === session.accountId && a.customerId === session.customerId);
      if (!account) throw new NotFoundException('Bank account not found');

      // 2. Lock & Check Observation IDs specifically
      const observations = inboundsTable.filter((t) => params.observationIds.includes(t.id));
      if (observations.length !== params.observationIds.length) {
        throw new NotFoundException('Một hoặc nhiều bản ghi observation không tồn tại trong hệ thống');
      }

      // 3. Đối chiếu dữ liệu của từng observation với bằng chứng xác nhận
      for (const obs of observations) {
        if (!obs.proofId || obs.proofId.toString() !== params.sessionId.toString()) {
          throw new BadRequestException(`Quan sát #${obs.id} không thuộc về phiên #${params.sessionId}`);
        }
        const isObs =
          obs.reconciliationFlag === 'FLAGGED_MISSING_PROVIDER_REF' ||
          obs.matchDecision === 'MISSING_TRANSACTION_REF' ||
          obs.providerTransactionRef?.startsWith('UNREF_OBS_') ||
          obs.matchDecision === 'MERGED_INTO_CONFIRMED';
        if (!isObs) {
          throw new BadRequestException(`Bản ghi #${obs.id} không phải là quan sát đối soát hợp lệ`);
        }
        if (obs.provider !== provider) {
          throw new ConflictException(`Quan sát #${obs.id} có provider không khớp với giao dịch xác nhận`);
        }
        if (obs.channel !== channel) {
          throw new ConflictException(`Quan sát #${obs.id} có channel không khớp với kênh giao dịch xác nhận`);
        }
        if (Number(obs.amount) !== amountNum) {
          throw new ConflictException(
            `Số tiền của quan sát #${obs.id} (${obs.amount}đ) không khớp với giao dịch xác nhận (${amountNum}đ). Không thể tự động ghép các khoản khác số tiền.`,
          );
        }
        if (params.sourceBankBin && obs.sourceBankBin && obs.sourceBankBin !== params.sourceBankBin) {
          throw new ConflictException(
            `Mã BIN nguồn của quan sát #${obs.id} (${obs.sourceBankBin}) mâu thuẫn với chứng từ xác nhận (${params.sourceBankBin})`,
          );
        }
        if (params.sourceAccountHash && obs.sourceAccountHash && obs.sourceAccountHash !== params.sourceAccountHash) {
          throw new ConflictException(`Tài khoản nguồn của quan sát #${obs.id} mâu thuẫn với chứng từ xác nhận`);
        }
      }

      // 4. Kiểm tra nếu giao dịch xác nhận đã tồn tại (Idempotency hoặc Bổ sung liên kết)
      const existingInbound = inboundsTable.find(
        (t) => t.provider === provider && t.channel === channel && t.providerTransactionRef === confirmedRef,
      );
      if (existingInbound) {
        const isAmountMatch = Number(existingInbound.amount) === amountNum;
        const isSessionMatch = existingInbound.proofId?.toString() === params.sessionId.toString();
        const isBinMatch = (existingInbound.sourceBankBin || null) === (params.sourceBankBin || null);
        const isAccountMatch = (existingInbound.sourceAccountHash || null) === (params.sourceAccountHash || null);

        if (!isAmountMatch || !isSessionMatch || !isBinMatch || !isAccountMatch) {
          throw new ConflictException(`Giao dịch xác nhận ${confirmedRef} đã tồn tại nhưng có dữ liệu mâu thuẫn`);
        }

        const pendingObsIds: bigint[] = [];
        for (const obs of observations) {
          if (obs.mergedIntoInboundId) {
            if (obs.mergedIntoInboundId.toString() !== existingInbound.id.toString()) {
              throw new ConflictException(
                `Quan sát #${obs.id} đã được ghép vào giao dịch khác (#${obs.mergedIntoInboundId}), không thể đổi liên kết`,
              );
            }
          } else {
            pendingObsIds.push(obs.id);
          }
        }

        if (pendingObsIds.length > 0) {
          for (const obs of observations.filter((o) => pendingObsIds.includes(o.id))) {
            obs.mergedIntoInboundId = existingInbound.id;
            obs.matchDecision = 'MERGED_INTO_CONFIRMED';
            obs.reconciliationFlag = `RECONCILED_MERGED_INTO_${confirmedRef}`.slice(0, 64);
          }
        }

        const totalLinked = inboundsTable.filter((t) => t.mergedIntoInboundId === existingInbound.id).length;
        const existingObl = obligationsTable.find((o) => o.inboundTransactionId === existingInbound.id);

        return {
          idempotent: pendingObsIds.length === 0,
          confirmedInbound: existingInbound,
          obligation: existingObl,
          mergedObservationsCount: totalLinked,
          shouldActivate: false,
          matchDecision: existingInbound.matchDecision,
        };
      }

      // 5. Nếu giao dịch chưa tồn tại: Tất cả observation phải chưa từng được ghép
      for (const obs of observations) {
        if (
          (obs.mergedIntoInboundId !== null && obs.mergedIntoInboundId !== undefined) ||
          obs.matchDecision === 'MERGED_INTO_CONFIRMED'
        ) {
          throw new ConflictException(`Quan sát #${obs.id} đã được ghép vào giao dịch trước đó, không thể ghép lại`);
        }
      }

      // 6. Đánh giá điều kiện kích hoạt tài khoản
      const isSessionActive = session.sessionStatus === 'ACTIVE';
      const isSessionUnused = session.usedAt === null;
      const isSessionUnexpired =
        new Date(session.expiresAt).getTime() > receivedAt.getTime() &&
        new Date(session.expiresAt).getTime() > Date.now();
      const isLate = !isSessionUnexpired;

      const isExactPolicyAmount = amountNum === 2000;
      const isAccountUnverified = account.verificationStatus !== 'VERIFIED';

      const isBinMatched = Boolean(params.sourceBankBin && params.sourceBankBin === session.bankBin);
      const isAccountMatched = Boolean(
        params.sourceAccountHash && params.sourceAccountHash === session.accountNumberHash,
      );
      const hasSufficientEvidence = Boolean(params.sourceBankBin && params.sourceAccountHash);

      let matchDecision = 'PENDING';
      let reconciliationFlag = 'RECONCILED_CONFIRMED';

      if (!hasSufficientEvidence) {
        matchDecision = 'INSUFFICIENT_DATA';
      } else if (!isBinMatched) {
        matchDecision = 'MISMATCH_BIN';
      } else if (!isAccountMatched) {
        matchDecision = 'MISMATCH_ACCOUNT';
      } else if (!isExactPolicyAmount) {
        matchDecision = 'INVALID_AMOUNT';
      } else {
        matchDecision = 'MATCHED';
      }

      if (isLate) {
        reconciliationFlag = 'FLAGGED_LATE_PAYMENT';
      } else if (!isExactPolicyAmount) {
        reconciliationFlag = 'FLAGGED_INVALID_AMOUNT';
      }

      const shouldActivate =
        matchDecision === 'MATCHED' &&
        isExactPolicyAmount &&
        !isLate &&
        isSessionActive &&
        isSessionUnused &&
        isAccountUnverified;

      // 7. Create Confirmed Inbound
      const confirmedInbound = {
        id: BigInt(inboundsTable.length + 1),
        proofId: session.id,
        provider,
        channel,
        providerTransactionRef: confirmedRef,
        amount: params.amount,
        receivedAt,
        isLatePayment: isLate,
        sourceBankBin: params.sourceBankBin,
        sourceAccountMasked: params.sourceAccountMasked,
        sourceAccountHash: params.sourceAccountHash,
        sourceAccountEncrypted: params.sourceAccountEncrypted,
        sourceAccountName: params.sourceAccountName,
        hasSufficientEvidence,
        sessionMatchStatus: 'MATCHED_SESSION',
        matchDecision,
        reconciliationFlag,
        mergedIntoInboundId: null,
        createdAt: new Date(),
      };
      inboundsTable.push(confirmedInbound);

      // 8. Update selected observations with FK
      for (const obs of observations) {
        obs.mergedIntoInboundId = confirmedInbound.id;
        obs.reconciliationFlag = `RECONCILED_MERGED_INTO_${confirmedRef}`.slice(0, 64);
        obs.matchDecision = 'MERGED_INTO_CONFIRMED';
      }

      // 9. Create exactly 1 refund obligation
      const obligation = {
        id: BigInt(obligationsTable.length + 1),
        inboundTransactionId: confirmedInbound.id,
        refundAmount: params.amount,
        refundStatus: hasSufficientEvidence ? 'PENDING_REFUND' : 'PENDING_MANUAL_REFUND',
        targetBankBin: params.sourceBankBin,
        targetAccountMasked: params.sourceAccountMasked,
        targetAccountHash: params.sourceAccountHash,
        targetAccountEncrypted: params.sourceAccountEncrypted,
        targetAccountName: params.sourceAccountName,
        refundPayoutReference: `REF_PAYOS_${confirmedRef}_${Date.now()}`.slice(0, 64),
        activePayoutAttemptId: null,
        refundedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      obligationsTable.push(obligation);

      // 10. CAS Activation if and only if shouldActivate
      if (shouldActivate) {
        session.sessionStatus = 'CONSUMED';
        session.verificationStatus = 'VERIFIED';
        session.status = 'SUCCESS';
        session.usedAt = new Date();
        session.verifiedAt = new Date();
        session.verifiedByTransactionId = confirmedInbound.id;
        account.verificationStatus = 'VERIFIED';
        testBankAccount.verificationStatus = 'VERIFIED';
      } else {
        if (session.verificationStatus !== 'VERIFIED') {
          if (matchDecision === 'INSUFFICIENT_DATA') {
            session.verificationStatus = 'PENDING_SOURCE_EVIDENCE';
          } else if (matchDecision === 'MISMATCH_BIN' || matchDecision === 'MISMATCH_ACCOUNT') {
            session.verificationStatus = 'FAILED_MISMATCH';
            session.rejectionReason = `Giao dịch không khớp thông tin tài khoản (${matchDecision})`;
          } else if (matchDecision === 'INVALID_AMOUNT') {
            session.rejectionReason = `Số tiền không đúng chính sách 2.000đ`;
          }
        }
      }

      const totalLinked = inboundsTable.filter((t) => t.mergedIntoInboundId === confirmedInbound.id).length;

      return {
        idempotent: false,
        confirmedInbound,
        obligation,
        mergedObservationsCount: totalLinked,
        shouldActivate,
        matchDecision,
      };
    },
  };

  const payosPayoutService = new PayOSPayoutService();
  const service = new CustomerBankPennyVerificationService(mockRepo, payosPayoutService);

  // ========================================================================
  // TEST 1: Khởi tạo phiên xác minh (bật cờ thu tiền giả lập)
  // ========================================================================
  console.log('--- TEST 1: Khởi tạo phiên xác minh tài khoản 2.000đ thành công ---');
  process.env.CUSTOMER_BANK_VERIFICATION_PAYMENT_ENABLED = 'true';

  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url: any, opts: any) => {
    const urlStr = url.toString();
    if (urlStr.includes('/v2/payment-requests') && opts?.method === 'POST') {
      return {
        json: async () => ({
          code: '00',
          desc: 'success',
          data: {
            paymentLinkId: `plink_${ts}`,
            checkoutUrl: `https://payos.vn/checkout/${ts}`,
          },
        }),
      } as any;
    }
    return origFetch(url, opts);
  };

  const session1 = await service.initiateVerificationSession({ userId: testUser.userId }, testBankAccount.id);
  testAssert(
    session1 !== null &&
      Number(session1.amount) === 2000 &&
      session1.checkoutUrl.startsWith('https://payos.vn/checkout/') &&
      session1.sessionStatus === 'ACTIVE',
    'Khởi tạo phiên xác minh 2.000đ thành công với checkoutUrl PayOS thật',
  );

  // ========================================================================
  // TEST 2: Idempotency: Tái sử dụng phiên còn hiệu lực
  // ========================================================================
  console.log('\n--- TEST 2: Tái sử dụng phiên xác minh đang hoạt động trong 15 phút (Idempotent) ---');
  const session2 = await service.initiateVerificationSession({ userId: testUser.userId }, testBankAccount.id);
  testAssert(
    session2.orderCode === session1.orderCode &&
      session2.sessionReference === session1.sessionReference &&
      session2.checkoutUrl === session1.checkoutUrl &&
      session2.message.includes('Tái sử dụng phiên xác minh đang hoạt động'),
    'Gọi lại cùng tài khoản trả về phiên cũ, cùng orderCode và checkoutUrl',
  );

  // ========================================================================
  // TEST 3 [P1]: Phục hồi Payment Link sau Timeout bằng stable orderCode
  // ========================================================================
  console.log('\n--- TEST 3 [P1]: Phục hồi Payment Link sau Timeout bằng GET /v2/payment-requests/:orderCode ---');
  let getCallCount = 0;
  globalThis.fetch = async (url: any, opts: any) => {
    const urlStr = url.toString();
    if (urlStr.includes('/v2/payment-requests') && opts?.method === 'POST') {
      // Giả lập client timeout khi gọi POST
      const abortErr: any = new Error('The operation was aborted');
      abortErr.name = 'AbortError';
      throw abortErr;
    }
    if (urlStr.includes('/v2/payment-requests/') && (!opts || opts.method === 'GET')) {
      getCallCount++;
      const reqOrderCode = Number(urlStr.split('/').pop());
      return {
        json: async () => ({
          code: '00',
          desc: 'Success',
          data: {
            id: `recovered_plink_${ts}`,
            orderCode: reqOrderCode,
            amount: 2000,
            checkoutUrl: `https://payos.vn/checkout/recovered_${ts}`,
          },
        }),
      } as any;
    }
    return origFetch(url, opts);
  };

  // Tạo một tài khoản mới để test recovery
  const testAccountRecovery: any = {
    ...testBankAccount,
    id: BigInt(301),
  };
  // Khởi tạo phiên nhưng checkoutUrl chưa có
  const { session: recoverySession } = await mockRepo.getOrCreatePennyVerificationSessionTx({
    customerId: testCustomer.customerId,
    accountId: testAccountRecovery.id,
    bankBin: testAccountRecovery.bankBin,
    accountNumberHash: testAccountRecovery.accountNumberHash,
    expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    generateOrderCode: () => BigInt(77889900),
    generateProofReference: () => `CUST_VRF_RECOVERY_${Date.now()}`,
  });

  const recoveredSession = await service.initiateVerificationSession(
    { userId: testUser.userId },
    testAccountRecovery.id,
  );
  testAssert(
    recoveredSession.checkoutUrl.includes('recovered') && getCallCount > 0,
    'Client timeout khi POST được tự động phục hồi qua GET /v2/payment-requests/:orderCode, không tạo phiên mới',
  );

  // ========================================================================
  // TEST 4 [P0]: Chống Replay Webhook khi thay đổi body.channel
  // ========================================================================
  console.log('\n--- TEST 4 [P0]: Cùng chữ ký, thay đổi body.channel -> Vẫn chỉ duy nhất 1 inbound và 1 obligation ---');
  const validTxRef = `REF_REPLAY_TEST_${ts}`;
  const webhookDataValid = {
    orderCode: Number(session1.orderCode),
    amount: 2000,
    reference: validTxRef,
    counterAccountBankId: testBankBin,
    counterAccountNumber: rawAccNumber,
    counterAccountName: 'NGUYEN VAN REPLAY TEST',
    transactionDateTime: new Date().toISOString(),
  };
  const validSig = signWebhookData(webhookDataValid, testChecksumKey);

  // Lần 1: Gửi với channel PAYOS_WEBHOOK
  await service.processPayosVerificationWebhook({
    code: '00',
    desc: 'success',
    data: webhookDataValid,
    signature: validSig,
    channel: 'PAYOS_WEBHOOK',
  });

  const inboundsCount1 = inboundsTable.filter((t) => t.providerTransactionRef === validTxRef).length;
  const obligationsCount1 = obligationsTable.filter((o) => o.refundPayoutReference?.includes(validTxRef)).length;

  // Lần 2: Gửi lại cùng payload + chữ ký, nhưng thay body.channel thành 'ATTACKER_FAKE_CHANNEL'
  await service.processPayosVerificationWebhook({
    code: '00',
    desc: 'success',
    data: webhookDataValid,
    signature: validSig,
    channel: 'ATTACKER_FAKE_CHANNEL',
  });

  const inboundsCount2 = inboundsTable.filter((t) => t.providerTransactionRef === validTxRef).length;
  const obligationsCount2 = obligationsTable.filter((o) => o.refundPayoutReference?.includes(validTxRef)).length;

  testAssert(
    inboundsCount1 === 1 && inboundsCount2 === 1 && obligationsCount1 === 1 && obligationsCount2 === 1,
    'Server cố định channel PAYOS_WEBHOOK gắn với auth keys; kẻ tấn công đổi body.channel không thể tạo thêm giao dịch hay obligation',
  );

  // ========================================================================
  // TEST 5 [P0]: Bộ xác minh Payout (verifyPayosPayoutEvidence) - Fail-Closed
  // ========================================================================
  console.log('\n--- TEST 5 [P0]: Payout Verifier loại bỏ Fail-Open: Bắt buộc BIN/Hash, đúng 1 reference, amount nguyên ---');
  const testPayoutRef = `REF_TEST_VERIFIER_${ts}`;
  const validSnapshot = {
    amount: 2000,
    payoutReference: testPayoutRef,
    targetBankBin: testBankBin,
    targetAccountHash: accHash,
    expectedPayoutId: 'payout_real_100',
  };

  // 5a. Thiếu BIN người nhận từ phía hệ thống snapshot -> fail-closed
  const vMissingBinSnap = verifyPayosPayoutEvidence(
    { id: 'payout_real_100', approvalState: 'COMPLETED', transactions: [{ referenceId: testPayoutRef, amount: 2000, toBin: testBankBin, toAccountNumber: rawAccNumber, state: 'SUCCEEDED' }] },
    { ...validSnapshot, targetBankBin: null },
  );
  testAssert(!vMissingBinSnap.isVerified && vMissingBinSnap.reason?.includes('Thiếu snapshot thông tin người nhận'), 'Từ chối khi thiếu snapshot BIN người nhận');

  // 5b. Provider không báo cáo mã BIN (toBin / bin rỗng) -> fail-closed
  const vMissingReportedBin = verifyPayosPayoutEvidence(
    { id: 'payout_real_100', approvalState: 'COMPLETED', transactions: [{ referenceId: testPayoutRef, amount: 2000, toAccountNumber: rawAccNumber, state: 'SUCCEEDED' }] },
    validSnapshot,
  );
  testAssert(!vMissingReportedBin.isVerified && vMissingReportedBin.reason?.includes('thiếu thông tin mã BIN'), 'Từ chối fail-closed khi provider không trả về mã BIN người nhận');

  // 5c. Provider không báo cáo số tài khoản / hash -> fail-closed
  const vMissingReportedAcc = verifyPayosPayoutEvidence(
    { id: 'payout_real_100', approvalState: 'COMPLETED', transactions: [{ referenceId: testPayoutRef, amount: 2000, toBin: testBankBin, state: 'SUCCEEDED' }] },
    validSnapshot,
  );
  testAssert(!vMissingReportedAcc.isVerified && vMissingReportedAcc.reason?.includes('thiếu thông tin số tài khoản nhận'), 'Từ chối fail-closed khi provider không trả về số tài khoản nhận');

  // 5d. Phát hiện nhiều transactions trùng referenceId -> từ chối không đoán bừa
  const vDuplicateRef = verifyPayosPayoutEvidence(
    {
      id: 'payout_real_100',
      approvalState: 'COMPLETED',
      transactions: [
        { referenceId: testPayoutRef, amount: 2000, toBin: testBankBin, toAccountNumber: rawAccNumber, state: 'SUCCEEDED' },
        { referenceId: testPayoutRef, amount: 2000, toBin: testBankBin, toAccountNumber: rawAccNumber, state: 'SUCCEEDED' },
      ],
    },
    validSnapshot,
  );
  testAssert(!vDuplicateRef.isVerified && vDuplicateRef.reason?.includes('trùng payoutReference'), 'Từ chối khi có nhiều hơn 1 transaction trùng referenceId');

  // 5e. Dùng transaction ID thay cho referenceId -> không cho phép
  const vTxIdSubstituted = verifyPayosPayoutEvidence(
    {
      id: 'payout_real_100',
      approvalState: 'COMPLETED',
      transactions: [
        { id: testPayoutRef, referenceId: 'DIFF_REF', amount: 2000, toBin: testBankBin, toAccountNumber: rawAccNumber, state: 'SUCCEEDED' },
      ],
    },
    validSnapshot,
  );
  testAssert(!vTxIdSubstituted.isVerified, 'Không cho phép transaction ID thay thế referenceId');

  // 5f. Sai payoutId so với expectedPayoutId đã tra cứu
  const vWrongPayoutId = verifyPayosPayoutEvidence(
    { id: 'payout_wrong_999', approvalState: 'COMPLETED', transactions: [{ referenceId: testPayoutRef, amount: 2000, toBin: testBankBin, toAccountNumber: rawAccNumber, state: 'SUCCEEDED' }] },
    validSnapshot,
  );
  testAssert(!vWrongPayoutId.isVerified && vWrongPayoutId.reason?.includes('không khớp với ID đã tra cứu'), 'Từ chối khi payoutId detail không khớp expectedPayoutId');

  // 5g. Số tiền không phải số nguyên dương (e.g. 2000.5)
  const vNonIntegerAmount = verifyPayosPayoutEvidence(
    { id: 'payout_real_100', approvalState: 'COMPLETED', transactions: [{ referenceId: testPayoutRef, amount: 2000.5, toBin: testBankBin, toAccountNumber: rawAccNumber, state: 'SUCCEEDED' }] },
    validSnapshot,
  );
  testAssert(!vNonIntegerAmount.isVerified && vNonIntegerAmount.reason?.includes('nguyên dương'), 'Từ chối khi số tiền báo cáo không phải là số nguyên');

  // 5h. Bằng chứng đầy đủ và chuẩn xác -> isVerified: true
  const vSuccess = verifyPayosPayoutEvidence(
    { id: 'payout_real_100', approvalState: 'COMPLETED', transactions: [{ referenceId: testPayoutRef, amount: 2000, toBin: testBankBin, toAccountNumber: rawAccNumber, state: 'SUCCEEDED' }] },
    validSnapshot,
  );
  testAssert(vSuccess.isVerified && vSuccess.providerPayoutId === 'payout_real_100', 'Xác minh thành công khi đầy đủ tất cả snapshot, identity và chứng từ người nhận');

  // ========================================================================
  // TEST 6 [P0]: Xác minh Payout Thất Bại & Reconciler (Ma trận 5 trường hợp fail-closed)
  // ========================================================================
  console.log('\n--- TEST 6 [P0]: Payout Thất bại: Kiểm tra ma trận từ chối 5 trường hợp fail-closed ---');
  // 6a. Tổng FAILED, transaction SUCCEEDED -> Không finalize FAILED
  const rejTxnSucceeded = verifyPayosPayoutRejectionEvidence(
    {
      id: 'payout_fail_100',
      approvalState: 'FAILED',
      transactions: [{ referenceId: testPayoutRef, amount: 2000, toBin: testBankBin, toAccountNumber: rawAccNumber, state: 'SUCCEEDED' }],
    },
    { ...validSnapshot, expectedPayoutId: 'payout_fail_100' },
  );
  testAssert(!rejTxnSucceeded.isVerified, 'Tổng FAILED nhưng transaction SUCCEEDED -> Không finalize FAILED');

  // 6b. Tổng FAILED, transaction PROCESSING -> Không finalize FAILED
  const rejTxnProcessing = verifyPayosPayoutRejectionEvidence(
    {
      id: 'payout_fail_100',
      approvalState: 'FAILED',
      transactions: [{ referenceId: testPayoutRef, amount: 2000, toBin: testBankBin, toAccountNumber: rawAccNumber, state: 'PROCESSING' }],
    },
    { ...validSnapshot, expectedPayoutId: 'payout_fail_100' },
  );
  testAssert(!rejTxnProcessing.isVerified, 'Tổng FAILED nhưng transaction PROCESSING -> Không finalize FAILED');

  // 6c. Tổng FAILED, không có transactions -> Chờ đối soát
  const rejNoTxns = verifyPayosPayoutRejectionEvidence(
    {
      id: 'payout_fail_100',
      approvalState: 'FAILED',
      transactions: [],
    },
    { ...validSnapshot, expectedPayoutId: 'payout_fail_100' },
  );
  testAssert(!rejNoTxns.isVerified && rejNoTxns.reason?.includes('Không có danh sách transactions'), 'Tổng FAILED nhưng không có transactions -> Chờ đối soát');

  // 6d. Đúng reference nhưng sai amount hoặc sai tài khoản/BIN -> Chờ đối soát
  const rejWrongAmount = verifyPayosPayoutRejectionEvidence(
    {
      id: 'payout_fail_100',
      approvalState: 'FAILED',
      transactions: [{ referenceId: testPayoutRef, amount: 5000, toBin: testBankBin, toAccountNumber: rawAccNumber, state: 'FAILED' }],
    },
    { ...validSnapshot, expectedPayoutId: 'payout_fail_100' },
  );
  const rejWrongBin = verifyPayosPayoutRejectionEvidence(
    {
      id: 'payout_fail_100',
      approvalState: 'FAILED',
      transactions: [{ referenceId: testPayoutRef, amount: 2000, toBin: '970405', toAccountNumber: rawAccNumber, state: 'FAILED' }],
    },
    { ...validSnapshot, expectedPayoutId: 'payout_fail_100' },
  );
  const rejWrongAcc = verifyPayosPayoutRejectionEvidence(
    {
      id: 'payout_fail_100',
      approvalState: 'FAILED',
      transactions: [{ referenceId: testPayoutRef, amount: 2000, toBin: testBankBin, toAccountNumber: '111222333444', state: 'FAILED' }],
    },
    { ...validSnapshot, expectedPayoutId: 'payout_fail_100' },
  );
  testAssert(
    !rejWrongAmount.isVerified && !rejWrongBin.isVerified && !rejWrongAcc.isVerified,
    'Đúng reference nhưng sai amount hoặc sai tài khoản/BIN -> Chờ đối soát',
  );

  // 6e. Mâu thuẫn: Tổng COMPLETED nhưng transaction FAILED -> Chờ đối soát
  const rejContradictory = verifyPayosPayoutRejectionEvidence(
    {
      id: 'payout_fail_100',
      approvalState: 'COMPLETED',
      transactions: [{ referenceId: testPayoutRef, amount: 2000, toBin: testBankBin, toAccountNumber: rawAccNumber, state: 'FAILED' }],
    },
    { ...validSnapshot, expectedPayoutId: 'payout_fail_100' },
  );
  testAssert(!rejContradictory.isVerified && rejContradictory.reason?.includes('Mâu thuẫn'), 'Mâu thuẫn: Tổng COMPLETED nhưng transaction FAILED -> Chờ đối soát');

  // 6f. Đủ bằng chứng thất bại đúng giao dịch và người nhận -> Mới finalize FAILED
  const rejValid = verifyPayosPayoutRejectionEvidence(
    {
      id: 'payout_fail_100',
      approvalState: 'FAILED',
      transactions: [{ referenceId: testPayoutRef, amount: 2000, toBin: testBankBin, toAccountNumber: rawAccNumber, state: 'FAILED' }],
    },
    { ...validSnapshot, expectedPayoutId: 'payout_fail_100' },
  );
  testAssert(rejValid.isVerified && rejValid.providerPayoutId === 'payout_fail_100', 'Đủ bằng chứng thất bại đúng giao dịch và người nhận -> Mới finalize FAILED');

  // 6c. Reconciler gặp lỗi timeout / 403 / 500 -> giữ PENDING_RECONCILIATION
  const testObligationReconcile = {
    id: BigInt(obligationsTable.length + 1),
    inboundTransactionId: BigInt(7001),
    refundAmount: 2000,
    refundStatus: 'PROCESSING_REFUND',
    targetBankBin: testBankBin,
    targetAccountHash: accHash,
    targetAccountEncrypted: accEncrypted,
    targetAccountMasked: accMasked,
    refundPayoutReference: `REF_PAY_RECON_${ts}`,
    activePayoutAttemptId: null,
  };
  obligationsTable.push(testObligationReconcile);

  const testAttemptReconcile = {
    id: BigInt(attemptsTable.length + 1),
    obligationId: testObligationReconcile.id,
    attemptNumber: 1,
    payoutProvider: 'PAYOS',
    payoutReference: `REF_OBL_${testObligationReconcile.id}_ATT_1_${ts}`,
    status: 'PENDING_RECONCILIATION',
    createdAt: new Date(),
    obligation: testObligationReconcile,
  };
  attemptsTable.push(testAttemptReconcile);
  testObligationReconcile.activePayoutAttemptId = testAttemptReconcile.id;

  mockRepo.findPendingReconciliationAttempts = async () => [testAttemptReconcile];

  // PayOS ném 403 Forbidden
  (payosPayoutService as any).getPayouts = async () => {
    const err: any = new Error('Forbidden 403: Invalid IP whitelist');
    err.status = 403;
    throw err;
  };

  await service.reconcilePendingRefundPayouts(5);
  testAssert(
    testAttemptReconcile.status === 'PENDING_RECONCILIATION' && testObligationReconcile.activePayoutAttemptId !== null,
    'Lỗi 403 / Timeout từ provider giữ nguyên PENDING_RECONCILIATION, không tự suy diễn thất bại',
  );

  // ========================================================================
  // TEST 7 [P1]: State Machine: Active Pointer Guard & Chống Ghi Đè Terminal
  // ========================================================================
  console.log('\n--- TEST 7 [P1]: State Machine: Active Pointer Guard và Chống Ghi Đè Terminal ---');
  // 7a. Cho attempt 1 thành công (SUCCESS)
  await mockRepo.finalizePayoutAttemptTx({
    obligationId: testObligationReconcile.id,
    attemptId: testAttemptReconcile.id,
    status: 'SUCCESS',
    providerPayoutId: 'payout_final_ok',
  });
  testAssert(
    testAttemptReconcile.status === 'SUCCESS' && testObligationReconcile.activePayoutAttemptId === null,
    'Attempt 1 thành công chuyển status SUCCESS và giải phóng active pointer',
  );

  // 7b. Idempotent duplicate: Gửi lại callback SUCCESS cho attempt 1
  const idempRes = await mockRepo.finalizePayoutAttemptTx({
    obligationId: testObligationReconcile.id,
    attemptId: testAttemptReconcile.id,
    status: 'SUCCESS',
    providerPayoutId: 'payout_final_ok',
  });
  testAssert(idempRes.idempotent === true, 'Callback lặp cùng trạng thái SUCCESS trả về idempotent: true');

  // 7c. Callback trái ngược: Gửi callback FAILED cho attempt đã SUCCESS -> 409 Conflict
  let conflictTerminalError: any = null;
  try {
    await mockRepo.finalizePayoutAttemptTx({
      obligationId: testObligationReconcile.id,
      attemptId: testAttemptReconcile.id,
      status: 'FAILED',
      failureReason: 'Contradictory late failure',
    });
  } catch (err: any) {
    conflictTerminalError = err;
  }
  testAssert(
    conflictTerminalError !== null && conflictTerminalError.status === 409,
    'Chặn đứng callback trái ngược cố ghi đè trạng thái terminal (409 Conflict)',
  );

  // 7d. Attempt đang active bị callback khi pointer đã null hoặc trỏ sang attempt khác
  const testObligationPointer = {
    id: BigInt(obligationsTable.length + 1),
    inboundTransactionId: BigInt(8001),
    refundAmount: 2000,
    refundStatus: 'PENDING_REFUND',
    targetBankBin: testBankBin,
    targetAccountHash: accHash,
    targetAccountEncrypted: accEncrypted,
    targetAccountMasked: accMasked,
    refundPayoutReference: `REF_PAY_PTR_${ts}`,
    activePayoutAttemptId: null,
  };
  obligationsTable.push(testObligationPointer);

  const attempt1 = {
    id: BigInt(attemptsTable.length + 1),
    obligationId: testObligationPointer.id,
    attemptNumber: 1,
    payoutProvider: 'PAYOS',
    payoutReference: `REF_PTR_ATT_1_${ts}`,
    status: 'PREPARING',
    createdAt: new Date(),
    obligation: testObligationPointer,
  };
  attemptsTable.push(attempt1);

  // Pointer đang là null, cố finalize attempt1
  let nullPointerError: any = null;
  try {
    await mockRepo.finalizePayoutAttemptTx({
      obligationId: testObligationPointer.id,
      attemptId: attempt1.id,
      status: 'FAILED',
      failureReason: 'Late report',
    });
  } catch (e: any) {
    nullPointerError = e;
  }
  testAssert(
    nullPointerError !== null && nullPointerError.message.includes('active pointer: null'),
    'Từ chối cập nhật attempt khi active pointer là null (Bảo vệ tính toàn vẹn con trỏ)',
  );

  // ========================================================================
  // TEST 8 [P1]: Intake thiếu reference: Lưu 3 quan sát đối soát riêng biệt, cấm tự động chi trả
  //              và KHÔNG tính vào tiền thực nhận (paymentStatus = PENDING_RECONCILIATION, receivedAmount = 0)
  // ========================================================================
  console.log('\n--- TEST 8 [P1]: Gửi lặp 3 thông báo thiếu reference -> Lưu 3 quan sát, API không tính vào tiền thực nhận ---');
  // Khởi tạo phiên xác minh cho testAccountObs (id: 302)
  const testAccountObs = accountsTable.find((a) => a.id === BigInt(302));
  const { session: obsSession } = await mockRepo.getOrCreatePennyVerificationSessionTx({
    customerId: testCustomer.customerId,
    accountId: testAccountObs.id,
    bankBin: testAccountObs.bankBin,
    accountNumberHash: testAccountObs.accountNumberHash,
    expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    generateOrderCode: () => BigInt(99887711),
    generateProofReference: () => `CUST_VRF_OBS_${Date.now()}`,
  });

  const missingRefOrderCode1 = Number(obsSession.paymentOrderCode);

  // Gửi lặp 3 thông báo webhook thiếu reference
  for (let i = 1; i <= 3; i++) {
    const missingRefData = {
      orderCode: missingRefOrderCode1,
      amount: 2000,
      counterAccountBankId: testBankBin,
      counterAccountNumber: rawAccNumber,
      counterAccountName: `NGUYEN VAN MISSING REF ${i}`,
      transactionDateTime: new Date(Date.now() + i * 1000).toISOString(),
    };
    const sig = signWebhookData(missingRefData, testChecksumKey);
    await service.processPayosVerificationWebhook({
      code: '00',
      desc: 'success',
      data: missingRefData,
      signature: sig,
    });
  }

  const missingObsList = inboundsTable.filter(
    (t) => t.proofId === obsSession.id && t.reconciliationFlag === 'FLAGGED_MISSING_PROVIDER_REF',
  );
  const unrefObligations = obligationsTable.filter((o) =>
    missingObsList.some((obs) => obs.id === o.inboundTransactionId),
  );

  // Tra cứu trạng thái qua API Polling (getVerificationStatus)
  const statusBefore = await service.getVerificationStatus({ userId: testUser.userId }, testAccountObs.id);
  // Tra cứu lịch sử (getVerificationHistory)
  const historyBefore = await service.getVerificationHistory({ userId: testUser.userId }, { page: 1, pageSize: 20 });
  const sessionItemBefore = historyBefore.items.find((item) => item.sessionId === obsSession.id.toString());

  testAssert(
    missingObsList.length === 3 &&
      unrefObligations.length === 0 &&
      statusBefore.session.paymentStatus === 'PENDING_RECONCILIATION' &&
      statusBefore.session.refundSummary.totalObligationAmount === 0 &&
      (sessionItemBefore?.receivedAmount || 0) === 0 &&
      (sessionItemBefore?.totalObligationAmount || 0) === 0,
    'Gửi lặp 3 thông báo thiếu reference -> Lưu 3 quan sát, không tạo obligation, API trả PENDING_RECONCILIATION và 0đ',
  );

  // ========================================================================
  // TEST 9 [P1]: Đối soát ghép các quan sát cụ thể thành giao dịch xác định (Không tạo đường kích hoạt riêng)
  // ========================================================================
  console.log('\n--- TEST 9 [P1]: Đối soát ghép các quan sát cụ thể thành giao dịch xác định ---');
  const obsIdsToMerge = missingObsList.slice(0, 2).map((o) => o.id); // Chọn 2 trong 3 quan sát
  const unmergedObs = missingObsList[2]; // Quan sát thứ 3 là một khoản riêng biệt

  // 9a. Ghép 2 quan sát được chỉ định vào confirmed receipt 2.000đ hợp lệ
  const confirmedBankRef = `FT_RECONCILED_${ts}`;
  const reconResult = await service.reconcileObservationsIntoConfirmedReceipt({
    sessionId: obsSession.id,
    observationIds: obsIdsToMerge,
    confirmedTransactionRef: confirmedBankRef,
    amount: 2000,
    sourceBankBin: testBankBin,
    sourceAccountNumber: rawAccNumber,
    sourceAccountName: 'NGUYEN VAN RECONCILED',
  });

  const statusAfter = await service.getVerificationStatus({ userId: testUser.userId }, testAccountObs.id);
  const historyAfter = await service.getVerificationHistory({ userId: testUser.userId }, { page: 1, pageSize: 20 });
  const sessionItemAfter = historyAfter.items.find((item) => item.sessionId === obsSession.id.toString());

  testAssert(
    reconResult.mergedObservationsCount === 2 &&
      statusAfter.session.paymentStatus === 'PAID' &&
      statusAfter.session.refundSummary.totalObligationAmount === 2000 &&
      sessionItemAfter?.receivedAmount === 2000 &&
      sessionItemAfter?.totalObligationAmount === 2000 &&
      testAccountObs.verificationStatus === 'VERIFIED',
    'Sau đối soát: 2 quan sát được chọn được gộp với FK mergedIntoInboundId, kích hoạt tài khoản đúng chuẩn',
  );

  // 9b. Hai khoản khác nhau cùng phiên không bị gộp: Quan sát thứ 3 vẫn độc lập
  testAssert(
    unmergedObs.mergedIntoInboundId === null || unmergedObs.mergedIntoInboundId === undefined,
    'Hai khoản khác nhau cùng phiên: Quan sát thứ 3 không nằm trong danh sách chọn không bị gộp vào giao dịch 1',
  );

  // 9c. Ghép lại cùng giao dịch -> Trả kết quả Idempotent, tuyệt đối không tạo thêm obligation
  const obligationsBeforeRetry = obligationsTable.length;
  const idempRecon = await service.reconcileObservationsIntoConfirmedReceipt({
    sessionId: obsSession.id,
    observationIds: obsIdsToMerge,
    confirmedTransactionRef: confirmedBankRef,
    amount: 2000,
    sourceBankBin: testBankBin,
    sourceAccountNumber: rawAccNumber,
    sourceAccountName: 'NGUYEN VAN RECONCILED',
  });
  testAssert(
    idempRecon.idempotent === true && obligationsTable.length === obligationsBeforeRetry,
    'Ghép lại cùng reference giao dịch -> Trả kết quả idempotent, không tạo nghĩa vụ hoàn tiền mới',
  );

  // 9d. Observation đã ghép không được đổi liên kết sang giao dịch khác -> 409 Conflict
  let conflictMergeError: any = null;
  try {
    await service.reconcileObservationsIntoConfirmedReceipt({
      sessionId: obsSession.id,
      observationIds: [obsIdsToMerge[0]], // Thử ghép lại observation đã ghép vào 1 giao dịch mới
      confirmedTransactionRef: `FT_ANOTHER_NEW_REF_${ts}`,
      amount: 2000,
      sourceBankBin: testBankBin,
      sourceAccountNumber: rawAccNumber,
    });
  } catch (err: any) {
    conflictMergeError = err;
  }
  testAssert(
    conflictMergeError !== null,
    'Chặn đứng việc đổi liên kết audit: Observation đã ghép không thể bị ghép sang giao dịch khác',
  );

  // 9e. Khoản đối soát không đủ điều kiện (amount = 5000đ khác 2000đ hoặc sai tài khoản nguồn):
  //     Vẫn tạo confirmed receipt và obligation hoàn tiền, nhưng TUYỆT ĐỐI KHÔNG XÁC NHẬN TÀI KHOẢN!
  const testAccountBadRecon: any = {
    ...testBankAccount,
    id: BigInt(304),
    verificationStatus: 'PENDING',
  };
  accountsTable.push(testAccountBadRecon);

  const { session: badReconSession } = await mockRepo.getOrCreatePennyVerificationSessionTx({
    customerId: testCustomer.customerId,
    accountId: testAccountBadRecon.id,
    bankBin: testAccountBadRecon.bankBin,
    accountNumberHash: testAccountBadRecon.accountNumberHash,
    expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    generateOrderCode: () => BigInt(77665544),
    generateProofReference: () => `CUST_VRF_BAD_RECON_${Date.now()}`,
  });

  const badObsInbound = {
    id: BigInt(inboundsTable.length + 1),
    proofId: badReconSession.id,
    provider: 'PAYOS',
    channel: 'PAYOS_WEBHOOK',
    providerTransactionRef: `UNREF_OBS_77665544_${Date.now()}_abc`,
    amount: 5000,
    receivedAt: new Date(),
    isLatePayment: false,
    sourceBankBin: testBankBin,
    sourceAccountMasked: accMasked,
    sourceAccountHash: accHash,
    sourceAccountEncrypted: accEncrypted,
    sourceAccountName: 'NGUYEN VAN BAD RECON',
    hasSufficientEvidence: false,
    sessionMatchStatus: 'MATCHED_SESSION',
    matchDecision: 'MISSING_TRANSACTION_REF',
    reconciliationFlag: 'FLAGGED_MISSING_PROVIDER_REF',
    mergedIntoInboundId: null,
    createdAt: new Date(),
  };
  inboundsTable.push(badObsInbound);

  const badReconResult = await service.reconcileObservationsIntoConfirmedReceipt({
    sessionId: badReconSession.id,
    observationIds: [badObsInbound.id],
    confirmedTransactionRef: `FT_BAD_AMOUNT_${ts}`,
    amount: 5000, // Sai số tiền (5.000đ thay vì 2.000đ)
    sourceBankBin: testBankBin,
    sourceAccountNumber: rawAccNumber,
    sourceAccountName: 'NGUYEN VAN BAD RECON',
  });

  testAssert(
    badReconResult.shouldActivate === false &&
      badReconResult.matchDecision === 'INVALID_AMOUNT' &&
      badReconResult.obligation !== null &&
      Number(badReconResult.obligation.refundAmount) === 5000 &&
      testAccountBadRecon.verificationStatus === 'PENDING' &&
      badReconSession.verificationStatus !== 'VERIFIED',
    'Khoản đối soát sai số tiền (5.000đ): Tạo nghĩa vụ hoàn tiền 5.000đ nhưng TUYỆT ĐỐI KHÔNG xác nhận tài khoản (tài khoản giữ PENDING)',
  );

  // 9f (Tình huống 1): Giao dịch đã tồn tại, observation chưa liên kết:
  //    Ghép có kiểm chứng vào giao dịch hiện có, không tạo obligation mới, không báo thành công giả
  const obligationsBeforeAdd = obligationsTable.length;
  const addReconResult = await service.reconcileObservationsIntoConfirmedReceipt({
    sessionId: obsSession.id,
    observationIds: [unmergedObs.id], // Quan sát thứ 3 chưa được liên kết
    confirmedTransactionRef: confirmedBankRef, // Giao dịch đã tồn tại từ 9a
    amount: 2000,
    sourceBankBin: testBankBin,
    sourceAccountNumber: rawAccNumber,
    sourceAccountName: 'NGUYEN VAN RECONCILED',
  });
  testAssert(
    addReconResult.idempotent === false &&
      addReconResult.mergedObservationsCount === 3 &&
      unmergedObs.mergedIntoInboundId !== null &&
      obligationsTable.length === obligationsBeforeAdd,
    'Giao dịch đã tồn tại, bổ sung observation chưa liên kết: Ghép thành công vào giao dịch hiện có, không tạo obligation mới',
  );

  // 9g (Tình huống 2): Danh sách chứa ID không tồn tại hoặc sai phiên -> Bị từ chối
  let notFoundObsError: any = null;
  try {
    await service.reconcileObservationsIntoConfirmedReceipt({
      sessionId: obsSession.id,
      observationIds: [BigInt(999999999)], // ID không tồn tại
      confirmedTransactionRef: `FT_TEST_NOT_FOUND_${ts}`,
      amount: 2000,
      sourceBankBin: testBankBin,
      sourceAccountNumber: rawAccNumber,
    });
  } catch (err: any) {
    notFoundObsError = err;
  }
  testAssert(
    notFoundObsError !== null && (notFoundObsError.getStatus?.() === 404 || notFoundObsError.status === 404),
    'Từ chối khi danh sách chứa observation ID không tồn tại (404 Not Found)',
  );

  let wrongSessionObsError: any = null;
  try {
    await service.reconcileObservationsIntoConfirmedReceipt({
      sessionId: badReconSession.id, // Phiên B
      observationIds: [obsIdsToMerge[0]], // Quan sát thuộc phiên A
      confirmedTransactionRef: `FT_WRONG_SESSION_${ts}`,
      amount: 2000,
      sourceBankBin: testBankBin,
      sourceAccountNumber: rawAccNumber,
    });
  } catch (err: any) {
    wrongSessionObsError = err;
  }
  testAssert(
    wrongSessionObsError !== null && (wrongSessionObsError.getStatus?.() === 400 || wrongSessionObsError.status === 400),
    'Từ chối khi quan sát không thuộc về đúng phiên xác minh yêu cầu (400 Bad Request)',
  );

  // 9h (Tình huống 3): Hai observation khác số tiền hoặc tài khoản nguồn -> Không tự ghép chung
  const diffAmountObs = {
    id: BigInt(inboundsTable.length + 1),
    proofId: obsSession.id,
    provider: 'PAYOS',
    channel: 'PAYOS_WEBHOOK',
    providerTransactionRef: `UNREF_OBS_DIFF_AMT_${ts}`,
    amount: 10000, // Khác 2.000đ
    receivedAt: new Date(),
    isLatePayment: false,
    sourceBankBin: testBankBin,
    sourceAccountMasked: accMasked,
    sourceAccountHash: accHash,
    sourceAccountEncrypted: accEncrypted,
    sourceAccountName: 'DIFF AMOUNT',
    hasSufficientEvidence: true,
    sessionMatchStatus: 'MATCHED_SESSION',
    matchDecision: 'MISSING_TRANSACTION_REF',
    reconciliationFlag: 'FLAGGED_MISSING_PROVIDER_REF',
    mergedIntoInboundId: null,
    createdAt: new Date(),
  };
  inboundsTable.push(diffAmountObs);

  let diffAmountError: any = null;
  try {
    await service.reconcileObservationsIntoConfirmedReceipt({
      sessionId: obsSession.id,
      observationIds: [diffAmountObs.id],
      confirmedTransactionRef: `FT_DIFF_AMOUNT_CHECK_${ts}`,
      amount: 2000, // Cố ghép observation 10.000đ vào chứng từ 2.000đ
      sourceBankBin: testBankBin,
      sourceAccountNumber: rawAccNumber,
    });
  } catch (err: any) {
    diffAmountError = err;
  }
  testAssert(
    diffAmountError !== null && (diffAmountError.getStatus?.() === 409 || diffAmountError.status === 409),
    'Mâu thuẫn số tiền: Từ chối tự động ghép observation có số tiền khác với giao dịch xác nhận (409 Conflict)',
  );

  const diffBinObs = {
    id: BigInt(inboundsTable.length + 1),
    proofId: obsSession.id,
    provider: 'PAYOS',
    channel: 'PAYOS_WEBHOOK',
    providerTransactionRef: `UNREF_OBS_DIFF_BIN_${ts}`,
    amount: 2000,
    receivedAt: new Date(),
    isLatePayment: false,
    sourceBankBin: '970400', // Khác BIN đăng ký 970422
    sourceAccountMasked: accMasked,
    sourceAccountHash: accHash,
    sourceAccountEncrypted: accEncrypted,
    sourceAccountName: 'DIFF BIN',
    hasSufficientEvidence: true,
    sessionMatchStatus: 'MATCHED_SESSION',
    matchDecision: 'MISSING_TRANSACTION_REF',
    reconciliationFlag: 'FLAGGED_MISSING_PROVIDER_REF',
    mergedIntoInboundId: null,
    createdAt: new Date(),
  };
  inboundsTable.push(diffBinObs);

  let diffBinError: any = null;
  try {
    await service.reconcileObservationsIntoConfirmedReceipt({
      sessionId: obsSession.id,
      observationIds: [diffBinObs.id],
      confirmedTransactionRef: `FT_DIFF_BIN_CHECK_${ts}`,
      amount: 2000,
      sourceBankBin: testBankBin, // 970422 mâu thuẫn với 970400
      sourceAccountNumber: rawAccNumber,
    });
  } catch (err: any) {
    diffBinError = err;
  }
  testAssert(
    diffBinError !== null && (diffBinError.getStatus?.() === 409 || diffBinError.status === 409),
    'Mâu thuẫn tài khoản/BIN nguồn: Từ chối ghép observation có BIN mâu thuẫn với chứng từ xác nhận (409 Conflict)',
  );

  // 9i (Tình huống 5): Hai request đồng thời cùng ghép -> Không tạo trùng tiền hoặc đổi liên kết
  const concurrentObs = {
    id: BigInt(inboundsTable.length + 1),
    proofId: obsSession.id,
    provider: 'PAYOS',
    channel: 'PAYOS_WEBHOOK',
    providerTransactionRef: `UNREF_OBS_CONCURRENT_${ts}`,
    amount: 2000,
    receivedAt: new Date(),
    isLatePayment: false,
    sourceBankBin: testBankBin,
    sourceAccountMasked: accMasked,
    sourceAccountHash: accHash,
    sourceAccountEncrypted: accEncrypted,
    sourceAccountName: 'CONCURRENT OBS',
    hasSufficientEvidence: true,
    sessionMatchStatus: 'MATCHED_SESSION',
    matchDecision: 'MISSING_TRANSACTION_REF',
    reconciliationFlag: 'FLAGGED_MISSING_PROVIDER_REF',
    mergedIntoInboundId: null,
    createdAt: new Date(),
  };
  inboundsTable.push(concurrentObs);

  const obligationsBeforeConcurrent = obligationsTable.length;
  const concurrentRef = `FT_CONCURRENT_${ts}`;
  const [res1, res2] = await Promise.all([
    service.reconcileObservationsIntoConfirmedReceipt({
      sessionId: obsSession.id,
      observationIds: [concurrentObs.id],
      confirmedTransactionRef: concurrentRef,
      amount: 2000,
      sourceBankBin: testBankBin,
      sourceAccountNumber: rawAccNumber,
    }),
    service.reconcileObservationsIntoConfirmedReceipt({
      sessionId: obsSession.id,
      observationIds: [concurrentObs.id],
      confirmedTransactionRef: concurrentRef,
      amount: 2000,
      sourceBankBin: testBankBin,
      sourceAccountNumber: rawAccNumber,
    }),
  ]);

  testAssert(
    obligationsTable.length === obligationsBeforeConcurrent + 1 &&
      (res1.idempotent === true || res2.idempotent === true),
    'Hai request đồng thời cùng ghép: Chỉ sinh duy nhất 1 nghĩa vụ hoàn trả (1:1), request còn lại trả kết quả idempotent',
  );

  // ========================================================================
  // TEST 10 [P1]: Multi-Instance Link Recovery & CAS Loser Fallback
  // ========================================================================
  console.log('\n--- TEST 10 [P1]: Hai instance cùng xử lý phiên, instance thua CAS trả về link đã lưu an toàn ---');
  const testAccountCAS: any = {
    ...testBankAccount,
    id: BigInt(303),
    verificationStatus: 'PENDING',
  };
  accountsTable.push(testAccountCAS);

  const { session: casSession } = await mockRepo.getOrCreatePennyVerificationSessionTx({
    customerId: testCustomer.customerId,
    accountId: testAccountCAS.id,
    bankBin: testAccountCAS.bankBin,
    accountNumberHash: testAccountCAS.accountNumberHash,
    expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    generateOrderCode: () => BigInt(88991122),
    generateProofReference: () => `CUST_VRF_CAS_${Date.now()}`,
  });

  const committedUrl = `https://payos.vn/checkout/instance1_${ts}`;
  await mockRepo.attachPaymentLinkToSessionCAS(casSession.id, `plink_inst1_${ts}`, committedUrl);

  // Instance 2 thua CAS (attach trả false):
  const originalAttachCAS = mockRepo.attachPaymentLinkToSessionCAS;
  mockRepo.attachPaymentLinkToSessionCAS = async () => false;

  const instance2Result = await service.initiateVerificationSession(
    { userId: testUser.userId },
    testAccountCAS.id,
  );

  mockRepo.attachPaymentLinkToSessionCAS = originalAttachCAS;

  testAssert(
    instance2Result.checkoutUrl === committedUrl,
    'Instance 2 thua CAS tự động nạp lại phiên đã commit từ DB và trả về đúng checkoutUrl đã lưu, không ném lỗi',
  );

  console.log('\n================================================================================');
  console.log(`📊 SUMMARY: Total Passed: ${passed} | Failed: ${failed}`);
  console.log('================================================================================\n');

  assert.strictEqual(failed, 0, `There are ${failed} failing tests in the suite!`);
}

runComprehensivePennyVerificationTestSuite().catch((e) => {
  console.error(e);
  process.exit(1);
});
