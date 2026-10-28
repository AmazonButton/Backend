import { Controller, Get, Post, Put, Param, Body, UseGuards, Request, Inject, Query, BadRequestException } from '@nestjs/common';
import { AdminService } from './admin.service';
import { UpdateUserRoleDto } from './dto/update-user-role.dto';
import { CreateSubscriptionPlanDto, UpdateSubscriptionPlanDto } from './dto/plans.dto';
import { CreateRentalPackageDto, UpdateRentalPackageDto } from './dto/rental-packages.dto';
import { CreatePayosBatchPayoutDto, EstimatePayoutCreditDto, ListPayosPayoutsQueryDto } from './dto/payos-payout.dto';
import {
  AdminDashboardQueryDto,
  AdminTimeseriesAnalyticsQueryDto,
  AdminStoresLeaderboardQueryDto,
} from './dto/admin-analytics-query.dto';
import { WalletMapper } from '../store-wallet/mappers/wallet.mapper';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('SUPER_ADMIN')
@Controller('admin')
export class AdminController {
  constructor(@Inject(AdminService) private readonly adminService: AdminService) {}

  @Get('stores/pending')
  async listPendingStores() {
    const data = await this.adminService.listPendingStores();
    return { success: true, data };
  }

  @Get('stores')
  async listStores() {
    const data = await this.adminService.listAllStores();
    return { success: true, data };
  }

  @Post('stores/:id/approve')
  async approveStore(@Param('id') id: string, @Request() req: any) {
    const data = await this.adminService.approveStore(id, req.user);
    return { success: true, message: 'Đã phê duyệt cửa hàng thành công!', data };
  }

  @Post('stores/:id/reject')
  async rejectStore(@Param('id') id: string, @Body('reason') reason: string, @Request() req: any) {
    const data = await this.adminService.rejectStore(id, reason, req.user);
    return { success: true, message: 'Đã từ chối cửa hàng', data };
  }

  @Get('stats')
  async getStats() {
    const data = await this.adminService.getSystemStats();
    return { success: true, data };
  }

  @Get('audit-logs')
  async listAuditLogs() {
    const data = await this.adminService.listAuditLogs();
    return { success: true, data };
  }

  @Get('users')
  async listUsers() {
    const data = await this.adminService.listUsers();
    return { success: true, data };
  }

  @Post('users/:id/toggle-status')
  async toggleUserStatus(@Param('id') id: string) {
    const data = await this.adminService.toggleUserStatus(id);
    return { success: true, message: 'Đã cập nhật trạng thái tài khoản', data };
  }

  @Post('users/:id/role')
  async updateUserRole(@Param('id') id: string, @Body() body: UpdateUserRoleDto) {
    const data = await this.adminService.updateUserRole(id, body.role);
    return { success: true, message: 'Đã cập nhật vai trò phân quyền', data };
  }

  // Plans
  @Post('plans')
  async createPlan(@Body() body: CreateSubscriptionPlanDto) {
    const data = await this.adminService.createSubscriptionPlan(body);
    return { success: true, message: 'Tạo gói cước thành công!', data };
  }

  @Get('plans')
  async listPlans() {
    const data = await this.adminService.listSubscriptionPlans();
    return { success: true, data };
  }

  @Put('plans/:id')
  async updatePlan(@Param('id') id: string, @Body() body: UpdateSubscriptionPlanDto) {
    const data = await this.adminService.updateSubscriptionPlan(id, body);
    return { success: true, message: 'Cập nhật gói cước thành công!', data };
  }

  // Rental Packages
  @Post('rentals/packages')
  async createRentalPackage(@Body() body: CreateRentalPackageDto) {
    const data = await this.adminService.createRentalPackage(body);
    return { success: true, message: 'Tạo gói thuê nút IoT thành công!', data };
  }

  @Get('rentals/packages')
  async listRentalPackages() {
    const data = await this.adminService.listRentalPackages();
    return { success: true, data };
  }

  @Put('rentals/packages/:id')
  async updateRentalPackage(@Param('id') id: string, @Body() body: UpdateRentalPackageDto) {
    const data = await this.adminService.updateRentalPackage(id, body);
    return { success: true, message: 'Cập nhật gói thuê nút thành công!', data };
  }

  // Withdrawals
  @Roles('SUPER_ADMIN', 'SYSTEM_ADMIN', 'ADMIN')
  @Get('withdrawals')
  async listAllWithdrawals() {
    const data = await this.adminService.listAllWithdrawals();
    return { success: true, data: WalletMapper.toWithdrawalDtoList(data) };
  }

  @Roles('SUPER_ADMIN', 'SYSTEM_ADMIN', 'ADMIN')
  @Get('withdrawals/:id')
  async getWithdrawalById(@Param('id') id: string) {
    const data = await this.adminService.getWithdrawalById(id);
    return { success: true, message: 'Lấy chi tiết yêu cầu rút tiền thành công', data: WalletMapper.toWithdrawalDto(data) };
  }

