import { Injectable, NotFoundException, BadRequestException, Inject } from '@nestjs/common';
import { StoreSubscriptionsRepository } from './store-subscriptions.repository';
import { StoreWalletService } from '../store-wallet/store-wallet.service';

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
    let currentSub = await this.getCurrentSubscription(rawStoreId);

    if (!currentSub) {
      const activePlan = await this.subscriptionsRepo.findFirstActivePlan();
      if (activePlan) {
        try {
          await this.subscriptionsRepo.createTrialSubscription(rawStoreId, activePlan.planId);
          currentSub = await this.getCurrentSubscription(rawStoreId);
        } catch (_) {
          // If already exists or transient error, continue
        }
      }

      if (!currentSub) {
        return true;
      }
    }

    const currentProductsCount = await this.subscriptionsRepo.countStoreProducts(rawStoreId);

    if (currentProductsCount >= currentSub.plan.maxProducts) {
      throw new BadRequestException(
        `Cửa hàng đã đạt giới hạn tối đa ${currentSub.plan.maxProducts} sản phẩm của gói ${currentSub.plan.planName}. Vui lòng nâng cấp gói để đăng thêm.`,
      );
    }

    return true;
  }
}
