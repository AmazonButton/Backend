import { ForbiddenException, Injectable, Inject } from '@nestjs/common';
import { AnalyticsRepository } from './analytics.repository';
import { DashboardAnalyticsQueryDto } from './dto/dashboard-analytics-query.dto';

@Injectable()
export class AnalyticsService {
  constructor(@Inject(AnalyticsRepository) private readonly analyticsRepo: AnalyticsRepository) {}

  async getDashboardAnalytics(
    storeId?: string | number | bigint,
    user?: any,
    query?: DashboardAnalyticsQueryDto,
  ) {
    const isPlatformAdmin = ['SUPER_ADMIN', 'SYSTEM_ADMIN', 'ADMIN'].includes(user?.role);

    // Strict Tenant Isolation
    let targetStoreId: bigint | undefined = undefined;
    if (isPlatformAdmin) {
      const requested = query?.storeId || storeId;
      targetStoreId = requested ? BigInt(requested) : undefined;
    } else {
      if (!user?.storeId) {
        throw new ForbiddenException('Tài khoản không có quyền truy cập dữ liệu thống kê của cửa hàng');
      }
      if (query?.storeId && BigInt(query.storeId) !== BigInt(user.storeId)) {
        throw new ForbiddenException({
          success: false,
          code: 'ACCESS_DENIED',
          message: 'Bạn không có quyền truy cập thống kê của cửa hàng khác.',
        });
      }
      targetStoreId = BigInt(user.storeId);
    }

    const dateRange: { fromDate?: Date; toDate?: Date } = {};
    if (query?.fromDate) dateRange.fromDate = new Date(query.fromDate);
    if (query?.toDate) dateRange.toDate = new Date(query.toDate);

    const { orders, buttons } = await this.analyticsRepo.getDashboardData(targetStoreId, dateRange);

    const groupBy = query?.groupBy || 'day';

    const getGroupKey = (d: Date): string => {
      const year = d.getFullYear();
      const month = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');

      if (groupBy === 'month') {
        return `${year}-${month}`;
      } else if (groupBy === 'week') {
        const target = new Date(d.valueOf());
        const dayNr = (d.getDay() + 6) % 7;
        target.setDate(target.getDate() - dayNr + 3);
        const firstThursday = target.valueOf();
        target.setMonth(0, 1);
        if (target.getDay() !== 4) {
          target.setMonth(0, 1 + ((4 - target.getDay() + 7) % 7));
        }
        const weekNum = 1 + Math.ceil((firstThursday - target.valueOf()) / 604800000);
        return `${year}-W${String(weekNum).padStart(2, '0')}`;
      } else {
        return `${year}-${month}-${day}`;
      }
    };

    const revenueMap: Record<string, { revenue: number; orderCount: number }> = {};

    orders.forEach((o) => {
      const dateObj = new Date(o.orderDate || o.createdAt);
      const key = getGroupKey(dateObj);
      if (!revenueMap[key]) {
        revenueMap[key] = { revenue: 0, orderCount: 0 };
      }
      revenueMap[key].revenue += Number(o.totalAmount || 0);
      revenueMap[key].orderCount += 1;
    });

    const chartData = Object.entries(revenueMap).map(([period, data]) => ({
      period,
      date: period,
      revenue: data.revenue,
      orderCount: data.orderCount,
    }));

    return {
      storeId: targetStoreId ? targetStoreId.toString() : null,
      filter: {
        fromDate: query?.fromDate || null,
        toDate: query?.toDate || null,
        groupBy,
      },
      totalOrders: orders.length,
      totalRevenue: orders
        .filter((o) => o.orderStatus !== 'CANCELLED' && o.orderStatus !== 'REJECTED')
        .reduce((sum, o) => sum + Number(o.totalAmount || 0), 0),
      activeButtons: buttons.filter((d) => d.status === 'ACTIVE').length,
      chartData,
    };
  }
}
