import { Controller, Get, Post, Body, UseGuards, Request } from '@nestjs/common';
import { StoreSubscriptionsService } from './store-subscriptions.service';
import { SubscribePlanDto } from './dto/subscription.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { ForbiddenException } from '@nestjs/common';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('STORE_OWNER', 'STORE_MANAGER')
@Controller('store/subscriptions')
export class StoreSubscriptionsController {
  constructor(private readonly subscriptionsService: StoreSubscriptionsService) {}

  @Get('current')
  async getCurrent(@Request() req: any) {
    const storeId = req.user.storeId || req.user.ownedStores?.[0]?.storeId || (req.query?.storeId ? BigInt(req.query.storeId) : undefined);
    if (!storeId) {
      throw new ForbiddenException('Không tìm thấy thông tin cửa hàng liên kết (storeId)');
    }
    const data = await this.subscriptionsService.getCurrentSubscription(storeId);
    return { success: true, data };
  }

  @Post('subscribe')
  async subscribe(@Request() req: any, @Body() body: SubscribePlanDto) {
    const storeId = req.user.storeId || req.user.ownedStores?.[0]?.storeId || (req.query?.storeId ? BigInt(req.query.storeId) : undefined);
    if (!storeId) {
      throw new ForbiddenException('Không tìm thấy thông tin cửa hàng liên kết (storeId)');
    }
    const data = await this.subscriptionsService.subscribeWithWallet(storeId, body.planId);
    return { success: true, message: 'Đăng ký gói thuê gian hàng thành công!', data };
  }
}
