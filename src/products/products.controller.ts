import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  Query,
  UseGuards,
  Request,
  Inject,
} from '@nestjs/common';
import { ProductsService } from './products.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

@Controller('products')
export class ProductsController {
  constructor(@Inject(ProductsService) private readonly productsService: ProductsService) {}

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Get()
  async list(@Request() req: any, @Query('storeId') storeId?: string) {
    const targetStoreId = req.user.storeId || storeId;
    const data = await this.productsService.list(targetStoreId);
    return { success: true, data };
  }

  @Get('storefront/catalog')
  async storefrontCatalog(@Query('search') search?: string, @Query('category') category?: string) {
    const data = await this.productsService.storefrontCatalog(search, category);
    return { success: true, data };
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('STORE_OWNER', 'STORE_MANAGER', 'SUPER_ADMIN')
  @Post()
  async create(@Request() req: any, @Body() body: any) {
    const data = await this.productsService.create(req.user, body);
    return { success: true, message: 'Tạo sản phẩm thành công!', data };
  }

  @Roles('STORE_OWNER', 'STORE_MANAGER', 'SUPER_ADMIN')
  @Put(':id')
  async update(@Param('id') id: string, @Body() body: any) {
    const data = await this.productsService.update(id, body);
    return { success: true, message: 'Cập nhật sản phẩm thành công!', data };
  }

  @Roles('STORE_OWNER', 'STORE_MANAGER', 'SUPER_ADMIN')
  @Delete(':id')
  async delete(@Param('id') id: string) {
    const data = await this.productsService.delete(id);
    return { success: true, message: 'Xóa sản phẩm thành công!', data };
  }
}
