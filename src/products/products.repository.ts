import { Injectable, Inject } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Decimal } from '@prisma/client/runtime/library';

export interface ProductImageInput {
  imageUrl: string;
  cloudinaryPublicId?: string;
  isThumbnail?: boolean;
  displayOrder?: number;
}

@Injectable()
export class ProductsRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async findMany(storeId?: bigint, pagination?: { page?: number; pageSize?: number }) {
    const whereClause: any = {};
    if (storeId) {
      whereClause.storeId = storeId;
    }
    const page = pagination?.page && pagination.page > 0 ? Number(pagination.page) : 1;
    const pageSize = pagination?.pageSize && pagination.pageSize > 0 ? Number(pagination.pageSize) : undefined;
    const skip = pageSize ? (page - 1) * pageSize : undefined;
    const take = pageSize ? pageSize : undefined;

    const [items, total] = await Promise.all([
      this.prisma.product.findMany({
        where: whereClause,
        include: {
          inventory: true,
          category: true,
          images: {
            orderBy: { displayOrder: 'asc' },
          },
        },
        orderBy: { createdAt: 'desc' },
        ...(skip !== undefined ? { skip } : {}),
        ...(take !== undefined ? { take } : {}),
      }),
      this.prisma.product.count({ where: whereClause }),
    ]);

