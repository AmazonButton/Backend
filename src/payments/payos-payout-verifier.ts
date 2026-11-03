import { Decimal } from '@prisma/client/runtime/library';
import { CryptoVaultUtil } from '../common/utils/crypto-vault.util';

export interface PayosPayoutVerificationResult {
  isVerified: boolean;
  providerPayoutId: string;
  reportedAmount: number;
  matchedTxId?: string;
  reason?: string;
}

export interface PayosPayoutExpectedCriteria {
  amount: number | string | Decimal;
  payoutReference: string;
  targetBankBin?: string | null;
  targetAccountHash?: string | null;
  expectedPayoutId?: string | null;
}

/**
 * Bộ xác minh bằng chứng Payout dùng chung nghiêm ngặt cho toàn bộ hệ thống
 * (Fail-Closed, zero ambiguity, áp dụng đồng nhất cho cả hoàn cọc thiết bị và hoàn tiền xác minh 2.000đ)
 *
 * Tiêu chí kiểm định bắt buộc:
 * 1. Phản hồi có mã PayOS Payout ID thật (payoutData.id). Khớp expectedPayoutId nếu được cung cấp.
 * 2. Bắt buộc đầy đủ snapshot thông tin người nhận (targetBankBin và targetAccountHash) từ phía hệ thống.
 * 3. Trạng thái tổng approvalState / state là SUCCEEDED hoặc COMPLETED.
 * 4. Mảng transactions chi tiết hiện diện và không rỗng.
 * 5. Đúng duy nhất một giao dịch khớp referenceId / reference (không lấy transaction ID thay reference, không chấp nhận trùng reference).
 * 6. Giao dịch chi tiết có trạng thái thành công riêng (SUCCEEDED, COMPLETED, hoặc PAID).
 * 7. Số tiền báo cáo là số nguyên dương hợp lệ và bằng chính xác với số tiền cần hoàn.
 * 8. Bắt buộc có thông tin người nhận từ provider: Khớp mã BIN ngân hàng nhận và Hash số tài khoản nhận (Fail-Closed).
 */
