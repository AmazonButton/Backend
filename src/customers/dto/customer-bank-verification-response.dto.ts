export class CustomerBankVerificationSessionResponseDto {
  accountId: string;
  sessionReference: string;
  orderCode: string;
  checkoutUrl: string;
  amount: number;
  sessionStatus: string;
  verificationStatus: string;
  expiresAt: string;
  message: string;
}

export class CustomerBankVerificationRefundSummaryDto {
  totalObligationAmount: number;
  totalRefundedAmount: number;
  totalPendingRefundAmount: number;
}

export class CustomerBankVerificationStatusResponseDto {
  accountId: string;
  bankBin: string;
  bankCode?: string | null;
  bankName: string;
  accountNumberMasked: string;
  accountName: string;
  accountVerificationStatus: string;
  session?: {
    sessionReference: string;
    sessionStatus: string;
    verificationStatus: string;
    paymentStatus: string;
    refundStatus: string;
    refundSummary: CustomerBankVerificationRefundSummaryDto;
    expiresAt: string;
    isExpired: boolean;
    rejectionReason?: string | null;
    checkoutUrl?: string | null;
  } | null;
  message: string;
}

export class CustomerBankVerificationHistoryItemDto {
  sessionId: string;
  sessionReference: string;
  orderCode?: string | null;
  accountId?: string | null;
  bankBin?: string | null;
  bankName?: string | null;
  accountNumberMasked?: string | null;
  accountName?: string | null;
  checkoutUrl?: string | null;
  sessionStatus: string;
  verificationStatus: string;
  paymentReceived: boolean;
  receivedAmount?: number | null;
  refundStatus: string;
  totalObligationAmount?: number;
  totalRefundedAmount?: number;
  totalPendingRefundAmount?: number;
  expiresAt: string;
  verifiedAt?: string | null;
  createdAt: string;
}

