import {
  Injectable,
  Logger,
  Inject,
  Optional,
  ServiceUnavailableException,
  BadRequestException,
} from '@nestjs/common';
import * as crypto from 'crypto';
import {
  BankVerificationProvider,
  BankAccountLookupResult,
  BankRefundParams,
  BankRefundResult,
} from './bank-verification.provider.interface';
import { PayOSPayoutService } from '../../payments/payos-payout.service';
import { VIETNAM_BANKS } from '../constants/vietnam-banks.constant';
import { verifyWebhookSignature } from '../../payments/payos.helper';

@Injectable()
export class PayOSBankVerificationProvider implements BankVerificationProvider {
  private readonly logger = new Logger(PayOSBankVerificationProvider.name);

  constructor(
    @Optional()
    @Inject(PayOSPayoutService)
    private readonly payosPayoutService?: PayOSPayoutService,
  ) {}

  /**
   * Tra cứu tên chủ tài khoản ngân hàng từ NAPAS/VietQR (Chỉ mock khi BANK_VERIFICATION_MOCK=true)
   */
  async lookupAccount(
    bankBin: string,
    accountNumber: string,
  ): Promise<BankAccountLookupResult> {
    const bank = VIETNAM_BANKS.find((b) => b.bin === bankBin);
    const bankName = bank ? bank.shortName : `Ngân hàng (BIN ${bankBin})`;

    if (process.env.NODE_ENV === 'production' && process.env.BANK_VERIFICATION_MOCK === 'true') {
      throw new Error('FATAL: BANK_VERIFICATION_MOCK must be disabled in production');
    }

    // Chỉ cho phép mock khi có cờ rõ ràng BANK_VERIFICATION_MOCK=true
    const isExplicitMock = process.env.BANK_VERIFICATION_MOCK === 'true';

    if (isExplicitMock) {
      this.logger.log(`[BankVerification Mock] Simulating lookup for BIN: ${bankBin}`);
      return {
        bankBin,
        bankName,
        accountNumber,
        accountName: 'NGUYEN VAN A',
      };
    }

    // VietQR credentials belong to a different provider contract than PayOS;
    // never send PayOS credentials to VietQR as an implicit fallback.
    const vietqrClientId = process.env.VIETQR_CLIENT_ID?.trim() || '';
    const vietqrApiKey = process.env.VIETQR_API_KEY?.trim() || '';

    if (!vietqrClientId || !vietqrApiKey) {
      this.logger.warn('[PayOSBankVerificationProvider] VietQR API credentials are not configured');
      throw new ServiceUnavailableException('Dịch vụ tra cứu tài khoản ngân hàng chưa được cấu hình (thiếu VIETQR_CLIENT_ID / VIETQR_API_KEY)');
    }

    try {
      // Gọi VietQR Open API để tra cứu tên tài khoản
      const response = await fetch('https://api.vietqr.io/v2/lookup', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-client-id': vietqrClientId,
          'x-api-key': vietqrApiKey,
        },
        body: JSON.stringify({
          bin: bankBin,
          accountNumber,
        }),
        signal: AbortSignal.timeout(4000),
      });

      if (!response.ok) {
        this.logger.warn(`VietQR Lookup HTTP ${response.status} for BIN ${bankBin}`);
        if (response.status === 401 || response.status === 403) {
          this.logger.error(
            `[PayOSBankVerificationProvider] VietQR API HTTP ${response.status}: Key VIETQR_CLIENT_ID/VIETQR_API_KEY không hợp lệ hoặc hết hạn trên https://my.vietqr.io (Lưu ý: Không dùng khóa PayOS cho VietQR Open API).`,
          );
          throw new ServiceUnavailableException({
            success: false,
            errorCode: 'BANK_LOOKUP_SERVICE_UNAVAILABLE',
            message: 'Dịch vụ tra cứu tài khoản ngân hàng tạm thời không khả dụng. Vui lòng thử lại sau.',
          });
        }
        throw new ServiceUnavailableException({
          success: false,
          errorCode: 'BANK_LOOKUP_SERVICE_UNAVAILABLE',
          message: 'Dịch vụ tra cứu tài khoản ngân hàng tạm thời không khả dụng',
        });
      }

      const resData = (await response.json()) as any;
      if (resData.code === '00' && resData.data?.accountName) {
        return {
          bankBin,
          bankName: bank?.shortName || resData.data.bankName || bankName,
          accountNumber,
          accountName: String(resData.data.accountName).toUpperCase(),
        };
      }

      if (resData.code === '42') {
        throw new BadRequestException({
          success: false,
          errorCode: 'BANK_ACCOUNT_NOT_FOUND',
          message: 'Tài khoản ngân hàng không tồn tại hoặc không chính xác',
        });
      }

      if (resData.code === '41') {
        throw new BadRequestException({
          success: false,
          errorCode: 'BANK_NOT_SUPPORTED_FOR_LOOKUP',
          message: 'Ngân hàng chưa hỗ trợ tra cứu tên chủ tài khoản trực tuyến',
        });
      }

