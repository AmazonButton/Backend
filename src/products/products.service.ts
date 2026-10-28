import { MediaService } from '../media/media.service';
import { StoreSubscriptionsService } from '../store-subscriptions/store-subscriptions.service';
import { Injectable, BadRequestException, NotFoundException, ForbiddenException, Inject, Logger, Optional } from '@nestjs/common';
import { ProductsRepository, ProductImageInput } from './products.repository';
import { EventsGateway } from '../websocket/events.gateway';
import { PriceHistoryResponseDto } from './dto/price-history-response.dto';
import { InventoryResponseDto } from './dto/inventory-response.dto';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { DashboardCacheService } from '../common/cache/dashboard-cache.service';

@Injectable()
export class ProductsService {
  private readonly logger = new Logger(ProductsService.name);
  constructor(
    @Inject(ProductsRepository) private readonly productsRepo: ProductsRepository,
    @Inject(StoreSubscriptionsService) private readonly subscriptionsService: StoreSubscriptionsService,
    @Inject(MediaService) private readonly mediaService: MediaService,
    @Optional() @Inject(EventsGateway) private readonly eventsGateway?: EventsGateway,
    @Optional() private readonly cacheService?: DashboardCacheService,
  ) {}

  private async invalidateProductCaches(storeId?: string | number | bigint) {
    if (!this.cacheService || typeof this.cacheService.invalidatePrefix !== 'function') return;
    try {
      const promises: Promise<void>[] = [
        this.cacheService.invalidatePrefix('admin:dashboard:'),
        this.cacheService.invalidatePrefix('admin:operations'),
      ];
      if (storeId) {
        promises.push(this.cacheService.invalidatePrefix(`dash:store:${storeId.toString()}:`));
        promises.push(this.cacheService.invalidatePrefix(`staff:dashboard:store:${storeId.toString()}:`));
      }
      await Promise.all(promises);
    } catch (error) {
      this.logger.warn(`Failed to invalidate product cache: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }

  private extractPublicIdFromUrl(url?: string): string | undefined {
    if (!url || typeof url !== 'string') return undefined;
    const match = url.match(/\/upload\/(?:v\d+\/)?([^\.]+)/);
    return match ? match[1] : undefined;
  }

  private parseImageInputs(body: any): ProductImageInput[] | undefined {
    const { imageUrl, images, imageDetails, cloudinaryPublicId } = body;
    if (Array.isArray(imageDetails)) {
      if (imageDetails.length === 0) return [];
      return imageDetails.map((img: any, idx: number) => ({
        imageUrl: img.imageUrl || img.url,
        cloudinaryPublicId: img.cloudinaryPublicId || img.publicId || this.extractPublicIdFromUrl(img.imageUrl || img.url),
        isThumbnail: img.isThumbnail !== undefined ? Boolean(img.isThumbnail) : idx === 0,
        displayOrder: img.displayOrder !== undefined ? Number(img.displayOrder) : idx,
      }));
    }

    if (Array.isArray(images)) {
      if (images.length === 0) return [];
      return images.map((img: any, idx: number) => {
        if (typeof img === 'string') {
          return {
            imageUrl: img,
            cloudinaryPublicId: this.extractPublicIdFromUrl(img),
            isThumbnail: idx === 0,
            displayOrder: idx,
          };
        }
        return {
          imageUrl: img.imageUrl || img.url,
          cloudinaryPublicId: img.cloudinaryPublicId || img.publicId || this.extractPublicIdFromUrl(img.imageUrl || img.url),
          isThumbnail: img.isThumbnail !== undefined ? Boolean(img.isThumbnail) : idx === 0,
          displayOrder: img.displayOrder !== undefined ? Number(img.displayOrder) : idx,
        };
      });
    }

    if (imageUrl && typeof imageUrl === 'string' && imageUrl.trim().length > 0) {
      return [
        {
          imageUrl: imageUrl.trim(),
          cloudinaryPublicId: cloudinaryPublicId || this.extractPublicIdFromUrl(imageUrl.trim()),
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
      name: p.productName || p.name || '',
      productName: p.productName || p.name || '',
      sku: p.productCode || p.sku || ('SKU-' + p.productId.toString()),
      storeId: p.storeId ? p.storeId.toString() : null,
      categoryId: p.categoryId ? p.categoryId.toString() : null,
      basePrice: Number(p.basePrice || 0),
      price: Number(p.basePrice || 0),
      stock: p.inventory ? Number(p.inventory.quantityOnHand || 0) : (p.stock !== undefined ? Number(p.stock) : 0),
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

  async getById(id: string | number | bigint, user?: any) {
    if (typeof id === 'string' && !/^\d+$/.test(id.trim())) {
      throw new BadRequestException('ID san pham khong hop le');
    }
    const productId = BigInt(id);
    const product = await this.productsRepo.findById(productId);
    if (!product) {
      throw new NotFoundException('San pham khong ton tai');
    }

    // Tenant Isolation (Fail-Closed):
    // STORE_OWNER va STAFF_INVENTORY chi duoc xem san pham cua cua hang minh.
    // Thieu storeId -> 403 Forbidden.
    // Khac storeId -> 403 Forbidden.
    // CUSTOMER va SYSTEM_ADMIN / SUPER_ADMIN duoc phep xem toan bo catalog cong khai.
    const isStoreScopedRole = user && (user.role === 'STORE_OWNER' || user.role === 'STAFF_INVENTORY');
    if (isStoreScopedRole) {
      if (!user.storeId) {
        throw new ForbiddenException('Tai khoan quan ly hoac nhan vien chua duoc lien ket voi bat ky cua hang nao');
      }
      if (product.storeId && product.storeId.toString() !== user.storeId.toString()) {
        throw new ForbiddenException('Ban khong co quyen truy cap san pham cua cua hang khac');
      }
    }

    return this.formatProduct(product);
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

    if (user.role !== 'SUPER_ADMIN' && user.role !== 'SYSTEM_ADMIN') {
      await this.subscriptionsService.validateStoreCanListProducts(targetStoreId);
    }

    const finalProductName = productName || name;
    const finalCode = productCode || sku || `PROD-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;
    const finalPrice = basePrice !== undefined ? basePrice : price;

    if (!finalProductName || finalPrice === undefined) {
      throw new BadRequestException('Tên sản phẩm và giá gốc không được để trống');
    }

    if (categoryId) {
      const cat = await this.productsRepo.findCategoryById(BigInt(categoryId), targetStoreId);
      if (!cat) {
        throw new BadRequestException('Danh mục không tồn tại hoặc không thuộc cửa hàng này');
      }
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
    const formatted = this.formatProduct(created);
    this.eventsGateway?.emitToStore(targetStoreId.toString(), 'PRODUCT_CREATED', {
      product: formatted,
      storeId: targetStoreId.toString(),
    });
    this.eventsGateway?.emitGlobal('PRODUCT_CREATED', {
      product: formatted,
      storeId: targetStoreId.toString(),
    });
    this.eventsGateway?.emitGlobal('CATALOG_UPDATED', {
      action: 'CREATE',
      product: formatted,
      storeId: targetStoreId.toString(),
    });
    await this.invalidateProductCaches(targetStoreId);
    return formatted;
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

    const { productName, name, brand, basePrice, price, status, description } = body;
    const finalProductName = productName || name;
    const finalPrice = basePrice !== undefined ? parseFloat(basePrice.toString()) : price !== undefined ? parseFloat(price.toString()) : undefined;

    // Prepare price change history if price is being updated
    const hasPriceChange = finalPrice !== undefined && Number(existing.basePrice) !== finalPrice;
    const priceHistory = hasPriceChange
      ? {
          oldPrice: Number(existing.basePrice),
          newPrice: finalPrice,
          changedByUserId: user?.userId ? BigInt(user.userId) : undefined,
        }
      : undefined;

    const stock = body.stock !== undefined && !isNaN(Number(body.stock)) ? Number(body.stock) : undefined;
    const imageInputs = this.parseImageInputs(body);

    // 1. Capture existing images before update for Cloudinary asset lifecycle
    const oldImages = imageInputs !== undefined
      ? await this.productsRepo.findProductImages(targetProductId)
      : [];

    if (body.categoryId) {
      const cat = await this.productsRepo.findCategoryById(BigInt(body.categoryId), existing.storeId);
      if (!cat) {
        throw new BadRequestException('Danh mục không tồn tại hoặc không thuộc cửa hàng này');
      }
    }

    // 2. Perform Atomic DB update (Product, Inventory, Price History, and Images in single transaction)
    const updated = await this.productsRepo.updateProductAtomicTx({
      productId: targetProductId,
      storeId: existing.storeId,
      data: {
        ...(finalProductName ? { productName: finalProductName } : {}),
        ...(brand ? { brand } : {}),
        ...(finalPrice !== undefined ? { basePrice: finalPrice } : {}),
        ...(status ? { status } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(body.categoryId ? { categoryId: BigInt(body.categoryId) } : {}),
      },
      images: imageInputs,
      priceHistory,
      stock,
    });

    // 3. Cloudinary Asset Lifecycle: Destroy removed store assets if reference count is 0
    if (imageInputs !== undefined && oldImages.length > 0) {
      const newPublicIds = new Set(imageInputs.map((img) => img.cloudinaryPublicId).filter(Boolean));
      const storePrefix = existing.storeId ? `stores/${existing.storeId.toString()}/` : 'stores/';

      for (const oldImg of oldImages) {
        const oldPubId = oldImg.cloudinaryPublicId;
        // Strictly protect seed catalog (smart-order/...) and only target store-scoped assets
        if (oldPubId && !newPublicIds.has(oldPubId) && oldPubId.startsWith(storePrefix)) {
          const remainingCount = await this.productsRepo.countImageReferences(oldPubId);
          if (remainingCount === 0) {
            try {
              const destroyed = await this.mediaService.deleteAsset(oldPubId);
              if (destroyed) {
                this.logger.log(`[Cloudinary Lifecycle] Safely destroyed orphaned asset: ${oldPubId}`);
              } else {
                this.logger.warn(`[Cloudinary Lifecycle Retry Outbox] Failed to destroy asset ${oldPubId} via Cloudinary API, registered for background retry`);
              }
            } catch (cloudErr: any) {
              this.logger.error(`[Cloudinary Lifecycle Retry Outbox] Failed to destroy asset ${oldPubId}: ${cloudErr.message}`);
            }
          }
        }
      }
    }

    const formatted = this.formatProduct(updated);
    this.eventsGateway?.emitToStore(existing.storeId.toString(), 'PRODUCT_UPDATED', {
      product: formatted,
      storeId: existing.storeId.toString(),
    });
    this.eventsGateway?.emitGlobal('PRODUCT_UPDATED', {
      product: formatted,
      storeId: existing.storeId.toString(),
    });
    this.eventsGateway?.emitGlobal('CATALOG_UPDATED', {
      action: 'UPDATE',
      product: formatted,
      storeId: existing.storeId.toString(),
    });
    await this.invalidateProductCaches(existing.storeId);
    return formatted;
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

    const res = await this.productsRepo.updateInventoryStock(
      targetProductId,
      existing.storeId,
      stock,
      body.lowStockThreshold,
    );

    this.eventsGateway?.emitToStore(existing.storeId.toString(), 'PRODUCT_STOCK_CHANGED', {
      productId: targetProductId.toString(),
      storeId: existing.storeId.toString(),
      availableStock: stock,
    });
    this.eventsGateway?.emitGlobal('PRODUCT_STOCK_CHANGED', {
      productId: targetProductId.toString(),
      storeId: existing.storeId.toString(),
      availableStock: stock,
    });
    this.eventsGateway?.emitGlobal('CATALOG_UPDATED', {
      action: 'STOCK',
      productId: targetProductId.toString(),
      storeId: existing.storeId.toString(),
      availableStock: stock,
    });

    await this.invalidateProductCaches(existing.storeId);
    return res;
  }

  async getStorefrontCatalog(params: { search?: string; storeId?: string; category?: string }) {
    const items = await this.productsRepo.findStorefrontCatalog(params);
    return items.map((p: any) => {
      const thumb = p.images?.find((img: any) => img.isThumbnail) || p.images?.[0];
      const imageUrl = thumb?.imageUrl || '';
      const availableStock = Number(p.inventory?.quantityOnHand || 0);
      const reservedStock = Number(p.inventory?.reservedQuantity || 0);

      return {
        id: p.productId.toString(),
        productId: p.productId.toString(),
        storeId: p.storeId.toString(),
        name: p.productName,
        productName: p.productName,
        productCode: p.productCode,
        sku: p.productCode,
        brand: p.brand || '',
        description: p.description || '',
        category: p.category?.categoryName || 'Khác',
        categoryId: p.categoryId ? p.categoryId.toString() : null,
        unit: 'Sản phẩm',
        price: Number(p.basePrice),
        basePrice: Number(p.basePrice),
        stock: availableStock,
        reservedStock,
        availableStock,
        imageUrl,
        thumbnailUrl: imageUrl,
        images: p.images?.map((img: any) => ({
          imageId: img.imageId.toString(),
          productId: img.productId.toString(),
          imageUrl: img.imageUrl,
          isThumbnail: img.isThumbnail,
          displayOrder: img.displayOrder,
        })) || [],
        store: {
          id: p.store.storeId.toString(),
          storeId: p.store.storeId.toString(),
          name: p.store.name,
          code: p.store.code,
          address: p.store.address,
          phone: p.store.phone,
        },
      };
    });
  }

  async remove(id: string | number | bigint, user?: any) {
    const targetProductId = BigInt(id);
    const hasActive = await this.productsRepo.hasActiveOrders(targetProductId);
    if (hasActive) {
      throw new BadRequestException({
        success: false,
        code: 'PRODUCT_HAS_ACTIVE_ORDERS',
        message: 'Không thể ngừng kinh doanh hoặc xóa sản phẩm đang có đơn hàng xử lý.',
      });
    }
    return this.update(id, { status: 'INACTIVE' }, user);
  }

  async getPriceHistory(productIdStr: string, query?: PaginationQueryDto, user?: any) {
    const productId = BigInt(productIdStr);
    const existing = await this.productsRepo.findStoreIdOnly(productId);
    if (!existing) {
      throw new NotFoundException('Sản phẩm không tồn tại');
    }
    if (user && !['SUPER_ADMIN', 'SYSTEM_ADMIN', 'ADMIN'].includes(user.role)) {
      if (!user.storeId || BigInt(user.storeId) !== existing.storeId) {
        throw new ForbiddenException({
          success: false,
          code: 'ACCESS_DENIED',
          message: 'Bạn không có quyền xem lịch sử giá của cửa hàng khác.',
        });
      }
    }
    const result = await this.productsRepo.findPriceHistory(productId, {
      page: query?.page ? Number(query.page) : 1,
      pageSize: query?.pageSize ? Number(query.pageSize) : 20,
    });
    return {
      items: result.items.map((h) => PriceHistoryResponseDto.fromEntity(h)),
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
    };
  }

  async getStoreInventory(storeIdStr: string, query?: PaginationQueryDto, user?: any) {
    const storeId = BigInt(storeIdStr);
    if (user && !['SUPER_ADMIN', 'SYSTEM_ADMIN', 'ADMIN'].includes(user.role)) {
      if (!user.storeId || BigInt(user.storeId) !== storeId) {
        throw new ForbiddenException({
          success: false,
          code: 'ACCESS_DENIED',
          message: 'Bạn không có quyền xem kho hàng của cửa hàng khác.',
        });
      }
    }

    const result = await this.productsRepo.findStoreInventory(storeId, {
      page: query?.page ? Number(query.page) : 1,
      pageSize: query?.pageSize ? Number(query.pageSize) : 20,
      lowStockOnly: false,
    });

    return {
      items: result.items.map((i) => InventoryResponseDto.fromEntity(i)),
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
    };
  }

  async getStoreLowStockInventory(storeIdStr: string, query?: PaginationQueryDto, user?: any) {
    const storeId = BigInt(storeIdStr);
    if (user && !['SUPER_ADMIN', 'SYSTEM_ADMIN', 'ADMIN'].includes(user.role)) {
      if (!user.storeId || BigInt(user.storeId) !== storeId) {
        throw new ForbiddenException({
          success: false,
          code: 'ACCESS_DENIED',
          message: 'Bạn không có quyền xem cảnh báo tồn kho của cửa hàng khác.',
        });
      }
    }

    const result = await this.productsRepo.findStoreInventory(storeId, {
      page: query?.page ? Number(query.page) : 1,
      pageSize: query?.pageSize ? Number(query.pageSize) : 20,
      lowStockOnly: true,
    });

    return {
      items: result.items.map((i) => InventoryResponseDto.fromEntity(i)),
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
    };
  }
}

