import { Injectable, Inject } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ProductsRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async findMany(storeId?: bigint) {
    const whereClause: any = {};
    if (storeId) {
      whereClause.storeId = storeId;
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

  async findById(productId: bigint) {
    return this.prisma.product.findUnique({
      where: { productId },
      include: {
        inventory: true,
        category: true,
      },
    });
  }

  async findStoreIdOnly(productId: bigint) {
    return this.prisma.product.findUnique({
      where: { productId },
      select: { storeId: true, basePrice: true },
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
  }) {
    const { initialStock = 0, ...productData } = data;
    return this.prisma.$transaction(async (tx) => {
      const product = await tx.product.create({
        data: productData,
      });

      // Automatically create Inventory record for product
      const inventory = await tx.inventory.create({
        data: {
          storeId: product.storeId,
          productId: product.productId,
          quantityOnHand: initialStock,
          reservedQuantity: 0,
          minStockAlert: 5,
        },
      });

      return {
        ...product,
        inventory,
      };
    });
  }

  async update(productId: bigint, data: any) {
    return this.prisma.product.update({
      where: { productId },
      data,
      include: {
        inventory: true,
        category: true,
      },
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
    storeId: bigint;
    productId: bigint;
    oldPrice: number;
    newPrice: number;
    changedByUserId?: bigint;
    reason?: string;
  }) {
    return this.prisma.productPriceHistory.create({
      data,
    });
  }
}
