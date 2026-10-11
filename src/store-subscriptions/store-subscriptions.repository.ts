import { Injectable, Inject, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@prisma/client';

@Injectable()
export class StoreSubscriptionsRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async findPlanById(planId: bigint) {
    return this.prisma.subscriptionPlan.findUnique({
      where: { planId },
    });
  }

  async countTotalPlans(): Promise<number> {
    return this.prisma.subscriptionPlan.count();
  }

  async countStoreProducts(storeId: bigint): Promise<number> {
    return this.prisma.product.count({
      where: { storeId, status: { not: 'DELETED' } },
    });
  }

  async getCurrentSubscription(storeId: bigint) {
    return this.prisma.storeSubscription.findFirst({
      where: {
        storeId,
        status: 'ACTIVE',
        endDate: { gte: new Date() },
      },
      include: { plan: true },
      orderBy: { endDate: 'desc' },
    });
  }

  async subscribeWithWalletAtomicTx(params: {
    storeId: bigint;
    planId: bigint;
    walletId: bigint;
    idempotencyKey?: string;
  }): Promise<any> {
    return this.prisma.$transaction(async (tx) => {
      // 0. Idempotency check if idempotencyKey provided
      if (params.idempotencyKey) {
        const idempRef = `SUB-IDEMP-${params.idempotencyKey.trim()}`;
        const existingTx = await tx.walletTransaction.findFirst({
          where: {
            walletId: params.walletId,
            type: 'SUBSCRIPTION_PAYMENT',
            referenceId: idempRef,
          },
        });
        if (existingTx) {
          // Idempotent: return the latest active subscription
          const latestSub = await tx.storeSubscription.findFirst({
            where: { storeId: params.storeId, planId: params.planId },
            include: { plan: true },
            orderBy: { createdAt: 'desc' },
          });
          if (latestSub) return latestSub;
        }
      }

      // 1. Lock store_wallets row (FOR UPDATE)
      const walletRows = await tx.$queryRawUnsafe<any[]>(
        `SELECT wallet_id, balance, store_id FROM store_wallets WHERE wallet_id = $1 FOR UPDATE;`,
        params.walletId,
      );
      if (!walletRows || walletRows.length === 0) {
        throw new NotFoundException('Ví cửa hàng không tồn tại');
      }
      const walletRow = walletRows[0];

      // 2. Lock active subscription for store (FOR UPDATE)
      const activeSubRows = await tx.$queryRawUnsafe<any[]>(
        `SELECT subscription_id, start_date, end_date FROM store_subscriptions
         WHERE store_id = $1 AND status = 'ACTIVE' AND end_date > CURRENT_TIMESTAMP
         ORDER BY end_date DESC LIMIT 1 FOR UPDATE;`,
        params.storeId,
      );
      const activeSub = activeSubRows && activeSubRows.length > 0 ? activeSubRows[0] : null;

      // 3. Fetch plan
      const plan = await tx.subscriptionPlan.findUnique({
        where: { planId: params.planId },
      });
      if (!plan || !plan.isActive) {
        throw new NotFoundException('Gói cước không tồn tại hoặc đã tạm dừng cung cấp');
      }

      // 4. Financial math strictly using Prisma.Decimal
      const price = new Prisma.Decimal(plan.price);
      const currentBalance = new Prisma.Decimal(walletRow.balance);

      if (currentBalance.lessThan(price)) {
        throw new BadRequestException(
          `Số dư ví không đủ để thanh toán gói cước (${price.toString()} VND). Số dư khả dụng hiện tại: ${currentBalance.toString()} VND`,
        );
      }

      const balanceAfter = currentBalance.minus(price);

      // Update wallet balance
      await tx.$executeRawUnsafe(
        `UPDATE store_wallets SET balance = $1, updated_at = CURRENT_TIMESTAMP WHERE wallet_id = $2;`,
        balanceAfter,
        params.walletId,
      );

      // 5. Calculate start & end date without race condition
      const now = new Date();
      const startDate = activeSub && new Date(activeSub.end_date) > now ? new Date(activeSub.end_date) : now;
      const durationMs = plan.durationDays * 24 * 60 * 60 * 1000;
      const endDate = new Date(startDate.getTime() + durationMs);

      // 6. Create store_subscription
      const subscription = await tx.storeSubscription.create({
        data: {
          storeId: params.storeId,
          planId: params.planId,
          startDate,
          endDate,
          status: 'ACTIVE',
          paymentMethod: 'WALLET',
        },
        include: { plan: true },
      });

      // 7. Create wallet_transaction
      const referenceId = params.idempotencyKey
        ? `SUB-IDEMP-${params.idempotencyKey.trim()}`
        : `SUB-${subscription.subscriptionId}`;

      await tx.walletTransaction.create({
        data: {
          walletId: params.walletId,
          amount: price.negated(),
          type: 'SUBSCRIPTION_PAYMENT',
          balanceBefore: currentBalance,
          balanceAfter,
          referenceId,
          description: `Thanh toán phí thuê gian hàng gói ${plan.planName} (${plan.durationDays} ngày)`,
        },
      });

      return subscription;
    });
  }
}
