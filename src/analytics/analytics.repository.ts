import { Injectable, Inject } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AnalyticsRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async getDashboardData(storeId?: bigint) {
    const whereStore: any = storeId ? { storeId } : {};

    const [orders, buttons, products] = await Promise.all([
      this.prisma.order.findMany({
        where: whereStore,
        include: { items: true },
        orderBy: { orderDate: 'asc' },
      }),
      this.prisma.ioTButton.findMany({
        where: whereStore,
        include: { buttonProducts: { include: { product: true } } },
      }),
      this.prisma.product.findMany({
        where: whereStore,
      }),
    ]);

    return { orders, buttons, products };
  }
}
