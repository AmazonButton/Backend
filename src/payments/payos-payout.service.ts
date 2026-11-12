import {
  Injectable,
  Logger,
  OnModuleInit,
  BadRequestException,
  BadGatewayException,
  InternalServerErrorException,
} from '@nestjs/common';
import {
  signPayoutRequest,
  verifyPayoutSignature,
  PayosPayoutRequestParams,
  PayosBatchPayoutRequestParams,
} from './payos.helper';

export interface PayOSCreatePayoutResult {
  code: string;
  desc: string;
  data?: {
    id: string;
    referenceId: string;
    approvalState: string;
    amount?: number;
    transactions?: Array<{
      id: string;
      referenceId: string;
      amount: number;
      description: string;
      toBin: string;
      toAccountNumber: string;
      toAccountName?: string;
      state: string;
    }>;
  };
}

export interface PayOSPayoutBalanceResult {
  code: string;
  desc: string;
  data?: {
    accountNumber: string;
    accountName: string;
    currency: string;
    balance: string | number;
  };
}

/** PayOS chặn lệnh chi trước khi gửi sang ngân hàng: chắc chắn CHƯA chi tiền, caller có thể đánh FAILED. */
export class PayOSPayoutPreDispatchException extends BadRequestException {
  constructor(
    public readonly payosCode: string,
    message: string,
    details?: unknown,
  ) {
    super({ success: false, code: 'PAYOS_PAYOUT_REJECTED', message, payosCode, details });
  }
}

/** Kết quả không rõ: tiền có thể đã đi. Caller PHẢI giữ PENDING_RECONCILIATION, không hoàn tiền / chi lại. */
export class PayOSPayoutIndeterminateException extends BadGatewayException {
  constructor(
    public readonly payosCode: string,
    message: string,
    details?: unknown,
  ) {
    super({ success: false, code: 'PAYOS_PAYOUT_INDETERMINATE', message, payosCode, details });
  }
}

// Các mã PayOS từ chối ở bước kiểm tra đầu vào (theo tài liệu payout API) => chắc chắn chưa chi.
// DUPLICATE_IDEMPOTENCY_KEY và PAYOUT_FAILED/CREATE_PAYOUT_FAILED cố ý KHÔNG nằm ở đây:
// lệnh trước cùng khóa có thể đã được gửi đi. Mã lạ/không biết cũng coi là chưa rõ (fail-safe).
const PRE_DISPATCH_REJECT_CODES = new Set<string>([
  'AMOUNT_NOT_INTEGER',
  'DECIMAL_PART_TOO_LONG',
  'PAYOUT_USAGE_LIMIT_EXCEED',
  'BALANCE_NOT_ENOUGH',
  'INVALID_DESTINATION',
  'PAYOUT_MISSING_PARAM',
  'PAYOUT_INVALID_FROM_ACCOUNT_NUMBER',
  'PAYOUT_INVALID_TO_ACCOUNT_NUMBER',
  'PAYOUT_INVALID_TO_BIN',
  'PAYOUT_INSUFFICIENT_FUNDS',
  'PAYOUT_LIMIT_REACHED',
  'PAYOUT_MAX_EXCEEDED_PER_TIME',
  'PAYOUT_MIN_EXCEEDED_PER_TIME',
  'PAYOUT_MAX_EXCEEDED_PER_DAY',
  'PAYOUT_MAX_EXCEEDED_PER_MONTH',
  'PAYOUT_PERMISSION_DENIED',
  'PAYOUT_INVALID_DESCRIPTION',
  'BANK_INFO_NOT_FOUND',
  'FI_SERVICE_ACCOUNT_STATE_INACTIVE',
  'MISSING_IDEMPOTENCY_KEY',
  'INVALID_IDEMPOTENCY_KEY',
  'INVALID_CONTENT_TYPE',
  'INVALID_PARAM',
  'PAYMENT_REQUEST_DATA_SIGNATURE_INCORRECT',
  'API_KEY_OR_CLIENT_ID_NOT_FOUND',
  'PAYOUT_API_KEY_NOT_FOUND',
  'PAYOUT_API_KEY_NOT_ACTIVE',
  'PAYOUT_API_KEY_ORGANIZATION_NOT_FOUND',
]);

