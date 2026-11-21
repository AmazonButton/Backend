import * as crypto from 'crypto';
import { normalizeBankBin } from '../common/utils/bank-identifier.util';
import { CryptoVaultUtil } from '../common/utils/crypto-vault.util';

export type SourceEvidenceStatus =
  | 'SUFFICIENT'
  | 'MISSING'
  | 'MASKED'
  | 'UNMAPPED_BANK'
  | 'CONFLICTING';

export interface InboundPaymentSourceMeta {
  providerTransactionRef?: string | null;
  paymentLinkId?: string | null;
  amount?: number | null;
  currency?: string | null;
  receivedAt?: Date | null;
  sourceBankRaw?: string | null;
  sourceBankBin?: string | null;
  sourceAccountMasked?: string | null;
  sourceAccountHash?: string | null;
  sourceAccountEncrypted?: string | null;
  sourceAccountName?: string | null;
  sourceEvidenceStatus: SourceEvidenceStatus;
  rawPayloadChecksum?: string | null;
}

/**
 * Extracts and validates sender account evidence from an authenticated PayOS order webhook payload.
 * Never defaults unmapped `counterAccountBankId` to a bank BIN and never blocks recording the receipt
 * when source details are masked or absent — instead marks `sourceEvidenceStatus` fail-closed.
 */
export function extractInboundPaymentSourceEvidence(
  data: Record<string, any> | null | undefined,
  fallbackRef?: string | null,
): InboundPaymentSourceMeta {
  const rawRef = data?.reference ?? data?.providerTransactionRef ?? fallbackRef ?? null;
  const providerTransactionRef =
    rawRef !== null && rawRef !== undefined && String(rawRef).trim().length > 0
      ? String(rawRef).trim()
      : null;

  const rawBankId =
    data?.counterAccountBankId ?? data?.counterBankBin ?? data?.senderBankBin ?? null;
  const sourceBankRaw =
    rawBankId !== null && rawBankId !== undefined && String(rawBankId).trim().length > 0
      ? String(rawBankId).trim()
      : null;

  const normalizedBin = normalizeBankBin(sourceBankRaw);

  const rawAcc = data?.counterAccountNumber ?? data?.senderAccountNumber ?? null;
  const cleanRawAcc =
    rawAcc !== null && rawAcc !== undefined
      ? String(rawAcc).replace(/\s+/g, '').toUpperCase().trim()
      : '';

  const rawName = data?.counterAccountName ?? data?.senderAccountName ?? null;
  const sourceAccountName =
    rawName !== null && rawName !== undefined && String(rawName).trim().length > 0
      ? String(rawName).trim().slice(0, 255)
      : null;

  const isMasked = Boolean(cleanRawAcc && cleanRawAcc.includes('*'));

  let sourceAccountMasked: string | null = null;
  let sourceAccountHash: string | null = null;
  let sourceAccountEncrypted: string | null = null;
  let sourceEvidenceStatus: SourceEvidenceStatus;

  if (!cleanRawAcc) {
    sourceEvidenceStatus = 'MISSING';
  } else if (isMasked) {
    sourceAccountMasked = cleanRawAcc.slice(0, 32);
    sourceEvidenceStatus = 'MASKED';
  } else {
    sourceAccountMasked = CryptoVaultUtil.maskAccountNumber(cleanRawAcc).slice(0, 32);
    sourceAccountHash = CryptoVaultUtil.computeDeterministicAccountHash(cleanRawAcc);
    try {
      sourceAccountEncrypted = CryptoVaultUtil.encryptAccountNumber(cleanRawAcc);
    } catch {
      sourceAccountEncrypted = null;
    }

    if (!normalizedBin) {
      sourceEvidenceStatus = 'UNMAPPED_BANK';
    } else if (!sourceAccountEncrypted) {
      sourceEvidenceStatus = 'MISSING';
    } else {
      sourceEvidenceStatus = 'SUFFICIENT';
    }
  }

  let rawPayloadChecksum: string | null = null;
  if (data) {
    rawPayloadChecksum = crypto
      .createHash('sha256')
      .update(JSON.stringify(data))
      .digest('hex');
  }

  const parsedAmount =
    data?.amount !== undefined && data?.amount !== null && !Number.isNaN(Number(data.amount))
      ? Number(data.amount)
      : null;

  let receivedAt: Date | null = null;
  if (data?.transactionDateTime) {
    const dt = new Date(data.transactionDateTime);
    if (!Number.isNaN(dt.getTime())) receivedAt = dt;
  }

  return {
    providerTransactionRef,
    paymentLinkId: data?.paymentLinkId ? String(data.paymentLinkId).trim() : null,
    amount: parsedAmount,
    currency: data?.currency ? String(data.currency).toUpperCase().trim() : 'VND',
    receivedAt,
    sourceBankRaw,
    sourceBankBin: normalizedBin,
    sourceAccountMasked,
    sourceAccountHash,
    sourceAccountEncrypted,
    sourceAccountName,
    sourceEvidenceStatus,
    rawPayloadChecksum,
  };
}
