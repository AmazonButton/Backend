import { Controller, Get, Post, Param, Body, Query, UseGuards, Request } from '@nestjs/common';
import { DriverShiftsService } from './driver-shifts.service';
import { ConfirmHandoverDto } from './dto/confirm-handover.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('driver-shifts')
export class DriverShiftsController {
  constructor(private readonly shiftsService: DriverShiftsService) {}

  @Roles('STAFF_DELIVERY', 'STORE_OWNER', 'STORE_MANAGER', 'STAFF_ORDER', 'SUPER_ADMIN', 'SYSTEM_ADMIN')
  @Post('start')
  async startShift(@Request() req: any) {
    const data = await this.shiftsService.startShift(req.user);
    return { success: true, message: 'Bắt đầu ca làm việc thành công', data };
  }

  @Roles('STAFF_DELIVERY', 'STORE_OWNER', 'STORE_MANAGER', 'STAFF_ORDER', 'SUPER_ADMIN', 'SYSTEM_ADMIN')
  @Get('current')
  async getCurrentShift(@Request() req: any) {
    const data = await this.shiftsService.getCurrentShift(req.user);
    return { success: true, data };
  }

  @Roles('STAFF_DELIVERY', 'STORE_OWNER', 'STORE_MANAGER', 'STAFF_ORDER', 'SUPER_ADMIN', 'SYSTEM_ADMIN')
  @Get('history')
  async getShiftHistory(@Request() req: any, @Query('page') page?: number, @Query('limit') limit?: number) {
    const data = await this.shiftsService.getShiftHistory(req.user, page, limit);
    return { success: true, ...data };
  }

  @Roles('STAFF_DELIVERY', 'STORE_OWNER', 'STORE_MANAGER', 'STAFF_ORDER', 'SUPER_ADMIN', 'SYSTEM_ADMIN')
  @Post(':id/close')
  async closeShift(@Param('id') id: string, @Request() req: any) {
    const data = await this.shiftsService.closeShift(id, req.user);
    return { success: true, message: 'Đóng ca làm việc thành công', data };
  }

  @Roles('STORE_OWNER', 'STORE_MANAGER', 'STAFF_ORDER', 'SUPER_ADMIN', 'SYSTEM_ADMIN')
  @Post(':id/confirm-handover')
  async confirmHandover(@Param('id') id: string, @Body() body: ConfirmHandoverDto, @Request() req: any) {
    const data = await this.shiftsService.confirmHandover(id, req.user, body);
    return { success: true, message: 'Xác nhận bàn giao tiền ca thành công', data };
  }
}
