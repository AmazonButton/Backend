import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { PaymentRefundsRepository } from './payment-refunds.repository';
import {
  PayOSPayoutIndeterminateException,
  PayOSPayoutPreDispatchException,
  PayOSPayoutService,
} from './payos-payout.service';
import {
  verifyPayosPayoutEvidence,
  verifyPayosPayoutRejectionEvidence,
} from './payos-payout-verifier';
import { CryptoVaultUtil } from '../common/utils/crypto-vault.util';
import { normalizeBankBin } from '../common/utils/bank-identifier.util';
import { NotificationsService } from '../notifications/notifications.service';
import { EventsGateway } from '../websocket/events.gateway';

export function toPaymentRefundObligationDto(obligation: any) {
  if (!obligation) return null;
  return {
    obligationId: obligation.obligationId?.toString(),
    orderId: obligation.orderId?.toString(),
    sourcePaymentTransactionId: obligation.sourcePaymentTransactionId
      ? obligation.sourcePaymentTransactionId.toString()
      : null,
    receiptId: obligation.receiptId?.toString(),
    obligationType: obligation.obligationType,
    refundAmount: Number(obligation.refundAmount),
    currency: obligation.currency,
    status: obligation.status,
    recipientVerificationStatus: obligation.recipientVerificationStatus,
    verificationNote: obligation.verificationNote ?? null,
    customerBankAccountId: obligation.customerBankAccountId
      ? obligation.customerBankAccountId.toString()
      : null,
    targetBankBin: obligation.targetBankBin ?? null,
    targetAccountMasked: obligation.targetAccountMasked ?? null,
    targetAccountName: obligation.targetAccountName ?? null,
    snapshotLockedAt: obligation.snapshotLockedAt ?? null,
    activePayoutAttemptId: obligation.activePayoutAttemptId
      ? obligation.activePayoutAttemptId.toString()
      : null,
    settledAttemptId: obligation.settledAttemptId
      ? obligation.settledAttemptId.toString()
      : null,
    refundedAt: obligation.refundedAt ?? null,
    failureReason: obligation.failureReason ?? null,
    createdAt: obligation.createdAt,
    updatedAt: obligation.updatedAt,
    receipt: obligation.receipt
      ? {
          receiptId: obligation.receipt.receiptId?.toString(),
          provider: obligation.receipt.provider,
          channel: obligation.receipt.channel,
          providerTransactionRef: obligation.receipt.providerTransactionRef,
          amount: Number(obligation.receipt.amount),
          classification: obligation.receipt.classification,
          sourceBankBin: obligation.receipt.sourceBankBin ?? null,
          sourceAccountMasked: obligation.receipt.sourceAccountMasked ?? null,
          sourceEvidenceStatus: obligation.receipt.sourceEvidenceStatus,
          receivedAt: obligation.receipt.receivedAt,
        }
      : undefined,
    order: obligation.order
      ? {
          orderId: obligation.order.orderId?.toString(),
          orderCode: obligation.order.orderCode,
          orderStatus: obligation.order.orderStatus,
          paymentStatus: obligation.order.paymentStatus,
          isGuestOrder: obligation.order.customerId == null,
          storeId: obligation.order.storeId?.toString(),
        }
      : undefined,
    payoutAttempts: Array.isArray(obligation.payoutAttempts)
      ? obligation.payoutAttempts.map((a: any) => ({
          attemptId: a.attemptId?.toString(),
          attemptNumber: a.attemptNumber,
          payoutProvider: a.payoutProvider,
          payoutReference: a.payoutReference,
          providerPayoutId: a.providerPayoutId ?? null,
          providerTransactionId: a.providerTransactionId ?? null,
          status: a.status,
          dispatchedAt: a.dispatchedAt ?? null,
          reconciledAt: a.reconciledAt ?? null,
          reconcileAttempts: a.reconcileAttempts,
          responseCode: a.responseCode ?? null,
          failureReason: a.failureReason ?? null,
          createdAt: a.createdAt,
        }))
      : undefined,
    verifiedVoucher: obligation.verifiedVoucher
      ? {
          voucherId: obligation.verifiedVoucher.voucherId?.toString(),
          providerPayoutId: obligation.verifiedVoucher.providerPayoutId,
          providerTransactionId: obligation.verifiedVoucher.providerTransactionId,
          payoutReference: obligation.verifiedVoucher.payoutReference,
          verifiedAmount: Number(obligation.verifiedVoucher.verifiedAmount),
          verifiedAt: obligation.verifiedVoucher.verifiedAt,
        }
      : undefined,
  };
}

