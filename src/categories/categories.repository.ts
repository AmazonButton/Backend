import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
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

  /**
   * Atomically verify category hierarchy invariants under store-scoped row locks (FOR UPDATE)
   * and update the category in a single transaction to prevent concurrent cycle creation.
   */
  async updateWithCycleCheckAtomicTx(params: {
    storeId: bigint;
    categoryId: bigint;
    data: {
      categoryName?: string;
      parentCategoryId?: bigint | null;
      status?: string;
    };
  }) {
    return this.prisma.$transaction(async (tx) => {
      const storeCategories = await tx.$queryRaw<
        Array<{ category_id: bigint; parent_category_id: bigint | null }>
      >`
        SELECT category_id, parent_category_id
        FROM category
        WHERE store_id = ${params.storeId}
        ORDER BY category_id ASC
        FOR UPDATE;
      `;

      const parentById = new Map<string, bigint | null>();
      for (const row of storeCategories) {
        parentById.set(
          BigInt(row.category_id).toString(),
          row.parent_category_id != null ? BigInt(row.parent_category_id) : null,
        );
      }

      if (!parentById.has(params.categoryId.toString())) {
        throw new NotFoundException('Không tìm thấy danh mục');
      }

      if (params.data.parentCategoryId !== undefined && params.data.parentCategoryId !== null) {
        if (params.categoryId === params.data.parentCategoryId) {
          throw new BadRequestException('Một danh mục không thể làm cha của chính nó');
        }

        let currentParentId: bigint | null = params.data.parentCategoryId;
        const visited = new Set<string>([params.categoryId.toString()]);

        while (currentParentId) {
          const parentStr = currentParentId.toString();
          if (visited.has(parentStr)) {
            throw new BadRequestException('Phát hiện vòng lặp phân cấp danh mục (cycle detected)');
          }
          if (!parentById.has(parentStr)) {
            throw new BadRequestException('Danh mục cha không tồn tại trong cửa hàng này');
          }
          visited.add(parentStr);
          currentParentId = parentById.get(parentStr) ?? null;
        }
      }

      const payload: any = {};
      if (params.data.categoryName !== undefined) payload.categoryName = params.data.categoryName;
      if (params.data.parentCategoryId !== undefined) payload.parentCategoryId = params.data.parentCategoryId;
      if (params.data.status !== undefined) payload.status = params.data.status;

      return tx.category.update({
        where: { categoryId: params.categoryId },
        data: payload,
      });
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
      include: {
        role: true,
      },
    });
    if (!staff) return false;
    return ['STORE_OWNER', 'STORE_MANAGER', 'ADMIN', 'SYSTEM_ADMIN', 'SUPER_ADMIN'].includes(staff.role?.roleCode);
  }
}
