import { EventsGateway } from '../websocket/events.gateway';
import {
  Injectable,
  HttpException,
  HttpStatus,
  BadRequestException,
  ConflictException,
  NotFoundException,
  InternalServerErrorException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { PaymentsRepository } from './payments.repository';
import { CreatePaymentLinkDto, PayosWebhookDto } from './dto/payment.dto';
import { signPaymentRequest, verifyWebhookSignature } from './payos.helper';
import { Optional, Inject, forwardRef } from '@nestjs/common';
import { BillingChargesService } from '../billing-charges/billing-charges.service';
import { CustomerBankPennyVerificationService } from '../customers/customer-bank-penny-verification.service';
import { BankVerificationService } from '../bank-verification/bank-verification.service';
import { storeCashEnabled } from '../store-cash/store-cash-settlement.transaction';
import { PaymentRefundsService } from './payment-refunds.service';
import { extractInboundPaymentSourceEvidence } from './payment-source-evidence.util';

import { NotificationsService } from '../notifications/notifications.service';
import { ChangePaymentMethodDto } from './dto/change-payment-method.dto';
import { RefundExcessPaymentDto } from './dto/refund-excess-payment.dto';

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly paymentsRepo: PaymentsRepository,
    @Optional() @Inject(EventsGateway) private readonly eventsGateway?: EventsGateway,
    @Optional() @Inject(NotificationsService) private readonly notificationsService?: NotificationsService,
    @Optional() @Inject(forwardRef(() => BillingChargesService)) private readonly billingChargesService?: BillingChargesService,
    @Optional() @Inject(forwardRef(() => CustomerBankPennyVerificationService)) private readonly customerBankPennyService?: CustomerBankPennyVerificationService,
    @Optional() @Inject(forwardRef(() => BankVerificationService)) private readonly bankVerificationService?: BankVerificationService,
    @Optional() @Inject(forwardRef(() => PaymentRefundsService)) private readonly paymentRefundsService?: PaymentRefundsService,
  ) {}

  async createPayosPaymentLink(dto: CreatePaymentLinkDto, userOrUserId?: any) {
    const rawOrderId = BigInt(dto.orderId);
    const userId = typeof userOrUserId === 'object' && userOrUserId?.userId ? BigInt(userOrUserId.userId) : (typeof userOrUserId === 'bigint' ? userOrUserId : undefined);
    const userRole = typeof userOrUserId === 'object' ? userOrUserId?.role : undefined;
    const userStoreId = typeof userOrUserId === 'object' ? userOrUserId?.storeId : undefined;

    const clientId = process.env.PAYOS_CLIENT_ID?.trim();
    const apiKey = process.env.PAYOS_API_KEY?.trim();
    const checksumKey = process.env.PAYOS_CHECKSUM_KEY?.trim();

    if (!clientId || !apiKey || !checksumKey) {
      throw new InternalServerErrorException({
        success: false,
        code: 'PAYOS_CONFIG_MISSING',
        message: 'Chưa cấu hình đầy đủ PAYOS_CLIENT_ID, PAYOS_API_KEY, PAYOS_CHECKSUM_KEY trong server .env',
      });
    }

    // Khóa đơn hàng FOR UPDATE trước khi kiểm tra trạng thái và tạo giao dịch PENDING
    const orderCode = Math.floor(Date.now() / 1000) * 1000 + Math.floor(Math.random() * 1000);

    let checkedResult: any;
    try {
      checkedResult = await this.paymentsRepo.createPendingTransactionCheckedTx({
        orderId: rawOrderId,
        userId,
        userRole,
        userStoreId,
        transactionCode: orderCode.toString(),
        paymentMethod: 'QR',
      });
    } catch (createErr: any) {
      if (createErr.code === 'P2002' || createErr.message?.includes('uq_payment_active_per_order')) {
        // Bounded retry loop (wait up to 2 seconds for winner to finish calling PayOS and persisting link)
        for (let attempt = 0; attempt < 8; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          const recheck = await this.paymentsRepo.findTransactionsByOrderId(rawOrderId);
          const activeTx = recheck?.find((tx: any) => tx.status === 'PENDING' && tx.paymentLinkId);
          if (activeTx) {
            return {
              success: true,
              message: 'Đơn hàng đã có liên kết thanh toán đang chờ xử lý',
              data: {
                paymentTransactionId: activeTx.paymentTransactionId.toString(),
                orderCode: Number(activeTx.transactionCode),
                checkoutUrl: (activeTx as any).checkoutUrl || `https://pay.payos.vn/web/${activeTx.paymentLinkId}`,
                paymentLinkId: activeTx.paymentLinkId,
                amount: Number(activeTx.amount),
                status: 'PENDING',
              },
            };
          }
          const paidTx = recheck?.find((tx: any) => tx.status === 'PAID');
          if (paidTx) {
            throw new BadRequestException({
              success: false,
              code: 'ORDER_ALREADY_PAID',
              message: 'Đơn hàng này đã được thanh toán thành công',
            });
          }
          const hasPendingWithoutLink = recheck?.some((tx: any) => tx.status === 'PENDING');
          if (!hasPendingWithoutLink) {
            throw new ConflictException({
              success: false,
              code: 'PAYMENT_TRANSACTION_CANCELLED',
              message: 'Yêu cầu thanh toán đang khởi tạo đã bị hủy hoặc đổi phương thức thanh toán',
            });
          }
        }
        throw new HttpException(
          {
            success: true,
            statusCode: 202,
            code: 'PAYMENT_LINK_CREATING',
            message: 'Liên kết thanh toán đang được khởi tạo, vui lòng thử lại sau giây lát',
          },
          HttpStatus.ACCEPTED,
        );
      }
      throw createErr;
    }

    if (checkedResult.reusedActiveLink) {
      const existingActive = checkedResult.transaction;
      return {
        success: true,
        message: 'Đơn hàng đã có liên kết thanh toán đang chờ xử lý',
        data: {
          paymentTransactionId: existingActive.paymentTransactionId.toString(),
          orderCode: Number(existingActive.transactionCode),
          checkoutUrl: (existingActive as any).checkoutUrl || `https://pay.payos.vn/web/${existingActive.paymentLinkId}`,
          paymentLinkId: existingActive.paymentLinkId,
          amount: Number(existingActive.amount),
          status: 'PENDING',
        },
      };
    }

    const transaction = checkedResult.transaction;
    const orderAmount = checkedResult.orderAmount;
    const description = (dto.description || `DH${checkedResult.orderCode || rawOrderId}`).slice(0, 25);
    const returnUrl = dto.returnUrl || process.env.PAYOS_RETURN_URL || 'http://localhost:3000/payment/success';
    const cancelUrl = dto.cancelUrl || process.env.PAYOS_CANCEL_URL || 'http://localhost:3000/payment/cancel';

    const signature = signPaymentRequest(
      {
        amount: orderAmount,
        cancelUrl,
        description,
        orderCode,
        returnUrl,
      },
      checksumKey,
    );

    // Support local test mock
    if (process.env.PAYOS_MOCK_PAYMENT === 'true' || clientId === 'mock_client_id' || clientId?.startsWith('ci_test_')) {
      const mockPaymentLinkId = `mock_link_${orderCode}`;
      const mockCheckoutUrl = `https://pay.payos.vn/web/mock-${orderCode}`;
      const mockQrCode = `00020101021238540010A000000727012600069704220112${orderCode}`;
      await this.persistLinkOrCancelOnRace({
        orderId: rawOrderId,
        paymentTransactionId: transaction.paymentTransactionId,
        paymentLinkId: mockPaymentLinkId,
        checkoutUrl: mockCheckoutUrl,
        qrCode: mockQrCode,
      });
      return {
        success: true,
        message: 'Tạo link thanh toán PayOS thành công (mock)',
        data: {
          paymentTransactionId: transaction.paymentTransactionId.toString(),
          orderCode,
          amount: orderAmount,
          description,
          checkoutUrl: mockCheckoutUrl,
          qrCode: mockQrCode,
          paymentLinkId: mockPaymentLinkId,
          currency: 'VND',
          status: 'PENDING',
        },
      };
    }

    try {
      const response = await fetch('https://api-merchant.payos.vn/v2/payment-requests', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-client-id': clientId,
          'x-api-key': apiKey,
        },
        body: JSON.stringify({
          orderCode,
          amount: orderAmount,
          description,
          cancelUrl,
          returnUrl,
          signature,
        }),
      });

      const result = await response.json();

      if (result.code !== '00') {
        this.logger.error(`PayOS API error: ${result.desc || JSON.stringify(result)}`);
        await this.paymentsRepo.markTransactionFailedIfPendingAtomicTx(transaction.paymentTransactionId);
        throw new BadRequestException({
          success: false,
          code: 'PAYOS_CREATION_FAILED',
          message: result.desc || 'Không thể tạo link thanh toán PayOS',
        });
      }

      if (!result.data?.paymentLinkId) {
        this.logger.error(`PayOS API response missing paymentLinkId: ${JSON.stringify(result)}`);
        await this.paymentsRepo.markTransactionFailedIfPendingAtomicTx(transaction.paymentTransactionId);
        throw new BadRequestException({
          success: false,
          code: 'PAYOS_CREATION_FAILED',
          message: 'PayOS không trả về paymentLinkId hợp lệ để đối soát webhook',
        });
      }

      // Point 6: Verify all PayOS response fields against internal data
      if (Number(result.data?.orderCode) !== orderCode) {
        this.logger.error(`PayOS orderCode mismatch: expected ${orderCode}, got ${result.data?.orderCode}`);
        await this.paymentsRepo.markTransactionFailedIfPendingAtomicTx(transaction.paymentTransactionId);
        throw new BadRequestException({
          success: false,
          code: 'PAYOS_RESPONSE_MISMATCH',
          message: 'Mã orderCode trong phản hồi từ PayOS không khớp với đơn hàng nội bộ',
        });
      }

      if (Number(result.data?.amount) !== orderAmount) {
        this.logger.error(`PayOS amount mismatch: expected ${orderAmount}, got ${result.data?.amount}`);
        await this.paymentsRepo.markTransactionFailedIfPendingAtomicTx(transaction.paymentTransactionId);
        throw new BadRequestException({
          success: false,
          code: 'PAYOS_RESPONSE_MISMATCH',
          message: 'Số tiền trong phản hồi từ PayOS không khớp với đơn hàng nội bộ',
        });
      }

      if (!result.data?.currency || typeof result.data.currency !== 'string' || result.data.currency !== 'VND') {
        this.logger.error(`PayOS currency invalid or missing: expected VND, got ${result.data?.currency}`);
        await this.paymentsRepo.markTransactionFailedIfPendingAtomicTx(transaction.paymentTransactionId);
        throw new BadRequestException({
          success: false,
          code: 'PAYOS_RESPONSE_MISMATCH',
          message: 'Đơn vị tiền tệ trong phản hồi từ PayOS không hợp lệ hoặc không phải VND',
        });
      }

      if (typeof result.data?.paymentLinkId !== 'string' || typeof result.data?.checkoutUrl !== 'string') {
        this.logger.error(`PayOS response types invalid: ${JSON.stringify(result.data)}`);
        await this.paymentsRepo.markTransactionFailedIfPendingAtomicTx(transaction.paymentTransactionId);
        throw new BadRequestException({
          success: false,
          code: 'PAYOS_RESPONSE_INVALID',
          message: 'Dữ liệu liên kết thanh toán từ PayOS không hợp lệ',
        });
      }

      await this.persistLinkOrCancelOnRace({
        orderId: rawOrderId,
        paymentTransactionId: transaction.paymentTransactionId,
        paymentLinkId: result.data.paymentLinkId,
        checkoutUrl: result.data.checkoutUrl,
        qrCode: result.data.qrCode,
      });

      return {
        success: true,
        message: 'Tạo link thanh toán PayOS thành công',
        data: {
          paymentTransactionId: transaction.paymentTransactionId.toString(),
          orderCode,
          amount: orderAmount,
          description,
          checkoutUrl: result.data.checkoutUrl,
          qrCode: result.data.qrCode,
          paymentLinkId: result.data.paymentLinkId,
          status: 'PENDING',
        },
      };
    } catch (err: any) {
      if (err instanceof HttpException) throw err;
      this.logger.error(`PayOS request failed: ${err.message}`);
      // NV-12: Do NOT unilaterally mark transaction as FAILED on network/timeout errors.
      throw new InternalServerErrorException('Lỗi kết nối tới cổng thanh toán PayOS');
    }
  }

  /**
   * Persist newly created PayOS link details under row lock; if the transaction or order
   * was cancelled / switched payment method while PayOS I/O was in flight, reject returning
   * an active PENDING link and trigger best-effort remote cancellation for reconciliation.
   */
  private async persistLinkOrCancelOnRace(params: {
    orderId: bigint;
    paymentTransactionId: bigint;
    paymentLinkId: string;
    checkoutUrl?: string;
    qrCode?: string;
  }) {
    const persistResult = await this.paymentsRepo.savePaymentLinkIfStillActiveTx(params);
    if (!persistResult.saved) {
      if (persistResult.transactionStatus !== 'PAID' && persistResult.paymentStatus !== 'PAID') {
        try {
          await this.cancelPaymentLink(
            params.paymentLinkId,
            `Giao dịch thanh toán không còn hiệu lực (${persistResult.reason || persistResult.transactionStatus})`,
          );
        } catch (cancelErr: any) {
          this.logger.warn(
            `Failed to cancel stale PayOS link ${params.paymentLinkId} (tx=${params.paymentTransactionId}, reason=${persistResult.reason}): ${cancelErr?.message}`,
          );
        }
      }
      throw new ConflictException({
        success: false,
        code: 'PAYMENT_TRANSACTION_CANCELLED',
        message:
          'Yêu cầu thanh toán hoặc đơn hàng đã bị hủy hoặc đổi phương thức thanh toán trước khi lưu liên kết PayOS',
      });
    }
    return persistResult;
  }

  async handlePayosWebhook(body: PayosWebhookDto) {
    // 1. PayOS Webhook URL confirmation handshake (sent when updating webhook URL on PayOS dashboard)
    if ((body?.webhookUrl || (body as any)?.webhook_url) && !body?.data && !body?.signature) {
      const confirmedUrl = body.webhookUrl || (body as any).webhook_url;
      this.logger.log(`[PayOS Webhook] Acknowledged confirmation ping for webhookUrl: ${confirmedUrl}`);
      return {
        code: '00',
        desc: 'success',
        data: {
          webhookUrl: confirmedUrl,
        },
      };
    }

    const { code, data, signature } = body || {};


    if (body?.success !== true) {
      this.logger.warn(`[PayOS Webhook] Rejected: body.success must be true, received: ${body?.success}`);
      return { success: false, message: 'Invalid webhook: success must be true' };
    }

    const checksumKey = process.env.PAYOS_CHECKSUM_KEY?.trim() || '';

    if (!verifyWebhookSignature(data, signature, checksumKey)) {
      this.logger.warn(`[PayOS Webhook] Invalid signature for orderCode: ${data?.orderCode}`);
      return { success: false, message: 'Invalid signature' };
    }

    const orderCodeStr = data?.orderCode?.toString();
    const transaction = await this.paymentsRepo.findTransactionByCode(orderCodeStr);

    if (!transaction) {
      if (this.billingChargesService) {
        const charge = await this.billingChargesService.findChargeByOrderCode(orderCodeStr, data?.paymentLinkId);
        if (charge) {
          const signedChargeCode = data?.code !== undefined && data?.code !== null ? String(data.code).trim() : '';
          const envelopeChargeCode = code !== undefined && code !== null ? String(code).trim() : '';
          if (signedChargeCode === '00') {
            if (envelopeChargeCode && envelopeChargeCode !== '00') {
              this.logger.warn(`[PayOS Webhook] Rejected inconsistent envelope code "${envelopeChargeCode}" for signed charge data.code="00" (orderCode=${orderCodeStr})`);
              return { success: false, message: 'Inconsistent webhook envelope code' };
            }
            const receiptLedgerEnabled = ['RENTAL_INITIAL', 'RENTAL_EXTENSION', 'STORE_SUBSCRIPTION'].includes(charge.purpose);
            if (!data?.amount || isNaN(Number(data.amount))) {
              this.logger.warn('[PayOS Webhook] Missing or invalid mandatory field amount for charge');
              return { success: false, message: 'Missing amount' };
            }
            if (data.currency?.toUpperCase() !== 'VND') {
              this.logger.warn(`[PayOS Webhook] Invalid currency: ${data.currency} for charge: ${orderCodeStr}`);
              return { success: false, message: 'Invalid currency' };
            }
            if (Number(data.amount) !== Number(charge.totalAmount) && !receiptLedgerEnabled) {
              this.logger.warn(`[PayOS Webhook] Amount mismatch: webhook=${data.amount}, charge=${charge.totalAmount} for orderCode: ${orderCodeStr}`);
              return { success: false, message: 'Amount mismatch' };
            }
            if (charge.status === 'PAID' && !receiptLedgerEnabled) {
              return { success: true, message: 'Already processed' };
            }
            const recordedLinkId = charge.paymentLinkId;
            if (receiptLedgerEnabled && (!data.reference || !recordedLinkId || data.paymentLinkId !== recordedLinkId)) {
              throw new BadRequestException('Verified transaction reference and payment link binding are required');
            }
            if (recordedLinkId && data.paymentLinkId && recordedLinkId !== data.paymentLinkId) {
              this.logger.warn(`[PayOS Webhook] Payment link ID mismatch for charge ${orderCodeStr}: recorded="${recordedLinkId}", received="${data.paymentLinkId}"`);
              return { success: false, message: 'Payment link ID mismatch' };
            }

            const settlement: any = await this.billingChargesService.settleCharge(
              charge.chargeId,
              {
                provider: 'PAYOS',
                providerTransactionCode: (data.reference || orderCodeStr).toString(),
                amount: Number(data.amount),
                currency: data.currency.toUpperCase(),
                paidAt: new Date(data.transactionDateTime || Date.now()),
                verified: true,
                paymentLinkId: data.paymentLinkId,
              },
              {
                role: 'SYSTEM',
              },
            );

            return {
              success: true,
              message: settlement.overpayment ? 'Payment recorded for reconciliation'
                : settlement.alreadySettled ? 'Already processed' : 'Billing charge settled successfully',
            };
          }
        }
      }

      const webhookDesc = data?.description || (body as any)?.description || '';
      let isStoreVerification =
        /VERIFY_[A-Z0-9]{4,10}/i.test(webhookDesc) ||
        /(?:^|[^A-Z0-9])S[A-Z0-9]{6,8}(?=[^A-Z0-9]|$)/i.test(webhookDesc);

      // Nếu description không chứa VERIFY_, kiểm tra thêm xem orderCode có thuộc về giao dịch Store Verification không
      if (!isStoreVerification && orderCodeStr) {
        isStoreVerification = await this.paymentsRepo.isStoreVerificationTransaction(orderCodeStr);
      }

      // 1. Ưu tiên định tuyến trực tiếp vào Store Bank Verification nếu thuộc về Store
      if (isStoreVerification && this.bankVerificationService) {
        try {
          const storeResult = await this.bankVerificationService.handleVerificationWebhook(body as any);
          if (storeResult && (storeResult.success || (storeResult as any).code === '00')) {
            this.logger.log(`[PayOS Webhook] Routed to BankVerificationService for description: ${webhookDesc}, orderCode: ${orderCodeStr}`);
            return storeResult;
          }
        } catch (storeErr: any) {
          this.logger.warn(`[PayOS Webhook] BankVerificationService routing failed: ${storeErr.message}`);
        }
      }

      // 2. Thử định tuyến vào Customer Bank Penny Verification
      if (this.customerBankPennyService) {
        try {
          const pennyResult = await this.customerBankPennyService.processPayosVerificationWebhook(body as any);
          if (pennyResult && (pennyResult.success || pennyResult.code === '00') && !(pennyResult as any).notHandled) {
            this.logger.log(`[PayOS Webhook] Routed to CustomerBankPennyVerificationService for orderCode: ${orderCodeStr}`);
            return pennyResult;
          }
        } catch (pennyErr: any) {
          this.logger.warn(`[PayOS Webhook] CustomerBankPennyVerificationService routing failed: ${pennyErr.message}`);
        }
      }

      // 3. Fallback sang Store Bank Verification nếu Customer không xử lý
      if (!isStoreVerification && this.bankVerificationService) {
        try {
          const storeResult = await this.bankVerificationService.handleVerificationWebhook(body as any);
          if (storeResult && (storeResult.success || (storeResult as any).code === '00')) {
            this.logger.log(`[PayOS Webhook] Fallback routed to BankVerificationService for orderCode: ${orderCodeStr}`);
            return storeResult;
          }
        } catch (storeErr: any) {
          this.logger.warn(`[PayOS Webhook] BankVerificationService fallback routing failed: ${storeErr.message}`);
        }
      }

      this.logger.warn(`[PayOS Webhook] Transaction not found for orderCode: ${orderCodeStr}`);
      return { success: false, message: 'Transaction not found' };
    }

    const signedDataCode = data?.code !== undefined && data?.code !== null ? String(data.code).trim() : '';
    const envelopeCode = code !== undefined && code !== null ? String(code).trim() : '';

    // Trust only signed `data.code`. Reject contradictory unsigned envelope `code` so tampering
    // with the outer envelope can never mark a signed success receipt as FAILED.
    if (signedDataCode === '00' && envelopeCode && envelopeCode !== '00') {
      this.logger.warn(
        `[PayOS Webhook] Rejected inconsistent outer envelope code "${envelopeCode}" vs signed data.code "${signedDataCode}" for orderCode: ${orderCodeStr}`,
      );
      return { success: false, message: 'Inconsistent webhook envelope code' };
    }

    const isTransactionalRepo =
      typeof (this.paymentsRepo as any)?.prisma?.$transaction === 'function';

    if (!isTransactionalRepo) {
      const mockAlreadySettled = ['PAID', 'REFUND_PENDING', 'REFUNDED'].includes(transaction.status);
      if (signedDataCode !== '00' && mockAlreadySettled) {
        return { success: true, message: 'Already processed' };
      }
    }

    if (signedDataCode === '00') {
      // MANDATORY PAYOS PAYLOAD FIELD ENFORCEMENT (state-independent checks only before lock)
      if (!data?.orderCode) {
        this.logger.warn('[PayOS Webhook] Missing mandatory field orderCode');
        return { success: false, message: 'Missing orderCode' };
      }

      if (data.amount === undefined || data.amount === null || isNaN(Number(data.amount))) {
        this.logger.warn('[PayOS Webhook] Missing or invalid mandatory field amount');
        return { success: false, message: 'Missing amount' };
      }

      const webhookAmount = Number(data.amount);
      if (!Number.isFinite(webhookAmount) || webhookAmount <= 0 || !Number.isInteger(webhookAmount)) {
        this.logger.warn(`[PayOS Webhook] Invalid non-positive integer amount=${data.amount} for orderCode: ${orderCodeStr}`);
        return { success: false, message: 'Invalid amount' };
      }

      if (!data.currency) {
        this.logger.warn('[PayOS Webhook] Missing mandatory field currency');
        return { success: false, message: 'Missing currency' };
      }

      if (!data.paymentLinkId) {
        this.logger.warn('[PayOS Webhook] Missing mandatory field paymentLinkId');
        return { success: false, message: 'Missing paymentLinkId' };
      }

      // Validate currency: Must be VND
      if (data.currency.toUpperCase() !== 'VND') {
        this.logger.warn(`[PayOS Webhook] Invalid currency: ${data.currency} for orderCode: ${orderCodeStr}`);
        return { success: false, message: 'Invalid currency' };
      }

      // Validate paymentLinkId: FAIL-CLOSED strict equality
      const recordedLinkId = (transaction as any).paymentLinkId;
      if (!recordedLinkId || recordedLinkId !== data.paymentLinkId) {
        this.logger.warn(`[PayOS Webhook] Payment link ID mismatch for orderCode ${orderCodeStr}: recorded="${recordedLinkId}", received="${data.paymentLinkId}"`);
        return { success: false, message: 'Payment link ID mismatch' };
      }

      if (!isTransactionalRepo) {
        const mockAlreadySettled = ['PAID', 'REFUND_PENDING', 'REFUNDED'].includes(transaction.status);
        if (!mockAlreadySettled && webhookAmount !== Number(transaction.amount)) {
          this.logger.warn(`[PayOS Webhook] Amount mismatch: webhook amount=${data.amount}, tx amount=${transaction.amount} for orderCode: ${orderCodeStr}`);
          return { success: false, message: 'Amount mismatch' };
        }
      }

      const inboundMeta = extractInboundPaymentSourceEvidence(data as any);

      let legacyProviderVerdict: 'PROVEN_REPLAY' | 'PROVEN_INDEPENDENT_EXCESS' | 'UNVERIFIED' =
        'UNVERIFIED';
      if (
        isTransactionalRepo &&
        inboundMeta.providerTransactionRef &&
        typeof (this.paymentsRepo as any)?.findUnreconciledLegacyBackfill === 'function'
      ) {
        const legacyPlaceholder = await this.paymentsRepo.findUnreconciledLegacyBackfill(
          transaction.paymentTransactionId,
        );
        if (legacyPlaceholder) {
          legacyProviderVerdict = await this.resolveProviderLegacyLinkEvidence(
            transaction,
            inboundMeta,
            legacyPlaceholder,
          );
        }
      }

      // Atomic confirmation & receipt/obligation ledger recording; locked state decides primary vs excess
      const confirmed: any = await this.paymentsRepo.confirmPaymentAtomicTx(
        transaction.paymentTransactionId,
        inboundMeta,
        { legacyProviderVerdict },
      );
      const outcome = confirmed?.__webhookOutcome || {};
      if (outcome.amountMismatch) {
        this.logger.warn(
          `[PayOS Webhook] Amount mismatch under lock for Order #${transaction.orderId}: webhook=${webhookAmount}, tx=${transaction.amount}`,
        );
        return { success: false, message: 'Amount mismatch' };
      }

      this.logger.log(`[PayOS Webhook] Payment confirmed/recorded for Order #${transaction.orderId} (Transaction #${transaction.paymentTransactionId}, Ref=${inboundMeta.providerTransactionRef || 'N/A'})`);

      if (!outcome.wasAlreadySettled && !outcome.wasLateOrExcessRefund && transaction.order) {
        const storeId = transaction.order.storeId ? transaction.order.storeId.toString() : '';
        const orderId = transaction.orderId ? transaction.orderId.toString() : '';
        const eventPayload = {
          orderId,
          orderCode: orderCodeStr,
          amount: Number(transaction.amount),
          paymentTransactionId: transaction.paymentTransactionId.toString(),
        };

        if (this.eventsGateway) {
          this.eventsGateway.emitToStore(storeId, 'ORDER_PAYMENT_CONFIRMED', eventPayload);
          const assignedDriverId = (transaction.order as any)?.assignedDriverId;
          if (assignedDriverId) {
            this.eventsGateway.emitToDriver(
              assignedDriverId.toString(),
              'ORDER_PAYMENT_CONFIRMED',
              eventPayload,
            );
          }
        }

        // Post-commit: send FCM push notification to customer & emit customer websocket
        const fullOrder = await this.paymentsRepo.findOrderById(transaction.orderId);
        if (fullOrder && fullOrder.customer) {
          const customerUserId = fullOrder.customer.userId;
          const customerId = fullOrder.customer.customerId?.toString();

          if (this.eventsGateway && customerId) {
            this.eventsGateway.emitToCustomer(customerId, 'ORDER_PAYMENT_CONFIRMED', eventPayload);
          }

          if (this.notificationsService && customerUserId) {
            const notifTitle = 'Thanh toán đơn hàng thành công';
            const notifBody = `Đơn hàng #${orderCodeStr} đã thanh toán thành công qua PayOS với số tiền ${Number(transaction.amount).toLocaleString('vi-VN')} VND.`;
            this.notificationsService
              .sendPushToUser(customerUserId, {
                title: notifTitle,
                body: notifBody,
                data: {
                  orderId,
                  orderCode: orderCodeStr,
                  type: 'PAYMENT_SUCCESS',
                },
              })
              .catch((err) => {
                this.logger.error(`[PayOS Webhook] Failed to dispatch FCM push: ${err.message}`);
              });
          }
        }
      }
      return { success: true, message: 'Payment confirmed successfully' };
    } else {
      await this.paymentsRepo.markTransactionFailedIfPendingAtomicTx(transaction.paymentTransactionId);
      this.logger.log(`[PayOS Webhook] Payment failed recorded (if PENDING) for Order #${transaction.orderId}`);
      return { success: true, message: 'Payment failed recorded' };
    }
  }

  /**
   * Dispatches & settles an independent excess duplicate PayOS refund obligation
   * strictly for SUPER_ADMIN via PaymentRefundsService + PayOSPayoutService.
   */
  async refundExcessTransaction(
    transactionIdParam: string,
    dto: RefundExcessPaymentDto,
    user?: any,
  ) {
    if (!transactionIdParam || !/^\d+$/.test(transactionIdParam)) {
      throw new BadRequestException('Mã giao dịch không hợp lệ');
    }
    const paymentTransactionId = BigInt(transactionIdParam);
    const tx = await this.paymentsRepo.findTransactionById(paymentTransactionId);
    if (!tx || !tx.order) {
      throw new NotFoundException('Không tìm thấy giao dịch hoặc đơn hàng tương ứng');
    }

    if (!user || user.role !== 'SUPER_ADMIN') {
      throw new ForbiddenException(
        'Chỉ SUPER_ADMIN mới có quyền phát lệnh hoàn khoản thanh toán dư PayOS.',
      );
    }

    if (!this.paymentRefundsService) {
      throw new BadRequestException(
        'MANUAL_EXCESS_REFUND_DEPRECATED: Hệ thống chi hộ và đối soát chứng từ hoàn tiền PayOS chưa sẵn sàng.',
      );
    }

    const prisma = (this.paymentsRepo as any).prisma;
    const txObligations: any[] = await prisma.paymentRefundObligation.findMany({
      where: {
        sourcePaymentTransactionId: paymentTransactionId,
        obligationType: { in: ['EXCESS_DUPLICATE', 'LEGACY_UNCLASSIFIED'] },
      },
      orderBy: { obligationId: 'asc' },
    });

    let targetObl: any = null;
    if (dto?.obligationId) {
      const targetId = BigInt(dto.obligationId);
      targetObl = txObligations.find((o) => BigInt(o.obligationId) === targetId);
      if (!targetObl) {
        throw new NotFoundException(
          `Không tìm thấy nghĩa vụ hoàn khoản dư #${dto.obligationId} gắn với giao dịch #${transactionIdParam}.`,
        );
      }
    } else {
      const openObligations = txObligations.filter(
        (o) => !['REFUNDED', 'CANCELLED'].includes(o.status),
      );
      if (openObligations.length > 1) {
        throw new BadRequestException(
          'Giao dịch có nhiều nghĩa vụ hoàn khoản dư độc lập; vui lòng chỉ định obligationId cụ thể hoặc xử lý qua /admin/payment-refunds/obligations/:id/payout.',
        );
      }
      if (openObligations.length === 1) {
        targetObl = openObligations[0];
      } else if (txObligations.length > 0 && txObligations.every((o) => o.status === 'REFUNDED')) {
        const refreshed = await this.paymentsRepo.findTransactionById(paymentTransactionId);
        return {
          success: true,
          message: 'Khoản thanh toán dư đã được hoàn trả xác thực trước đó',
          data: {
            paymentTransactionId: refreshed?.paymentTransactionId?.toString(),
            obligationId: txObligations[0].obligationId.toString(),
            obligationStatus: txObligations[0].status,
            status: refreshed?.status,
            orderId: refreshed?.orderId?.toString(),
            orderPaymentStatus: refreshed?.order?.paymentStatus,
          },
        };
      } else {
        throw new BadRequestException(
          'Không tìm thấy nghĩa vụ hoàn khoản dư có chứng từ thu hợp lệ cho giao dịch này.',
        );
      }
    }

    const resultObl = await this.paymentRefundsService.initiateObligationPayout(
      targetObl.obligationId,
      {
        customerBankAccountId: dto?.customerBankAccountId,
        note: dto?.adminNote,
      },
      user,
    );

    if (
      resultObl &&
      ['READY_FOR_PAYOUT', 'PENDING_RECIPIENT_VERIFICATION'].includes(resultObl.status)
    ) {
      throw new BadRequestException(
        resultObl.failureReason || 'Yêu cầu chi hoàn tiền PayOS bị từ chối hoặc chưa đủ điều kiện thụ hưởng.',
      );
    }

    const updatedTx = await this.paymentsRepo.findTransactionById(paymentTransactionId);
    const settled = resultObl?.status === 'REFUNDED';

    return {
      success: true,
      settled,
      message: settled
        ? 'Đã hoàn tất chi trả và đối soát hoàn khoản thanh toán dư'
        : 'Đã gửi lệnh chi hoàn khoản dư PayOS, đang chờ xác nhận chứng từ cuối cùng',
      data: {
        paymentTransactionId: updatedTx?.paymentTransactionId?.toString(),
        orderId: updatedTx?.orderId?.toString(),
        status: updatedTx?.status,
        orderPaymentStatus: updatedTx?.order?.paymentStatus,
        obligationId: resultObl?.obligationId,
        obligationStatus: resultObl?.status,
        obligation: resultObl,
      },
    };
  }

  /**
   * Best-effort cancellation of stale remote PayOS links after DB commit.
   * Never throws back into the caller's post-commit business flow.
   */
  async cancelRemotePayosLinksBestEffort(
    paymentLinkIds: Array<string | null | undefined>,
    reason: string = 'Hủy liên kết thanh toán không còn hiệu lực',
  ): Promise<void> {
    const uniqueLinkIds = Array.from(
      new Set(
        (paymentLinkIds || [])
          .map((id) => (id ? String(id).trim() : ''))
          .filter((id) => id.length > 0),
      ),
    );
    for (const paymentLinkId of uniqueLinkIds) {
      try {
        await this.cancelPaymentLink(paymentLinkId, reason);
      } catch (err: any) {
        this.logger.warn(
          `Best-effort remote PayOS link cancellation failed for ${paymentLinkId}: ${err?.message || err}`,
        );
      }
    }
  }

  /**
   * Đổi phương thức thanh toán cho đơn hàng
   * - BOLA: Kiểm tra order thuộc quyền sở hữu của user
   * - Cho phép đổi khi đơn chưa PAID và đang ở PENDING..SHIPPING
   * - Hủy các transaction PENDING cũ và hủy link PayOS tương ứng nếu có
   */
  async changeOrderPaymentMethod(orderIdParam: string, dto: ChangePaymentMethodDto, user: any) {
    if (!orderIdParam || !/^\d+$/.test(orderIdParam)) {
      throw new BadRequestException('Mã đơn hàng không hợp lệ');
    }
    const orderId = BigInt(orderIdParam);

    // Phase 1 (ACID Lock First): Lock order FOR UPDATE inside TX, verify ownership/status,
    // mark PENDING payment transactions as CANCELLED, and switch paymentMethod atomically.
    const { updated, cancelledLinkIds } = await this.paymentsRepo.changePaymentMethodTx(
      orderId,
      dto.paymentMethod,
      user
        ? { userId: user.id || user.userId, role: user.role }
        : undefined,
    );

    // Phase 2 (External PayOS I/O AFTER DB commit): Cancel stale remote links best-effort
    await this.cancelRemotePayosLinksBestEffort(
      cancelledLinkIds,
      'Người dùng thay đổi phương thức thanh toán',
    );

    if (this.eventsGateway && updated) {
      const switchPayload = {
        orderId: updated.orderId.toString(),
        orderCode: updated.orderCode,
        paymentMethod: updated.paymentMethod,
        paymentStatus: updated.paymentStatus,
        orderStatus: updated.orderStatus,
        storeId: updated.storeId ? updated.storeId.toString() : null,
        customerId: updated.customerId ? updated.customerId.toString() : null,
      };
      if (updated.storeId) {
        this.eventsGateway.emitToStore(updated.storeId.toString(), 'ORDER_PAYMENT_METHOD_CHANGED', switchPayload);
      }
      if (updated.customerId) {
        this.eventsGateway.emitToCustomer(updated.customerId.toString(), 'ORDER_PAYMENT_METHOD_CHANGED', switchPayload);
      }
    }

    return {
      success: true,
      message: 'Cập nhật phương thức thanh toán thành công',
      data: {
        orderId: updated.orderId.toString(),
        orderCode: updated.orderCode,
        paymentMethod: updated.paymentMethod,
        orderStatus: updated.orderStatus,
        paymentStatus: updated.paymentStatus,
      },
    };
  }

  async getTransaction(id: string, user?: any) {
    if (!id || !/^\d+$/.test(id)) {
      throw new NotFoundException('Không tìm thấy thông tin giao dịch');
    }
    const transaction = await this.paymentsRepo.findTransactionById(BigInt(id));
    if (!transaction) {
      throw new NotFoundException('Không tìm thấy thông tin giao dịch');
    }

    // BOLA / IDOR Protection
    if (user) {
      const isSuperAdmin = user.role === 'SUPER_ADMIN' || user.role === 'SYSTEM_ADMIN';
      const isStoreStaff = user.storeId && transaction.order?.storeId && user.storeId.toString() === transaction.order.storeId.toString();
      const isCustomerOwner = user.customerProfileId && transaction.order?.customerId && user.customerProfileId.toString() === transaction.order.customerId.toString();

      if (!isSuperAdmin && !isStoreStaff && !isCustomerOwner) {
        throw new ForbiddenException('Bạn không có quyền truy cập thông tin giao dịch thanh toán này');
      }
    }

    return {
      success: true,
      data: {
        paymentTransactionId: transaction.paymentTransactionId.toString(),
        orderId: transaction.orderId.toString(),
        provider: transaction.provider,
        transactionCode: transaction.transactionCode,
        amount: Number(transaction.amount),
        paymentMethod: transaction.paymentMethod,
        status: transaction.status,
        paidAt: transaction.paidAt,
        createdAt: transaction.createdAt,
      },
    };
  }

    private async verifyPaymentRequestOwnership(orderCodeOrId: number | string, user: any) {
    if (!user) {
      return;
    }
    if (['SUPER_ADMIN', 'SYSTEM_ADMIN', 'ADMIN'].includes(user.role)) {
      return;
    }
    const tx: any = await this.paymentsRepo.findTransactionByPaymentLinkIdOrOrder(String(orderCodeOrId));
    if (tx) {
      const isCustomerOwner = tx.order?.customer?.userId && BigInt(tx.order.customer.userId) === BigInt(user.userId || user.id);
      const isStoreOwner = user.storeId && tx.order?.storeId && BigInt(tx.order.storeId) === BigInt(user.storeId);
      if (!isCustomerOwner && !isStoreOwner) {
        throw new ForbiddenException('Bạn không có quyền truy cập hoặc thao tác yêu cầu thanh toán này');
      }
      return;
    }

    if (this.billingChargesService) {
      const charge = await this.billingChargesService.findChargeByOrderCode(String(orderCodeOrId));
      if (charge) {
        await this.billingChargesService.getChargeById(charge.chargeId, user);
        return;
      }
    }

    throw new NotFoundException('Không tìm thấy thông tin giao dịch hoặc yêu cầu thanh toán trong hệ thống');
  }

  private async resolveProviderLegacyLinkEvidence(
    transaction: { transactionCode?: string | null; paymentLinkId?: string | null },
    inbound: { providerTransactionRef?: string | null; amount?: number | null },
    legacyPlaceholder: { amount?: any },
  ): Promise<'PROVEN_REPLAY' | 'PROVEN_INDEPENDENT_EXCESS' | 'UNVERIFIED'> {
    const inboundRef = inbound?.providerTransactionRef?.trim();
    const inboundAmt = inbound?.amount != null ? Math.round(Number(inbound.amount)) : 0;
    const legacyAmt = Math.round(Number(legacyPlaceholder?.amount || 0));
    const lookupKey = transaction?.paymentLinkId || transaction?.transactionCode;
    if (!inboundRef || inboundAmt <= 0 || legacyAmt <= 0 || !lookupKey) {
      return 'UNVERIFIED';
    }

    try {
      const res: any = await this.getPaymentLinkInformation(String(lookupKey));
      if (!res || res.code !== '00' || !res.data || typeof res.data !== 'object') {
        return 'UNVERIFIED';
      }
      if (
        res.data.orderCode != null &&
        transaction.transactionCode &&
        String(res.data.orderCode) !== String(transaction.transactionCode)
      ) {
        return 'UNVERIFIED';
      }
      if (
        res.data.id != null &&
        transaction.paymentLinkId &&
        String(res.data.id) !== String(transaction.paymentLinkId)
      ) {
        return 'UNVERIFIED';
      }

      const rawTxs = Array.isArray(res.data.transactions) ? res.data.transactions : [];
      const settledTxs = rawTxs
        .map((t: any) => ({
          ref: String(t?.reference || t?.providerTransactionRef || '').trim(),
          amount: Math.round(Number(t?.amount || 0)),
        }))
        .filter((t: any) => t.ref.length > 0 && Number.isFinite(t.amount) && t.amount > 0);

      if (settledTxs.length === 0) {
        return 'UNVERIFIED';
      }

      const matchingInbound = settledTxs.filter(
        (t: { ref: string; amount: number }) => t.ref === inboundRef && t.amount === inboundAmt,
      );
      if (matchingInbound.length === 0) {
        return 'UNVERIFIED';
      }

      const reportedPaid =
        res.data.amountPaid != null && Number.isFinite(Number(res.data.amountPaid))
          ? Math.round(Number(res.data.amountPaid))
          : null;

      if (settledTxs.length >= 2 || (reportedPaid !== null && reportedPaid > legacyAmt)) {
        return 'PROVEN_INDEPENDENT_EXCESS';
      }

      if (
        settledTxs.length === 1 &&
        matchingInbound.length === 1 &&
        inboundAmt === legacyAmt &&
        (reportedPaid === null || reportedPaid === legacyAmt)
      ) {
        return 'PROVEN_REPLAY';
      }

      return 'UNVERIFIED';
    } catch {
      return 'UNVERIFIED';
    }
  }

  async getPaymentLinkInformation(orderCodeOrId: number | string, user?: any) {
    if (user) {
      await this.verifyPaymentRequestOwnership(orderCodeOrId, user);
    }
    const clientId = process.env.PAYOS_CLIENT_ID?.trim();
    const apiKey = process.env.PAYOS_API_KEY?.trim();
    if (!clientId || !apiKey) {
      throw new InternalServerErrorException('PAYOS_CLIENT_ID or PAYOS_API_KEY missing');
    }

    if (process.env.PAYOS_MOCK_PAYMENT === 'true' || clientId === 'mock_client_id' || clientId?.startsWith('ci_test_')) {
      return {
        code: '00',
        desc: 'success',
        data: {
          id: `link_${orderCodeOrId}`,
          orderCode: isNaN(Number(orderCodeOrId)) ? orderCodeOrId : Number(orderCodeOrId),
          amount: 200000,
          amountPaid: 200000,
          amountRemaining: 0,
          status: 'PAID',
          createdAt: new Date().toISOString(),
          transactions: [],
        },
      };
    }

    try {
      const response = await fetch(`https://api-merchant.payos.vn/v2/payment-requests/${orderCodeOrId}`, {
        method: 'GET',
        headers: {
          'x-client-id': clientId,
          'x-api-key': apiKey,
        },
      });
      return await response.json();
    } catch (err: any) {
      this.logger.error(`PayOS getPaymentLinkInformation error: ${err.message}`);
      throw new InternalServerErrorException(`Không thể lấy thông tin link thanh toán: ${err.message}`);
    }
  }

  async cancelPaymentLink(orderCodeOrId: number | string, cancellationReason?: string, user?: any) {
    if (user) {
      await this.verifyPaymentRequestOwnership(orderCodeOrId, user);
    }
    const clientId = process.env.PAYOS_CLIENT_ID?.trim();
    const apiKey = process.env.PAYOS_API_KEY?.trim();
    if (!clientId || !apiKey) {
      throw new InternalServerErrorException('PAYOS_CLIENT_ID or PAYOS_API_KEY missing');
    }

    if (process.env.PAYOS_MOCK_PAYMENT === 'true' || clientId === 'mock_client_id' || clientId?.startsWith('ci_test_')) {
      await this.markLocalPaymentLinkCancelled(orderCodeOrId);
      return {
        code: '00',
        desc: 'success',
        data: {
          id: `link_${orderCodeOrId}`,
          orderCode: isNaN(Number(orderCodeOrId)) ? orderCodeOrId : Number(orderCodeOrId),
          status: 'CANCELLED',
          cancellationReason: cancellationReason || 'User requested cancel',
        },
      };
    }

    try {
      const response = await fetch(`https://api-merchant.payos.vn/v2/payment-requests/${orderCodeOrId}/cancel`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-client-id': clientId,
          'x-api-key': apiKey,
        },
        body: JSON.stringify({ cancellationReason: cancellationReason || 'Cancelled by store/customer' }),
      });
      // Issue 6 Fix: Always check HTTP status and PayOS response code before reporting success.
      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        this.logger.error(`PayOS cancelPaymentLink HTTP ${response.status} for ${orderCodeOrId}: ${errText}`);
        throw new BadRequestException(`Hủy link thanh toán thất bại (HTTP ${response.status})`);
      }
      const resData = await response.json() as any;
      if (resData.code !== '00') {
        this.logger.error(`PayOS cancelPaymentLink rejected (code ${resData.code}): ${resData.desc} for ${orderCodeOrId}`);
        throw new BadRequestException({
          success: false,
          errorCode: resData.code || 'PAYOS_CANCEL_FAILED',
          message: resData.desc || 'Hủy link thanh toán thất bại',
        });
      }
      await this.markLocalPaymentLinkCancelled(orderCodeOrId);
      return resData;
    } catch (err: any) {
      if (err instanceof BadRequestException) throw err;
      this.logger.error(`PayOS cancelPaymentLink error: ${err.message}`);
      throw new InternalServerErrorException(`Không thể hủy link thanh toán: ${err.message}`);
    }
  }

  private async markLocalPaymentLinkCancelled(orderCodeOrId: number | string) {
    try {
      const prisma = (this.paymentsRepo as any)?.prisma;
      if (!prisma) return;
      const keyStr = String(orderCodeOrId).trim();
      await prisma.paymentTransaction?.updateMany?.({
        where: {
          status: 'PENDING',
          OR: [{ transactionCode: keyStr }, { paymentLinkId: keyStr }],
        },
        data: { status: 'CANCELLED' },
      })?.catch?.(() => {});
      await prisma.billingCharge?.updateMany?.({
        where: {
          status: 'PENDING',
          OR: [{ providerTransactionCode: keyStr }, { paymentLinkId: keyStr }],
        },
        data: {
          paymentLinkId: null,
          checkoutUrl: null,
          qrCode: null,
        },
      })?.catch?.(() => {});
    } catch {
      // Best-effort local cleanup after remote cancellation
    }
  }
}

