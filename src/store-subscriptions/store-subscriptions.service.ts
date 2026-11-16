import { Injectable, NotFoundException, BadRequestException, ForbiddenException, Inject } from '@nestjs/common';
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
    const start = new Date(sub.startDate).getTime();
    const end = new Date(sub.endDate).getTime();
    const isUpcoming = start > now;
    const isExpired = end < now;
    const daysRemaining = isUpcoming ? 0 : Math.max(0, Math.ceil((end - now) / (1000 * 60 * 60 * 24)));

    let upcomingSubscription = null;
    if (
      !isUpcoming &&
      !isExpired &&
      typeof this.subscriptionsRepo?.getUpcomingSubscription === 'function'
    ) {
      upcomingSubscription = await this.subscriptionsRepo.getUpcomingSubscription(rawStoreId);
    }

    return {
      ...sub,
      daysRemaining,
      isUpcoming,
      isExpired,
      upcomingSubscription,
    };
  }

  async hasUsedTrialSubscription(storeId: string | number | bigint): Promise<boolean> {
    return this.subscriptionsRepo.hasUsedTrialSubscription(BigInt(storeId));
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

    const isTrial = Number(plan.price) === 0 || plan.planCode.toUpperCase().includes('TRIAL');
    if (isTrial) {
      const hasUsed = await this.subscriptionsRepo.hasUsedTrialSubscription(rawStoreId);
      if (hasUsed) {
        throw new BadRequestException('Cửa hàng đã từng sử dụng gói dùng thử 7 ngày. Mỗi tài khoản chỉ được dùng thử 1 lần duy nhất.');
      }
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

    if (
      !currentSub ||
      currentSub.isExpired ||
      currentSub.isUpcoming ||
      currentSub.status !== 'ACTIVE' ||
      new Date(currentSub.startDate) > new Date() ||
      new Date(currentSub.endDate) < new Date()
    ) {
      throw new ForbiddenException(
        'Gian hàng đã hết hạn hoặc chưa đăng ký gói dịch vụ. Vui lòng đăng ký hoặc gia hạn gói dịch vụ để tiếp tục đăng bán sản phẩm.',
      );
    }

    // Nghiệp vụ mới: Không giới hạn số lượng sản phẩm cho từng gói, chỉ cần gói dịch vụ còn hạn hợp lệ là được đăng bán.
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

  async getPlanForCheckout(planId: bigint, options?: { allowFreeTrial?: boolean }) {
    const plan = await this.subscriptionsRepo.findPlanById(planId);
    if (!plan) {
      throw new NotFoundException('Không tìm thấy gói dịch vụ gian hàng');
    }
    if (!plan.isActive) {
      throw new BadRequestException('Gói dịch vụ đã tạm dừng, không thể tạo thanh toán mới');
    }
    const price = Number(plan.price);
    if (price === 0) {
      if (options?.allowFreeTrial) {
        return plan;
      }
      throw new BadRequestException('Gói dịch vụ miễn phí (0đ). Vui lòng sử dụng tính năng đăng ký trực tiếp thay vì thanh toán qua PayOS');
    }
    if (price < 2000) {
      throw new BadRequestException('Số tiền thanh toán qua PayOS tối thiểu là 2.000đ');
    }
    return plan;
  }
}
