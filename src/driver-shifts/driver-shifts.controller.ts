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
  async getShiftHistory(
    @Request() req: any,
    @Query('page') page?: number,
    @Query('pageSize') pageSize?: number,
    @Query('limit') limit?: number,
  ) {
    const safePage = page ? Number(page) : 1;
    const safePageSize = Math.max(1, Math.min(100, pageSize ? Number(pageSize) : limit ? Number(limit) : 20));
    const data = await this.shiftsService.getShiftHistory(req.user, safePage, safePageSize);
    const totalItems = data.pagination?.total || 0;
    const totalPages = Math.ceil(totalItems / safePageSize);

    return {
      success: true,
      message: 'Lấy lịch sử ca làm việc thành công',
      data: data.shifts,
      pagination: {
        page: safePage,
        pageSize: safePageSize,
        totalItems,
        totalPages,
        hasNextPage: safePage < totalPages,
        hasPrevPage: safePage > 1,
      },
    };
  }

  @Roles('STAFF_DELIVERY', 'STORE_OWNER', 'STORE_MANAGER', 'STAFF_ORDER', 'SUPER_ADMIN', 'SYSTEM_ADMIN')
  @Get(':id')
  async getShiftById(@Param('id') id: string, @Request() req: any) {
    const data = await this.shiftsService.getShiftById(id, req.user);
    return { success: true, message: 'Lấy chi tiết ca làm việc thành công', data };
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
