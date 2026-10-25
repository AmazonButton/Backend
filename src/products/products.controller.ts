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
  ParseIntPipe,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { ProductsService } from './products.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { ProductQueryDto } from './dto/query-product.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { buildPaginatedResponse } from '../common/utils/pagination.helper';

@ApiTags('Products & Inventory')
@Controller('products')
export class ProductsController {
  constructor(@Inject(ProductsService) private readonly productsService: ProductsService) {}

  @Get('storefront/catalog')
  @ApiOperation({ summary: 'Xem danh mục sản phẩm công khai cho storefront (Không yêu cầu đăng nhập)' })
  async getStorefrontCatalog(
    @Query('search') search?: string,
    @Query('storeId') storeId?: string,
    @Query('category') category?: string,
  ) {
    const data = await this.productsService.getStorefrontCatalog({ search, storeId, category });
    return {
      success: true,
      data,
    };
  }

  @ApiBearerAuth('JWT-auth')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Get()
  @ApiOperation({ summary: 'Xem danh sách sản phẩm và tồn kho' })
  async list(
    @Request() req: any,
    @Query() query: ProductQueryDto,
  ) {
    const targetStoreId = req.user.storeId || query.storeId;
    const effectivePageSize = query.pageSize || query.limit;
    const pagination = {
      page: query.page,
      pageSize: effectivePageSize,
    };
    const res = await this.productsService.list(targetStoreId, pagination);
    return {
      success: true,
      data: res.data,
      ...(res.pagination ? { pagination: res.pagination } : {}),
    };
  }

  @ApiBearerAuth('JWT-auth')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Get(':id/price-history')
  @ApiOperation({ summary: 'Lịch sử thay đổi giá sản phẩm' })
  async getPriceHistory(
    @Param('id') id: string,
    @Query() query: PaginationQueryDto,
  ) {
    const res = await this.productsService.getPriceHistory(id, query);
    return buildPaginatedResponse(
      res.items,
      res.total,
      res.page,
      res.pageSize,
      'Lấy lịch sử thay đổi giá thành công',
    );
  }

  @ApiBearerAuth('JWT-auth')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Get(':id')
  @ApiOperation({ summary: 'Xem chi tiet san pham va danh sach anh' })
  async getById(
    @Param('id', new ParseIntPipe({ errorHttpStatusCode: HttpStatus.BAD_REQUEST })) id: number,
    @Request() req: any,
  ) {
    const data = await this.productsService.getById(id, req.user);
    return {
      success: true,
      data,
    };
  }

  @ApiBearerAuth('JWT-auth')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('STORE_OWNER', 'SYSTEM_ADMIN', 'SUPER_ADMIN')
  @Post()
  @ApiOperation({ summary: 'Tạo sản phẩm mới (STORE_OWNER hoặc SYSTEM_ADMIN)' })
  async create(@Request() req: any, @Body() body: CreateProductDto) {
    const data = await this.productsService.create(req.user, body);
    return { success: true, message: 'Tạo sản phẩm thành công!', data };
  }

  @ApiBearerAuth('JWT-auth')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('STORE_OWNER', 'SYSTEM_ADMIN', 'SUPER_ADMIN')
  @Put(':id')
  @ApiOperation({ summary: 'Cập nhật thông tin và giá sản phẩm (STORE_OWNER hoặc SYSTEM_ADMIN)' })
  async update(@Param('id') id: string, @Body() body: UpdateProductDto, @Request() req: any) {
    const data = await this.productsService.update(id, body, req.user);
    return { success: true, message: 'Cập nhật sản phẩm thành công!', data };
  }

  @ApiBearerAuth('JWT-auth')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('STORE_OWNER', 'STAFF_INVENTORY', 'SYSTEM_ADMIN', 'SUPER_ADMIN')
  @Patch(':id/inventory')
  @ApiOperation({ summary: 'Cập nhật số lượng tồn kho (STAFF_INVENTORY hoặc STORE_OWNER)' })
  async updateStock(
    @Param('id') id: string,
    @Body() body: { availableStock: number; lowStockThreshold?: number },
    @Request() req: any,
  ) {
    const data = await this.productsService.updateStock(id, body, req.user);
    return { success: true, message: 'Cập nhật tồn kho thành công!', data };
  }

  @ApiBearerAuth('JWT-auth')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('STORE_OWNER', 'SYSTEM_ADMIN', 'SUPER_ADMIN')
  @Delete(':id')
  @ApiOperation({ summary: 'Vô hiệu hóa (ngừng kinh doanh) sản phẩm thay vì xóa cứng (Soft delete)' })
  async remove(@Param('id') id: string, @Request() req: any) {
    const data = await this.productsService.remove(id, req.user);
    return { success: true, message: 'Đã chuyển sản phẩm sang trạng thái ngừng kinh doanh!', data };
  }
}
