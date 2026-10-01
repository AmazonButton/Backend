import { Injectable, NotFoundException, BadRequestException, Inject } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { StoreWalletService } from '../store-wallet/store-wallet.service';

@Injectable()
export class StoreSubscriptionsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(StoreWalletService) private readonly walletService: StoreWalletService
  ) {}

  async getCurrentSubscription(storeId: string | number | bigint) {
    const rawStoreId = BigInt(storeId);
    const sub = await this.prisma.storeSubscription.findFirst({
      where: {
        storeId: rawStoreId,
        status: 'ACTIVE',
        endDate: { gte: new Date() },
      },
      include: { plan: true },
      orderBy: { endDate: 'desc' },
    });

    if (!sub) return null;

    const now = Date.now();
    const end = new Date(sub.endDate).getTime();
    const daysRemaining = Math.max(0, Math.ceil((end - now) / (1000 * 60 * 60 * 24)));

    return {
      ...sub,
      daysRemaining,
    };
  }

  async subscribeWithWallet(storeId: string | number | bigint, planId: string | number | bigint) {
    const rawStoreId = BigInt(storeId);
    const rawPlanId = BigInt(planId);

    const plan = await this.prisma.subscriptionPlan.findUnique({
      where: { planId: rawPlanId },
    });
    if (!plan || !plan.isActive) {
      throw new NotFoundException('Gói cước không tồn tại hoặc đã tạm dừng cung cấp');
    }

    const price = Number(plan.price);
    const wallet = await this.walletService.getOrCreateStoreWallet(rawStoreId);

    return this.prisma.$transaction(async (tx) => {
      const currentWallet = await tx.storeWallet.findUnique({
        where: { walletId: wallet.walletId },
      });
      if (!currentWallet) throw new NotFoundException('Ví cửa hàng không tồn tại');

      const currentBalance = Number(currentWallet.balance);
      if (currentBalance < price) {
        throw new BadRequestException(
          `Số dư ví không đủ để thanh toán gói cước (${price.toLocaleString()} VND). Số dư khả dụng hiện tại: ${currentBalance.toLocaleString()} VND`
        );
      }

      const balanceAfter = currentBalance - price;
      await tx.storeWallet.update({
        where: { walletId: wallet.walletId },
        data: { balance: balanceAfter },
      });

      const now = new Date();
      const startDate = now;
      const durationMs = plan.durationDays * 24 * 60 * 60 * 1000;
      const endDate = new Date(now.getTime() + durationMs);

      const subscription = await tx.storeSubscription.create({
        data: {
          storeId: rawStoreId,
          planId: rawPlanId,
          startDate,
          endDate,
          status: 'ACTIVE',
          paymentMethod: 'WALLET',
        },
        include: { plan: true },
      });

      await tx.walletTransaction.create({
        data: {
          walletId: wallet.walletId,
          amount: -price,
          type: 'SUBSCRIPTION_PAYMENT',
          balanceBefore: currentBalance,
          balanceAfter,
          referenceId: `SUB-${subscription.subscriptionId}`,
          description: `Thanh toán phí thuê gian hàng gói ${plan.planName} (${plan.durationDays} ngày)`,
        },
      });

      return subscription;
    });
  }

  async validateStoreCanListProducts(storeId: string | number | bigint): Promise<boolean> {
    const rawStoreId = BigInt(storeId);
    const currentSub = await this.getCurrentSubscription(rawStoreId);

    if (!currentSub) {
      const totalPlans = await this.prisma.subscriptionPlan.count();
      if (totalPlans === 0) return true;

      throw new BadRequestException(
        'Cửa hàng chưa đăng ký hoặc đã hết hạn gói thuê gian hàng. Vui lòng gia hạn gói để tiếp tục đăng bán sản phẩm.'
      );
    }

    const currentProductsCount = await this.prisma.product.count({
      where: { storeId: rawStoreId, status: { not: 'DELETED' } },
    });

    if (currentProductsCount >= currentSub.plan.maxProducts) {
      throw new BadRequestException(
        `Cửa hàng đã đạt giới hạn tối đa ${currentSub.plan.maxProducts} sản phẩm của gói ${currentSub.plan.planName}. Vui lòng nâng cấp gói để đăng thêm.`
      );
    }

    return true;
  }
}
