import { Controller, Get, Patch, Param, Query, Body, UseGuards, Request } from '@nestjs/common';
import { StoresService } from './stores.service';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { buildPaginatedResponse } from '../common/utils/pagination.helper';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { UpdateStoreMeDto } from './dto/update-store-me.dto';

@Controller('stores')
export class StoresController {
  constructor(private readonly storesService: StoresService) {}

  @Get()
  async listStores(
    @Query('search') search?: string,
    @Query() pagination?: PaginationQueryDto,
  ) {
    const page = pagination?.page ? Number(pagination.page) : 1;
    const pageSize = pagination?.pageSize
      ? Number(pagination.pageSize)
      : pagination?.limit
        ? Number(pagination.limit)
        : 20;

    const result = await this.storesService.listActiveStores({
      search,
      page,
      pageSize,
    });

    return buildPaginatedResponse(
      result.items,
      result.total,
      result.page,
      result.pageSize,
      'Lấy danh sách cửa hàng thành công',
    );
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  async getStoreMe(@Request() req: any) {
    const data = await this.storesService.getStoreMe(req.user);
    return {
      success: true,
      message: 'Lấy thông tin cửa hàng thành công',
      data,
    };
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('STORE_OWNER', 'STORE_MANAGER', 'ADMIN', 'SYSTEM_ADMIN', 'SUPER_ADMIN')
  @Patch('me')
  async updateStoreMe(@Request() req: any, @Body() body: UpdateStoreMeDto) {
    const data = await this.storesService.updateStoreMe(req.user, body);
    return {
      success: true,
      message: 'Cập nhật thông tin cửa hàng thành công',
      data,
    };
  }

  @Get(':id')
  async getStoreById(@Param('id') id: string) {
    const data = await this.storesService.getStoreById(id);
    return {
      success: true,
      message: 'Lấy thông tin cửa hàng thành công',
      data,
    };
  }
}
