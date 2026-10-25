import { Controller, Get, Param, Query, UseGuards, Request } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { ProductsService } from './products.service';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { buildPaginatedResponse } from '../common/utils/pagination.helper';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

@ApiTags('Products & Inventory')
@Controller('stores')
export class StoreInventoryController {
  constructor(private readonly productsService: ProductsService) {}

  @ApiBearerAuth('JWT-auth')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('STORE_OWNER', 'STORE_MANAGER', 'STAFF_INVENTORY', 'SYSTEM_ADMIN', 'SUPER_ADMIN')
  @Get(':storeId/inventory/low-stock')
  @ApiOperation({ summary: 'Xem danh sách sản phẩm cảnh báo sắp hết hàng' })
  async getLowStock(
    @Param('storeId') storeId: string,
    @Query() query: PaginationQueryDto,
    @Request() req: any,
  ) {
    const res = await this.productsService.getStoreLowStockInventory(storeId, query, req.user);
    return buildPaginatedResponse(
      res.items,
      res.total,
      res.page,
      res.pageSize,
      'Lấy danh sách sản phẩm sắp hết hàng thành công',
    );
  }

  @ApiBearerAuth('JWT-auth')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('STORE_OWNER', 'STORE_MANAGER', 'STAFF_INVENTORY', 'SYSTEM_ADMIN', 'SUPER_ADMIN')
  @Get(':storeId/inventory')
  @ApiOperation({ summary: 'Xem danh sách tồn kho theo cửa hàng' })
  async getInventory(
    @Param('storeId') storeId: string,
    @Query() query: PaginationQueryDto,
    @Request() req: any,
  ) {
    const res = await this.productsService.getStoreInventory(storeId, query, req.user);
    return buildPaginatedResponse(
      res.items,
      res.total,
      res.page,
      res.pageSize,
      'Lấy danh sách tồn kho thành công',
    );
  }
}
