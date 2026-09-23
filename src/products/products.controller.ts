import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Param,
  Body,
  Query,
  UseGuards,
  Request,
  Inject,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { ProductsService } from './products.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

@ApiTags('Products & Inventory')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('products')
export class ProductsController {
  constructor(@Inject(ProductsService) private readonly productsService: ProductsService) {}

  @Get()
  @ApiOperation({ summary: 'Xem danh sách sản phẩm và tồn kho' })
  async list(@Request() req: any, @Query('storeId') storeId?: string) {
    const targetStoreId = req.user.storeId || storeId;
    const data = await this.productsService.list(targetStoreId);
    return { success: true, data };
  }

  @Roles('STORE_OWNER', 'SYSTEM_ADMIN', 'SUPER_ADMIN')
  @Post()
  @ApiOperation({ summary: 'Tạo sản phẩm mới (STORE_OWNER hoặc SYSTEM_ADMIN)' })
  async create(@Request() req: any, @Body() body: CreateProductDto) {
    const data = await this.productsService.create(req.user, body);
    return { success: true, message: 'Tạo sản phẩm thành công!', data };
  }

  @Roles('STORE_OWNER', 'SYSTEM_ADMIN', 'SUPER_ADMIN')
  @Put(':id')
  @ApiOperation({ summary: 'Cập nhật thông tin và giá sản phẩm (STORE_OWNER hoặc SYSTEM_ADMIN)' })
  async update(@Param('id') id: string, @Body() body: UpdateProductDto, @Request() req: any) {
    const data = await this.productsService.update(id, body, req.user);
    return { success: true, message: 'Cập nhật sản phẩm thành công!', data };
  }

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
}
