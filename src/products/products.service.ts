import { StoreSubscriptionsService } from '../store-subscriptions/store-subscriptions.service';
import { Injectable, BadRequestException, ForbiddenException, Inject } from '@nestjs/common';
import { ProductsRepository, ProductImageInput } from './products.repository';

@Injectable()
export class ProductsService {
  constructor(
    @Inject(ProductsRepository) private readonly productsRepo: ProductsRepository,
    @Inject(StoreSubscriptionsService) private readonly subscriptionsService: StoreSubscriptionsService
  ) {}

  private parseImageInputs(body: any): ProductImageInput[] | undefined {
    const { imageUrl, images, imageDetails } = body;
    if (imageDetails && Array.isArray(imageDetails) && imageDetails.length > 0) {
      return imageDetails.map((img: any, idx: number) => ({
        imageUrl: img.imageUrl || img.url,
        isThumbnail: img.isThumbnail !== undefined ? Boolean(img.isThumbnail) : idx === 0,
        displayOrder: img.displayOrder !== undefined ? Number(img.displayOrder) : idx,
      }));
    }

    if (images && Array.isArray(images) && images.length > 0) {
      return images.map((url: string, idx: number) => ({
        imageUrl: typeof url === 'string' ? url : (url as any).url || (url as any).imageUrl,
        isThumbnail: idx === 0,
        displayOrder: idx,
      }));
    }

    if (imageUrl && typeof imageUrl === 'string' && imageUrl.trim().length > 0) {
      return [
        {
          imageUrl: imageUrl.trim(),
          isThumbnail: true,
          displayOrder: 0,
        },
      ];
    }

    return undefined;
  }

  private formatProduct(p: any) {
    if (!p) return null;
    const thumb = p.images?.find((img: any) => img.isThumbnail) || p.images?.[0];
    const thumbUrl = thumb?.imageUrl || null;
    return {
      ...p,
      id: p.productId.toString(),
      productId: p.productId.toString(),
      sku: p.productCode || p.sku || ('SKU-' + p.productId.toString()),
      storeId: p.storeId ? p.storeId.toString() : null,
      categoryId: p.categoryId ? p.categoryId.toString() : null,
      basePrice: Number(p.basePrice),
      imageUrl: thumbUrl,
      thumbnailUrl: thumbUrl,
      images: p.images?.map((img: any) => ({
        imageId: img.imageId.toString(),
        productId: img.productId.toString(),
        imageUrl: img.imageUrl,
        isThumbnail: img.isThumbnail,
        displayOrder: img.displayOrder,
      })) || [],
    };
  }

  async list(storeId?: string | number | bigint, pagination?: { page?: number; pageSize?: number }) {
    const targetStoreId = storeId ? BigInt(storeId) : undefined;
    const { items, total, page, pageSize } = await this.productsRepo.findMany(targetStoreId, pagination);
    const data = items.map((p: any) => this.formatProduct(p));
    return {
      data,
      pagination: pagination?.pageSize
        ? {
            page: page || 1,
            pageSize: pageSize || total,
            total,
            totalPages: Math.ceil(total / (pageSize || 1)),
          }
        : undefined,
    };
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

    const imageInputs = this.parseImageInputs(body);

    const created = await this.productsRepo.create({
      storeId: targetStoreId,
      productName: finalProductName,
      productCode: finalCode,
      brand: brand || 'Khác',
      description: description || null,
      basePrice: parseFloat(finalPrice.toString()),
      status: 'ACTIVE',
      ...(categoryId ? { categoryId: BigInt(categoryId) } : {}),
      initialStock: initialStock !== undefined ? initialStock : stock || 50,
      images: imageInputs,
    });
    return this.formatProduct(created);
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

    const imageInputs = this.parseImageInputs(body);

    const updated = await this.productsRepo.update(
      targetProductId,
      {
        ...(finalProductName ? { productName: finalProductName } : {}),
        ...(brand ? { brand } : {}),
        ...(finalPrice !== undefined ? { basePrice: finalPrice } : {}),
        ...(status ? { status } : {}),
        ...(description !== undefined ? { description } : {}),
      },
      imageInputs,
    );

    return this.formatProduct(updated);
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