@Injectable()
export class PaymentRefundsService {
  private readonly logger = new Logger(PaymentRefundsService.name);

  constructor(
    private readonly repo: PaymentRefundsRepository,
    @Optional() @Inject(PayOSPayoutService) private readonly payosPayoutService?: PayOSPayoutService,
    @Optional() @Inject(NotificationsService) private readonly notificationsService?: NotificationsService,
    @Optional() @Inject(EventsGateway) private readonly eventsGateway?: EventsGateway,
  ) {}

  assertSuperAdmin(user?: any) {
    if (!user || user.role !== 'SUPER_ADMIN') {
      throw new ForbiddenException(
        'Chỉ SUPER_ADMIN mới có quyền phát lệnh hoặc chốt đối soát hoàn tiền PayOS.',
      );
    }
  }

  async listObligations(query: { page?: any; pageSize?: any; status?: string; orderId?: string }, user?: any) {
    this.assertSuperAdmin(user);
    const res = await this.repo.listObligations({
      page: query.page ? Number(query.page) : 1,
      pageSize: query.pageSize ? Number(query.pageSize) : 20,
      status: query.status,
      orderId: query.orderId && /^\d+$/.test(query.orderId) ? BigInt(query.orderId) : undefined,
    });
    return {
      items: res.items.map(toPaymentRefundObligationDto),
      total: res.total,
      page: res.page,
      pageSize: res.pageSize,
    };
  }

  async getObligationById(idParam: string | bigint, user?: any) {
    this.assertSuperAdmin(user);
    if (!/^\d+$/.test(String(idParam))) {
      throw new BadRequestException('Mã nghĩa vụ hoàn tiền không hợp lệ');
    }
    const obl = await this.repo.findObligationById(BigInt(idParam));
    if (!obl) throw new NotFoundException('Không tìm thấy nghĩa vụ hoàn tiền');
    return toPaymentRefundObligationDto(obl);
  }

  async ensureOrderRefundObligations(orderId: bigint) {
    await this.repo['prisma'].$transaction(async (tx: any) => {
      await this.repo.ensureOrderRefundObligationsForCancelledOrderInTx(tx, orderId);
    });
    return this.repo.findObligationsForOrder(orderId);
  }

