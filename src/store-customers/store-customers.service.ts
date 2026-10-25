import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { StoreCustomersRepository } from './store-customers.repository';
import { StoreCustomerResponseDto, CustomerStoreItemDto } from './dto/store-customer-response.dto';

@Injectable()
export class StoreCustomersService {
  constructor(private readonly repo: StoreCustomersRepository) {}

  private checkStoreAccess(storeId: bigint, user: any) {
    if (user && user.role !== 'SUPER_ADMIN' && user.role !== 'SYSTEM_ADMIN') {
      if (!user.storeId || BigInt(user.storeId) !== storeId) {
        throw new ForbiddenException({
          success: false,
          code: 'ACCESS_DENIED',
          message: 'Bạn không có quyền truy cập thông tin khách hàng của cửa hàng khác.',
        });
      }
    }
  }

  async getStoreCustomers(storeIdStr: string, query: any, user: any) {
    const storeId = BigInt(storeIdStr);
    this.checkStoreAccess(storeId, user);

    const result = await this.repo.findStoreCustomers(storeId, {
      page: query?.page ? Number(query.page) : 1,
      pageSize: query?.pageSize ? Number(query.pageSize) : 20,
      search: query?.search,
      status: query?.status,
    });

    const items = await Promise.all(
      result.items.map(async (sc) => {
        const stats = await this.repo.getCustomerStoreStats(storeId, sc.customerId);
        return StoreCustomerResponseDto.fromEntity(sc, stats);
      }),
    );

    return {
      items,
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
    };
  }

  async getStoreCustomer(storeIdStr: string, customerIdStr: string, user: any) {
    const storeId = BigInt(storeIdStr);
    const customerId = BigInt(customerIdStr);
    this.checkStoreAccess(storeId, user);

    const sc = await this.repo.findStoreCustomer(storeId, customerId);
    if (!sc) {
      throw new NotFoundException('Không tìm thấy thông tin khách hàng tại cửa hàng này');
    }

    const stats = await this.repo.getCustomerStoreStats(storeId, customerId);
    return StoreCustomerResponseDto.fromEntity(sc, stats);
  }

  async updateCustomerStatus(storeIdStr: string, customerIdStr: string, status: string, user: any) {
    const storeId = BigInt(storeIdStr);
    const customerId = BigInt(customerIdStr);
    this.checkStoreAccess(storeId, user);

    const updated = await this.repo.upsertStoreCustomerStatus(storeId, customerId, status);
    const stats = await this.repo.getCustomerStoreStats(storeId, customerId);
    return StoreCustomerResponseDto.fromEntity(updated, stats);
  }

  async getCustomerStores(user: any, query?: any) {
    if (!user) throw new ForbiddenException('Thiếu thông tin người dùng');
    const userId = BigInt(user.userId || user.id);
    const profile = await this.repo.findCustomerProfileByUserId(userId);
    if (!profile) {
      return {
        items: [],
        total: 0,
        page: 1,
        pageSize: 20,
      };
    }

    const result = await this.repo.findCustomerStores(profile.customerId, {
      page: query?.page ? Number(query.page) : 1,
      pageSize: query?.pageSize ? Number(query.pageSize) : 20,
    });

    const items: CustomerStoreItemDto[] = await Promise.all(
      result.items.map(async (item) => {
        const stats = await this.repo.getCustomerStoreStats(item.storeId, profile.customerId);
        return {
          storeId: item.store.storeId.toString(),
          name: item.store.name,
          code: item.store.code,
          phone: item.store.phone,
          address: item.store.address,
          status: item.status,
          joinedAt: item.joinedAt,
          totalOrders: stats.totalOrders,
        };
      }),
    );

    return {
      items,
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
    };
  }
}
