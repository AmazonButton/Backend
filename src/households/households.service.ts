import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class HouseholdsService {
  constructor(private readonly prisma: PrismaService) {}

  async getUserHouseholds(userId: string) {
    const members = await this.prisma.householdMember.findMany({
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
