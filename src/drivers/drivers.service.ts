import { Injectable, NotFoundException, ForbiddenException, Inject } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateDutyDto } from './dto/update-duty.dto';

@Injectable()
export class DriversService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async updateMyDuty(user: any, dto: UpdateDutyDto) {
    if (!user) throw new ForbiddenException('Thiếu thông tin người dùng');
    if (!user.storeId) {
      throw new ForbiddenException('Tài khoản thiếu thông tin cửa hàng liên kết (storeId)');
    }

    const driverId = BigInt(user.userId || user.id);
    const storeId = BigInt(user.storeId);

    const duty = await this.prisma.driverDuty.upsert({
      where: { driverId },
      update: {
        status: dto.status,
        lastSeenAt: new Date(),
        storeId,
      },
      create: {
        driverId,
        storeId,
        status: dto.status,
        lastSeenAt: new Date(),
      },
      include: {
        driver: { select: { userId: true, fullName: true, phone: true } },
      },
    });

    return {
      driverId: duty.driverId.toString(),
      storeId: duty.storeId.toString(),
      status: duty.status,
      lastSeenAt: duty.lastSeenAt,
      fullName: duty.driver.fullName,
      phone: duty.driver.phone,
    };
  }

  async getMyDuty(user: any) {
    if (!user) throw new ForbiddenException('Thiếu thông tin người dùng');
    const driverId = BigInt(user.userId || user.id);
    const duty = await this.prisma.driverDuty.findUnique({
      where: { driverId },
      include: {
        driver: { select: { userId: true, fullName: true, phone: true } },
      },
    });

    if (!duty) {
      return {
        driverId: driverId.toString(),
        storeId: user.storeId?.toString() || null,
        status: 'OFFLINE',
        lastSeenAt: null,
        fullName: user.fullName || '',
        phone: null,
      };
    }

    return {
      driverId: duty.driverId.toString(),
      storeId: duty.storeId.toString(),
      status: duty.status,
      lastSeenAt: duty.lastSeenAt,
      fullName: duty.driver.fullName,
      phone: duty.driver.phone,
    };
  }

  async getMyDeliverySummary(user: any) {
    if (!user) throw new ForbiddenException('Thiếu thông tin người dùng');
    const driverId = BigInt(user.userId || user.id);

    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const [completedOrders, pendingOrders] = await Promise.all([
      this.prisma.order.findMany({
        where: {
          assignedDriverId: driverId,
          orderStatus: { in: ['DELIVERED', 'COMPLETED'] },
          updatedAt: { gte: startOfDay },
        },
      }),
      this.prisma.order.findMany({
        where: {
          assignedDriverId: driverId,
          orderStatus: { in: ['ASSIGNED', 'PICKED_UP', 'SHIPPING', 'DELIVERING'] },
        },
      }),
    ]);

    let totalCashCollected = 0;
    for (const o of completedOrders) {
      if (o.paymentMethod === 'COD' || o.paymentMethod === 'CASH') {
        totalCashCollected += Number(o.totalAmount || 0);
      }
    }

    return {
      driverId: driverId.toString(),
      todayCompletedDeliveries: completedOrders.length,
      todayPendingDeliveries: pendingOrders.length,
      todayCashCollected: totalCashCollected,
      summaryDate: startOfDay.toISOString().split('T')[0],
    };
  }

  async getOnlineDrivers(storeId: string | number | bigint, user: any) {
    const targetStoreId = BigInt(storeId);
    if (user && user.storeId && user.storeId.toString() !== targetStoreId.toString() && user.role !== 'SUPER_ADMIN' && user.role !== 'SYSTEM_ADMIN') {
      throw new ForbiddenException('Bạn không có quyền truy cập danh sách tài xế của cửa hàng khác');
    }

    const onlineDrivers = await this.prisma.driverDuty.findMany({
      where: {
        storeId: targetStoreId,
        status: 'ONLINE',
      },
      include: {
        driver: { select: { userId: true, fullName: true, phone: true } },
      },
    });

    return onlineDrivers.map(d => ({
      driverId: d.driverId.toString(),
      storeId: d.storeId.toString(),
      status: d.status,
      lastSeenAt: d.lastSeenAt,
      fullName: d.driver.fullName,
      phone: d.driver.phone,
    }));
  }
}
