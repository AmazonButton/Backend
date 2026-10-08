import { Injectable, Inject } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface ProductImageInput {
  imageUrl: string;
  isThumbnail?: boolean;
  displayOrder?: number;
}

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
        images: {
          orderBy: { displayOrder: 'asc' },
        },
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

      // Automatically create ProductImage records if provided
      let createdImages: any[] = [];
      if (images && images.length > 0) {
        await tx.productImage.createMany({
          data: images.map((img, idx) => ({
            productId: product.productId,
            imageUrl: img.imageUrl,
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

  async update(productId: bigint, data: any, images?: ProductImageInput[]) {
    return this.prisma.$transaction(async (tx) => {
      const product = await tx.product.update({
        where: { productId },
        data,
        include: {
          inventory: true,
          category: true,
        },
      });

      if (images && images.length > 0) {
        // Clear previous images and insert updated list
        await tx.productImage.deleteMany({ where: { productId } });
        await tx.productImage.createMany({
          data: images.map((img, idx) => ({
            productId,
            imageUrl: img.imageUrl,
            isThumbnail: img.isThumbnail !== undefined ? img.isThumbnail : idx === 0,
            displayOrder: img.displayOrder !== undefined ? img.displayOrder : idx,
          })),
        });
      }

      const currentImages = await tx.productImage.findMany({
        where: { productId },
        orderBy: { displayOrder: 'asc' },
      });

      return {
        ...product,
        images: currentImages,
      };
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
