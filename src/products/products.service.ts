import { Injectable, BadRequestException, Inject } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ProductsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async list(storeId?: string) {
    return this.prisma.product.findMany({
      where: storeId ? { storeId } : {},
      orderBy: { createdAt: 'desc' },
    });
  }

  async create(user: any, body: any) {
    const { name, brand, sku, category, unit, price, stock, imageUrl } = body;

    if (!user.storeId) {
      throw new BadRequestException('Bạn không thuộc cửa hàng nào để tạo sản phẩm');
    }

    return this.prisma.product.create({
      data: {
        storeId: user.storeId,
        name,
        brand: brand || 'Khác',
        sku,
        category: category || 'Nhu yếu phẩm',
        unit,
        price: parseFloat(price),
        stock: parseInt(stock || '0', 10),
        imageUrl,
      },
    });
  }

  async update(id: string, body: any) {
    const { name, brand, price, stock, unit, category, imageUrl, isActive } = body;
    return this.prisma.product.update({
      where: { id },
      data: {
        ...(name ? { name } : {}),
        ...(brand ? { brand } : {}),
        ...(price !== undefined ? { price: parseFloat(price) } : {}),
        ...(stock !== undefined ? { stock: parseInt(stock, 10) } : {}),
        ...(unit ? { unit } : {}),
        ...(category ? { category } : {}),
        ...(imageUrl ? { imageUrl } : {}),
        ...(isActive !== undefined ? { isActive } : {}),
      },
    });
  }
}
