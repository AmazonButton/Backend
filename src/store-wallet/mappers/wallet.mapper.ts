import { CryptoVaultUtil } from '../../common/utils/crypto-vault.util';

export interface WalletResponseDto {
  walletId: string;
  storeId: string;
  balance: number;
  frozenBalance: number;
  bankName: string | null;
  bankAccountNumber: string | null;
  bankAccountNumberMasked: string | null;
  bankAccountHolder: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface WithdrawalResponseDto {
  withdrawalId: string;
  withdrawalCode: string;
  walletId: string;
  storeId: string | null;
  amount: number;
  fee: number;
  netAmount: number;
  bankCode: string | null;
  bankName: string;
  bankAccountNumber: string;
  bankAccountMasked: string;
  bankAccountHolder: string;
  status: string;
  provider: string;
  providerPayoutId: string | null;
  providerReferenceId: string | null;
  failureReason: string | null;
  rejectionReason: string | null;
  transferEvidenceUrl: string | null;
  requestedAt: Date;
  processedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface WalletTransactionResponseDto {
  transactionId: string;
  walletId: string;
  amount: number;
  type: string;
  balanceBefore: number;
  balanceAfter: number;
  referenceId: string | null;
  description: string | null;
  createdAt: Date;
}

export class WalletMapper {
  static toWalletDto(wallet: any): WalletResponseDto {
    const masked = wallet.bankAccountNumber
      ? CryptoVaultUtil.maskAccountNumber(wallet.bankAccountNumber)
      : null;

    return {
      walletId: wallet.walletId?.toString(),
      storeId: wallet.storeId?.toString(),
      balance: Number(wallet.balance || 0),
      frozenBalance: Number(wallet.frozenBalance || 0),
      bankName: wallet.bankName || null,
      bankAccountNumber: masked,
      bankAccountNumberMasked: masked,
      bankAccountHolder: wallet.bankAccountHolder || null,
      createdAt: wallet.createdAt,
      updatedAt: wallet.updatedAt,
    };
  }

  static toWithdrawalDto(w: any): WithdrawalResponseDto {
    const masked =
      w.bankAccountMasked ||
      (w.bankAccountNumber ? CryptoVaultUtil.maskAccountNumber(w.bankAccountNumber) : '******');

    return {
      withdrawalId: w.withdrawalId?.toString(),
      withdrawalCode: w.withdrawalCode,
      walletId: w.walletId?.toString(),
      storeId: w.storeId?.toString() || null,
      amount: Number(w.amount),
      fee: Number(w.fee || 0),
      netAmount: Number(w.netAmount ?? Number(w.amount) - Number(w.fee || 0)),
      bankCode: w.bankBinSnapshot || w.bankCode || null,
      bankName: w.bankNameSnapshot || w.bankName,
      bankAccountNumber: masked,
      bankAccountMasked: masked,
      bankAccountHolder: w.bankAccountNameSnapshot || w.bankAccountHolder,
      status: w.status,
      provider: w.provider,
      providerPayoutId: w.providerPayoutId || null,
      providerReferenceId: w.providerReferenceId || null,
      failureReason: w.failureReason || null,
      rejectionReason: w.rejectionReason || null,
      transferEvidenceUrl: w.transferEvidenceUrl || null,
      requestedAt: w.requestedAt,
      processedAt: w.processedAt || null,
      createdAt: w.createdAt,
      updatedAt: w.updatedAt,
    };
  }

  static toWithdrawalDtoList(withdrawals: any[]): WithdrawalResponseDto[] {
    return (withdrawals || []).map((w) => this.toWithdrawalDto(w));
  }

  static toTransactionDto(tx: any): WalletTransactionResponseDto {
    return {
      transactionId: tx.transactionId?.toString(),
      walletId: tx.walletId?.toString(),
      amount: Number(tx.amount),
      type: tx.type,
      balanceBefore: Number(tx.balanceBefore),
      balanceAfter: Number(tx.balanceAfter),
      referenceId: tx.referenceId || null,
      description: tx.description || null,
      createdAt: tx.createdAt,
    };
  }

  static toTransactionDtoList(transactions: any[]): WalletTransactionResponseDto[] {
    return (transactions || []).map((tx) => this.toTransactionDto(tx));
  }
}