  /**
   * @deprecated Endpoint này đã bị vô hiệu hóa để bảo đảm tính toàn vẹn tài chính. Mọi khoản rút tiền phải qua PayOS Payout (/withdrawals/:id/payout).
   */
  @Post('withdrawals/:id/transfer')
  async confirmTransfer(
    @Param('id') id: string,
    @Body('transferEvidenceUrl') transferEvidenceUrl: string,
    @Request() req: any
  ) {
    throw new BadRequestException({
      success: false,
      errorCode: 'MANUAL_TRANSFER_DEPRECATED',
      message:
        'Phương thức chuyển khoản thủ công đã bị vô hiệu hóa. Trạng thái rút tiền chỉ được xử lý qua PayOS Payout (POST /api/v1/admin/withdrawals/:id/payout).',
    });
  }

  @Post('withdrawals/:id/reject')
  async rejectWithdrawal(
    @Param('id') id: string,
    @Body('reason') reason: string,
    @Request() req: any
  ) {
    const data = await this.adminService.rejectWithdrawal(id, reason, req.user);
    return { success: true, message: 'Đã từ chối và hoàn tiền vào ví cửa hàng!', data: WalletMapper.toWithdrawalDto(data) };
  }
  // PayOS Payout Admin Controls
  @Get('payos/payout-balance')
  async getPayoutBalance() {
    const data = await this.adminService.getPayosPayoutBalance();
    return { success: true, data };
  }

  @Post('withdrawals/:id/payout')
  async payoutViaPayOS(@Param('id') id: string, @Request() req: any) {
    const data = await this.adminService.payoutViaPayOS(id, req.user);
    return { success: true, message: 'Đã gửi lệnh chi tiền PayOS thành công!', data: WalletMapper.toWithdrawalDto(data) };
  }

    @Post('withdrawals/:id/sync-payout')
  async syncPayoutStatus(@Param('id') id: string) {
    const data = await this.adminService.syncPayoutStatus(id);
    return { success: true, message: 'Đã đồng bộ trạng thái chi tiền PayOS!', data };
  }

  @Post('payos/payouts/batch')
  async createBatchPayout(@Body() body: CreatePayosBatchPayoutDto) {
    const res = await this.adminService.createBatchPayout(body);
    return { success: true, message: 'Đã gửi lệnh chi theo lô PayOS!', data: res?.data || res };
  }

  @Post('payos/payouts/estimate-credit')
  async estimatePayoutCredit(@Body() body: EstimatePayoutCreditDto) {
    const res = await this.adminService.estimatePayoutCredit(body);
    return { success: true, data: res?.data || res };
  }

  @Get('payos/payouts')
  async listPayosPayouts(@Query() query: ListPayosPayoutsQueryDto) {
    const res = await this.adminService.listPayosPayouts(query);
    return { success: true, data: res?.data || res };
  }

  @Roles('SUPER_ADMIN', 'SYSTEM_ADMIN', 'ADMIN')
  @Get('dashboard')
  async getDashboard(@Query() query: AdminDashboardQueryDto) {
    const data = await this.adminService.getDashboard(query);
    return { success: true, message: 'Lấy dữ liệu dashboard quản trị thành công', data };
  }

  @Roles('SUPER_ADMIN', 'SYSTEM_ADMIN', 'ADMIN')
  @Get('analytics/revenue')
  async getRevenueAnalytics(@Query() query: AdminTimeseriesAnalyticsQueryDto) {
    const data = await this.adminService.getRevenueAnalytics(query);
    return { success: true, message: 'Lấy dữ liệu phân tích doanh thu thành công', data };
  }

  @Roles('SUPER_ADMIN', 'SYSTEM_ADMIN', 'ADMIN')
  @Get('analytics/growth')
  async getGrowthAnalytics(@Query() query: AdminTimeseriesAnalyticsQueryDto) {
    const data = await this.adminService.getGrowthAnalytics(query);
    return { success: true, message: 'Lấy dữ liệu phân tích tăng trưởng thành công', data };
  }

  @Roles('SUPER_ADMIN', 'SYSTEM_ADMIN', 'ADMIN')
  @Get('analytics/operations')
  async getOperationsAnalytics() {
    const data = await this.adminService.getOperationsAnalytics();
    return { success: true, message: 'Lấy dữ liệu vận hành hệ thống thành công', data };
  }

  @Roles('SUPER_ADMIN', 'SYSTEM_ADMIN', 'ADMIN')
  @Get('analytics/stores')
  async getStoresLeaderboard(@Query() query: AdminStoresLeaderboardQueryDto) {
    const result = await this.adminService.getStoresLeaderboard(query);
    return {
      success: true,
      message: 'Lấy bảng xếp hạng cửa hàng thành công',
      data: result.stores,
      pagination: result.pagination,
    };
  }
}
