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
        storeStaffs: { where: { status: 'ACTIVE' }, include: { role: true, store: true } },
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
    email?: string | null;
    passwordHash?: string | null;
    fullName: string;
    avatarUrl?: string | null;
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

    async verifyEmailAtomicTx(params: {
    tokenHash: string;
    email?: string;
  }): Promise<{ success: boolean; user?: any; reason?: string }> {
    const normalizedEmail = params.email ? params.email.toLowerCase().trim() : null;

    return this.prisma.$transaction(async (tx) => {
      const rows: any[] = await tx.$queryRawUnsafe(
        `UPDATE auth_otps
         SET consumed_at = NOW()
         WHERE id = (
           SELECT id FROM auth_otps
           WHERE token_hash = $1
             AND purpose = 'EMAIL_VERIFICATION'
             AND ($2::text IS NULL OR LOWER(email) = LOWER($2))
             AND consumed_at IS NULL
             AND expires_at > CURRENT_TIMESTAMP
             AND attempts < max_attempts
           ORDER BY id DESC
           LIMIT 1
           FOR UPDATE
         )
         RETURNING id, user_id, email;`,
        params.tokenHash,
        normalizedEmail,
      );

      if (!rows || rows.length === 0) {
        return { success: false, reason: 'Mã xác thực không hợp lệ hoặc đã được sử dụng.' };
      }

      const otp = rows[0];
      const targetUserId = BigInt(otp.user_id);

      const user = await tx.user.update({
        where: { userId: targetUserId },
        data: {
          status: 'ACTIVE',
          emailVerificationToken: null,
          emailVerificationExpiresAt: null,
        },
      });

      return { success: true, user };
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
        storeStaffs: { where: { status: 'ACTIVE' }, include: { role: true, store: true } },
      },
    });
  }

  async findByProviderSubject(authProvider: string, providerSubject: string) {
    return this.prisma.user.findFirst({
      where: { authProvider, providerSubject },
      include: {
        customerProfile: { include: { addresses: true } },
        ownedStores: true,
        storeStaffs: { where: { status: 'ACTIVE' }, include: { role: true, store: true } },
      },
    });
  }

  async linkProviderSubject(userId: bigint, authProvider: string, providerSubject: string) {
    return this.prisma.user.update({
      where: { userId },
      data: { authProvider, providerSubject },
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

  async updatePasswordTx(userId: bigint, newPasswordHash: string, passwordChangedAt: Date) {
    return this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { userId },
        data: {
          passwordHash: newPasswordHash,
          passwordChangedAt,
          updatedAt: new Date(),
        },
      });
      await tx.refreshToken.updateMany({
        where: { userId },
        data: { isRevoked: true },
      });
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
           AND expires_at > CURRENT_TIMESTAMP
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
           AND expires_at > CURRENT_TIMESTAMP
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
        },
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

  async atomicResetPasswordWithOtpTx(params: {
    tokenHash: string;
    purpose: string;
    email?: string;
    newPasswordHash: string;
  }): Promise<{ success: boolean; userId?: any; reason?: string }> {
    const normalizedEmail = params.email ? params.email.toLowerCase().trim() : null;

    return this.prisma.$transaction(async (tx) => {
      // 1. Pessimistic lock and verify OTP
      const otps = await tx.$queryRawUnsafe<any[]>(
        `SELECT id, user_id, email, attempts, max_attempts, expires_at, consumed_at
         FROM auth_otps
         WHERE token_hash = $1
           AND purpose = $2
           AND ($3::text IS NULL OR LOWER(email) = LOWER($3))
           AND consumed_at IS NULL
         ORDER BY id DESC
         LIMIT 1
         FOR UPDATE`,
        params.tokenHash,
        params.purpose,
        normalizedEmail,
      );

      if (!otps || otps.length === 0) {
        if (normalizedEmail) {
          await tx.$executeRawUnsafe(
            `UPDATE auth_otps
             SET attempts = attempts + 1
             WHERE LOWER(email) = LOWER($1)
               AND purpose = $2
               AND consumed_at IS NULL`,
            normalizedEmail,
            params.purpose,
          );
        }
        return { success: false, reason: 'Mã xác thực không hợp lệ hoặc đã được sử dụng.' };
      }

      const otp = otps[0];
      if (otp.attempts >= otp.max_attempts) {
        return { success: false, reason: 'Mã OTP đã bị vô hiệu hóa do thử sai quá nhiều lần.' };
      }
      if (new Date(otp.expires_at) <= new Date()) {
        return { success: false, reason: 'Mã OTP đã hết hạn. Vui lòng yêu cầu mã mới.' };
      }

      // 2. Consume OTP inside same transaction
      await tx.$executeRawUnsafe(
        `UPDATE auth_otps SET consumed_at = NOW() WHERE id = $1`,
        otp.id,
      );

      // 3. Update User password
      await tx.user.update({
        where: { userId: BigInt(otp.user_id) },
        data: {
          passwordHash: params.newPasswordHash,
          passwordResetToken: null,
          passwordResetExpiresAt: null,
          passwordChangedAt: new Date(),
        },
      });

      // 4. Revoke all refresh tokens
      await tx.refreshToken.updateMany({
        where: { userId: BigInt(otp.user_id), isRevoked: false },
        data: { isRevoked: true },
      });

      return { success: true, userId: otp.user_id };
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

  async deactivateUserFcmTokens(userId: bigint, token?: string) {
    if (token && token.trim().length > 0) {
      return (this.prisma as any).userFcmToken.updateMany({
        where: {
          userId,
          token: token.trim(),
        },
        data: {
          isActive: false,
          updatedAt: new Date(),
        },
      });
    }
    return (this.prisma as any).userFcmToken.updateMany({
      where: {
        userId,
        isActive: true,
      },
      data: {
        isActive: false,
        updatedAt: new Date(),
      },
    });
  }

  async findByFirebaseUid(firebaseUid: string) {
    return this.prisma.user.findUnique({
      where: { firebaseUid },
    });
  }

  async updatePhoneVerification(
    userId: bigint,
    phoneNumber: string,
    firebaseUid: string,
    verifiedAt: Date,
  ) {
    return this.prisma.user.update({
      where: { userId },
      data: {
        phone: phoneNumber,
        firebaseUid,
        phoneVerifiedAt: verifiedAt,
      },
    });
  }

  async updateProfile(
    userId: bigint,
    data: {
      fullName?: string;
      avatarUrl?: string;
      phone?: string;
    },
  ) {
    return this.prisma.user.update({
      where: { userId },
      data: {
        ...(data.fullName !== undefined ? { fullName: data.fullName } : {}),
        ...(data.avatarUrl !== undefined ? { avatarUrl: data.avatarUrl } : {}),
        ...(data.phone !== undefined ? { phone: data.phone } : {}),
      },
      include: {
        customerProfile: { include: { addresses: true } },
        ownedStores: true,
        storeStaffs: { where: { status: 'ACTIVE' }, include: { role: true, store: true } },
      },
    });
  }

  async findByPhone(phone: string) {
    return this.prisma.user.findFirst({
      where: { phone },
      include: {
        customerProfile: { include: { addresses: true } },
        ownedStores: true,
        storeStaffs: { where: { status: 'ACTIVE' }, include: { role: true, store: true } },
      },
    });
  }

  async findUserByFirebaseUidWithRelations(firebaseUid: string) {
    return this.prisma.user.findUnique({
      where: { firebaseUid },
      include: {
        customerProfile: { include: { addresses: true } },
        ownedStores: true,
        storeStaffs: { where: { status: 'ACTIVE' }, include: { role: true, store: true } },
      },
    });
  }

  async registerByPhoneTx(params: {
    userData: {
      username: string;
      fullName: string;
      email?: string | null;
      phone: string;
      phoneVerifiedAt: Date;
      firebaseUid: string;
      status: string;
      passwordHash?: string | null;
    };
    customerProfileData: {
      phone: string;
    };
    refreshTokenData: {
      tokenHash: string;
      expiresAt: Date;
    };
  }) {
    return this.prisma.$transaction(async (tx) => {
      const newUser = await tx.user.create({
        data: params.userData,
      });

      const customerProfile = await tx.customerProfile.create({
        data: {
          ...params.customerProfileData,
          userId: newUser.userId,
        },
      });

      const refreshTokenRecord = await tx.refreshToken.create({
        data: {
          userId: newUser.userId,
          tokenHash: params.refreshTokenData.tokenHash,
          expiresAt: params.refreshTokenData.expiresAt,
        },
      });

      return { newUser, customerProfile, refreshTokenRecord };
    });
  }
}