  /**
   * SUPER_ADMIN financial payout initiation:
   * Phase 1 (TX): checks permissions, verified recipient ownership & source proof, conservation budget,
   * claims obligation + creates single attempt + writes OutboxEvent -> COMMIT.
   */
  async initiateObligationPayout(
    obligationIdParam: string | number | bigint,
    dto: { customerBankAccountId?: string; note?: string } = {},
    user?: any,
    options?: { dispatchNow?: boolean },
  ) {
    this.assertSuperAdmin(user);
    if (!/^\d+$/.test(String(obligationIdParam))) {
      throw new BadRequestException('Mã nghĩa vụ hoàn tiền không hợp lệ');
    }
    const obligationId = BigInt(obligationIdParam);
    const actorUserId = user?.userId ? BigInt(user.userId) : null;
    const customerBankAccountId =
      dto?.customerBankAccountId && /^\d+$/.test(dto.customerBankAccountId)
        ? BigInt(dto.customerBankAccountId)
        : null;

    const claimed = await this.repo.claimObligationForPayoutTx(obligationId, actorUserId, {
      customerBankAccountId,
      note: dto?.note,
    });

    if (claimed.alreadySettled) {
      return toPaymentRefundObligationDto(claimed.obligation);
    }

    const shouldDispatchNow =
      options?.dispatchNow !== undefined ? options.dispatchNow : Boolean(this.payosPayoutService);

    if (shouldDispatchNow && claimed.attempt) {
      let dispatchRes: any;
      try {
        dispatchRes = await this.dispatchClaimedAttempt(
          obligationId,
          BigInt(claimed.attempt.attemptId),
        );
      } catch (err) {
        if (claimed.outboxEvent?.id) {
          const latestAtt = await this.repo['prisma'].paymentRefundPayoutAttempt
            .findUnique({
              where: { attemptId: claimed.attempt.attemptId },
              select: { status: true },
            })
            .catch(() => null);
          if (latestAtt && latestAtt.status !== 'PREPARING') {
            await this.repo['prisma'].outboxEvent
              .updateMany({
                where: { id: claimed.outboxEvent.id, status: 'PENDING' },
                data: { status: 'COMPLETED', processedAt: new Date() },
              })
              .catch(() => {});
          }
        }
        throw err;
      }
      if (
        claimed.outboxEvent?.id &&
        dispatchRes?.action !== 'PREFLIGHT_RETRY_PENDING' &&
        dispatchRes?.action !== 'IN_FLIGHT_PREFLIGHT'
      ) {
        await this.repo['prisma'].outboxEvent
          .updateMany({
            where: { id: claimed.outboxEvent.id, status: 'PENDING' },
            data: { status: 'COMPLETED', processedAt: new Date() },
          })
          .catch(() => {});
      }
      if (dispatchRes?.action === 'PRE_DISPATCH_REJECTED' || dispatchRes?.action === 'BLOCKED_SOURCE_CONFLICT') {
        const latestRejected = await this.repo.findObligationById(obligationId);
        throw new BadRequestException(
          latestRejected?.failureReason ||
            dispatchRes?.reason ||
            'PayOS từ chối yêu cầu chi hoàn tiền hoặc nguồn thu có xung đột trước khi chuyển tiền.',
        );
      }
      if (dispatchRes?.obligation) {
        return dispatchRes.obligation;
      }
      const latest = await this.repo.findObligationById(obligationId);
      return toPaymentRefundObligationDto(latest);
    }

    return toPaymentRefundObligationDto(claimed.obligation);
  }

