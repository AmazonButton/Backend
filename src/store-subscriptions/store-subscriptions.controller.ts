import { Controller, Get, Post, Body, UseGuards, Request, ForbiddenException, BadRequestException, Query, Param, Inject, Optional, forwardRef } from '@nestjs/common';
import { StoreSubscriptionsService } from './store-subscriptions.service';
import { SubscribePlanDto } from './dto/subscription.dto';
import { StoreSubscriptionQueryDto } from './dto/store-subscription-query.dto';
import { StoreQueryDto } from '../store-wallet/dto/wallet.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { buildPaginatedResponse } from '../common/utils/pagination.helper';
import { BillingChargesService } from '../billing-charges/billing-charges.service';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('STORE_OWNER', 'STORE_MANAGER')
@Controller('store/subscriptions')
export class StoreSubscriptionsController {
  constructor(
    private readonly subscriptionsService: StoreSubscriptionsService,
    @Optional() @Inject(forwardRef(() => BillingChargesService)) private readonly billingChargesService?: any,
  ) {}

  private extractStoreId(req: any, query?: { storeId?: string }): bigint {
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

  @Get()
  async getSubscriptionHistory(
    @Request() req: any,
    @Query() query?: StoreSubscriptionQueryDto,
  ) {
    const storeId = this.extractStoreId(req, query);
    const result = await this.subscriptionsService.listStoreSubscriptions(storeId, {
      page: query?.page ? Number(query.page) : 1,
      pageSize: query?.pageSize ? Number(query.pageSize) : 20,
      status: query?.status,
    });

    return buildPaginatedResponse(
      result.items,
      result.total,
      result.page,
      result.pageSize,
      'Lấy lịch sử gói đăng ký gian hàng thành công',
    );
  }

  @Get('current')
  async getCurrent(@Request() req: any, @Query() query?: StoreQueryDto) {
    const storeId = this.extractStoreId(req, query);
    const data = await this.subscriptionsService.getCurrentSubscription(storeId);
    return { success: true, data };
  }

  @Get(':id')
  async getSubscriptionDetail(
    @Param('id') id: string,
    @Request() req: any,
    @Query() query?: StoreQueryDto,
  ) {
    const storeId = this.extractStoreId(req, query);
    const data = await this.subscriptionsService.getStoreSubscriptionById(BigInt(id), storeId);
    return {
      success: true,
      message: 'Lấy chi tiết gói đăng ký thành công',
      data,
    };
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

  @Post('renew-charge')
  async createRenewCharge(
    @Request() req: any,
    @Body() body: { returnUrl?: string; cancelUrl?: string },
    @Query() query?: StoreQueryDto,
  ) {
    const storeId = this.extractStoreId(req, query);
    if (!this.billingChargesService) {
      throw new BadRequestException('Dịch vụ thu tiền BillingChargesService chưa sẵn sàng');
    }

    const charge = await this.billingChargesService.createStoreSubscriptionCharge({
      storeId,
      amount: 60000,
      durationDays: 30,
    });

    const paymentLink = await this.billingChargesService.createPayosPaymentRequestForCharge(
      charge.chargeId,
      req.user,
      body?.returnUrl,
      body?.cancelUrl,
    );

    return {
      success: true,
      message: 'Tạo liên kết thanh toán phí duy trì gian hàng 60.000đ/tháng thành công',
      data: paymentLink,
    };
  }
}

