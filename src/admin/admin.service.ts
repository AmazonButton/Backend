import { Injectable, NotFoundException, BadRequestException, Inject } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AdminService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async listPendingStores() {
    return this.prisma.store.findMany({
      where: { status: 'PENDING_APPROVAL' },
      include: { users: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async listAllStores() {
    return this.prisma.store.findMany({
      orderBy: { name: 'asc' },
      include: {
        _count: { select: { devices: true, products: true } },
      },
    });
  }

  async approveStore(storeId: string, adminUser: any) {
    const store = await this.prisma.store.findUnique({ where: { id: storeId } });
    if (!store) throw new NotFoundException('Không tìm thấy cửa hàng');

    return this.prisma.$transaction(async (tx) => {
      const s = await tx.store.update({
        where: { id: storeId },
        data: {
          status: 'ACTIVE',
          approvedAt: new Date(),
        },
      });

      await tx.user.updateMany({
        where: { storeId, role: 'STORE_OWNER' },
        data: { isActive: true },
      });

      await tx.auditLog.create({
        data: {
          userId: adminUser.id,
          action: 'STORE_APPROVED',
          entity: 'Store',
          entityId: storeId,
          newValues: JSON.stringify({ approvedBy: adminUser.email }),
        },
      });

      return s;
    });
  }

  async rejectStore(storeId: string, reason: string, adminUser: any) {
    if (!reason) throw new BadRequestException('Bắt buộc phải nhập lý do từ chối');

    return this.prisma.$transaction(async (tx) => {
      const s = await tx.store.update({
        where: { id: storeId },
        data: {
          status: 'REJECTED',
          rejectionReason: reason,
        },
      });

      await tx.auditLog.create({
        data: {
          userId: adminUser.id,
          action: 'STORE_REJECTED',
          entity: 'Store',
          entityId: storeId,
          newValues: JSON.stringify({ reason, rejectedBy: adminUser.email }),
        },
      });

      return s;
    });
  }

  async getSystemStats() {
    const [totalStores, totalUsers, totalDevices, totalOrders, pendingStores, orders] =
      await Promise.all([
        this.prisma.store.count(),
        this.prisma.user.count(),
        this.prisma.device.count(),
        this.prisma.order.count(),
        this.prisma.store.count({ where: { status: 'PENDING_APPROVAL' } }),
        this.prisma.order.findMany({ select: { totalAmount: true, status: true } }),
      ]);

    const totalRevenue = orders
      .filter((o) => o.status !== 'CANCELLED' && o.status !== 'REJECTED')
      .reduce((sum, o) => sum + o.totalAmount, 0);

    const activeDevices = await this.prisma.device.count({ where: { status: 'ACTIVE' } });

    return {
      totalStores,
      totalUsers,
      totalDevices,
      activeDevices,
      totalOrders,
      pendingStores,
      totalRevenue,
    };
  }

  async listAuditLogs() {
    return this.prisma.auditLog.findMany({
      take: 50,
      orderBy: { createdAt: 'desc' },
      include: { user: true },
    });
  }

  async listUsers() {
    return this.prisma.user.findMany({
      select: {
        id: true,
        email: true,
        username: true,
        fullName: true,
        phone: true,
        role: true,
        isActive: true,
        createdAt: true,
        lastLoginAt: true,
        store: { select: { name: true, code: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async toggleUserStatus(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('Không tìm thấy tài khoản');
    return this.prisma.user.update({
      where: { id: userId },
      data: { isActive: !user.isActive },
    });
  }

  async updateUserRole(userId: string, role: string) {
    return this.prisma.user.update({
      where: { id: userId },
      data: { role },
    });
  }
}