  /**
   * Executes post-commit PayOS payout dispatch for a previously claimed obligation & attempt.
   * Separates pre-POST preflight GET lookup (attempt stays PREPARING with short lease) from the
   * true POST boundary (DISPATCHING) and re-checks live receipt conflict before any POST.
   */
  async dispatchClaimedAttempt(
    obligationId: bigint,
    attemptId: bigint,
  ): Promise<{ settled: boolean; action?: string; reason?: string; obligation?: any }> {
    const preflight = await this.repo.authorizeAttemptPreflightTx(obligationId, attemptId);

    if (preflight.action === 'ALREADY_SETTLED') {
      return { settled: true, action: preflight.action };
    }
    if (
      preflight.action === 'NOT_FOUND' ||
      preflight.action === 'STALE' ||
      preflight.action === 'ALREADY_FAILED' ||
      preflight.action === 'INVALID_SNAPSHOT' ||
      preflight.action === 'BLOCKED_SOURCE_CONFLICT' ||
      preflight.action === 'IN_FLIGHT_PREFLIGHT'
    ) {
      return {
        settled: false,
        action: preflight.action,
        reason: (preflight as any).reason,
      };
    }
    if (preflight.action === 'RECOVER_PRIOR') {
      return this.reconcileAttempt(obligationId, attemptId);
    }

    if (!this.payosPayoutService) {
      await this.repo.markAttemptFailedAndReleaseTx({
        obligationId,
        attemptId,
        failureReason: 'PayOSPayoutService chưa được cấu hình',
      });
      throw new InternalServerErrorException('PayOSPayoutService chưa sẵn sàng');
    }

    const obl = preflight.obligation;
    const att = preflight.attempt;

    const toBin = normalizeBankBin(obl.targetBankBin);
    if (!toBin || !obl.targetAccountEncrypted || !obl.targetAccountHash) {
      await this.repo.markAttemptFailedAndReleaseTx({
        obligationId,
        attemptId,
        failureReason: 'Snapshot thụ hưởng không hợp lệ (BIN/Encrypted/Hash)',
      });
      throw new BadRequestException('Snapshot tài khoản thụ hưởng không hợp lệ');
    }

    let toAccountNumber = '';
    try {
      toAccountNumber = CryptoVaultUtil.decryptAccountNumber(obl.targetAccountEncrypted).trim();
    } catch (err: any) {
      await this.repo.releaseAttemptPreflightRetryableTx({
        obligationId,
        attemptId,
        reason: `Lỗi giải mã snapshot tài khoản trước gửi: ${err?.message}`,
      });
      throw err;
    }

    if (CryptoVaultUtil.computeDeterministicAccountHash(toAccountNumber) !== obl.targetAccountHash) {
      await this.repo.markAttemptFailedAndReleaseTx({
        obligationId,
        attemptId,
        failureReason: 'Hash tài khoản giải mã không khớp snapshot đã khóa.',
      });
      throw new ConflictException('Hash tài khoản nhận không khớp snapshot.');
    }

    // Check existing provider state by exact payoutReference BEFORE moving to DISPATCHING
    const preLookup = await this.lookupProviderPayoutByReferenceOrId(
      att.payoutReference,
      att.providerPayoutId,
    );
    if (preLookup.indeterminate) {
      await this.repo.releaseAttemptPreflightRetryableTx({
        obligationId,
        attemptId,
        reason: preLookup.reason || 'Pre-dispatch GET lookup tạm thời lỗi trước khi gọi POST',
      });
      return { settled: false, action: 'PREFLIGHT_RETRY_PENDING' };
    }
    if (preLookup.payoutData) {
      return this.applyProviderVerificationResult(obl, att, preLookup.payoutData, att.initiatedByUserId ?? null);
    }

    // Linearization Point (TX Phase 2): re-lock & re-check source conflicts right before POST createPayout
    const dispatchAuth = await this.repo.commitAttemptDispatchingTx(obligationId, attemptId);
    if (dispatchAuth.action === 'ALREADY_SETTLED') {
      return { settled: true, action: dispatchAuth.action };
    }
    if (dispatchAuth.action !== 'DISPATCH') {
      return {
        settled: false,
        action: dispatchAuth.action,
        reason: (dispatchAuth as any).reason,
      };
    }

    const lockedObl = dispatchAuth.obligation;
    const lockedAtt = dispatchAuth.attempt;

    let payoutResult: any;
    try {
      payoutResult = await this.payosPayoutService.createPayout({
        referenceId: lockedAtt.payoutReference,
        amount: Math.round(Number(lockedObl.refundAmount)),
        description: `Hoan tien don ${lockedObl.orderId}`.slice(0, 25),
        toBin,
        toAccountNumber,
      });
    } catch (err: any) {
      const isDefinitePreDispatch =
        !(err instanceof PayOSPayoutIndeterminateException) &&
        err instanceof PayOSPayoutPreDispatchException;

      if (isDefinitePreDispatch) {
        await this.repo.markAttemptFailedAndReleaseTx({
          obligationId,
          attemptId,
          responseCode: err.payosCode,
          failureReason: `PayOS từ chối trước chi: ${err.message}`,
        });
        return { settled: false, action: 'PRE_DISPATCH_REJECTED' };
      }

      // Timeout, crash window, network 5xx or indeterminate AFTER POST entry -> keep exact reference for reconciliation.
      await this.repo.markAttemptPendingReconciliationTx({
        obligationId,
        attemptId,
        responseCode: err?.payosCode || null,
        reason: `Kết quả createPayout chưa xác định: ${err?.message || 'Timeout/Error'}`,
      });
      return { settled: false, action: 'PENDING_RECONCILIATION' };
    }

    const returnedPayoutId = payoutResult?.data?.id ? String(payoutResult.data.id).trim() : null;
    return this.applyProviderVerificationResult(
      lockedObl,
      { ...lockedAtt, providerPayoutId: returnedPayoutId || lockedAtt.providerPayoutId },
      payoutResult?.data || null,
      lockedAtt.initiatedByUserId ?? null,
    );
  }

