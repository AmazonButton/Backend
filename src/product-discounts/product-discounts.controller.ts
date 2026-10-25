import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  UseGuards,
  Request,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ProductDiscountsService } from './product-discounts.service';
import { CreateProductDiscountDto } from './dto/create-product-discount.dto';
import { UpdateProductDiscountDto } from './dto/update-product-discount.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

@Controller('products/:productId/discounts')
export class ProductDiscountsController {
  constructor(private readonly discountsService: ProductDiscountsService) {}

  @Get()
  async listProductDiscounts(@Param('productId') productId: string) {
    const data = await this.discountsService.listProductDiscounts(productId);
    return {
      success: true,
      message: 'Lấy danh sách chương trình giảm giá của sản phẩm thành công',
      data,
    };
  }

  @UseGuards(JwtAuthGuard)
  @Post()
  async createDiscount(
    @Request() req: any,
    @Param('productId') productId: string,
    @Body() body: CreateProductDiscountDto,
  ) {
    const data = await this.discountsService.createDiscount(req.user, productId, body);
    return {
      success: true,
      message: 'Tạo chương trình giảm giá thành công',
      data,
    };
  }
}

@Controller('discounts')
export class DiscountsController {
  constructor(private readonly discountsService: ProductDiscountsService) {}

  @Get(':id')
  async getDiscountById(@Param('id') id: string) {
    const data = await this.discountsService.getDiscountById(id);
    return {
      success: true,
      message: 'Lấy thông tin chương trình giảm giá thành công',
      data,
    };
  }

  @UseGuards(JwtAuthGuard)
  @Patch(':id')
  async updateDiscount(
    @Request() req: any,
    @Param('id') id: string,
    @Body() body: UpdateProductDiscountDto,
  ) {
    const data = await this.discountsService.updateDiscount(req.user, id, body);
    return {
      success: true,
      message: 'Cập nhật chương trình giảm giá thành công',
      data,
    };
  }

  @UseGuards(JwtAuthGuard)
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  async deleteDiscount(
    @Request() req: any,
    @Param('id') id: string,
  ) {
    await this.discountsService.deleteDiscount(req.user, id);
    return {
      success: true,
      message: 'Xóa chương trình giảm giá thành công',
    };
  }
}
