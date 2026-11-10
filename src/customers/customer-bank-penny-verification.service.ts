import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
  BadGatewayException,
  Optional,
  Inject,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { CustomersRepository } from './customers.repository';
import { CryptoVaultUtil } from '../common/utils/crypto-vault.util';
import {
  CustomerBankVerificationSessionResponseDto,
  CustomerBankVerificationStatusResponseDto,
  CustomerBankVerificationHistoryItemDto,
} from './dto/customer-bank-verification-response.dto';
import { verifyWebhookSignature, signPaymentRequest } from '../payments/payos.helper';
import { PayOSPayoutService } from '../payments/payos-payout.service';
import {
  verifyPayosPayoutEvidence,
  verifyPayosPayoutRejectionEvidence,
} from '../payments/payos-payout-verifier';

@Injectable()
export class CustomerBankPennyVerificationService {
  private readonly logger = new Logger(CustomerBankPennyVerificationService.name);
  private readonly inFlightLinkCreations = new Map<string, Promise<{ paymentLinkId: string; checkoutUrl: string }>>();

  constructor(
    private readonly customersRepo: CustomersRepository,
    @Optional() @Inject(PayOSPayoutService) private readonly payosPayoutService?: PayOSPayoutService,
  ) {}

  /**
   * Tra cứu payment link đã tạo từ PayOS theo orderCode (Phục hồi sau timeout / retry)
   */
  private async recoverExistingPaymentLink(
    orderCode: number,
    clientId: string,
    apiKey: string,
  ): Promise<{ paymentLinkId: string; checkoutUrl: string } | null> {
    try {
      const queryController = new AbortController();
      const queryTimeout = setTimeout(() => queryController.abort(), 6000);
      const queryRes = await fetch(`https://api-merchant.payos.vn/v2/payment-requests/${orderCode}`, {
        method: 'GET',
        headers: {
          'x-client-id': clientId,
          'x-api-key': apiKey,
        },
        signal: queryController.signal,
      });
      clearTimeout(queryTimeout);
      const queryData: any = await queryRes.json();
      if (
        queryData?.code === '00' &&
        queryData?.data &&
        Number(queryData.data.orderCode) === orderCode &&
        Number(queryData.data.amount) === 2000 &&
        queryData.data.checkoutUrl
      ) {
        return {
          paymentLinkId: queryData.data.id || queryData.data.paymentLinkId || String(orderCode),
          checkoutUrl: queryData.data.checkoutUrl,
        };
      }
    } catch (e: any) {
      this.logger.warn(`Không thể tra cứu payment link cũ cho orderCode ${orderCode}: ${e.message}`);
    }
    return null;
  }

