import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AdminService } from './admin.service';

@Injectable()
export class StoreWithdrawalPayoutWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StoreWithdrawalPayoutWorkerService.name);
  private timer: NodeJS.Timeout | null = null;
  private isRunning = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly adminService: AdminService,
  ) {}

  onModuleInit() {
    if (process.env.NODE_ENV === 'test' || process.env.PAYOS_PAYOUT_WORKER_ENABLED === 'false') {
      return;
    }
    const intervalMs = Math.max(
      1000,
      Number(process.env.PAYOS_PAYOUT_WORKER_INTERVAL_MS) || 2500,
    );
    this.timer = setInterval(async () => {
      await this.runTick();
    }, intervalMs);
    if (this.timer.unref) {
      this.timer.unref();
    }
  }

  onModuleDestroy() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async runTick() {
    if (process.env.PAYOS_PAYOUT_WORKER_ENABLED === 'false') return;
    if (this.isRunning) return;
    this.isRunning = true;
    try {
      await this.processOutboxDispatchBatch(10);
    } catch (err: any) {
      this.logger.error(`[StoreWithdrawalPayoutWorker] Tick error: ${err?.message}`);
    } finally {
      this.isRunning = false;
    }
  }

  async processOutboxDispatchBatch(limit = 10): Promise<{ processed: number; failed: number }> {
    const batchSize = Math.max(1, Math.min(50, Number(limit) || 10));
    const claimToken = crypto.randomUUID();
    const results = { processed: 0, failed: 0 };

    const events = await this.prisma.$transaction(async (tx) => {
      const pending = await tx.$queryRawUnsafe<any[]>(
        `SELECT id, event_type, payload, attempts, status
         FROM outbox_events
         WHERE event_type = 'STORE_WITHDRAWAL_PAYOUT'
           AND (status = 'PENDING' OR (status = 'PROCESSING' AND locked_until < NOW()))
           AND next_attempt_at <= NOW()
         ORDER BY id ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED`,
        batchSize,
      );
      if (!pending || pending.length === 0) return [];
      const ids = pending.map((e) => e.id);
      await tx.$executeRawUnsafe(
        `UPDATE outbox_events
         SET status = 'PROCESSING',
             claim_token = $1,
             locked_until = NOW() + INTERVAL '5 minutes',
             attempts = attempts + 1,
             updated_at = NOW()
         WHERE id = ANY($2::bigint[])`,
        claimToken,
        ids,
      );
      return pending.map((e) => ({ ...e, claimToken }));
    });

    for (const ev of events) {
      try {
        const payload = typeof ev.payload === 'string' ? JSON.parse(ev.payload) : ev.payload;
        const rawWithdrawalId = BigInt(payload.withdrawalId);
        const adminUserId = payload.adminUserId ? BigInt(payload.adminUserId) : null;
        const isRetry = Number(ev.attempts || 0) > 0 || ev.status === 'PROCESSING';

        await this.adminService.dispatchClaimedWithdrawalPayout(rawWithdrawalId, adminUserId, {
          isRetry,
        });

        await this.prisma.outboxEvent.updateMany({
          where: { id: ev.id, claimToken: ev.claimToken },
          data: { status: 'COMPLETED', processedAt: new Date(), lockedUntil: null },
        });
        results.processed++;
      } catch (err: any) {
        results.failed++;
        const nextAttempts = Number(ev.attempts || 0) + 1;
        await this.prisma.outboxEvent.updateMany({
          where: { id: ev.id, claimToken: ev.claimToken },
          data: {
            status: nextAttempts >= 3 ? 'FAILED' : 'PENDING',
            error: String(err?.message || 'Unknown error').slice(0, 500),
            nextAttemptAt: new Date(Date.now() + 15_000 * nextAttempts),
            lockedUntil: null,
          },
        });
      }
    }

    return results;
  }
}
