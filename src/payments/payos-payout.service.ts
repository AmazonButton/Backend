import {
  Injectable,
  Logger,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import {
  signPayoutRequest,
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

@Injectable()
export class PayOSPayoutService {
  private readonly logger = new Logger(PayOSPayoutService.name);
  private readonly baseUrl = 'https://api-merchant.payos.vn';

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

  createPayoutSignature(params: PayosPayoutRequestParams): string {
    const { checksumKey } = this.getCredentials();
    if (!checksumKey) {
      throw new InternalServerErrorException('PAYOS_CHECKSUM_KEY chua du?c c?u h�nh');
    }
    return signPayoutRequest(params, checksumKey);
  }

  async createPayout(params: PayosPayoutRequestParams): Promise<PayOSCreatePayoutResult> {
    const { clientId, apiKey, checksumKey } = this.getCredentials();

    if (!clientId || !apiKey || !checksumKey) {
      throw new InternalServerErrorException(
        'Chua c?u h�nh d?y d? PAYOS_CLIENT_ID, PAYOS_API_KEY, PAYOS_CHECKSUM_KEY trong server .env'
      );
    }

    const signature = signPayoutRequest(params, checksumKey);

    // Support local mock or dry-run if PAYOS_MOCK_PAYOUT=true or clientId starts with 'test'/'mock'
    const isMock = process.env.PAYOS_MOCK_PAYOUT === 'true' || clientId === 'mock_client_id';
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

    const abortController = new AbortController();
    const timeoutHandle = setTimeout(() => abortController.abort(), 10000);
    try {
      const response = await fetch(`${this.baseUrl}/v1/payouts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-client-id': clientId,
          'x-api-key': apiKey,
          'x-idempotency-key': params.referenceId,
          'x-signature': signature,
        },
        body: JSON.stringify(params),
        signal: abortController.signal,
      });

      const result = await response.json();

      if (result.code !== '00') {
        this.logger.error(`PayOS Payout API error: ${result.desc || JSON.stringify(result)}`);
        throw new BadRequestException({
          success: false,
          code: 'PAYOS_PAYOUT_FAILED',
          message: result.desc || 'T?o y�u c?u chi ti?n PayOS th?t b?i',
          details: result,
        });
      }

      return result;
    } catch (err: any) {
      if (err instanceof BadRequestException) throw err;
      this.logger.error(`PayOS Payout request network error: ${err.message}`);
      throw new InternalServerErrorException(`Lỗi kết nối tới PayOS Payout API: ${err.message}`);
    } finally {
      clearTimeout(timeoutHandle);
    }
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

    const isMock = process.env.PAYOS_MOCK_PAYOUT === 'true' || clientId === 'mock_client_id';
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

    const abortController = new AbortController();
    const timeoutHandle = setTimeout(() => abortController.abort(), 8000);
    try {
      const encodedPayoutId = encodeURIComponent(cleanPayoutId);
      const response = await fetch(`${this.baseUrl}/v1/payouts/${encodedPayoutId}`, {
        method: 'GET',
        headers: {
          'x-client-id': clientId,
          'x-api-key': apiKey,
        },
        signal: abortController.signal,
      });
      return await response.json();
    } catch (err: any) {
      this.logger.error(`PayOS getPayout error: ${err.message}`);
      throw new InternalServerErrorException(`Không thể tra cứu payout: ${err.message}`);
    } finally {
      clearTimeout(timeoutHandle);
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

    if (process.env.PAYOS_MOCK_PAYOUT === 'true' || clientId === 'mock_client_id') {
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
      const response = await fetch(`${this.baseUrl}/v1/payouts?${query.toString()}`, {
        method: 'GET',
        headers: {
          'x-client-id': clientId,
          'x-api-key': apiKey,
        },
      });
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

    if (process.env.PAYOS_MOCK_PAYOUT === 'true' || clientId === 'mock_client_id') {
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
      const response = await fetch(`${this.baseUrl}/v1/payouts/batch`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-client-id': clientId,
          'x-api-key': apiKey,
          'x-idempotency-key': params.referenceId,
          'x-signature': signature,
        },
        body: JSON.stringify(params),
      });
      return await response.json();
    } catch (err: any) {
      this.logger.error(`PayOS createBatchPayout error: ${err.message}`);
      throw new InternalServerErrorException(`Lỗi kết nối tới PayOS Batch Payout API: ${err.message}`);
    }
  }

  async estimateCredit(params: PayosBatchPayoutRequestParams): Promise<any> {
    const { clientId, apiKey } = this.getCredentials();
    if (!clientId || !apiKey) {
      throw new InternalServerErrorException('PayOS credentials missing');
    }

    if (process.env.PAYOS_MOCK_PAYOUT === 'true' || clientId === 'mock_client_id') {
      return {
        code: '00',
        desc: 'success',
        data: {
          estimateCredit: 5000,
        },
      };
    }

    try {
      const response = await fetch(`${this.baseUrl}/v1/payouts/estimate-credit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-client-id': clientId,
          'x-api-key': apiKey,
        },
        body: JSON.stringify(params),
      });
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

    if (process.env.PAYOS_MOCK_PAYOUT === 'true' || clientId === 'mock_client_id') {
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
      const response = await fetch(`${this.baseUrl}/v1/payouts-account/balance`, {
        method: 'GET',
        headers: {
          'x-client-id': clientId,
          'x-api-key': apiKey,
        },
      });
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
