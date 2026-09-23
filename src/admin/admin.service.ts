import { Injectable, NotFoundException, BadRequestException, Inject } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AdminService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async listPendingStores() {
    return this.prisma.store.findMany({
      where: { status: 'INACTIVE' },
      include: { owner: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async listAllStores() {
    return this.prisma.store.findMany({
      orderBy: { name: 'asc' },
      include: {
        owner: true,
        _count: { select: { iotButtons: true, products: true, orders: true } },
      },
    });
  }

  async approveStore(storeId: string | number | bigint, adminUser: any) {
    const targetStoreId = BigInt(storeId);
    const store = await this.prisma.store.findUnique({ where: { storeId: targetStoreId } });
    if (!store) throw new NotFoundException('Không tìm thấy cửa hàng');

    return this.prisma.$transaction(async (tx) => {
      const s = await tx.store.update({
        where: { storeId: targetStoreId },
        data: {
          status: 'ACTIVE',
        },
      });

      await tx.user.update({
        where: { userId: store.ownerUserId },
        data: { status: 'ACTIVE' },
      });

      return s;
    });
  }

  async rejectStore(storeId: string | number | bigint, reason: string, adminUser: any) {
    if (!reason) throw new BadRequestException('Bắt buộc phải nhập lý do từ chối');
    const targetStoreId = BigInt(storeId);

    return this.prisma.store.update({
      where: { storeId: targetStoreId },
      data: {
        status: 'SUSPENDED',
      },
    });
  }

  async getSystemStats() {
    const [totalStores, totalUsers, totalButtons, totalOrders, stores, orders] =
      await Promise.all([
        this.prisma.store.count(),
        this.prisma.user.count(),
        this.prisma.ioTButton.count(),
        this.prisma.order.count(),
        this.prisma.store.findMany({ select: { status: true } }),
        this.prisma.order.findMany({ select: { totalAmount: true, orderStatus: true } }),
      ]);

    const totalRevenue = orders
      .filter((o) => o.orderStatus !== 'CANCELLED' && o.orderStatus !== 'REJECTED')
      .reduce((sum, o) => sum + Number(o.totalAmount), 0);

    const activeButtons = await this.prisma.ioTButton.count({ where: { status: 'ACTIVE' } });
    const activeStores = stores.filter((s) => s.status === 'ACTIVE').length;

    return {
      totalStores,
      activeStores,
      totalUsers,
      totalButtons,
      activeButtons,
      totalOrders,
      totalRevenue,
    };
  }

  async listAuditLogs() {
    const [statusLogs, priceLogs] = await Promise.all([
      this.prisma.orderStatusHistory.findMany({
        take: 50,
        orderBy: { changedAt: 'desc' },
        include: { changedByUser: true, order: true },
      }),
      this.prisma.productPriceHistory.findMany({
        take: 50,
        orderBy: { changedAt: 'desc' },
        include: { changedByUser: true, product: true },
      }),
    ]);

    const formattedLogs = [
      ...statusLogs.map((sl) => ({
        id: sl.historyId.toString(),
        type: 'ORDER_STATUS_CHANGE',
        description: `Đơn ${sl.order.orderCode}: ${sl.oldStatus || 'NONE'} -> ${sl.newStatus}`,
        timestamp: sl.changedAt,
        user: sl.changedByUser?.fullName || 'Hệ thống',
      })),
      ...priceLogs.map((pl) => ({
        id: pl.historyId.toString(),
        type: 'PRICE_CHANGE',
        description: `Sản phẩm ${pl.product.productName}: ${pl.oldPrice} -> ${pl.newPrice}`,
        timestamp: pl.changedAt,
        user: pl.changedByUser?.fullName || 'Quản lý',
      })),
    ].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    return formattedLogs;
  }

  async listUsers() {
    return this.prisma.user.findMany({
      select: {
        userId: true,
        email: true,
        username: true,
        fullName: true,
        phone: true,
        status: true,
        createdAt: true,
        customerProfile: true,
        ownedStores: { select: { name: true, code: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async toggleUserStatus(userId: string | number | bigint) {
    const targetUserId = BigInt(userId);
    const user = await this.prisma.user.findUnique({ where: { userId: targetUserId } });
    if (!user) throw new NotFoundException('Không tìm thấy tài khoản');

    const newStatus = user.status === 'ACTIVE' ? 'BLOCKED' : 'ACTIVE';
    return this.prisma.user.update({
      where: { userId: targetUserId },
      data: { status: newStatus },
    });
  }

  async updateUserRole(userId: string | number | bigint, roleCode: string) {
    const targetUserId = BigInt(userId);
    const user = await this.prisma.user.findUnique({ where: { userId: targetUserId } });
    if (!user) throw new NotFoundException('Không tìm thấy tài khoản');

    let role = await this.prisma.role.findUnique({ where: { roleCode } });
    if (!role) {
      role = await this.prisma.role.create({
        data: {
          roleCode,
          roleName: roleCode,
          description: `Vai trò ${roleCode}`,
        },
      });
    }

    const staff = await this.prisma.storeStaff.findFirst({ where: { userId: targetUserId } });
    if (staff) {
      await this.prisma.storeStaff.update({
        where: { storeStaffId: staff.storeStaffId },
        data: { roleId: role.roleId },
      });
    }

    return {
      success: true,
      message: `Đã cập nhật vai trò cho người dùng ${user.username} thành ${roleCode}`,
    };
  }
}
