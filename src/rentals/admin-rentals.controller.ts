import {
  Controller,
  Get,
  Patch,
  Param,
  Body,
  Query,
  UseGuards,
} from '@nestjs/common';
import { RentalsService } from './rentals.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { buildPaginatedResponse } from '../common/utils/pagination.helper';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN', 'SYSTEM_ADMIN')
@Controller('admin/rentals')
export class AdminRentalsController {
  constructor(private readonly rentalsService: RentalsService) {}

  @Get()
  async listAllRentals(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('status') status?: string,
  ) {
    const result = await this.rentalsService.listAllRentalsAdmin({
      page: page ? Number(page) : 1,
      pageSize: pageSize ? Number(pageSize) : 20,
      status,
    });

    return buildPaginatedResponse(
      result.items,
      result.total,
      result.page,
      result.pageSize,
      'Lấy danh sách hợp đồng thuê thành công',
    );
  }

  @Patch(':id/status')
  async updateRentalStatus(
    @Param('id') id: string,
    @Body('status') status: string,
  ) {
    const data = await this.rentalsService.updateRentalStatusAdmin(id, status);
    return {
      success: true,
      message: 'Cập nhật trạng thái hợp đồng thuê thành công',
      data,
    };
  }
}
