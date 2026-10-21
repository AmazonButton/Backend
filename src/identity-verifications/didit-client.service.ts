import {
  Injectable,
  Logger,
  BadGatewayException,
  GatewayTimeoutException,
} from '@nestjs/common';

export interface DiditCreateSessionResponse {
  session_id: string;
  url: string;
  status: string;
  expires_at?: string;
  workflow_id?: string;
  vendor_data?: string;
}

export interface DiditDecisionResponse {
  status: string;
  session_id?: string;
  decision?: any;
  created_at?: string;
  updated_at?: string;
}

@Injectable()
export class DiditClientService {
  private readonly logger = new Logger(DiditClientService.name);
  private readonly baseUrl: string;
  private readonly deleteUrl: string;
  private readonly apiKey: string;
  private readonly workflowId: string;
  private readonly requestTimeoutMs = 10000;

  constructor() {
    this.baseUrl =
      process.env.DIDIT_BASE_URL || 'https://verification.didit.me/v3';
    this.deleteUrl =
      process.env.DIDIT_DELETE_URL || 'https://verification.didit.me/v1';
    this.apiKey = process.env.DIDIT_API_KEY || '';
    this.workflowId = process.env.DIDIT_WORKFLOW_ID || '';
  }

  /**
   * Safe fetch wrapper with timeout, x-api-key header, and secret leakage prevention
   */
  private async executeRequest<T>(
    url: string,
    options: RequestInit,
    endpointName: string,
  ): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    const headers: Record<string, string> = {
      'x-api-key': this.apiKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...((options.headers as Record<string, string>) || {}),
    };

    try {
      const response = await fetch(url, {
        ...options,
        headers,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const responseText = await response.text();
      let responseData: any = {};
      try {
        responseData = responseText ? JSON.parse(responseText) : {};
      } catch {
        responseData = { raw: responseText };
      }

      if (!response.ok) {
        this.logger.error(
          `[DiditClient] ${endpointName} failed with HTTP ${response.status}`,
        );

        if (response.status >= 500) {
          throw new BadGatewayException(
            'Cổng định danh danh tính đối tác (Didit) đang gặp sự cố. Vui lòng thử lại sau.',
          );
        }

        throw new BadGatewayException(
          `Yêu cầu đến cổng định danh Didit không thành công (${response.status})`,
        );
      }

      return responseData as T;
    } catch (error: any) {
      clearTimeout(timeoutId);

      if (error?.name === 'AbortError') {
        this.logger.error(`[DiditClient] ${endpointName} timed out after ${this.requestTimeoutMs}ms`);
        throw new GatewayTimeoutException(
          'Kết nối đến cổng định danh Didit bị quá thời gian chờ (timeout).',
        );
      }

      if (error instanceof BadGatewayException || error instanceof GatewayTimeoutException) {
        throw error;
      }

      this.logger.error(`[DiditClient] ${endpointName} network error: ${error.message}`);
      throw new BadGatewayException(
        'Không thể kết nối đến cổng định danh đối tác. Vui lòng kiểm tra kết nối mạng.',
      );
    }
  }

  /**
   * Create a new verification session via Didit API v3
   * POST https://verification.didit.me/v3/session/
   */
  async createSession(
    vendorData: string,
    callbackUrl: string,
  ): Promise<DiditCreateSessionResponse> {
    const url = `${this.baseUrl.replace(/\/+$/, '')}/session/`;
    const payload = {
      workflow_id: this.workflowId,
      vendor_data: vendorData,
      callback: callbackUrl,
    };

    return this.executeRequest<DiditCreateSessionResponse>(
      url,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
      'CreateSession',
    );
  }

  /**
   * Retrieve decision details for a session via Didit API v3
   * GET https://verification.didit.me/v3/session/{sessionId}/decision/
   */
  async getDecision(diditSessionId: string): Promise<DiditDecisionResponse> {
    const url = `${this.baseUrl.replace(/\/+$/, '')}/session/${encodeURIComponent(
      diditSessionId,
    )}/decision/`;

    return this.executeRequest<DiditDecisionResponse>(
      url,
      {
        method: 'GET',
      },
      'GetDecision',
    );
  }

  /**
   * Delete session via Didit API v1
   * DELETE https://verification.didit.me/v1/session/{sessionId}/delete/
   */
  async deleteSession(diditSessionId: string): Promise<{ success: boolean }> {
    const url = `${this.deleteUrl.replace(/\/+$/, '')}/session/${encodeURIComponent(
      diditSessionId,
    )}/delete/`;

    return this.executeRequest<{ success: boolean }>(
      url,
      {
        method: 'DELETE',
      },
      'DeleteSession',
    );
  }
}
