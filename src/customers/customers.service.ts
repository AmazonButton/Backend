import { Injectable, Inject, Optional } from '@nestjs/common';
import { CustomersRepository } from './customers.repository';
import { DashboardCacheService } from '../common/cache/dashboard-cache.service';
import { buildAnalyticsDateRange } from '../analytics/utils/analytics-date-range.util';

@Injectable()
export class CustomersService {
  constructor(
    @Inject(CustomersRepository)
    private readonly customersRepo: CustomersRepository,
    @Optional()
    private readonly cacheService?: DashboardCacheService,
  ) {}

  async getDashboard(user: any) {
    const userId = BigInt(user.userId || user.id);
    const cacheKey = `customer:dashboard:${userId.toString()}`;

    const fetcher = async () => this.customersRepo.getCustomerDashboard(userId);

    if (this.cacheService && typeof this.cacheService.getOrSet === 'function') {
      return this.cacheService.getOrSet(cacheKey, 30, fetcher);
    }
    return fetcher();
  }

  async getOrdersAnalytics(user: any, fromDate?: string, toDate?: string) {
    const userId = BigInt(user.userId || user.id);
    const cacheKey = `customer:orders:${userId.toString()}:${fromDate || 'all'}:${toDate || 'all'}`;

    const fetcher = async () => {
      const dateRange = fromDate || toDate ? buildAnalyticsDateRange(fromDate, toDate, 'day') : {};
      return this.customersRepo.getCustomerOrdersAnalytics(userId, dateRange);
    };

    if (this.cacheService && typeof this.cacheService.getOrSet === 'function') {
      return this.cacheService.getOrSet(cacheKey, 30, fetcher);
    }
    return fetcher();
  }

  async getDevicesAnalytics(user: any) {
    const userId = BigInt(user.userId || user.id);
    const cacheKey = `customer:devices:${userId.toString()}`;

    const fetcher = async () => this.customersRepo.getCustomerDevicesAnalytics(userId);

    if (this.cacheService && typeof this.cacheService.getOrSet === 'function') {
      return this.cacheService.getOrSet(cacheKey, 30, fetcher);
    }
    return fetcher();
  }

  async getRentalsAnalytics(user: any) {
    const userId = BigInt(user.userId || user.id);
    const cacheKey = `customer:rentals:${userId.toString()}`;

    const fetcher = async () => this.customersRepo.getCustomerRentalsAnalytics(userId);

    if (this.cacheService && typeof this.cacheService.getOrSet === 'function') {
      return this.cacheService.getOrSet(cacheKey, 30, fetcher);
    }
    return fetcher();
  }
}
