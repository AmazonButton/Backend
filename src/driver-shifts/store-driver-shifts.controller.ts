import { Controller, Get, Post, Param, Query, Body, UseGuards, Request, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { DriverShiftsService } from './driver-shifts.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { buildPaginatedResponse } from '../common/utils/pagination.helper';

@ApiTags('Driver Shifts Monitoring')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('stores')
export class StoreDriverShiftsController {
  constructor(private readonly shiftsService: DriverShiftsService) {}

  @ApiBearerAuth('JWT-auth')
  @Roles('STORE_OWNER', 'SUPER_ADMIN', 'SYSTEM_ADMIN')
  @Get(':storeId/driver-shifts')
  @ApiOperation({ summary: 'Xem danh sách ca làm việc giao hàng theo cửa hàng' })
  async getStoreShifts(
    @Param('storeId') storeId: string,
    @Query() query: any,
    @Request() req: any,
  ) {
    const result = await this.shiftsService.getStoreShifts(storeId, req.user, query);
    return buildPaginatedResponse(
      result.items,
      result.total,
      result.page,
      result.pageSize,
      'Lấy danh sách ca làm việc của cửa hàng thành công',
    );
  }

  @ApiBearerAuth('JWT-auth')
  @Roles('STORE_OWNER', 'SUPER_ADMIN', 'SYSTEM_ADMIN')
  @Get(':storeId/legacy-handover-status')
  @ApiOperation({ summary: 'Kiểm tra đơn shipper đang nhận, ca đang mở và tiền COD còn phải bàn giao của cửa hàng' })
  async getLegacyHandoverStatus(@Param('storeId') storeId: string, @Request() req: any) {
    const data = await this.shiftsService.getLegacyHandoverSummary(storeId, req.user);
    return {
      success: true,
      message: 'Lấy thông tin bàn giao shipper cũ thành công',
      data,
    };
  }

  @ApiBearerAuth('JWT-auth')
  @Roles('STORE_OWNER', 'SUPER_ADMIN', 'SYSTEM_ADMIN')
  @HttpCode(HttpStatus.OK)
  @Post(':storeId/legacy-handover/settle')
  @ApiOperation({ summary: 'Chủ cửa hàng thu hồi đơn đang giao, chốt ca đang mở và tất toán bàn giao COD từ shipper cũ' })
  async settleLegacyHandover(
    @Param('storeId') storeId: string,
    @Body('note') note: string | undefined,
    @Request() req: any,
  ) {
    const data = await this.shiftsService.reconcileStoreLegacyShippers(storeId, req.user, note);
    return {
      success: true,
      message: 'Đã thu hồi đơn đang giao, đóng ca mở và tất toán COD bàn giao thành công',
      data,
    };
  }
}
