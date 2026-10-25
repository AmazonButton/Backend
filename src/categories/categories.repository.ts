import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class CategoriesRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findByStoreId(storeId: bigint) {
    return this.prisma.category.findMany({
      where: { storeId },
      orderBy: [{ parentCategoryId: 'asc' }, { categoryName: 'asc' }],
    });
  }

  async findById(categoryId: bigint) {
    return this.prisma.category.findUnique({
      where: { categoryId },
      include: {
        subCategories: true,
      },
    });
  }

  async findByStoreAndId(storeId: bigint, categoryId: bigint) {
    return this.prisma.category.findUnique({
      where: {
        uq_category_store_pair: {
          storeId,
          categoryId,
        },
      },
      include: {
        subCategories: true,
      },
    });
  }

  async countProductsByCategoryId(categoryId: bigint): Promise<number> {
    return this.prisma.product.count({
      where: { categoryId },
    });
  }

  async create(data: {
    storeId: bigint;
    categoryName: string;
    parentCategoryId?: bigint | null;
    status?: string;
  }) {
    return this.prisma.category.create({
      data: {
        storeId: data.storeId,
        categoryName: data.categoryName,
        parentCategoryId: data.parentCategoryId ?? null,
        status: data.status || 'ACTIVE',
      },
    });
  }

  async update(
    categoryId: bigint,
    data: {
      categoryName?: string;
      parentCategoryId?: bigint | null;
      status?: string;
    },
  ) {
    const payload: any = {};
    if (data.categoryName !== undefined) payload.categoryName = data.categoryName;
    if (data.parentCategoryId !== undefined) payload.parentCategoryId = data.parentCategoryId;
    if (data.status !== undefined) payload.status = data.status;

    return this.prisma.category.update({
      where: { categoryId },
      data: payload,
    });
  }

  async isUserStoreManagerOrOwner(userId: bigint, storeId: bigint): Promise<boolean> {
    // Check if owner
    const store = await this.prisma.store.findFirst({
      where: { storeId, ownerUserId: userId },
    });
    if (store) return true;

    // Check if staff/manager
    const staff = await this.prisma.storeStaff.findFirst({
      where: {
        storeId,
        userId,
        status: 'ACTIVE',
      },
    });
    return !!staff;
  }
}
