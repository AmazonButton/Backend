import { Injectable, NotFoundException, ForbiddenException, BadRequestException, Inject } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class HouseholdsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  async getUserHouseholds(userId: string) {
    let members = await this.prisma.householdMember.findMany({
      where: { userId },
      include: {
        household: {
          include: {
            members: {
              include: {
                user: {
                  select: { id: true, fullName: true, email: true, phone: true, role: true },
                },
              },
            },
            devices: {
              include: {
                configuration: {
                  include: { product: true },
                },
              },
            },
            reminders: {
              where: { status: 'PENDING' },
              include: { product: true },
            },
            shoppingList: {
              include: {
                items: {
                  include: { product: true },
                },
              },
            },
          },
        },
      },
      orderBy: { joinedAt: 'asc' },
    });

    // Auto-provision a default Household if none exists yet for this user
    if (members.length === 0) {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        include: { customerProfile: true },
      });

      if (user) {
        const householdName = user.customerProfile?.apartment 
          ? `Căn hộ ${user.customerProfile.apartment}` 
          : `Gia đình ${user.fullName || 'của tôi'}`;

        const newHousehold = await this.prisma.household.create({
          data: {
            name: householdName,
            address: user.customerProfile?.deliveryAddress || 'TP. Hồ Chí Minh',
            apartment: user.customerProfile?.apartment || 'Căn hộ gia đình',
            phone: user.phone || user.customerProfile?.phone,
            shoppingList: { create: {} },
            members: {
              create: {
                userId: user.id,
                role: 'OWNER',
                nickname: 'Chủ hộ',
              },
            },
          },
          include: {
            members: {
              include: {
                user: {
                  select: { id: true, fullName: true, email: true, phone: true, role: true },
                },
              },
            },
            devices: {
              include: {
                configuration: {
                  include: { product: true },
                },
              },
            },
            reminders: {
              where: { status: 'PENDING' },
              include: { product: true },
            },
            shoppingList: {
              include: {
                items: {
                  include: { product: true },
                },
              },
            },
          },
        });

        // Link any orphan customer devices to this household
        if (user.customerProfile?.id) {
          await this.prisma.device.updateMany({
            where: { customerId: user.customerProfile.id, householdId: null },
            data: { householdId: newHousehold.id },
          });
        }

        return [{
          membership: {
            role: 'OWNER',
            nickname: 'Chủ hộ',
            joinedAt: new Date(),
          },
          ...newHousehold,
        }];
      }
    }

    return members.map((m) => ({
      membership: {
        role: m.role,
        nickname: m.nickname,
        joinedAt: m.joinedAt,
      },
      ...m.household,
    }));
  }

  async getHouseholdDetails(householdId: string, userId: string) {
    const member = await this.prisma.householdMember.findUnique({
      where: { householdId_userId: { householdId, userId } },
    });

    if (!member) {
      throw new ForbiddenException('Bạn không thuộc gia đình/căn hộ này.');
    }

    const household = await this.prisma.household.findUnique({
      where: { id: householdId },
      include: {
        members: {
          include: {
            user: {
              select: { id: true, fullName: true, email: true, phone: true },
            },
          },
        },
        devices: {
          include: {
            configuration: {
              include: { product: true },
            },
          },
        },
        reminders: {
          include: { product: true },
          orderBy: { expectedDate: 'asc' },
        },
        shoppingList: {
          include: {
            items: {
              include: { product: true },
            },
          },
        },
        serviceRequests: {
          orderBy: { createdAt: 'desc' },
          take: 10,
        },
        urgentAlerts: {
          where: { status: 'ACTIVE' },
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!household) {
      throw new NotFoundException('Không tìm thấy căn hộ/gia đình.');
    }

    return {
      currentMemberRole: member.role,
      ...household,
    };
  }

  async updateMemberRole(householdId: string, currentUserId: string, targetUserId: string, newRole: string) {
    const currentMember = await this.prisma.householdMember.findUnique({
      where: { householdId_userId: { householdId, userId: currentUserId } },
    });

    if (!currentMember || (currentMember.role !== 'OWNER' && currentMember.role !== 'ADMIN')) {
      throw new ForbiddenException('Chỉ Chủ hộ hoặc Quản trị viên mới có quyền cập nhật vai trò thành viên.');
    }

    return this.prisma.householdMember.update({
      where: { householdId_userId: { householdId, userId: targetUserId } },
      data: { role: newRole },
    });
  }

  async addMember(householdId: string, currentUserId: string, email: string, role: string = 'MEMBER', nickname?: string) {
    const currentMember = await this.prisma.householdMember.findUnique({
      where: { householdId_userId: { householdId, userId: currentUserId } },
    });

    if (!currentMember || (currentMember.role !== 'OWNER' && currentMember.role !== 'ADMIN')) {
      throw new ForbiddenException('Chỉ Chủ hộ hoặc Quản trị viên mới có quyền mời thành viên mới.');
    }

    const targetUser = await this.prisma.user.findUnique({
      where: { email },
    });

    if (!targetUser) {
      throw new NotFoundException('Không tìm thấy tài khoản với email này.');
    }

    const existing = await this.prisma.householdMember.findUnique({
      where: { householdId_userId: { householdId, userId: targetUser.id } },
    });

    if (existing) {
      throw new BadRequestException('Người dùng đã là thành viên của gia đình.');
    }

    return this.prisma.householdMember.create({
      data: {
        householdId,
        userId: targetUser.id,
        role,
        nickname: nickname || targetUser.fullName,
      },
    });
  }

  async removeMember(householdId: string, currentUserId: string, targetUserId: string) {
    const currentMember = await this.prisma.householdMember.findUnique({
      where: { householdId_userId: { householdId, userId: currentUserId } },
    });

    if (!currentMember || (currentMember.role !== 'OWNER' && currentMember.role !== 'ADMIN')) {
      throw new ForbiddenException('Không có quyền xóa thành viên.');
    }

    if (currentUserId === targetUserId) {
      throw new BadRequestException('Chủ hộ không thể tự xóa chính mình khỏi gia đình.');
    }

    return this.prisma.householdMember.delete({
      where: { householdId_userId: { householdId, userId: targetUserId } },
    });
  }
}