export function verifyPayosPayoutEvidence(
  payoutData: any,
  expected: PayosPayoutExpectedCriteria,
): PayosPayoutVerificationResult {
  if (!payoutData) {
    return {
      isVerified: false,
      providerPayoutId: '',
      reportedAmount: 0,
      reason: 'Dữ liệu phản hồi từ cổng PayOS rỗng',
    };
  }

  // 1. Phản hồi phải có payout ID thật
  const payoutId = payoutData?.id?.toString().trim();
  if (!payoutId) {
    return {
      isVerified: false,
      providerPayoutId: '',
      reportedAmount: 0,
      reason: 'Phản hồi từ PayOS thiếu mã payout ID thật (payoutData.id)',
    };
  }

  // 1b. Khớp expectedPayoutId nếu hệ thống đã tra cứu theo ID cụ thể
  if (expected.expectedPayoutId) {
    const expId = String(expected.expectedPayoutId).trim();
    if (expId && payoutId !== expId) {
      return {
        isVerified: false,
        providerPayoutId: payoutId,
        reportedAmount: 0,
        reason: `Mã Payout ID trong detail (${payoutId}) không khớp với ID đã tra cứu (${expId})`,
      };
    }
  }

  // 2. Snapshot thụ hưởng phía hệ thống bắt buộc phải đầy đủ (Fail-Closed)
  const expectedBin = expected.targetBankBin ? String(expected.targetBankBin).trim() : '';
  const expectedHash = expected.targetAccountHash ? String(expected.targetAccountHash).trim() : '';
  if (!expectedBin || !expectedHash) {
    return {
      isVerified: false,
      providerPayoutId: payoutId,
      reportedAmount: 0,
      reason: 'Thiếu snapshot thông tin người nhận (targetBankBin hoặc targetAccountHash) để đối soát',
    };
  }

  // 3. Trạng thái phê duyệt tổng thể
  const approvalState = payoutData?.approvalState || payoutData?.state;
  if (approvalState !== 'COMPLETED' && approvalState !== 'SUCCEEDED') {
    return {
      isVerified: false,
      providerPayoutId: payoutId,
      reportedAmount: 0,
      reason: `Trạng thái phê duyệt chi trả chưa hoàn tất (hiện tại: ${approvalState || 'UNKNOWN'})`,
    };
  }

  // 4. Mảng transactions chi tiết
  const transactions = payoutData?.transactions;
  if (!Array.isArray(transactions) || transactions.length === 0) {
    return {
      isVerified: false,
      providerPayoutId: payoutId,
      reportedAmount: 0,
      reason: 'Phản hồi từ cổng PayOS thiếu danh sách giao dịch chi tiết (transactions)',
    };
  }

  // 5. Lọc đúng referenceId, yêu cầu DUY NHẤT MỘT transaction khớp (không dùng transaction.id thay reference)
  const expectedRef = expected.payoutReference ? String(expected.payoutReference).trim() : '';
  if (!expectedRef) {
    return {
      isVerified: false,
      providerPayoutId: payoutId,
      reportedAmount: 0,
      reason: 'Thiếu payoutReference cần xác minh',
    };
  }

  const matchingTxns = transactions.filter((t: any) => {
    if (!t) return false;
    const tRef = t.referenceId ? String(t.referenceId).trim() : (t.reference ? String(t.reference).trim() : '');
    return tRef === expectedRef;
  });

  if (matchingTxns.length === 0) {
    return {
      isVerified: false,
      providerPayoutId: payoutId,
      reportedAmount: 0,
      reason: `Không tìm thấy transaction chi tiết nào khớp với payoutReference (${expectedRef})`,
    };
  }

  if (matchingTxns.length > 1) {
    return {
      isVerified: false,
      providerPayoutId: payoutId,
      reportedAmount: 0,
      reason: `Phát hiện nhiều hơn một transaction (${matchingTxns.length}) trùng payoutReference (${expectedRef}) trong cùng payout`,
    };
  }

  const matchedTxn = matchingTxns[0];

  // 6. Trạng thái thành công riêng của transaction
  const txnState = matchedTxn.state || matchedTxn.status;
  if (txnState !== 'COMPLETED' && txnState !== 'SUCCEEDED' && txnState !== 'PAID') {
    return {
      isVerified: false,
      providerPayoutId: payoutId,
      reportedAmount: 0,
      reason: `Giao dịch chi tiết chưa thành công (trạng thái: ${txnState || 'UNKNOWN'})`,
    };
  }

  // 7. Số tiền chi trả phải là số nguyên dương và bằng chính xác với số tiền cần hoàn
  const rawReportedAmount = matchedTxn.amount;
  if (
    rawReportedAmount == null ||
    typeof rawReportedAmount !== 'number' ||
    !Number.isInteger(rawReportedAmount) ||
    rawReportedAmount <= 0
  ) {
    return {
      isVerified: false,
      providerPayoutId: payoutId,
      reportedAmount: 0,
      reason: 'Giao dịch chi tiết thiếu thông tin số tiền nguyên dương hợp lệ',
    };
  }

  const reportedAmount = Number(rawReportedAmount);
  const expectedAmount = Number(expected.amount);
  if (!Number.isInteger(expectedAmount) || expectedAmount <= 0 || reportedAmount !== expectedAmount) {
    return {
      isVerified: false,
      providerPayoutId: payoutId,
      reportedAmount,
      reason: `Số tiền chi trả xác nhận (${reportedAmount}) không khớp với nghĩa vụ hoàn (${expectedAmount})`,
    };
  }

  // 8. So khớp BIN ngân hàng nhận (Fail-Closed: bắt buộc có từ provider và khớp chính xác)
  const reportedBin = (matchedTxn.toBin || matchedTxn.bin || matchedTxn.recipientBin)?.toString().trim();
  if (!reportedBin) {
    return {
      isVerified: false,
      providerPayoutId: payoutId,
      reportedAmount,
      reason: 'Giao dịch chi tiết từ PayOS thiếu thông tin mã BIN ngân hàng nhận (fail-closed)',
    };
  }
  if (reportedBin !== expectedBin) {
    return {
      isVerified: false,
      providerPayoutId: payoutId,
      reportedAmount,
      reason: `Mã BIN ngân hàng nhận (${reportedBin}) không khớp với snapshot đích (${expectedBin})`,
    };
  }

  // 9. So khớp Hash số tài khoản nhận (Fail-Closed: bắt buộc có từ provider và khớp chính xác)
  let reportedHash = (matchedTxn.accountNumberHash || matchedTxn.recipientAccountNumberHash)?.toString().trim();
  if (!reportedHash && matchedTxn.toAccountNumber) {
    reportedHash = CryptoVaultUtil.computeDeterministicAccountHash(String(matchedTxn.toAccountNumber).trim());
  }
  if (!reportedHash) {
    return {
      isVerified: false,
      providerPayoutId: payoutId,
      reportedAmount,
      reason: 'Giao dịch chi tiết từ PayOS thiếu thông tin số tài khoản nhận để đối soát (fail-closed)',
    };
  }
  if (reportedHash !== expectedHash) {
    return {
      isVerified: false,
      providerPayoutId: payoutId,
      reportedAmount,
      reason: 'Số tài khoản nhận thực tế không khớp với snapshot tài khoản thụ hưởng',
    };
  }

  return {
    isVerified: true,
    providerPayoutId: payoutId,
    reportedAmount,
    matchedTxId: matchedTxn.id ? String(matchedTxn.id) : undefined,
  };
}

