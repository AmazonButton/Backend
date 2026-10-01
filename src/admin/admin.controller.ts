import { Controller, Get, Post, Put, Param, Body, UseGuards, Request, Inject } from '@nestjs/common';
import { AdminService } from './admin.service';
import { UpdateUserRoleDto } from './dto/update-user-role.dto';
import { CreateSubscriptionPlanDto, UpdateSubscriptionPlanDto } from './dto/plans.dto';
import { CreateRentalPackageDto, UpdateRentalPackageDto } from './dto/rental-packages.dto';
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
}