  /**
   * Reconciles an attempt (or completes preflight+dispatch if a prior GET pre-lookup failed before POST).
   */
  async reconcileAttempt(obligationId: bigint, attemptId: bigint, actorUserId?: bigint | null) {
    const obl = await this.repo.findObligationById(obligationId);
    if (!obl) throw new NotFoundException('Không tìm thấy nghĩa vụ hoàn tiền');
    if (obl.status === 'REFUNDED') {
      return { settled: true, obligation: toPaymentRefundObligationDto(obl) };
    }

    const att = obl.payoutAttempts?.find((a: any) => BigInt(a.attemptId) === attemptId);
    if (!att) throw new NotFoundException('Không tìm thấy lượt chi trả payout');
    if (att.status === 'FAILED') {
      return { settled: false, obligation: toPaymentRefundObligationDto(obl) };
    }
    if (att.status === 'PREPARING' && att.dispatchedAt == null) {
      await this.dispatchClaimedAttempt(obligationId, attemptId);
      const updatedPrep = await this.repo.findObligationById(obligationId);
      return {
        settled: updatedPrep?.status === 'REFUNDED',
        obligation: toPaymentRefundObligationDto(updatedPrep),
      };
    }
    if (!this.payosPayoutService) {
      throw new InternalServerErrorException('PayOSPayoutService chưa sẵn sàng để đối soát');
    }

    const lookup = await this.lookupProviderPayoutByReferenceOrId(
      att.payoutReference,
      att.providerPayoutId,
    );
    if (lookup.indeterminate || !lookup.payoutData) {
      await this.repo.markAttemptPendingReconciliationTx({
        obligationId,
        attemptId,
        reason: lookup.reason || 'Chưa có phản hồi terminal từ PayOS để đối soát',
      });
      const updated = await this.repo.findObligationById(obligationId);
      return { settled: false, obligation: toPaymentRefundObligationDto(updated) };
    }

    return this.applyProviderVerificationResult(
      obl,
      att,
      lookup.payoutData,
      actorUserId ?? att.initiatedByUserId ?? null,
    );
  }

  async syncObligationStatus(obligationIdParam: string | bigint, user?: any) {
    this.assertSuperAdmin(user);
    if (!/^\d+$/.test(String(obligationIdParam))) {
      throw new BadRequestException('Mã nghĩa vụ hoàn tiền không hợp lệ');
    }
    const obligationId = BigInt(obligationIdParam);
    const obl = await this.repo.findObligationById(obligationId);
    if (!obl) throw new NotFoundException('Không tìm thấy nghĩa vụ hoàn tiền');

    if (obl.status === 'REFUNDED') {
      return { settled: true, obligation: toPaymentRefundObligationDto(obl) };
    }
    if (!obl.activePayoutAttemptId) {
      throw new BadRequestException('Nghĩa vụ hoàn tiền chưa có lượt chi trả đang xử lý để đồng bộ.');
    }
    return this.reconcileAttempt(
      obligationId,
      BigInt(obl.activePayoutAttemptId),
      user?.userId ? BigInt(user.userId) : null,
    );
  }

  /**
   * Handles authenticated PayOS Payout Webhook routed from PayoutWebhookController.
   */
  async processSignedPayoutWebhook(signedData: any, desc?: string) {
    const candidateRef =
      signedData?.referenceId ||
      (Array.isArray(signedData?.transactions) && signedData.transactions[0]?.referenceId) ||
      null;

    if (!candidateRef) {
      return { handled: false, success: true, message: 'Missing referenceId' };
    }

    const attempt = await this.repo.findAttemptByPayoutReference(String(candidateRef).trim());
    if (!attempt) {
      return { handled: false };
    }

    const obl = attempt.obligation;
    if (obl.status === 'REFUNDED' || attempt.status === 'SUCCEEDED') {
      return { handled: true, success: true, message: 'Nghĩa vụ hoàn tiền đã tất toán trước đó' };
    }
    if (attempt.status === 'FAILED') {
      return { handled: true, success: true, message: 'Attempt đã ở trạng thái FAILED trước đó' };
    }

    let detailPayout = signedData;
    const hasDetails =
      Array.isArray(detailPayout?.transactions) &&
      detailPayout.transactions.length > 0 &&
      detailPayout.transactions.some((t: any) => t?.id && (t?.toBin || t?.bin) && (t?.toAccountNumber || t?.accountNumberHash));

    if (!hasDetails && this.payosPayoutService && signedData?.id) {
      try {
        const res = await this.payosPayoutService.getPayout(String(signedData.id).trim());
        if (res?.data) {
          detailPayout = res.data;
        }
      } catch (err: any) {
        this.logger.warn(
          `[PaymentRefundsService] Không thể lấy detail PayOS payout ${signedData.id}: ${err?.message}`,
        );
      }
    }

    const res = await this.applyProviderVerificationResult(
      obl,
      attempt,
      detailPayout,
      attempt.initiatedByUserId ?? null,
      desc,
    );

    return {
      handled: true,
      success: true,
      message: res.settled ? 'Đã tất toán hoàn tiền thành công' : 'Đã ghi nhận webhook, giữ chờ đối soát',
      data: res,
    };
  }

