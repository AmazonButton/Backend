export class StoreCustomerResponseDto {
  storeCustomerId: string;
  storeId: string;
  customerId: string;
  userId: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  status: string;
  joinedAt: Date;
  totalOrders?: number;
  totalSpent?: number;

  static fromEntity(sc: any, stats?: { totalOrders: number; totalSpent: number }): StoreCustomerResponseDto {
    return {
      storeCustomerId: sc.storeCustomerId?.toString(),
      storeId: sc.storeId?.toString(),
      customerId: sc.customerId?.toString(),
      userId: sc.customer?.user?.userId?.toString() || sc.customer?.userId?.toString() || '',
      fullName: sc.customer?.user?.fullName || '',
      email: sc.customer?.user?.email || null,
      phone: sc.customer?.phone || sc.customer?.user?.phone || null,
      status: sc.status,
      joinedAt: sc.joinedAt || sc.createdAt,
      totalOrders: stats?.totalOrders ?? 0,
      totalSpent: stats?.totalSpent ?? 0,
    };
  }
}

export class CustomerStoreItemDto {
  storeId: string;
  name: string;
  code: string;
  phone: string;
  address: string;
  status: string;
  joinedAt: Date;
  totalOrders: number;
}
