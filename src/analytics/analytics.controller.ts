import { Controller, Get, UseGuards, Request, Inject } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AnalyticsService } from './analytics.service';

@UseGuards(JwtAuthGuard)
@Controller('analytics')
export class AnalyticsController {
  constructor(@Inject(AnalyticsService) private readonly analyticsService: AnalyticsService) {}

  @Get('dashboard')
  async getDashboardAnalytics(@Request() req: any) {
    const data = await this.analyticsService.getDashboardAnalytics(req.user?.storeId);
    return {
      success: true,
      data,
    };
  }
}