  /**
   * Khởi tạo phiên xác minh tài khoản ngân hàng bằng penny-deposit (2.000đ)
   * Tự động tái sử dụng phiên còn hạn trong 15 phút (idempotency an toàn dưới DB lock)
   */
  async initiateVerificationSession(
    user: any,
    accountId: string | number | bigint,
  ): Promise<CustomerBankVerificationSessionResponseDto> {
    const userId = BigInt(user.userId || user.id);
    const profile = await this.customersRepo.getCustomerProfileByUserId(userId);
    if (!profile) {
      throw new NotFoundException('Hồ sơ khách hàng không tồn tại');
    }

    const rawAccountId = BigInt(accountId);
    const account = await this.customersRepo.findCustomerBankAccountById(profile.customerId, rawAccountId);
    if (!account) {
      throw new NotFoundException('Tài khoản ngân hàng không tồn tại hoặc không thuộc sở hữu của bạn');
    }

    if (account.verificationStatus === 'VERIFIED') {
      return {
        accountId: account.id.toString(),
        sessionReference: '',
        orderCode: '0',
        checkoutUrl: '',
        amount: 0,
        sessionStatus: 'CONSUMED',
        verificationStatus: 'VERIFIED',
        expiresAt: new Date().toISOString(),
        message: 'Tài khoản ngân hàng đã được xác minh chính chủ trước đó',
      };
    }

    // 1. Kiểm tra tính năng thu tiền (Zero Fake Checkout URLs)
    const isLivePaymentEnabled = process.env.CUSTOMER_BANK_VERIFICATION_PAYMENT_ENABLED === 'true';
    if (!isLivePaymentEnabled) {
      throw new ServiceUnavailableException(
        'Tính năng thu tiền xác minh tài khoản đang tạm thời tắt (chờ cấu hình kết nối đối tác). Vui lòng thử lại sau.',
      );
    }

    const clientId = process.env.PAYOS_CLIENT_ID?.trim();
    const apiKey = process.env.PAYOS_API_KEY?.trim();
    const checksumKey = process.env.PAYOS_CHECKSUM_KEY?.trim();

    if (!clientId || !apiKey || !checksumKey) {
      throw new ServiceUnavailableException('Chưa cấu hình khóa kết nối PayOS trong hệ thống');
    }

    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes TTL

    // 2. [Step 1 & 2] Khóa tài khoản và LẤY hoặc TẠO phiên với orderCode ổn định trong DB Transaction
    const { session, isReused } = await this.customersRepo.getOrCreatePennyVerificationSessionTx({
      customerId: profile.customerId,
      accountId: account.id,
      bankBin: account.bankBin,
      accountNumberHash: (account as any).accountNumberHash,
      expiresAt,
      generateOrderCode: () => BigInt(Math.floor(Date.now() / 1000) * 1000 + Math.floor(Math.random() * 1000)),
      generateProofReference: () => `CUST_VRF_${account.bankBin}_${CryptoVaultUtil.generateReferenceCode('')}`.slice(0, 64),
    });

    // Nếu phiên đã có link PayOS hợp lệ gắn kèm -> Tái sử dụng ngay lập tức
    if (session.paymentCheckoutUrl) {
      return {
        accountId: account.id.toString(),
        sessionReference: session.proofReference,
        orderCode: session.paymentOrderCode!.toString(),
        checkoutUrl: session.paymentCheckoutUrl,
        amount: 2000,
        sessionStatus: session.sessionStatus,
        verificationStatus: session.verificationStatus,
        expiresAt: session.expiresAt.toISOString(),
        message: 'Tái sử dụng phiên xác minh đang hoạt động trong hạn 15 phút',
      };
    }

    // 3. [Step 3] Phiên chưa có payment link (hoặc lần trước timeout/retry) -> Quản lý dispatch với claim/lease và recovery
    const orderCodeNum = Number(session.paymentOrderCode);
    const leaseKey = session.id.toString();

    let linkPromise = this.inFlightLinkCreations.get(leaseKey);
    if (!linkPromise) {
      linkPromise = (async () => {
        // Nếu là phiên tái sử dụng, kiểm tra tra cứu payment request đã tồn tại trước
        if (isReused) {
          const recovered = await this.recoverExistingPaymentLink(orderCodeNum, clientId, apiKey);
          if (recovered) {
            return recovered;
          }
        }

        const description = `VRF ${account.bankBin}`.slice(0, 25);
        const frontendOrigin = process.env.FRONTEND_URL || 'https://buttontdash.vercel.app';
        const returnUrl = process.env.PAYOS_RETURN_URL || `${frontendOrigin}/customer/banking?status=success`;
        const cancelUrl = process.env.PAYOS_CANCEL_URL || `${frontendOrigin}/customer/banking?status=cancelled`;

        const signature = signPaymentRequest(
          {
            amount: 2000,
            cancelUrl,
            description,
            orderCode: orderCodeNum,
            returnUrl,
          },
          checksumKey,
        );

        const abortController = new AbortController();
        const timeoutHandle = setTimeout(() => abortController.abort(), 8000);

        try {
          const response = await fetch('https://api-merchant.payos.vn/v2/payment-requests', {
            method: 'POST',
            headers: {
              'x-client-id': clientId,
              'x-api-key': apiKey,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              orderCode: orderCodeNum,
              amount: 2000,
              description,
              cancelUrl,
              returnUrl,
              signature,
            }),
            signal: abortController.signal,
          });

          const resData: any = await response.json();
          if (resData?.code === '00' && resData?.data?.checkoutUrl) {
            return {
              paymentLinkId: resData.data.paymentLinkId,
              checkoutUrl: resData.data.checkoutUrl,
            };
          }

          // Nếu PayOS báo đơn hàng đã tồn tại hoặc lỗi khác, phục hồi bằng cách tra cứu qua GET /v2/payment-requests/:orderCode
          const recovered = await this.recoverExistingPaymentLink(orderCodeNum, clientId, apiKey);
          if (recovered) {
            return recovered;
          }

          this.logger.error(`PayOS trả về lỗi khi tạo link xác minh: ${JSON.stringify(resData)}`);
          throw new BadGatewayException(
            `Không thể tạo liên kết thanh toán từ cổng PayOS: ${resData?.desc || 'Lỗi nhà cung cấp'}`,
          );
        } catch (err: any) {
          if (err instanceof BadGatewayException) throw err;
          // Client timeout hoặc lỗi mạng -> tra cứu lại trước khi throw
          const recovered = await this.recoverExistingPaymentLink(orderCodeNum, clientId, apiKey);
          if (recovered) {
            return recovered;
          }
          this.logger.error(`Lỗi kết nối PayOS khi tạo payment link: ${err.message}`);
          throw new BadGatewayException(`Lỗi kết nối tới cổng thanh toán PayOS: ${err.message}`);
        } finally {
          clearTimeout(timeoutHandle);
        }
      })();

      this.inFlightLinkCreations.set(leaseKey, linkPromise);
    }

    let linkResult: { paymentLinkId: string; checkoutUrl: string };
    try {
      linkResult = await linkPromise;
    } finally {
      this.inFlightLinkCreations.delete(leaseKey);
    }

    // 4. [Step 4] Lưu kết quả payment link vào phiên bằng CAS
    let finalCheckoutUrl = linkResult.checkoutUrl;
    const casSuccess = await this.customersRepo.attachPaymentLinkToSessionCAS(
      session.id,
      linkResult.paymentLinkId,
      linkResult.checkoutUrl,
    );
    if (!casSuccess) {
      // Instance thua CAS hoặc link đã được gắn trước đó bởi instance khác: lấy lại link đã lưu trong DB
      const currentSession = await this.customersRepo.findVerificationSessionById(session.id);
      if (currentSession?.paymentCheckoutUrl) {
        finalCheckoutUrl = currentSession.paymentCheckoutUrl;
      }
    }

