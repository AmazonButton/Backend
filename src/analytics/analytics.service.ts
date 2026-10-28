import { ForbiddenException, Injectable, Inject, Optional } from '@nestjs/common';
import { AnalyticsRepository } from './analytics.repository';
import { DashboardAnalyticsQueryDto } from './dto/dashboard-analytics-query.dto';
import { buildAnalyticsDateRange } from './utils/analytics-date-range.util';
import { DashboardCacheService } from '../common/cache/dashboard-cache.service';

@Injectable()
export class AnalyticsService {
  constructor(
    @Inject(AnalyticsRepository) private readonly analyticsRepo: AnalyticsRepository,
    @Optional() @Inject(DashboardCacheService) private readonly cacheService?: DashboardCacheService,
  ) {}

  private resolveStoreId(user: any, requestedStoreId?: string | number | bigint): bigint {
    const isPlatformAdmin = ['SUPER_ADMIN', 'SYSTEM_ADMIN', 'ADMIN'].includes(user?.role);
    if (isPlatformAdmin) {
      if (!requestedStoreId && !user?.storeId) {
        throw new ForbiddenException('Vui lòng chỉ định storeId để xem phân tích dữ liệu cửa hàng');
      }
      return BigInt(requestedStoreId || user.storeId);
    }

    if (!user?.storeId) {
      throw new ForbiddenException('Tài khoản không có quyền truy cập dữ liệu thống kê của cửa hàng');
    }

    if (requestedStoreId && BigInt(requestedStoreId) !== BigInt(user.storeId)) {
      throw new ForbiddenException({
        success: false,
        code: 'ACCESS_DENIED',
        message: 'Bạn không có quyền truy cập thống kê của cửa hàng khác.',
      });
    }

    return BigInt(user.storeId);
  }

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

    const groupBy = query?.groupBy || 'day';
    const dateRange = buildAnalyticsDateRange(query?.fromDate, query?.toDate, groupBy);

    const cacheKey = `dash:store:${targetStoreId || 'all'}:${query?.fromDate || 'none'}:${query?.toDate || 'none'}:${groupBy}:${query?.compareWith || 'none'}`;
    if (this.cacheService) {
      const cached = await this.cacheService.get(cacheKey);
      if (cached) return cached;
    }

    const { summary, devices, chartData } = await this.analyticsRepo.getDashboardData(
      targetStoreId,
      dateRange,
      groupBy,
    );

    const extended = typeof (this.analyticsRepo as any).getStoreExtendedData === 'function'
      ? await (this.analyticsRepo as any).getStoreExtendedData(targetStoreId, dateRange, query?.compareWith)
      : null;

    const result = {
      storeId: targetStoreId ? targetStoreId.toString() : null,
      filter: {
        fromDate: query?.fromDate || null,
        toDate: query?.toDate || null,
        groupBy,
      },
      totalOrders: summary.totalOrders,
      totalRevenue: summary.gmv,
      activeButtons: devices.activeDevices,
      financials: {
        gmv: summary.gmv,
        realizedRevenue: summary.realizedRevenue,
        platformCommission: summary.platformCommission,
        netRevenue: summary.netRevenue,
        paidRevenue: summary.paidRevenue,
      },
      devices,
      chartData: chartData.map((point) => ({
        ...point,
        revenue: point.gmv,
      })),
      ...(extended ? {
        orders: extended.orders,
        inventory: extended.inventory,
        customers: extended.customers,
        delivery: extended.delivery,
        wallet: extended.wallet,
        alerts: extended.alerts,
        comparison: extended.comparison,
      } : {}),
    };

    if (this.cacheService) {
      await this.cacheService.set(cacheKey, result, 30);
    }

    return result;
  }

  async getDashboard(user?: any, query?: DashboardAnalyticsQueryDto) {
    return this.getDashboardAnalytics(query?.storeId, user, query);
  }

  async getOrderAnalytics(user: any, query?: any) {
    const storeId = this.resolveStoreId(user, query?.storeId);
    const groupBy = query?.groupBy || 'day';
    const dateRange = buildAnalyticsDateRange(query?.fromDate, query?.toDate, groupBy);
    return this.analyticsRepo.getOrderAnalytics(storeId, dateRange, groupBy);
  }

  async getProductAnalytics(user: any, query?: any) {
    const storeId = this.resolveStoreId(user, query?.storeId);
    const dateRange = buildAnalyticsDateRange(query?.fromDate, query?.toDate, 'day');
    return this.analyticsRepo.getProductAnalytics(storeId, dateRange, {
      limit: query?.limit ? Number(query.limit) : 10,
      categoryId: query?.categoryId ? BigInt(query.categoryId) : undefined,
    });
  }

  async getInventoryAnalytics(user: any, query?: any) {
    const storeId = this.resolveStoreId(user, query?.storeId);
    return this.analyticsRepo.getInventoryAnalytics(storeId, {
      page: query?.page ? Number(query.page) : 1,
      pageSize: query?.pageSize ? Number(query.pageSize) : 20,
      filter: query?.filter,
    });
  }

  async getCustomerAnalytics(user: any, query?: any) {
    const storeId = this.resolveStoreId(user, query?.storeId);
    const dateRange = buildAnalyticsDateRange(query?.fromDate, query?.toDate, 'day');
    return this.analyticsRepo.getCustomerAnalytics(storeId, dateRange, {
      page: query?.page ? Number(query.page) : 1,
      pageSize: query?.pageSize ? Number(query.pageSize) : 20,
    });
  }

  async getFinanceAnalytics(user: any, query?: any) {
    const allowedRoles = ['STORE_OWNER', 'STORE_MANAGER', 'SUPER_ADMIN', 'SYSTEM_ADMIN', 'ADMIN'];
    if (!allowedRoles.includes(user?.role)) {
      throw new ForbiddenException('Nhân viên không có quyền truy cập dữ liệu tài chính của cửa hàng');
    }
    const storeId = this.resolveStoreId(user, query?.storeId);
    const dateRange = buildAnalyticsDateRange(query?.fromDate, query?.toDate, 'day');
    return this.analyticsRepo.getFinanceAnalytics(storeId, dateRange, {
      page: query?.page ? Number(query.page) : 1,
      pageSize: query?.pageSize ? Number(query.pageSize) : 20,
    });
  }

  async getOperationsAnalytics(user: any, query?: any) {
    const storeId = this.resolveStoreId(user, query?.storeId);
    const dateRange = buildAnalyticsDateRange(query?.fromDate, query?.toDate, 'day');
    return this.analyticsRepo.getOperationsAnalytics(storeId, dateRange);
  }

  async getStaffAnalytics(user: any, query?: any) {
    const storeId = this.resolveStoreId(user, query?.storeId);
    const dateRange = buildAnalyticsDateRange(query?.fromDate, query?.toDate, 'day');
    return this.analyticsRepo.getStaffAnalytics(storeId, dateRange);
  }

  async getAlertsAnalytics(user: any, query?: any) {
    const storeId = this.resolveStoreId(user, query?.storeId);
    return this.analyticsRepo.getAlertsAnalytics(storeId);
  }
}
