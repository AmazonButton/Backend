import { Injectable, Inject } from '@nestjs/common';
import { AnalyticsRepository } from './analytics.repository';

@Injectable()
export class AnalyticsService {
  constructor(@Inject(AnalyticsRepository) private readonly analyticsRepo: AnalyticsRepository) {}

  async getDashboardAnalytics(storeId?: string | number | bigint) {
    const targetStoreId = storeId ? BigInt(storeId) : undefined;
    const { orders, buttons } = await this.analyticsRepo.getDashboardData(targetStoreId);

    // Group sales by day
    const salesByDay: Record<string, number> = {};
    orders.forEach((o) => {
      const day = new Date(o.orderDate || o.createdAt).toLocaleDateString('vi-VN', {
        month: '2-digit',
        day: '2-digit',
      });
      salesByDay[day] = (salesByDay[day] || 0) + Number(o.totalAmount);
    });

    const chartData = Object.entries(salesByDay).map(([date, revenue]) => ({
      date,
      revenue,
    }));

    return {
      totalOrders: orders.length,
      totalRevenue: orders
        .filter((o) => o.orderStatus !== 'CANCELLED' && o.orderStatus !== 'REJECTED')
        .reduce((sum, o) => sum + Number(o.totalAmount), 0),
      activeButtons: buttons.filter((d) => d.status === 'ACTIVE').length,
      chartData, // Real data only; empty array [] when no orders exist
    };
  }
}
