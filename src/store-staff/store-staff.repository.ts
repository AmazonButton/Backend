import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  advanceMonotonicTokensInvalidBefore,
  lockUserForWatermark,
} from '../auth/authority.policy';

@Injectable()
export class StoreStaffRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findStaffByStore(
    storeId: bigint,
    options: { skip: number; take: number; status?: string; roleCode?: string },
  ) {
    const where: any = { storeId };
    if (options.status) {
      where.status = options.status;
    }
    if (options.roleCode) {
      where.role = { roleCode: options.roleCode };
    }

    const [total, items] = await Promise.all([
      this.prisma.storeStaff.count({ where }),
      this.prisma.storeStaff.findMany({
        where,
        skip: options.skip,
        take: options.take,
        include: {
          user: true,
          role: true,
        },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    return { total, items };
  }

  async findStaffById(storeStaffId: bigint) {
    return this.prisma.storeStaff.findUnique({
      where: { storeStaffId },
      include: {
        user: true,
        role: true,
        store: true,
      },
    });
  }

  async findStaffByStoreAndUser(storeId: bigint, userId: bigint) {
    return this.prisma.storeStaff.findUnique({
      where: {
        uq_store_staff_store_user: {
          storeId,
          userId,
        },
      },
      include: {
        user: true,
        role: true,
      },
    });
  }

  async findUserByIdentifier(identifier: string) {
    // If identifier is pure digits, try userId first
    if (/^\d+$/.test(identifier)) {
      const byId = await this.prisma.user.findUnique({
        where: { userId: BigInt(identifier) },
      });
      if (byId) return byId;
    }

    return this.prisma.user.findFirst({
      where: {
        OR: [
          { email: identifier },
          { username: identifier },
          { phone: identifier },
        ],
      },
    });
  }

  async findRoleByCode(roleCode: string) {
    return this.prisma.role.findUnique({
      where: { roleCode },
    });
  }

  async listRolesByCodes(roleCodes: string[]) {
    return this.prisma.role.findMany({
      where: {
        roleCode: { in: roleCodes },
      },
    });
  }

  async createStaff(data: { storeId: bigint; userId: bigint; roleId: bigint; status?: string }) {
    return this.prisma.storeStaff.create({
      data: {
        storeId: data.storeId,
        userId: data.userId,
        roleId: data.roleId,
        status: data.status || 'PENDING',
      },
      include: {
        user: true,
        role: true,
      },
    });
  }

  async updateStaff(
    storeStaffId: bigint,
    data: { roleId?: bigint; status?: string; joinedAt?: Date | null; leftAt?: Date | null },
  ) {
    return this.prisma.storeStaff.update({
      where: { storeStaffId },
      data,
      include: {
        user: true,
        role: true,
      },
    });
  }

  async acceptInvitationAtomic(storeStaffId: bigint, userId: bigint) {
    const res = await this.prisma.storeStaff.updateMany({
      where: {
        storeStaffId,
        userId,
        status: 'PENDING',
      },
      data: {
        status: 'ACTIVE',
        joinedAt: new Date(),
        leftAt: null,
      },
    });

    if (res.count === 0) {
      return null;
    }

    return this.findStaffById(storeStaffId);
  }

  async deleteStaff(
    storeStaffId: bigint,
    actorUserId?: bigint | null,
    revocationTimestamp?: Date,
  ) {
    const targetRef = await this.prisma.storeStaff.findUnique({
      where: { storeStaffId },
      select: { storeStaffId: true, userId: true },
    });
    if (!targetRef) {
      return null;
    }

    return this.prisma.$transaction(async (tx) => {
      // Canonical lock order: ALWAYS lock users row FIRST before touching store_staff
      const existingWatermark = await lockUserForWatermark(tx, targetRef.userId);

      const existing = await tx.storeStaff.findUnique({
        where: { storeStaffId },
        include: {
          user: true,
          role: true,
        },
      });
      if (!existing) {
        return null;
      }

      const now = revocationTimestamp ?? new Date();
      const updated = await tx.storeStaff.update({
        where: { storeStaffId },
        data: {
          status: 'TERMINATED',
          leftAt: existing.leftAt ?? now,
        },
        include: {
          user: true,
          role: true,
        },
      });

      if ((tx as any).rentalAuditLog?.create) {
        await (tx as any).rentalAuditLog.create({
          data: {
            actorType: 'STORE_OWNER_OR_ADMIN',
            actorUserId: actorUserId ?? null,
            action: 'TERMINATE_STORE_STAFF',
            targetType: 'STORE_STAFF',
            targetId: storeStaffId,
            beforeState: existing.status,
            afterState: 'TERMINATED',
            reason: 'Ngừng/thu hồi membership nhân viên cửa hàng (bảo toàn lịch sử)',
            metadata: {
              storeId: existing.storeId.toString(),
              staffUserId: existing.userId.toString(),
              roleCode: existing.role?.roleCode || null,
              terminatedAt: now.toISOString(),
            },
          },
        });
      }

      if (existing.status === 'ACTIVE') {
        await tx.refreshToken.updateMany({
          where: { userId: existing.userId, isRevoked: false },
          data: { isRevoked: true },
        });
        await advanceMonotonicTokensInvalidBefore(
          tx,
          existing.userId,
          existingWatermark,
          now,
        );
      }

      return updated;
    });
  }

  async findStore(storeId: bigint) {
    return this.prisma.store.findUnique({
      where: { storeId },
    });
  }

  async countOwnedStores(userId: bigint): Promise<number> {
    return this.prisma.store.count({
      where: { ownerUserId: userId, status: 'ACTIVE' },
    });
  }

  async findUserActivePlatformRoles(userId: bigint): Promise<string[]> {
    const staffs = await this.prisma.storeStaff.findMany({
      where: { userId, status: 'ACTIVE' },
      include: { role: true },
    });
    return staffs.map((s) => s.role.roleCode);
  }
}
