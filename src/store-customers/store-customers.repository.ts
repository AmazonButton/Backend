import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class StoreCustomersRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findCustomerProfileByUserId(userId: bigint) {
    return this.prisma.customerProfile.findUnique({
      where: { userId },
    });
  }

  async findStoreCustomers(
    storeId: bigint,
    options?: { page?: number; pageSize?: number; search?: string; status?: string },
  ) {
    const page = Math.max(1, Number(options?.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(options?.pageSize) || 20));
    const skip = (page - 1) * pageSize;

    const where: any = { storeId };
    if (options?.status) {
      where.status = options.status;
    }
    if (options?.search) {
      where.customer = {
        user: {
          OR: [
            { fullName: { contains: options.search, mode: 'insensitive' } },
            { email: { contains: options.search, mode: 'insensitive' } },
            { phone: { contains: options.search, mode: 'insensitive' } },
          ],
        },
      };
    }

    const [items, total] = await Promise.all([
      this.prisma.storeCustomer.findMany({
        where,
        include: {
          customer: {
            include: {
              user: {
                select: {
                  userId: true,
                  fullName: true,
                  email: true,
                  phone: true,
                  avatarUrl: true,
                },
              },
            },
          },
        },
        orderBy: { joinedAt: 'desc' },
        skip,
        take: pageSize,
      }),
      this.prisma.storeCustomer.count({ where }),
    ]);

    return { items, total, page, pageSize };
  }

  async findStoreCustomer(storeId: bigint, customerId: bigint) {
    return this.prisma.storeCustomer.findUnique({
      where: {
        uq_store_customer: { storeId, customerId },
      },
      include: {
        customer: {
          include: {
            user: {
              select: {
                userId: true,
                fullName: true,
                email: true,
                phone: true,
                avatarUrl: true,
              },
            },
          },
        },
      },
    });
  }

  async upsertStoreCustomerStatus(storeId: bigint, customerId: bigint, status: string) {
    return this.prisma.storeCustomer.upsert({
      where: {
        uq_store_customer: { storeId, customerId },
      },
      update: { status },
      create: {
        storeId,
        customerId,
        status,
        joinedAt: new Date(),
      },
      include: {
        customer: {
          include: {
            user: {
              select: {
                userId: true,
                fullName: true,
                email: true,
                phone: true,
                avatarUrl: true,
              },
            },
          },
        },
      },
    });
  }

  async getCustomerStoreStats(storeId: bigint, customerId: bigint) {
    const orders = await this.prisma.order.findMany({
      where: {
        storeId,
        customerId,
        orderStatus: { in: ['COMPLETED', 'DELIVERED'] },
      },
      select: { totalAmount: true },
    });

    const totalOrders = orders.length;
    const totalSpent = orders.reduce((sum, o) => sum + Number(o.totalAmount || 0), 0);

    return { totalOrders, totalSpent };
  }

  async findCustomerStores(customerId: bigint, options?: { page?: number; pageSize?: number }) {
    const page = Math.max(1, Number(options?.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(options?.pageSize) || 20));
    const skip = (page - 1) * pageSize;

    const where = { customerId };

    const [items, total] = await Promise.all([
      this.prisma.storeCustomer.findMany({
        where,
        include: {
          store: true,
        },
        orderBy: { joinedAt: 'desc' },
        skip,
        take: pageSize,
      }),
      this.prisma.storeCustomer.count({ where }),
    ]);

    return { items, total, page, pageSize };
  }
}