// HTTP status mà gateway từ chối trước khi xử lý lệnh (xác thực, bị cấm, rate limit).
const PRE_DISPATCH_HTTP_STATUS = new Set<number>([401, 403, 429]);

@Injectable()
export class PayOSPayoutService implements OnModuleInit {
  private readonly logger = new Logger(PayOSPayoutService.name);
  private readonly baseUrl = 'https://api-merchant.payos.vn';

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test' || process.env.PAYOS_MOCK_PAYOUT === 'true') return;
    // Không chặn khởi động và không throw: chỉ cảnh báo sớm khi tài khoản chi chưa sẵn sàng.
    void this.checkPayoutAccountHealth();
  }

  private async checkPayoutAccountHealth(): Promise<void> {
    try {
      this.getCredentials();
      await this.getPayoutBalance();
      this.logger.log('[PayOS Payout] Tài khoản chi phản hồi hợp lệ (balance API trả mã 00).');
    } catch (err: any) {
      const payosCode = err?.getResponse?.()?.details?.code ?? err?.getResponse?.()?.code;
      this.logger.warn(
        `[PayOS Payout] Tài khoản chi CHƯA sẵn sàng${payosCode ? ` (${payosCode})` : ''}: ${err?.message}. Các lệnh chi/hoàn tiền sẽ bị từ chối cho tới khi khắc phục.`,
      );
    }
  }

  private getCredentials() {
    const isProd = process.env.NODE_ENV === 'production';
    let clientId = process.env.PAYOS_PAYOUT_CLIENT_ID?.trim();
    let apiKey = process.env.PAYOS_PAYOUT_API_KEY?.trim();
    let checksumKey = process.env.PAYOS_PAYOUT_CHECKSUM_KEY?.trim();

    if (!isProd) {
      clientId = clientId || process.env.PAYOS_CLIENT_ID?.trim();
      apiKey = apiKey || process.env.PAYOS_API_KEY?.trim();
      checksumKey = checksumKey || process.env.PAYOS_CHECKSUM_KEY?.trim();
    } else {
      if (!clientId || !apiKey || !checksumKey) {
        throw new InternalServerErrorException(
          'Môi trường production yêu cầu cấu hình bắt buộc bộ khóa PAYOS_PAYOUT_CLIENT_ID, PAYOS_PAYOUT_API_KEY, PAYOS_PAYOUT_CHECKSUM_KEY riêng cho chi hộ',
        );
      }
    }
    return { clientId, apiKey, checksumKey };
  }

  private isMockMode(clientId?: string): boolean {
    return process.env.PAYOS_MOCK_PAYOUT === 'true' || clientId === 'mock_client_id';
  }

  private async fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    const abortController = new AbortController();
    const timeoutHandle = setTimeout(() => abortController.abort(), timeoutMs);
    try {
      return await fetch(url, { ...init, signal: abortController.signal });
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  private classifyRejection(httpStatus: number, result: any): Error {
    const payosCode = String(result?.code ?? 'UNKNOWN');
    const message = result?.desc || 'Tạo yêu cầu chi tiền PayOS thất bại';
    this.logger.error(`PayOS Payout API error [${payosCode}] (HTTP ${httpStatus}): ${message}`);
    if (PRE_DISPATCH_HTTP_STATUS.has(httpStatus) || PRE_DISPATCH_REJECT_CODES.has(payosCode)) {
      return new PayOSPayoutPreDispatchException(payosCode, message, result);
    }
    return new PayOSPayoutIndeterminateException(payosCode, message, result);
  }

  private checkResponseSignature(response: Response, result: any, checksumKey: string): void {
    const resSignature = response.headers?.get?.('x-signature');
    if (!resSignature || !result?.data) return;
    if (verifyPayoutSignature(result.data, resSignature, checksumKey)) return;

    this.logger.error('[PayOS Payout] Chữ ký x-signature của response không hợp lệ.');
    // Công thức ký response chưa được đối chiếu với tài liệu CAS => mặc định chỉ cảnh báo,
    // bật PAYOS_PAYOUT_ENFORCE_RESPONSE_SIGNATURE=true để coi là "chưa rõ kết quả" sau khi đã kiểm chứng.
    if (process.env.PAYOS_PAYOUT_ENFORCE_RESPONSE_SIGNATURE === 'true') {
      throw new PayOSPayoutIndeterminateException(
        'RESPONSE_SIGNATURE_INVALID',
        'Chữ ký phản hồi từ PayOS Payout không hợp lệ, cần đối soát trạng thái lệnh chi',
      );
    }
  }

  createPayoutSignature(params: PayosPayoutRequestParams): string {
    const { checksumKey } = this.getCredentials();
    if (!checksumKey) {
      throw new InternalServerErrorException('PAYOS_PAYOUT_CHECKSUM_KEY chưa được cấu hình trong server .env');
    }
    return signPayoutRequest(params, checksumKey);
  }

  async createPayout(params: PayosPayoutRequestParams): Promise<PayOSCreatePayoutResult> {
    const { clientId, apiKey, checksumKey } = this.getCredentials();

    if (!clientId || !apiKey || !checksumKey) {
      throw new InternalServerErrorException(
        'Chưa cấu hình đầy đủ PAYOS_PAYOUT_CLIENT_ID, PAYOS_PAYOUT_API_KEY, PAYOS_PAYOUT_CHECKSUM_KEY trong server .env',
      );
    }

    const signature = signPayoutRequest(params, checksumKey);

    const isMock = this.isMockMode(clientId);
    const isAllowedMockEnv = ['test', 'development', 'local'].includes(process.env.NODE_ENV || '');

    if (isMock) {
      if (!isAllowedMockEnv) {
        throw new BadRequestException('Chế độ giả lập PayOS Payout bị cấm tuyệt đối trên môi trường Staging/Production');
      }
      this.logger.log(`[PayOS Payout Mock] Creating simulated payout for ref: ${params.referenceId}`);
      return {
        code: '00',
        desc: 'success',
        data: {
          id: `payout_mock_${Date.now()}`,
          referenceId: params.referenceId,
          approvalState: 'PROCESSING',
          amount: params.amount,
          transactions: [
            {
              id: `txn_mock_${Date.now()}`,
              referenceId: params.referenceId,
              amount: params.amount,
              description: params.description,
              toBin: params.toBin,
              toAccountNumber: params.toAccountNumber,
              state: 'PROCESSING',
            },
          ],
        },
      };
    }

    // Từ lúc gọi fetch trở đi, mọi lỗi không phải "PayOS từ chối rõ ràng" đều là kết quả chưa rõ.
    let response: Response;
    let result: any;
    try {
      response = await this.fetchWithTimeout(
        `${this.baseUrl}/v1/payouts`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-client-id': clientId,
            'x-api-key': apiKey,
            'x-idempotency-key': params.referenceId,
            'x-signature': signature,
          },
          body: JSON.stringify(params),
        },
        10000,
      );
    } catch (err: any) {
      this.logger.error(`PayOS Payout request network error: ${err?.message}`);
      throw new PayOSPayoutIndeterminateException(
        'NETWORK_ERROR',
        `Lỗi kết nối tới PayOS Payout API (chưa rõ lệnh đã được gửi hay chưa): ${err?.message}`,
      );
    }

    try {
      result = await response.json();
    } catch (err: any) {
      if (PRE_DISPATCH_HTTP_STATUS.has(response.status)) {
        throw new PayOSPayoutPreDispatchException(String(response.status), 'PayOS từ chối yêu cầu chi tiền');
      }
      this.logger.error(`PayOS Payout response parse error (HTTP ${response.status}): ${err?.message}`);
      throw new PayOSPayoutIndeterminateException(
        'INVALID_RESPONSE',
        `Không đọc được phản hồi từ PayOS Payout API (HTTP ${response.status})`,
      );
    }

    if (result?.code !== '00') {
      throw this.classifyRejection(response.status, result);
    }

    this.checkResponseSignature(response, result, checksumKey);
    return result;
  }

  async getPayout(payoutId: string): Promise<any> {
    if (!payoutId || typeof payoutId !== 'string' || !payoutId.trim()) {
      throw new BadRequestException('Mã payout ID không hợp lệ để tra cứu');
    }
    const cleanPayoutId = payoutId.trim();

    const { clientId, apiKey } = this.getCredentials();
    if (!clientId || !apiKey) {
      throw new InternalServerErrorException('PayOS credentials missing');
    }

    const isMock = this.isMockMode(clientId);
    const isAllowedMockEnv = ['test', 'development', 'local'].includes(process.env.NODE_ENV || '');

    if (isMock) {
      if (!isAllowedMockEnv) {
        throw new BadRequestException('Chế độ giả lập PayOS Payout bị cấm tuyệt đối trên môi trường Staging/Production');
      }
      return {
        code: '00',
        desc: 'success',
        data: {
          id: cleanPayoutId,
          referenceId: cleanPayoutId,
          approvalState: 'SUCCEEDED',
          amount: 200000,
          transactions: [{ id: `txn_${cleanPayoutId}`, referenceId: cleanPayoutId, amount: 200000, state: 'SUCCEEDED' }],
        },
      };
    }

    try {
      const encodedPayoutId = encodeURIComponent(cleanPayoutId);
      const response = await this.fetchWithTimeout(
        `${this.baseUrl}/v1/payouts/${encodedPayoutId}`,
        { method: 'GET', headers: { 'x-client-id': clientId, 'x-api-key': apiKey } },
        8000,
      );
      return await response.json();
    } catch (err: any) {
      this.logger.error(`PayOS getPayout error: ${err.message}`);
      throw new InternalServerErrorException(`Không thể tra cứu payout: ${err.message}`);
    }
  }

  async getPayouts(params?: {
    referenceId?: string;
    approvalState?: string;
    category?: string;
    fromDate?: string;
    toDate?: string;
    limit?: number;
    offset?: number;
  }): Promise<any> {
    const { clientId, apiKey } = this.getCredentials();
    if (!clientId || !apiKey) {
      throw new InternalServerErrorException('PayOS credentials missing');
    }

    if (this.isMockMode(clientId)) {
      return {
        code: '00',
        desc: 'success',
        data: {
          payouts: [],
          pagination: {
            total: 0,
            limit: params?.limit || 10,
            offset: params?.offset || 0,
            count: 0,
            hasMore: false,
          },
        },
      };
    }

    const query = new URLSearchParams();
    if (params?.referenceId) query.append('referenceId', params.referenceId);
    if (params?.approvalState) query.append('approvalState', params.approvalState);
    if (params?.category) query.append('category', params.category);
    if (params?.fromDate) query.append('fromDate', params.fromDate);
    if (params?.toDate) query.append('toDate', params.toDate);
    if (params?.limit) query.append('limit', params.limit.toString());
    if (params?.offset) query.append('offset', params.offset.toString());

    try {
      const response = await this.fetchWithTimeout(
        `${this.baseUrl}/v1/payouts?${query.toString()}`,
        { method: 'GET', headers: { 'x-client-id': clientId, 'x-api-key': apiKey } },
        8000,
      );
      return await response.json();
    } catch (err: any) {
      this.logger.error(`PayOS getPayouts error: ${err.message}`);
      throw new InternalServerErrorException(`Không thể tra cứu danh sách payout: ${err.message}`);
    }
  }

  async createBatchPayout(params: PayosBatchPayoutRequestParams): Promise<any> {
    const { clientId, apiKey, checksumKey } = this.getCredentials();
    if (!clientId || !apiKey || !checksumKey) {
      throw new InternalServerErrorException('Chưa cấu hình đầy đủ credentials cho PayOS Payout');
    }

    const signature = signPayoutRequest(params, checksumKey);

    if (this.isMockMode(clientId)) {
      return {
        code: '00',
        desc: 'success',
        data: {
          id: `batch_${Date.now()}`,
          referenceId: params.referenceId,
          approvalState: 'PROCESSING',
          transactions: params.payouts.map((p, idx) => ({
            id: `batch_txn_${Date.now()}_${idx}`,
            referenceId: p.referenceId,
            amount: p.amount,
            description: p.description,
            toBin: p.toBin,
            toAccountNumber: p.toAccountNumber,
            state: 'PROCESSING',
          })),
        },
      };
    }

    try {
      const response = await this.fetchWithTimeout(
        `${this.baseUrl}/v1/payouts/batch`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-client-id': clientId,
            'x-api-key': apiKey,
            'x-idempotency-key': params.referenceId,
            'x-signature': signature,
          },
          body: JSON.stringify(params),
        },
        15000,
      );
      return await response.json();
    } catch (err: any) {
      this.logger.error(`PayOS createBatchPayout error: ${err.message}`);
      throw new PayOSPayoutIndeterminateException(
        'NETWORK_ERROR',
        `Lỗi kết nối tới PayOS Batch Payout API (chưa rõ lô lệnh đã được gửi hay chưa): ${err.message}`,
      );
    }
  }

  async estimateCredit(params: PayosBatchPayoutRequestParams): Promise<any> {
    const { clientId, apiKey, checksumKey } = this.getCredentials();
    if (!clientId || !apiKey) {
      throw new InternalServerErrorException('PayOS credentials missing');
    }

    if (this.isMockMode(clientId)) {
      return {
        code: '00',
        desc: 'success',
        data: {
          estimateCredit: 5000,
        },
      };
    }

    // Tài liệu CAS yêu cầu x-signature cho endpoint ước tính phí.
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-client-id': clientId,
      'x-api-key': apiKey,
    };
    if (checksumKey) headers['x-signature'] = signPayoutRequest(params, checksumKey);

    try {
      const response = await this.fetchWithTimeout(
        `${this.baseUrl}/v1/payouts/estimate-credit`,
        { method: 'POST', headers, body: JSON.stringify(params) },
        8000,
      );
      return await response.json();
    } catch (err: any) {
      this.logger.error(`PayOS estimateCredit error: ${err.message}`);
      throw new InternalServerErrorException(`Lỗi kết nối tới PayOS Estimate Credit API: ${err.message}`);
    }
  }

  async getPayoutBalance(): Promise<PayOSPayoutBalanceResult> {
    const { clientId, apiKey } = this.getCredentials();
    if (!clientId || !apiKey) {
      throw new InternalServerErrorException('PayOS credentials missing');
    }

    if (this.isMockMode(clientId)) {
      return {
        code: '00',
        desc: 'success',
        data: {
          accountNumber: '123456789',
          accountName: 'CONG TY ABC TEST',
          currency: 'VND',
          balance: '50000000',
        },
      };
    }

    let result: any;
    try {
      const response = await this.fetchWithTimeout(
        `${this.baseUrl}/v1/payouts-account/balance`,
        { method: 'GET', headers: { 'x-client-id': clientId, 'x-api-key': apiKey } },
        8000,
      );
      result = await response.json();
    } catch (err: any) {
      this.logger.error(`PayOS getPayoutBalance network error: ${err.message}`);
      throw new InternalServerErrorException(`Lỗi kết nối tới PayOS Payout: ${err.message}`);
    }

    if (result && result.code !== '00') {
      this.logger.warn(`[PayOS Payout] Kênh chi hộ (Payout) trả mã lỗi ${result.code}: ${result.desc}`);
      throw new BadRequestException({
        success: false,
        code: result.code === '601' ? 'PAYOS_PAYOUT_NOT_CONFIGURED' : 'PAYOS_PAYOUT_ERROR',
        message: result.desc || `API Key PayOS chưa được kích hoạt quyền Chi hộ (Payout) hoặc không tồn tại (Code: ${result.code})`,
        details: result,
      });
    }
    return result;
  }
}
