import { Decimal } from '@prisma/client/runtime/library';
import {
  verifyPayosPayoutEvidence,
  PayosPayoutExpectedCriteria,
} from '../payments/payos-payout-verifier';

export interface PayoutReconciliationResult {
  isVerified: boolean;
  providerRef: string;
  reportedAmount: number;
  reason?: string;
}

/**
 * Verifier dùng chung nghiêm ngặt cho cả Worker và Admin API hoàn cọc thiết bị.
 * Ủy quyền trực tiếp cho bộ xác minh chuẩn hệ thống `verifyPayosPayoutEvidence`
 * để đảm bảo tính bất biến, chống đối chiếu bằng ID kỹ thuật (NV-14)
 * và phát hiện mâu thuẫn giữa số tài khoản và mã băm (NV-15).
 */
export function verifyDepositRefundPayoutEvidence(
  payoutData: any,
  refund: {
    amount: number | string | Decimal;
    refundCode: string;
    providerReferenceId?: string | null;
    recipientBin?: string | null;
    recipientAccountNumberHash?: string | null;
    recipientAccountNumberMasked?: string | null;
  },
): PayoutReconciliationResult {
  const criteria: PayosPayoutExpectedCriteria = {
    amount: refund.amount,
    payoutReference: refund.refundCode,
    expectedPayoutId: refund.providerReferenceId || undefined,
    targetBankBin: refund.recipientBin,
    targetAccountHash: refund.recipientAccountNumberHash,
  };

  const result = verifyPayosPayoutEvidence(payoutData, criteria);
  return {
    isVerified: result.isVerified,
    providerRef: result.providerPayoutId,
    reportedAmount: result.reportedAmount,
    reason: result.reason,
  };
}
