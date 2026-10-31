import { Decimal } from '@prisma/client/runtime/library';
import * as crypto from 'crypto';

export interface PayoutReconciliationResult {
  isVerified: boolean;
  providerRef: string;
  reportedAmount: number;
  reason?: string;
}

/**
 * Verifier dùng chung nghiêm ngặt cho cả Worker và Admin API.
 * BẮT BUỘC:
 * 1. Phản hồi từ cổng thanh toán phải có payout ID thật (payoutData.id). Bắt buộc lưu và trả về payoutData.id làm providerRef để phục vụ tra cứu /v1/payouts/:payoutId. Tuyệt đối không dùng transaction ID thay thế.
 * 2. Cổng thanh toán phải trả về approvalState / state là SUCCEEDED hoặc COMPLETED.
 * 3. Phải có mảng transactions chi tiết với ít nhất 1 phần tử. Tuyệt đối không fallback sang payoutData.amount.
 * 4. Tìm chính xác transaction khớp mã refund (refundCode) hoặc providerReferenceId. Không mặc định lấy transactions[0].
 * 5. Bắt buộc transaction tìm được phải có trạng thái thành công riêng (SUCCEEDED, COMPLETED, hoặc PAID); tuyệt đối không dùng trạng thái tổng thay thế.
 * 6. Số tiền transaction.amount phải là số dương, hữu hạn, và bằng chính xác (tuyệt đối không làm tròn hai vế) với số tiền hoàn cọc refund.amount.
 * 7. So khớp BIN bắt buộc: transaction phải có BIN và phải trùng khớp 100% với recipientBin đã snapshot lúc duyệt. Tuyệt đối không fallback sang quan hệ refund.bankAccount.
 * 8. So khớp Hash tài khoản người nhận bắt buộc: tính SHA-256 hash của số tài khoản nhận từ transaction và so khớp với recipientAccountNumberHash đã snapshot lúc duyệt. Tuyệt đối không fallback sang quan hệ refund.bankAccount và không dùng riêng 4 số cuối làm bằng chứng.
 * 9. Nếu thiếu bất kỳ dữ liệu chứng minh nào: từ chối xác nhận (isVerified: false), giữ PENDING_PAYOUT để đối soát thủ công.
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
  if (!payoutData) {
    return { isVerified: false, providerRef: '', reportedAmount: 0, reason: 'Dữ liệu phản hồi từ cổng thanh toán rỗng' };
  }

  // P0 Invariant: Bắt buộc phản hồi từ cổng phải có mã PayOS payout ID thật (payoutData.id)
  const payoutId = payoutData?.id?.toString().trim();
  if (!payoutId) {
    return {
      isVerified: false,
      providerRef: '',
      reportedAmount: 0,
      reason: 'Phản hồi từ cổng thanh toán thiếu mã PayOS payout ID (payoutData.id)',
    };
  }

  // Nếu refund đã có providerReferenceId (đang trong luồng đối soát), payoutData.id phải khớp chính xác
  if (refund.providerReferenceId) {
    const expectedProviderRef = refund.providerReferenceId.toString().trim();
    if (payoutId !== expectedProviderRef) {
      return {
        isVerified: false,
        providerRef: payoutId,
        reportedAmount: 0,
        reason: `Mã payout ID từ cổng thanh toán (${payoutId}) không khớp với providerReferenceId đã lưu (${expectedProviderRef})`,
      };
    }
  }

  const approvalState = payoutData?.approvalState || payoutData?.state;
  if (approvalState !== 'COMPLETED' && approvalState !== 'SUCCEEDED') {
    return {
      isVerified: false,
      providerRef: payoutId,
      reportedAmount: 0,
      reason: `Trạng thái phê duyệt chi trả từ cổng chưa hoàn tất (hiện tại: ${approvalState || 'UNKNOWN'})`,
    };
  }

  const transactions = payoutData?.transactions;
  if (!Array.isArray(transactions) || transactions.length === 0) {
    return {
      isVerified: false,
      providerRef: payoutId,
      reportedAmount: 0,
      reason: 'Phản hồi từ cổng thanh toán thiếu danh sách giao dịch chi tiết (transactions) để làm bằng chứng đối soát',
    };
  }

  // 1. Tìm transaction khớp mã tham chiếu đã lưu (providerReferenceId hoặc refundCode)
  const expectedProviderRef = refund.providerReferenceId ? String(refund.providerReferenceId).trim() : null;
  const expectedRefundCode = refund.refundCode ? String(refund.refundCode).trim() : null;

  const matchedTxn = transactions.find((t: any) => {
    if (!t) return false;
    const tId = t.id ? String(t.id).trim() : '';
    const tRef = t.referenceId ? String(t.referenceId).trim() : t.reference ? String(t.reference).trim() : '';

    if (expectedProviderRef && (tId === expectedProviderRef || tRef === expectedProviderRef)) {
      return true;
    }
    if (expectedRefundCode && (tRef === expectedRefundCode || tId === expectedRefundCode)) {
      return true;
    }
    return false;
  });

  if (!matchedTxn) {
    return {
      isVerified: false,
      providerRef: payoutId,
      reportedAmount: 0,
      reason: `Không tìm thấy transaction chi tiết nào khớp với mã tham chiếu (providerReferenceId: ${expectedProviderRef || 'N/A'}, refundCode: ${expectedRefundCode}) trong mảng transactions`,
    };
  }

  // 2. Bắt buộc transaction có trạng thái thành công riêng; tuyệt đối không fallback sang approvalState
  const txnState = matchedTxn.state || matchedTxn.status;
  if (!txnState) {
    return {
      isVerified: false,
      providerRef: payoutId,
      reportedAmount: 0,
      reason: 'Giao dịch chi tiết thiếu trạng thái thành công riêng (status/state)',
    };
  }

  if (txnState !== 'COMPLETED' && txnState !== 'SUCCEEDED' && txnState !== 'PAID') {
    return {
      isVerified: false,
      providerRef: payoutId,
      reportedAmount: 0,
      reason: `Giao dịch chi tiết của cổng thanh toán chưa hoàn tất (trạng thái: ${txnState})`,
    };
  }

  // 3. Số tiền chi trả phải do transaction báo cáo, hữu hạn, dương và bằng CHÍNH XÁC (không làm tròn hai vế)
  const rawReportedAmount = matchedTxn.amount;
  if (
    rawReportedAmount == null ||
    typeof rawReportedAmount !== 'number' ||
    isNaN(rawReportedAmount) ||
    !Number.isFinite(rawReportedAmount) ||
    rawReportedAmount <= 0
  ) {
    return {
      isVerified: false,
      providerRef: payoutId,
      reportedAmount: 0,
      reason: 'Phản hồi từ cổng thanh toán thiếu thông tin số tiền giao dịch hợp lệ để đối soát',
    };
  }

  const reportedAmount = Number(rawReportedAmount);
  const expectedAmount = Number(refund.amount);
  if (reportedAmount !== expectedAmount) {
    return {
      isVerified: false,
      providerRef: payoutId,
      reportedAmount,
      reason: `Số tiền chi trả xác nhận từ cổng (${reportedAmount}) không khớp với số tiền hoàn cọc (${expectedAmount})`,
    };
  }

  // 4. So khớp BIN ngân hàng BẮT BUỘC: CHỈ dùng recipientBin đã snapshot, TUYỆT ĐỐI không fallback sang refund.bankAccount
  const expectedBin = refund.recipientBin?.toString().trim();
  if (!expectedBin) {
    return {
      isVerified: false,
      providerRef: payoutId,
      reportedAmount,
      reason: 'Yêu cầu hoàn cọc thiếu mã BIN người nhận trong snapshot bất biến đã duyệt',
    };
  }

  const reportedBin = (matchedTxn.toBin || matchedTxn.bin || matchedTxn.recipientBin)?.toString().trim();
  if (!reportedBin) {
    return {
      isVerified: false,
      providerRef: payoutId,
      reportedAmount,
      reason: 'Giao dịch chi tiết từ cổng thanh toán thiếu mã BIN người nhận để đối soát',
    };
  }

  if (reportedBin !== expectedBin) {
    return {
      isVerified: false,
      providerRef: payoutId,
      reportedAmount,
      reason: `Mã BIN ngân hàng nhận từ cổng (${reportedBin}) không khớp với tài khoản snapshot (${expectedBin})`,
    };
  }

  // 5. So khớp SHA-256 hash của số tài khoản người nhận BẮT BUỘC: CHỈ dùng recipientAccountNumberHash đã snapshot, TUYỆT ĐỐI không fallback sang refund.bankAccount
  const expectedAccountHash = refund.recipientAccountNumberHash?.toString().trim();
  if (!expectedAccountHash) {
    return {
      isVerified: false,
      providerRef: payoutId,
      reportedAmount,
      reason: 'Yêu cầu hoàn cọc thiếu SHA-256 hash tài khoản nhận trong snapshot bất biến đã duyệt',
    };
  }

  let reportedAccountHash = (matchedTxn.accountNumberHash || matchedTxn.recipientAccountNumberHash)?.toString().trim();
  const reportedAccountNumber = (matchedTxn.toAccountNumber || matchedTxn.accountNumber)?.toString().trim();

  if (!reportedAccountHash && reportedAccountNumber) {
    reportedAccountHash = crypto.createHash('sha256').update(reportedAccountNumber).digest('hex');
  }

  if (!reportedAccountHash) {
    return {
      isVerified: false,
      providerRef: payoutId,
      reportedAmount,
      reason: 'Giao dịch chi tiết từ cổng thanh toán thiếu thông tin số tài khoản/hash người nhận để đối soát',
    };
  }

  if (reportedAccountHash !== expectedAccountHash) {
    return {
      isVerified: false,
      providerRef: payoutId,
      reportedAmount,
      reason: 'Số tài khoản nhận từ cổng không khớp với tài khoản snapshot đã chốt',
    };
  }

  return {
    isVerified: true,
    providerRef: payoutId,
    reportedAmount,
  };
}
