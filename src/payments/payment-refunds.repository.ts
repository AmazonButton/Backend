import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { normalizeBankBin } from '../common/utils/bank-identifier.util';
import { CryptoVaultUtil } from '../common/utils/crypto-vault.util';
import { runWithTransactionRetry } from '../common/utils/transaction-retry.util';
import { InboundPaymentSourceMeta } from './payment-source-evidence.util';

export type ReceiptClassification =
  | 'ORDER_PAYMENT'
  | 'LATE_CANCELLED_OR_COD'
  | 'EXCESS_DUPLICATE'
  | 'LEGACY_UNCLASSIFIED';

export type ObligationType =
  | 'ORDER_REFUND'
  | 'EXCESS_DUPLICATE'
  | 'LEGACY_UNCLASSIFIED';

export type RecipientVerificationStatus =
  | 'VERIFIED_MATCHED_SOURCE'
  | 'GUEST_UNVERIFIED'
  | 'SOURCE_INSUFFICIENT'
  | 'SOURCE_CONFLICTING'
  | 'CUSTOMER_NO_VERIFIED_BANK'
  | 'LEGACY_UNCLASSIFIED';

function accountMatchesReceiptHash(bankAcc: any, receiptSourceHash: string): boolean {
  if (!bankAcc || !receiptSourceHash) return false;
  if (bankAcc.accountNumberHash === receiptSourceHash) return true;
  if (bankAcc.accountNumberEncrypted) {
    try {
      const decrypted = CryptoVaultUtil.decryptAccountNumber(bankAcc.accountNumberEncrypted);
      if (CryptoVaultUtil.computeDeterministicAccountHash(decrypted) === receiptSourceHash) {
        return true;
      }
      if (CryptoVaultUtil.hashAccountNumber(decrypted) === receiptSourceHash) {
        return true;
      }
    } catch {
      return false;
    }
  }
  return false;
}

@Injectable()
export class PaymentRefundsRepository {
  constructor(private readonly prisma: PrismaService) { }

  async findReceiptByProviderRef(
    provider: string,
    channel: string,
    providerTransactionRef: string,
  ) {
    if (!providerTransactionRef) return null;
    return this.prisma.paymentOrderReceipt.findUnique({
      where: {
        provider_channel_providerTransactionRef: {
          provider,
          channel,
          providerTransactionRef,
        },
      },
      include: { refundObligation: true },
    });
  }

  async findAttemptByPayoutReference(payoutReference: string) {
    if (!payoutReference) return null;
    return this.prisma.paymentRefundPayoutAttempt.findUnique({
      where: {
        payoutProvider_payoutReference: {
          payoutProvider: 'PAYOS',
          payoutReference,
        },
      },
      include: { obligation: { include: { receipt: true, order: true } } },
    });
  }

  async findObligationById(obligationId: bigint) {
    return this.prisma.paymentRefundObligation.findUnique({
      where: { obligationId },
      include: {
        receipt: true,
        order: true,
        payoutAttempts: { orderBy: { attemptNumber: 'desc' } },
        verifiedVoucher: true,
      },
    });
  }

  async findObligationsForOrder(orderId: bigint) {
    return this.prisma.paymentRefundObligation.findMany({
      where: { orderId },
      include: {
        receipt: true,
        payoutAttempts: { orderBy: { attemptNumber: 'desc' } },
        verifiedVoucher: true,
      },
      orderBy: { obligationId: 'asc' },
    });
  }

