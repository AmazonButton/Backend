import { Injectable, NotFoundException, ForbiddenException, BadRequestException, InternalServerErrorException, Optional, Inject } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { StoresRepository } from './stores.repository';
import { UpdateStoreMeDto } from './dto/update-store-me.dto';
import { StoreMeResponseDto } from './dto/store-me-response.dto';
import { DashboardCacheService } from '../common/cache/dashboard-cache.service';
import { MediaService } from '../media/media.service';

@Injectable()
export class StoresService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storesRepo: StoresRepository,
    @Optional() private readonly cacheService?: DashboardCacheService,
    @Optional() @Inject(MediaService) private readonly mediaService?: MediaService,
  ) {}

  private async invalidateStoreCaches(storeId: bigint): Promise<void> {
    if (!this.cacheService) return;
    try {
      await Promise.all([
        this.cacheService.invalidateKey('stores:active_page1_20'),
        this.cacheService.invalidatePrefix?.('stores:') ?? Promise.resolve(),
        this.cacheService.invalidatePrefix?.(`dash:store:${storeId.toString()}:`) ?? Promise.resolve(),
        this.cacheService.invalidatePrefix?.('admin:stores-leaderboard:') ?? Promise.resolve(),
        this.cacheService.invalidatePrefix?.('admin:dashboard:') ?? Promise.resolve(),
      ]);
    } catch {
      // Best effort cache invalidation
    }
  }

  async resolveStoreId(user: any): Promise<bigint> {
    if (user?.storeId) {
      return BigInt(user.storeId);
    }
    if (user?.userId || user?.id) {
      const userId = BigInt(user.userId || user.id);
      const store = await this.storesRepo.findStoreByOwnerUserId(userId);
      if (store) {
        return store.storeId;
      }
    }
    throw new ForbiddenException('Tài khoản không thuộc hoặc sở hữu cửa hàng nào');
  }

  async getStoreMe(user: any): Promise<StoreMeResponseDto> {
    const storeId = await this.resolveStoreId(user);
    const store = await this.storesRepo.findStoreForMe(storeId);
    if (!store) {
      throw new NotFoundException('Cửa hàng không tồn tại');
    }
    return StoreMeResponseDto.fromEntity(store, user?.role);
  }

  async updateStoreMe(user: any, dto: UpdateStoreMeDto): Promise<StoreMeResponseDto> {
    const storeId = await this.resolveStoreId(user);
    const current = dto.logoUrl !== undefined ? await this.storesRepo.findStoreForMe(storeId) : null;
    const previousLogoPublicId = current?.logoPublicId || null;

    let nextLogoUrl = dto.logoUrl;
    let nextLogoPublicId: string | null | undefined = undefined;
    if (dto.logoUrl !== undefined) {
      if (dto.logoUrl === null) {
        nextLogoUrl = null;
        nextLogoPublicId = null;
      } else {
        const trimmedUrl = dto.logoUrl.trim();
        nextLogoUrl = trimmedUrl;
        if (trimmedUrl !== current?.logoUrl) {
          nextLogoPublicId = null;
        }
      }
    }

    await this.storesRepo.updateStore(storeId, {
      ...dto,
      logoUrl: nextLogoUrl,
      logoPublicId: nextLogoPublicId,
    });
    if (nextLogoPublicId === null && previousLogoPublicId) {
      await this.mediaService?.deleteAssetBestEffort(previousLogoPublicId);
    }
    const updated = await this.storesRepo.findStoreForMe(storeId);
    await this.invalidateStoreCaches(storeId);
    return StoreMeResponseDto.fromEntity(updated, user?.role);
  }

  /**
   * Upload and persist a store logo image directly to Cloudinary and PostgreSQL.
   */
  async uploadStoreLogo(user: any, file: Express.Multer.File): Promise<StoreMeResponseDto> {
    if (!file || !file.buffer) {
      throw new BadRequestException('Vui lòng chọn tệp logo hợp lệ (JPG, PNG, WEBP, tối đa 3MB)');
    }
    if (!this.mediaService) {
      throw new InternalServerErrorException('Dịch vụ lưu trữ ảnh chưa được khởi tạo');
    }

    const storeId = await this.resolveStoreId(user);
    const existingStore = await this.storesRepo.findStoreForMe(storeId);
    if (!existingStore) {
      throw new NotFoundException('Cửa hàng không tồn tại');
    }

    const previousLogoPublicId = existingStore.logoPublicId || null;
    const uploadResult = await this.mediaService.uploadImageBuffer(
      file,
      `stores/${storeId.toString()}/logo`,
      {
        maxBytes: 3 * 1024 * 1024,
        allowedMimes: ['image/jpeg', 'image/png', 'image/webp'],
        publicIdPrefix: `store_${storeId.toString()}`,
      },
    );

    try {
      await this.storesRepo.updateStore(storeId, {
        logoUrl: uploadResult.secureUrl,
        logoPublicId: uploadResult.publicId,
      });
    } catch (err) {
      await this.mediaService.deleteAssetBestEffort(uploadResult.publicId);
      throw err;
    }

    if (previousLogoPublicId && previousLogoPublicId !== uploadResult.publicId) {
      await this.mediaService.deleteAssetBestEffort(previousLogoPublicId);
    }

    const updated = await this.storesRepo.findStoreForMe(storeId);
    await this.invalidateStoreCaches(storeId);
    return StoreMeResponseDto.fromEntity(updated, user?.role);
  }

  /**
   * Remove store logo URL and clean up old Cloudinary asset best-effort.
   */
  async removeStoreLogo(user: any): Promise<StoreMeResponseDto> {
    const storeId = await this.resolveStoreId(user);
    const existingStore = await this.storesRepo.findStoreForMe(storeId);
    if (!existingStore) {
      throw new NotFoundException('Cửa hàng không tồn tại');
    }

    const previousLogoPublicId = existingStore.logoPublicId || null;
    await this.storesRepo.updateStore(storeId, {
      logoUrl: null,
      logoPublicId: null,
    });

    if (previousLogoPublicId) {
      await this.mediaService?.deleteAssetBestEffort(previousLogoPublicId);
    }

    const updated = await this.storesRepo.findStoreForMe(storeId);
    await this.invalidateStoreCaches(storeId);
    return StoreMeResponseDto.fromEntity(updated, user?.role);
  }

  async listActiveStores(query: { search?: string; page?: number; pageSize?: number; limit?: number }) {
    const page = Math.max(1, Number(query.page) || 1);
    const rawPageSize = query.pageSize !== undefined ? query.pageSize : query.limit;
    const pageSize = Math.max(1, Math.min(100, Number(rawPageSize) || 20));
    const skip = (page - 1) * pageSize;

    const isDefaultQuery = !query.search && page === 1 && pageSize === 20;
    const cacheKey = 'stores:active_page1_20';

    if (isDefaultQuery && this.cacheService) {
      try {
        const cached = await this.cacheService.get(cacheKey);
        if (cached) return cached;
      } catch {
        // Fallback to database
      }
    }

    const where: any = {
      status: 'ACTIVE',
    };

    if (query.search) {
      where.OR = [
        { name: { contains: query.search, mode: 'insensitive' } },
        { code: { contains: query.search, mode: 'insensitive' } },
        { address: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const [total, stores] = await Promise.all([
      this.prisma.store.count({ where }),
      this.prisma.store.findMany({
        where,
        skip,
        take: pageSize,
        orderBy: { createdAt: 'desc' },
        include: {
          _count: {
            select: { products: true },
          },
        },
      }),
    ]);

    const result = {
      items: stores.map((s) => ({
        storeId: s.storeId.toString(),
        name: s.name,
        code: s.code,
        email: s.email,
        phone: s.phone,
        address: s.address,
        logoUrl: s.logoUrl || null,
        latitude: s.latitude != null ? Number(s.latitude) : null,
        longitude: s.longitude != null ? Number(s.longitude) : null,
        commissionRate: s.commissionRate ? Number(s.commissionRate) : 8.0,
        status: s.status,
        productCount: s._count.products,
        createdAt: s.createdAt,
      })),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };

    if (isDefaultQuery && this.cacheService) {
      try {
        await this.cacheService.set(cacheKey, result, 30); // 30s TTL
      } catch {
        // Best effort
      }
    }

    return result;
  }

  async getStoreById(id: string | number | bigint) {
    if (typeof id === 'string' && !/^\d+$/.test(id)) {
      throw new NotFoundException('Cửa hàng không tồn tại hoặc đã ngừng hoạt động');
    }
    const rawId = BigInt(id);
    const store = await this.prisma.store.findFirst({
      where: {
        storeId: rawId,
        status: 'ACTIVE',
      },
      include: {
        categories: {
          where: { status: 'ACTIVE' },
          select: {
            categoryId: true,
            categoryName: true,
            status: true,
          },
        },
        products: {
          where: { status: 'ACTIVE' },
          include: {
            inventory: true,
            images: {
              orderBy: { displayOrder: 'asc' },
            },
          },
        },
      },
    });

    if (!store) {
      throw new NotFoundException('Cửa hàng không tồn tại hoặc đã ngừng hoạt động');
    }

    return {
      storeId: store.storeId.toString(),
      name: store.name,
      code: store.code,
      email: store.email,
      phone: store.phone,
      address: store.address,
      logoUrl: store.logoUrl || null,
      commissionRate: store.commissionRate ? Number(store.commissionRate) : 8.0,
      status: store.status,
      createdAt: store.createdAt,
      categories: store.categories.map((c) => ({
        categoryId: c.categoryId.toString(),
        name: c.categoryName,
        status: c.status,
      })),
      products: store.products.map((p) => {
        const onHand = p.inventory?.quantityOnHand || 0;
        const reserved = p.inventory?.reservedQuantity || 0;
        return {
          productId: p.productId.toString(),
          categoryId: p.categoryId ? p.categoryId.toString() : null,
          productCode: p.productCode,
          name: p.productName,
          brand: p.brand,
          description: p.description,
          basePrice: Number(p.basePrice),
          quantityOnHand: onHand,
          reservedQuantity: reserved,
          availableQuantity: Math.max(0, onHand - reserved),
          status: p.status,
          thumbnailUrl: (p.images?.find((img) => img.isThumbnail) || p.images?.[0])?.imageUrl || null,
          images: p.images?.map((img) => ({
            imageId: img.imageId.toString(),
            imageUrl: img.imageUrl,
            isThumbnail: img.isThumbnail,
            displayOrder: img.displayOrder,
          })) || [],
        };
      }),
    };
  }
}
