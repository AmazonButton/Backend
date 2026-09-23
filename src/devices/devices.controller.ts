import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  UseGuards,
  Request,
  Inject,
} from '@nestjs/common';
import { DevicesService } from './devices.service';
import { OrdersService } from '../orders/orders.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('devices')
export class DevicesController {
  constructor(
    @Inject(DevicesService) private readonly devicesService: DevicesService,
    @Inject(OrdersService) private readonly ordersService: OrdersService,
  ) {}

  @Get('fleet/stats')
  async getFleetStats(@Request() req: any) {
    const data = await this.devicesService.getFleetStats(req.user);
    return { success: true, data };
  }

  @Get()
  async list(@Request() req: any, @Query() query: any) {
    const data = await this.devicesService.list(req.user, query);
    return { success: true, data };
  }

  @Post()
  @Roles('STORE_OWNER', 'STORE_MANAGER', 'SUPER_ADMIN')
  async register(@Body() body: any, @Request() req: any) {
    const data = await this.devicesService.registerDevice(body, req.user);
    return { success: true, message: 'Đăng ký thiết bị thành công!', data };
  }

  @Post('bulk-import')
  @Roles('STORE_OWNER', 'STORE_MANAGER', 'SUPER_ADMIN')
  async bulkImport(@Body() body: { rows: any[]; storeId?: string }, @Request() req: any) {
    return this.devicesService.bulkImport(body, req.user);
  }

  /**
   * Super Admin tạo lô nút bấm trống vào kho tổng
   */
  @Post('batch-generate')
  @Roles('SUPER_ADMIN')
  async batchGenerate(@Body() body: { count: number; prefix?: string; model?: string }, @Request() req: any) {
    return this.devicesService.batchGenerateBlankDevices(body, req.user);
  }

  /**
   * Super Admin lấy danh sách nút trống chưa phân bổ
   */
  @Get('unassigned')
  @Roles('SUPER_ADMIN')
  async getUnassigned() {
    const data = await this.devicesService.getUnassignedDevices();
    return { success: true, data };
  }

  /**
   * Super Admin cấp quyền phân phối danh sách nút cho Cửa hàng
   */
  @Post('allocate-store')
  @Roles('SUPER_ADMIN')
  async allocateToStore(@Body() body: { storeId: string; deviceIds: string[]; productId?: string }, @Request() req: any) {
    return this.devicesService.allocateDevicesToStore(body, req.user);
  }

  /**
   * Search device by 6-digit PIN, Device ID, or QR Payload without MAC
   */
  @Post('lookup-code')
  async lookupCode(@Body() body: { code: string }) {
    const data = await this.devicesService.lookupByCode(body.code);
    return { success: true, data };
  }

  /**
   * Pair / Claim / Configure device directly by Code or QR Payload (No MAC needed)
   */
  @Post('configure-by-code')
  async configureByCode(@Body() body: any, @Request() req: any) {
    return this.devicesService.configureByCode(body, req.user);
  }

  @Get(':id')
  async getById(@Param('id') id: string, @Request() req: any) {
    const data = await this.devicesService.getById(id, req.user);
    return { success: true, data };
  }

  @Patch(':id')
  @Roles('STORE_OWNER', 'STORE_MANAGER', 'SUPER_ADMIN')
  async update(@Param('id') id: string, @Body() body: any, @Request() req: any) {
    const data = await this.devicesService.update(id, body, req.user);
    return { success: true, message: 'Cập nhật thiết bị thành công', data };
  }

  @Delete(':id')
  @Roles('STORE_OWNER', 'STORE_MANAGER', 'SUPER_ADMIN')
  async remove(@Param('id') id: string, @Request() req: any) {
    const data = await this.devicesService.remove(id, req.user);
    return data;
  }

  @Post(':id/pair')
  @Roles('STORE_OWNER', 'STORE_MANAGER', 'SUPER_ADMIN')
  async pair(@Param('id') id: string, @Body() body: any, @Request() req: any) {
    const data = await this.devicesService.pair(id, body, req.user);
    return { success: true, message: 'Ghép nối thiết bị thành công!', data };
  }

  @Post(':id/re-pair')
  @Roles('STORE_OWNER', 'STORE_MANAGER', 'SUPER_ADMIN')
  async repair(@Param('id') id: string, @Request() req: any) {
    const data = await this.devicesService.repair(id, req.user);
    return { success: true, message: 'Đã tạo lại mã QR và token ghép nối mới', data };
  }

  @Post(':id/assign-product')
  @Roles('STORE_OWNER', 'STORE_MANAGER', 'SUPER_ADMIN')
  async assignProduct(@Param('id') id: string, @Body() body: any, @Request() req: any) {
    return this.devicesService.assignProduct(id, body, req.user);
  }

  @Delete(':id/product')
  @Roles('STORE_OWNER', 'STORE_MANAGER', 'SUPER_ADMIN')
  async unassignProduct(@Param('id') id: string, @Request() req: any) {
    return this.devicesService.unassignProduct(id, req.user);
  }

  @Post(':id/disable')
  @Roles('STORE_OWNER', 'STAFF_BUTTON', 'SYSTEM_ADMIN', 'SUPER_ADMIN')
  async disable(@Param('id') id: string, @Request() req: any) {
    const data = await this.devicesService.disable(id, req.user);
    return { success: true, message: 'Đã vô hiệu hóa thiết bị', data };
  }

