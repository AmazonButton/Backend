import { ForbiddenException, Injectable, Inject, Optional } from '@nestjs/common';
import { StaffRepository } from './staff.repository';
import { DashboardCacheService } from '../common/cache/dashboard-cache.service';

@Injectable()
export class StaffService {
  constructor(
    @Inject(StaffRepository)
    private readonly staffRepo: StaffRepository,
    @Optional()
    private readonly cacheService?: DashboardCacheService,
  ) {}

  async getStaffDashboard(user: any) {
    const userId = BigInt(user.userId || user.id);
    let role = user.role;
    let storeId: bigint | null = user.storeId ? BigInt(user.storeId) : null;

    if (!storeId || !role || role === 'STORE_STAFF') {
      const membership = await this.staffRepo.findStaffMembership(userId);
      if (membership) {
        storeId = membership.storeId;
        role = membership.role?.roleCode || role;
      }
    }

    if (!storeId && role !== 'STAFF_DELIVERY' && role !== 'DRIVER') {
      throw new ForbiddenException('Tài khoản nhân viên không thuộc về cửa hàng nào');
    }

    const cacheKey = `staff:dashboard:store:${storeId?.toString() || 'none'}:user:${userId.toString()}:role:${role}`;

    const fetcher = async () => {
      switch (role) {
        case 'STAFF_ORDER':
          return this.staffRepo.getOrderStaffDashboard(storeId!);
        case 'STAFF_INVENTORY':
          return this.staffRepo.getInventoryStaffDashboard(storeId!);
        case 'STAFF_BUTTON':
          return this.staffRepo.getButtonStaffDashboard(storeId!);
        case 'STAFF_DELIVERY':
        case 'DRIVER':
          return this.staffRepo.getDeliveryStaffDashboard(userId, storeId || undefined);
        case 'STORE_STAFF':
        default:
          return this.staffRepo.getGeneralStaffDashboard(storeId!);
      }
    };

    if (this.cacheService && typeof this.cacheService.getOrSet === 'function') {
      return this.cacheService.getOrSet(cacheKey, 30, fetcher);
    }
    return fetcher();
  }
}
