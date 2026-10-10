import { Injectable, Inject, UnauthorizedException } from '@nestjs/common';
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
    authId?: string | null;
    emailVerificationToken?: string | null;
    emailVerificationExpiresAt?: Date | null;
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

  async markEmailVerified(userId: bigint, otpId?: bigint) {
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.update({
        where: { userId },
        data: {
          status: 'ACTIVE',
          emailVerificationToken: null,
          emailVerificationExpiresAt: null,
        },
      });

      if (otpId) {
        await tx.authOtp.update({
          where: { id: otpId },
          data: { consumedAt: new Date() },
        });
      }

      return user;
    });
  }

  // --- Refresh Token Rotation Methods ---

  async updateAuthId(userId: bigint, authId: string) {
    return this.prisma.user.update({
      where: { userId },
      data: { authId },
    });
  }

  async findByAuthId(authId: string) {
    return this.prisma.user.findUnique({
      where: { authId },
      include: {
        customerProfile: { include: { addresses: true } },
        ownedStores: true,
        storeStaffs: { include: { role: true, store: true } },
      },
    });
  }

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

  async registerStoreOwnerTx(userData: any, storeData: any, roleData: any) {
    return this.prisma.$transaction(async (tx) => {
      const newUser = await tx.user.create({ data: userData });
      const newStore = await tx.store.create({
        data: { ...storeData, ownerUserId: newUser.userId },
      });
      let ownerRole = await tx.role.findUnique({ where: { roleCode: 'STORE_OWNER' } });
      if (!ownerRole) {
        ownerRole = await tx.role.create({ data: roleData });
      }
      await tx.storeStaff.create({
        data: {
          storeId: newStore.storeId,
          userId: newUser.userId,
          roleId: ownerRole.roleId,
          status: 'ACTIVE',
        },
      });
      return { newUser, newStore, ownerRole };
    });
  }

  async registerCustomerTx(userData: any, customerProfileData: any, addressData?: any) {
    return this.prisma.$transaction(async (tx) => {
      const newUser = await tx.user.create({ data: userData });
      const customerProfile = await tx.customerProfile.create({
        data: { ...customerProfileData, userId: newUser.userId },
      });
      let customerAddress = null;
      if (addressData) {
        customerAddress = await tx.customerAddress.create({
          data: { ...addressData, customerId: customerProfile.customerId },
        });
      }
      return { newUser, customerProfile, customerAddress };
    });
  }

  async rotateRefreshToken(oldTokenHash: string, newTokenData: any) {
    return this.prisma.$transaction(async (tx) => {
      const updateResult = await tx.refreshToken.updateMany({
        where: { tokenHash: oldTokenHash, isRevoked: false },
        data: { isRevoked: true },
      });
      if (updateResult.count === 0) {
        throw new UnauthorizedException('Refresh token không hợp lệ hoặc đã bị thu hồi/hết hạn');
      }
      return tx.refreshToken.create({
        data: newTokenData,
      });
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

  // --- Dedicated OTP Table Methods (Atomic & Peppered) ---
  async createAuthOtp(data: {
    userId?: bigint;
    email: string;
    purpose: string;
    tokenHash: string;
    expiresAt: Date;
    maxAttempts?: number;
  }) {
    return this.prisma.authOtp.create({
      data: {
        userId: data.userId || null,
        email: data.email.toLowerCase().trim(),
        purpose: data.purpose,
        tokenHash: data.tokenHash,
        expiresAt: data.expiresAt,
        maxAttempts: data.maxAttempts || 5,
        attempts: 0,
      },
    });
  }

  async consumeOtpAtomically(params: {
    tokenHash: string;
    purpose: string;
    email?: string;
  }): Promise<{ success: boolean; otp?: any; reason?: string }> {
    const normalizedEmail = params.email ? params.email.toLowerCase().trim() : null;

    // Atomic update using SELECT ... FOR UPDATE in raw SQL
    const result = await this.prisma.$queryRawUnsafe<any[]>(
      `UPDATE auth_otps
       SET consumed_at = NOW()
       WHERE id = (
         SELECT id FROM auth_otps
         WHERE token_hash = $1
           AND purpose = $2
           AND ($3::text IS NULL OR LOWER(email) = LOWER($3))
           AND consumed_at IS NULL
           AND expires_at > NOW()
           AND attempts < max_attempts
         ORDER BY id DESC
         LIMIT 1
         FOR UPDATE
       )
       RETURNING id, user_id, email, attempts, max_attempts;`,
      params.tokenHash,
      params.purpose,
      normalizedEmail,
    );

    if (result && result.length > 0) {
      return { success: true, otp: result[0] };
    }

    if (normalizedEmail) {
      await this.prisma.$executeRawUnsafe(
        `UPDATE auth_otps
         SET attempts = attempts + 1
         WHERE LOWER(email) = LOWER($1)
           AND purpose = $2
           AND consumed_at IS NULL
           AND expires_at > NOW()
           AND attempts < max_attempts;`,
        normalizedEmail,
        params.purpose,
      );

      const existingOtp = await this.prisma.authOtp.findFirst({
        where: {
          email: { equals: normalizedEmail, mode: 'insensitive' },
          purpose: params.purpose,
        },
        orderBy: { id: 'desc' },
      });

      if (existingOtp) {
        if (existingOtp.attempts >= existingOtp.maxAttempts) {
          return { success: false, reason: 'Mã OTP đã bị vô hiệu hóa do thử sai quá 5 lần. Vui lòng yêu cầu mã mới.' };
        }
        if (existingOtp.expiresAt <= new Date()) {
          return { success: false, reason: 'Mã OTP đã hết hạn. Vui lòng yêu cầu mã mới.' };
        }
      }
    }

    return { success: false, reason: 'Mã xác thực không hợp lệ hoặc đã được sử dụng.' };
  }

  async resetPasswordTx(params: {
    userId: bigint;
    newPasswordHash: string;
    otpId?: bigint;
  }) {
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.update({
        where: { userId: params.userId },
        data: {
          passwordHash: params.newPasswordHash,
          passwordResetToken: null,
          passwordResetExpiresAt: null,
          passwordChangedAt: new Date(),
        },
      });

      // Revoke all existing refresh tokens for this user
      await tx.refreshToken.updateMany({
        where: { userId: params.userId, isRevoked: false },
        data: { isRevoked: true },
      });

      if (params.otpId) {
        await tx.authOtp.update({
          where: { id: params.otpId },
          data: { consumedAt: new Date() },
        });
      }

      return user;
    });
  }

  async createGoogleUserTx(userData: any, customerProfileData: any) {
    return this.prisma.$transaction(async (tx) => {
      const newUser = await tx.user.create({ data: userData });
      const customerProfile = await tx.customerProfile.create({
        data: { ...customerProfileData, userId: newUser.userId },
      });
      return { newUser, customerProfile };
    });
  }

}
