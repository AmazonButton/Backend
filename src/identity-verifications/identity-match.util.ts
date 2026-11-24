import { CryptoVaultUtil } from '../common/utils/crypto-vault.util';

export interface DiditWarningSummary {
  feature: string;
  code: string;
  risk: string | null;
  shortDescription: string | null;
}

export interface ExtractedDiditOcr {
  fullName: string | null;
  documentNumberNormalized: string | null;
  documentNumberMasked: string | null;
  documentHash: string | null;
  dateOfBirth: string | null;
  nationality: string | null;
  expiryDate: string | null;
  hasCompleteIdentity: boolean;
  warnings: DiditWarningSummary[];
}

export interface NameComparisonResult {
  matched: boolean;
  matchType: 'EXACT_NORMALIZED' | 'TOKEN_REORDER_MATCH' | 'MISSING_INPUT' | 'MISMATCH';
  normalizedExpected: string;
  normalizedOcr: string;
}

const INVALID_DOC_PLACEHOLDERS = new Set([
  'NA',
  'N/A',
  'NONE',
  'NULL',
  'UNKNOWN',
  'UNDEFINED',
  'TEST',
]);

/**
 * Normalize Vietnamese/ASCII names for legal-identity cross-checking:
 * - Maps đ/Đ to d/D before NFD decomposition (NFD leaves stroke-d intact)
 * - Strips combining accents and punctuation
 * - Collapses whitespace to single ASCII spaces and uppercases
 */
