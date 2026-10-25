import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  UseGuards,
  Request,
} from '@nestjs/common';
import { StoreStaffService } from './store-staff.service';
import { CreateStoreStaffDto } from './dto/create-store-staff.dto';
import { UpdateStoreStaffDto } from './dto/update-store-staff.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { buildPaginatedResponse } from '../common/utils/pagination.helper';

@Controller()
export class StoreStaffController {
  constructor(private readonly service: StoreStaffService) {}

  @Get('store-staff-roles')
  async getAssignableRoles() {
    const data = await this.service.listAssignableRoles();
    return {
      success: true,
      message: 'Lấy danh sách vai trò nhân viên hợp lệ thành công',
      data,
    };
  }

  @UseGuards(JwtAuthGuard)
  @Get('stores/:storeId/staff')
  async listStoreStaff(
    @Param('storeId') storeId: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('status') status?: string,
    @Query('roleCode') roleCode?: string,
    @Request() req?: any,
  ) {
    const result = await this.service.listStaff(
      storeId,
      {
        page: page ? Number(page) : 1,
        pageSize: pageSize ? Number(pageSize) : 20,
        status,
        roleCode,
      },
      req?.user,
    );

    return buildPaginatedResponse(
      result.items,
      result.total,
      result.page,
      result.pageSize,
      'Lấy danh sách nhân viên cửa hàng thành công',
    );
  }

  @UseGuards(JwtAuthGuard)
  @Post('stores/:storeId/staff')
  async addStoreStaff(
    @Param('storeId') storeId: string,
    @Body() body: CreateStoreStaffDto,
    @Request() req: any,
  ) {
    const data = await this.service.addStaff(storeId, body, req.user);
    return {
      success: true,
      message: 'Thêm nhân viên vào cửa hàng thành công',
      data,
    };
  }

  @UseGuards(JwtAuthGuard)
  @Get('store-staff/:id')
  async getStoreStaff(@Param('id') id: string, @Request() req: any) {
    const data = await this.service.getStaff(id, req.user);
    return {
      success: true,
      message: 'Lấy thông tin nhân viên thành công',
      data,
    };
  }

  @UseGuards(JwtAuthGuard)
  @Patch('store-staff/:id')
  async updateStoreStaff(
    @Param('id') id: string,
    @Body() body: UpdateStoreStaffDto,
    @Request() req: any,
  ) {
    const data = await this.service.updateStaff(id, body, req.user);
    return {
      success: true,
      message: 'Cập nhật thông tin nhân viên thành công',
      data,
    };
  }

  @UseGuards(JwtAuthGuard)
  @Delete('store-staff/:id')
  async deleteStoreStaff(@Param('id') id: string, @Request() req: any) {
    const result = await this.service.deleteStaff(id, req.user);
    return result;
  }
}
