import { Injectable, NotFoundException, ForbiddenException, BadRequestException, Inject } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ConfirmHandoverDto } from './dto/confirm-handover.dto';
import * as crypto from 'crypto';

@Injectable()
export class DriverShiftsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async startShift(user: any) {
    if (!user) throw new ForbiddenException('Thiếu thông tin người dùng');
    if (!user.storeId) throw new ForbiddenException('Tài khoản thiếu thông tin cửa hàng liên kết (storeId)');

    const driverId = BigInt(user.userId || user.id);
    const storeId = BigInt(user.storeId);

    // Idempotent: return existing OPEN shift if already started
    const existing = await this.prisma.driverShift.findFirst({
      where: {
        driverId,
        status: 'OPEN',
      },
      orderBy: { startedAt: 'desc' },
    });

    if (existing) {
      return this.formatShiftWithLiveStats(existing);
    }

    try {
      const newShift = await this.prisma.driverShift.create({
        data: {
          driverId,
          storeId,
          status: 'OPEN',
          startedAt: new Date(),
          handoverCode: `HO-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`,
        },
      });

      return this.formatShiftWithLiveStats(newShift);
    } catch (err: any) {
      // Concurrency race condition protection (caught by uq_driver_open_shift unique index)
      const isUniqueConflict =
        err?.code === 'P2002' ||
        err?.code === '23505' ||
        err?.message?.includes('uq_driver_open_shift');

      if (isUniqueConflict) {
        const concurrentShift = await this.prisma.driverShift.findFirst({
          where: {
            driverId,
            status: 'OPEN',
          },
          orderBy: { startedAt: 'desc' },
        });
        if (concurrentShift) {
          return this.formatShiftWithLiveStats(concurrentShift);
        }
      }
      throw err;
    }
  }

  async getCurrentShift(user: any) {
    if (!user) throw new ForbiddenException('Thiếu thông tin người dùng');
    const driverId = BigInt(user.userId || user.id);

    const shift = await this.prisma.driverShift.findFirst({
      where: {
        driverId,
        status: 'OPEN',
      },
      orderBy: { startedAt: 'desc' },
    });

    if (!shift) {
      return null;
    }

    return this.formatShiftWithLiveStats(shift);
  }

  async closeShift(shiftId: string | number | bigint, user: any) {
    if (!user) throw new ForbiddenException('Thiếu thông tin người dùng');
    const targetShiftId = BigInt(shiftId);
    const shift = await this.prisma.driverShift.findUnique({
      where: { shiftId: targetShiftId },
    });

    if (!shift) {
      throw new NotFoundException('Ca làm việc không tồn tại');
    }

    const driverId = BigInt(user.userId || user.id);
    if (shift.driverId.toString() !== driverId.toString() && !['SUPER_ADMIN', 'SYSTEM_ADMIN'].includes(user.role)) {
      throw new ForbiddenException('Bạn không thể đóng ca của tài xế khác');
    }

    if (shift.status !== 'OPEN') {
      return this.formatShiftWithLiveStats(shift);
    }

    // Compute live final stats from database
    const stats = await this.computeLiveShiftStats(shift.driverId, shift.storeId, shift.startedAt, new Date());

    const closed = await this.prisma.driverShift.update({
      where: { shiftId: targetShiftId },
      data: {
        status: 'CLOSED',
        endedAt: new Date(),
        totalOrdersDelivered: stats.totalOrdersDelivered,
        totalOrdersFailed: stats.totalOrdersFailed,
        totalCodCollected: stats.totalCodCollected,
        totalVietqrCollected: stats.totalVietqrCollected,
      },
    });

    return this.formatShiftWithLiveStats(closed);
  }

  async confirmHandover(shiftId: string | number | bigint, user: any, dto?: ConfirmHandoverDto) {
    if (!user) throw new ForbiddenException('Thiếu thông tin người dùng');
    if (!['STORE_OWNER', 'STORE_MANAGER', 'STAFF_ORDER', 'SUPER_ADMIN', 'SYSTEM_ADMIN'].includes(user.role)) {
      throw new ForbiddenException('Chỉ thu ngân hoặc quản lý cửa hàng mới có quyền xác nhận bàn giao ca');
    }

    const targetShiftId = BigInt(shiftId);
    const shift = await this.prisma.driverShift.findUnique({
      where: { shiftId: targetShiftId },
    });

    if (!shift) {
      throw new NotFoundException('Ca làm việc không tồn tại');
    }

    if (user.storeId && shift.storeId.toString() !== user.storeId.toString() && !['SUPER_ADMIN', 'SYSTEM_ADMIN'].includes(user.role)) {
      throw new ForbiddenException('Ca làm việc không thuộc cửa hàng bạn quản lý');
    }

    if (shift.status === 'HANDED_OVER') {
      return this.formatShiftWithLiveStats(shift);
    }

    const handedOver = await this.prisma.driverShift.update({
      where: { shiftId: targetShiftId },
      data: {
        status: 'HANDED_OVER',
        handedOverAt: new Date(),
        confirmedByUserId: BigInt(user.userId || user.id),
        handoverNote: dto?.note || shift.handoverNote,
      },
    });

    return this.formatShiftWithLiveStats(handedOver);
  }

  async getShiftHistory(user: any, page: number = 1, limit: number = 20) {
    if (!user) throw new ForbiddenException('Thiếu thông tin người dùng');
    const driverId = BigInt(user.userId || user.id);
    const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
    const safePage = Math.max(Number(page) || 1, 1);
    const skip = (safePage - 1) * safeLimit;

    const [shifts, total] = await Promise.all([
      this.prisma.driverShift.findMany({
        where: { driverId },
        skip,
        take: safeLimit,
        orderBy: { startedAt: 'desc' },
      }),
      this.prisma.driverShift.count({ where: { driverId } }),
    ]);

    return {
      shifts: shifts.map(s => this.mapShiftDto(s)),
      pagination: {
        page: safePage,
        limit: safeLimit,
        total,
        totalPages: Math.ceil(total / safeLimit),
      },
    };
  }

  private async computeLiveShiftStats(driverId: bigint, storeId: bigint, startedAt: Date, endedAt: Date = new Date()) {
    const ordersDelivered = await this.prisma.order.findMany({
      where: {
        assignedDriverId: driverId,
        storeId,
        orderStatus: 'DELIVERED',
        deliveredAt: { gte: startedAt, lte: endedAt },
      },
      select: { totalAmount: true, paymentMethod: true },
    });

    const ordersFailedCount = await this.prisma.order.count({
      where: {
        assignedDriverId: driverId,
        storeId,
        orderStatus: 'DELIVERY_FAILED',
        updatedAt: { gte: startedAt, lte: endedAt },
      },
    });

    let codSum = 0;
    let vietqrSum = 0;
    for (const o of ordersDelivered) {
      const amt = Number(o.totalAmount || 0);
      if (o.paymentMethod === 'COD') {
        codSum += amt;
      } else {
        vietqrSum += amt;
      }
    }

    return {
      totalOrdersDelivered: ordersDelivered.length,
      totalOrdersFailed: ordersFailedCount,
      totalCodCollected: codSum,
      totalVietqrCollected: vietqrSum,
    };
  }

  private async formatShiftWithLiveStats(shift: any) {
    if (shift.status === 'OPEN') {
      const stats = await this.computeLiveShiftStats(shift.driverId, shift.storeId, shift.startedAt, new Date());
      return {
        ...this.mapShiftDto(shift),
        totalOrdersDelivered: stats.totalOrdersDelivered,
        totalOrdersFailed: stats.totalOrdersFailed,
        totalCodCollected: stats.totalCodCollected,
        totalVietqrCollected: stats.totalVietqrCollected,
      };
    }
    return this.mapShiftDto(shift);
  }

  private mapShiftDto(shift: any) {
    return {
      shiftId: shift.shiftId.toString(),
      storeId: shift.storeId.toString(),
      driverId: shift.driverId.toString(),
      status: shift.status,
      startedAt: shift.startedAt,
      endedAt: shift.endedAt,
      handedOverAt: shift.handedOverAt,
      confirmedByUserId: shift.confirmedByUserId ? shift.confirmedByUserId.toString() : null,
      handoverCode: shift.handoverCode,
      totalOrdersDelivered: Number(shift.totalOrdersDelivered || 0),
      totalOrdersFailed: Number(shift.totalOrdersFailed || 0),
      totalCodCollected: Number(shift.totalCodCollected || 0),
      totalVietqrCollected: Number(shift.totalVietqrCollected || 0),
      handoverNote: shift.handoverNote,
      createdAt: shift.createdAt,
    };
  }
}