export function normalizeVietnameseIdentityName(name: string): string {
  if (typeof name !== 'string') {
    return '';
  }

  return name
    .normalize('NFKC')
    .replace(/[đĐ]/g, 'D')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Split account name into Didit v3 expected_details first_name/last_name without sending empty fields.
 */
export function splitVietnameseExpectedName(
  fullName?: string | null,
): { first_name: string; last_name?: string } | null {
  if (typeof fullName !== 'string') {
    return null;
  }
  const clean = fullName.trim().replace(/\s+/g, ' ');
  if (!clean) {
    return null;
  }

  const tokens = clean.split(' ');
  if (tokens.length === 1) {
    return { first_name: tokens[0] };
  }

  return {
    first_name: tokens.slice(1).join(' '),
    last_name: tokens[0],
  };
}

/**
 * Compare expected profile/legal name against OCR name cleanly across Vietnamese diacritics and Western token order.
 */
export function compareIdentityNames(
  expectedName?: string | null,
  ocrName?: string | null,
): NameComparisonResult {
  const normalizedExpected = normalizeVietnameseIdentityName(expectedName || '');
  const normalizedOcr = normalizeVietnameseIdentityName(ocrName || '');

  if (!normalizedExpected || !normalizedOcr) {
    return {
      matched: false,
      matchType: 'MISSING_INPUT',
      normalizedExpected,
      normalizedOcr,
    };
  }

  if (normalizedExpected === normalizedOcr) {
    return {
      matched: true,
      matchType: 'EXACT_NORMALIZED',
      normalizedExpected,
      normalizedOcr,
    };
  }

  const expectedTokens = normalizedExpected.split(' ').filter(Boolean);
  const ocrTokens = normalizedOcr.split(' ').filter(Boolean);

  // Order-insensitive token multiset equality handles MRZ / Western "First Last" vs "Last Middle First"
  if (expectedTokens.length >= 2 && expectedTokens.length === ocrTokens.length) {
    const sortedExpected = [...expectedTokens].sort().join(' ');
    const sortedOcr = [...ocrTokens].sort().join(' ');
    if (sortedExpected === sortedOcr) {
      return {
        matched: true,
        matchType: 'TOKEN_REORDER_MATCH',
        normalizedExpected,
        normalizedOcr,
      };
    }
  }

  return {
    matched: false,
    matchType: 'MISMATCH',
    normalizedExpected,
    normalizedOcr,
  };
}

export function isValidIdentityDocumentNumber(rawDoc?: unknown): string | null {
  if (typeof rawDoc !== 'string' && typeof rawDoc !== 'number') {
    return null;
  }
  const normalized = CryptoVaultUtil.normalizeIdentityDocument(String(rawDoc));
  if (
    !normalized ||
    normalized.length < 5 ||
    normalized.length > 32 ||
    INVALID_DOC_PLACEHOLDERS.has(normalized) ||
    !/^[A-Z0-9]+$/.test(normalized) ||
    !/[0-9]/.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

export function mapDiditProviderStatus(rawStatus?: unknown): string | null {
  if (typeof rawStatus !== 'string' || !rawStatus.trim()) {
    return null;
  }
  const statusLower = rawStatus.toLowerCase();
  if (statusLower.includes('approved')) return 'APPROVED';
  if (statusLower.includes('declined') || statusLower.includes('rejected')) return 'DECLINED';
  if (statusLower.includes('review')) return 'IN_REVIEW';
  if (statusLower.includes('expired')) return 'EXPIRED';
  if (statusLower.includes('abandoned')) return 'ABANDONED';
  return null;
}

function pickCleanString(...candidates: unknown[]): string | null {
  for (const val of candidates) {
    if (typeof val === 'string') {
      const cleaned = val.trim().replace(/\s+/g, ' ');
      if (cleaned && !INVALID_DOC_PLACEHOLDERS.has(cleaned.toUpperCase())) {
        return cleaned;
      }
    }
  }
  return null;
}

/**
 * Extract sanitized OCR identity data from Didit v3 REST /decision responses AND webhooks (status.updated / data.updated).
 * Strips raw image URLs/blobs and never stores unnormalized blobs.
 */
export function extractDiditOcrIdentity(source: any): ExtractedDiditOcr | null {
  if (!source || typeof source !== 'object') {
    return null;
  }

  const decisionObj = source?.decision && typeof source.decision === 'object' ? source.decision : null;
  const dataObj = source?.data && typeof source.data === 'object' ? source.data : null;

  const idVerifications: any[] = Array.isArray(source?.id_verifications)
    ? source.id_verifications
    : Array.isArray(decisionObj?.id_verifications)
      ? decisionObj.id_verifications
      : Array.isArray(dataObj?.id_verifications)
        ? dataObj.id_verifications
        : [];

  const preferredIdVerif =
    idVerifications.find(
      (item) =>
        item &&
        typeof item === 'object' &&
        String(item.status || '').toLowerCase().includes('approv') &&
        (item.full_name || item.first_name || item.document_number || item.personal_number),
    ) ||
    idVerifications.find(
      (item) =>
        item &&
        typeof item === 'object' &&
        (item.full_name || item.first_name || item.document_number || item.personal_number),
    ) ||
    idVerifications[0] ||
    null;

  const flatOcrCandidates = [preferredIdVerif, decisionObj?.id_verification, dataObj?.id_verification, decisionObj, dataObj, source].filter(
    (obj) => obj && typeof obj === 'object',
  );

  let fullName: string | null = null;
  let validDoc: string | null = null;
  let dateOfBirth: string | null = null;
  let nationality: string | null = null;
  let expiryDate: string | null = null;

  for (const candidate of flatOcrCandidates) {
    if (!fullName) {
      const combinedName =
        candidate.first_name || candidate.last_name
          ? [candidate.last_name, candidate.first_name].filter(Boolean).join(' ').trim()
          : null;
      fullName = pickCleanString(
        candidate.full_name,
        candidate.fullName,
        candidate.name,
        combinedName,
      );
    }

    if (!validDoc) {
      validDoc =
        isValidIdentityDocumentNumber(candidate.document_number) ||
        isValidIdentityDocumentNumber(candidate.documentNumber) ||
        isValidIdentityDocumentNumber(candidate.personal_number) ||
        isValidIdentityDocumentNumber(candidate.id_number) ||
        isValidIdentityDocumentNumber(candidate.id_card) ||
        isValidIdentityDocumentNumber(candidate.identification_number);
    }

    if (!dateOfBirth) {
      dateOfBirth = pickCleanString(candidate.date_of_birth, candidate.dateOfBirth, candidate.dob);
    }
    if (!nationality) {
      nationality = pickCleanString(candidate.nationality, candidate.issuing_state_code);
    }
    if (!expiryDate) {
      expiryDate = pickCleanString(candidate.expiration_date, candidate.expiry_date, candidate.expiryDate);
    }
  }

  const warnings: DiditWarningSummary[] = [];
  const collectWarnings = (feature: string, list: any) => {
    if (!Array.isArray(list)) return;
    for (const w of list) {
      if (!w || typeof w !== 'object') continue;
      if (warnings.length >= 10) break;
      const code = pickCleanString(w.feature, w.risk, w.type, w.code) || 'WARNING';
      warnings.push({
        feature,
        code: String(code).slice(0, 64),
        risk: pickCleanString(w.risk, w.severity),
        shortDescription: pickCleanString(w.short_description, w.message, w.description)?.slice(0, 160) || null,
      });
    }
  };

  collectWarnings('id_verification', preferredIdVerif?.warnings);
  for (const fc of Array.isArray(decisionObj?.face_matches) ? decisionObj.face_matches : source?.face_matches || []) {
    collectWarnings('face_match', fc?.warnings);
  }
  for (const lc of Array.isArray(decisionObj?.liveness_checks) ? decisionObj.liveness_checks : source?.liveness_checks || []) {
    collectWarnings('liveness', lc?.warnings);
  }

  if (!fullName && !validDoc && !dateOfBirth && !expiryDate && warnings.length === 0) {
    return null;
  }

  return {
    fullName,
    documentNumberNormalized: validDoc,
    documentNumberMasked: validDoc ? CryptoVaultUtil.maskIdentityDocument(validDoc) : null,
    documentHash: validDoc ? CryptoVaultUtil.hashIdentityDocument(validDoc) : null,
    dateOfBirth,
    nationality: nationality || (validDoc ? 'VNM' : null),
    expiryDate,
    hasCompleteIdentity: Boolean(fullName && validDoc),
    warnings,
  };
}
