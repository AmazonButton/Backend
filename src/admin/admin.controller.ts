import { Controller, Get, Post, Param, Body, UseGuards, Request, Inject } from '@nestjs/common';
import { AdminService } from './admin.service';
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
  async updateUserRole(@Param('id') id: string, @Body('role') role: string) {
    const data = await this.adminService.updateUserRole(id, role);
    return { success: true, message: 'Đã cập nhật vai trò phân quyền', data };
  }
}
