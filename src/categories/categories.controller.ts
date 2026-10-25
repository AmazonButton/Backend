import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { CategoriesService } from './categories.service';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

@Controller('stores/:storeId/categories')
export class StoreCategoriesController {
  constructor(private readonly categoriesService: CategoriesService) {}

  @Get()
  async listStoreCategories(
    @Param('storeId') storeId: string,
    @Query('mode') mode?: 'flat' | 'tree',
  ) {
    const data = await this.categoriesService.listStoreCategories(storeId, mode || 'tree');
    return {
      success: true,
      message: 'Lấy danh mục sản phẩm của cửa hàng thành công',
      data,
    };
  }

  @UseGuards(JwtAuthGuard)
  @Post()
  async createCategory(
    @Request() req: any,
    @Param('storeId') storeId: string,
    @Body() body: CreateCategoryDto,
  ) {
    const data = await this.categoriesService.createCategory(req.user, storeId, body);
    return {
      success: true,
      message: 'Tạo danh mục sản phẩm thành công',
      data,
    };
  }
}

@Controller('categories')
export class CategoriesController {
  constructor(private readonly categoriesService: CategoriesService) {}

  @Get(':id')
  async getCategoryById(@Param('id') id: string) {
    const data = await this.categoriesService.getCategoryById(id);
    return {
      success: true,
      message: 'Lấy thông tin danh mục thành công',
      data,
    };
  }

  @UseGuards(JwtAuthGuard)
  @Patch(':id')
  async updateCategory(
    @Request() req: any,
    @Param('id') id: string,
    @Body() body: UpdateCategoryDto,
  ) {
    const data = await this.categoriesService.updateCategory(req.user, id, body);
    return {
      success: true,
      message: 'Cập nhật danh mục thành công',
      data,
    };
  }

  @UseGuards(JwtAuthGuard)
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  async deleteCategory(
    @Request() req: any,
    @Param('id') id: string,
  ) {
    await this.categoriesService.deleteCategory(req.user, id);
    return {
      success: true,
      message: 'Xóa danh mục thành công',
    };
  }
}
