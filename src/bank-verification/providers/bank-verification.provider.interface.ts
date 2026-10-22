export interface BankAccountLookupResult {
  bankBin: string;
  bankName: string;
  accountNumber: string;
  accountName: string;
}

export interface BankRefundParams {
  bankBin: string;
  accountNumber: string;
  accountName?: string;
  amount: number;
  referenceId: string;
  description: string;
}

export interface BankRefundResult {
  refundTransactionId: string;
  status: 'PENDING' | 'SUCCESS' | 'FAILED';
  rawResponse?: any;
}

export interface BankVerificationProvider {
  /**
   * Lookup bank account holder name via NAPAS / VietQR directory
   */
  lookupAccount(bankBin: string, accountNumber: string): Promise<BankAccountLookupResult>;

  /**
   * Initiate payout refund of 2,000 VND to verified bank account
   */
  createRefund(params: BankRefundParams): Promise<BankRefundResult>;

  /**
   * Query transaction details by provider transaction ID
   */
  getTransaction(transactionId: string): Promise<any>;

  /**
   * Verify HMAC signature of incoming inbound webhook
   */
  verifyWebhook(
    rawBody: Buffer,
    signature: string,
    headers: Record<string, string>,
  ): boolean | Promise<boolean>;
}

export const BANK_VERIFICATION_PROVIDER_TOKEN = 'BANK_VERIFICATION_PROVIDER_TOKEN';