/**
 * Bộ xác minh bằng chứng từ chối / thất bại Payout (Deterministic Terminal Failure)
 * Đảm bảo thất bại được xác minh định danh và snapshot người nhận trước khi giải phóng attempt
 */
export function verifyPayosPayoutRejectionEvidence(
  payoutData: any,
  expected: PayosPayoutExpectedCriteria,
): PayosPayoutVerificationResult {
  if (!payoutData) {
    return {
      isVerified: false,
      providerPayoutId: '',
      reportedAmount: 0,
      reason: 'Dữ liệu phản hồi từ cổng PayOS rỗng',
    };
  }

  // 1. Phản hồi phải có payout ID thật
  const payoutId = payoutData?.id?.toString().trim();
  if (!payoutId) {
    return {
      isVerified: false,
      providerPayoutId: '',
      reportedAmount: 0,
      reason: 'Phản hồi từ PayOS thiếu mã payout ID thật để xác minh thất bại',
    };
  }

  // 1b. Khớp expectedPayoutId nếu hệ thống đã tra cứu theo ID cụ thể
  if (expected.expectedPayoutId) {
    const expId = String(expected.expectedPayoutId).trim();
    if (expId && payoutId !== expId) {
      return {
        isVerified: false,
        providerPayoutId: payoutId,
        reportedAmount: 0,
        reason: `Mã Payout ID trong detail (${payoutId}) không khớp với ID cần tra cứu (${expId})`,
      };
    }
  }

  // 2. Snapshot thụ hưởng phía hệ thống bắt buộc phải đầy đủ (Fail-Closed)
  const expectedBin = expected.targetBankBin ? String(expected.targetBankBin).trim() : '';
  const expectedHash = expected.targetAccountHash ? String(expected.targetAccountHash).trim() : '';
  if (!expectedBin || !expectedHash) {
    return {
      isVerified: false,
      providerPayoutId: payoutId,
      reportedAmount: 0,
      reason: 'Thiếu snapshot thông tin người nhận (targetBankBin hoặc targetAccountHash) để đối soát thất bại',
    };
  }

  // 3. BẮT BUỘC có mảng transactions chi tiết (Loại bỏ hoàn toàn nhánh xác nhận chỉ từ summary)
  const transactions = payoutData?.transactions;
  if (!Array.isArray(transactions) || transactions.length === 0) {
    return {
      isVerified: false,
      providerPayoutId: payoutId,
      reportedAmount: 0,
      reason: 'Không có danh sách transactions chi tiết để xác minh thất bại cho từng giao dịch (chờ đối soát)',
    };
  }

  // 4. Lọc đúng referenceId, yêu cầu DUY NHẤT MỘT transaction khớp (không dùng transaction.id thay reference)
  const expectedRef = expected.payoutReference ? String(expected.payoutReference).trim() : '';
  if (!expectedRef) {
    return {
      isVerified: false,
      providerPayoutId: payoutId,
      reportedAmount: 0,
      reason: 'Thiếu payoutReference cần xác minh thất bại',
    };
  }

  const matchingTxns = transactions.filter((t: any) => {
    if (!t) return false;
    const tRef = t.referenceId ? String(t.referenceId).trim() : (t.reference ? String(t.reference).trim() : '');
    return tRef === expectedRef;
  });

  if (matchingTxns.length === 0) {
    return {
      isVerified: false,
      providerPayoutId: payoutId,
      reportedAmount: 0,
      reason: `Không tìm thấy transaction chi tiết nào khớp với payoutReference (${expectedRef})`,
    };
  }

  if (matchingTxns.length > 1) {
    return {
      isVerified: false,
      providerPayoutId: payoutId,
      reportedAmount: 0,
      reason: `Phát hiện nhiều hơn một transaction (${matchingTxns.length}) trùng payoutReference trong payout`,
    };
  }

  const matchedTxn = matchingTxns[0];

  // 5. Kiểm tra trạng thái chi tiết của transaction: Bắt buộc phải là trạng thái thất bại terminal
  const txnState = matchedTxn.state || matchedTxn.status;
  const isTxnRejected = txnState === 'FAILED' || txnState === 'REJECTED' || txnState === 'CANCELLED';
  if (!isTxnRejected) {
    return {
      isVerified: false,
      providerPayoutId: payoutId,
      reportedAmount: 0,
      reason: `Giao dịch chi tiết không ở trạng thái thất bại terminal (trạng thái: ${txnState || 'UNKNOWN'})`,
    };
  }

  // 6. Chống mâu thuẫn giữa trạng thái tổng và chi tiết:
  // Nếu trạng thái tổng là COMPLETED, SUCCEEDED hoặc đang dở dang (PROCESSING, PENDING) mà transaction lại là FAILED -> Dữ liệu mâu thuẫn hoặc chưa kết thúc -> Chờ đối soát!
  const approvalState = (payoutData?.approvalState || payoutData?.state)?.toString().toUpperCase();
  const isOverallConflictingOrIncomplete =
    approvalState &&
    ['COMPLETED', 'SUCCEEDED', 'PROCESSING', 'PENDING', 'PENDING_APPROVAL', 'APPROVED', 'IN_PROGRESS', 'EXECUTING'].includes(
      approvalState,
    );
  if (isOverallConflictingOrIncomplete) {
    return {
      isVerified: false,
      providerPayoutId: payoutId,
      reportedAmount: 0,
      reason: `Mâu thuẫn dữ liệu hoặc trạng thái tổng chưa kết thúc (${approvalState}) trong khi transaction chi tiết là ${txnState} (giữ chờ đối soát)`,
    };
  }

  // 7. Số tiền chi trả phải nguyên dương và bằng chính xác với số tiền cần hoàn
  const rawReportedAmount = matchedTxn.amount;
  if (
    rawReportedAmount == null ||
    typeof rawReportedAmount !== 'number' ||
    !Number.isInteger(rawReportedAmount) ||
    rawReportedAmount <= 0
  ) {
    return {
      isVerified: false,
      providerPayoutId: payoutId,
      reportedAmount: 0,
      reason: 'Giao dịch chi tiết thiếu số tiền nguyên dương hợp lệ để xác minh thất bại',
    };
  }

  const reportedAmount = Number(rawReportedAmount);
  const expectedAmount = Number(expected.amount);
  if (!Number.isInteger(expectedAmount) || expectedAmount <= 0 || reportedAmount !== expectedAmount) {
    return {
      isVerified: false,
      providerPayoutId: payoutId,
      reportedAmount,
      reason: `Số tiền trong giao dịch thất bại (${reportedAmount}) không khớp với nghĩa vụ (${expectedAmount})`,
    };
  }

  // 8. So khớp BIN ngân hàng nhận (Fail-Closed: bắt buộc có từ provider và khớp chính xác)
  const reportedBin = (matchedTxn.toBin || matchedTxn.bin || matchedTxn.recipientBin)?.toString().trim();
  if (!reportedBin) {
    return {
      isVerified: false,
      providerPayoutId: payoutId,
      reportedAmount,
      reason: 'Giao dịch chi tiết từ PayOS thiếu thông tin mã BIN ngân hàng nhận (fail-closed)',
    };
  }
  if (reportedBin !== expectedBin) {
    return {
      isVerified: false,
      providerPayoutId: payoutId,
      reportedAmount,
      reason: `Mã BIN ngân hàng nhận (${reportedBin}) không khớp với snapshot đích (${expectedBin})`,
    };
  }

  // 9. So khớp Hash số tài khoản nhận (Fail-Closed: bắt buộc có từ provider và khớp chính xác)
  let reportedHash = (matchedTxn.accountNumberHash || matchedTxn.recipientAccountNumberHash)?.toString().trim();
  if (!reportedHash && matchedTxn.toAccountNumber) {
    reportedHash = CryptoVaultUtil.computeDeterministicAccountHash(String(matchedTxn.toAccountNumber).trim());
  }
  if (!reportedHash) {
    return {
      isVerified: false,
      providerPayoutId: payoutId,
      reportedAmount,
      reason: 'Giao dịch chi tiết từ PayOS thiếu thông tin số tài khoản nhận để đối soát (fail-closed)',
    };
  }
  if (reportedHash !== expectedHash) {
    return {
      isVerified: false,
      providerPayoutId: payoutId,
      reportedAmount,
      reason: 'Số tài khoản nhận thực tế không khớp với snapshot tài khoản thụ hưởng',
    };
  }

  return {
    isVerified: true,
    providerPayoutId: payoutId,
    reportedAmount,
    matchedTxId: matchedTxn.id ? String(matchedTxn.id) : undefined,
  };
}
