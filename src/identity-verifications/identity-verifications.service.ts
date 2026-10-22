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
import { DiditClientService } from './didit-client.service';
import { IdentityVerificationSession } from '@prisma/client';

export interface SessionResponseDto {
  sessionId: string;
  userId: string;
  diditSessionId: string;
  workflowId: string;
  status: string;
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
  ) {}

  private mapToDto(session: IdentityVerificationSession): SessionResponseDto {
    return {
      sessionId: session.id.toString(),
      userId: session.userId.toString(),
      diditSessionId: session.diditSessionId,
      workflowId: session.workflowId,
      status: session.status,
      verificationUrl: session.verificationUrl,
      metadata: session.metadata,
      expiresAt: session.expiresAt ? session.expiresAt.toISOString() : null,
      completedAt: session.completedAt ? session.completedAt.toISOString() : null,
      createdAt: session.createdAt.toISOString(),
    };
  }

  /**
   * Create a new verification session with Didit API v3
   */
  async createSession(userId: bigint): Promise<SessionResponseDto> {
    // 1. Check if user already has an active pending session to prevent duplicate vendor session fees
    const existingPending = await this.repo.findActivePendingSession(userId);
    if (existingPending) {
      this.logger.log(`[Didit KYC] Reusing active pending session #${existingPending.id} for user #${userId}`);
      return this.mapToDto(existingPending);
    }

    // 2. Compose vendorData securely on server-side
    const vendorData = `user-${userId.toString()}`;
    const callbackUrl =
      process.env.DIDIT_CALLBACK_URL ||
      'https://buttontdash.vercel.app/verification/callback';

    // 3. Call Didit API v3
    const diditResponse = await this.diditClient.createSession(vendorData, callbackUrl);

    // 4. Save session record into database
    const expiresAt = diditResponse.expires_at ? new Date(diditResponse.expires_at) : null;
    const session = await this.repo.createSession({
      userId,
      diditSessionId: diditResponse.session_id,
      workflowId: diditResponse.workflow_id || process.env.DIDIT_WORKFLOW_ID || 'default',
      vendorData,
      status: 'PENDING',
      verificationUrl: diditResponse.url,
      expiresAt,
    });

    // 5. Update user KYC status to PENDING
    await this.repo.updateUserKycStatus(userId, 'PENDING');

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

    // BOLA Authorization Check
    const isOwner = session.userId === BigInt(user.id);
    const isAdmin = user.role === 'ADMIN' || (user.roles && user.roles.includes('ADMIN'));

    if (!isOwner && !isAdmin) {
      throw new ForbiddenException('Bạn không có quyền truy cập phiên xác minh này');
    }

    return this.mapToDto(session);
  }

  /**
   * Server-to-server decision fallback
   */
  async getDecision(sessionId: bigint, user: any): Promise<{ status: string; decision: any }> {
    const session = await this.repo.findSessionById(sessionId);
    if (!session || session.deletedAt !== null) {
      throw new NotFoundException('Không tìm thấy phiên xác minh danh tính');
    }

    // BOLA Authorization Check
    const isOwner = session.userId === BigInt(user.id);
    const isAdmin = user.role === 'ADMIN' || (user.roles && user.roles.includes('ADMIN'));

    if (!isOwner && !isAdmin) {
      throw new ForbiddenException('Bạn không có quyền truy cập phiên xác minh này');
    }

    const decisionResponse = await this.diditClient.getDecision(session.diditSessionId);

    // Sync state if decision returned updated terminal status
    if (decisionResponse?.status) {
      const rawStatus = decisionResponse.status.toLowerCase();
      let newStatus: string | null = null;
      if (rawStatus.includes('approved')) newStatus = 'APPROVED';
      else if (rawStatus.includes('declined')) newStatus = 'DECLINED';
      else if (rawStatus.includes('review')) newStatus = 'IN_REVIEW';
      else if (rawStatus.includes('expired')) newStatus = 'EXPIRED';

      if (newStatus && session.status !== 'APPROVED') {
        await this.repo.updateSessionStatus(session.id, newStatus, new Date());
        if (newStatus === 'APPROVED') {
          await this.repo.updateUserKycStatus(session.userId, 'APPROVED');
        }
      }
    }

    return {
      status: session.status,
      decision: decisionResponse,
    };
  }

  /**
   * List sessions with role-based filtering
   */
  async listSessions(user: any, page = 1, pageSize = 20) {
    const p = Math.max(1, page);
    const ps = Math.min(100, Math.max(1, pageSize));
    const skip = (p - 1) * ps;

    const isAdmin = user.role === 'ADMIN' || (user.roles && user.roles.includes('ADMIN'));

    let sessions: IdentityVerificationSession[];
    let totalItems: number;

    if (isAdmin) {
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
   * Safe delete session: calls Didit delete API FIRST, then soft-deletes locally
   */
  async deleteSession(sessionId: bigint, user: any): Promise<{ success: boolean; message: string }> {
    const session = await this.repo.findSessionById(sessionId);
    if (!session || session.deletedAt !== null) {
      throw new NotFoundException('Không tìm thấy phiên xác minh danh tính để xóa');
    }

    // 1. Call Didit API v1 delete endpoint first
    this.logger.log(`[Didit KYC] Deleting session ${session.diditSessionId} on Didit server...`);
    await this.diditClient.deleteSession(session.diditSessionId);

    // 2. Only after Didit responds successfully, soft-delete locally to preserve audit trail
    await this.repo.softDeleteSession(session.id);
    this.logger.log(`[Didit KYC] Soft-deleted session #${session.id} locally`);

    return {
      success: true,
      message: 'Xóa phiên xác minh thành công',
    };
  }

  /**
   * Webhook Ingestion & Anti-Downgrade State Machine
   * Concurrency-safe via single atomic transaction:
   * 1. Acquires row-level lock (FOR UPDATE) on session and user.
   * 2. Atomic idempotency insert (ON CONFLICT DO NOTHING) covers both payload_hash AND event_id.
   * 3. Rolls back completely on failure so retries are never locked out.
   */
  async handleWebhook(rawBody: Buffer, payload: any): Promise<{ success: boolean; message: string }> {
    if (!Buffer.isBuffer(rawBody)) {
      throw new BadRequestException('Thiếu raw body webhook buffer hợp lệ');
    }

    const payloadHash = crypto.createHash('sha256').update(rawBody).digest('hex');
    const eventId = payload?.event_id || payload?.id || null;
    const eventType = payload?.event_type || payload?.type || 'unknown';
    const rawStatus = (payload?.status || payload?.data?.status || 'UNKNOWN').toString();
    const diditSessionId =
      payload?.session_id ||
      payload?.data?.session_id ||
      payload?.session?.id ||
      null;

    let sanitizedMetadata: any = undefined;
    if (eventType === 'data.updated') {
      const ocrSource = payload?.data || payload;
      sanitizedMetadata = {
        fullName: ocrSource?.full_name || ocrSource?.name || null,
        documentNumber: ocrSource?.document_number || ocrSource?.id_number || null,
        dateOfBirth: ocrSource?.date_of_birth || ocrSource?.dob || null,
        nationality: ocrSource?.nationality || 'VNM',
        expiryDate: ocrSource?.expiry_date || null,
        updatedAt: new Date().toISOString(),
      };
    }

    const result = await this.repo.executeAtomicWebhookTransaction({
      eventId,
      diditSessionId,
      eventType,
      rawStatus,
      payloadHash,
      sanitizedMetadata,
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
      `[Didit Webhook] Processed ${eventType} for session ${diditSessionId}: status=${result.sessionStatus}`,
    );
    return { success: true, message: 'Webhook processed successfully' };
  }
}
