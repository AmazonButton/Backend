import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ProductDiscountsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findProductById(productId: bigint) {
    return this.prisma.product.findUnique({
      where: { productId },
    });
  }

  async findByProductId(productId: bigint) {
    return this.prisma.productDiscount.findMany({
      where: { productId },
      orderBy: [{ startAt: 'desc' }],
    });
  }

  async findById(discountId: bigint) {
    return this.prisma.productDiscount.findUnique({
      where: { discountId },
      include: {
        product: true,
      },
    });
  }

  async countActiveOverlapping(
    productId: bigint,
    startAt: Date,
    endAt: Date,
    excludeDiscountId?: bigint,
  ): Promise<number> {
    const whereClause: any = {
      productId,
      status: 'ACTIVE',
      startAt: { lt: endAt },
      endAt: { gt: startAt },
    };

    if (excludeDiscountId) {
      whereClause.discountId = { not: excludeDiscountId };
    }

    return this.prisma.productDiscount.count({
      where: whereClause,
    });
  }

  async create(data: {
    productId: bigint;
    discountPercent?: number | null;
    discountAmount?: number | null;
    startAt: Date;
    endAt: Date;
    status?: string;
  }) {
    return this.prisma.$transaction(async (tx) => {
      // Row-lock product to serialize concurrent discount creations
      await tx.$queryRaw`SELECT product_id FROM product WHERE product_id = ${data.productId} FOR UPDATE`;

      if ((data.status || 'ACTIVE') === 'ACTIVE') {
        const overlapCount = await tx.productDiscount.count({
          where: {
            productId: data.productId,
            status: 'ACTIVE',
            startAt: { lt: data.endAt },
            endAt: { gt: data.startAt },
          },
        });
        if (overlapCount > 0) {
          throw new BadRequestException('Khoảng thời gian giảm giá bị trùng lặp với một chương trình giảm giá đang hoạt động khác của sản phẩm này');
        }
      }

      return tx.productDiscount.create({
        data: {
          productId: data.productId,
          discountPercent: data.discountPercent != null ? data.discountPercent : null,
          discountAmount: data.discountAmount != null ? data.discountAmount : null,
          startAt: data.startAt,
          endAt: data.endAt,
          status: data.status || 'ACTIVE',
        },
      });
    });
  }

  async update(
    discountId: bigint,
    data: {
      discountPercent?: number | null;
      discountAmount?: number | null;
      startAt?: Date;
      endAt?: Date;
      status?: string;
    },
  ) {
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.productDiscount.findUnique({
        where: { discountId },
      });
      if (!current) {
        throw new NotFoundException('Không tìm thấy chương trình giảm giá');
      }

      // Row-lock product to serialize concurrent updates
      await tx.$queryRaw`SELECT product_id FROM product WHERE product_id = ${current.productId} FOR UPDATE`;

      const start = data.startAt || current.startAt;
      const end = data.endAt || current.endAt;
      const status = data.status || current.status;

      if (status === 'ACTIVE') {
        const overlapCount = await tx.productDiscount.count({
          where: {
            productId: current.productId,
            status: 'ACTIVE',
            startAt: { lt: end },
            endAt: { gt: start },
            discountId: { not: discountId },
          },
        });

        if (overlapCount > 0) {
          throw new BadRequestException('Khoảng thời gian giảm giá bị trùng lặp với một chương trình giảm giá đang hoạt động khác của sản phẩm này');
        }
      }

      return tx.productDiscount.update({
        where: { discountId },
        data: {
          ...(data.discountPercent !== undefined ? { discountPercent: data.discountPercent } : {}),
          ...(data.discountAmount !== undefined ? { discountAmount: data.discountAmount } : {}),
          ...(data.startAt ? { startAt: data.startAt } : {}),
          ...(data.endAt ? { endAt: data.endAt } : {}),
          ...(data.status ? { status: data.status } : {}),
        },
      });
    });
  }

  async delete(discountId: bigint) {
    return this.prisma.productDiscount.delete({
      where: { discountId },
    });
  }

  async isUserStoreManagerOrOwner(userId: bigint, storeId: bigint): Promise<boolean> {
    const store = await this.prisma.store.findFirst({
      where: { storeId, ownerUserId: userId },
    });
    if (store) return true;

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
