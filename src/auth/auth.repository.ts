import { Injectable, Inject } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AuthRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async findByEmail(email: string) {
    return this.prisma.user.findUnique({
      where: { email },
    });
  }

  async findByUsername(username: string) {
    return this.prisma.user.findUnique({
      where: { username },
    });
  }

  async findById(userId: bigint) {
    return this.prisma.user.findUnique({
      where: { userId },
      include: {
        ownedStores: true,
        customerProfile: {
          include: {
            addresses: true,
            iotButtons: {
              include: {
                buttonProducts: { include: { product: true } },
                store: true,
              },
            },
          },
        },
        storeStaffs: {
          include: {
            role: true,
            store: true,
          },
        },
      },
    });
  }

  async findUserWithAuthRelations(identifier: string) {
    return this.prisma.user.findFirst({
      where: {
        OR: [{ email: identifier }, { username: identifier }],
      },
      include: {
        customerProfile: { include: { addresses: true } },
        ownedStores: true,
        storeStaffs: { include: { role: true, store: true } },
      },
    });
  }

  async countByEmail(email: string): Promise<number> {
    return this.prisma.user.count({
      where: { email },
    });
  }

  async countByUsername(username: string): Promise<number> {
    return this.prisma.user.count({
      where: { username },
    });
  }

  async createUser(data: {
    username: string;
    email: string;
    passwordHash: string;
    fullName: string;
    phone?: string | null;
    status: string;
  }) {
    return this.prisma.user.create({
      data,
    });
  }

  async createStoreWithOwner(data: {
    ownerUserId: bigint;
    name: string;
    code: string;
    phone: string;
    email: string;
    address: string;
    status: string;
  }) {
    return this.prisma.store.create({
      data,
    });
  }

  async findRoleByCode(roleCode: string) {
    return this.prisma.role.findUnique({
      where: { roleCode },
    });
  }

  async createRole(data: { roleCode: string; roleName: string; description: string }) {
    return this.prisma.role.create({
      data,
    });
  }

  async createStoreStaff(data: {
    storeId: bigint;
    userId: bigint;
    roleId: bigint;
    status: string;
  }) {
    return this.prisma.storeStaff.create({
      data,
    });
  }

  async createCustomerProfile(data: { userId: bigint; phone?: string | null }) {
    return this.prisma.customerProfile.create({
      data,
    });
  }

  async createCustomerAddress(data: {
    customerId: bigint;
    recipientName: string;
    phone: string;
    addressDetail: string;
    isDefault: boolean;
  }) {
    return this.prisma.customerAddress.create({
      data,
    });
  }

  async setPasswordResetToken(userId: bigint, tokenHash: string, expiresAt: Date) {
    return this.prisma.user.update({
      where: { userId },
      data: {
        passwordResetToken: tokenHash,
        passwordResetExpiresAt: expiresAt,
      },
    });
  }

  async findByPasswordResetToken(tokenHash: string) {
    return this.prisma.user.findFirst({
      where: {
        passwordResetToken: tokenHash,
        passwordResetExpiresAt: {
          gt: new Date(),
        },
      },
    });
  }

  async updatePasswordAndClearResetToken(userId: bigint, newPasswordHash: string) {
    return this.prisma.user.update({
      where: { userId },
      data: {
        passwordHash: newPasswordHash,
        passwordResetToken: null,
        passwordResetExpiresAt: null,
      },
    });
  }

  // --- Email Verification Methods ---
  async setEmailVerificationToken(userId: bigint, tokenHash: string, expiresAt: Date) {
    return this.prisma.user.update({
      where: { userId },
      data: {
        emailVerificationToken: tokenHash,
        emailVerificationExpiresAt: expiresAt,
      },
    });
  }

  async findByEmailVerificationToken(tokenHash: string) {
    return this.prisma.user.findFirst({
      where: {
        emailVerificationToken: tokenHash,
        emailVerificationExpiresAt: {
          gt: new Date(),
        },
      },
    });
  }

  async markEmailVerified(userId: bigint) {
    return this.prisma.user.update({
      where: { userId },
      data: {
        status: 'ACTIVE',
        emailVerificationToken: null,
        emailVerificationExpiresAt: null,
      },
    });
  }

  // --- Refresh Token Rotation Methods ---
  async createRefreshToken(userId: bigint, tokenHash: string, expiresAt: Date) {
    return this.prisma.refreshToken.create({
      data: {
        userId,
        tokenHash,
        expiresAt,
        isRevoked: false,
      },
    });
  }

  async findRefreshToken(tokenHash: string) {
    return this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });
  }

  async revokeRefreshToken(tokenHash: string) {
    return this.prisma.refreshToken.updateMany({
      where: { tokenHash },
      data: { isRevoked: true },
    });
  }

  async revokeAllUserRefreshTokens(userId: bigint) {
    return this.prisma.refreshToken.updateMany({
      where: { userId },
      data: { isRevoked: true },
    });
  }
}

