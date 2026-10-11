import { Controller, Get, Post, Body, UseGuards, Request, ForbiddenException, BadRequestException, Query } from '@nestjs/common';
import { StoreSubscriptionsService } from './store-subscriptions.service';
import { SubscribePlanDto } from './dto/subscription.dto';
import { StoreQueryDto } from '../store-wallet/dto/wallet.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('STORE_OWNER', 'STORE_MANAGER')
@Controller('store/subscriptions')
export class StoreSubscriptionsController {
  constructor(private readonly subscriptionsService: StoreSubscriptionsService) {}

  private extractStoreId(req: any, query?: StoreQueryDto): bigint {
    const isSuperAdmin = ['SUPER_ADMIN', 'SYSTEM_ADMIN'].includes(req.user?.role);
    if (isSuperAdmin && query?.storeId) {
      return BigInt(query.storeId);
    }
    const storeId = req.user?.storeId || req.user?.ownedStores?.[0]?.storeId;
    if (!storeId) {
      throw new ForbiddenException('Không tìm thấy thông tin cửa hàng liên kết (storeId)');
    }
    return BigInt(storeId);
  }

  @Get('current')
  async getCurrent(@Request() req: any, @Query() query?: StoreQueryDto) {
    const storeId = this.extractStoreId(req, query);
    const data = await this.subscriptionsService.getCurrentSubscription(storeId);
    return { success: true, data };
  }

  @Post('subscribe')
  async subscribe(@Request() req: any, @Body() body: SubscribePlanDto, @Query() query?: StoreQueryDto) {
    const storeId = this.extractStoreId(req, query);
    let idempotencyKey = body.idempotencyKey || req.headers?.['idempotency-key'] || req.headers?.['x-idempotency-key'];
    if (idempotencyKey) {
      if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 1 || idempotencyKey.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(idempotencyKey)) {
        throw new BadRequestException('Idempotency key không hợp lệ (tối đa 128 ký tự, chỉ gồm A-Za-z0-9._:-) ');
      }
    }
    const data = await this.subscriptionsService.subscribeWithWallet(storeId, body.planId, idempotencyKey);
    return { success: true, message: 'Đăng ký gói thuê gian hàng thành công!', data };
  }
}