  private async lookupProviderPayoutByReferenceOrId(
    payoutReference: string,
    providerPayoutId?: string | null,
  ): Promise<{ payoutData: any | null; indeterminate: boolean; reason?: string }> {
    if (!this.payosPayoutService) {
      return { payoutData: null, indeterminate: true, reason: 'PayOSPayoutService unavailable' };
    }

    if (providerPayoutId) {
      try {
        const res = await this.payosPayoutService.getPayout(String(providerPayoutId).trim());
        if (res?.data?.id) {
          return { payoutData: res.data, indeterminate: false };
        }
        return { payoutData: null, indeterminate: true, reason: 'getPayout thiếu data.id' };
      } catch (err: any) {
        return { payoutData: null, indeterminate: true, reason: err?.message };
      }
    }

    try {
      const listRes = await this.payosPayoutService.getPayouts({ referenceId: payoutReference });
      if (listRes?.code && listRes.code !== '00') {
        return { payoutData: null, indeterminate: true, reason: `getPayouts error code=${listRes.code}` };
      }
      const rawList = Array.isArray(listRes?.data?.payouts)
        ? listRes.data.payouts
        : Array.isArray(listRes?.data)
          ? listRes.data
          : null;
      if (!rawList) {
        return { payoutData: null, indeterminate: true, reason: 'getPayouts response invalid shape' };
      }
      const matched = rawList.filter((p: any) => {
        if (String(p?.referenceId || p?.reference || '').trim() === payoutReference) {
          return true;
        }
        return (
          Array.isArray(p?.transactions) &&
          p.transactions.some((t: any) => String(t?.referenceId || '').trim() === payoutReference)
        );
      });
      if (matched.length > 1) {
        return {
          payoutData: null,
          indeterminate: true,
          reason: `Phát hiện ${matched.length} payout trùng reference ${payoutReference}`,
        };
      }
      if (matched.length === 1) {
        const matchedId = matched[0]?.id ? String(matched[0].id).trim() : '';
        if (!matchedId) {
          return { payoutData: null, indeterminate: true, reason: 'Payout lookup item thiếu data.id' };
        }
        const detail = await this.payosPayoutService.getPayout(matchedId);
        if (detail?.data?.id) {
          return { payoutData: detail.data, indeterminate: false };
        }
        return { payoutData: null, indeterminate: true, reason: 'getPayout detail thiếu data.id' };
      }
      return { payoutData: null, indeterminate: false };
    } catch (err: any) {
      return { payoutData: null, indeterminate: true, reason: err?.message };
    }
  }

