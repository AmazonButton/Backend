import { Injectable, NotFoundException, BadRequestException, Inject } from '@nestjs/common';
import { StoreSubscriptionsRepository } from './store-subscriptions.repository';
import { StoreWalletService } from '../store-wallet/store-wallet.service';
import { SubscriptionPlanResponseDto } from './dto/subscription-plan-response.dto';
import { StoreSubscriptionResponseDto } from './dto/store-subscription-response.dto';

@Injectable()
export class StoreSubscriptionsService {
  constructor(
    @Inject(StoreSubscriptionsRepository) private readonly subscriptionsRepo: StoreSubscriptionsRepository,
    @Inject(StoreWalletService) private readonly walletService: StoreWalletService,
  ) {}

  async getCurrentSubscription(storeId: string | number | bigint) {
    const rawStoreId = BigInt(storeId);
    const sub = await this.subscriptionsRepo.getCurrentSubscription(rawStoreId);

    if (!sub) return null;

    const now = Date.now();
    const end = new Date(sub.endDate).getTime();
    const daysRemaining = Math.max(0, Math.ceil((end - now) / (1000 * 60 * 60 * 24)));

    return {
      ...sub,
      daysRemaining,
    };
  }

  async subscribeWithWallet(
    storeId: string | number | bigint,
    planId: string | number | bigint,
    idempotencyKey?: string,
  ) {
    const rawStoreId = BigInt(storeId);
    const rawPlanId = BigInt(planId);

    const plan = await this.subscriptionsRepo.findPlanById(rawPlanId);
    if (!plan || !plan.isActive) {
      throw new NotFoundException('Gói cước không tồn tại hoặc đã tạm dừng cung cấp');
    }

    const wallet = await this.walletService.getOrCreateStoreWallet(rawStoreId);

    return this.subscriptionsRepo.subscribeWithWalletAtomicTx({
      storeId: rawStoreId,
      planId: rawPlanId,
      walletId: wallet.walletId,
      idempotencyKey,
    });
  }

  async validateStoreCanListProducts(storeId: string | number | bigint): Promise<boolean> {
    const rawStoreId = BigInt(storeId);
    const currentSub = await this.getCurrentSubscription(rawStoreId);

    if (!currentSub) {
      const totalPlans = await this.subscriptionsRepo.countTotalPlans();
      if (totalPlans === 0) return true;

      throw new BadRequestException(
        'Cửa hàng chưa đăng ký hoặc đã hết hạn gói thuê gian hàng. Vui lòng gia hạn gói để tiếp tục đăng bán sản phẩm.',
      );
    }

    const currentProductsCount = await this.subscriptionsRepo.countStoreProducts(rawStoreId);

    if (currentProductsCount >= currentSub.plan.maxProducts) {
      throw new BadRequestException(
        `Cửa hàng đã đạt giới hạn tối đa ${currentSub.plan.maxProducts} sản phẩm của gói ${currentSub.plan.planName}. Vui lòng nâng cấp gói để đăng thêm.`,
      );
    }

    return true;
  }

  async listPlans(): Promise<SubscriptionPlanResponseDto[]> {
    const plans = await this.subscriptionsRepo.listActivePlans();
    return plans.map(SubscriptionPlanResponseDto.fromEntity);
  }

  async listStoreSubscriptions(
    storeId: bigint,
    query: { page?: number; pageSize?: number; status?: string },
  ) {
    const page = Math.max(1, Number(query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 20));
    const skip = (page - 1) * pageSize;

    const { total, items } = await this.subscriptionsRepo.findStoreSubscriptions(storeId, {
      skip,
      take: pageSize,
      status: query.status,
    });

    return {
      items: items.map(StoreSubscriptionResponseDto.fromEntity),
      total,
      page,
      pageSize,
    };
  }

  async getStoreSubscriptionById(
    subscriptionId: bigint,
    storeId: bigint,
  ): Promise<StoreSubscriptionResponseDto> {
    const sub = await this.subscriptionsRepo.findStoreSubscriptionById(subscriptionId, storeId);
    if (!sub) {
      throw new NotFoundException('Gói đăng ký không tồn tại hoặc không thuộc cửa hàng này');
    }
    return StoreSubscriptionResponseDto.fromEntity(sub);
  }
}