  @Post(':id/enable')
  @Roles('STORE_OWNER', 'STAFF_BUTTON', 'SYSTEM_ADMIN', 'SUPER_ADMIN')
  async enable(@Param('id') id: string, @Request() req: any) {
    const data = await this.devicesService.enable(id, req.user);
    return { success: true, message: 'Đã kích hoạt thiết bị', data };
  }

  @Get(':id/telemetry')
  async getTelemetry(@Param('id') id: string, @Request() req: any) {
    const data = await this.devicesService.getTelemetry(id, req.user);
    return { success: true, data };
  }

  @Get(':id/audit-logs')
  async getAuditLogs(@Param('id') id: string, @Request() req: any) {
    const data = await this.devicesService.getAuditLogs(id, req.user);
    return { success: true, data };
  }

  // --- Backward Compatibility Endpoints ---
  @Roles('STORE_OWNER', 'STORE_MANAGER', 'SUPER_ADMIN')
  @Post('claim')
  async claim(@Request() req: any, @Body() body: { deviceId: string; claimCode: string }) {
    const data = await this.devicesService.claim(
      body.deviceId,
      body.claimCode,
      req.user.storeId,
      req.user.id,
    );
    return { success: true, message: 'Kích hoạt thiết bị thành công!', data };
  }

  @Roles('STORE_OWNER', 'STORE_MANAGER', 'SUPER_ADMIN')
  @Post(':id/assign')
  async assign(@Param('id') id: string, @Body() body: any, @Request() req: any) {
    const data = await this.devicesService.assign(id, body, req.user.storeId, req.user.id);
    return { success: true, message: 'Gán nút bấm thành công!', data };
  }

  @Put(':id/config')
  async updateConfig(@Param('id') id: string, @Body() body: any, @Request() req: any) {
    const data = await this.devicesService.updateConfig(id, body, req.user);
    return { success: true, message: 'Cập nhật cấu hình thành công', data };
  }

  @Roles('STORE_OWNER', 'STORE_MANAGER', 'SUPER_ADMIN')
  @Patch(':id/status')
  async toggleStatus(@Param('id') id: string, @Body('status') status: string) {
    const data = await this.devicesService.toggleStatus(id, status);
    return { success: true, message: `Trạng thái đã chuyển sang ${status}`, data };
  }

  /**
   * Khách hàng (User) tự cấu hình nút bấm của mình:
   * Sửa tên nút, chọn lại sản phẩm (trong cùng Store), đổi số lượng, bật/tắt nút.
   */
  @Roles('CUSTOMER', 'SUPER_ADMIN')
  @Put(':id/customer-config')
  async customerUpdateConfig(@Param('id') id: string, @Body() body: any, @Request() req: any) {
    const data = await this.devicesService.customerUpdateConfig(id, body, req.user);
    return { success: true, message: 'Cấu hình nút bấm thành công!', data };
  }

  /**
   * Cập nhật / Sạc / Thay pin cho nút bấm
   */
  @Roles('STORE_OWNER', 'STAFF_BUTTON', 'SYSTEM_ADMIN', 'SUPER_ADMIN')
  @Patch(':id/battery')
  async updateBattery(@Param('id') id: string, @Body('batteryLevel') batteryLevel: number, @Request() req: any) {
    const data = await this.devicesService.updateBattery(id, batteryLevel !== undefined ? batteryLevel : 100, req.user);
    return { success: true, message: 'Cập nhật pin thiết bị thành công!', data };
  }

  /**
   * Gia hạn thời hạn sử dụng / hạn bảo hành cho nút bấm
   */
  @Roles('STORE_OWNER', 'STAFF_BUTTON', 'SYSTEM_ADMIN', 'SUPER_ADMIN')
  @Patch(':id/extend-warranty')
  async extendWarranty(@Param('id') id: string, @Body() body: any, @Request() req: any) {
    const data = await this.devicesService.extendWarranty(id, body, req.user);
    return { success: true, message: 'Gia hạn thời hạn sử dụng thành công!', data };
  }

  /**
   * Bật / Tắt trạng thái còn xài hay không của nút bấm
   */
  @Roles('STORE_OWNER', 'STAFF_BUTTON', 'SYSTEM_ADMIN', 'SUPER_ADMIN')
  @Patch(':id/toggle-active')
  async toggleActive(@Param('id') id: string, @Body('status') status: string, @Request() req: any) {
    const data = await this.devicesService.toggleDeviceStatus(id, status, req.user);
    return { success: true, message: `Đã chuyển trạng thái thiết bị sang ${data.status}`, data };
  }

  /**
   * Cấu hình hành vi nút bấm (SmartSupply Behavior Designer)
   */
  @Put(':id/behavior')
  async updateBehavior(@Param('id') id: string, @Body() body: any, @Request() req: any) {
    const data = await this.devicesService.updateBehavior(id, body, req.user);
    return { success: true, message: 'Cập nhật hành vi nút bấm thành công!', data };
  }

  /**
   * Mô phỏng bấm nút gửi tín hiệu cho server
   */
  @Post(':id/simulate-press')
  async simulatePress(@Param('id') id: string, @Body() body: any, @Request() req: any) {
    return this.ordersService.simulateButtonPress({ deviceId: id, ...body }, req.user);
  }
}
