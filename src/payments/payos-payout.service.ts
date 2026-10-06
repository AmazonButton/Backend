import {
  Injectable,
  Logger,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import {
  signPayoutRequest,
  PayosPayoutRequestParams,
} from './payos.helper';

export interface PayOSCreatePayoutResult {
  code: string;
  desc: string;
  data?: {
    id: string;
    referenceId: string;
    approvalState: string;
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
    const clientId = process.env.PAYOS_CLIENT_ID?.trim();
    const apiKey = process.env.PAYOS_API_KEY?.trim();
    const checksumKey = process.env.PAYOS_CHECKSUM_KEY?.trim();

    return { clientId, apiKey, checksumKey };
  }

  createPayoutSignature(params: PayosPayoutRequestParams): string {
    const { checksumKey } = this.getCredentials();
    if (!checksumKey) {
      throw new InternalServerErrorException('PAYOS_CHECKSUM_KEY chua du?c c?u hình');
    }
    return signPayoutRequest(params, checksumKey);
  }

  async createPayout(params: PayosPayoutRequestParams): Promise<PayOSCreatePayoutResult> {
    const { clientId, apiKey, checksumKey } = this.getCredentials();

    if (!clientId || !apiKey || !checksumKey) {
      throw new InternalServerErrorException(
        'Chua c?u hình d?y d? PAYOS_CLIENT_ID, PAYOS_API_KEY, PAYOS_CHECKSUM_KEY trong server .env'
      );
    }

    const signature = signPayoutRequest(params, checksumKey);

    // Support local mock or dry-run if PAYOS_MOCK_PAYOUT=true or clientId starts with 'test'/'mock'
    if (process.env.PAYOS_MOCK_PAYOUT === 'true' || clientId === 'mock_client_id') {
      this.logger.log(`[PayOS Payout Mock] Creating simulated payout for ref: ${params.referenceId}`);
      return {
        code: '00',
        desc: 'success',
        data: {
          id: `payout_mock_${Date.now()}`,
          referenceId: params.referenceId,
          approvalState: 'PROCESSING',
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
      });

      const result = await response.json();

      if (result.code !== '00') {
        this.logger.error(`PayOS Payout API error: ${result.desc || JSON.stringify(result)}`);
        throw new BadRequestException({
          success: false,
          code: 'PAYOS_PAYOUT_FAILED',
          message: result.desc || 'T?o yêu c?u chi ti?n PayOS th?t b?i',
          details: result,
        });
      }

      return result;
    } catch (err: any) {
      if (err instanceof BadRequestException) throw err;
      this.logger.error(`PayOS Payout request network error: ${err.message}`);
      throw new InternalServerErrorException(`L?i k?t n?i t?i PayOS Payout API: ${err.message}`);
    }
  }

  async getPayout(payoutId: string): Promise<any> {
    const { clientId, apiKey } = this.getCredentials();
    if (!clientId || !apiKey) {
      throw new InternalServerErrorException('PayOS credentials missing');
    }

    if (process.env.PAYOS_MOCK_PAYOUT === 'true' || clientId === 'mock_client_id') {
      return {
        code: '00',
        desc: 'success',
        data: {
          id: payoutId,
          approvalState: 'SUCCEEDED',
          transactions: [{ id: `txn_${payoutId}`, state: 'SUCCEEDED' }],
        },
      };
    }

    try {
      const response = await fetch(`${this.baseUrl}/v1/payouts/${payoutId}`, {
        method: 'GET',
        headers: {
          'x-client-id': clientId,
          'x-api-key': apiKey,
        },
      });
      return await response.json();
    } catch (err: any) {
      this.logger.error(`PayOS getPayout error: ${err.message}`);
      throw new InternalServerErrorException(`Không th? tra c?u payout: ${err.message}`);
    }
  }

  async getPayouts(params?: { referenceId?: string; approvalState?: string; limit?: number; offset?: number }): Promise<any> {
    const { clientId, apiKey } = this.getCredentials();
    if (!clientId || !apiKey) {
      throw new InternalServerErrorException('PayOS credentials missing');
    }

    const query = new URLSearchParams();
    if (params?.referenceId) query.append('referenceId', params.referenceId);
    if (params?.approvalState) query.append('approvalState', params.approvalState);
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
      throw new InternalServerErrorException(`Không th? tra c?u danh sách payout: ${err.message}`);
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

    try {
      const response = await fetch(`${this.baseUrl}/v1/payouts-account/balance`, {
        method: 'GET',
        headers: {
          'x-client-id': clientId,
          'x-api-key': apiKey,
        },
      });
      return await response.json();
    } catch (err: any) {
      this.logger.error(`PayOS getPayoutBalance error: ${err.message}`);
      throw new InternalServerErrorException(`Không th? l?y s? du chi PayOS: ${err.message}`);
    }
  }
}
