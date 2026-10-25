import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { StoresRepository } from './stores.repository';
import { UpdateStoreMeDto } from './dto/update-store-me.dto';
import { StoreMeResponseDto } from './dto/store-me-response.dto';

@Injectable()
export class StoresService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storesRepo: StoresRepository,
  ) {}

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
    return StoreMeResponseDto.fromEntity(store);
  }

  async updateStoreMe(user: any, dto: UpdateStoreMeDto): Promise<StoreMeResponseDto> {
    const storeId = await this.resolveStoreId(user);
    await this.storesRepo.updateStore(storeId, dto);
    const updated = await this.storesRepo.findStoreForMe(storeId);
    return StoreMeResponseDto.fromEntity(updated);
  }

  async listActiveStores(query: { search?: string; page?: number; pageSize?: number; limit?: number }) {
    const page = Math.max(1, Number(query.page) || 1);
    const rawPageSize = query.pageSize !== undefined ? query.pageSize : query.limit;
    const pageSize = Math.max(1, Math.min(100, Number(rawPageSize) || 20));
    const skip = (page - 1) * pageSize;

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

    return {
      items: stores.map((s) => ({
        storeId: s.storeId.toString(),
        name: s.name,
        code: s.code,
        email: s.email,
        phone: s.phone,
        address: s.address,
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
