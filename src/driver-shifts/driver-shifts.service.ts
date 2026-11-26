import { Injectable, NotFoundException, ForbiddenException, BadRequestException, ConflictException, Inject } from '@nestjs/common';
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
    const driverId = BigInt(user.userId || user.id);
    const isAdmin = ['SUPER_ADMIN', 'SYSTEM_ADMIN'].includes(user.role);

    return this.prisma.$transaction(async (tx) => {
      if (typeof (tx as any).$queryRaw === 'function') {
        await (tx as any).$queryRaw`
          SELECT shift_id, status FROM driver_shifts WHERE shift_id = ${targetShiftId} FOR UPDATE
        `;
      }

      const shift = await tx.driverShift.findUnique({
        where: { shiftId: targetShiftId },
      });
      if (!shift) {
        throw new NotFoundException('Ca làm việc không tồn tại');
      }

      const isSameStoreOwner =
        user.role === 'STORE_OWNER' &&
        user.storeId != null &&
        shift.storeId.toString() === user.storeId.toString();

      if (shift.driverId.toString() !== driverId.toString() && !isSameStoreOwner && !isAdmin) {
        throw new ForbiddenException('Bạn không thể đóng ca của cửa hàng khác');
      }

      if (shift.status === 'HANDED_OVER') {
        throw new ConflictException({
          success: false,
          code: 'SHIFT_ALREADY_HANDED_OVER',
          message: 'Ca làm việc đã bàn giao COD (HANDED_OVER), không thể đóng ngược lại thành CLOSED',
        });
      }

      if (shift.status === 'CLOSED') {
        return this.formatShiftWithLiveStats(shift, tx);
      }

      // Compute live final stats from database inside transaction
      const endedAt = new Date();
      const stats = await this.computeLiveShiftStats(shift.driverId, shift.storeId, shift.startedAt, endedAt, tx);

      const cas = await tx.driverShift.updateMany({
        where: { shiftId: targetShiftId, status: 'OPEN' },
        data: {
          status: 'CLOSED',
          endedAt,
          totalOrdersDelivered: stats.totalOrdersDelivered,
          totalOrdersFailed: stats.totalOrdersFailed,
          totalCodCollected: stats.totalCodCollected,
          totalVietqrCollected: stats.totalVietqrCollected,
        },
      });
      if (cas.count === 0) {
        throw new ConflictException({
          success: false,
          code: 'SHIFT_STATE_CONFLICT',
          message: 'Trạng thái ca làm việc đã thay đổi bởi giao dịch khác, không thể đóng ca',
        });
      }

      const closed = await tx.driverShift.findUnique({ where: { shiftId: targetShiftId } });
      return this.formatShiftWithLiveStats(closed || { ...shift, status: 'CLOSED', endedAt, ...stats }, tx);
    });
  }

  async confirmHandover(shiftId: string | number | bigint, user: any, dto?: ConfirmHandoverDto) {
    if (!user) throw new ForbiddenException('Thiếu thông tin người dùng');
    if (!['STORE_OWNER', 'SUPER_ADMIN', 'SYSTEM_ADMIN'].includes(user.role)) {
      throw new ForbiddenException('Chỉ chủ cửa hàng hoặc quản trị mới có quyền xác nhận bàn giao tiền ca');
    }

    const targetShiftId = BigInt(shiftId);
    const actorUserId = BigInt(user.userId || user.id);

    return this.prisma.$transaction(async (tx) => {
      if (typeof (tx as any).$queryRaw === 'function') {
        await (tx as any).$queryRaw`
          SELECT shift_id, status FROM driver_shifts WHERE shift_id = ${targetShiftId} FOR UPDATE
        `;
      }

      const shift = await tx.driverShift.findUnique({
        where: { shiftId: targetShiftId },
      });
      if (!shift) {
        throw new NotFoundException('Ca làm việc không tồn tại');
      }

      if (!['SUPER_ADMIN', 'SYSTEM_ADMIN', 'ADMIN'].includes(user.role)) {
        if (!user.storeId || shift.storeId.toString() !== user.storeId.toString()) {
          throw new ForbiddenException('Ca làm việc không thuộc cửa hàng bạn quản lý');
        }
      }

      if (shift.status === 'HANDED_OVER') {
        return this.formatShiftWithLiveStats(shift, tx);
      }

      const now = new Date();
      let finalStats: {
        totalOrdersDelivered?: number;
        totalOrdersFailed?: number;
        totalCodCollected?: number;
        totalVietqrCollected?: number;
        endedAt?: Date;
      } = {};
      if (shift.status === 'OPEN') {
        const live = await this.computeLiveShiftStats(shift.driverId, shift.storeId, shift.startedAt, now, tx);
        finalStats = {
          endedAt: now,
          totalOrdersDelivered: live.totalOrdersDelivered,
          totalOrdersFailed: live.totalOrdersFailed,
          totalCodCollected: live.totalCodCollected,
          totalVietqrCollected: live.totalVietqrCollected,
        };
      }

      const cas = await tx.driverShift.updateMany({
        where: { shiftId: targetShiftId, status: { in: ['OPEN', 'CLOSED'] } },
        data: {
          ...finalStats,
          status: 'HANDED_OVER',
          handedOverAt: now,
          confirmedByUserId: actorUserId,
          handoverNote: dto?.note || shift.handoverNote,
        },
      });
      if (cas.count === 0) {
        throw new ConflictException({
          success: false,
          code: 'SHIFT_STATE_CONFLICT',
          message: 'Trạng thái ca làm việc đã thay đổi bởi giao dịch khác',
        });
      }

      const handedOver = await tx.driverShift.findUnique({ where: { shiftId: targetShiftId } });
      return this.formatShiftWithLiveStats(handedOver || { ...shift, ...finalStats, status: 'HANDED_OVER', handedOverAt: now }, tx);
    });
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

  private async computeLiveShiftStats(
    driverId: bigint,
    storeId: bigint,
    startedAt: Date,
    endedAt: Date = new Date(),
    client: any = this.prisma,
  ) {
    const ordersDelivered = await client.order.findMany({
      where: {
        assignedDriverId: driverId,
        storeId,
        orderStatus: { in: ['DELIVERED', 'COMPLETED'] },
        deliveredAt: { gte: startedAt, lte: endedAt },
      },
      select: { totalAmount: true, paymentMethod: true },
    });

    const ordersFailedCount = await client.order.count({
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
      } else if (o.paymentMethod === 'VIETQR') {
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

    async getShiftById(id: string | number | bigint, user: any) {
    const shiftId = BigInt(id);
    const shift = await this.prisma.driverShift.findUnique({
      where: { shiftId },
      include: {
        driver: { select: { userId: true, fullName: true, phone: true } },
      },
    });
    if (!shift) {
      throw new NotFoundException('Không tìm thấy thông tin ca làm việc');
    }
    if (user && user.role !== 'SUPER_ADMIN' && user.role !== 'SYSTEM_ADMIN') {
      const isMyShift = shift.driverId === BigInt(user.userId || user.id);
      const isMyStore = user.storeId && shift.storeId === BigInt(user.storeId);
      if (!isMyShift && !isMyStore) {
        throw new ForbiddenException({
          success: false,
          code: 'ACCESS_DENIED',
          message: 'Bạn không có quyền xem thông tin ca làm việc này.',
        });
      }
    }
    return this.formatShiftWithLiveStats(shift);
  }

  async getStoreShifts(storeId: string | number | bigint, user: any, query?: any) {
    const targetStoreId = BigInt(storeId);
    if (user && !['SUPER_ADMIN', 'SYSTEM_ADMIN', 'ADMIN'].includes(user.role)) {
      if (!user.storeId || BigInt(user.storeId) !== targetStoreId) {
        throw new ForbiddenException({
          success: false,
          code: 'ACCESS_DENIED',
          message: 'Bạn không có quyền xem danh sách ca làm việc của cửa hàng khác.',
        });
      }
    }

    const where: any = { storeId: targetStoreId };
    if (query?.status) {
      where.status = query.status;
    }
    if (query?.fromDate || query?.toDate) {
      where.startedAt = {};
      if (query.fromDate) where.startedAt.gte = new Date(query.fromDate);
      if (query.toDate) where.startedAt.lte = new Date(query.toDate);
    }

    const page = Math.max(1, Number(query?.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(query?.pageSize) || Number(query?.limit) || 20));
    const skip = (page - 1) * pageSize;

    const [items, total] = await Promise.all([
      this.prisma.driverShift.findMany({
        where,
        include: {
          driver: { select: { userId: true, fullName: true, phone: true } },
        },
        orderBy: { startedAt: 'desc' },
        skip,
        take: pageSize,
      }),
      this.prisma.driverShift.count({ where }),
    ]);

    const formatted = await Promise.all(items.map((s) => this.formatShiftWithLiveStats(s)));

    return {
      items: formatted,
      total,
      page,
      pageSize,
    };
  }

  private assertStoreHandoverAccess(storeId: string | number | bigint, user: any): bigint {
    if (!user) throw new ForbiddenException('Thiếu thông tin người dùng');
    const targetStoreId = BigInt(storeId);
    const isAdmin = ['SUPER_ADMIN', 'SYSTEM_ADMIN', 'ADMIN'].includes(user.role);
    if (!isAdmin) {
      if (user.role !== 'STORE_OWNER' || !user.storeId || BigInt(user.storeId) !== targetStoreId) {
        throw new ForbiddenException({
          success: false,
          code: 'ACCESS_DENIED',
          message: 'Bạn không có quyền quản lý bàn giao đơn/ca của cửa hàng khác.',
        });
      }
    }
    return targetStoreId;
  }

  async getLegacyHandoverSummary(storeId: string | number | bigint, user: any) {
    const targetStoreId = this.assertStoreHandoverAccess(storeId, user);
    const store = await this.prisma.store.findUnique({
      where: { storeId: targetStoreId },
      select: { storeId: true, ownerUserId: true, name: true },
    });
    if (!store) throw new NotFoundException('Cửa hàng không tồn tại');

    const [inFlightOrders, openShifts, closedShifts] = await Promise.all([
      this.prisma.order.findMany({
        where: {
          storeId: targetStoreId,
          orderStatus: 'SHIPPING',
          assignedDriverId: store.ownerUserId ? { not: store.ownerUserId } : { not: null },
        },
        select: {
          orderId: true,
          orderCode: true,
          totalAmount: true,
          paymentMethod: true,
          assignedDriverId: true,
        },
        orderBy: { updatedAt: 'desc' },
      }),
      this.prisma.driverShift.findMany({
        where: {
          storeId: targetStoreId,
          status: 'OPEN',
          ...(store.ownerUserId ? { driverId: { not: store.ownerUserId } } : {}),
        },
        include: { driver: { select: { userId: true, fullName: true, phone: true } } },
        orderBy: { startedAt: 'desc' },
      }),
      this.prisma.driverShift.findMany({
        where: {
          storeId: targetStoreId,
          status: 'CLOSED',
          ...(store.ownerUserId ? { driverId: { not: store.ownerUserId } } : {}),
        },
        include: { driver: { select: { userId: true, fullName: true, phone: true } } },
        orderBy: { endedAt: 'desc' },
      }),
    ]);

    const formattedOpenShifts = await Promise.all(openShifts.map((s) => this.formatShiftWithLiveStats(s)));
    const formattedClosedShifts = closedShifts.map((s) => this.mapShiftDto(s));
    const pendingCodHandoverTotal = [...formattedOpenShifts, ...formattedClosedShifts].reduce(
      (sum, s) => sum + Number(s.totalCodCollected || 0),
      0,
    );

    return {
      storeId: targetStoreId.toString(),
      ownerUserId: store.ownerUserId?.toString() || null,
      inFlightShipperOrders: inFlightOrders.map((o) => ({
        orderId: o.orderId.toString(),
        orderCode: o.orderCode,
        totalAmount: Number(o.totalAmount || 0),
        paymentMethod: o.paymentMethod,
        assignedDriverId: o.assignedDriverId?.toString() || null,
      })),
      openShifts: formattedOpenShifts,
      pendingHandoverClosedShifts: formattedClosedShifts,
      pendingCodHandoverTotal,
    };
  }

  async reconcileStoreLegacyShippers(storeId: string | number | bigint, user: any, note?: string) {
    const targetStoreId = this.assertStoreHandoverAccess(storeId, user);
    const actorUserId = BigInt(user.userId || user.id);

    return this.prisma.$transaction(async (tx) => {
      const store = await tx.store.findUnique({
        where: { storeId: targetStoreId },
        select: { storeId: true, ownerUserId: true },
      });
      if (!store) throw new NotFoundException('Cửa hàng không tồn tại');

      const reclaimAssigneeId =
        user.role === 'STORE_OWNER' ? actorUserId : store.ownerUserId || actorUserId;
      const now = new Date();

      if (typeof (tx as any).$queryRaw === 'function') {
        await (tx as any).$queryRaw`
          SELECT shift_id FROM driver_shifts
          WHERE store_id = ${targetStoreId} AND status IN ('OPEN', 'CLOSED')
          ORDER BY shift_id ASC
          FOR UPDATE
        `;
      }

      const pendingShifts = await tx.driverShift.findMany({
        where: {
          storeId: targetStoreId,
          status: { in: ['OPEN', 'CLOSED'] },
          ...(store.ownerUserId ? { driverId: { not: store.ownerUserId } } : {}),
        },
        orderBy: { startedAt: 'asc' },
      });

      let settledOpenShiftsCount = 0;
      let settledClosedShiftsCount = 0;
      let totalCodSettled = 0;
      let totalVietqrSettled = 0;

      for (const shift of pendingShifts) {
        if (shift.status === 'OPEN') {
          const live = await this.computeLiveShiftStats(
            shift.driverId,
            targetStoreId,
            shift.startedAt,
            now,
            tx,
          );
          const cas = await tx.driverShift.updateMany({
            where: { shiftId: shift.shiftId, status: 'OPEN' },
            data: {
              status: 'HANDED_OVER',
              endedAt: now,
              handedOverAt: now,
              confirmedByUserId: actorUserId,
              totalOrdersDelivered: live.totalOrdersDelivered,
              totalOrdersFailed: live.totalOrdersFailed,
              totalCodCollected: live.totalCodCollected,
              totalVietqrCollected: live.totalVietqrCollected,
              handoverNote: note || shift.handoverNote || 'Chốt ca và bàn giao COD khi ngừng role shipper',
            },
          });
          if (cas.count === 1) {
            settledOpenShiftsCount++;
            totalCodSettled += live.totalCodCollected;
            totalVietqrSettled += live.totalVietqrCollected;
          }
        } else if (shift.status === 'CLOSED') {
          const cas = await tx.driverShift.updateMany({
            where: { shiftId: shift.shiftId, status: 'CLOSED' },
            data: {
              status: 'HANDED_OVER',
              handedOverAt: now,
              confirmedByUserId: actorUserId,
              handoverNote: note || shift.handoverNote || 'Xác nhận bàn giao COD ca đã đóng',
            },
          });
          if (cas.count === 1) {
            settledClosedShiftsCount++;
            totalCodSettled += Number(shift.totalCodCollected || 0);
            totalVietqrSettled += Number(shift.totalVietqrCollected || 0);
          }
        }
      }

      const reclaimedRes = await tx.order.updateMany({
        where: {
          storeId: targetStoreId,
          orderStatus: 'SHIPPING',
          assignedDriverId: store.ownerUserId ? { not: store.ownerUserId } : { not: null },
        },
        data: {
          assignedDriverId: reclaimAssigneeId,
        },
      });

      await tx.driverDuty.updateMany({
        where: {
          storeId: targetStoreId,
          status: 'ONLINE',
          ...(store.ownerUserId ? { driverId: { not: store.ownerUserId } } : {}),
        },
        data: { status: 'OFFLINE' },
      });

      return {
        storeId: targetStoreId.toString(),
        reclaimAssigneeId: reclaimAssigneeId.toString(),
        reclaimedShippingOrdersCount: reclaimedRes.count,
        settledOpenShiftsCount,
        settledClosedShiftsCount,
        totalCodSettled,
        totalVietqrSettled,
      };
    });
  }

  private async formatShiftWithLiveStats(shift: any, client: any = this.prisma) {
    if (shift.status === 'OPEN') {
      const stats = await this.computeLiveShiftStats(shift.driverId, shift.storeId, shift.startedAt, new Date(), client);
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