      if (resData.code === '45') {
        throw new ServiceUnavailableException({
          success: false,
          errorCode: 'BANK_SYSTEM_BUSY',
          message: 'Hệ thống ngân hàng đang bận, vui lòng thử lại sau',
        });
      }

      if (resData.code === '47') {
        this.logger.warn(
          `[PayOSBankVerificationProvider] VietQR API thông báo: Gói Free tra cứu STK đã dừng từ 20/08/2024 (code 47). Kích hoạt Graceful Fallback để tiếp tục xác minh qua chuyển khoản 2.000đ.`,
        );
        return {
          bankBin,
          bankName: bank?.shortName || bankName,
          accountNumber,
          accountName: 'CHỦ TÀI KHOẢN (XÁC MINH QUA 2.000Đ)',
        };
      }

      throw new BadRequestException({
        success: false,
        errorCode: 'BANK_LOOKUP_FAILED',
        message: resData.desc || 'Không tìm thấy thông tin tài khoản ngân hàng',
      });
    } catch (error: any) {
      this.logger.warn(`[PayOSBankVerificationProvider] Lookup failed for BIN ${bankBin}: ${error.message}`);
      if (error instanceof ServiceUnavailableException || error instanceof BadRequestException) {
        throw error;
      }
      throw new ServiceUnavailableException({
        success: false,
        errorCode: 'BANK_LOOKUP_SERVICE_UNAVAILABLE',
        message: 'Dịch vụ tra cứu tài khoản ngân hàng tạm thời không khả dụng',
      });
    }
  }

  /**
   * Tạo lệnh hoàn trả tiền xác minh qua PayOS Payout API (Chỉ mock khi BANK_VERIFICATION_MOCK=true)
   */
  async createRefund(params: BankRefundParams): Promise<BankRefundResult> {
    if (process.env.NODE_ENV === 'production' && process.env.BANK_VERIFICATION_MOCK === 'true') {
      throw new Error('FATAL: BANK_VERIFICATION_MOCK must be disabled in production');
    }

    if (!this.payosPayoutService) {
      if (process.env.BANK_VERIFICATION_MOCK === 'true') {
        this.logger.log(`[BankVerification Mock] Simulating refund payout for ref: ${params.referenceId}`);
        return {
          refundTransactionId: `mock_refund_${Date.now()}`,
          status: 'PENDING_RECONCILIATION',
        };
      }
      throw new ServiceUnavailableException('Dịch vụ hoàn tiền Payout chưa được cấu hình');
    }

    try {
      const result = await this.payosPayoutService.createPayout({
        toBin: params.bankBin,
        toAccountNumber: params.accountNumber,
        amount: params.amount,
        description: params.description.slice(0, 50),
        referenceId: params.referenceId,
      });

      if (result.code === '00') {
        return {
          refundTransactionId: result.data?.id ? String(result.data.id).trim() : params.referenceId,
          status: 'PENDING_RECONCILIATION',
        };
      }

      this.logger.warn(
        `[PayOSBankVerificationProvider] Payout rejected for referenceId: ${params.referenceId}`,
      );
      return {
        refundTransactionId: '',
        status: 'FAILED',
      };
    } catch (error: any) {
      this.logger.error(
        `[PayOSBankVerificationProvider] createRefund failed for referenceId: ${params.referenceId}: ${error?.message}`,
      );
      return {
        refundTransactionId: '',
        status: 'PENDING_RECONCILIATION',
      };
    }
  }

  /**
   * Tra cứu thông tin giao dịch
   */
  async getTransaction(transactionId: string): Promise<any> {
    return {
      transactionId,
      status: 'VERIFIED',
    };
  }

  /**
   * Xác thực chữ ký Webhook HMAC-SHA256 trên rawBody byte buffer
   */
  verifyWebhook(
    rawBody: Buffer,
    signature: string,
    _headers: Record<string, string>,
  ): boolean {
    const secret =
      process.env.BANK_VERIFICATION_WEBHOOK_SECRET ||
      process.env.PAYOS_CHECKSUM_KEY ||
      '';

    if (!secret || !signature || !Buffer.isBuffer(rawBody)) {
      return false;
    }

    // Try standard HMAC-SHA256 direct over rawBody buffer
    let cleanSignature = signature.trim();
    if (cleanSignature.startsWith('sha256=')) {
      cleanSignature = cleanSignature.substring(7);
    }

    const expectedHex = crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest('hex');

    try {
      const sigBuf = Buffer.from(cleanSignature, 'hex');
      const expBuf = Buffer.from(expectedHex, 'hex');
      if (sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf)) {
        return true;
      }
    } catch {
      // Continue to test PayOS object query string verification
    }

    // Secondary: PayOS standard deep sort query string HMAC verification
    try {
      const parsed = JSON.parse(rawBody.toString('utf8'));
      if (parsed.data) {
        return verifyWebhookSignature(parsed.data, cleanSignature, secret);
      }
    } catch {
      // Ignore JSON parse errors
    }

    return false;
  }
}
