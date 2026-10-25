import { Controller, Get, Param, Query, UseGuards, Request } from '@nestjs/common';
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
  @Roles('STORE_OWNER', 'STORE_MANAGER', 'STAFF_ORDER', 'SUPER_ADMIN', 'SYSTEM_ADMIN')
  @Get(':storeId/driver-shifts')
  @ApiOperation({ summary: 'Xem danh sách ca làm việc của tài xế theo cửa hàng' })
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
}