  async listObligations(params: {
    page?: number;
    pageSize?: number;
    status?: string;
    orderId?: bigint;
  }) {
    const page = Math.max(1, Number(params.page) || 1);
    const pageSize = Math.min(Math.max(1, Number(params.pageSize) || 20), 100);
    const where: Prisma.PaymentRefundObligationWhereInput = {};
    if (params.status) where.status = params.status;
    if (params.orderId) where.orderId = params.orderId;

    const [items, total] = await Promise.all([
      this.prisma.paymentRefundObligation.findMany({
        where,
        include: {
          receipt: true,
          order: { select: { orderId: true, orderCode: true, orderStatus: true, paymentStatus: true, customerId: true, storeId: true } },
          payoutAttempts: { orderBy: { attemptNumber: 'desc' }, take: 5 },
          verifiedVoucher: true,
        },
        orderBy: { obligationId: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.paymentRefundObligation.count({ where }),
    ]);

    return { items, total, page, pageSize };
  }

  /**
   * Evaluates recipient eligibility inside a transaction where `order` & `receipt` are already locked.
   * Never defaults to an arbitrary VERIFIED account when source proof is missing or contradictory,
   * and strictly keeps guest orders (customerId == null) unverified for auto-payout.
   */
  async evaluateRecipientEligibilityInTx(
    tx: any,
    params: {
      order: { orderId: bigint; customerId: bigint | null };
      receipt: any;
      preferredBankAccountId?: bigint | null;
    },
  ): Promise<{
    eligibleStatus: 'READY_FOR_PAYOUT' | 'PENDING_RECIPIENT_VERIFICATION';
    recipientVerificationStatus: RecipientVerificationStatus;
    verificationNote: string;
    matchedBankAccount: any | null;
    targetBankBin: string | null;
    targetAccountEncrypted: string | null;
    targetAccountHash: string | null;
    targetAccountMasked: string | null;
    targetAccountName: string | null;
  }> {
    const { order, receipt, preferredBankAccountId } = params;
    const customerId = order.customerId != null ? BigInt(order.customerId) : null;

    if (!customerId) {
      return {
        eligibleStatus: 'PENDING_RECIPIENT_VERIFICATION',
        recipientVerificationStatus: 'GUEST_UNVERIFIED',
        verificationNote: 'Đơn hàng guest chưa xác minh chủ sở hữu khoản thanh toán; giữ chờ đối soát thủ công.',
        matchedBankAccount: null,
        targetBankBin: null,
        targetAccountEncrypted: null,
        targetAccountHash: null,
        targetAccountMasked: null,
        targetAccountName: null,
      };
    }

    if (receipt.sourceEvidenceStatus === 'CONFLICTING') {
      return {
        eligibleStatus: 'PENDING_RECIPIENT_VERIFICATION',
        recipientVerificationStatus: 'SOURCE_CONFLICTING',
        verificationNote: 'Bằng chứng tài khoản nguồn thanh toán có mâu thuẫn; cần SUPER_ADMIN đối soát.',
        matchedBankAccount: null,
        targetBankBin: null,
        targetAccountEncrypted: null,
        targetAccountHash: null,
        targetAccountMasked: null,
        targetAccountName: null,
      };
    }

    const sourceBin = normalizeBankBin(receipt.sourceBankBin);
    if (receipt.sourceEvidenceStatus !== 'SUFFICIENT' || !sourceBin || !receipt.sourceAccountHash) {
      return {
        eligibleStatus: 'PENDING_RECIPIENT_VERIFICATION',
        recipientVerificationStatus: 'SOURCE_INSUFFICIENT',
        verificationNote: `Chứng từ tài khoản chuyển tiền chưa đủ để hoàn tự động (${receipt.sourceEvidenceStatus}).`,
        matchedBankAccount: null,
        targetBankBin: null,
        targetAccountEncrypted: null,
        targetAccountHash: null,
        targetAccountMasked: null,
        targetAccountName: null,
      };
    }

    const verifiedAccounts = await tx.customerBankAccount.findMany({
      where: {
        customerId,
        verificationStatus: 'VERIFIED',
      },
      orderBy: [{ isDefault: 'desc' }, { id: 'asc' }],
    });

    if (!verifiedAccounts || verifiedAccounts.length === 0) {
      return {
        eligibleStatus: 'PENDING_RECIPIENT_VERIFICATION',
        recipientVerificationStatus: 'CUSTOMER_NO_VERIFIED_BANK',
        verificationNote: 'Khách hàng chưa có tài khoản ngân hàng VERIFIED trùng với nguồn thanh toán.',
        matchedBankAccount: null,
        targetBankBin: null,
        targetAccountEncrypted: null,
        targetAccountHash: null,
        targetAccountMasked: null,
        targetAccountName: null,
      };
    }

    const matchedAccounts = verifiedAccounts.filter((acc: any) => {
      const accBin = normalizeBankBin(acc.bankBin);
      return accBin !== null && accBin === sourceBin && accountMatchesReceiptHash(acc, receipt.sourceAccountHash);
    });

    if (matchedAccounts.length === 0) {
      return {
        eligibleStatus: 'PENDING_RECIPIENT_VERIFICATION',
        recipientVerificationStatus: 'SOURCE_CONFLICTING',
        verificationNote: 'Tài khoản chuyển tiền từ PayOS không khớp với tài khoản ngân hàng VERIFIED của khách hàng.',
        matchedBankAccount: null,
        targetBankBin: null,
        targetAccountEncrypted: null,
        targetAccountHash: null,
        targetAccountMasked: null,
        targetAccountName: null,
      };
    }

    const selected = matchedAccounts[0];
    if (preferredBankAccountId != null && BigInt(selected.id) !== BigInt(preferredBankAccountId)) {
      throw new BadRequestException(
        'Không được chọn tài khoản nhận khác với tài khoản VERIFIED đã khớp nguồn thanh toán của đơn hàng.',
      );
    }

    const decryptedAcc = CryptoVaultUtil.decryptAccountNumber(selected.accountNumberEncrypted);
    const deterministicHash = CryptoVaultUtil.computeDeterministicAccountHash(decryptedAcc);
    const targetAccountEncrypted = CryptoVaultUtil.encryptAccountNumber(decryptedAcc);
    const targetAccountMasked = selected.accountNumberMasked || CryptoVaultUtil.maskAccountNumber(decryptedAcc);

    return {
      eligibleStatus: 'READY_FOR_PAYOUT',
      recipientVerificationStatus: 'VERIFIED_MATCHED_SOURCE',
      verificationNote: 'Đã xác minh khách hàng sở hữu đơn và tài khoản VERIFIED khớp tài khoản nguồn.',
      matchedBankAccount: selected,
      targetBankBin: sourceBin,
      targetAccountEncrypted,
      targetAccountHash: deterministicHash,
      targetAccountMasked,
      targetAccountName: selected.accountName,
    };
  }

  /**
   * Inserts a unique money receipt into `payment_order_receipts` inside an active TX (orders already locked).
   * Detects conflicting replay payloads sharing `(provider, channel, providerTransactionRef)` without
   * dropping already-recorded valid funds, and spawns an obligation when immediately refundable.
   */
  async reconcileLegacyBackfillReceiptInTx(
    tx: any,
    params: {
      receipt: any;
      order: any;
      payment: any;
      inbound: InboundPaymentSourceMeta;
    },
  ) {
    const providerTransactionRef = params.inbound.providerTransactionRef!.trim();
    const updatedReceipt = await tx.paymentOrderReceipt.update({
      where: { receiptId: BigInt(params.receipt.receiptId) },
      data: {
        channel: 'ORDER_PAYMENT_LINK',
        providerTransactionRef,
        paymentLinkId:
          params.inbound.paymentLinkId ??
          params.payment?.payment_link_id ??
          params.receipt.paymentLinkId ??
          null,
        sourceBankRaw: params.inbound.sourceBankRaw ?? params.receipt.sourceBankRaw ?? null,
        sourceBankBin: params.inbound.sourceBankBin ?? params.receipt.sourceBankBin ?? null,
        sourceAccountMasked:
          params.inbound.sourceAccountMasked ?? params.receipt.sourceAccountMasked ?? null,
        sourceAccountHash:
          params.inbound.sourceAccountHash ?? params.receipt.sourceAccountHash ?? null,
        sourceAccountEncrypted:
          params.inbound.sourceAccountEncrypted ?? params.receipt.sourceAccountEncrypted ?? null,
        sourceAccountName:
          params.inbound.sourceAccountName ?? params.receipt.sourceAccountName ?? null,
        sourceEvidenceStatus:
          params.inbound.sourceEvidenceStatus || params.receipt.sourceEvidenceStatus || 'MISSING',
        rawPayloadChecksum:
          params.inbound.rawPayloadChecksum ?? params.receipt.rawPayloadChecksum ?? null,
        receivedAt: params.inbound.receivedAt || params.receipt.receivedAt || new Date(),
      },
      include: { refundObligation: true },
    });

    if (
      updatedReceipt.refundObligation &&
      updatedReceipt.refundObligation.snapshotLockedAt == null &&
      updatedReceipt.refundObligation.status === 'PENDING_RECIPIENT_VERIFICATION'
    ) {
      await tx.paymentRefundObligation.update({
        where: { obligationId: updatedReceipt.refundObligation.obligationId },
        data: {
          verificationNote: `Đã liên kết chứng từ PayOS (${providerTransactionRef}) vào bản ghi backfill lịch sử; giữ chờ SUPER_ADMIN xác minh trước chi.`.slice(
            0,
            500,
          ),
        },
      });
    }

    return updatedReceipt;
  }

  async recordReceiptAndMaybeObligationInTx(
    tx: any,
    params: {
      order: {
        order_id: bigint;
        customer_id: bigint | null;
        order_status?: string;
        payment_status?: string;
        payment_method?: string;
      };
      payment: {
        payment_transaction_id: bigint;
        amount: any;
        payment_link_id?: string | null;
        transaction_code?: string | null;
      };
      classification: ReceiptClassification;
      inbound?: InboundPaymentSourceMeta | null;
      quarantineReason?: string | null;
      skipObligationCreation?: boolean;
      obligationTypeOverride?: ObligationType;
    },
  ) {
    const provider = 'PAYOS';
    const channel = 'ORDER_PAYMENT_LINK';
    const orderId = BigInt(params.order.order_id);
    const customerId = params.order.customer_id != null ? BigInt(params.order.customer_id) : null;
    const paymentTransactionId = BigInt(params.payment.payment_transaction_id);

    const amountNum =
      params.inbound?.amount && params.inbound.amount > 0
        ? Number(params.inbound.amount)
        : Number(params.payment.amount);

    const providerTransactionRef =
      params.inbound?.providerTransactionRef?.trim() ||
      `PAYOS_TX_${paymentTransactionId.toString()}`;

    const existing = await tx.paymentOrderReceipt.findUnique({
      where: {
        provider_channel_providerTransactionRef: {
          provider,
          channel,
          providerTransactionRef,
        },
      },
      include: { refundObligation: true },
    });

    if (existing) {
      const amountConflict = Math.round(Number(existing.amount)) !== Math.round(amountNum);
      const binConflict = Boolean(
        params.inbound?.sourceBankBin &&
        existing.sourceBankBin &&
        params.inbound.sourceBankBin !== existing.sourceBankBin,
      );
      const accConflict = Boolean(
        params.inbound?.sourceAccountHash &&
        existing.sourceAccountHash &&
        params.inbound.sourceAccountHash !== existing.sourceAccountHash,
      );
      const hasConflict = amountConflict || binConflict || accConflict;

      if (hasConflict) {
        await tx.paymentOrderReceipt.update({
          where: { receiptId: existing.receiptId },
          data: { sourceEvidenceStatus: 'CONFLICTING' },
        });
        if (existing.refundObligation && existing.refundObligation.status !== 'REFUNDED') {
          const oblId = BigInt(existing.refundObligation.obligationId);
          const inFlightPostAttempts = await tx.paymentRefundPayoutAttempt.count({
            where: {
              obligationId: oblId,
              status: { in: ['DISPATCHING', 'PENDING_RECONCILIATION'] },
            },
          });

          if (inFlightPostAttempts === 0) {
            await tx.paymentRefundPayoutAttempt.updateMany({
              where: { obligationId: oblId, status: 'PREPARING' },
              data: {
                status: 'FAILED',
                reconciledAt: new Date(),
                failureReason: 'SOURCE_CONFLICTING_DISCOVERED_BEFORE_DISPATCH',
              },
            });
            await tx.paymentRefundObligation.update({
              where: { obligationId: oblId },
              data: {
                status: 'PENDING_RECIPIENT_VERIFICATION',
                activePayoutAttemptId: null,
                recipientVerificationStatus: 'SOURCE_CONFLICTING',
                verificationNote: 'Phát hiện xung đột thông tin chứng từ thu tiền trên cùng mã giao dịch.',
              },
            });
          } else {
            await tx.paymentRefundObligation.update({
              where: { obligationId: oblId },
              data: {
                recipientVerificationStatus: 'SOURCE_CONFLICTING',
                verificationNote:
                  'Phát hiện xung đột chứng từ nguồn trong khi attempt đang đối soát sau gửi.',
              },
            });
          }
        }
      }

      return {
        receipt: existing,
        obligation: existing.refundObligation || null,
        created: false,
        conflict: hasConflict,
      };
    }

    const receipt = await tx.paymentOrderReceipt.create({
      data: {
        orderId,
        paymentTransactionId,
        provider,
        channel,
        providerTransactionRef,
        paymentLinkId: params.inbound?.paymentLinkId ?? params.payment.payment_link_id ?? null,
        amount: new Prisma.Decimal(amountNum),
        currency: params.inbound?.currency || 'VND',
        classification: params.classification,
        sourceBankRaw: params.inbound?.sourceBankRaw ?? null,
        sourceBankBin: params.inbound?.sourceBankBin ?? null,
        sourceAccountMasked: params.inbound?.sourceAccountMasked ?? null,
        sourceAccountHash: params.inbound?.sourceAccountHash ?? null,
        sourceAccountEncrypted: params.inbound?.sourceAccountEncrypted ?? null,
        sourceAccountName: params.inbound?.sourceAccountName ?? null,
        sourceEvidenceStatus: params.inbound?.sourceEvidenceStatus || 'MISSING',
        rawPayloadChecksum: params.inbound?.rawPayloadChecksum ?? null,
        receivedAt: params.inbound?.receivedAt || new Date(),
      },
    });

    if (params.classification === 'ORDER_PAYMENT' || params.skipObligationCreation) {
      return { receipt, obligation: null, created: true, conflict: false };
    }

    const obligationType: ObligationType =
      params.obligationTypeOverride ||
      (params.classification === 'EXCESS_DUPLICATE' ? 'EXCESS_DUPLICATE' : 'ORDER_REFUND');

    const obligation = await this.createObligationForReceiptInTx(tx, {
      order: { orderId, customerId },
      receipt,
      sourcePaymentTransactionId: paymentTransactionId,
      obligationType,
      quarantineReason: params.quarantineReason,
    });

    return { receipt, obligation, created: true, conflict: false };
  }

  async createObligationForReceiptInTx(
    tx: any,
    params: {
      order: { orderId: bigint; customerId: bigint | null };
      receipt: any;
      sourcePaymentTransactionId?: bigint | null;
      obligationType: ObligationType;
      quarantineReason?: string | null;
    },
  ) {
    const existing = await tx.paymentRefundObligation.findUnique({
      where: { receiptId: BigInt(params.receipt.receiptId) },
    });
    if (existing) return existing;

    if (params.quarantineReason) {
      return tx.paymentRefundObligation.create({
        data: {
          orderId: BigInt(params.order.orderId),
          sourcePaymentTransactionId:
            params.sourcePaymentTransactionId ?? params.receipt.paymentTransactionId ?? null,
          receiptId: BigInt(params.receipt.receiptId),
          obligationType: params.obligationType,
          refundAmount: params.receipt.amount,
          currency: params.receipt.currency || 'VND',
          status: 'PENDING_RECIPIENT_VERIFICATION',
          recipientVerificationStatus: 'LEGACY_UNCLASSIFIED',
          verificationNote: params.quarantineReason.slice(0, 500),
        },
      });
    }

    const evalRes = await this.evaluateRecipientEligibilityInTx(tx, {
      order: params.order,
      receipt: params.receipt,
    });

    return tx.paymentRefundObligation.create({
      data: {
        orderId: BigInt(params.order.orderId),
        sourcePaymentTransactionId:
          params.sourcePaymentTransactionId ?? params.receipt.paymentTransactionId ?? null,
        receiptId: BigInt(params.receipt.receiptId),
        obligationType: params.obligationType,
        refundAmount: params.receipt.amount,
        currency: params.receipt.currency || 'VND',
        status: evalRes.eligibleStatus,
        recipientVerificationStatus: evalRes.recipientVerificationStatus,
        verificationNote: evalRes.verificationNote,
        customerBankAccountId: evalRes.matchedBankAccount?.id ?? null,
        targetBankBin: evalRes.targetBankBin,
        targetAccountEncrypted: evalRes.targetAccountEncrypted,
        targetAccountHash: evalRes.targetAccountHash,
        targetAccountMasked: evalRes.targetAccountMasked,
        targetAccountName: evalRes.targetAccountName,
      },
    });
  }

  /**
   * Ensures every refundable ORDER_PAYMENT / LATE_CANCELLED_OR_COD receipt on a cancelled/rejected order
   * creates a tracked PaymentRefundObligation inside the same transaction.
   */
  async ensureOrderRefundObligationsForCancelledOrderInTx(tx: any, orderId: bigint) {
    const orderRows: any[] = await tx.$queryRawUnsafe(
      `SELECT order_id, customer_id, order_status, payment_status, payment_method
       FROM orders WHERE order_id = $1 FOR UPDATE`,
      orderId,
    );
    const order = orderRows?.[0];
    if (!order) return [];

    if (
      order.payment_status !== 'REFUND_PENDING' &&
      !['CANCELLED', 'REJECTED', 'DELIVERY_FAILED'].includes(order.order_status)
    ) {
      return [];
    }

    const receipts = await tx.paymentOrderReceipt.findMany({
      where: {
        orderId,
        classification: { in: ['ORDER_PAYMENT', 'LATE_CANCELLED_OR_COD'] },
      },
      include: { refundObligation: true },
      orderBy: { receiptId: 'asc' },
    });

    const createdOrExisting: any[] = [];
    for (const r of receipts) {
      if (r.refundObligation) {
        createdOrExisting.push(r.refundObligation);
      } else {
        const obl = await this.createObligationForReceiptInTx(tx, {
          order: {
            orderId,
            customerId: order.customer_id != null ? BigInt(order.customer_id) : null,
          },
          receipt: r,
          sourcePaymentTransactionId: r.paymentTransactionId,
          obligationType: 'ORDER_REFUND',
        });
        createdOrExisting.push(obl);
      }
    }
    return createdOrExisting;
  }

  /**
   * Step 1 (Atomic TX): Verify recipient eligibility + conservation budget, lock immutable target snapshot,
   * claim obligation as PROCESSING_PAYOUT, create fixed-reference attempt row & enqueue OutboxEvent.
   */
  async claimObligationForPayoutTx(
    obligationId: bigint,
    initiatedByUserId?: bigint | null,
    options?: { customerBankAccountId?: bigint | null; note?: string },
  ) {
    return runWithTransactionRetry(
      () =>
        this.prisma.$transaction(async (tx) => {
          const refRows = await tx.$queryRawUnsafe<any[]>(
            `SELECT obligation_id, order_id FROM payment_refund_obligations WHERE obligation_id = $1`,
            obligationId,
          );
          if (!refRows || refRows.length === 0) {
            throw new NotFoundException(`Không tìm thấy nghĩa vụ hoàn tiền #${obligationId}`);
          }
          const orderId = BigInt(refRows[0].order_id);

          // Canonical Lock Order: orders -> payment_order_receipts -> payment_refund_obligations -> attempts
          const lockedOrders = await tx.$queryRawUnsafe<any[]>(
            `SELECT * FROM orders WHERE order_id = $1 FOR UPDATE`,
            orderId,
          );
          const order = lockedOrders?.[0];
          if (!order) throw new NotFoundException('Không tìm thấy đơn hàng tương ứng');

          const lockedObls = await tx.$queryRawUnsafe<any[]>(
            `SELECT * FROM payment_refund_obligations WHERE obligation_id = $1 FOR UPDATE`,
            obligationId,
          );
          const lockedObl = lockedObls?.[0];
          if (!lockedObl) throw new NotFoundException('Không tìm thấy nghĩa vụ hoàn tiền');

          const lockedReceipt = await tx.paymentOrderReceipt.findUnique({
            where: { receiptId: BigInt(lockedObl.receipt_id) },
          });
          if (!lockedReceipt) throw new NotFoundException('Thiếu chứng từ khoản thu nguồn của nghĩa vụ');

          if (lockedObl.status === 'REFUNDED') {
            return {
              alreadySettled: true,
              obligation: await this.findObligationByIdInTx(tx, obligationId),
              attempt: null,
              outboxEvent: null,
            };
          }
          if (lockedObl.status === 'CANCELLED') {
            throw new BadRequestException('Nghĩa vụ hoàn tiền đã bị hủy.');
          }
          if (
            lockedObl.status === 'PROCESSING_PAYOUT' ||
            lockedObl.status === 'PENDING_RECONCILIATION' ||
            lockedObl.active_payout_attempt_id != null
          ) {
            throw new ConflictException(
              `Nghĩa vụ hoàn #${obligationId} đang có lượt chi trả xử lý hoặc chờ đối soát (${lockedObl.status}).`,
            );
          }

          const inFlightAttempts = await tx.$queryRawUnsafe<any[]>(
            `SELECT attempt_id, status FROM payment_refund_payout_attempts
             WHERE obligation_id = $1 AND status IN ('PREPARING', 'DISPATCHING', 'PENDING_RECONCILIATION')
             FOR UPDATE`,
            obligationId,
          );
          if (inFlightAttempts && inFlightAttempts.length > 0) {
            throw new ConflictException(
              `Đã tồn tại attempt đang xử lý (#${inFlightAttempts[0].attempt_id}) cho nghĩa vụ #${obligationId}.`,
            );
          }

          // Double-spend guard: never disburse ORDER_REFUND if store wallet already credited ORDER_REVENUE
          if (lockedObl.obligation_type === 'ORDER_REFUND') {
            const revenueRows = await tx.$queryRawUnsafe<any[]>(
              `SELECT transaction_id FROM wallet_transactions WHERE type = 'ORDER_REVENUE' AND reference_id = $1 LIMIT 1`,
              `ORDER:${orderId.toString()}`,
            );
            if (revenueRows && revenueRows.length > 0) {
              throw new ConflictException(
                `Đơn hàng #${orderId} đã cộng doanh thu vào ví cửa hàng; không thể giải ngân hoàn tiền ORDER_REFUND.`,
              );
            }
          }

          // Re-verify recipient eligibility strictly BEFORE first/new dispatch
          const evalRes = await this.evaluateRecipientEligibilityInTx(tx, {
            order: {
              orderId,
              customerId: order.customer_id != null ? BigInt(order.customer_id) : null,
            },
            receipt: lockedReceipt,
            preferredBankAccountId: options?.customerBankAccountId ?? null,
          });

          if (evalRes.eligibleStatus !== 'READY_FOR_PAYOUT' || !evalRes.targetBankBin || !evalRes.targetAccountEncrypted || !evalRes.targetAccountHash) {
            if (lockedObl.snapshot_locked_at == null) {
              await tx.paymentRefundObligation.update({
                where: { obligationId },
                data: {
                  status: 'PENDING_RECIPIENT_VERIFICATION',
                  recipientVerificationStatus: evalRes.recipientVerificationStatus,
                  verificationNote: evalRes.verificationNote,
                },
              });
            }
            throw new BadRequestException({
              success: false,
              code: evalRes.recipientVerificationStatus,
              message: evalRes.verificationNote,
            });
          }

          // Enforce snapshot immutability if already locked from a prior failed pre-dispatch attempt
          let snapshotData: any = {};
          if (lockedObl.snapshot_locked_at != null) {
            if (
              lockedObl.target_bank_bin !== evalRes.targetBankBin ||
              lockedObl.target_account_hash !== evalRes.targetAccountHash
            ) {
              throw new ConflictException(
                'Snapshot tài khoản nhận đã khóa mâu thuẫn với thông tin ngân hàng hiện tại.',
              );
            }
          } else {
            snapshotData = {
              customerBankAccountId: evalRes.matchedBankAccount?.id ?? null,
              targetBankBin: evalRes.targetBankBin,
              targetAccountEncrypted: evalRes.targetAccountEncrypted,
              targetAccountHash: evalRes.targetAccountHash,
              targetAccountMasked: evalRes.targetAccountMasked,
              targetAccountName: evalRes.targetAccountName,
              snapshotLockedAt: new Date(),
            };
          }

          const attemptsCount = await tx.paymentRefundPayoutAttempt.count({
            where: { obligationId },
          });
          const attemptNumber = attemptsCount + 1;
          const suffix = crypto.randomBytes(3).toString('hex').toUpperCase();
          const payoutReference = `PAYREF_O${obligationId}_A${attemptNumber}_${suffix}`.slice(0, 64);

          const attempt = await tx.paymentRefundPayoutAttempt.create({
            data: {
              obligationId,
              attemptNumber,
              payoutProvider: 'PAYOS',
              payoutReference,
              status: 'PREPARING',
              initiatedByUserId: initiatedByUserId ?? null,
            },
          });

          await tx.paymentRefundObligation.update({
            where: { obligationId },
            data: {
              status: 'PROCESSING_PAYOUT',
              recipientVerificationStatus: evalRes.recipientVerificationStatus,
              verificationNote: options?.note
                ? `${evalRes.verificationNote} | ${options.note}`.slice(0, 500)
                : evalRes.verificationNote,
              activePayoutAttemptId: attempt.attemptId,
              failureReason: null,
              ...snapshotData,
            },
          });

          const outboxEvent = await tx.outboxEvent.create({
            data: {
              eventType: 'PAYMENT_REFUND_PAYOUT',
              status: 'PENDING',
              payload: {
                obligationId: obligationId.toString(),
                attemptId: attempt.attemptId.toString(),
                orderId: orderId.toString(),
                payoutReference,
                initiatedByUserId: initiatedByUserId ? initiatedByUserId.toString() : null,
              },
            },
          });

          return {
            alreadySettled: false,
            obligation: await this.findObligationByIdInTx(tx, obligationId),
            attempt,
            outboxEvent,
          };
        }),
      { operationName: 'claimObligationForPayoutTx' },
    );
  }

  private async evaluateLockedAttemptForDispatchInTx(
    tx: Prisma.TransactionClient,
    obligationId: bigint,
    attemptId: bigint,
    mode: 'PREFLIGHT' | 'DISPATCH',
  ) {
    const refRows: any[] = await tx.$queryRawUnsafe(
      `SELECT obligation_id, order_id, receipt_id FROM payment_refund_obligations WHERE obligation_id = $1`,
      obligationId,
    );
    const ref = refRows?.[0];
    if (!ref) {
      return { action: 'NOT_FOUND' as const };
    }

    const orderId = BigInt(ref.order_id);
    const receiptId = BigInt(ref.receipt_id);

    // Canonical Lock Order: orders -> payment_order_receipts -> payment_refund_obligations -> attempts
    const orders: any[] = await tx.$queryRawUnsafe(
      `SELECT * FROM orders WHERE order_id = $1 FOR UPDATE`,
      orderId,
    );
    const order = orders?.[0];

    const receipts: any[] = await tx.$queryRawUnsafe(
      `SELECT * FROM payment_order_receipts WHERE receipt_id = $1 FOR UPDATE`,
      receiptId,
    );
    const receipt = receipts?.[0];

    const obls: any[] = await tx.$queryRawUnsafe(
      `SELECT * FROM payment_refund_obligations WHERE obligation_id = $1 FOR UPDATE`,
      obligationId,
    );
    const obl = obls?.[0];

    const atts: any[] = await tx.$queryRawUnsafe(
      `SELECT * FROM payment_refund_payout_attempts WHERE attempt_id = $1 FOR UPDATE`,
      attemptId,
    );
    const att = atts?.[0];

    if (!order || !receipt || !obl || !att) {
      return { action: 'NOT_FOUND' as const };
    }
    if (obl.status === 'REFUNDED' || att.status === 'SUCCEEDED') {
      return { action: 'ALREADY_SETTLED' as const, obligation: obl, attempt: att };
    }
    if (
      BigInt(att.obligation_id) !== obligationId ||
      obl.active_payout_attempt_id == null ||
      BigInt(obl.active_payout_attempt_id) !== attemptId
    ) {
      return { action: 'STALE' as const, obligation: obl, attempt: att };
    }
    if (att.status === 'FAILED') {
      return { action: 'ALREADY_FAILED' as const, obligation: obl, attempt: att };
    }

    // If POST createPayout may already have been sent, NEVER abandon — always reconcile prior attempt.
    if (
      att.status === 'DISPATCHING' ||
      att.status === 'PENDING_RECONCILIATION' ||
      att.dispatched_at != null
    ) {
      await tx.paymentRefundPayoutAttempt.update({
        where: { attemptId },
        data: {
          status: 'PENDING_RECONCILIATION',
          nextReconcileAt: new Date(),
        },
      });
      await tx.paymentRefundObligation.update({
        where: { obligationId },
        data: { status: 'PENDING_RECONCILIATION' },
      });
      return { action: 'RECOVER_PRIOR' as const, obligation: obl, attempt: att };
    }

    // Check immutable beneficiary snapshot completeness before preflight/POST
    if (
      !obl.target_bank_bin ||
      !obl.target_account_encrypted ||
      !obl.target_account_hash ||
      !obl.target_account_masked ||
      !obl.target_account_name ||
      !obl.snapshot_locked_at
    ) {
      await tx.paymentRefundPayoutAttempt.update({
        where: { attemptId },
        data: { status: 'FAILED', failureReason: 'MISSING_IMMUTABLE_SNAPSHOT', reconciledAt: new Date() },
      });
      await tx.paymentRefundObligation.update({
        where: { obligationId },
        data: {
          status: 'PENDING_RECIPIENT_VERIFICATION',
          activePayoutAttemptId: null,
          failureReason: 'MISSING_IMMUTABLE_SNAPSHOT',
        },
      });
      return { action: 'INVALID_SNAPSHOT' as const, obligation: obl, attempt: att };
    }

    // Re-evaluate live source evidence & beneficiary verification strictly before dispatching POST
    const evalRes = await this.evaluateRecipientEligibilityInTx(tx, {
      order: {
        orderId,
        customerId: order.customer_id != null ? BigInt(order.customer_id) : null,
      },
      receipt: {
        sourceEvidenceStatus: receipt.source_evidence_status,
        sourceBankBin: receipt.source_bank_bin,
        sourceAccountHash: receipt.source_account_hash,
      },
    });

    const sourceConflict =
      receipt.source_evidence_status === 'CONFLICTING' ||
      obl.status === 'PENDING_RECIPIENT_VERIFICATION' ||
      obl.status === 'CANCELLED' ||
      obl.recipient_verification_status === 'SOURCE_CONFLICTING' ||
      evalRes.eligibleStatus !== 'READY_FOR_PAYOUT' ||
      evalRes.targetBankBin !== obl.target_bank_bin ||
      evalRes.targetAccountHash !== obl.target_account_hash;

    if (sourceConflict) {
      const reason =
        receipt.source_evidence_status === 'CONFLICTING' ||
          obl.recipient_verification_status === 'SOURCE_CONFLICTING'
          ? 'SOURCE_CONFLICTING_DISCOVERED_BEFORE_DISPATCH'
          : `PRE_DISPATCH_ELIGIBILITY_BLOCKED:${evalRes.recipientVerificationStatus}`;

      await tx.paymentRefundPayoutAttempt.update({
        where: { attemptId },
        data: {
          status: 'FAILED',
          failureReason: reason.slice(0, 500),
          reconciledAt: new Date(),
        },
      });
      await tx.paymentRefundObligation.update({
        where: { obligationId },
        data: {
          status: 'PENDING_RECIPIENT_VERIFICATION',
          activePayoutAttemptId: null,
          recipientVerificationStatus:
            receipt.source_evidence_status === 'CONFLICTING'
              ? 'SOURCE_CONFLICTING'
              : evalRes.recipientVerificationStatus,
          verificationNote: evalRes.verificationNote,
          failureReason: reason.slice(0, 500),
        },
      });
      return {
        action: 'BLOCKED_SOURCE_CONFLICT' as const,
        reason,
        obligation: await this.findObligationByIdInTx(tx, obligationId),
        attempt: await tx.paymentRefundPayoutAttempt.findUnique({ where: { attemptId } }),
      };
    }

    if (mode === 'PREFLIGHT') {
      if (att.next_reconcile_at && new Date(att.next_reconcile_at).getTime() > Date.now()) {
        return {
          action: 'IN_FLIGHT_PREFLIGHT' as const,
          reason: 'PREFLIGHT_LEASE_ACTIVE',
          obligation: obl,
          attempt: att,
        };
      }

      await tx.paymentRefundPayoutAttempt.update({
        where: { attemptId },
        data: {
          nextReconcileAt: new Date(Date.now() + 30_000),
        },
      });

      return {
        action: 'PREFLIGHT' as const,
        obligation: await this.findObligationByIdInTx(tx, obligationId),
        attempt: await tx.paymentRefundPayoutAttempt.findUnique({ where: { attemptId } }),
      };
    }

    await tx.paymentRefundPayoutAttempt.update({
      where: { attemptId },
      data: {
        status: 'DISPATCHING',
        dispatchedAt: new Date(),
        nextReconcileAt: null,
      },
    });

    return {
      action: 'DISPATCH' as const,
      obligation: await this.findObligationByIdInTx(tx, obligationId),
      attempt: await tx.paymentRefundPayoutAttempt.findUnique({ where: { attemptId } }),
    };
  }

  /**
   * Step 2a-preflight: Lock canonical hierarchy and reserve a short lease while KEEPING
   * `status = 'PREPARING'` and `dispatchedAt = NULL` prior to the PayOS GET lookup.
   */
  async authorizeAttemptPreflightTx(obligationId: bigint, attemptId: bigint) {
    return runWithTransactionRetry(
      () =>
        this.prisma.$transaction((tx) =>
          this.evaluateLockedAttemptForDispatchInTx(tx, obligationId, attemptId, 'PREFLIGHT'),
        ),
      { operationName: 'authorizeAttemptPreflightTx' },
    );
  }

  /**
   * Releases the preflight lease after a transient pre-POST GET failure WITHOUT transitioning
   * the unsent attempt into PENDING_RECONCILIATION, so retry recovery can safely re-run preflight.
   */
  async releaseAttemptPreflightRetryableTx(params: {
    obligationId: bigint;
    attemptId: bigint;
    reason?: string | null;
  }) {
    return runWithTransactionRetry(
      () =>
        this.prisma.$transaction(async (tx) => {
          const refRows = await tx.$queryRawUnsafe<any[]>(
            `SELECT order_id FROM payment_refund_obligations WHERE obligation_id = $1`,
            params.obligationId,
          );
          if (!refRows?.[0]) return null;
          await tx.$queryRawUnsafe<any[]>(
            `SELECT order_id FROM orders WHERE order_id = $1 FOR UPDATE`,
            BigInt(refRows[0].order_id),
          );
          const obls = await tx.$queryRawUnsafe<any[]>(
            `SELECT obligation_id, status, active_payout_attempt_id FROM payment_refund_obligations WHERE obligation_id = $1 FOR UPDATE`,
            params.obligationId,
          );
          const atts = await tx.$queryRawUnsafe<any[]>(
            `SELECT attempt_id, status, dispatched_at FROM payment_refund_payout_attempts WHERE attempt_id = $1 FOR UPDATE`,
            params.attemptId,
          );
          const obl = obls?.[0];
          const att = atts?.[0];
          if (!obl || !att) return null;
          if (att.status !== 'PREPARING' || att.dispatched_at != null) {
            return this.findObligationByIdInTx(tx, params.obligationId);
          }

          await tx.paymentRefundPayoutAttempt.update({
            where: { attemptId: params.attemptId },
            data: {
              nextReconcileAt: null,
              reconcileAttempts: { increment: 1 },
              failureReason: params.reason ? params.reason.slice(0, 500) : undefined,
            },
          });
          return this.findObligationByIdInTx(tx, params.obligationId);
        }),
      { operationName: 'releaseAttemptPreflightRetryableTx' },
    );
  }

  /**
   * Step 2b (True POST Linearization Point TX right before PayOS createPayout call).
   * Re-locks and re-checks live receipt conflicts right before flipping status to DISPATCHING.
   */
  async commitAttemptDispatchingTx(obligationId: bigint, attemptId: bigint) {
    return runWithTransactionRetry(
      () =>
        this.prisma.$transaction((tx) =>
          this.evaluateLockedAttemptForDispatchInTx(tx, obligationId, attemptId, 'DISPATCH'),
        ),
      { operationName: 'commitAttemptDispatchingTx' },
    );
  }

  /**
   * Step 2a (Linearization Point TX right before PayOS createPayout call).
   * Kept as a safe delegate to `commitAttemptDispatchingTx`.
   */
  async authorizeAttemptDispatchTx(obligationId: bigint, attemptId: bigint) {
    return this.commitAttemptDispatchingTx(obligationId, attemptId);
  }

  async markAttemptPendingReconciliationTx(params: {
    obligationId: bigint;
    attemptId: bigint;
    providerPayoutId?: string | null;
    responseCode?: string | null;
    reason?: string | null;
    nextReconcileAt?: Date;
  }) {
    return runWithTransactionRetry(
      () =>
        this.prisma.$transaction(async (tx) => {
          const obls = await tx.$queryRawUnsafe<any[]>(
            `SELECT obligation_id, status, active_payout_attempt_id FROM payment_refund_obligations WHERE obligation_id = $1 FOR UPDATE`,
            params.obligationId,
          );
          const obl = obls?.[0];
          const atts = await tx.$queryRawUnsafe<any[]>(
            `SELECT attempt_id, status, provider_payout_id FROM payment_refund_payout_attempts WHERE attempt_id = $1 FOR UPDATE`,
            params.attemptId,
          );
          const att = atts?.[0];
          if (!obl || !att) return null;
          if (obl.status === 'REFUNDED' || att.status === 'SUCCEEDED' || att.status === 'FAILED') {
            return this.findObligationByIdInTx(tx, params.obligationId);
          }

          await tx.paymentRefundPayoutAttempt.update({
            where: { attemptId: params.attemptId },
            data: {
              status: 'PENDING_RECONCILIATION',
              ...(params.providerPayoutId && !att.provider_payout_id
                ? { providerPayoutId: params.providerPayoutId.trim() }
                : {}),
              ...(params.responseCode ? { responseCode: params.responseCode } : {}),
              failureReason: params.reason ? params.reason.slice(0, 500) : undefined,
              nextReconcileAt: params.nextReconcileAt || new Date(Date.now() + 15_000),
              reconcileAttempts: { increment: 1 },
            },
          });

          await tx.paymentRefundObligation.update({
            where: { obligationId: params.obligationId },
            data: {
              status: 'PENDING_RECONCILIATION',
              failureReason: params.reason ? params.reason.slice(0, 500) : undefined,
            },
          });

          return this.findObligationByIdInTx(tx, params.obligationId);
        }),
      { operationName: 'markAttemptPendingReconciliationTx' },
    );
  }

  async markAttemptFailedAndReleaseTx(params: {
    obligationId: bigint;
    attemptId: bigint;
    providerPayoutId?: string | null;
    responseCode?: string | null;
    failureReason: string;
    allowFromReconcile?: boolean;
  }) {
    return runWithTransactionRetry(
      () =>
        this.prisma.$transaction(async (tx) => {
          const obls = await tx.$queryRawUnsafe<any[]>(
            `SELECT * FROM payment_refund_obligations WHERE obligation_id = $1 FOR UPDATE`,
            params.obligationId,
          );
          const obl = obls?.[0];
          const atts = await tx.$queryRawUnsafe<any[]>(
            `SELECT * FROM payment_refund_payout_attempts WHERE attempt_id = $1 FOR UPDATE`,
            params.attemptId,
          );
          const att = atts?.[0];
          if (!obl || !att) return null;

          if (obl.status === 'REFUNDED' || att.status === 'SUCCEEDED') {
            throw new ConflictException('Không thể đánh dấu FAILED cho giao dịch đã hoàn tất REFUNDED.');
          }
          if (att.status === 'PENDING_RECONCILIATION' && !params.allowFromReconcile) {
            return this.findObligationByIdInTx(tx, params.obligationId);
          }

          await tx.paymentRefundPayoutAttempt.update({
            where: { attemptId: params.attemptId },
            data: {
              status: 'FAILED',
              ...(params.providerPayoutId && !att.provider_payout_id
                ? { providerPayoutId: params.providerPayoutId.trim() }
                : {}),
              responseCode: params.responseCode?.slice(0, 64) || null,
              failureReason: params.failureReason.slice(0, 500),
              reconciledAt: new Date(),
            },
          });

          await tx.paymentRefundObligation.update({
            where: { obligationId: params.obligationId },
            data: {
              status: 'READY_FOR_PAYOUT',
              activePayoutAttemptId: null,
              failureReason: params.failureReason.slice(0, 500),
            },
          });

          return this.findObligationByIdInTx(tx, params.obligationId);
        }),
      { operationName: 'markAttemptFailedAndReleaseTx' },
    );
  }

  /**
   * Atomically settles a verified payout across:
   * - `payment_refund_verified_vouchers` (enforcing global uniqueness of provider_transaction_id & (provider_payout_id, payout_reference))
   * - `payment_refund_payout_attempts` (SUCCEEDED)
   * - `payment_refund_obligations` (REFUNDED)
   * - `payment_transaction` (only transitions non-active REFUND_PENDING/refunded source tx without corrupting valid PAID tx on same link!)
   * - `orders` (sets payment_status = REFUNDED only when ORDER_REFUND/LATE/LEGACY obligations settle, never touching PAID order on EXCESS_DUPLICATE)
   */
  async settleRefundSuccessAtomicTx(params: {
    obligationId: bigint;
    attemptId: bigint;
    providerPayoutId: string;
    providerTransactionId: string;
    payoutReference: string;
    verifiedAmount: number;
    settledByUserId?: bigint | null;
    note?: string;
  }) {
    if (!params.providerPayoutId?.trim() || !params.providerTransactionId?.trim() || !params.payoutReference?.trim()) {
      throw new BadRequestException(
        'Thiếu định danh chứng từ payout xác thực (providerPayoutId, providerTransactionId hoặc payoutReference).',
      );
    }

    return runWithTransactionRetry(
      () =>
        this.prisma.$transaction(async (tx) => {
          const refRows = await tx.$queryRawUnsafe<any[]>(
            `SELECT obligation_id, order_id FROM payment_refund_obligations WHERE obligation_id = $1`,
            params.obligationId,
          );
          if (!refRows || refRows.length === 0) {
            throw new NotFoundException(`Không tìm thấy nghĩa vụ hoàn tiền #${params.obligationId}`);
          }
          const orderId = BigInt(refRows[0].order_id);

          // Canonical lock order: orders -> obligations -> attempts -> payment_transaction
          const lockedOrders = await tx.$queryRawUnsafe<any[]>(
            `SELECT * FROM orders WHERE order_id = $1 FOR UPDATE`,
            orderId,
          );
          const order = lockedOrders?.[0];
          if (!order) throw new NotFoundException('Không tìm thấy đơn hàng');

          const lockedObls = await tx.$queryRawUnsafe<any[]>(
            `SELECT * FROM payment_refund_obligations WHERE obligation_id = $1 FOR UPDATE`,
            params.obligationId,
          );
          const obl = lockedObls?.[0];
          const lockedAtts = await tx.$queryRawUnsafe<any[]>(
            `SELECT * FROM payment_refund_payout_attempts WHERE attempt_id = $1 FOR UPDATE`,
            params.attemptId,
          );
          const att = lockedAtts?.[0];
          if (!obl || !att) throw new NotFoundException('Không tìm thấy nghĩa vụ hoặc attempt');

          if (BigInt(att.obligation_id) !== params.obligationId) {
            throw new BadRequestException('Attempt không thuộc về nghĩa vụ hoàn tiền này');
          }

          if (obl.status === 'REFUNDED') {
            if (obl.settled_attempt_id != null && BigInt(obl.settled_attempt_id) === params.attemptId) {
              const existingVoucher = await tx.paymentRefundVerifiedVoucher.findUnique({
                where: { obligationId: params.obligationId },
              });
              if (
                existingVoucher &&
                existingVoucher.providerTransactionId === params.providerTransactionId.trim() &&
                existingVoucher.providerPayoutId === params.providerPayoutId.trim()
              ) {
                return {
                  alreadySettled: true,
                  obligation: await this.findObligationByIdInTx(tx, params.obligationId),
                  orderPaymentStatus: order.payment_status,
                };
              }
            }
            throw new ConflictException(
              `Nghĩa vụ hoàn tiền #${params.obligationId} đã được tất toán bởi chứng từ khác.`,
            );
          }

          if (att.status === 'FAILED') {
            throw new ConflictException(
              `CRITICAL_PAYOUT_CONFLICT: Không thể tất toán attempt #${params.attemptId} vì đã ở trạng thái FAILED.`,
            );
          }
          if (att.payout_reference !== params.payoutReference.trim()) {
            throw new ConflictException(
              `Payout reference không khớp (attempt=${att.payout_reference}, verified=${params.payoutReference}).`,
            );
          }
          if (Math.round(Number(obl.refund_amount)) !== Math.round(Number(params.verifiedAmount))) {
            throw new ConflictException(
              `Số tiền chứng từ (${params.verifiedAmount}) không khớp nghĩa vụ (${obl.refund_amount}).`,
            );
          }
          if (!obl.target_bank_bin || !obl.target_account_hash) {
            throw new ConflictException('Thiếu snapshot tài khoản nhận trên nghĩa vụ.');
          }

          // Insert global verified voucher; DB unique indexes forbid ANY cross-obligation voucher reuse
          try {
            await tx.paymentRefundVerifiedVoucher.create({
              data: {
                payoutProvider: att.payout_provider || 'PAYOS',
                providerPayoutId: params.providerPayoutId.trim(),
                providerTransactionId: params.providerTransactionId.trim(),
                payoutReference: params.payoutReference.trim(),
                obligationId: params.obligationId,
                attemptId: params.attemptId,
                verifiedAmount: new Prisma.Decimal(params.verifiedAmount),
                targetBankBin: obl.target_bank_bin,
                targetAccountHash: obl.target_account_hash,
              },
            });
          } catch (voucherErr: any) {
            if (voucherErr?.code === 'P2002') {
              throw new ConflictException(
                'Chứng từ giao dịch chi trả (providerTransactionId hoặc payoutReference) đã được dùng để tất toán một nghĩa vụ khác.',
              );
            }
            throw voucherErr;
          }

          try {
            await tx.paymentRefundPayoutAttempt.update({
              where: { attemptId: params.attemptId },
              data: {
                status: 'SUCCEEDED',
                providerPayoutId: params.providerPayoutId.trim(),
                providerTransactionId: params.providerTransactionId.trim(),
                responseCode: '00',
                reconciledAt: new Date(),
                failureReason: null,
              },
            });
          } catch (attErr: any) {
            if (attErr?.code === 'P2002') {
              throw new ConflictException(
                'Định danh giao dịch chi trả providerTransactionId đã tồn tại trên lượt chi khác.',
              );
            }
            throw attErr;
          }

          const now = new Date();
          await tx.paymentRefundObligation.update({
            where: { obligationId: params.obligationId },
            data: {
              status: 'REFUNDED',
              activePayoutAttemptId: null,
              settledAttemptId: params.attemptId,
              settledByUserId: params.settledByUserId ?? att.initiated_by_user_id ?? null,
              refundedAt: now,
              failureReason: null,
            },
          });

          // Lock & evaluate parent PaymentTransaction ONLY if all obligations on that tx are settled
          // AND this settlement is NOT an excess duplicate riding on an active PAID primary tx.
          if (obl.source_payment_transaction_id != null) {
            const sourceTxId = BigInt(obl.source_payment_transaction_id);
            const [lockedPt] = await tx.$queryRawUnsafe<any[]>(
              `SELECT * FROM payment_transaction WHERE payment_transaction_id = $1 FOR UPDATE`,
              sourceTxId,
            );
            if (lockedPt && lockedPt.status !== 'REFUNDED') {
              const receiptsOnTx = await tx.paymentOrderReceipt.findMany({
                where: { paymentTransactionId: sourceTxId },
                include: { refundObligation: true },
              });
              const hasActiveUnrefundedOrderReceipt = receiptsOnTx.some(
                (r: any) =>
                  r.classification === 'ORDER_PAYMENT' &&
                  (!r.refundObligation || r.refundObligation.status !== 'REFUNDED'),
              );
              const hasOpenObligationOnTx = receiptsOnTx.some(
                (r: any) =>
                  r.refundObligation &&
                  !['REFUNDED', 'CANCELLED'].includes(r.refundObligation.status),
              );
              const hasSettledObligationOnTx = receiptsOnTx.some(
                (r: any) => r.refundObligation?.status === 'REFUNDED',
              );

              const shouldMarkTxRefunded =
                !hasOpenObligationOnTx &&
                !hasActiveUnrefundedOrderReceipt &&
                (lockedPt.status === 'REFUND_PENDING' || hasSettledObligationOnTx);

              if (shouldMarkTxRefunded) {
                await tx.paymentTransaction.update({
                  where: { paymentTransactionId: sourceTxId },
                  data: { status: 'REFUNDED' },
                });
              }
            }
          }

          // Conditionally mark Order.paymentStatus = REFUNDED when this obligation is an ORDER_REFUND
          // (or LEGACY_UNCLASSIFIED when order is REFUND_PENDING) and no non-excess order obligations remain open.
          let nextOrderPaymentStatus = order.payment_status;
          const isCompletedOrDeliveredCod =
            order.payment_method === 'COD' &&
            ['DELIVERED', 'COMPLETED'].includes(order.order_status) &&
            order.payment_status === 'PAID';
          if (
            obl.obligation_type !== 'EXCESS_DUPLICATE' &&
            order.payment_status === 'REFUND_PENDING' &&
            !isCompletedOrDeliveredCod
          ) {
            const remainingOpenMainObls = await tx.paymentRefundObligation.count({
              where: {
                orderId,
                obligationType: { in: ['ORDER_REFUND', 'LEGACY_UNCLASSIFIED'] },
                status: { notIn: ['REFUNDED', 'CANCELLED'] },
              },
            });
            const unrefundedOrderReceipts = await tx.paymentOrderReceipt.count({
              where: {
                orderId,
                classification: { in: ['ORDER_PAYMENT', 'LATE_CANCELLED_OR_COD'] },
                OR: [
                  { refundObligation: { is: null } },
                  { refundObligation: { is: { status: { not: 'REFUNDED' } } } },
                ],
              },
            });

            if (remainingOpenMainObls === 0 && unrefundedOrderReceipts === 0) {
              await tx.order.update({
                where: { orderId },
                data: { paymentStatus: 'REFUNDED' },
              });
              nextOrderPaymentStatus = 'REFUNDED';
            }
          }

          await tx.orderStatusHistory.create({
            data: {
              orderId,
              oldStatus: order.order_status,
              newStatus: order.order_status,
              changedByUserId: params.settledByUserId ?? null,
              reason:
                params.note ||
                `Xác nhận hoàn tiền thành công #${params.obligationId} (${obl.obligation_type}) qua PayOS Payout ${params.providerPayoutId.trim()} [TX:${params.providerTransactionId.trim()}]`,
            },
          });

          return {
            alreadySettled: false,
            obligation: await this.findObligationByIdInTx(tx, params.obligationId),
            orderPaymentStatus: nextOrderPaymentStatus,
          };
        }),
      { operationName: 'settleRefundSuccessAtomicTx' },
    );
  }

  async findPendingReconciliationAttempts(limit = 10) {
    const safeLimit = Math.max(1, Math.min(50, Number(limit) || 10));
    return this.prisma.paymentRefundPayoutAttempt.findMany({
      where: {
        OR: [
          {
            status: 'PENDING_RECONCILIATION',
            OR: [{ nextReconcileAt: null }, { nextReconcileAt: { lte: new Date() } }],
          },
          {
            // Crash recovery: DISPATCHING left orphaned > 15s
            status: 'DISPATCHING',
            updatedAt: { lte: new Date(Date.now() - 15_000) },
          },
          {
            // Retryable preflight failure (GET lookup error before POST): recover once lease clears
            status: 'PREPARING',
            dispatchedAt: null,
            reconcileAttempts: { gt: 0 },
            OR: [{ nextReconcileAt: null }, { nextReconcileAt: { lte: new Date() } }],
          },
          {
            // Crash recovery: PREPARING left orphaned if Outbox never picked it up
            status: 'PREPARING',
            createdAt: { lte: new Date(Date.now() - 60_000) },
          },
        ],
      },
      include: {
        obligation: { include: { receipt: true, order: true } },
      },
      orderBy: { attemptId: 'asc' },
      take: safeLimit,
    });
  }

  private async findObligationByIdInTx(tx: any, obligationId: bigint) {
    return tx.paymentRefundObligation.findUnique({
      where: { obligationId },
      include: {
        receipt: true,
        order: true,
        payoutAttempts: { orderBy: { attemptNumber: 'desc' } },
        verifiedVoucher: true,
      },
    });
  }
}
