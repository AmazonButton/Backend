import { Controller, Get } from '@nestjs/common';
import { StoreSubscriptionsService } from './store-subscriptions.service';

@Controller('subscription-plans')
export class SubscriptionPlansController {
  constructor(private readonly subscriptionsService: StoreSubscriptionsService) {}

  @Get()
  async getActivePlansCatalog() {
    const data = await this.subscriptionsService.listPlans();
    return {
      success: true,
      message: 'Lấy danh sách các gói dịch vụ gian hàng thành công',
      data,
    };
  }
}