    return { items, total, page, pageSize: pageSize || total };
  }

  async findById(productId: bigint) {
    return this.prisma.product.findUnique({
      where: { productId },
      include: {
        inventory: true,
        category: true,
        images: {
          orderBy: { displayOrder: 'asc' },
        },
      },
    });
  }

  async findStoreIdOnly(productId: bigint) {
    return this.prisma.product.findUnique({
      where: { productId },
      select: { storeId: true, basePrice: true },
    });
  }

  async findCategoryById(categoryId: bigint, storeId: bigint) {
    return this.prisma.category.findFirst({
      where: {
        categoryId,
        storeId,
      },
    });
  }

  async create(data: {
    storeId: bigint;
    productName: string;
    productCode: string;
    brand: string;
    description?: string | null;
    basePrice: number;
    status: string;
    categoryId?: bigint;
    initialStock?: number;
    images?: ProductImageInput[];
  }) {
    const { initialStock = 0, images = [], ...productData } = data;
    return this.prisma.$transaction(async (tx) => {
      const product = await tx.product.create({
        data: productData,
      });

      // Automatically create or sync Inventory record for product (safe against DB trigger)
      const inventory = await tx.inventory.upsert({
        where: {
          productId: product.productId,
        },
        update: {
          quantityOnHand: initialStock,
        },
        create: {
          storeId: product.storeId,
          productId: product.productId,
          quantityOnHand: initialStock,
          reservedQuantity: 0,
          minStockAlert: 5,
        },
      });

      // Automatically create ProductImage records if provided
      let createdImages: any[] = [];
      if (images && images.length > 0) {
        await tx.productImage.createMany({
          data: images.map((img, idx) => ({
            productId: product.productId,
            imageUrl: img.imageUrl,
            cloudinaryPublicId: img.cloudinaryPublicId || null,
            isThumbnail: img.isThumbnail !== undefined ? img.isThumbnail : idx === 0,
            displayOrder: img.displayOrder !== undefined ? img.displayOrder : idx,
          })),
        });

        createdImages = await tx.productImage.findMany({
          where: { productId: product.productId },
          orderBy: { displayOrder: 'asc' },
        });
      }

      return {
        ...product,
        inventory,
        images: createdImages,
      };
    });
  }

  async updateProductAtomicTx(params: {
    productId: bigint;
    storeId: bigint;
    data: any;
    images?: ProductImageInput[];
    priceHistory?: {
      oldPrice: number;
      newPrice: number;
      changedByUserId?: bigint;
    };
    stock?: number;
  }) {
    return this.prisma.$transaction(async (tx) => {
      // 1. Lock the product row with SELECT FOR UPDATE to prevent race conditions
      await tx.$queryRaw`
        SELECT product_id FROM product WHERE product_id = ${params.productId} FOR UPDATE
      `;

      // 2. Insert price history if price has changed
      if (params.priceHistory) {
        await tx.productPriceHistory.create({
          data: {
            productId: params.productId,
            oldPrice: new Decimal(params.priceHistory.oldPrice),
            newPrice: new Decimal(params.priceHistory.newPrice),
            ...(params.priceHistory.changedByUserId
              ? { changedByUserId: params.priceHistory.changedByUserId }
              : {}),
          },
        });
      }

      // 3. Update inventory stock atomically
      if (params.stock !== undefined && !isNaN(params.stock)) {
        await tx.inventory.upsert({
          where: { productId: params.productId },
          update: { quantityOnHand: params.stock },
          create: {
            storeId: params.storeId,
            productId: params.productId,
            quantityOnHand: params.stock,
            reservedQuantity: 0,
            minStockAlert: 5,
          },
        });
      }

      // 4. Update product entity
      const product = await tx.product.update({
        where: { productId: params.productId },
        data: params.data,
        include: {
          inventory: true,
          category: true,
        },
      });

      // 5. Update images if specified
      if (params.images !== undefined) {
        await tx.productImage.deleteMany({ where: { productId: params.productId } });
        if (params.images.length > 0) {
          await tx.productImage.createMany({
            data: params.images.map((img, idx) => ({
              productId: params.productId,
              imageUrl: img.imageUrl,
              cloudinaryPublicId: img.cloudinaryPublicId || null,
              isThumbnail: img.isThumbnail !== undefined ? img.isThumbnail : idx === 0,
              displayOrder: img.displayOrder !== undefined ? img.displayOrder : idx,
            })),
          });
        }
      }

      const currentImages = await tx.productImage.findMany({
        where: { productId: params.productId },
        orderBy: { displayOrder: 'asc' },
      });

      return {
        ...product,
        images: currentImages,
      };
    });
  }

  async update(productId: bigint, data: any, images?: ProductImageInput[]) {
    return this.updateProductAtomicTx({
      productId,
      storeId: BigInt(0),
      data,
      images,
    });
  }

  
  async findProductImages(productId: bigint) {
    return this.prisma.productImage.findMany({
      where: { productId },
      select: { imageId: true, cloudinaryPublicId: true, imageUrl: true },
    });
  }

  async countImageReferences(cloudinaryPublicId: string) {
    return this.prisma.productImage.count({
      where: { cloudinaryPublicId },
    });
  }

  async updateInventoryStock(
    productId: bigint,
    storeId: bigint,
    availableStock: number,
    lowStockThreshold?: number,
  ) {
    return this.prisma.inventory.upsert({
      where: {
        productId,
      },
      update: {
        quantityOnHand: availableStock,
        ...(lowStockThreshold !== undefined ? { minStockAlert: lowStockThreshold } : {}),
      },
      create: {
        storeId,
        productId,
        quantityOnHand: availableStock,
        reservedQuantity: 0,
        minStockAlert: lowStockThreshold || 5,
      },
    });
  }

  async recordPriceHistory(data: {
    productId: bigint;
    oldPrice: number;
    newPrice: number;
    changedByUserId?: bigint;
  }) {
    return this.prisma.productPriceHistory.create({
      data: {
        productId: data.productId,
        oldPrice: data.oldPrice,
        newPrice: data.newPrice,
        ...(data.changedByUserId ? { changedByUserId: data.changedByUserId } : {}),
      },
    });
  }

  async findStorefrontCatalog(params: { search?: string; storeId?: string; category?: string }) {
    const whereClause: any = {
      status: 'ACTIVE',
      store: {
        status: 'ACTIVE',
      },
    };

    if (params.storeId) {
      try {
        whereClause.storeId = BigInt(params.storeId);
      } catch (_) {}
    }

    if (params.category && params.category !== 'Tất cả') {
      whereClause.category = {
        categoryName: {
          equals: params.category,
          mode: 'insensitive',
        },
      };
    }

    if (params.search && params.search.trim().length > 0) {
      const words = params.search.trim().split(/\s+/).filter(Boolean);
      whereClause.AND = words.map((w) => ({
        OR: [
          { productName: { contains: w, mode: 'insensitive' } },
          { brand: { contains: w, mode: 'insensitive' } },
          { description: { contains: w, mode: 'insensitive' } },
          { productCode: { contains: w, mode: 'insensitive' } },
        ],
      }));
    }

    return this.prisma.product.findMany({
      where: whereClause,
      include: {
        store: {
          select: {
            storeId: true,
            name: true,
            code: true,
            address: true,
            phone: true,
          },
        },
        category: true,
        inventory: true,
        images: {
          orderBy: { displayOrder: 'asc' },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  async hasActiveOrders(productId: bigint): Promise<boolean> {
    const activeItem = await this.prisma.orderItem.findFirst({
      where: {
        productId,
        order: {
          orderStatus: {
            in: ['PENDING', 'CONFIRMED', 'PREPARING', 'PROCESSING', 'READY_FOR_DELIVERY', 'SHIPPING'],
          },
        },
      },
    });
    return !!activeItem;
  }

  async findPriceHistory(productId: bigint, pagination?: { page?: number; pageSize?: number }) {
    const page = pagination?.page && pagination.page > 0 ? Number(pagination.page) : 1;
    const pageSize = pagination?.pageSize && pagination.pageSize > 0 ? Math.min(100, Number(pagination.pageSize)) : 20;
    const skip = (page - 1) * pageSize;

    const [items, total] = await Promise.all([
      this.prisma.productPriceHistory.findMany({
        where: { productId },
        include: {
          changedByUser: {
            select: {
              userId: true,
              fullName: true,
              email: true,
            },
          },
        },
        orderBy: { changedAt: 'desc' },
        skip,
        take: pageSize,
      }),
      this.prisma.productPriceHistory.count({ where: { productId } }),
    ]);

    return { items, total, page, pageSize };
  }

  async findStoreInventory(
    storeId: bigint,
    options?: { page?: number; pageSize?: number; lowStockOnly?: boolean },
  ) {
    const page = options?.page && options.page > 0 ? Number(options.page) : 1;
    const pageSize = options?.pageSize && options.pageSize > 0 ? Math.min(100, Number(options.pageSize)) : 20;
    const skip = (page - 1) * pageSize;

    if (options?.lowStockOnly) {
      const totalRes: any[] = await this.prisma.$queryRaw`
        SELECT COUNT(*)::int as total
        FROM inventory
        WHERE store_id = ${storeId}
          AND quantity_on_hand <= min_stock_alert
      `;
      const total = Number(totalRes[0]?.total || 0);

      const items: any[] = await this.prisma.$queryRaw`
        SELECT 
          i.inventory_id as "inventoryId",
          i.store_id as "storeId",
          i.product_id as "productId",
          p.product_name as "productName",
          p.product_code as "productCode",
          i.quantity_on_hand as "quantityOnHand",
          i.reserved_quantity as "reservedQuantity",
          i.min_stock_alert as "minStockAlert",
          i.updated_at as "updatedAt"
        FROM inventory i
        JOIN product p ON p.product_id = i.product_id
        WHERE i.store_id = ${storeId}
          AND i.quantity_on_hand <= i.min_stock_alert
        ORDER BY i.quantity_on_hand ASC, i.updated_at DESC
        LIMIT ${pageSize} OFFSET ${skip}
      `;

      return { items, total, page, pageSize };
    }

    const where = { storeId };
    const [rawItems, total] = await Promise.all([
      this.prisma.inventory.findMany({
        where,
        include: {
          product: {
            select: {
              productId: true,
              productName: true,
              productCode: true,
            },
          },
        },
        orderBy: { updatedAt: 'desc' },
        skip,
        take: pageSize,
      }),
      this.prisma.inventory.count({ where }),
    ]);

    const items = rawItems.map((inv) => ({
      inventoryId: inv.inventoryId,
      storeId: inv.storeId,
      productId: inv.productId,
      productName: inv.product?.productName || '',
      productCode: inv.product?.productCode || '',
      quantityOnHand: inv.quantityOnHand,
      reservedQuantity: inv.reservedQuantity,
      minStockAlert: inv.minStockAlert,
      updatedAt: inv.updatedAt,
    }));

    return { items, total, page, pageSize };
  }
}

