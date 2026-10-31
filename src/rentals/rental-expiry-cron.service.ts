import { Injectable, Logger, Inject } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class RentalExpiryCronService {
  private readonly logger = new Logger(RentalExpiryCronService.name);

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  @Cron('*/10 * * * *')
  async handleCron() {
    this.logger.log('Starting automated rental and store subscription expiration check...');
    const rentalResult = await this.processExpiredRentals(50);
    const subResult = await this.processExpiredStoreSubscriptions(50);
    this.logger.log(
      `Completed expiration check: ${rentalResult.processedCount} rentals expired, ${subResult.processedCount} store subscriptions expired.`,
    );
  }

  async processExpiredRentals(batchSize: number = 50) {
    const now = new Date();
    const limit = Math.max(1, Math.min(200, batchSize));

    return this.prisma.$transaction(async (tx) => {
      // 1. Lock expired ACTIVE rentals with SKIP LOCKED to avoid concurrency collisions across workers
      const expiredRentals = await tx.$queryRawUnsafe<Array<{
        rental_id: bigint;
        rental_code: string;
        customer_id: bigint;
        effective_expires_at: Date;
        status: string;
      }>>(
        `SELECT rental_id, rental_code, customer_id, effective_expires_at, status
         FROM button_rentals
         WHERE status = 'ACTIVE'
           AND effective_expires_at <= $1
         ORDER BY effective_expires_at ASC
         LIMIT $2
         FOR UPDATE SKIP LOCKED`,
        now,
        limit,
      );

      if (!expiredRentals || expiredRentals.length === 0) {
        return { processedCount: 0, expiredRentalIds: [] };
      }

      const expiredRentalIds: string[] = [];

      for (const r of expiredRentals) {
        // Update rental to EXPIRED
        await tx.$executeRawUnsafe(
          `UPDATE button_rentals
           SET status = 'EXPIRED', updated_at = NOW()
           WHERE rental_id = $1 AND status = 'ACTIVE'`,
          r.rental_id,
        );

        // Lock and disable all buttons assigned to this rental
        await tx.$executeRawUnsafe(
          `UPDATE iot_button
           SET can_order = false, status = 'INACTIVE', updated_at = NOW()
           WHERE rental_id = $1`,
          r.rental_id,
        );

        // Write Audit Log
        if ((tx as any).rentalAuditLog) {
          await (tx as any).rentalAuditLog.create({
            data: {
              actorType: 'SYSTEM',
              actorUserId: null,
              action: 'RENTAL_EXPIRED',
              targetType: 'RENTAL',
              targetId: r.rental_id,
              beforeState: 'ACTIVE',
              afterState: 'EXPIRED',
              correlationId: r.rental_code,
              reason: 'Automatic expiration upon reaching effective_expires_at',
              metadata: {
                effectiveExpiresAt: r.effective_expires_at,
                expiredAt: now,
              },
            },
          });
        }

        // Publish Outbox event for Customer Notification
        await tx.outboxEvent.create({
          data: {
            eventType: 'RENTAL_EXPIRED',
            payload: {
              rentalId: r.rental_id.toString(),
              rentalCode: r.rental_code,
              customerId: r.customer_id.toString(),
              effectiveExpiresAt: r.effective_expires_at,
            },
            status: 'PENDING',
          },
        });

        expiredRentalIds.push(r.rental_id.toString());
      }

      return {
        processedCount: expiredRentalIds.length,
        expiredRentalIds,
      };
    });
  }

  async processExpiredStoreSubscriptions(batchSize: number = 50) {
    const now = new Date();
    const limit = Math.max(1, Math.min(200, batchSize));

    return this.prisma.$transaction(async (tx) => {
      const expiredSubs = await tx.$queryRawUnsafe<Array<{
        subscription_id: bigint;
        store_id: bigint;
        end_date: Date;
        status: string;
      }>>(
        `SELECT subscription_id, store_id, end_date, status
         FROM store_subscriptions
         WHERE status = 'ACTIVE'
           AND end_date <= $1
         ORDER BY end_date ASC
         LIMIT $2
         FOR UPDATE SKIP LOCKED`,
        now,
        limit,
      );

      if (!expiredSubs || expiredSubs.length === 0) {
        return { processedCount: 0, expiredSubscriptionIds: [] };
      }

      const expiredSubscriptionIds: string[] = [];

      for (const sub of expiredSubs) {
        await tx.$executeRawUnsafe(
          `UPDATE store_subscriptions
           SET status = 'EXPIRED', updated_at = NOW()
           WHERE subscription_id = $1 AND status = 'ACTIVE'`,
          sub.subscription_id,
        );

        await tx.outboxEvent.create({
          data: {
            eventType: 'STORE_SUBSCRIPTION_EXPIRED',
            payload: {
              subscriptionId: sub.subscription_id.toString(),
              storeId: sub.store_id.toString(),
              endDate: sub.end_date,
            },
            status: 'PENDING',
          },
        });

        expiredSubscriptionIds.push(sub.subscription_id.toString());
      }

      return {
        processedCount: expiredSubscriptionIds.length,
        expiredSubscriptionIds,
      };
    });
  }
}
