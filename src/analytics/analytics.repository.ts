import { Injectable, Inject } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AnalyticsRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async getDashboardData(storeId?: bigint, dateRange?: { fromDate?: Date; toDate?: Date }) {
    const whereStore: any = storeId ? { storeId } : {};

    if (dateRange?.fromDate || dateRange?.toDate) {
      whereStore.orderDate = {};
      if (dateRange.fromDate) whereStore.orderDate.gte = dateRange.fromDate;
      if (dateRange.toDate) whereStore.orderDate.lte = dateRange.toDate;
    }

    const [orders, buttons, products] = await Promise.all([
      this.prisma.order.findMany({
        where: whereStore,
        include: { items: true },
        orderBy: { orderDate: 'asc' },
      }),
      this.prisma.ioTButton.findMany({
        where: storeId ? { storeId } : {},
        include: { buttonProducts: { include: { product: true } } },
      }),
      this.prisma.product.findMany({
        where: storeId ? { storeId } : {},
      }),
    ]);

    return { orders, buttons, products };
  }
}
