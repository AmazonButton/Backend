import { Controller, Get, Post, Body, Query, Param, UseGuards, Request } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { CustomersService } from './customers.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CreateCustomerBankAccountDto } from './dto/create-customer-bank-account.dto';

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

  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Đăng ký tài khoản ngân hàng nhận tiền hoàn cọc của khách hàng' })
  @Post('me/bank-accounts')
  async createMyBankAccount(@Request() req: any, @Body() dto: CreateCustomerBankAccountDto) {
    const data = await this.customersService.addBankAccount(req.user, dto);
    return {
      success: true,
      message: 'Đăng ký tài khoản ngân hàng thành công',
      data,
    };
  }

  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Lấy danh sách tài khoản ngân hàng của khách hàng' })
  @Get('me/bank-accounts')
  async getMyBankAccounts(@Request() req: any) {
    const data = await this.customersService.getBankAccounts(req.user);
    return {
      success: true,
      message: 'Lấy danh sách tài khoản ngân hàng thành công',
      data,
    };
  }

  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Polling trạng thái xác minh tài khoản ngân hàng của khách hàng' })
  @Get('me/bank-accounts/:id/verification-status')
  async getMyBankAccountVerificationStatus(@Request() req: any, @Param('id') id: string) {
    const data = await this.customersService.getBankAccountVerificationStatus(req.user, id);
    return {
      success: true,
      message: 'Lấy trạng thái xác minh tài khoản ngân hàng thành công',
      data,
    };
  }

  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Xác minh tài khoản ngân hàng của khách hàng với bằng chứng hợp lệ' })
  @Post('me/bank-accounts/:id/verify')
  async verifyMyBankAccount(
    @Request() req: any,
    @Param('id') id: string,
    @Body() evidence?: { verificationCode?: string; proofReference?: string },
  ) {
    const data = await this.customersService.verifyBankAccount(req.user, id, evidence);
    return {
      success: true,
      message: data.message || 'Xác minh tài khoản ngân hàng thành công',
      data,
    };
  }
}
