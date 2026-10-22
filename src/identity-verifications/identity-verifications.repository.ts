import { Injectable, Inject } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { IdentityVerificationSession, DiditWebhookEvent } from '@prisma/client';

@Injectable()
export class IdentityVerificationsRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async createSession(data: {
    userId: bigint;
    diditSessionId: string;
    workflowId: string;
    vendorData: string;
    status: string;
    verificationUrl: string;
    expiresAt?: Date | null;
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
        OR: [
          { expiresAt: null },
          { expiresAt: { gt: new Date() } },
        ],
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

  async updateSessionStatus(
    id: bigint,
    status: string,
    completedAt?: Date | null,
    metadata?: any,
  ): Promise<IdentityVerificationSession> {
    const dataToUpdate: any = { status };
    if (completedAt !== undefined) {
      dataToUpdate.completedAt = completedAt;
    }
    if (metadata !== undefined) {
      dataToUpdate.metadata = metadata;
    }

    return this.prisma.identityVerificationSession.update({
      where: { id },
      data: dataToUpdate,
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

  async updateUserKycStatus(userId: bigint, kycStatus: string): Promise<void> {
    await this.prisma.user.update({
      where: { userId },
      data: { kycStatus },
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
   * Execute entire webhook idempotency lock, session/user row locking, state mutation,
   * and audit timestamp inside a SINGLE atomic transaction.
   *
   * Invariants enforced:
   * 1. If any downstream update fails, the entire transaction rolls back including the webhook insert,
   *    allowing provider retries without permanent duplicate lockout.
   * 2. Row-level locks (SELECT FOR UPDATE) on both session and user serialize concurrent webhooks
   *    (e.g., simultaneous Approved and Declined webhooks).
   * 3. ON CONFLICT DO NOTHING (without target clause) catches duplicates across BOTH payload_hash AND event_id.
   */
  async executeAtomicWebhookTransaction(params: {
    eventId?: string | null;
    diditSessionId?: string | null;
    eventType: string;
    rawStatus: string;
    payloadHash: string;
    sanitizedMetadata?: any;
  }): Promise<{
    status: 'PROCESSED' | 'DUPLICATE' | 'UNKNOWN_SESSION';
    message: string;
    sessionStatus?: string;
  }> {
    const {
      eventId,
      diditSessionId,
      eventType,
      rawStatus,
      payloadHash,
      sanitizedMetadata,
    } = params;

    return this.prisma.$transaction(async (tx) => {
      // 1. If diditSessionId is provided, acquire row-level lock on session immediately
      let lockedSession: any = null;
      if (diditSessionId) {
        const sessionRows = await tx.$queryRaw<any[]>`
          SELECT "id", "user_id", "didit_session_id", "status", "metadata"
          FROM "identity_verification_sessions"
          WHERE "didit_session_id" = ${diditSessionId}
          FOR UPDATE;
        `;
        if (sessionRows && sessionRows.length > 0) {
          lockedSession = sessionRows[0];
        }
      }

      // Foreign key constraint safety: only link diditSessionId if session exists in DB
      const validDiditSessionId = lockedSession ? lockedSession.didit_session_id : null;

      // 2. Atomic Idempotency Insert (detects duplicates across BOTH payload_hash AND event_id)
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
        // Duplicate delivery detected (same payload_hash OR same event_id already processed or committed)
        return {
          status: 'DUPLICATE',
          message: 'Event already processed',
        };
      }

      const webhookRecordId = BigInt(insertedRows[0].id);

      // 3. Unknown session handling: mark webhook audit record processed and exit safely
      if (!lockedSession) {
        await tx.diditWebhookEvent.update({
          where: { id: webhookRecordId },
          data: { processedAt: new Date() },
        });
        return {
          status: 'UNKNOWN_SESSION',
          message: 'Webhook received for unknown session',
        };
      }

      // 4. Acquire row-level lock on User record
      const userId = BigInt(lockedSession.user_id);
      await tx.$queryRaw`
        SELECT "user_id", "kyc_status"
        FROM "users"
        WHERE "user_id" = ${userId}
        FOR UPDATE;
      `;

      // 5. Evaluate state transitions with anti-downgrade guarantees
      let targetStatus = lockedSession.status;
      let shouldUpdateSessionStatus = false;
      let shouldUpdateUserApproved = false;
      let shouldUpdateUserDeclined = false;

      if (eventType === 'status.updated') {
        const statusLower = rawStatus.toLowerCase();
        if (statusLower.includes('approved')) {
          targetStatus = 'APPROVED';
        } else if (statusLower.includes('declined') || statusLower.includes('rejected')) {
          targetStatus = 'DECLINED';
        } else if (statusLower.includes('review')) {
          targetStatus = 'IN_REVIEW';
        } else if (statusLower.includes('expired')) {
          targetStatus = 'EXPIRED';
        } else if (statusLower.includes('abandoned')) {
          targetStatus = 'ABANDONED';
        }

        // Anti-downgrade invariant: APPROVED is terminal and cannot transition to non-APPROVED
        if (lockedSession.status === 'APPROVED' && targetStatus !== 'APPROVED') {
          shouldUpdateSessionStatus = false;
        } else {
          shouldUpdateSessionStatus = true;

          if (targetStatus === 'APPROVED') {
            shouldUpdateUserApproved = true;
          } else if (targetStatus === 'DECLINED') {
            // Check if user has another approved session (within current transaction snapshot)
            const otherApproved = await tx.$queryRaw<any[]>`
              SELECT "id" FROM "identity_verification_sessions"
              WHERE "user_id" = ${userId}
                AND "id" != ${lockedSession.id}
                AND "status" = 'APPROVED'
                AND "deleted_at" IS NULL
              LIMIT 1;
            `;
            if (!otherApproved || otherApproved.length === 0) {
              shouldUpdateUserDeclined = true;
            }
          }
        }
      }

      // 6. Mutate Session status & metadata
      const sessionUpdateData: any = {};
      if (shouldUpdateSessionStatus) {
        sessionUpdateData.status = targetStatus;
        sessionUpdateData.completedAt = new Date();
      }
      if (sanitizedMetadata) {
        sessionUpdateData.metadata = sanitizedMetadata;
      }
      if (Object.keys(sessionUpdateData).length > 0) {
        await tx.identityVerificationSession.update({
          where: { id: lockedSession.id },
          data: sessionUpdateData,
        });
      }

      // 7. Mutate User KYC status
      if (shouldUpdateUserApproved) {
        await tx.user.update({
          where: { userId },
          data: { kycStatus: 'APPROVED' },
        });
      } else if (shouldUpdateUserDeclined) {
        await tx.user.update({
          where: { userId },
          data: { kycStatus: 'DECLINED' },
        });
      }

      // 8. Finalize webhook event processedAt timestamp
      await tx.diditWebhookEvent.update({
        where: { id: webhookRecordId },
        data: { processedAt: new Date() },
      });

      return {
        status: 'PROCESSED',
        message: 'Webhook processed successfully',
        sessionStatus: shouldUpdateSessionStatus ? targetStatus : lockedSession.status,
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