    // 5. [Step 5] Trả về thông tin phiên đã gắn link hoàn tất
    return {
      accountId: account.id.toString(),
      sessionReference: session.proofReference,
      orderCode: session.paymentOrderCode!.toString(),
      checkoutUrl: finalCheckoutUrl,
      amount: 2000,
      sessionStatus: session.sessionStatus,
      verificationStatus: session.verificationStatus,
      expiresAt: session.expiresAt.toISOString(),
      message: isReused
        ? 'Tái sử dụng phiên xác minh đang hoạt động trong hạn 15 phút'
        : 'Khởi tạo phiên xác minh tài khoản 2.000đ thành công. Vui lòng thanh toán trong vòng 15 phút.',
    };
  }

  /**
   * Polling trạng thái xác minh và nghĩa vụ hoàn tiền
   * Tổng trạng thái hoàn trả chỉ báo REFUNDED khi tất cả các nghĩa vụ đã hoàn tất
   */
  async getVerificationStatus(
    user: any,
    accountId: string | number | bigint,
  ): Promise<CustomerBankVerificationStatusResponseDto> {
    const userId = BigInt(user.userId || user.id);
    const profile = await this.customersRepo.getCustomerProfileByUserId(userId);
    if (!profile) {
      throw new NotFoundException('Hồ sơ khách hàng không tồn tại');
    }

    const rawAccountId = BigInt(accountId);
    const account = await this.customersRepo.findCustomerBankAccountById(profile.customerId, rawAccountId);
    if (!account) {
      throw new NotFoundException('Tài khoản ngân hàng không tồn tại hoặc không thuộc sở hữu của bạn');
    }

    const latestSession = await this.customersRepo.findLatestVerificationSessionByAccount(
      profile.customerId,
      rawAccountId,
    );

    let sessionData: any = null;
    let message = 'Tài khoản đang chờ xác minh';

    if (latestSession) {
      const isExpired = new Date(latestSession.expiresAt).getTime() < Date.now();
      const inbounds = latestSession.inboundTransactions || [];

      // BẮT BUỘC (P1): Tách rõ giao dịch thực nhận xác định (confirmedReceipts) khỏi quan sát đối soát (unconfirmedObservations)
      const confirmedReceipts = inbounds.filter((tx: any) =>
        tx.matchDecision !== 'MISSING_TRANSACTION_REF' &&
        tx.matchDecision !== 'MERGED_INTO_CONFIRMED' &&
        tx.reconciliationFlag !== 'FLAGGED_MISSING_PROVIDER_REF' &&
        !tx.reconciliationFlag?.startsWith('RECONCILED_MERGED') &&
        !tx.providerTransactionRef?.startsWith('UNREF_OBS_') &&
        !tx.mergedIntoInboundId
      );
      const unconfirmedObservations = inbounds.filter((tx: any) =>
        tx.matchDecision === 'MISSING_TRANSACTION_REF' ||
        tx.matchDecision === 'MERGED_INTO_CONFIRMED' ||
        tx.reconciliationFlag === 'FLAGGED_MISSING_PROVIDER_REF' ||
        tx.reconciliationFlag?.startsWith('RECONCILED_MERGED') ||
        tx.providerTransactionRef?.startsWith('UNREF_OBS_') ||
        Boolean(tx.mergedIntoInboundId)
      );

      const hasConfirmedReceipt = confirmedReceipts.length > 0;
      const paymentStatus = hasConfirmedReceipt
        ? 'PAID'
        : unconfirmedObservations.length > 0
        ? 'PENDING_RECONCILIATION'
        : isExpired
        ? 'EXPIRED'
        : 'PENDING';

      // Tính toán nghĩa vụ hoàn tiền tổng hợp: CHỈ tính trên các giao dịch thực nhận đã xác nhận (confirmedReceipts)
      let refundStatus = 'NONE';
      let totalObligationAmount = 0;
      let totalRefundedAmount = 0;
      let totalPendingRefundAmount = 0;

      if (hasConfirmedReceipt) {
        const obligations = confirmedReceipts.map((tx: any) => tx.refundObligation).filter(Boolean);

        totalObligationAmount = obligations.reduce((sum: number, o: any) => sum + Number(o.refundAmount || 0), 0);
        totalRefundedAmount = obligations
          .filter((o: any) => o.refundStatus === 'REFUNDED')
          .reduce((sum: number, o: any) => sum + Number(o.refundAmount || 0), 0);
        totalPendingRefundAmount = obligations
          .filter((o: any) => o.refundStatus !== 'REFUNDED')
          .reduce((sum: number, o: any) => sum + Number(o.refundAmount || 0), 0);

        if (obligations.length === 0) {
          refundStatus = 'NONE';
        } else if (obligations.every((o: any) => o.refundStatus === 'REFUNDED')) {
          refundStatus = 'REFUNDED';
        } else if (obligations.some((o: any) => o.refundStatus === 'REFUNDED')) {
          refundStatus = 'PARTIALLY_REFUNDED';
        } else if (obligations.every((o: any) => o.refundStatus === 'REFUND_FAILED')) {
          refundStatus = 'REFUND_FAILED';
        } else if (obligations.some((o: any) => o.refundStatus === 'PROCESSING_REFUND')) {
          refundStatus = 'PROCESSING_REFUND';
        } else if (obligations.some((o: any) => o.refundStatus === 'PENDING_MANUAL_REFUND')) {
          refundStatus = 'PENDING_MANUAL_REFUND';
        } else {
          refundStatus = 'PENDING_REFUND';
        }
      }

      sessionData = {
        sessionReference: latestSession.proofReference,
        sessionStatus: latestSession.sessionStatus,
        verificationStatus: latestSession.verificationStatus,
        paymentStatus,
        refundStatus,
        refundSummary: {
          totalObligationAmount,
          totalRefundedAmount,
          totalPendingRefundAmount,
        },
        expiresAt: latestSession.expiresAt.toISOString(),
        isExpired,
        rejectionReason: latestSession.rejectionReason,
        checkoutUrl: latestSession.paymentCheckoutUrl || null,
      };

      // Chuẩn hóa thông điệp người dùng
      if (latestSession.verificationStatus === 'PENDING_SOURCE_EVIDENCE') {
        message =
          'Đã nhận 2.000đ nhưng chưa đủ thông tin tài khoản nguồn để xác nhận và hoàn tự động. Khoản tiền đang chờ xử lý hoàn; vui lòng liên hệ hỗ trợ.';
      } else if (latestSession.verificationStatus === 'VERIFIED') {
        message = 'Tài khoản đã được xác thực chính chủ thành công. Khoản tiền 2.000đ đang trong quy trình hoàn trả.';
      } else if (latestSession.verificationStatus === 'FAILED_MISMATCH') {
        message = 'Giao dịch chuyển khoản không khớp với tài khoản đã đăng ký. Khoản tiền sẽ được hoàn trả về tài khoản đã chuyển.';
      } else if (unconfirmedObservations.length > 0 && !hasConfirmedReceipt) {
        message = 'Có thông báo chuyển khoản đang chờ đối soát mã tham chiếu ngân hàng (chưa xác nhận tiền thực nhận).';
      } else if (isExpired && !hasConfirmedReceipt) {
        message = 'Phiên xác minh đã hết hạn. Vui lòng tạo yêu cầu xác minh mới.';
      } else if (paymentStatus === 'PAID') {
        message = 'Đã nhận khoản tiền chuyển khoản. Hệ thống đang tiến hành xử lý hoàn trả.';
      } else {
        message = 'Đang chờ khách hàng chuyển khoản 2.000đ để xác thực tài khoản.';
      }
    }

    if (account.verificationStatus === 'VERIFIED') {
      message = 'Tài khoản ngân hàng đã được xác minh chính chủ thành công.';
    }

    return {
      accountId: account.id.toString(),
      bankBin: account.bankBin,
      bankCode: account.bankCode,
      bankName: account.bankName,
      accountNumberMasked: account.accountNumberMasked,
      accountName: account.accountName,
      accountVerificationStatus: account.verificationStatus,
      session: sessionData,
      message,
    };
  }

  /**
   * Lịch sử các phiên xác minh của khách hàng có phân trang
   */
  async getVerificationHistory(
    user: any,
    query: { page?: number; pageSize?: number } = {},
  ): Promise<{ items: CustomerBankVerificationHistoryItemDto[]; total: number; page: number; pageSize: number }> {
    const userId = BigInt(user.userId || user.id);
    const profile = await this.customersRepo.getCustomerProfileByUserId(userId);
    if (!profile) {
      throw new NotFoundException('Hồ sơ khách hàng không tồn tại');
    }

    const page = Math.max(1, Number(query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 20));
    const skip = (page - 1) * pageSize;

    const { items, total } = await this.customersRepo.findVerificationSessionsHistory(profile.customerId, skip, pageSize);

    const mappedItems: CustomerBankVerificationHistoryItemDto[] = items.map((s: any) => {
      const inbounds = s.inboundTransactions || [];
      // BẮT BUỘC (P1): CHỈ tính trên các giao dịch thực nhận đã xác nhận (confirmedReceipts)
      const confirmedReceipts = inbounds.filter((tx: any) =>
        tx.matchDecision !== 'MISSING_TRANSACTION_REF' &&
        tx.matchDecision !== 'MERGED_INTO_CONFIRMED' &&
        tx.reconciliationFlag !== 'FLAGGED_MISSING_PROVIDER_REF' &&
        !tx.reconciliationFlag?.startsWith('RECONCILED_MERGED') &&
        !tx.providerTransactionRef?.startsWith('UNREF_OBS_') &&
        !tx.mergedIntoInboundId
      );
      const paymentReceived = confirmedReceipts.length > 0;
      const receivedAmount = confirmedReceipts.reduce((sum: number, tx: any) => sum + Number(tx.amount || 0), 0);

      const obligations = confirmedReceipts.map((tx: any) => tx.refundObligation).filter(Boolean);
      const totalObligationAmount = obligations.reduce((sum: number, o: any) => sum + Number(o.refundAmount || 0), 0);
      const totalRefundedAmount = obligations
        .filter((o: any) => o.refundStatus === 'REFUNDED')
        .reduce((sum: number, o: any) => sum + Number(o.refundAmount || 0), 0);
      const totalPendingRefundAmount = obligations
        .filter((o: any) => o.refundStatus !== 'REFUNDED')
        .reduce((sum: number, o: any) => sum + Number(o.refundAmount || 0), 0);

      let refundStatus = 'NONE';
      if (obligations.length === 0) {
        refundStatus = 'NONE';
      } else if (obligations.every((o: any) => o.refundStatus === 'REFUNDED')) {
        refundStatus = 'REFUNDED';
      } else if (obligations.some((o: any) => o.refundStatus === 'REFUNDED')) {
        refundStatus = 'PARTIALLY_REFUNDED';
      } else if (obligations.every((o: any) => o.refundStatus === 'REFUND_FAILED')) {
        refundStatus = 'REFUND_FAILED';
      } else if (obligations.some((o: any) => o.refundStatus === 'PROCESSING_REFUND')) {
        refundStatus = 'PROCESSING_REFUND';
      } else if (obligations.some((o: any) => o.refundStatus === 'PENDING_MANUAL_REFUND')) {
        refundStatus = 'PENDING_MANUAL_REFUND';
      } else {
        refundStatus = 'PENDING_REFUND';
      }

      return {
        sessionId: s.id.toString(),
        sessionReference: s.proofReference,
        orderCode: s.paymentOrderCode ? s.paymentOrderCode.toString() : null,
        accountId: s.accountId ? s.accountId.toString() : null,
        bankBin: s.bankAccount?.bankBin || s.bankBin || null,
        bankName: s.bankAccount?.bankName || null,
        accountNumberMasked: s.bankAccount?.accountNumberMasked || null,
        accountName: s.bankAccount?.accountName || null,
        checkoutUrl: s.paymentCheckoutUrl || null,
        sessionStatus: s.sessionStatus,
        verificationStatus: s.verificationStatus,
        paymentReceived,
        receivedAmount: paymentReceived ? receivedAmount : null,
        refundStatus,
        totalObligationAmount: paymentReceived ? totalObligationAmount : 0,
        totalRefundedAmount: paymentReceived ? totalRefundedAmount : 0,
        totalPendingRefundAmount: paymentReceived ? totalPendingRefundAmount : 0,
        expiresAt: s.expiresAt.toISOString(),
        verifiedAt: s.verifiedAt ? s.verifiedAt.toISOString() : null,
        createdAt: s.createdAt.toISOString(),
      };
    });

    return {
      items: mappedItems,
      total,
      page,
      pageSize,
    };
  }

  /**
   * Xử lý webhook thanh toán xác minh từ PayOS
   * Bất biến:
   * 1. Xác thực chữ ký HMAC thật (bỏ bypass)
   * 2. Bắt buộc trạng thái thành công code === '00'
   * 3. Số tiền (amount) phải hợp lệ và hiện diện; tuyệt đối không tự bù 2.000đ
   * 4. Giao dịch khác 2.000đ vẫn ghi nhận nghĩa vụ hoàn thực nhận, nhưng không kích hoạt tài khoản
   * 5. Thiếu định danh giao dịch đáng tin cậy -> đưa vào đối soát
   * 6. Chống trùng có đối chiếu mâu thuẫn dữ liệu
   */
  async processPayosVerificationWebhook(body: any, rawBody?: Buffer): Promise<{ success: boolean; message: string }> {
    if (!body?.data) {
      throw new BadRequestException('Webhook payload không hợp lệ: thiếu data');
    }

    const checksumKey = process.env.PAYOS_CHECKSUM_KEY?.trim();
    if (!checksumKey) {
      this.logger.error('PAYOS_CHECKSUM_KEY chưa được cấu hình');
      throw new BadRequestException('Chưa cấu hình khóa xác thực webhook PayOS');
    }

    // 1. Kiểm tra chữ ký HMAC (Zero Mock Signature Bypass)
    let isValid = verifyWebhookSignature(body.data, body.signature, checksumKey);
    if (!isValid && rawBody) {
      try {
        const rawHmac = crypto.createHmac('sha256', checksumKey).update(rawBody).digest('hex');
        isValid = crypto.timingSafeEqual(Buffer.from(rawHmac, 'hex'), Buffer.from(body.signature, 'hex'));
      } catch {
        isValid = false;
      }
    }

    if (!isValid) {
      this.logger.warn(`Chữ ký webhook PayOS không hợp lệ cho orderCode: ${body.data?.orderCode}`);
      throw new BadRequestException('Chữ ký webhook không hợp lệ');
    }

    const data = body.data;

    // 2. Kiểm tra trạng thái thanh toán thành công
    // - Envelope bên ngoài (body.code) bắt buộc phải là '00'
    // - Dữ liệu đã xác thực chữ ký (data.code): nếu hiện diện, bắt buộc phải là '00'
    // - Tuyệt đối không cho phép body.desc === 'success' hoặc envelope bên ngoài thay thế/ghi đè khi data.code báo lỗi
    const isEnvelopeSuccess = body.code === '00';
    const isDataSuccess = data.code === undefined || data.code === null || data.code === '00';

    if (!isEnvelopeSuccess || !isDataSuccess) {
      this.logger.warn(
        `Webhook PayOS thông báo thanh toán không thành công: body.code=${body.code}, data.code=${data.code}`,
      );
      return {
        success: true,
        message: 'Giao dịch không ở trạng thái thành công; bỏ qua ghi sổ nhận tiền',
      };
    }

    // 3. Kiểm tra số tiền hợp lệ: bắt buộc là số nguyên dương hữu hạn (tuyệt đối không tự bù 2.000đ)
    if (
      data.amount === undefined ||
      data.amount === null ||
      typeof data.amount !== 'number' ||
      !Number.isFinite(data.amount) ||
      !Number.isInteger(data.amount) ||
      data.amount <= 0
    ) {
      throw new BadRequestException('Số tiền thanh toán (amount) không hợp lệ hoặc thiếu trong webhook payload');
    }
    const amount = data.amount;

    // 4. Kiểm tra mã tham chiếu giao dịch provider đáng tin cậy
    // CHÚ Ý BẮT BUỘC (P0): Merchant/channel lấy từ cấu hình server gắn với bộ khóa xác thực.
    // Tuyệt đối KHÔNG dùng trường envelope chưa xác thực (body.channel) làm phạm vi chống trùng.
    const provider = 'PAYOS';
    const channel = 'PAYOS_WEBHOOK';
    const rawRef = data.reference ? String(data.reference).trim() : null;
    const isMissingRef = !rawRef;
    let providerTransactionRef = rawRef;
    let missingRefFlag: string | null = null;

    if (isMissingRef) {
      missingRefFlag = 'FLAGGED_MISSING_PROVIDER_REF';
      const obsNonce = crypto.randomUUID();
      providerTransactionRef = `UNREF_OBS_${data.orderCode}_${Date.now()}_${obsNonce.slice(0, 8)}`;
      this.logger.warn(
        `Webhook PayOS thiếu reference đáng tin cậy cho orderCode ${data.orderCode}. Lưu quan sát đối soát riêng biệt [${providerTransactionRef}].`,
      );
    }

    const receivedAt = data.transactionDateTime ? new Date(data.transactionDateTime) : new Date();

    // 5. Tra cứu phiên xác nhận tương ứng
    const orderCode = BigInt(data.orderCode);
    const session = await this.customersRepo.findVerificationSessionByOrderCode(orderCode);

    // 6. Chuẩn bị thông tin tài khoản nguồn
    const sourceBankBin = data.counterAccountBankId ? String(data.counterAccountBankId).trim() : null;
    const sourceAccountNumber = data.counterAccountNumber ? String(data.counterAccountNumber).trim() : null;
    const sourceAccountName = data.counterAccountName ? String(data.counterAccountName).trim() : null;

    const hasSufficientEvidence = !isMissingRef && Boolean(sourceBankBin && sourceAccountNumber);
    let sourceAccountMasked: string | null = null;
    let sourceAccountHash: string | null = null;
    let sourceAccountEncrypted: string | null = null;

    if (sourceBankBin && sourceAccountNumber) {
      sourceAccountMasked = `******${sourceAccountNumber.slice(-4)}`;
      sourceAccountHash = CryptoVaultUtil.computeDeterministicAccountHash(sourceAccountNumber);
      sourceAccountEncrypted = CryptoVaultUtil.encryptAccountNumber(sourceAccountNumber);
    }

    // 7. Chống trùng lặp theo provider & channel scope và đối chiếu 4 thuộc tính bất biến mâu thuẫn
    const existingTx = await this.customersRepo.findInboundTransactionByProviderRef(
      provider,
      channel,
      providerTransactionRef!,
    );

    if (existingTx) {
      const isAmountConflict = Number(existingTx.amount) !== amount;
      const isSourceBinConflict = (existingTx.sourceBankBin || null) !== sourceBankBin;
      const isSourceAccountConflict = (existingTx.sourceAccountHash || null) !== sourceAccountHash;
      const isSessionConflict = existingTx.proofId !== (session ? session.id : null);

      if (isAmountConflict || isSourceBinConflict || isSourceAccountConflict || isSessionConflict) {
        this.logger.error(
          `[CRITICAL AUDIT] Webhook trùng reference ${providerTransactionRef} nhưng mâu thuẫn dữ liệu: ` +
            `amount (cũ: ${existingTx.amount}, mới: ${amount}), ` +
            `BIN (cũ: ${existingTx.sourceBankBin}, mới: ${sourceBankBin}), ` +
            `accountHash (cũ: ${existingTx.sourceAccountHash}, mới: ${sourceAccountHash}), ` +
            `session (cũ: ${existingTx.proofId}, mới: ${session ? session.id : null})`,
        );
        await this.customersRepo.flagConflictingInboundTransaction(
          existingTx.id,
          'FLAGGED_CONFLICTING_DUPLICATE_WEBHOOK',
        );
        return {
          success: true,
          message: 'Giao dịch trùng lặp có dữ liệu mâu thuẫn đã được đánh dấu cờ đối soát',
        };
      }

      return {
        success: true,
        message: 'Giao dịch đã được ghi nhận trước đó (Idempotent)',
      };
    }

    const rawPayloadChecksum = crypto
      .createHash('sha256')
      .update(JSON.stringify(data))
      .digest('hex');

    const refundPayoutReference = isMissingRef
      ? null
      : `REF_PAYOS_${providerTransactionRef}_${Date.now()}`.slice(0, 64);

    // 8. Thực thi ghi sổ Inbound + Obligation và xác thực CAS trong cùng 1 transaction nguyên tử
    const result = await this.customersRepo.recordInboundTransactionAndObligationAtomicTx({
      proofId: session ? session.id : null,
      provider,
      channel,
      providerTransactionRef: providerTransactionRef!,
      amount,
      receivedAt,
      sourceBankBin,
      sourceAccountMasked,
      sourceAccountHash,
      sourceAccountEncrypted,
      sourceAccountName,
      hasSufficientEvidence,
      rawPayloadChecksum,
      reconciliationFlag: missingRefFlag,
      refundPayoutReference,
    });

    this.logger.log(
      `Ghi nhận giao dịch PayOS [${providerTransactionRef}] amount=${amount} ` +
        `matchDecision=${result.matchDecision} shouldActivate=${result.shouldActivate}`,
    );

    return {
      success: true,
      message: result.shouldActivate
        ? 'Ghi nhận giao dịch, kích hoạt tài khoản và tạo nghĩa vụ hoàn tiền thành công'
        : isMissingRef
        ? 'Ghi nhận quan sát giao dịch thiếu reference đưa vào đối soát (chưa tạo nghĩa vụ tự động)'
        : 'Ghi nhận giao dịch và nghĩa vụ hoàn tiền thành công',
    };
  }

  /**
   * Worker xử lý hoàn tiền 2.000đ từ sổ nghĩa vụ hoàn trả (Refund Obligation Outbox)
   * Nối adapter PayOSPayoutService thật, không giả định thành công
   */
  async processRefundWorkerBatch(limit = 10): Promise<{ processed: number; succeeded: number; failed: number }> {
    const isLivePayoutEnabled = process.env.FEATURE_CUSTOMER_REFUND_PAYOUT_ENABLED === 'true';
    if (!isLivePayoutEnabled) {
      this.logger.log(
        '[DRY-RUN] FEATURE_CUSTOMER_REFUND_PAYOUT_ENABLED is disabled. Worker will not claim refund obligations.',
      );
      return { processed: 0, succeeded: 0, failed: 0 };
    }

    if (!this.payosPayoutService) {
      this.logger.warn('PayOSPayoutService chưa được kích hoạt trong hệ thống. Bỏ qua lượt chi trả hoàn cọc.');
      return { processed: 0, succeeded: 0, failed: 0 };
    }

    const obligations = await this.customersRepo.findPendingRefundObligations(limit);
    let processed = 0;
    let succeeded = 0;
    let failed = 0;

    for (const obligation of obligations) {
      processed++;
      try {
        // 1. Giải mã số tài khoản thụ hưởng
        let targetAccountNumber: string | null = null;
        if (obligation.targetAccountEncrypted) {
          try {
            targetAccountNumber = CryptoVaultUtil.decryptAccountNumber(obligation.targetAccountEncrypted);
          } catch (e: any) {
            this.logger.error(`Lỗi giải mã số tài khoản thụ hưởng cho obligation #${obligation.id}: ${e.message}`);
          }
        }

        if (!targetAccountNumber || !obligation.targetBankBin) {
          this.logger.warn(
            `Obligation #${obligation.id} thiếu BIN hoặc số tài khoản đích. Chuyển sang PENDING_MANUAL_REFUND.`,
          );
          await this.customersRepo.moveObligationToManualRefund(
            obligation.id,
            'Thiếu thông tin số tài khoản hoặc BIN nhận hoàn tiền',
          );
          failed++;
          continue;
        }

        // 2. Tạo attempt và khóa obligation nguyên tử
        const { attempt } = await this.customersRepo.createPayoutAttemptAndLockObligationTx(
          obligation.id,
          'PAYOS',
        );

        // 3. Gửi lệnh chi hộ qua PayOSPayoutService thật
        let payoutResult: any;
        try {
          payoutResult = await this.payosPayoutService.createPayout({
            toBin: obligation.targetBankBin,
            toAccountNumber: targetAccountNumber,
            amount: Number(obligation.refundAmount),
            description: `Hoan coc xac minh ${obligation.id}`.slice(0, 25),
            referenceId: attempt.payoutReference,
          });
        } catch (payoutErr: any) {
          this.logger.error(`Lỗi khi gọi PayOS createPayout cho attempt #${attempt.id}: ${payoutErr.message}`);
          // Timeout / lỗi mạng không rõ kết quả -> Luôn giữ trong PENDING_RECONCILIATION, không tự suy diễn thất bại
          await this.customersRepo.finalizePayoutAttemptTx({
            obligationId: obligation.id,
            attemptId: attempt.id,
            status: 'PENDING_RECONCILIATION',
            failureReason: `Network/Timeout: ${payoutErr.message}`,
          });
          failed++;
          continue;
        }

        // 4. Xác minh kết quả payout bằng bộ kiểm định dùng chung nghiêm ngặt
        const targetAccountHash =
          obligation.targetAccountHash ||
          (targetAccountNumber ? CryptoVaultUtil.computeDeterministicAccountHash(targetAccountNumber) : null);

        const expectedCriteria = {
          amount: Number(obligation.refundAmount),
          payoutReference: attempt.payoutReference,
          targetBankBin: obligation.targetBankBin,
          targetAccountHash,
          expectedPayoutId: attempt.providerPayoutId || undefined,
        };

        const verification = verifyPayosPayoutEvidence(payoutResult?.data, expectedCriteria);

        if (verification.isVerified) {
          await this.customersRepo.finalizePayoutAttemptTx({
            obligationId: obligation.id,
            attemptId: attempt.id,
            status: 'SUCCESS',
            providerPayoutId: verification.providerPayoutId,
            responseCode: '00',
          });
          succeeded++;
        } else {
          // Xác minh bằng chứng thất bại terminal nghiêm ngặt (Fail-Closed)
          const rejectionVerification = verifyPayosPayoutRejectionEvidence(payoutResult?.data, expectedCriteria);
          if (rejectionVerification.isVerified) {
            await this.customersRepo.finalizePayoutAttemptTx({
              obligationId: obligation.id,
              attemptId: attempt.id,
              status: 'FAILED',
              providerPayoutId: rejectionVerification.providerPayoutId,
              responseCode: payoutResult?.code || 'REJECTED',
              failureReason: rejectionVerification.reason || payoutResult?.desc || 'Cổng PayOS từ chối lệnh chi hộ',
            });
            failed++;
          } else {
            // Chưa đủ bằng chứng hoặc trạng thái PROCESSING/PENDING_APPROVAL -> giữ PENDING_RECONCILIATION
            await this.customersRepo.finalizePayoutAttemptTx({
              obligationId: obligation.id,
              attemptId: attempt.id,
              status: 'PENDING_RECONCILIATION',
              providerPayoutId: payoutResult?.data?.id || undefined,
              responseCode: payoutResult?.code || '00',
              failureReason: verification.reason || 'Chưa đủ bằng chứng xác minh kết quả chi trả, giữ chờ đối soát',
            });
            failed++;
          }
        }
      } catch (err: any) {
        this.logger.error(`Lỗi xử lý hoàn tiền cho obligation #${obligation.id}: ${err.message}`);
        failed++;
      }
    }

    return { processed, succeeded, failed };
  }

  /**
   * Đối soát và phục hồi các lượt chi trả đang ở trạng thái chưa rõ kết quả (Reconciler)
   */
  async reconcilePendingRefundPayouts(limit = 10): Promise<{ reconciled: number }> {
    if (!this.payosPayoutService) return { reconciled: 0 };
    const attempts = await this.customersRepo.findPendingReconciliationAttempts(limit);
    let reconciled = 0;

    for (const attempt of attempts) {
      try {
        let payoutDetailData: any = null;
        let concretePayoutId = attempt.providerPayoutId ? String(attempt.providerPayoutId).trim() : null;

        try {
          if (concretePayoutId) {
            const detailRes = await this.payosPayoutService.getPayout(concretePayoutId);
            if (detailRes?.code === '00' && detailRes?.data) {
              payoutDetailData = detailRes.data;
            }
          } else if (attempt.payoutReference) {
            // Tra cứu bằng referenceId qua API getPayouts
            const listRes = await this.payosPayoutService.getPayouts({
              referenceId: attempt.payoutReference,
            });

            if (listRes?.code === '00' && Array.isArray(listRes?.data?.payouts)) {
              // Lọc chính xác các payout khớp referenceId
              const matchingPayouts = listRes.data.payouts.filter((p: any) => {
                if (!p) return false;
                const pRef = p.referenceId ? String(p.referenceId).trim() : (p.reference ? String(p.reference).trim() : '');
                return pRef === attempt.payoutReference;
              });

              if (matchingPayouts.length === 1 && matchingPayouts[0]?.id) {
                concretePayoutId = String(matchingPayouts[0].id).trim();
                // Lấy chi tiết detail bằng ID cụ thể
                const detailRes = await this.payosPayoutService.getPayout(concretePayoutId);
                if (detailRes?.code === '00' && detailRes?.data) {
                  payoutDetailData = detailRes.data;
                }
              } else if (matchingPayouts.length > 1) {
                this.logger.warn(
                  `Phát hiện nhiều hơn 1 payout (${matchingPayouts.length}) khớp reference ${attempt.payoutReference}. Giữ PENDING_RECONCILIATION.`,
                );
                await this.customersRepo.updateAttemptReconcileBackoff(attempt.id, this.computeBackoffMs(attempt.reconcileAttempts || 0), 'Nhiều payout trùng reference');
                continue;
              } else {
                // matchingPayouts.length === 0 -> Chưa có payout từ provider, tiếp tục giữ chờ đối soát
                await this.customersRepo.updateAttemptReconcileBackoff(attempt.id, this.computeBackoffMs(attempt.reconcileAttempts || 0), 'Chưa tìm thấy payout từ cổng thanh toán');
                continue;
              }
            }
          }
        } catch (err: any) {
          // Mọi lỗi tra cứu (network timeout, 403, 404, gián đoạn) KHÔNG được hiểu thành "chưa chuyển tiền".
          // Giữ nguyên chờ đối soát trong PENDING_RECONCILIATION, tuyệt đối không suy diễn FAILED.
          this.logger.warn(`Lỗi tra cứu PayOS cho attempt #${attempt.id}: ${err.message}. Giữ chờ đối soát.`);
          await this.customersRepo.updateAttemptReconcileBackoff(attempt.id, this.computeBackoffMs(attempt.reconcileAttempts || 0), err.message);
          continue;
        }

        if (!payoutDetailData) {
          // Chưa có detail đầy đủ từ provider -> tiếp tục giữ chờ đối soát
          await this.customersRepo.updateAttemptReconcileBackoff(attempt.id, this.computeBackoffMs(attempt.reconcileAttempts || 0), 'Chưa có detail đầy đủ từ provider');
          continue;
        }

        const obligation = attempt.obligation;
        let targetAccountNumber: string | null = null;
        if (obligation?.targetAccountEncrypted) {
          try {
            targetAccountNumber = CryptoVaultUtil.decryptAccountNumber(obligation.targetAccountEncrypted);
          } catch {}
        }
        const targetAccountHash =
          obligation?.targetAccountHash ||
          (targetAccountNumber ? CryptoVaultUtil.computeDeterministicAccountHash(targetAccountNumber) : null);

        const expectedCriteria = {
          amount: Number(obligation?.refundAmount || 0),
          payoutReference: attempt.payoutReference,
          targetBankBin: obligation?.targetBankBin,
          targetAccountHash,
          expectedPayoutId: concretePayoutId || undefined,
        };

        // 1. Xác minh thành công (SUCCESS)
        const successVerification = verifyPayosPayoutEvidence(payoutDetailData, expectedCriteria);
        if (successVerification.isVerified) {
          await this.customersRepo.finalizePayoutAttemptTx({
            obligationId: attempt.obligationId,
            attemptId: attempt.id,
            status: 'SUCCESS',
            providerPayoutId: successVerification.providerPayoutId,
            responseCode: '00',
          });
          reconciled++;
          continue;
        }

        // 2. Xác minh thất bại terminal (FAILED)
        const rejectionVerification = verifyPayosPayoutRejectionEvidence(payoutDetailData, expectedCriteria);
        if (rejectionVerification.isVerified) {
          await this.customersRepo.finalizePayoutAttemptTx({
            obligationId: attempt.obligationId,
            attemptId: attempt.id,
            status: 'FAILED',
            providerPayoutId: rejectionVerification.providerPayoutId,
            failureReason: rejectionVerification.reason || payoutDetailData?.desc || 'PayOS xác nhận chi hộ thất bại',
          });
          reconciled++;
          continue;
        }

        // 3. Nếu chưa đủ bằng chứng cho cả 2 quyết định (đang PROCESSING) -> Cập nhật next_reconcile_at chống nghẽn hàng đợi (Anti-HoL)
        await this.customersRepo.updateAttemptReconcileBackoff(
          attempt.id,
          this.computeBackoffMs(attempt.reconcileAttempts || 0),
          `Đang xử lý tại cổng chi tiền (${payoutDetailData?.desc || payoutDetailData?.state || 'PROCESSING'})`,
        );
      } catch (e: any) {
        this.logger.error(`Lỗi đối soát payout attempt #${attempt.id}: ${e.message}`);
        await this.customersRepo.updateAttemptReconcileBackoff(
          attempt.id,
          this.computeBackoffMs(attempt.reconcileAttempts || 0),
          e.message,
        ).catch(() => {});
      }
    }

    return { reconciled };
  }

  private computeBackoffMs(attempts: number): number {
    const schedule = [
      60 * 1000,        // 1m
      2 * 60 * 1000,    // 2m
      5 * 60 * 1000,    // 5m
      15 * 60 * 1000,   // 15m
      30 * 60 * 1000,   // 30m
      60 * 60 * 1000,   // 1h
    ];
    return schedule[Math.min(attempts, schedule.length - 1)];
  }

  /**
   * Quy trình ghép các observation cụ thể vào một giao dịch xác định (Manual/Automated Reconciliation)
   * Bắt buộc cung cấp danh sách observationIds, không được tự động gom toàn bộ phiên.
   */
  async reconcileObservationsIntoConfirmedReceipt(params: {
    sessionId: string | number | bigint;
    observationIds: Array<string | number | bigint>;
    confirmedTransactionRef: string;
    amount: number;
    sourceBankBin: string;
    sourceAccountNumber: string;
    sourceAccountName?: string | null;
  }) {
    if (!Array.isArray(params.observationIds) || params.observationIds.length === 0) {
      throw new BadRequestException('Danh sách observationIds cần ghép không được rỗng');
    }

    const rawAccNumber = params.sourceAccountNumber.trim();
    const sourceAccountMasked = `******${rawAccNumber.slice(-4)}`;
    const sourceAccountHash = CryptoVaultUtil.computeDeterministicAccountHash(rawAccNumber);
    const sourceAccountEncrypted = CryptoVaultUtil.encryptAccountNumber(rawAccNumber);

    return this.customersRepo.reconcileObservationsIntoConfirmedReceiptTx({
      sessionId: BigInt(params.sessionId),
      observationIds: params.observationIds.map((id) => BigInt(id)),
      confirmedTransactionRef: params.confirmedTransactionRef.trim(),
      amount: params.amount,
      sourceBankBin: params.sourceBankBin.trim(),
      sourceAccountMasked,
      sourceAccountHash,
      sourceAccountEncrypted,
      sourceAccountName: params.sourceAccountName || null,
    });
  }
}
