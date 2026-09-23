import { Injectable, BadRequestException, ForbiddenException, Inject } from '@nestjs/common';
import { ProductsRepository } from './products.repository';

@Injectable()
export class ProductsService {
  constructor(@Inject(ProductsRepository) private readonly productsRepo: ProductsRepository) {}

  async list(storeId?: string | number | bigint) {
    return this.productsRepo.findMany(storeId ? BigInt(storeId) : undefined);
  }

  async create(user: any, body: any) {
    const {
      productName,
      name,
      brand,
      productCode,
      sku,
      categoryId,
      basePrice,
      price,
      description,
      initialStock,
      stock,
    } = body;

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

    return this.productsRepo.create({
      storeId: targetStoreId,
      productName: finalProductName,
      productCode: finalCode,
      brand: brand || 'Khác',
      description: description || null,
      basePrice: parseFloat(finalPrice.toString()),
      status: 'ACTIVE',
      ...(categoryId ? { categoryId: BigInt(categoryId) } : {}),
      initialStock: initialStock !== undefined ? initialStock : stock || 50,
    });
  }

  async update(id: string | number | bigint, body: any, user?: any) {
    const targetProductId = BigInt(id);

    // BOLA / IDOR Protection: verify product belongs to user's store
    const existing = await this.productsRepo.findStoreIdOnly(targetProductId);
    if (!existing) {
      throw new BadRequestException('Sản phẩm không tồn tại');
    }

    if (user && user.role !== 'SUPER_ADMIN' && user.role !== 'SYSTEM_ADMIN') {
      if (user.storeId && existing.storeId !== BigInt(user.storeId)) {
        throw new ForbiddenException({
          success: false,
          code: 'ACCESS_DENIED',
          message: 'Bạn không có quyền chỉnh sửa sản phẩm của cửa hàng khác.',
        });
      }
    }

    const { productName, name, brand, basePrice, price, status, description, reason } = body;
    const finalProductName = productName || name;
    const finalPrice = basePrice !== undefined ? parseFloat(basePrice.toString()) : price !== undefined ? parseFloat(price.toString()) : undefined;

    // Track price change history if price is being updated
    if (finalPrice !== undefined && Number(existing.basePrice) !== finalPrice) {
      await this.productsRepo.recordPriceHistory({
        storeId: existing.storeId,
        productId: targetProductId,
        oldPrice: Number(existing.basePrice),
        newPrice: finalPrice,
        changedByUserId: user?.userId ? BigInt(user.userId) : undefined,
        reason: reason || 'Cập nhật giá bán sản phẩm',
      });
    }

    return this.productsRepo.update(targetProductId, {
      ...(finalProductName ? { productName: finalProductName } : {}),
      ...(brand ? { brand } : {}),
      ...(finalPrice !== undefined ? { basePrice: finalPrice } : {}),
      ...(status ? { status } : {}),
      ...(description !== undefined ? { description } : {}),
    });
  }

  async updateStock(
    id: string | number | bigint,
    body: { availableStock: number; lowStockThreshold?: number },
    user: any,
  ) {
    const targetProductId = BigInt(id);
    const existing = await this.productsRepo.findStoreIdOnly(targetProductId);
    if (!existing) {
      throw new BadRequestException('Sản phẩm không tồn tại');
    }

    if (user && user.role !== 'SUPER_ADMIN' && user.role !== 'SYSTEM_ADMIN') {
      if (user.storeId && existing.storeId !== BigInt(user.storeId)) {
        throw new ForbiddenException({
          success: false,
          code: 'ACCESS_DENIED',
          message: 'Bạn không có quyền cập nhật tồn kho của cửa hàng khác.',
        });
      }
    }

    const stock = Number(body.availableStock);
    if (isNaN(stock) || stock < 0) {
      throw new BadRequestException('Số lượng tồn kho phải là số không âm');
    }

    return this.productsRepo.updateInventoryStock(
      targetProductId,
      existing.storeId,
      stock,
      body.lowStockThreshold,
    );
  }
}
