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

  @Get(':id')
  async getById(@Param('id') id: string) {
    const data = await this.ordersService.getById(id);
    if (!data) throw new NotFoundException('Đơn hàng không tồn tại');
    return { success: true, data };
  }

  @Roles('CUSTOMER')
  @Post('quick-reorder')
  async quickReorder(@Request() req: any, @Body('deviceId') deviceId: string) {
    // Look up device
    const device = await this.ordersService['prisma'].device.findUnique({
      where: { deviceId },
      include: { configuration: true },
    });

    if (!device || device.customerId !== req.user.customerProfileId) {
      throw new NotFoundException('Thiết bị không tồn tại hoặc không thuộc sở hữu của bạn');
    }

    const data = await this.ordersService.handleButtonEvent(device, {
      eventType: 'APP_QUICK_REORDER',
      requestId: `app_req_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      battery: device.batteryLevel,
      rssi: device.wifiRSSI,
    });

    return { success: true, message: 'Đặt hàng thành công!', data };
  }

  @Post('simulate-button-press')
  async simulateButtonPress(@Request() req: any, @Body() body: any) {
    return this.ordersService.simulateButtonPress(body, req.user);
  }

  @Roles('STORE_OWNER', 'STORE_MANAGER', 'STORE_STAFF', 'SUPER_ADMIN')
  @Patch(':id/status')
  async updateStatus(@Param('id') id: string, @Body('status') status: string) {
    const data = await this.ordersService.updateOrderStatus(id, status);
    return { success: true, message: `Đã cập nhật trạng thái đơn: ${status}`, data };
  }

  @HttpCode(200)
  @Post(':id/cancel')
  async cancel(@Param('id') id: string, @Body('reason') reason?: string) {
    const data = await this.ordersService.cancelOrder(id, reason || 'Khách hàng hủy đơn');
    return { success: true, message: 'Đã hủy đơn hàng thành công', data };
  }
}
