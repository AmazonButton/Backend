import {
  Injectable,
  Inject,
  Logger,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { IdentityVerificationsRepository } from './identity-verifications.repository';
import { DiditClientService, DiditExpectedDetails } from './didit-client.service';
import { IdentityVerificationSession } from '@prisma/client';
import { CryptoVaultUtil } from '../common/utils/crypto-vault.util';
import {
  ExtractedDiditOcr,
  extractDiditOcrIdentity,
  mapDiditProviderStatus,
  splitVietnameseExpectedName,
} from './identity-match.util';

export interface SessionResponseDto {
  sessionId: string;
  userId: string;
  diditSessionId: string;
  workflowId: string;
  status: string;
  reviewReason: string | null;
  reviewedByUserId: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  verificationUrl: string;
  metadata?: any;
  expiresAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

@Injectable()
export class IdentityVerificationsService {
  private readonly logger = new Logger(IdentityVerificationsService.name);

  constructor(
    @Inject(IdentityVerificationsRepository)
    private readonly repo: IdentityVerificationsRepository,
    @Inject(DiditClientService)
    private readonly diditClient: DiditClientService,
  ) { }

  private isAdminUser(user: any): boolean {
    const adminRoles = new Set(['ADMIN', 'SUPER_ADMIN', 'SYSTEM_ADMIN']);
    if (typeof user?.role === 'string' && adminRoles.has(user.role.toUpperCase())) {
      return true;
    }
    if (Array.isArray(user?.roles)) {
      return user.roles.some(
        (r: unknown) => typeof r === 'string' && adminRoles.has(r.toUpperCase()),
      );
    }
    return false;
  }

  private sanitizeMetadataForResponse(rawMetadata: any): any {
    if (!rawMetadata || typeof rawMetadata !== 'object' || Array.isArray(rawMetadata)) {
      return rawMetadata ?? null;
    }

    const src = rawMetadata as Record<string, any>;
    const rawDocCandidate = [
      src.documentNumberMasked,
      src.documentNumber,
      src.document_number,
      src.personal_number,
      src.id_number,
      src.id_card,
      src.identification_number,
    ].find((val) => typeof val === 'string' && val.trim().length > 0);

    let safeMaskedDoc: string | null = null;
    if (rawDocCandidate) {
      const trimmed = rawDocCandidate.trim();
      if (trimmed.includes('*')) {
        safeMaskedDoc = trimmed;
      } else {
        const normalized = CryptoVaultUtil.normalizeIdentityDocument(trimmed);
        safeMaskedDoc = normalized
          ? CryptoVaultUtil.maskIdentityDocument(normalized)
          : '********';
      }
    }

    const safe: Record<string, any> = {};
    const fullName =
      typeof src.fullName === 'string' && src.fullName.trim()
        ? src.fullName.trim()
        : typeof src.full_name === 'string' && src.full_name.trim()
          ? src.full_name.trim()
          : null;
    if (fullName) safe.fullName = fullName;

    if (safeMaskedDoc) {
      safe.documentNumber = safeMaskedDoc;
      safe.documentNumberMasked = safeMaskedDoc;
    }
    if (typeof src.dateOfBirth === 'string' && src.dateOfBirth.trim()) {
      safe.dateOfBirth = src.dateOfBirth.trim();
    }
    if (typeof src.nationality === 'string' && src.nationality.trim()) {
      safe.nationality = src.nationality.trim();
    }
    if (typeof src.expiryDate === 'string' && src.expiryDate.trim()) {
      safe.expiryDate = src.expiryDate.trim();
    }
    if (typeof src.providerStatus === 'string') {
      safe.providerStatus = src.providerStatus;
    }
    if (typeof src.providerApproved === 'boolean') {
      safe.providerApproved = src.providerApproved;
    }
    if (typeof src.expectedAccountName === 'string' || src.expectedAccountName === null) {
      safe.expectedAccountName = src.expectedAccountName;
    }
    if (Array.isArray(src.warnings)) {
      safe.warnings = src.warnings.map((w: any) => ({
        feature: typeof w?.feature === 'string' ? w.feature : null,
        code: typeof w?.code === 'string' ? w.code : null,
        risk: typeof w?.risk === 'string' ? w.risk : null,
        shortDescription: typeof w?.shortDescription === 'string' ? w.shortDescription : null,
      }));
    }
    if (src.identityCheck && typeof src.identityCheck === 'object') {
      safe.identityCheck = {
        status: src.identityCheck.status ?? null,
        reason: src.identityCheck.reason ?? null,
        matchType: src.identityCheck.matchType ?? null,
        expectedNameSource: src.identityCheck.expectedNameSource ?? null,
        expectedNormalized: src.identityCheck.expectedNormalized ?? null,
        ocrNormalized: src.identityCheck.ocrNormalized ?? null,
        conflictingUserExists:
          typeof src.identityCheck.conflictingUserExists === 'boolean'
            ? src.identityCheck.conflictingUserExists
            : undefined,
        hasOcrName:
          typeof src.identityCheck.hasOcrName === 'boolean'
            ? src.identityCheck.hasOcrName
            : undefined,
        hasDocumentNumber:
          typeof src.identityCheck.hasDocumentNumber === 'boolean'
            ? src.identityCheck.hasDocumentNumber
            : undefined,
        adminUserId: src.identityCheck.adminUserId ?? undefined,
        reasonDetail: src.identityCheck.reasonDetail ?? undefined,
        checkedAt: src.identityCheck.checkedAt ?? null,
      };
    }
    if (src.lastAdminReview && typeof src.lastAdminReview === 'object') {
      safe.lastAdminReview = {
        adminUserId: src.lastAdminReview.adminUserId ?? null,
        reason: src.lastAdminReview.reason ?? null,
        outcome: src.lastAdminReview.outcome ?? null,
        reviewedAt: src.lastAdminReview.reviewedAt ?? null,
      };
    }
    if (src.revokedAudit && typeof src.revokedAudit === 'object') {
      safe.revokedAudit = {
        previousStatus: src.revokedAudit.previousStatus ?? null,
        adminUserId: src.revokedAudit.adminUserId ?? null,
        reason: src.revokedAudit.reason ?? null,
        revokedAt: src.revokedAudit.revokedAt ?? null,
      };
    }
    if (typeof src.updatedAt === 'string') {
      safe.updatedAt = src.updatedAt;
    }

    return safe;
  }

  private sanitizeDecisionForResponse(
    decisionResponse: any,
    extractedOcr: ExtractedDiditOcr | null,
    reconciled: { status: string; reviewReason: string | null },
  ) {
    const safeWarnings = Array.isArray(extractedOcr?.warnings)
      ? extractedOcr.warnings.map((w) => ({
        feature: w.feature,
        code: w.code,
        risk: w.risk,
        shortDescription: w.shortDescription,
      }))
      : [];

    return {
      session_id: decisionResponse?.session_id ?? null,
      workflow_id: decisionResponse?.workflow_id ?? null,
      status: decisionResponse?.status ?? reconciled.status,
      effectiveStatus: reconciled.status,
      reviewReason: reconciled.reviewReason ?? null,
      created_at: decisionResponse?.created_at ?? null,
      updated_at: decisionResponse?.updated_at ?? null,
      verifiedIdentity: extractedOcr
        ? {
          fullName: extractedOcr.fullName ?? null,
          documentNumberMasked: extractedOcr.documentNumberMasked ?? null,
          dateOfBirth: extractedOcr.dateOfBirth ?? null,
          nationality: extractedOcr.nationality ?? null,
          expiryDate: extractedOcr.expiryDate ?? null,
        }
        : null,
      warnings: safeWarnings,
    };
  }

  private mapToDto(session: IdentityVerificationSession): SessionResponseDto {
    const s = session as any;
    return {
      sessionId: session.id.toString(),
      userId: session.userId.toString(),
      diditSessionId: session.diditSessionId,
      workflowId: session.workflowId,
      status: session.status,
      reviewReason: s.reviewReason ?? null,
      reviewedByUserId: s.reviewedByUserId ? s.reviewedByUserId.toString() : null,
      reviewedAt: s.reviewedAt ? new Date(s.reviewedAt).toISOString() : null,
      reviewNote: s.reviewNote ?? null,
      verificationUrl: session.verificationUrl,
      metadata: this.sanitizeMetadataForResponse(session.metadata),
      expiresAt: session.expiresAt ? session.expiresAt.toISOString() : null,
      completedAt: session.completedAt ? session.completedAt.toISOString() : null,
      createdAt: session.createdAt.toISOString(),
    };
  }

  private buildExpectedDetails(userContext: any): DiditExpectedDetails | null {
    if (!userContext) return null;
    const expected: DiditExpectedDetails = {};
    const targetName = userContext.verifiedLegalName || userContext.fullName;
    const splitName = splitVietnameseExpectedName(targetName);
    if (splitName) {
      expected.first_name = splitName.first_name;
      if (splitName.last_name) {
        expected.last_name = splitName.last_name;
      }
    }

    if (userContext.verifiedDocumentEncrypted) {
      try {
        expected.identification_number = CryptoVaultUtil.decryptAccountNumber(
          userContext.verifiedDocumentEncrypted,
        );
      } catch {
        // Non-fatal if key rotated in test fixture; backend TX still verifies hash
      }
    }

    if (typeof userContext.verifiedDateOfBirth === 'string' && userContext.verifiedDateOfBirth.trim()) {
      expected.date_of_birth = userContext.verifiedDateOfBirth.trim();
    }
    if (typeof userContext.verifiedNationality === 'string' && userContext.verifiedNationality.trim()) {
      expected.nationality = userContext.verifiedNationality.trim();
      expected.id_country = userContext.verifiedNationality.trim();
    }

    return Object.keys(expected).length > 0 ? expected : null;
  }

  /**
   * Create a new verification session with Didit API v3 (including expected_details cross-check)
   */
  async createSession(userId: bigint): Promise<SessionResponseDto> {
    // 1. Check if user already has an active pending session to prevent duplicate vendor session fees
    const existingPending = await this.repo.findActivePendingSession(userId);
    if (existingPending) {
      this.logger.log(`[Didit KYC] Reusing active pending session #${existingPending.id} for user #${userId}`);
      return this.mapToDto(existingPending);
    }

    // 2. Load account/verified legal identity context for expected_details
    const userContext =
      typeof (this.repo as any).findUserIdentityContext === 'function'
        ? await (this.repo as any).findUserIdentityContext(userId)
        : null;
    if (typeof (this.repo as any).findUserIdentityContext === 'function' && !userContext) {
      throw new NotFoundException('Không tìm thấy tài khoản người dùng');
    }

    // 3. Compose vendorData and fixed callback URL securely on server-side
    const vendorData = `user-${userId.toString()}`;
    const defaultFrontendUrl = (
      process.env.FRONTEND_URL || 'https://smart-order-button.vercel.app'
    )
      .trim()
      .replace(/\/+$/, '');
    const callbackUrl =
      process.env.DIDIT_CALLBACK_URL ||
      `${defaultFrontendUrl}/customer/profile?tab=IDENTITY`;

    const expectedDetails = this.buildExpectedDetails(userContext);

    // 4. Call Didit API v3
    const diditResponse = await this.diditClient.createSession(
      vendorData,
      callbackUrl,
      expectedDetails ? { expectedDetails } : undefined,
    );

    // Ensure post-revoke sessions always carry createdAt strictly greater than kycRevokedAt
    const now = new Date();
    const minPostRevokeAt =
      userContext?.kycRevokedAt &&
        now.getTime() <= new Date(userContext.kycRevokedAt).getTime()
        ? new Date(new Date(userContext.kycRevokedAt).getTime() + 2)
        : undefined;

    // 5. Save session record into database
    const expiresAt = diditResponse.expires_at ? new Date(diditResponse.expires_at) : null;
    const session = await this.repo.createSession({
      userId,
      diditSessionId: diditResponse.session_id,
      workflowId: diditResponse.workflow_id || process.env.DIDIT_WORKFLOW_ID || 'default',
      vendorData,
      status: 'PENDING',
      verificationUrl: diditResponse.url,
      expiresAt,
      metadata: expectedDetails
        ? {
          expectedAccountName:
            userContext?.verifiedLegalName || userContext?.fullName || null,
        }
        : undefined,
      ...(minPostRevokeAt ? { createdAt: minPostRevokeAt } : {}),
    });

    // 6. Update user KYC status to PENDING without downgrading already APPROVED users
    const currentKycStatus =
      userContext?.kycStatus ??
      (typeof (this.repo as any).findUserKycStatus === 'function'
        ? await (this.repo as any).findUserKycStatus(userId)
        : null);
    if (currentKycStatus !== 'APPROVED') {
      await this.repo.updateUserKycStatus(userId, 'PENDING');
    }

    this.logger.log(`[Didit KYC] Created session #${session.id} for user #${userId} with Didit ID ${session.diditSessionId}`);
    return this.mapToDto(session);
  }

  /**
   * Retrieve session by ID with BOLA protection
   */
  async getSession(sessionId: bigint, user: any): Promise<SessionResponseDto> {
    const session = await this.repo.findSessionById(sessionId);
    if (!session || session.deletedAt !== null) {
      throw new NotFoundException('Không tìm thấy phiên xác minh danh tính');
    }

    const isOwner = session.userId === BigInt(user.id);
    if (!isOwner && !this.isAdminUser(user)) {
      throw new ForbiddenException('Bạn không có quyền truy cập phiên xác minh này');
    }

    return this.mapToDto(session);
  }

  /**
   * Server-to-server decision fallback: fetches Didit decision + OCR, then reconciles atomically
   * under row locks with OCR completeness, name match, and 1-CCCD-1-account uniqueness checks.
   */
  async getDecision(
    sessionId: bigint,
    user: any,
  ): Promise<{ status: string; reviewReason: string | null; decision: any }> {
    const session = await this.repo.findSessionById(sessionId);
    if (!session || session.deletedAt !== null) {
      throw new NotFoundException('Không tìm thấy phiên xác minh danh tính');
    }

    const isOwner = session.userId === BigInt(user.id);
    if (!isOwner && !this.isAdminUser(user)) {
      throw new ForbiddenException('Bạn không có quyền truy cập phiên xác minh này');
    }

    const decisionResponse = await this.diditClient.getDecision(session.diditSessionId);
    const newStatus = mapDiditProviderStatus(decisionResponse?.status);
    const extractedOcr = extractDiditOcrIdentity(decisionResponse);

    const reconciled = await this.repo.reconcileDecisionAtomicTx({
      sessionId: session.id,
      newStatus,
      extractedOcr,
    });

    return {
      status: reconciled.status,
      reviewReason: reconciled.reviewReason ?? null,
      decision: this.sanitizeDecisionForResponse(decisionResponse, extractedOcr, reconciled),
    };
  }

  /**
   * List sessions with role-based filtering
   */
  async listSessions(user: any, page = 1, pageSize = 20) {
    const p = Math.max(1, page);
    const ps = Math.min(100, Math.max(1, pageSize));
    const skip = (p - 1) * ps;

    let sessions: IdentityVerificationSession[];
    let totalItems: number;

    if (this.isAdminUser(user)) {
      [sessions, totalItems] = await Promise.all([
        this.repo.listAllSessions(skip, ps),
        this.repo.countAllSessions(),
      ]);
    } else {
      const userId = BigInt(user.id);
      [sessions, totalItems] = await Promise.all([
        this.repo.listSessionsByUser(userId, skip, ps),
        this.repo.countSessionsByUser(userId),
      ]);
    }

    const totalPages = Math.ceil(totalItems / ps);

    return {
      data: sessions.map((s) => this.mapToDto(s)),
      pagination: {
        page: p,
        pageSize: ps,
        totalItems,
        totalPages,
      },
    };
  }

  /**
   * Admin manual review of IN_REVIEW sessions (name mismatch resolution / explicit decline)
   */
  async reviewSession(
    sessionId: bigint,
    adminUser: any,
    dto: { decision: 'APPROVE' | 'DECLINE'; reason: string; acceptOcrNameAsVerified?: boolean },
  ) {
    if (!this.isAdminUser(adminUser)) {
      throw new ForbiddenException('Chỉ quản trị viên mới có quyền xét duyệt phiên KYC');
    }

    const adminUserId = BigInt(adminUser.id);
    const result = await this.repo.reviewSessionAtomicTx({
      sessionId,
      adminUserId,
      decision: dto.decision,
      reason: dto.reason,
      acceptOcrNameAsVerified: dto.acceptOcrNameAsVerified,
    });

    this.logger.log(
      `[Didit KYC] Admin #${adminUserId} reviewed session #${sessionId}: decision=${dto.decision}, finalStatus=${result.status}`,
    );

    return result;
  }

  /**
   * Admin audited identity revocation for dispute / account-transfer resolution
   */
  async revokeUserIdentity(
    targetUserId: bigint,
    adminUser: any,
    dto: { reason: string },
  ) {
    if (!this.isAdminUser(adminUser)) {
      throw new ForbiddenException('Chỉ quản trị viên mới có quyền thu hồi định danh tài khoản');
    }

    const adminUserId = BigInt(adminUser.id);
    const result = await this.repo.revokeUserIdentityAtomicTx({
      targetUserId,
      adminUserId,
      reason: dto.reason,
    });

    this.logger.log(
      `[Didit KYC] Admin #${adminUserId} revoked KYC identity for user #${targetUserId} (${result.revokedSessionCount} sessions)`,
    );

    return result;
  }

  /**
   * Safe delete session: calls Didit delete API FIRST, then soft-deletes locally
   */
  async deleteSession(sessionId: bigint, user: any): Promise<{ success: boolean; message: string }> {
    const session = await this.repo.findSessionById(sessionId);
    if (!session || session.deletedAt !== null) {
      throw new NotFoundException('Không tìm thấy phiên xác minh danh tính để xóa');
    }

    if (!this.isAdminUser(user)) {
      throw new ForbiddenException('Chỉ quản trị viên mới có quyền xóa phiên xác minh');
    }

    this.logger.log(`[Didit KYC] Deleting session ${session.diditSessionId} on Didit server...`);
    await this.diditClient.deleteSession(session.diditSessionId);

    await this.repo.softDeleteSession(session.id);
    this.logger.log(`[Didit KYC] Soft-deleted session #${session.id} locally`);

    return {
      success: true,
      message: 'Xóa phiên xác minh thành công',
    };
  }

  /**
   * Webhook Ingestion & Identity Verification Gate:
   * - Extracts OCR identity from Didit v3 id_verifications[], decision, or data payload.
   * - On thin status.updated Approved webhooks lacking OCR payload, optionally polls Didit /decision/
   *   best-effort BEFORE opening the DB transaction so missing OCR can be resolved atomically.
   * - Never grants APPROVED without complete OCR, name check, and 1-CCCD-1-account lock.
   */
  async handleWebhook(
    rawBody: Buffer,
    payload: any,
  ): Promise<{ success: boolean; message: string }> {
    if (!Buffer.isBuffer(rawBody)) {
      throw new BadRequestException('Thiếu raw body webhook buffer hợp lệ');
    }

    const payloadHash = crypto.createHash('sha256').update(rawBody).digest('hex');
    const eventId = payload?.event_id || payload?.id || null;
    const eventType = payload?.event_type || payload?.type || 'unknown';
    const rawStatus = (payload?.status || payload?.data?.status || 'UNKNOWN').toString();
    const mappedStatus = mapDiditProviderStatus(rawStatus);
    const diditSessionId =
      payload?.session_id ||
      payload?.data?.session_id ||
      payload?.session?.id ||
      null;

    let extractedOcr = extractDiditOcrIdentity(payload);

    // Best-effort pre-TX OCR hydration for thin status.updated=Approved webhooks without embedded OCR
    if (
      eventType === 'status.updated' &&
      mappedStatus === 'APPROVED' &&
      !extractedOcr?.hasCompleteIdentity &&
      diditSessionId &&
      typeof this.diditClient.isConfigured === 'function' &&
      this.diditClient.isConfigured()
    ) {
      try {
        const existingSession = await this.repo.findSessionByDiditId(diditSessionId);
        const existingHasDocHash = Boolean((existingSession as any)?.verifiedDocumentHash);
        const existingHasName = Boolean((existingSession?.metadata as any)?.fullName);
        if (existingSession && (!existingHasDocHash || !existingHasName)) {
          const decisionFallback = await this.diditClient.getDecision(diditSessionId);
          const fallbackOcr = extractDiditOcrIdentity(decisionFallback);
          if (fallbackOcr) {
            extractedOcr = fallbackOcr;
          }
        }
      } catch (err: any) {
        this.logger.warn(
          `[Didit Webhook] Best-effort /decision OCR fetch failed for ${diditSessionId}: ${err?.message || err}`,
        );
      }
    }

    const result = await this.repo.executeAtomicWebhookTransaction({
      eventId,
      diditSessionId,
      eventType,
      rawStatus,
      mappedStatus,
      payloadHash,
      extractedOcr,
    });

    if (result.status === 'DUPLICATE') {
      this.logger.log(`[Didit Webhook] Duplicate payload/event ${payloadHash.substring(0, 8)}... ignored`);
      return { success: true, message: 'Event already processed' };
    }

    if (result.status === 'UNKNOWN_SESSION') {
      this.logger.warn(`[Didit Webhook] Received ${eventType} for unknown session: ${diditSessionId}`);
      return { success: true, message: 'Webhook received for unknown session' };
    }

    this.logger.log(
      `[Didit Webhook] Processed ${eventType} for session ${diditSessionId}: status=${result.sessionStatus}${result.reviewReason ? ` reviewReason=${result.reviewReason}` : ''
      }`,
    );
    return { success: true, message: 'Webhook processed successfully' };
  }
}
