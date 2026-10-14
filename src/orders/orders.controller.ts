import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  Query,
  UseGuards,
  Request,
  NotFoundException,
  Inject,
  HttpCode,
} from '@nestjs/common';
import { OrdersService } from './orders.service';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto';
import { DeliverOrderDto } from './dto/deliver-order.dto';
import { DeliveryFailureDto } from './dto/delivery-failure.dto';
import { DriverOrdersQueryDto } from './dto/driver-orders-query.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('orders')
export class OrdersController {
  constructor(@Inject(OrdersService) private readonly ordersService: OrdersService) {}

  @Get()
  async list(@Request() req: any, @Query('status') status?: string) {
    const data = await this.ordersService.list(req.user, status);
    return { success: true, data };
  }

  @Roles('STAFF_DELIVERY', 'STORE_OWNER', 'STORE_MANAGER', 'STAFF_ORDER', 'SYSTEM_ADMIN', 'SUPER_ADMIN')
  @Get('driver/my-orders')
  async getDriverOrders(@Request() req: any, @Query() query: DriverOrdersQueryDto) {
    const data = await this.ordersService.getDriverOrders(req.user, query);
    return { success: true, ...data };
  }

  @Get(':id')
  async getById(@Param('id') id: string, @Request() req: any) {
    const data = await this.ordersService.getById(id, req.user);
    if (!data) throw new NotFoundException('Đơn hàng không tồn tại');
    return { success: true, data };
  }

  @Roles('CUSTOMER')
  @Post('quick-reorder')
  async quickReorder(@Request() req: any, @Body('deviceId') deviceId: string) {
    const data = await this.ordersService.quickReorder(req.user, deviceId);
    return { success: true, message: 'Đặt hàng thành công!', data };
  }

  @Post('simulate-button-press')
  async simulateButtonPress(@Request() req: any, @Body() body: any) {
    return this.ordersService.simulateButtonPress(body, req.user);
  }

  @Roles('STAFF_DELIVERY', 'STORE_OWNER', 'STORE_MANAGER', 'STAFF_ORDER', 'SYSTEM_ADMIN', 'SUPER_ADMIN')
  @Post(':id/claim')
  async claimOrder(@Param('id') id: string, @Request() req: any) {
    const data = await this.ordersService.claimOrder(id, req.user);
    return { success: true, message: 'Nhận đơn hàng thành công!', data };
  }

  @Roles('STAFF_DELIVERY', 'STORE_OWNER', 'STORE_MANAGER', 'STAFF_ORDER', 'SYSTEM_ADMIN', 'SUPER_ADMIN')
  @Post(':id/deliver')
  async deliverOrder(@Param('id') id: string, @Body() body: DeliverOrderDto, @Request() req: any) {
    const data = await this.ordersService.completeDelivery(id, body, req.user);
    return { success: true, message: 'Hoàn tất giao hàng thành công!', data };
  }

  @Roles('STAFF_DELIVERY', 'STORE_OWNER', 'STORE_MANAGER', 'STAFF_ORDER', 'SYSTEM_ADMIN', 'SUPER_ADMIN')
  @Post(':id/fail')
  async failDelivery(@Param('id') id: string, @Body() body: DeliveryFailureDto, @Request() req: any) {
    const data = await this.ordersService.failDelivery(id, body, req.user);
    return { success: true, message: 'Đã ghi nhận giao hàng thất bại', data };
  }

  @Roles('STORE_OWNER', 'STORE_MANAGER', 'STAFF_ORDER', 'STAFF_DELIVERY', 'SYSTEM_ADMIN', 'SUPER_ADMIN')
  @Patch(':id/status')
  async updateStatus(@Param('id') id: string, @Body() body: UpdateOrderStatusDto, @Request() req: any) {
    const data = await this.ordersService.updateOrderStatus(id, body.status, req.user);
    return { success: true, message: `Đã cập nhật trạng thái đơn: ${body.status}`, data };
  }

  @HttpCode(200)
  @Post(':id/cancel')
  async cancel(@Param('id') id: string, @Request() req: any, @Body('reason') reason?: string) {
    const data = await this.ordersService.cancelOrder(id, reason || 'Khách hàng hủy đơn', req.user);
    return { success: true, message: 'Đã hủy đơn hàng thành công', data };
  }
}
