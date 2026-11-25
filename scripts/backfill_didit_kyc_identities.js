try {
  require('dotenv').config();
} catch {
  // Optional when environment variables are already injected by CI/Runtime
}

const { PrismaClient } = require('@prisma/client');

function loadRuntimeKycModules() {
  const tryLoadTs = () => ({
    repoMod: require('../src/identity-verifications/identity-verifications.repository'),
    matchMod: require('../src/identity-verifications/identity-match.util'),
    cryptoMod: require('../src/common/utils/crypto-vault.util'),
  });

  if (require.extensions && require.extensions['.ts']) {
    return tryLoadTs();
  }

  try {
    require('tsx/cjs');
    return tryLoadTs();
  } catch {
    return {
      repoMod: require('../dist/src/identity-verifications/identity-verifications.repository'),
      matchMod: require('../dist/src/identity-verifications/identity-match.util'),
      cryptoMod: require('../dist/src/common/utils/crypto-vault.util'),
    };
  }
}

const {
  repoMod: { IdentityVerificationsRepository },
  matchMod: {
    compareIdentityNames,
    extractDiditOcrIdentity,
    isValidIdentityDocumentNumber,
  },
  cryptoMod: { CryptoVaultUtil },
} = loadRuntimeKycModules();

async function defaultFetchDiditDecision(diditSessionId) {
  const apiKey = process.env.DIDIT_API_KEY;
  if (!apiKey) return null;
  const baseUrl = (process.env.DIDIT_BASE_URL || 'https://verification.didit.me/v3').replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(`${baseUrl}/session/${encodeURIComponent(diditSessionId)}/decision/`, {
      method: 'GET',
      headers: {
        'x-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function extractPreviewOcrFromMetadata(rawMeta, prefetchedOcr) {
  const src = rawMeta && typeof rawMeta === 'object' ? rawMeta : {};
  let docNormalized = null;
  if (typeof src.documentEncrypted === 'string' && src.documentEncrypted) {
    try {
      docNormalized = isValidIdentityDocumentNumber(
        CryptoVaultUtil.decryptAccountNumber(src.documentEncrypted),
      );
    } catch {
      docNormalized = null;
    }
  }
  if (!docNormalized) {
    for (const candidate of [
      typeof src.documentNumber === 'string' && !src.documentNumber.includes('*') ? src.documentNumber : null,
      src.document_number,
      src.personal_number,
      src.id_number,
      src.id_card,
      src.identification_number,
    ]) {
      const valid = isValidIdentityDocumentNumber(candidate);
      if (valid) {
        docNormalized = valid;
        break;
      }
    }
  }

  const fullNameRaw =
    typeof src.fullName === 'string' && src.fullName.trim()
      ? src.fullName.trim()
      : typeof src.full_name === 'string' && src.full_name.trim()
        ? src.full_name.trim()
        : null;

  const fullName = fullNameRaw || prefetchedOcr?.fullName || null;
  docNormalized = docNormalized || prefetchedOcr?.documentNumberNormalized || null;
  const docHash = docNormalized ? CryptoVaultUtil.hashIdentityDocument(docNormalized) : null;
  return { fullName, docNormalized, docHash };
}

async function backfillDiditKycIdentities(options = {}) {
  const dryRun = Boolean(options.dryRun ?? process.argv.includes('--dry-run'));
  const fetchDidit = Boolean(options.fetchDidit ?? process.argv.includes('--fetch-didit'));
  const ownsPrisma = !options.prismaClient;
  const prisma = options.prismaClient || new PrismaClient();
  const diditFetcher = options.diditFetcher || defaultFetchDiditDecision;
  const repo = new IdentityVerificationsRepository(prisma);

  const summary = {
    dryRun,
    inspectedLegacyUsers: 0,
    promotedUsers: 0,
    duplicateParked: 0,
    mismatchParked: 0,
    ocrMissingParked: 0,
    skippedStaleOrProtected: 0,
    metadataSanitizedCount: 0,
    remainingUnhashedApproved: 0,
  };

  try {
    console.log(
      `🔄 [KYC Backfill] Starting legacy Didit KYC identity backfill (dryRun=${dryRun}, fetchDidit=${fetchDidit})...`,
    );

    // 1. Mask & encrypt unmasked CCCD fields in session metadata under FOR UPDATE row lock
    const allMetaSessions = await prisma.identityVerificationSession.findMany({
      where: { deletedAt: null },
      select: { id: true, metadata: true },
      orderBy: { id: 'asc' },
    });

    for (const s of allMetaSessions) {
      if (!repo.hasDirtySessionMetadata(s.metadata)) continue;
      if (dryRun) {
        summary.metadataSanitizedCount++;
        continue;
      }
      const sanitized = await repo.sanitizeSessionMetadataAtomicTx(BigInt(s.id));
      if (sanitized) {
        summary.metadataSanitizedCount++;
      }
    }

    // 2. Discover candidate legacy sessions belonging to users without bound verified_document_hash.
    // Every decision & state check is re-evaluated inside locked transaction via IdentityVerificationsRepository.
    const legacySessions = await prisma.$queryRaw`
      SELECT
        s."id",
        s."user_id",
        s."didit_session_id",
        s."status",
        s."review_reason",
        s."reviewed_by_user_id",
        s."metadata",
        s."verified_document_hash",
        s."completed_at",
        s."created_at",
        u."full_name" AS "user_full_name",
        u."kyc_status" AS "user_kyc_status",
        u."verified_document_hash" AS "user_doc_hash",
        u."verified_legal_name" AS "user_legal_name",
        u."kyc_verified_at" AS "user_verified_at",
        u."kyc_revoked_at" AS "user_kyc_revoked_at"
      FROM "identity_verification_sessions" s
      INNER JOIN "users" u ON u."user_id" = s."user_id"
      WHERE s."deleted_at" IS NULL
        AND (
          u."verified_document_hash" IS NULL
          OR u."verified_legal_name" IS NULL
        )
        AND (
          s."status" = 'APPROVED'
          OR (
            s."status" = 'IN_REVIEW'
            AND s."review_reason" IN ('LEGACY_OCR_MISSING', 'LEGACY_BACKFILL_REQUIRED')
          )
        )
      ORDER BY s."completed_at" ASC NULLS LAST, s."created_at" ASC, s."id" ASC;
    `;

    const simulatedClaimedHashes = new Set();
    const seenUsers = new Set();

    for (const row of legacySessions) {
      const userKey = row.user_id.toString();
      if (seenUsers.has(userKey)) continue;
      seenUsers.add(userKey);
      summary.inspectedLegacyUsers++;

      // External Didit HTTP recovery happens strictly BEFORE acquiring database row locks
      let prefetchedOcr = null;
      const preview = extractPreviewOcrFromMetadata(row.metadata, null);
      if ((!preview.fullName || !preview.docNormalized) && fetchDidit && row.didit_session_id) {
        const fetched = await diditFetcher(row.didit_session_id);
        prefetchedOcr = extractDiditOcrIdentity(fetched);
      }

      if (dryRun) {
        const isRevoked =
          row.status === 'REVOKED' ||
          Boolean(
            row.created_at &&
              row.user_kyc_revoked_at &&
              new Date(row.created_at).getTime() <= new Date(row.user_kyc_revoked_at).getTime(),
          );
        const isAdminDeclined =
          row.status === 'DECLINED' &&
          (row.review_reason === 'ADMIN_DECLINED' ||
            (row.reviewed_by_user_id !== null && row.reviewed_by_user_id !== undefined));
        const isLegacyEligible =
          row.status === 'APPROVED' ||
          (row.status === 'IN_REVIEW' &&
            ['LEGACY_OCR_MISSING', 'LEGACY_BACKFILL_REQUIRED'].includes(
              String(row.review_reason || ''),
            ));
        const alreadyBound = Boolean(row.user_doc_hash || row.user_legal_name);

        if (isRevoked || isAdminDeclined || !isLegacyEligible || alreadyBound) {
          summary.skippedStaleOrProtected++;
          continue;
        }

        const effective = extractPreviewOcrFromMetadata(row.metadata, prefetchedOcr);
        if (!effective.fullName || !effective.docHash) {
          summary.ocrMissingParked++;
          continue;
        }

        const existingOwner = await prisma.user.findUnique({
          where: { verifiedDocumentHash: effective.docHash },
          select: { userId: true },
        });
        const nameMatch = compareIdentityNames(row.user_full_name, effective.fullName);

        if (
          (existingOwner && existingOwner.userId.toString() !== userKey) ||
          simulatedClaimedHashes.has(effective.docHash)
        ) {
          summary.duplicateParked++;
        } else if (!nameMatch.matched) {
          summary.mismatchParked++;
        } else {
          simulatedClaimedHashes.add(effective.docHash);
          summary.promotedUsers++;
        }
        continue;
      }

      const result = await repo.backfillLegacySessionAtomicTx({
        sessionId: BigInt(row.id),
        prefetchedOcr,
      });

      if (result.outcome === 'PROMOTED') {
        summary.promotedUsers++;
      } else if (result.outcome === 'DUPLICATE_PARKED') {
        summary.duplicateParked++;
      } else if (result.outcome === 'MISMATCH_PARKED') {
        summary.mismatchParked++;
      } else if (result.outcome === 'OCR_MISSING_PARKED') {
        summary.ocrMissingParked++;
      } else {
        summary.skippedStaleOrProtected++;
      }
    }

    // 3. Final safety sweep: only downgrade APPROVED users still missing bound identity
    if (!dryRun && typeof prisma.$executeRaw === 'function') {
      await prisma.$executeRaw`
        UPDATE "users"
        SET "kyc_status" = 'IN_REVIEW'
        WHERE "kyc_status" = 'APPROVED'
          AND ("verified_document_hash" IS NULL OR "verified_legal_name" IS NULL);
      `;
    }

    const unhashedApproved = await prisma.user.count({
      where: {
        kycStatus: 'APPROVED',
        OR: [{ verifiedDocumentHash: null }, { verifiedLegalName: null }],
      },
    });
    summary.remainingUnhashedApproved = unhashedApproved;

    console.log('✅ [KYC Backfill Summary]', JSON.stringify(summary));
    return summary;
  } finally {
    if (ownsPrisma) {
      await prisma.$disconnect();
    }
  }
}

if (require.main === module) {
  backfillDiditKycIdentities()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('❌ KYC backfill failed:', err?.message || err);
      process.exit(1);
    });
}

module.exports = {
  backfillDiditKycIdentities,
  encryptIdentityDocument: (doc) => CryptoVaultUtil.encryptAccountNumber(doc),
  decryptIdentityDocument: (enc) => CryptoVaultUtil.decryptAccountNumber(enc),
  hashIdentityDocument: (doc) => CryptoVaultUtil.hashIdentityDocument(doc),
  maskIdentityDocument: (doc) => CryptoVaultUtil.maskIdentityDocument(doc),
};
