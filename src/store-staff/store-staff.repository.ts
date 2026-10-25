import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

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

  async createStaff(data: { storeId: bigint; userId: bigint; roleId: bigint }) {
    return this.prisma.storeStaff.create({
      data: {
        storeId: data.storeId,
        userId: data.userId,
        roleId: data.roleId,
        status: 'ACTIVE',
      },
      include: {
        user: true,
        role: true,
      },
    });
  }

  async updateStaff(
    storeStaffId: bigint,
    data: { roleId?: bigint; status?: string; leftAt?: Date | null },
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

  async deleteStaff(storeStaffId: bigint) {
    return this.prisma.storeStaff.delete({
      where: { storeStaffId },
    });
  }

  async findStore(storeId: bigint) {
    return this.prisma.store.findUnique({
      where: { storeId },
    });
  }
}
