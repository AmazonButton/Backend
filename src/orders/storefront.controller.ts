import {
  Body,
  Controller,
  Inject,
  Post,
  Request,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { OptionalJwtAuthGuard } from '../common/guards/optional-jwt-auth.guard';
import { CreateStorefrontOrderDto } from './dto/create-storefront-order.dto';
import { OrdersService } from './orders.service';
import { IdempotencyInterceptor } from '../common/idempotency/idempotency.interceptor';
import { Idempotent } from '../common/idempotency/idempotency.decorator';

@UseGuards(OptionalJwtAuthGuard)
@UseInterceptors(IdempotencyInterceptor)
@Controller('storefront/orders')
export class StorefrontController {
  constructor(
    @Inject(OrdersService) private readonly ordersService: OrdersService,
  ) {}

  @Post()
  @Idempotent({ required: true, ttlSeconds: 86400 })
  async checkout(@Request() req: any, @Body() body: CreateStorefrontOrderDto) {
    return this.ordersService.createStorefrontOrder(body, req.user?.userId);
  }
}
