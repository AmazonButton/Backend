import { Injectable } from '@nestjs/common';
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
    return this.prisma.productDiscount.create({
      data: {
        productId: data.productId,
        discountPercent: data.discountPercent != null ? data.discountPercent : null,
        discountAmount: data.discountAmount != null ? data.discountAmount : null,
        startAt: data.startAt,
        endAt: data.endAt,
        status: data.status || 'ACTIVE',
      },
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
    const payload: any = {};
    if (data.discountPercent !== undefined) payload.discountPercent = data.discountPercent;
    if (data.discountAmount !== undefined) payload.discountAmount = data.discountAmount;
    if (data.startAt !== undefined) payload.startAt = data.startAt;
    if (data.endAt !== undefined) payload.endAt = data.endAt;
    if (data.status !== undefined) payload.status = data.status;

    return this.prisma.productDiscount.update({
      where: { discountId },
      data: payload,
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
    });
    return !!staff;
  }
}
