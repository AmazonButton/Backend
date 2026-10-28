import { Controller, Get, Query, UseGuards, Request } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { CustomersService } from './customers.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

@ApiTags('Customers')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('CUSTOMER')
@Controller('customers')
export class CustomersController {
  constructor(private readonly customersService: CustomersService) {}

  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Lấy dữ liệu tổng quan dashboard của khách hàng hiện tại' })
  @Get('me/dashboard')
  async getMyDashboard(@Request() req: any) {
    const data = await this.customersService.getDashboard(req.user);
    return {
      success: true,
      message: 'Lấy dữ liệu dashboard khách hàng thành công',
      data,
    };
  }

  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Lấy dữ liệu thống kê đơn hàng của khách hàng hiện tại' })
  @Get('me/analytics/orders')
  async getMyOrdersAnalytics(
    @Request() req: any,
    @Query('fromDate') fromDate?: string,
    @Query('toDate') toDate?: string,
  ) {
    const data = await this.customersService.getOrdersAnalytics(req.user, fromDate, toDate);
    return {
      success: true,
      message: 'Lấy dữ liệu thống kê đơn hàng thành công',
      data,
    };
  }

  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Lấy danh sách thiết bị nút IoT thuộc quyền sở hữu/sử dụng của khách hàng' })
  @Get('me/analytics/devices')
  async getMyDevicesAnalytics(@Request() req: any) {
    const data = await this.customersService.getDevicesAnalytics(req.user);
    return {
      success: true,
      message: 'Lấy danh sách thiết bị nút IoT thành công',
      data,
    };
  }

  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Lấy lịch sử và trạng thái các gói thuê nút IoT của khách hàng' })
  @Get('me/analytics/rentals')
  async getMyRentalsAnalytics(@Request() req: any) {
    const data = await this.customersService.getRentalsAnalytics(req.user);
    return {
      success: true,
      message: 'Lấy dữ liệu các gói thuê nút IoT thành công',
      data,
    };
  }
}
