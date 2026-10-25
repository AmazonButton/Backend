import {
  Body,
  Controller,
  Inject,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { OptionalJwtAuthGuard } from '../common/guards/optional-jwt-auth.guard';
import { CreateStorefrontOrderDto } from './dto/create-storefront-order.dto';
import { OrdersService } from './orders.service';

@UseGuards(OptionalJwtAuthGuard)
@Controller('storefront/orders')
export class StorefrontController {
  constructor(
    @Inject(OrdersService) private readonly ordersService: OrdersService,
  ) {}

  @Post()
  async checkout(@Request() req: any, @Body() body: CreateStorefrontOrderDto) {
    return this.ordersService.createStorefrontOrder(body, req.user?.userId);
  }
}
