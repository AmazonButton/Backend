import { Controller, Get, UseGuards, Request, Inject, ForbiddenException, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { AnalyticsService } from './analytics.service';
import { DashboardAnalyticsQueryDto } from './dto/dashboard-analytics-query.dto';

@ApiTags('Analytics')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('STORE_OWNER', 'STORE_MANAGER', 'SUPER_ADMIN', 'SYSTEM_ADMIN', 'ADMIN')
@Controller('analytics')
export class AnalyticsController {
  constructor(@Inject(AnalyticsService) private readonly analyticsService: AnalyticsService) {}

  @ApiBearerAuth('JWT-auth')
  @Get('dashboard')
  @ApiOperation({ summary: 'Lấy dữ liệu thống kê bảng điều khiển với bộ lọc ngày và gom nhóm' })
  async getDashboardAnalytics(@Request() req: any, @Query() query: DashboardAnalyticsQueryDto) {
    const user = req.user;
    if (!['SUPER_ADMIN', 'SYSTEM_ADMIN', 'ADMIN'].includes(user.role) && !user.storeId) {
      throw new ForbiddenException('Tài khoản không có quyền truy cập dữ liệu thống kê của cửa hàng');
    }
    const data = await this.analyticsService.getDashboardAnalytics(user.storeId, user, query);
    return {
      success: true,
      message: 'Lấy dữ liệu thống kê thành công',
      data,
    };
  }
}