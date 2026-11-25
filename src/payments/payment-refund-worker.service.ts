import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentRefundsRepository } from './payment-refunds.repository';
import { PaymentRefundsService } from './payment-refunds.service';

@Injectable()
export class PaymentRefundWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PaymentRefundWorkerService.name);
  private timer: NodeJS.Timeout | null = null;
  private isRunning = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: PaymentRefundsRepository,
    private readonly paymentRefundsService: PaymentRefundsService,
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
      await this.reconcilePendingAttemptsBatch(10);
    } catch (err: any) {
      this.logger.error(`[PaymentRefundWorker] Tick error: ${err?.message}`);
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Claims committed PAYMENT_REFUND_PAYOUT OutboxEvents with FOR UPDATE SKIP LOCKED and executes post-commit PayOS dispatch.
   */
  async processOutboxDispatchBatch(limit = 10): Promise<{ processed: number; failed: number }> {
    const batchSize = Math.max(1, Math.min(50, Number(limit) || 10));
    const claimToken = crypto.randomUUID();
    const results = { processed: 0, failed: 0 };

    const events = await this.prisma.$transaction(async (tx) => {
      const pending = await tx.$queryRawUnsafe<any[]>(
        `SELECT id, event_type, payload, attempts
         FROM outbox_events
         WHERE event_type = 'PAYMENT_REFUND_PAYOUT'
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
        const dispatchRes = await this.paymentRefundsService.dispatchClaimedAttempt(
          BigInt(payload.obligationId),
          BigInt(payload.attemptId),
        );
        if (
          dispatchRes?.action === 'PREFLIGHT_RETRY_PENDING' ||
          dispatchRes?.action === 'IN_FLIGHT_PREFLIGHT'
        ) {
          await this.prisma.outboxEvent.updateMany({
            where: { id: ev.id, claimToken: ev.claimToken },
            data: {
              status: 'PENDING',
              nextAttemptAt: new Date(Date.now() + 5_000),
              lockedUntil: null,
            },
          });
        } else {
          await this.prisma.outboxEvent.updateMany({
            where: { id: ev.id, claimToken: ev.claimToken },
            data: { status: 'COMPLETED', processedAt: new Date(), lockedUntil: null },
          });
        }
        results.processed++;
      } catch (err: any) {
        results.failed++;
        const nextAttempts = Number(ev.attempts || 0) + 1;
        await this.prisma.outboxEvent.updateMany({
          where: { id: ev.id, claimToken: ev.claimToken },
          data: {
            status: nextAttempts >= 5 ? 'FAILED' : 'PENDING',
            error: String(err?.message || 'Unknown error').slice(0, 500),
            nextAttemptAt: new Date(Date.now() + 15_000 * nextAttempts),
            lockedUntil: null,
          },
        });
      }
    }

    return results;
  }

  async reconcilePendingAttemptsBatch(limit = 10): Promise<{ reconciled: number; total: number }> {
    const attempts = await this.repo.findPendingReconciliationAttempts(limit);
    let reconciled = 0;
    for (const att of attempts) {
      try {
        const res = await this.paymentRefundsService.reconcileAttempt(
          BigInt(att.obligationId),
          BigInt(att.attemptId),
        );
        if (res.settled) reconciled++;
      } catch (err: any) {
        this.logger.warn(
          `[PaymentRefundWorker] Reconcile failed for attempt #${att.attemptId}: ${err?.message}`,
        );
      }
    }
    return { reconciled, total: attempts.length };
  }
}
