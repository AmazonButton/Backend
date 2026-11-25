import { Injectable, Inject, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Decimal } from '@prisma/client/runtime/library';
import { runWithTransactionRetry } from '../common/utils/transaction-retry.util';
import {
  buildActiveStoreSubscriptionPrismaFilter,
  hasStoreActiveSubscription,
} from '../common/utils/store-subscription-policy.util';

export interface ProductImageInput {
  imageUrl: string;
  cloudinaryPublicId?: string;
  isThumbnail?: boolean;
  displayOrder?: number;
}

@Injectable()
export class ProductsRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async findMany(
    storeId?: bigint,
    options?: { page?: number; pageSize?: number; search?: string; category?: string; onlyActivePublic?: boolean },
  ) {
    const whereClause: any = {};
    if (storeId) {
      whereClause.storeId = storeId;
    }
    if (options?.onlyActivePublic) {
      whereClause.status = 'ACTIVE';
      whereClause.store = {
        status: 'ACTIVE',
        ...buildActiveStoreSubscriptionPrismaFilter(),
      };
    }
    if (options?.category?.trim()) {
      whereClause.category = {
        categoryName: { contains: options.category.trim(), mode: 'insensitive' },
      };
    }
    if (options?.search?.trim()) {
      const s = options.search.trim();
      whereClause.OR = [
        { productName: { contains: s, mode: 'insensitive' } },
        { productCode: { contains: s, mode: 'insensitive' } },
        { description: { contains: s, mode: 'insensitive' } },
      ];
    }

    const rawPage = Number(options?.page);
    const rawPageSize = Number(options?.pageSize);
    const page = Number.isSafeInteger(rawPage) && rawPage >= 1 ? Math.min(500, rawPage) : 1;
    const pageSize = Number.isSafeInteger(rawPageSize) && rawPageSize >= 1 ? Math.min(100, rawPageSize) : 20;
    const skip = (page - 1) * pageSize;
    const take = pageSize;

    const includeClause: any = {
      inventory: true,
      category: true,
      images: {
        orderBy: { displayOrder: 'asc' },
      },
    };
    if (options?.onlyActivePublic) {
      includeClause.store = {
        select: {
          storeId: true,
          name: true,
          code: true,
        },
      };
    }

    const [items, total] = await Promise.all([
      this.prisma.product.findMany({
        where: whereClause,
        include: includeClause,
        orderBy: [{ createdAt: 'desc' }, { productId: 'desc' }],
        skip,
        take,
      }),
      this.prisma.product.count({ where: whereClause }),
    ]);

    return { items, total, page, pageSize };
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
      select: { storeId: true, basePrice: true, status: true },
    });
  }

  async findStorePublicEligibility(storeId: bigint): Promise<boolean> {
    const store = await this.prisma.store.findUnique({
      where: { storeId },
      select: { storeId: true, status: true },
    });
    if (!store || store.status !== 'ACTIVE') {
      return false;
    }
    return hasStoreActiveSubscription(this.prisma, storeId);
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
      oldPrice?: number;
      newPrice: number;
      changedByUserId?: bigint;
    };
    stock?: number;
  }) {
    return runWithTransactionRetry(async () => {
      return this.prisma.$transaction(async (tx) => {
        // 1. Lock the product row with SELECT FOR UPDATE and read current committed base_price
        const lockedRows = await tx.$queryRaw<Array<{ product_id: bigint; base_price: any }>>`
          SELECT product_id, base_price FROM product WHERE product_id = ${params.productId} FOR UPDATE
        `;
        if (!lockedRows || lockedRows.length === 0) {
          throw new NotFoundException(`Product #${params.productId} không tồn tại`);
        }
        const currentLockedBasePrice = new Decimal(lockedRows[0].base_price);

        // 2. Insert price history using the freshly locked base_price
        if (params.priceHistory) {
          await tx.productPriceHistory.create({
            data: {
              productId: params.productId,
              oldPrice: currentLockedBasePrice,
              newPrice: new Decimal(params.priceHistory.newPrice),
              ...(params.priceHistory.changedByUserId
                ? { changedByUserId: params.priceHistory.changedByUserId }
                : {}),
            },
          });
        }

      // 3. Update inventory stock atomically under explicit inventory FOR UPDATE lock
      if (params.stock !== undefined && !isNaN(params.stock)) {
        if (!Number.isInteger(params.stock) || params.stock < 0) {
          throw new BadRequestException('Số lượng tồn kho phải là số nguyên không âm');
        }
        await tx.$executeRawUnsafe(
          `INSERT INTO inventory (store_id, product_id, quantity_on_hand, reserved_quantity, min_stock_alert, updated_at)
           VALUES ($1, $2, 0, 0, 5, NOW())
           ON CONFLICT (product_id) DO NOTHING`,
          params.storeId,
          params.productId,
        );
        const lockedInvRows = await tx.$queryRawUnsafe<
          Array<{ inventory_id: bigint; quantity_on_hand: number; reserved_quantity: number }>
        >(
          `SELECT inventory_id, quantity_on_hand, reserved_quantity
           FROM inventory
           WHERE product_id = $1
           FOR UPDATE`,
          params.productId,
        );
        const existingInv = lockedInvRows && lockedInvRows[0];
        if (existingInv && params.stock < Number(existingInv.reserved_quantity)) {
          throw new BadRequestException(
            `Không thể cập nhật tổng tồn kho (${params.stock}) nhỏ hơn số lượng đang được giữ chỗ cho đơn hàng đang xử lý (${existingInv.reserved_quantity})`,
          );
        }
        await tx.$executeRawUnsafe(
          `UPDATE inventory
           SET quantity_on_hand = $1,
               updated_at = NOW()
           WHERE product_id = $2`,
          params.stock,
          params.productId,
        );
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
    if (!Number.isInteger(availableStock) || availableStock < 0) {
      throw new BadRequestException('Số lượng tồn kho phải là số nguyên không âm');
    }

    return runWithTransactionRetry(
      () =>
        this.prisma.$transaction(async (tx) => {
          // Canonical lock order matching OrdersRepository.createStorefrontOrderTx & updateProductAtomicTx:
          // product FOR UPDATE -> inventory FOR UPDATE
          const lockedProdRows = await tx.$queryRawUnsafe<
            Array<{ product_id: bigint; store_id: bigint }>
          >(
            `SELECT product_id, store_id
             FROM product
             WHERE product_id = $1
             FOR UPDATE`,
            productId,
          );
          if (!lockedProdRows || lockedProdRows.length === 0) {
            throw new BadRequestException('Sản phẩm không tồn tại');
          }
          if (BigInt(lockedProdRows[0].store_id) !== storeId) {
            throw new ForbiddenException({
              success: false,
              code: 'ACCESS_DENIED',
              message: 'Bạn không có quyền cập nhật tồn kho của cửa hàng khác.',
            });
          }

          await tx.$executeRawUnsafe(
            `INSERT INTO inventory (store_id, product_id, quantity_on_hand, reserved_quantity, min_stock_alert, updated_at)
             VALUES ($1, $2, 0, 0, $3, NOW())
             ON CONFLICT (product_id) DO NOTHING`,
            storeId,
            productId,
            lowStockThreshold ?? 5,
          );

          const lockedInvRows = await tx.$queryRawUnsafe<
            Array<{ inventory_id: bigint; quantity_on_hand: number; reserved_quantity: number; min_stock_alert: number }>
          >(
            `SELECT inventory_id, quantity_on_hand, reserved_quantity, min_stock_alert
             FROM inventory
             WHERE product_id = $1
             FOR UPDATE`,
            productId,
          );
          const lockedInv = lockedInvRows?.[0];
          const reservedQty = Number(lockedInv?.reserved_quantity || 0);
          if (availableStock < reservedQty) {
            throw new BadRequestException(
              `Không thể cập nhật tổng tồn kho (${availableStock}) nhỏ hơn số lượng đang được giữ chỗ cho đơn hàng đang xử lý (${reservedQty})`,
            );
          }

          return tx.inventory.update({
            where: { productId },
            data: {
              quantityOnHand: availableStock,
              ...(lowStockThreshold !== undefined ? { minStockAlert: lowStockThreshold } : {}),
            },
          });
        }),
      { operationName: 'updateInventoryStock' },
    );
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
        ...buildActiveStoreSubscriptionPrismaFilter(),
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
            in: ['PENDING', 'CONFIRMED', 'PREPARING', 'PROCESSING', 'READY_FOR_DELIVERY', 'SHIPPING', 'DELIVERED'],
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

