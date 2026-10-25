import { Controller, Get, Patch, Param, Body, UseGuards, Request } from '@nestjs/common';
import { DriversService } from './drivers.service';
import { UpdateDutyDto } from './dto/update-duty.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('drivers')
export class DriversController {
  constructor(private readonly driversService: DriversService) {}

  @Roles('STAFF_DELIVERY', 'STORE_OWNER', 'STORE_MANAGER', 'STAFF_ORDER', 'SUPER_ADMIN', 'SYSTEM_ADMIN')
  @Patch('me/duty')
  async updateDuty(@Request() req: any, @Body() body: UpdateDutyDto) {
    const data = await this.driversService.updateMyDuty(req.user, body);
    return { success: true, message: `Cập nhật trạng thái trực ${data.status} thành công`, data };
  }

  @Roles('STAFF_DELIVERY', 'STORE_OWNER', 'STORE_MANAGER', 'STAFF_ORDER', 'SUPER_ADMIN', 'SYSTEM_ADMIN')
  @Get('me/duty')
  async getMyDuty(@Request() req: any) {
    const data = await this.driversService.getMyDuty(req.user);
    return { success: true, data };
  }

  @Roles('STAFF_DELIVERY', 'STORE_OWNER', 'STORE_MANAGER', 'STAFF_ORDER', 'SUPER_ADMIN', 'SYSTEM_ADMIN')
  @Get('me/delivery-summary')
  async getMyDeliverySummary(@Request() req: any) {
    const data = await this.driversService.getMyDeliverySummary(req.user);
    return { success: true, message: 'Lấy thống kê giao hàng hôm nay thành công', data };
  }

  @Roles('STORE_OWNER', 'STORE_MANAGER', 'STAFF_ORDER', 'STAFF_DELIVERY', 'SUPER_ADMIN', 'SYSTEM_ADMIN')
  @Get('store/:storeId/online')
  async getOnlineDrivers(@Param('storeId') storeId: string, @Request() req: any) {
    const data = await this.driversService.getOnlineDrivers(storeId, req.user);
    return { success: true, data };
  }
}
