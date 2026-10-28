import { Controller, Get, UseGuards, Request, Inject, ForbiddenException, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { AnalyticsService } from './analytics.service';
import { DashboardAnalyticsQueryDto } from './dto/dashboard-analytics-query.dto';
import {
  OrderAnalyticsQueryDto,
  ProductAnalyticsQueryDto,
  InventoryAnalyticsQueryDto,
  CustomerAnalyticsQueryDto,
  FinanceAnalyticsQueryDto,
  OperationsAnalyticsQueryDto,
  StaffAnalyticsQueryDto,
} from './dto/analytics-drilldown-query.dto';

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

  @ApiBearerAuth('JWT-auth')
  @Get('orders')
  @ApiOperation({ summary: 'Phân tích chi tiết đơn hàng (funnel, AOV, cancellation rate, payment method)' })
  async getOrderAnalytics(@Request() req: any, @Query() query: OrderAnalyticsQueryDto) {
    const data = await this.analyticsService.getOrderAnalytics(req.user, query);
    return {
      success: true,
      message: 'Lấy dữ liệu phân tích đơn hàng thành công',
      data,
    };
  }

  @ApiBearerAuth('JWT-auth')
  @Get('products')
  @ApiOperation({ summary: 'Phân tích sản phẩm bán chạy, sản phẩm chậm và doanh thu theo danh mục' })
  async getProductAnalytics(@Request() req: any, @Query() query: ProductAnalyticsQueryDto) {
    const data = await this.analyticsService.getProductAnalytics(req.user, query);
    return {
      success: true,
      message: 'Lấy dữ liệu phân tích sản phẩm thành công',
      data,
    };
  }

  @ApiBearerAuth('JWT-auth')
  @Get('inventory')
  @ApiOperation({ summary: 'Phân tích tồn kho SKU, cảnh báo hết hàng và giá trị tài sản ước tính' })
  async getInventoryAnalytics(@Request() req: any, @Query() query: InventoryAnalyticsQueryDto) {
    const data = await this.analyticsService.getInventoryAnalytics(req.user, query);
    return {
      success: true,
      message: 'Lấy dữ liệu phân tích tồn kho thành công',
      data,
    };
  }

  @ApiBearerAuth('JWT-auth')
  @Get('customers')
  @ApiOperation({ summary: 'Phân tích khách hàng cửa hàng (khách mới, khách quay lại, top chi tiêu)' })
  async getCustomerAnalytics(@Request() req: any, @Query() query: CustomerAnalyticsQueryDto) {
    const data = await this.analyticsService.getCustomerAnalytics(req.user, query);
    return {
      success: true,
      message: 'Lấy dữ liệu phân tích khách hàng thành công',
      data,
    };
  }

  @ApiBearerAuth('JWT-auth')
  @Get('finance')
  @ApiOperation({ summary: 'Phân tích tài chính, số dư ví và yêu cầu rút tiền của cửa hàng' })
  async getFinanceAnalytics(@Request() req: any, @Query() query: FinanceAnalyticsQueryDto) {
    const data = await this.analyticsService.getFinanceAnalytics(req.user, query);
    return {
      success: true,
      message: 'Lấy dữ liệu phân tích tài chính thành công',
      data,
    };
  }

  @ApiBearerAuth('JWT-auth')
  @Get('operations')
  @ApiOperation({ summary: 'Phân tích vận hành cửa hàng, điểm nghẽn xử lý đơn và hiệu suất ca trực' })
  async getOperationsAnalytics(@Request() req: any, @Query() query: OperationsAnalyticsQueryDto) {
    const data = await this.analyticsService.getOperationsAnalytics(req.user, query);
    return {
      success: true,
      message: 'Lấy dữ liệu phân tích vận hành thành công',
      data,
    };
  }

  @ApiBearerAuth('JWT-auth')
  @Get('staff')
  @ApiOperation({ summary: 'Phân tích hiệu suất cập nhật đơn của nhân viên và tài xế' })
  async getStaffAnalytics(@Request() req: any, @Query() query: StaffAnalyticsQueryDto) {
    const data = await this.analyticsService.getStaffAnalytics(req.user, query);
    return {
      success: true,
      message: 'Lấy dữ liệu phân tích nhân sự thành công',
      data,
    };
  }

  @ApiBearerAuth('JWT-auth')
  @Get('alerts')
  @ApiOperation({ summary: 'Lấy danh sách cảnh báo vận hành thời gian thực của cửa hàng' })
  async getAlertsAnalytics(@Request() req: any) {
    const data = await this.analyticsService.getAlertsAnalytics(req.user);
    return {
      success: true,
      message: 'Lấy danh sách cảnh báo thành công',
      data,
    };
  }
}