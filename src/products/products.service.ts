import { Injectable, BadRequestException, ForbiddenException, Inject } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ProductsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async list(storeId?: string | number | bigint) {
    const whereClause: any = {};
    if (storeId) {
      whereClause.storeId = BigInt(storeId);
    }
    return this.prisma.product.findMany({
      where: whereClause,
      include: {
        inventory: true,
        category: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async create(user: any, body: any) {
    const { productName, name, brand, productCode, sku, categoryId, basePrice, price, imageUrl, description } = body;

    const targetStoreId = user.storeId ? BigInt(user.storeId) : null;
    if (!targetStoreId) {
      throw new BadRequestException('Bạn không thuộc cửa hàng nào để tạo sản phẩm');
    }

    const finalProductName = productName || name;
    const finalCode = productCode || sku || `PROD-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;
    const finalPrice = basePrice !== undefined ? basePrice : price;

    if (!finalProductName || finalPrice === undefined) {
      throw new BadRequestException('Tên sản phẩm và giá gốc không được để trống');
    }

    return this.prisma.product.create({
      data: {
        storeId: targetStoreId,
        productName: finalProductName,
        productCode: finalCode,
        brand: brand || 'Khác',
        description: description || null,
        basePrice: parseFloat(finalPrice.toString()),
        status: 'ACTIVE',
        ...(categoryId ? { categoryId: BigInt(categoryId) } : {}),
      },
      include: {
        inventory: true,
      },
    });
  }

  async update(id: string | number | bigint, body: any, user?: any) {
    const targetProductId = BigInt(id);

    // BOLA / IDOR Protection: verify product belongs to user's store
    if (user && user.role !== 'SUPER_ADMIN') {
      const product = await this.prisma.product.findUnique({
        where: { productId: targetProductId },
        select: { storeId: true },
      });

      if (!product) {
        throw new BadRequestException('Sản phẩm không tồn tại');
      }

      if (user.storeId && product.storeId !== BigInt(user.storeId)) {
        throw new ForbiddenException({
          success: false,
          code: 'ACCESS_DENIED',
          message: 'Bạn không có quyền chỉnh sửa sản phẩm của cửa hàng khác.',
        });
      }
    }

    const { productName, name, brand, basePrice, price, status, description } = body;
    const finalProductName = productName || name;
    const finalPrice = basePrice !== undefined ? basePrice : price;

    return this.prisma.product.update({
      where: { productId: targetProductId },
      data: {
        ...(finalProductName ? { productName: finalProductName } : {}),
        ...(brand ? { brand } : {}),
        ...(finalPrice !== undefined ? { basePrice: parseFloat(finalPrice.toString()) } : {}),
        ...(status ? { status } : {}),
        ...(description !== undefined ? { description } : {}),
      },
      include: {
        inventory: true,
      },
    });
  }
}
