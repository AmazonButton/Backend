import {
  Injectable,
  Inject,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { IdentityVerificationSession, DiditWebhookEvent } from '@prisma/client';
import { CryptoVaultUtil } from '../common/utils/crypto-vault.util';
import {
  ExtractedDiditOcr,
  compareIdentityNames,
  isValidIdentityDocumentNumber,
} from './identity-match.util';

@Injectable()
export class IdentityVerificationsRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) { }

  async createSession(data: {
    userId: bigint;
    diditSessionId: string;
    workflowId: string;
    vendorData: string;
    status: string;
    verificationUrl: string;
    expiresAt?: Date | null;
    metadata?: any;
    createdAt?: Date;
  }): Promise<IdentityVerificationSession> {
    return this.prisma.identityVerificationSession.create({
      data: {
        userId: data.userId,
        diditSessionId: data.diditSessionId,
        workflowId: data.workflowId,
        vendorData: data.vendorData,
        status: data.status,
        verificationUrl: data.verificationUrl,
        expiresAt: data.expiresAt || null,
        metadata: data.metadata ?? undefined,
        ...(data.createdAt ? { createdAt: data.createdAt } : {}),
      },
    });
  }

  async findSessionById(id: bigint): Promise<IdentityVerificationSession | null> {
    return this.prisma.identityVerificationSession.findUnique({
      where: { id },
    });
  }

  async findSessionByDiditId(diditSessionId: string): Promise<IdentityVerificationSession | null> {
    return this.prisma.identityVerificationSession.findUnique({
      where: { diditSessionId },
    });
  }

  async findActivePendingSession(userId: bigint): Promise<IdentityVerificationSession | null> {
    return this.prisma.identityVerificationSession.findFirst({
      where: {
        userId,
        status: 'PENDING',
        deletedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async listSessionsByUser(
    userId: bigint,
    skip: number,
    take: number,
  ): Promise<IdentityVerificationSession[]> {
    return this.prisma.identityVerificationSession.findMany({
      where: {
        userId,
        deletedAt: null,
      },
      skip,
      take,
      orderBy: { createdAt: 'desc' },
    });
  }

  async countSessionsByUser(userId: bigint): Promise<number> {
    return this.prisma.identityVerificationSession.count({
      where: {
        userId,
        deletedAt: null,
      },
    });
  }

  async listAllSessions(skip: number, take: number): Promise<IdentityVerificationSession[]> {
    return this.prisma.identityVerificationSession.findMany({
      where: {
        deletedAt: null,
      },
      skip,
      take,
      orderBy: { createdAt: 'desc' },
    });
  }

  async countAllSessions(): Promise<number> {
    return this.prisma.identityVerificationSession.count({
      where: {
        deletedAt: null,
      },
    });
  }

  async softDeleteSession(id: bigint): Promise<IdentityVerificationSession> {
    return this.prisma.identityVerificationSession.update({
      where: { id },
      data: {
        status: 'DELETED',
        deletedAt: new Date(),
      },
    });
  }

  async hasApprovedSession(userId: bigint): Promise<boolean> {
    const approved = await this.prisma.identityVerificationSession.findFirst({
      where: {
        userId,
        status: 'APPROVED',
        deletedAt: null,
      },
    });
    return !!approved;
  }

  async findUserKycStatus(userId: bigint): Promise<string | null> {
    const user = await this.prisma.user.findUnique({
      where: { userId },
      select: { kycStatus: true },
    });
    return user?.kycStatus ?? null;
  }

  async findUserIdentityContext(userId: bigint) {
    return this.prisma.user.findUnique({
      where: { userId },
      select: {
        userId: true,
        fullName: true,
        kycStatus: true,
        verifiedLegalName: true,
        verifiedDocumentHash: true,
        verifiedDocumentEncrypted: true,
        verifiedDocumentMasked: true,
        verifiedDateOfBirth: true,
        verifiedNationality: true,
        kycVerifiedAt: true,
        kycRevokedAt: true,
      },
    });
  }

  private async lockUserForKycUpdateInTx(tx: any, userId: bigint): Promise<any> {
    const userRows = await tx.$queryRaw<any[]>`
      SELECT
        "user_id",
        "full_name",
        "kyc_status",
        "verified_legal_name",
        "verified_document_hash",
        "verified_document_encrypted",
        "verified_document_masked",
        "verified_date_of_birth",
        "verified_nationality",
        "kyc_verified_at",
        "kyc_revoked_at"
      FROM "users"
      WHERE "user_id" = ${userId}
      FOR UPDATE;
    `;
    return userRows && userRows.length > 0 ? userRows[0] : null;
  }

  async updateUserKycStatus(userId: bigint, kycStatus: string): Promise<void> {
    if (kycStatus !== 'APPROVED') {
      await this.prisma.user.updateMany({
        where: {
          userId,
          kycStatus: { not: 'APPROVED' },
        },
        data: { kycStatus },
      });
      return;
    }

    await this.prisma.user.update({
      where: { userId },
      data: { kycStatus },
    });
  }

  private extractLegacyRawDocFromMeta(meta: any): string | null {
    if (!meta || typeof meta !== 'object') return null;
    const candidates = [
      typeof meta.documentNumber === 'string' && !meta.documentNumber.includes('*')
        ? meta.documentNumber
        : null,
      meta.document_number,
      meta.personal_number,
      meta.id_number,
      meta.id_card,
      meta.identification_number,
    ];
    for (const candidate of candidates) {
      const valid = isValidIdentityDocumentNumber(candidate);
      if (valid) return valid;
    }
    return null;
  }

  private static readonly FORBIDDEN_RAW_META_KEYS = [
    'document_number',
    'personal_number',
    'id_number',
    'id_card',
    'identification_number',
    'front_image',
    'back_image',
    'portrait_image',
    'selfie_image',
    'image_url',
    'video_url',
    'selfie_url',
    'id_verifications',
    'face_matches',
    'liveness_checks',
    'decision',
    'full_name',
  ] as const;

  hasDirtySessionMetadata(metaRaw: any): boolean {
    if (!metaRaw || typeof metaRaw !== 'object' || Array.isArray(metaRaw)) {
      return false;
    }
    if (this.extractLegacyRawDocFromMeta(metaRaw)) {
      return true;
    }
    if (
      typeof metaRaw.documentNumber === 'string' &&
      metaRaw.documentNumber.trim().length > 0 &&
      !metaRaw.documentNumber.includes('*')
    ) {
      return true;
    }
    return IdentityVerificationsRepository.FORBIDDEN_RAW_META_KEYS.some((k) => k in metaRaw);
  }

  private mergeSessionMetadata(
    existingRaw: any,
    incomingOcr?: ExtractedDiditOcr | null,
    providerStatus?: string | null,
  ): Record<string, any> {
    const existing = existingRaw && typeof existingRaw === 'object' ? { ...existingRaw } : {};
    const merged: Record<string, any> = { ...existing };

    // Always extract & mask legacy raw document numbers BEFORE checking incomingOcr
    // so partial OCR (e.g. fullName without documentNumber) never leaves plaintext CCCD behind.
    const legacyDoc = this.extractLegacyRawDocFromMeta(existing);
    if (legacyDoc) {
      const maskedLegacy = CryptoVaultUtil.maskIdentityDocument(legacyDoc);
      merged.documentNumber = maskedLegacy;
      merged.documentNumberMasked = maskedLegacy;
      if (!merged.documentEncrypted) {
        merged.documentEncrypted = CryptoVaultUtil.encryptAccountNumber(legacyDoc);
      }
    } else if (
      typeof merged.documentNumber === 'string' &&
      !merged.documentNumber.includes('*')
    ) {
      const trimmedDoc = merged.documentNumber.trim();
      if (!trimmedDoc || ['NA', 'N/A', 'NONE', 'NULL', 'UNKNOWN', 'UNDEFINED', 'TEST'].includes(trimmedDoc.toUpperCase())) {
        delete merged.documentNumber;
      } else {
        const maskedFallback = CryptoVaultUtil.maskIdentityDocument(trimmedDoc);
        merged.documentNumber = maskedFallback;
        if (!merged.documentNumberMasked) {
          merged.documentNumberMasked = maskedFallback;
        }
      }
    }

    // Always strip legacy raw vendor keys / image URLs so metadata never retains plaintext PII or blobs
    for (const forbiddenKey of IdentityVerificationsRepository.FORBIDDEN_RAW_META_KEYS) {
      if (forbiddenKey === 'full_name') continue;
      delete merged[forbiddenKey];
    }

    if (!merged.fullName && typeof existing.full_name === 'string' && existing.full_name.trim()) {
      merged.fullName = existing.full_name.trim();
    }
    delete merged.full_name;

    if (providerStatus) {
      merged.providerStatus = providerStatus;
      if (providerStatus === 'APPROVED') {
        merged.providerApproved = true;
      }
    }

    if (incomingOcr) {
      if (incomingOcr.fullName) merged.fullName = incomingOcr.fullName;
      if (incomingOcr.documentNumberMasked) {
        // Store masked CCCD/ID only in JSON metadata so GET /sessions never leaks raw ID numbers
        merged.documentNumber = incomingOcr.documentNumberMasked;
        merged.documentNumberMasked = incomingOcr.documentNumberMasked;
      }
      if (incomingOcr.documentNumberNormalized) {
        merged.documentEncrypted = CryptoVaultUtil.encryptAccountNumber(
          incomingOcr.documentNumberNormalized,
        );
      }
      if (incomingOcr.dateOfBirth) merged.dateOfBirth = incomingOcr.dateOfBirth;
      if (incomingOcr.nationality) merged.nationality = incomingOcr.nationality;
      if (incomingOcr.expiryDate) merged.expiryDate = incomingOcr.expiryDate;
      if (incomingOcr.warnings?.length) merged.warnings = incomingOcr.warnings;
      merged.updatedAt = new Date().toISOString();
    }

    return merged;
  }

  private resolveEffectiveIdentityFromState(
    lockedSession: any,
    mergedMeta: Record<string, any>,
    incomingOcr?: ExtractedDiditOcr | null,
  ) {
    const ocrName: string | null = incomingOcr?.fullName || mergedMeta.fullName || null;
    const legacyDoc = !incomingOcr?.documentNumberNormalized
      ? this.extractLegacyRawDocFromMeta(lockedSession?.metadata)
      : null;

    let decryptedDoc: string | null = null;
    if (
      !incomingOcr?.documentNumberNormalized &&
      !legacyDoc &&
      typeof mergedMeta.documentEncrypted === 'string' &&
      mergedMeta.documentEncrypted
    ) {
      try {
        decryptedDoc = isValidIdentityDocumentNumber(
          CryptoVaultUtil.decryptAccountNumber(mergedMeta.documentEncrypted),
        );
      } catch {
        decryptedDoc = null;
      }
    }

    const docHash: string | null =
      incomingOcr?.documentHash ||
      lockedSession?.verified_document_hash ||
      (legacyDoc ? CryptoVaultUtil.hashIdentityDocument(legacyDoc) : null) ||
      (decryptedDoc ? CryptoVaultUtil.hashIdentityDocument(decryptedDoc) : null);

    let docEncrypted: string | null = null;
    if (incomingOcr?.documentNumberNormalized) {
      docEncrypted = CryptoVaultUtil.encryptAccountNumber(incomingOcr.documentNumberNormalized);
    } else if (typeof mergedMeta.documentEncrypted === 'string' && mergedMeta.documentEncrypted) {
      docEncrypted = mergedMeta.documentEncrypted;
    } else if (legacyDoc) {
      docEncrypted = CryptoVaultUtil.encryptAccountNumber(legacyDoc);
    }

    const docMasked: string | null =
      incomingOcr?.documentNumberMasked ||
      mergedMeta.documentNumberMasked ||
      (legacyDoc ? CryptoVaultUtil.maskIdentityDocument(legacyDoc) : null) ||
      (decryptedDoc ? CryptoVaultUtil.maskIdentityDocument(decryptedDoc) : null);

    const ocrDob: string | null = incomingOcr?.dateOfBirth || mergedMeta.dateOfBirth || null;
    const ocrNationality: string | null = incomingOcr?.nationality || mergedMeta.nationality || null;

    return {
      ocrName,
      docHash,
      docEncrypted,
      docMasked,
      ocrDob,
      ocrNationality,
    };
  }

  private isUniqueViolationError(err: any): boolean {
    if (!err) return false;
    if (err.code === 'P2002' || err.code === '23505') return true;
    const msg = String(err.message || '').toLowerCase();
    return msg.includes('23505') || msg.includes('uq_users_verified_document_hash');
  }

  /**
   * Unified transactional KYC evaluator used by webhook ingestion, /decision reconciliation,
   * and admin manual review. Executes strictly under session + user row locks (FOR UPDATE).
   */
  private async applyKycEvaluationInTx(
    tx: any,
    params: {
      lockedSession: any;
      lockedUser: any;
      providerStatus: string | null;
      incomingOcr?: ExtractedDiditOcr | null;
      isDataOnlyEvent?: boolean;
      ocrMissingReason?: string;
      bypassNameCheckForAdminReview?: boolean;
      adminReviewContext?: {
        adminUserId: bigint;
        reason: string;
      };
    },
  ): Promise<{
    sessionStatus: string;
    reviewReason: string | null;
  }> {
    const {
      lockedSession,
      lockedUser,
      providerStatus,
      incomingOcr,
      isDataOnlyEvent = false,
      ocrMissingReason = 'OCR_DATA_MISSING',
      bypassNameCheckForAdminReview = false,
      adminReviewContext,
    } = params;

    const userId = BigInt(lockedSession.user_id);
    const now = new Date();
    const nowIso = now.toISOString();
    const mergedMeta = this.mergeSessionMetadata(
      lockedSession.metadata,
      incomingOcr,
      providerStatus,
    );
    const identity = this.resolveEffectiveIdentityFromState(lockedSession, mergedMeta, incomingOcr);
    const hasMetadataChanges = Boolean(
      incomingOcr ||
        providerStatus ||
        adminReviewContext ||
        this.hasDirtySessionMetadata(lockedSession.metadata),
    );

    // Gate 0a: Monotonic revocation watermark (prevents pre-revoke sessions from reactivating KYC)
    const sessionRevokedByWatermark =
      Boolean(lockedSession.created_at && lockedUser?.kyc_revoked_at) &&
      new Date(lockedSession.created_at).getTime() <=
      new Date(lockedUser.kyc_revoked_at).getTime();

    if (lockedSession.status === 'REVOKED' || sessionRevokedByWatermark) {
      if (lockedSession.status !== 'REVOKED') {
        const revokedMeta = { ...mergedMeta };
        revokedMeta.revokedAudit = {
          ...(revokedMeta.revokedAudit || {}),
          previousStatus: lockedSession.status,
          reason: 'USER_IDENTITY_REVOKED_WATERMARK',
          revokedAt: nowIso,
        };
        await tx.identityVerificationSession.update({
          where: { id: lockedSession.id },
          data: {
            status: 'REVOKED',
            reviewReason: 'ADMIN_REVOKED',
            metadata: revokedMeta,
          },
        });
      }
      return {
        sessionStatus: 'REVOKED',
        reviewReason: lockedSession.review_reason || 'ADMIN_REVOKED',
      };
    }

    // Gate 0b: Manual Admin Decline lock (neither /decision polling nor provider webhooks can override ADMIN_DECLINED)
    const isManualAdminDeclined =
      lockedSession.status === 'DECLINED' &&
      (lockedSession.review_reason === 'ADMIN_DECLINED' ||
        (lockedSession.reviewed_by_user_id !== null &&
          lockedSession.reviewed_by_user_id !== undefined));

    if (isManualAdminDeclined && !adminReviewContext) {
      if (hasMetadataChanges) {
        await tx.identityVerificationSession.update({
          where: { id: lockedSession.id },
          data: {
            metadata: mergedMeta,
            ...(identity.docHash && !lockedSession.verified_document_hash
              ? { verifiedDocumentHash: identity.docHash }
              : {}),
          },
        });
      }
      return {
        sessionStatus: 'DECLINED',
        reviewReason: lockedSession.review_reason || 'ADMIN_DECLINED',
      };
    }

    const hasBoundUserIdentity =
      Boolean(lockedUser?.verified_document_hash) &&
      Boolean(lockedUser?.verified_legal_name);

    const hasMatchingBoundSession =
      hasBoundUserIdentity &&
      (!identity.docHash || identity.docHash === lockedUser.verified_document_hash);

    // Gate 0c: Preserve terminal APPROVED ONLY when the user already holds a valid bound identity
    // (legacy unbound APPROVED accounts without verified_document_hash / verified_legal_name must undergo full validation)
    if (lockedSession.status === 'APPROVED' && hasMatchingBoundSession) {
      const updateData: any = {};
      if (hasMetadataChanges) updateData.metadata = mergedMeta;
      if (identity.docHash && !lockedSession.verified_document_hash) {
        updateData.verifiedDocumentHash = identity.docHash;
      }
      if (Object.keys(updateData).length > 0) {
        await tx.identityVerificationSession.update({
          where: { id: lockedSession.id },
          data: updateData,
        });
      }

      if (lockedUser.kyc_status !== 'APPROVED') {
        await tx.user.update({
          where: { userId },
          data: {
            kycStatus: 'APPROVED',
            kycVerifiedAt: lockedUser.kyc_verified_at || now,
          },
        });
      }

      return {
        sessionStatus: 'APPROVED',
        reviewReason: null,
      };
    }

    // Re-evaluate previously parked OCR_DATA_MISSING sessions OR legacy un-bound APPROVED sessions
    let effectiveStatus = providerStatus;
    if (lockedSession.status === 'APPROVED' && !effectiveStatus) {
      effectiveStatus = 'APPROVED';
    }
    if (
      !effectiveStatus &&
      isDataOnlyEvent &&
      mergedMeta.providerApproved === true &&
      lockedSession.status === 'IN_REVIEW' &&
      (lockedSession.review_reason === 'OCR_DATA_MISSING' ||
        lockedSession.review_reason === 'LEGACY_OCR_MISSING' ||
        lockedSession.review_reason === 'LEGACY_BACKFILL_REQUIRED')
    ) {
      effectiveStatus = 'APPROVED';
    }

    if (!effectiveStatus) {
      if (hasMetadataChanges) {
        await tx.identityVerificationSession.update({
          where: { id: lockedSession.id },
          data: {
            metadata: mergedMeta,
            ...(identity.docHash ? { verifiedDocumentHash: identity.docHash } : {}),
          },
        });
      }
      return {
        sessionStatus: lockedSession.status,
        reviewReason: lockedSession.review_reason || null,
      };
    }

    if (effectiveStatus === 'APPROVED') {
      const parkSessionInReview = async (
        reason: string,
        diagnostic: Record<string, any>,
        preserveVerifiedUser = hasBoundUserIdentity,
      ) => {
        mergedMeta.identityCheck = {
          status: 'REVIEW_REQUIRED',
          reason,
          checkedAt: nowIso,
          ...diagnostic,
        };
        if (adminReviewContext) {
          mergedMeta.lastAdminReview = {
            adminUserId: adminReviewContext.adminUserId.toString(),
            reason: adminReviewContext.reason,
            outcome: 'BLOCKED_' + reason,
            reviewedAt: nowIso,
          };
        }

        await tx.identityVerificationSession.update({
          where: { id: lockedSession.id },
          data: {
            status: 'IN_REVIEW',
            reviewReason: reason,
            completedAt: lockedSession.completed_at || now,
            metadata: mergedMeta,
            ...(identity.docHash ? { verifiedDocumentHash: identity.docHash } : {}),
            ...(adminReviewContext
              ? {
                reviewedByUserId: adminReviewContext.adminUserId,
                reviewedAt: now,
                reviewNote: adminReviewContext.reason,
              }
              : {}),
          },
        });

        if (lockedUser.kyc_status !== 'APPROVED') {
          await tx.user.updateMany({
            where: { userId, kycStatus: { not: 'APPROVED' } },
            data: { kycStatus: 'IN_REVIEW' },
          });
        } else if (!preserveVerifiedUser) {
          await tx.user.update({
            where: { userId },
            data: { kycStatus: 'IN_REVIEW' },
          });
        }

        return {
          sessionStatus: 'IN_REVIEW',
          reviewReason: reason,
        };
      };

      // Gate 1: Reject blind approval without verified OCR name & document number
      if (!identity.ocrName || !identity.docHash) {
        return parkSessionInReview(ocrMissingReason, {
          hasOcrName: Boolean(identity.ocrName),
          hasDocumentNumber: Boolean(identity.docHash),
        });
      }

      // Gate 2: Serialize concurrent claims on the same CCCD across users
      if (typeof tx.$executeRaw === 'function') {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('kyc_doc'), hashtext(${identity.docHash}))`;
      }

      const existingOwners = await tx.$queryRaw<Array<{ user_id: bigint }>>`
        SELECT "user_id"
        FROM "users"
        WHERE "verified_document_hash" = ${identity.docHash}
        LIMIT 1;
      `;

      if (existingOwners && existingOwners.length > 0 && BigInt(existingOwners[0].user_id) !== userId) {
        return parkSessionInReview('DUPLICATE_DOCUMENT', {
          conflictingUserExists: true,
        });
      }

      if (
        lockedUser.verified_document_hash &&
        lockedUser.verified_document_hash !== identity.docHash
      ) {
        return parkSessionInReview('USER_DOCUMENT_CONFLICT', {
          reasonDetail: 'Account already bound to a different verified identity document',
        });
      }

      // Gate 3: Cross-check OCR legal name against locked legal name (on re-verification) or display fullName
      if (!bypassNameCheckForAdminReview) {
        const expectedNameSource = lockedUser.verified_legal_name
          ? 'VERIFIED_LEGAL_NAME'
          : 'PROFILE_FULL_NAME';
        const expectedName = lockedUser.verified_legal_name || lockedUser.full_name;
        const nameMatch = compareIdentityNames(expectedName, identity.ocrName);

        if (!nameMatch.matched) {
          return parkSessionInReview('NAME_MISMATCH', {
            matchType: nameMatch.matchType,
            expectedNameSource,
            expectedNormalized: nameMatch.normalizedExpected,
            ocrNormalized: nameMatch.normalizedOcr,
          });
        }

        mergedMeta.identityCheck = {
          status: 'MATCHED',
          matchType: nameMatch.matchType,
          expectedNameSource,
          checkedAt: nowIso,
        };
      } else {
        mergedMeta.identityCheck = {
          status: 'ADMIN_NAME_OVERRIDE_APPROVED',
          adminUserId: adminReviewContext?.adminUserId.toString() || null,
          reason: adminReviewContext?.reason || null,
          checkedAt: nowIso,
        };
      }

      // Gate 4: Bind verified legal identity atomically with SAVEPOINT catching any 23505 race
      const supportsSavepoint = typeof tx.$executeRawUnsafe === 'function';
      if (supportsSavepoint) {
        await tx.$executeRawUnsafe('SAVEPOINT sp_kyc_bind_user');
      }
      try {
        await tx.user.update({
          where: { userId },
          data: {
            kycStatus: 'APPROVED',
            verifiedLegalName: identity.ocrName,
            verifiedDocumentHash: identity.docHash,
            verifiedDocumentEncrypted: identity.docEncrypted,
            verifiedDocumentMasked: identity.docMasked,
            verifiedDateOfBirth: identity.ocrDob || lockedUser.verified_date_of_birth || null,
            verifiedNationality: identity.ocrNationality || lockedUser.verified_nationality || 'VNM',
            kycVerifiedAt: lockedUser.kyc_verified_at || now,
          },
        });
        if (supportsSavepoint) {
          await tx.$executeRawUnsafe('RELEASE SAVEPOINT sp_kyc_bind_user');
        }
      } catch (err: any) {
        if (supportsSavepoint) {
          await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT sp_kyc_bind_user');
        }
        if (this.isUniqueViolationError(err)) {
          return parkSessionInReview('DUPLICATE_DOCUMENT', {
            conflictingUserExists: true,
            uniqueIndexFallback: true,
          });
        }
        throw err;
      }

      await tx.identityVerificationSession.update({
        where: { id: lockedSession.id },
        data: {
          status: 'APPROVED',
          reviewReason: null,
          verifiedDocumentHash: identity.docHash,
          completedAt: lockedSession.completed_at || now,
          metadata: mergedMeta,
          ...(adminReviewContext
            ? {
              reviewedByUserId: adminReviewContext.adminUserId,
              reviewedAt: now,
              reviewNote: adminReviewContext.reason,
            }
            : {}),
        },
      });

      return {
        sessionStatus: 'APPROVED',
        reviewReason: null,
      };
    }

    // Non-APPROVED status transitions (DECLINED, IN_REVIEW, EXPIRED, ABANDONED)
    await tx.identityVerificationSession.update({
      where: { id: lockedSession.id },
      data: {
        status: effectiveStatus,
        completedAt: now,
        metadata: mergedMeta,
        ...(identity.docHash ? { verifiedDocumentHash: identity.docHash } : {}),
        ...(adminReviewContext
          ? {
            reviewReason: 'ADMIN_DECLINED',
            reviewedByUserId: adminReviewContext.adminUserId,
            reviewedAt: now,
            reviewNote: adminReviewContext.reason,
          }
          : effectiveStatus === 'IN_REVIEW'
            ? { reviewReason: lockedSession.review_reason || 'PROVIDER_REVIEW' }
            : {}),
      },
    });

    const canRetainApprovedStatus =
      lockedUser.kyc_status === 'APPROVED' && hasBoundUserIdentity;

    if (effectiveStatus === 'DECLINED' && !canRetainApprovedStatus) {
      const otherApproved = await tx.$queryRaw<any[]>`
        SELECT "id" FROM "identity_verification_sessions"
        WHERE "user_id" = ${userId}
          AND "id" != ${lockedSession.id}
          AND "status" = 'APPROVED'
          AND "deleted_at" IS NULL
        LIMIT 1;
      `;
      if (!hasBoundUserIdentity || !otherApproved || otherApproved.length === 0) {
        await tx.user.update({
          where: { userId },
          data: { kycStatus: 'DECLINED' },
        });
      }
    } else if (effectiveStatus === 'IN_REVIEW' && !canRetainApprovedStatus) {
      await tx.user.update({
        where: { userId },
        data: { kycStatus: 'IN_REVIEW' },
      });
    } else if (!hasBoundUserIdentity && lockedUser.kyc_status === 'APPROVED') {
      await tx.user.update({
        where: { userId },
        data: { kycStatus: 'IN_REVIEW' },
      });
    }

    return {
      sessionStatus: effectiveStatus,
      reviewReason:
        effectiveStatus === 'DECLINED' && adminReviewContext
          ? 'ADMIN_DECLINED'
          : lockedSession.review_reason || null,
    };
  }

  /**
   * Atomically reconcile provider decision polling with canonical lock hierarchy:
   * non-locking discovery -> users FOR UPDATE -> identity_verification_sessions FOR UPDATE -> advisory lock.
   */
  async reconcileDecisionAtomicTx(params: {
    sessionId: bigint;
    newStatus: string | null;
    extractedOcr?: ExtractedDiditOcr | null;
  }): Promise<{ status: string; reviewReason: string | null }> {
    return this.prisma.$transaction(async (tx) => {
      const discoveryRows = await tx.$queryRaw<any[]>`
        SELECT "id", "user_id", "deleted_at"
        FROM "identity_verification_sessions"
        WHERE "id" = ${params.sessionId}
        LIMIT 1;
      `;

      if (!discoveryRows || discoveryRows.length === 0 || discoveryRows[0].deleted_at !== null) {
        throw new NotFoundException('Không tìm thấy phiên xác minh danh tính');
      }

      const userId = BigInt(discoveryRows[0].user_id);
      const lockedUser = await this.lockUserForKycUpdateInTx(tx, userId);
      if (!lockedUser) {
        throw new NotFoundException('Không tìm thấy tài khoản người dùng của phiên xác minh');
      }

      const sessionRows = await tx.$queryRaw<any[]>`
        SELECT
          "id",
          "user_id",
          "status",
          "metadata",
          "verified_document_hash",
          "review_reason",
          "reviewed_by_user_id",
          "completed_at",
          "created_at",
          "deleted_at"
        FROM "identity_verification_sessions"
        WHERE "id" = ${params.sessionId}
        ORDER BY "id" ASC
        FOR UPDATE;
      `;

      if (!sessionRows || sessionRows.length === 0 || sessionRows[0].deleted_at !== null) {
        throw new NotFoundException('Không tìm thấy phiên xác minh danh tính');
      }

      const result = await this.applyKycEvaluationInTx(tx, {
        lockedSession: sessionRows[0],
        lockedUser,
        providerStatus: params.newStatus,
        incomingOcr: params.extractedOcr,
      });

      return {
        status: result.sessionStatus,
        reviewReason: result.reviewReason,
      };
    });
  }

  async findWebhookEventByHash(payloadHash: string): Promise<DiditWebhookEvent | null> {
    return this.prisma.diditWebhookEvent.findUnique({
      where: { payloadHash },
    });
  }

  async findWebhookEventByEventId(eventId: string): Promise<DiditWebhookEvent | null> {
    return this.prisma.diditWebhookEvent.findUnique({
      where: { eventId },
    });
  }

  /**
   * Execute webhook idempotency + identity evaluation using canonical lock hierarchy:
   * non-locking session discovery -> users FOR UPDATE -> sessions FOR UPDATE -> webhook event insert -> advisory lock.
   */
  async executeAtomicWebhookTransaction(params: {
    eventId?: string | null;
    diditSessionId?: string | null;
    eventType: string;
    rawStatus: string;
    mappedStatus?: string | null;
    payloadHash: string;
    extractedOcr?: ExtractedDiditOcr | null;
  }): Promise<{
    status: 'PROCESSED' | 'DUPLICATE' | 'UNKNOWN_SESSION';
    message: string;
    sessionStatus?: string;
    reviewReason?: string | null;
  }> {
    const {
      eventId,
      diditSessionId,
      eventType,
      rawStatus,
      mappedStatus,
      payloadHash,
      extractedOcr,
    } = params;

    return this.prisma.$transaction(async (tx) => {
      let discoveredSession: any = null;
      if (diditSessionId) {
        const discoveryRows = await tx.$queryRaw<any[]>`
          SELECT "id", "user_id", "didit_session_id", "deleted_at"
          FROM "identity_verification_sessions"
          WHERE "didit_session_id" = ${diditSessionId}
          LIMIT 1;
        `;
        if (discoveryRows && discoveryRows.length > 0) {
          discoveredSession = discoveryRows[0];
        }
      }

      let lockedUser: any = null;
      let lockedSession: any = null;

      if (discoveredSession) {
        const userId = BigInt(discoveredSession.user_id);
        lockedUser = await this.lockUserForKycUpdateInTx(tx, userId);

        const sessionRows = await tx.$queryRaw<any[]>`
          SELECT
            "id",
            "user_id",
            "didit_session_id",
            "status",
            "metadata",
            "verified_document_hash",
            "review_reason",
            "reviewed_by_user_id",
            "completed_at",
            "created_at",
            "deleted_at"
          FROM "identity_verification_sessions"
          WHERE "id" = ${BigInt(discoveredSession.id)}
          ORDER BY "id" ASC
          FOR UPDATE;
        `;
        if (sessionRows && sessionRows.length > 0) {
          lockedSession = sessionRows[0];
        }
      }

      const validDiditSessionId = lockedSession ? lockedSession.didit_session_id : null;

      const insertedRows = await tx.$queryRaw<Array<{ id: bigint }>>`
        INSERT INTO "didit_webhook_events" (
          "event_id",
          "didit_session_id",
          "event_type",
          "status",
          "payload_hash",
          "received_at",
          "processed_at"
        )
        VALUES (
          ${eventId || null},
          ${validDiditSessionId},
          ${eventType},
          ${rawStatus},
          ${payloadHash},
          NOW(),
          NULL
        )
        ON CONFLICT DO NOTHING
        RETURNING "id";
      `;

      if (!insertedRows || insertedRows.length === 0) {
        return {
          status: 'DUPLICATE',
          message: 'Event already processed',
        };
      }

      const webhookRecordId = BigInt(insertedRows[0].id);

      if (!lockedSession || !lockedUser) {
        await tx.diditWebhookEvent.update({
          where: { id: webhookRecordId },
          data: { processedAt: new Date() },
        });
        return {
          status: 'UNKNOWN_SESSION',
          message: 'Webhook received for unknown session',
        };
      }

      const evaluation = await this.applyKycEvaluationInTx(tx, {
        lockedSession,
        lockedUser,
        providerStatus: eventType === 'status.updated' ? (mappedStatus ?? null) : null,
        incomingOcr: extractedOcr,
        isDataOnlyEvent: eventType === 'data.updated',
      });

      await tx.diditWebhookEvent.update({
        where: { id: webhookRecordId },
        data: { processedAt: new Date() },
      });

      return {
        status: 'PROCESSED',
        message: 'Webhook processed successfully',
        sessionStatus: evaluation.sessionStatus,
        reviewReason: evaluation.reviewReason,
      };
    });
  }

  /**
   * Explicit Admin review for sessions parked in IN_REVIEW (NAME_MISMATCH / manual escalation).
   * Uses canonical lock order: discovery -> users FOR UPDATE -> session FOR UPDATE -> advisory lock.
   */
  async reviewSessionAtomicTx(params: {
    sessionId: bigint;
    adminUserId: bigint;
    decision: 'APPROVE' | 'DECLINE';
    reason: string;
    acceptOcrNameAsVerified?: boolean;
  }): Promise<{ status: string; reviewReason: string | null }> {
    return this.prisma.$transaction(async (tx) => {
      const discoveryRows = await tx.$queryRaw<any[]>`
        SELECT "id", "user_id", "deleted_at"
        FROM "identity_verification_sessions"
        WHERE "id" = ${params.sessionId}
        LIMIT 1;
      `;

      if (!discoveryRows || discoveryRows.length === 0 || discoveryRows[0].deleted_at !== null) {
        throw new NotFoundException('Không tìm thấy phiên xác minh danh tính');
      }

      const userId = BigInt(discoveryRows[0].user_id);
      const lockedUser = await this.lockUserForKycUpdateInTx(tx, userId);
      if (!lockedUser) {
        throw new NotFoundException('Không tìm thấy tài khoản người dùng của phiên xác minh');
      }

      const sessionRows = await tx.$queryRaw<any[]>`
        SELECT
          "id",
          "user_id",
          "status",
          "metadata",
          "verified_document_hash",
          "review_reason",
          "reviewed_by_user_id",
          "completed_at",
          "created_at",
          "deleted_at"
        FROM "identity_verification_sessions"
        WHERE "id" = ${params.sessionId}
        ORDER BY "id" ASC
        FOR UPDATE;
      `;

      if (!sessionRows || sessionRows.length === 0 || sessionRows[0].deleted_at !== null) {
        throw new NotFoundException('Không tìm thấy phiên xác minh danh tính');
      }

      const lockedSession = sessionRows[0];
      const revokedByWatermark =
        Boolean(lockedSession.created_at && lockedUser.kyc_revoked_at) &&
        new Date(lockedSession.created_at).getTime() <=
        new Date(lockedUser.kyc_revoked_at).getTime();

      if (lockedSession.status === 'APPROVED') {
        throw new ConflictException('Phiên xác minh này đã ở trạng thái APPROVED');
      }
      if (lockedSession.status === 'REVOKED' || revokedByWatermark) {
        throw new ConflictException('Phiên xác minh đã bị thu hồi trước đó');
      }

      const evaluation = await this.applyKycEvaluationInTx(tx, {
        lockedSession,
        lockedUser,
        providerStatus: params.decision === 'APPROVE' ? 'APPROVED' : 'DECLINED',
        bypassNameCheckForAdminReview:
          params.decision === 'APPROVE' && Boolean(params.acceptOcrNameAsVerified),
        adminReviewContext: {
          adminUserId: params.adminUserId,
          reason: params.reason.trim(),
        },
      });

      if (params.decision === 'APPROVE' && evaluation.sessionStatus !== 'APPROVED') {
        throw new ConflictException(
          `Không thể duyệt phiên xác minh (${evaluation.reviewReason || 'VALIDATION_FAILED'}). Nếu CCCD đang gắn tài khoản khác, hãy xử lý tranh chấp/thu hồi tài khoản cũ trước.`,
        );
      }

      return {
        status: evaluation.sessionStatus,
        reviewReason: evaluation.reviewReason,
      };
    });
  }

  /**
   * Explicit audited revocation for account transfer or verified identity dispute resolution.
   * Uses canonical lock order: users FOR UPDATE -> sessions ORDER BY id ASC FOR UPDATE -> advisory lock.
   * Revokes ALL non-deleted sessions and records kyc_revoked_at watermark so stale sessions stay terminal.
   */
  async revokeUserIdentityAtomicTx(params: {
    targetUserId: bigint;
    adminUserId: bigint;
    reason: string;
  }): Promise<{
    userId: string;
    previousKycStatus: string;
    revokedSessionCount: number;
  }> {
    if (!params.reason || params.reason.trim().length < 5) {
      throw new BadRequestException('Lý do thu hồi định danh không hợp lệ');
    }

    return this.prisma.$transaction(async (tx) => {
      const userRows = await tx.$queryRaw<any[]>`
        SELECT "user_id", "kyc_status", "verified_document_hash", "kyc_revoked_at"
        FROM "users"
        WHERE "user_id" = ${params.targetUserId}
        FOR UPDATE;
      `;

      if (!userRows || userRows.length === 0) {
        throw new NotFoundException('Không tìm thấy tài khoản cần thu hồi định danh');
      }

      const lockedUser = userRows[0];

      const sessionRows = await tx.$queryRaw<any[]>`
        SELECT "id", "status", "review_reason", "verified_document_hash", "metadata"
        FROM "identity_verification_sessions"
        WHERE "user_id" = ${params.targetUserId}
          AND "deleted_at" IS NULL
        ORDER BY "id" ASC
        FOR UPDATE;
      `;

      // Lock relevant document hashes LAST to match applyKycEvaluationInTx lock order (user -> session -> advisory)
      const docHashesToLock = Array.from(
        new Set(
          [
            lockedUser.verified_document_hash,
            ...(sessionRows || []).map((s) => s.verified_document_hash),
          ].filter((h): h is string => typeof h === 'string' && h.length > 0),
        ),
      ).sort();

      for (const hashToLock of docHashesToLock) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('kyc_doc'), hashtext(${hashToLock}))`;
      }

      const now = new Date();
      let revokedSessionCount = 0;

      for (const s of sessionRows || []) {
        if (s.status !== 'REVOKED' && s.status !== 'DELETED') {
          const meta = this.mergeSessionMetadata(s.metadata, null, null);
          meta.revokedAudit = {
            previousStatus: s.status,
            previousReviewReason: s.review_reason || null,
            adminUserId: params.adminUserId.toString(),
            reason: params.reason.trim(),
            revokedAt: now.toISOString(),
          };
          await tx.identityVerificationSession.update({
            where: { id: BigInt(s.id) },
            data: {
              status: 'REVOKED',
              reviewReason: 'ADMIN_REVOKED',
              reviewedByUserId: params.adminUserId,
              reviewedAt: now,
              reviewNote: params.reason.trim(),
              metadata: meta,
            },
          });
          revokedSessionCount++;
        }
      }

      await tx.user.update({
        where: { userId: params.targetUserId },
        data: {
          kycStatus: 'UNVERIFIED',
          verifiedLegalName: null,
          verifiedDocumentHash: null,
          verifiedDocumentEncrypted: null,
          verifiedDocumentMasked: null,
          verifiedDateOfBirth: null,
          verifiedNationality: null,
          kycVerifiedAt: null,
          kycRevokedAt: now,
        },
      });

      return {
        userId: params.targetUserId.toString(),
        previousKycStatus: lockedUser.kyc_status,
        revokedSessionCount,
      };
    });
  }

  /**
   * Lock a single session row with FOR UPDATE and sanitize legacy raw CCCD/vendor fields
   * only if live locked metadata still requires sanitization.
   */
  async sanitizeSessionMetadataAtomicTx(sessionId: bigint): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<any[]>`
        SELECT "id", "metadata", "verified_document_hash", "deleted_at"
        FROM "identity_verification_sessions"
        WHERE "id" = ${sessionId}
        FOR UPDATE;
      `;
      if (!rows || rows.length === 0 || rows[0].deleted_at !== null) {
        return false;
      }

      const locked = rows[0];
      if (!this.hasDirtySessionMetadata(locked.metadata)) {
        return false;
      }

      const sanitizedMeta = this.mergeSessionMetadata(locked.metadata, null, null);
      const extracted = this.resolveEffectiveIdentityFromState(locked, sanitizedMeta, null);
      const nextDocHash = locked.verified_document_hash || extracted.docHash || null;

      await tx.identityVerificationSession.update({
        where: { id: BigInt(locked.id) },
        data: {
          metadata: sanitizedMeta,
          ...(nextDocHash && !locked.verified_document_hash
            ? { verifiedDocumentHash: nextDocHash }
            : {}),
        },
      });
      return true;
    });
  }

  /**
   * Transactional legacy KYC backfill worker sharing applyKycEvaluationInTx with runtime.
   * Canonical lock order: discovery -> users FOR UPDATE -> session FOR UPDATE -> advisory lock.
   * Re-evaluates ALL preconditions (REVOKED/watermark, ADMIN_DECLINED, eligible legacy status,
   * bound identity, live user full_name) from current locked DB rows before any write.
   */
  async backfillLegacySessionAtomicTx(params: {
    sessionId: bigint;
    prefetchedOcr?: ExtractedDiditOcr | null;
  }): Promise<{
    outcome:
      | 'PROMOTED'
      | 'DUPLICATE_PARKED'
      | 'MISMATCH_PARKED'
      | 'OCR_MISSING_PARKED'
      | 'SKIPPED_REVOKED'
      | 'SKIPPED_ADMIN_DECLINED'
      | 'SKIPPED_ALREADY_BOUND'
      | 'SKIPPED_INELIGIBLE';
    reviewReason: string | null;
  }> {
    return this.prisma.$transaction(async (tx) => {
      const discoveryRows = await tx.$queryRaw<any[]>`
        SELECT "id", "user_id", "deleted_at"
        FROM "identity_verification_sessions"
        WHERE "id" = ${params.sessionId}
        LIMIT 1;
      `;

      if (!discoveryRows || discoveryRows.length === 0 || discoveryRows[0].deleted_at !== null) {
        return { outcome: 'SKIPPED_INELIGIBLE', reviewReason: 'SESSION_MISSING_OR_DELETED' };
      }

      const userId = BigInt(discoveryRows[0].user_id);
      const lockedUser = await this.lockUserForKycUpdateInTx(tx, userId);
      if (!lockedUser) {
        return { outcome: 'SKIPPED_INELIGIBLE', reviewReason: 'USER_NOT_FOUND' };
      }

      const sessionRows = await tx.$queryRaw<any[]>`
        SELECT
          "id",
          "user_id",
          "status",
          "metadata",
          "verified_document_hash",
          "review_reason",
          "reviewed_by_user_id",
          "completed_at",
          "created_at",
          "deleted_at"
        FROM "identity_verification_sessions"
        WHERE "id" = ${params.sessionId}
        ORDER BY "id" ASC
        FOR UPDATE;
      `;

      if (!sessionRows || sessionRows.length === 0 || sessionRows[0].deleted_at !== null) {
        return { outcome: 'SKIPPED_INELIGIBLE', reviewReason: 'SESSION_MISSING_OR_DELETED' };
      }

      const lockedSession = sessionRows[0];

      // 1. Respect REVOKED and monotonic kyc_revoked_at watermark BEFORE missing-OCR or promotion writes
      const sessionRevokedByWatermark =
        Boolean(lockedSession.created_at && lockedUser.kyc_revoked_at) &&
        new Date(lockedSession.created_at).getTime() <=
          new Date(lockedUser.kyc_revoked_at).getTime();

      if (lockedSession.status === 'REVOKED' || sessionRevokedByWatermark) {
        return {
          outcome: 'SKIPPED_REVOKED',
          reviewReason: lockedSession.review_reason || 'ADMIN_REVOKED',
        };
      }

      // 2. Respect manual ADMIN_DECLINED / reviewed decisions unconditionally
      const isManualAdminDeclined =
        lockedSession.status === 'DECLINED' &&
        (lockedSession.review_reason === 'ADMIN_DECLINED' ||
          (lockedSession.reviewed_by_user_id !== null &&
            lockedSession.reviewed_by_user_id !== undefined));

      if (isManualAdminDeclined) {
        return {
          outcome: 'SKIPPED_ADMIN_DECLINED',
          reviewReason: lockedSession.review_reason || 'ADMIN_DECLINED',
        };
      }

      // 3. Re-verify session is still an eligible legacy candidate after locking
      const isEligibleLegacySession =
        lockedSession.status === 'APPROVED' ||
        (lockedSession.status === 'IN_REVIEW' &&
          ['LEGACY_OCR_MISSING', 'LEGACY_BACKFILL_REQUIRED'].includes(
            String(lockedSession.review_reason || ''),
          ));

      if (!isEligibleLegacySession) {
        return {
          outcome: 'SKIPPED_INELIGIBLE',
          reviewReason: lockedSession.review_reason || `SESSION_STATUS_${lockedSession.status}`,
        };
      }

      // 4. Never overwrite an identity already bound concurrently on user
      if (lockedUser.verified_document_hash || lockedUser.verified_legal_name) {
        return {
          outcome: 'SKIPPED_ALREADY_BOUND',
          reviewReason: 'USER_ALREADY_BOUND',
        };
      }

      // 5. Preserve live locked session OCR first; only fill missing fields from pre-fetched Didit response
      const liveSanitizedMeta = this.mergeSessionMetadata(lockedSession.metadata, null, null);
      const liveIdentity = this.resolveEffectiveIdentityFromState(
        lockedSession,
        liveSanitizedMeta,
        null,
      );

      let fillGapOcr: ExtractedDiditOcr | null = null;
      if (params.prefetchedOcr && (!liveIdentity.ocrName || !liveIdentity.docHash)) {
        const mergedName = liveIdentity.ocrName || params.prefetchedOcr.fullName || null;
        const mergedDocNorm =
          (!liveIdentity.docHash ? params.prefetchedOcr.documentNumberNormalized : null) || null;
        const mergedDocHash = liveIdentity.docHash || params.prefetchedOcr.documentHash || null;
        fillGapOcr = {
          fullName: mergedName,
          documentNumberNormalized: mergedDocNorm,
          documentNumberMasked:
            liveIdentity.docMasked || params.prefetchedOcr.documentNumberMasked || null,
          documentHash: mergedDocHash,
          dateOfBirth: liveIdentity.ocrDob || params.prefetchedOcr.dateOfBirth || null,
          nationality: liveIdentity.ocrNationality || params.prefetchedOcr.nationality || null,
          expiryDate: liveSanitizedMeta.expiryDate || params.prefetchedOcr.expiryDate || null,
          hasCompleteIdentity: Boolean(mergedName && mergedDocHash),
          warnings: params.prefetchedOcr.warnings || [],
        };
      }

      // 6. Delegate inside the SAME locked transaction to the unified runtime KYC evaluator
      const evaluation = await this.applyKycEvaluationInTx(tx, {
        lockedSession,
        lockedUser,
        providerStatus: 'APPROVED',
        incomingOcr: fillGapOcr,
        ocrMissingReason: 'LEGACY_OCR_MISSING',
      });

      if (evaluation.sessionStatus === 'APPROVED') {
        return { outcome: 'PROMOTED', reviewReason: null };
      }
      if (evaluation.reviewReason === 'DUPLICATE_DOCUMENT') {
        return { outcome: 'DUPLICATE_PARKED', reviewReason: 'DUPLICATE_DOCUMENT' };
      }
      if (evaluation.reviewReason === 'NAME_MISMATCH') {
        return { outcome: 'MISMATCH_PARKED', reviewReason: 'NAME_MISMATCH' };
      }
      return {
        outcome: 'OCR_MISSING_PARKED',
        reviewReason: evaluation.reviewReason || 'LEGACY_OCR_MISSING',
      };
    });
  }

  async createWebhookEvent(data: {
    eventId?: string | null;
    diditSessionId?: string | null;
    eventType: string;
    status: string;
    payloadHash: string;
    processedAt?: Date | null;
  }): Promise<DiditWebhookEvent> {
    return this.prisma.diditWebhookEvent.create({
      data: {
        eventId: data.eventId || null,
        diditSessionId: data.diditSessionId || null,
        eventType: data.eventType,
        status: data.status,
        payloadHash: data.payloadHash,
        processedAt: data.processedAt || new Date(),
      },
    });
  }
}
