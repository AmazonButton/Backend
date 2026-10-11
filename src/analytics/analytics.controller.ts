import { Controller, Get, UseGuards, Request, Inject, ForbiddenException } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { AnalyticsService } from './analytics.service';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('STORE_OWNER', 'STORE_MANAGER', 'SUPER_ADMIN', 'SYSTEM_ADMIN', 'ADMIN')
@Controller('analytics')
export class AnalyticsController {
  constructor(@Inject(AnalyticsService) private readonly analyticsService: AnalyticsService) {}

  @Get('dashboard')
  async getDashboardAnalytics(@Request() req: any) {
    const user = req.user;
    if (!['SUPER_ADMIN', 'SYSTEM_ADMIN', 'ADMIN'].includes(user.role) && !user.storeId) {
      throw new ForbiddenException('Tài khoản không có quyền truy cập dữ liệu thống kê của cửa hàng');
    }
    const data = await this.analyticsService.getDashboardAnalytics(user.storeId, user);
    return {
      success: true,
      data,
    };
  }
}