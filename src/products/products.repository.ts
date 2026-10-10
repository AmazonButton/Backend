import { Injectable, Inject } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

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
            cloudinaryPublicId: img.cloudinaryPublicId || null,
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
