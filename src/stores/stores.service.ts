import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class StoresService {
  constructor(private readonly prisma: PrismaService) {}

  async listActiveStores(query: { search?: string; page?: number; limit?: number }) {
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.max(1, Math.min(100, Number(query.limit) || 20));
    const skip = (page - 1) * limit;

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
        take: limit,
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
      limit,
      totalPages: Math.ceil(total / limit),
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
