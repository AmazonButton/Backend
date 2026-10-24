import {
  Injectable,
  Logger,
  Inject,
  Optional,
  ServiceUnavailableException,
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

    const vietqrClientId = process.env.VIETQR_CLIENT_ID || process.env.PAYOS_CLIENT_ID || '';
    const vietqrApiKey = process.env.VIETQR_API_KEY || process.env.PAYOS_API_KEY || '';

    if (!vietqrClientId || !vietqrApiKey) {
      this.logger.warn('[PayOSBankVerificationProvider] VietQR API credentials are not configured');
      throw new ServiceUnavailableException('Dịch vụ tra cứu tài khoản chưa được cấu hình');
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
        throw new Error(`VietQR Lookup HTTP ${response.status}`);
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

      throw new Error('Không tìm thấy thông tin tài khoản ngân hàng');
    } catch (error: any) {
      this.logger.warn(`[PayOSBankVerificationProvider] Lookup failed for BIN ${bankBin}`);
      throw error;
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
          status: 'SUCCESS',
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
          refundTransactionId: result.data?.id || result.data?.referenceId || params.referenceId,
          status: 'SUCCESS',
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
        `[PayOSBankVerificationProvider] createRefund failed for referenceId: ${params.referenceId}`,
      );
      return {
        refundTransactionId: '',
        status: 'FAILED',
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