  private async applyProviderVerificationResult(
    obl: any,
    att: any,
    payoutData: any,
    settledByUserId: bigint | null,
    desc?: string,
  ) {
    const providerPayoutId = payoutData?.id ? String(payoutData.id).trim() : att.providerPayoutId;
    if (!payoutData) {
      await this.repo.markAttemptPendingReconciliationTx({
        obligationId: BigInt(obl.obligationId),
        attemptId: BigInt(att.attemptId),
        providerPayoutId,
        reason: 'Phản hồi PayOS không chứa payload detail',
      });
      const latest = await this.repo.findObligationById(BigInt(obl.obligationId));
      return { settled: false, obligation: toPaymentRefundObligationDto(latest) };
    }

    const criteria = {
      amount: Math.round(Number(obl.refundAmount)),
      payoutReference: att.payoutReference,
      targetBankBin: normalizeBankBin(obl.targetBankBin),
      targetAccountHash: obl.targetAccountHash,
      expectedPayoutId: att.providerPayoutId || undefined,
    };

    const successVerif = verifyPayosPayoutEvidence(payoutData, criteria);
    if (successVerif.isVerified) {
      // Fail-closed: detail transaction ID must be present so global voucher uniqueness can lock it
      if (!successVerif.matchedTxId || !successVerif.matchedTxId.trim()) {
        await this.repo.markAttemptPendingReconciliationTx({
          obligationId: BigInt(obl.obligationId),
          attemptId: BigInt(att.attemptId),
          providerPayoutId: successVerif.providerPayoutId,
          reason: 'Thiếu providerTransactionId (matchedTxId) trong chi tiết payout để bảo vệ chống tái sử dụng chứng từ.',
        });
        const latest = await this.repo.findObligationById(BigInt(obl.obligationId));
        return { settled: false, obligation: toPaymentRefundObligationDto(latest) };
      }

      const settled = await this.repo.settleRefundSuccessAtomicTx({
        obligationId: BigInt(obl.obligationId),
        attemptId: BigInt(att.attemptId),
        providerPayoutId: successVerif.providerPayoutId,
        providerTransactionId: successVerif.matchedTxId.trim(),
        payoutReference: att.payoutReference,
        verifiedAmount: successVerif.reportedAmount,
        settledByUserId,
      });

      await this.emitSettlementSideEffects(obl, settled.obligation);
      return { settled: true, obligation: toPaymentRefundObligationDto(settled.obligation) };
    }

    const rejectionVerif = verifyPayosPayoutRejectionEvidence(payoutData, criteria);
    if (rejectionVerif.isVerified) {
      await this.repo.markAttemptFailedAndReleaseTx({
        obligationId: BigInt(obl.obligationId),
        attemptId: BigInt(att.attemptId),
        providerPayoutId: rejectionVerif.providerPayoutId,
        failureReason: desc || rejectionVerif.reason || 'PayOS Payout thất bại xác thực',
        allowFromReconcile: true,
      });
      const latest = await this.repo.findObligationById(BigInt(obl.obligationId));
      return { settled: false, obligation: toPaymentRefundObligationDto(latest) };
    }

    await this.repo.markAttemptPendingReconciliationTx({
      obligationId: BigInt(obl.obligationId),
      attemptId: BigInt(att.attemptId),
      providerPayoutId,
      reason: successVerif.reason || rejectionVerif.reason || 'Đang chờ PayOS tất toán hoàn tất',
    });
    const latest = await this.repo.findObligationById(BigInt(obl.obligationId));
    return { settled: false, obligation: toPaymentRefundObligationDto(latest) };
  }

  private async emitSettlementSideEffects(prevObl: any, settledObl: any) {
    try {
      const order = settledObl?.order || prevObl?.order;
      if (!order) return;
      if (order.customerId && this.notificationsService) {
        const custProfile = await this.repo['prisma'].customerProfile.findUnique({
          where: { customerId: BigInt(order.customerId) },
          select: { userId: true },
        });
        if (custProfile?.userId) {
          await this.notificationsService
            .createAndDispatchNotification({
              userId: custProfile.userId,
              type: 'ORDER_REFUNDED',
              title: 'Hoàn tiền đơn hàng thành công',
              body: `Khoản hoàn ${Number(settledObl.refundAmount).toLocaleString('vi-VN')} VND cho đơn hàng #${order.orderCode} đã được chi trả thành công.`,
              data: {
                orderId: order.orderId.toString(),
                orderCode: order.orderCode,
                obligationId: settledObl.obligationId.toString(),
                refundAmount: Number(settledObl.refundAmount),
              },
              idempotencyKey: `payment_refund_obl:${settledObl.obligationId.toString()}:refunded`,
            })
            .catch(() => {});
        }
      }
      if (this.eventsGateway && order.storeId) {
        const eventPayload = {
          orderId: order.orderId.toString(),
          obligationId: settledObl.obligationId.toString(),
          orderPaymentStatus: order.paymentStatus,
        };
        this.eventsGateway.emitToStore(order.storeId.toString(), 'ORDER_REFUNDED', eventPayload);
        if (order.customerId) {
          this.eventsGateway.emitToCustomer(
            order.customerId.toString(),
            'ORDER_REFUNDED',
            eventPayload,
          );
        }
      }
    } catch {
      // Side effects never roll back committed refund settlement
    }
  }
}
