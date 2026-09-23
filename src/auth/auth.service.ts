import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  BadRequestException,
  Inject,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import { AuthRepository } from './auth.repository';
import {
  RegisterDto,
  LoginDto,
  ForgotPasswordDto,
  ResetPasswordDto,
  VerifyEmailDto,
  ResendVerificationDto,
} from './dto/auth.dto';

@Injectable()
export class AuthService {
  private resendCooldowns = new Map<string, number>();

  constructor(
    @Inject(AuthRepository) private readonly authRepo: AuthRepository,
    @Inject(JwtService) private readonly jwtService: JwtService,
  ) {}

  /**
   * 1. Register new user (Global Customer or Store Owner)
   */
  async register(body: RegisterDto) {
    const email = body.email?.trim().toLowerCase();
    const username = body.username?.trim().toLowerCase();
    const { password, fullName, phone, role = 'CUSTOMER', storeName, address } = body;

    if (!email || !password || !fullName || !username) {
      throw new BadRequestException({
        success: false,
        code: 'MISSING_FIELDS',
        message: 'Vui lòng điền đầy đủ họ tên, tên đăng nhập, email và mật khẩu',
      });
    }

    // Check duplicate email
    const existingEmail = await this.authRepo.findByEmail(email);
    if (existingEmail) {
      throw new ConflictException({
        success: false,
        code: 'EMAIL_ALREADY_EXISTS',
        message: 'Email này đã được sử dụng.',
      });
    }

    // Check duplicate username
    const existingUsername = await this.authRepo.findByUsername(username);
    if (existingUsername) {
      throw new ConflictException({
        success: false,
        code: 'USERNAME_ALREADY_EXISTS',
        message: 'Username này đã được sử dụng.',
      });
    }

    // Hash password with bcryptjs (salt rounds 12)
    const passwordHash = await bcrypt.hash(password, 12);

    // Create Base User via AuthRepository
    const newUser = await this.authRepo.createUser({
      username,
      email,
      passwordHash,
      fullName,
      phone: phone || null,
      status: 'ACTIVE',
    });

    // Handle Store Owner registration
    if (role === 'STORE_OWNER') {
      if (!storeName) {
        throw new BadRequestException({
          success: false,
          code: 'MISSING_STORE_INFO',
          message: 'Vui lòng cung cấp tên cửa hàng',
        });
      }

      const storeCode = `STORE-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;
      const newStore = await this.authRepo.createStoreWithOwner({
        ownerUserId: newUser.userId,
        name: storeName,
        code: storeCode,
        phone: phone || '0900000000',
        email,
        address: address || 'Chưa cập nhật địa chỉ',
        status: 'ACTIVE',
      });

      // Ensure STORE_OWNER role exists
      let ownerRole = await this.authRepo.findRoleByCode('STORE_OWNER');
      if (!ownerRole) {
        ownerRole = await this.authRepo.createRole({
          roleCode: 'STORE_OWNER',
          roleName: 'Store Owner',
          description: 'Chủ cửa hàng, toàn quyền trên Store',
        });
      }

      // Create StoreStaff record
      await this.authRepo.createStoreStaff({
        storeId: newStore.storeId,
        userId: newUser.userId,
        roleId: ownerRole.roleId,
        status: 'ACTIVE',
      });

      const accessToken = this.jwtService.sign(
        {
          userId: newUser.userId.toString(),
          email: newUser.email,
          username: newUser.username,
          role: 'STORE_OWNER',
          storeId: newStore.storeId.toString(),
          customerProfileId: null,
        },
        { expiresIn: '7d' },
      );

      return {
        success: true,
        message: 'Đăng ký cửa hàng thành công!',
        accessToken,
        token: accessToken,
        data: {
          token: accessToken,
          user: {
            id: newUser.userId.toString(),
            userId: newUser.userId.toString(),
            email: newUser.email,
            username: newUser.username,
            fullName: newUser.fullName,
            role: 'STORE_OWNER',
            storeId: newStore.storeId.toString(),
          },
          store: {
            storeId: newStore.storeId.toString(),
            name: newStore.name,
            code: newStore.code,
          },
        },
      };
    }

    // Handle Global Customer registration
    const customerProfile = await this.authRepo.createCustomerProfile({
      userId: newUser.userId,
      phone: phone || null,
    });

    if (address) {
      await this.authRepo.createCustomerAddress({
        customerId: customerProfile.customerId,
        recipientName: fullName,
        phone: phone || '0900000000',
        addressDetail: address,
        isDefault: true,
      });
    }

    const accessToken = this.jwtService.sign(
      {
        userId: newUser.userId.toString(),
        email: newUser.email,
        username: newUser.username,
        role: 'CUSTOMER',
        storeId: null,
        customerProfileId: customerProfile.customerId.toString(),
      },
      { expiresIn: '7d' },
    );

    return {
      success: true,
      message: 'Tạo tài khoản khách hàng thành công!',
      accessToken,
      token: accessToken,
      data: {
        token: accessToken,
        user: {
          id: newUser.userId.toString(),
          userId: newUser.userId.toString(),
          email: newUser.email,
          username: newUser.username,
          fullName: newUser.fullName,
          role: 'CUSTOMER',
          customerProfileId: customerProfile.customerId.toString(),
        },
      },
    };
  }

  /**
   * 2. Login with email or username
   */
  async login(body: LoginDto, ip?: string, userAgent?: string) {
    const rawIdentifier = body.email?.trim().toLowerCase();
    const { password } = body;

    if (!rawIdentifier || !password) {
      throw new BadRequestException({
        success: false,
        code: 'INVALID_CREDENTIALS',
        message: 'Vui lòng nhập đầy đủ tài khoản và mật khẩu',
      });
    }

    const user = await this.authRepo.findUserWithAuthRelations(rawIdentifier);

    if (!user) {
      throw new UnauthorizedException({
        success: false,
        code: 'INVALID_CREDENTIALS',
        message: 'Email hoặc mật khẩu không chính xác.',
      });
    }

    if (user.status !== 'ACTIVE') {
      throw new UnauthorizedException({
        success: false,
        code: 'ACCOUNT_DISABLED',
        message: 'Tài khoản của bạn hiện đang bị khóa. Vui lòng liên hệ quản trị viên.',
      });
    }

    const isMatch = await bcrypt.compare(password, user.passwordHash);
    if (!isMatch) {
      throw new UnauthorizedException({
        success: false,
        code: 'INVALID_CREDENTIALS',
        message: 'Email hoặc mật khẩu không chính xác.',
      });
    }

    // Determine primary role & storeId
    let role = 'CUSTOMER';
    let storeId: string | null = null;
    const customerProfileId = user.customerProfile?.customerId ? user.customerProfile.customerId.toString() : null;

    if (user.username === 'admin' || user.email === 'admin@smartorder.local') {
      role = 'SUPER_ADMIN';
    } else if (user.ownedStores && user.ownedStores.length > 0) {
      role = 'STORE_OWNER';
      storeId = user.ownedStores[0].storeId.toString();
    } else if (user.storeStaffs && user.storeStaffs.length > 0) {
      role = user.storeStaffs[0].role?.roleCode || 'STORE_STAFF';
      storeId = user.storeStaffs[0].storeId.toString();
    }

    const accessToken = this.jwtService.sign(
      {
        userId: user.userId.toString(),
        email: user.email,
        username: user.username,
        role,
        storeId,
        customerProfileId,
      },
      { expiresIn: '1d' },
    );

    // Generate secure 40-byte raw refresh token and store SHA-256 hash in database
    const rawRefreshToken = crypto.randomBytes(40).toString('hex');
    const refreshTokenHash = crypto.createHash('sha256').update(rawRefreshToken).digest('hex');
    const refreshExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
    await this.authRepo.createRefreshToken(user.userId, refreshTokenHash, refreshExpiresAt);

    const userPayload = {
      id: user.userId.toString(),
      userId: user.userId.toString(),
      email: user.email,
      username: user.username,
      fullName: user.fullName,
      role,
      storeId,
      customerProfileId,
      phone: user.phone,
    };

    return {
      success: true,
      message: 'Đăng nhập thành công',
      accessToken,
      token: accessToken,
      refreshToken: rawRefreshToken,
      data: {
        token: accessToken,
        accessToken,
        refreshToken: rawRefreshToken,
        user: userPayload,
      },
      user: userPayload,
    };
  }

  /**
   * 3. Check duplicate email in realtime
   */
  async checkEmail(email: string) {
    const normalized = email?.trim().toLowerCase();
    if (!normalized) return { exists: false };
    const count = await this.authRepo.countByEmail(normalized);
    return { exists: count > 0 };
  }

  /**
   * 4. Check duplicate username in realtime
   */
  async checkUsername(username: string) {
    const normalized = username?.trim().toLowerCase();
    if (!normalized) return { exists: false };
    const count = await this.authRepo.countByUsername(normalized);
    return { exists: count > 0 };
  }

  /**
   * 5. Refresh token (Database-backed SHA-256 Token Rotation)
   */
  async refresh(refreshToken: string, ip?: string, userAgent?: string) {
    if (!refreshToken) {
      throw new UnauthorizedException({
        success: false,
        code: 'INVALID_TOKEN',
        message: 'Thiếu refresh token',
      });
    }

    try {
      const cleanToken = refreshToken.trim();
      const tokenHash = crypto.createHash('sha256').update(cleanToken).digest('hex');
      const storedToken = await this.authRepo.findRefreshToken(tokenHash);

      let user: any = null;
      let role = 'CUSTOMER';
      let storeId: string | null = null;
      let customerProfileId: string | null = null;

      if (storedToken) {
        if (storedToken.isRevoked || storedToken.expiresAt < new Date()) {
          throw new UnauthorizedException('Refresh token không hợp lệ hoặc đã bị thu hồi/hết hạn');
        }

        // Revoke the old refresh token (Single-use rotation)
        await this.authRepo.revokeRefreshToken(tokenHash);
        user = await this.authRepo.findById(storedToken.userId);
      } else {
        // Fallback for JWT format tokens
        const payload = this.jwtService.verify(cleanToken);
        user = await this.authRepo.findById(BigInt(payload.userId));
      }

      if (!user || user.status !== 'ACTIVE') {
        throw new UnauthorizedException('Tài khoản không tồn tại hoặc đã bị khóa');
      }

      if (user.username === 'admin' || user.email === 'admin@smartorder.local') {
        role = 'SUPER_ADMIN';
      } else if (user.ownedStores && user.ownedStores.length > 0) {
        role = 'STORE_OWNER';
        storeId = user.ownedStores[0].storeId.toString();
      } else if (user.storeStaffs && user.storeStaffs.length > 0) {
        role = user.storeStaffs[0].role?.roleCode || 'STORE_STAFF';
        storeId = user.storeStaffs[0].storeId.toString();
      }
      customerProfileId = user.customerProfile?.customerId?.toString() || null;

      const newAccessToken = this.jwtService.sign(
        {
          userId: user.userId.toString(),
          email: user.email,
          username: user.username,
          role,
          storeId,
          customerProfileId,
        },
        { expiresIn: '1d' },
      );

      // Issue new rotated raw refresh token
      const newRawRefreshToken = crypto.randomBytes(40).toString('hex');
      const newRefreshTokenHash = crypto.createHash('sha256').update(newRawRefreshToken).digest('hex');
      const newRefreshExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      await this.authRepo.createRefreshToken(user.userId, newRefreshTokenHash, newRefreshExpiresAt);

      return {
        success: true,
        message: 'Làm mới token thành công',
        accessToken: newAccessToken,
        token: newAccessToken,
        refreshToken: newRawRefreshToken,
        data: {
          token: newAccessToken,
          accessToken: newAccessToken,
          refreshToken: newRawRefreshToken,
        },
      };
    } catch (err: any) {
      if (err instanceof UnauthorizedException) throw err;
      throw new UnauthorizedException('Token không hợp lệ hoặc đã hết hạn');
    }
  }

  /**
   * 6. Logout (Token Revocation & Invalidation)
   */
  async logout(userId?: string, refreshToken?: string) {
    if (refreshToken) {
      const hash = crypto.createHash('sha256').update(refreshToken.trim()).digest('hex');
      await this.authRepo.revokeRefreshToken(hash);
    }
    if (userId) {
      await this.authRepo.revokeAllUserRefreshTokens(BigInt(userId));
    }
    return {
      success: true,
      message: 'Đăng xuất thành công. Toàn bộ phiên đăng nhập đã được vô hiệu hóa an toàn.',
    };
  }

  /**
   * 7. Forgot Password (SHA-256 Hashed Token + Anti-Timing Enumeration)
   */
  async forgotPassword(body: ForgotPasswordDto) {
    const email = body.email?.trim().toLowerCase();
    if (!email) {
      return {
        success: true,
        message: 'Nếu email tồn tại trong hệ thống, chúng tôi đã gửi hướng dẫn đặt lại mật khẩu.',
      };
    }

    const user = await this.authRepo.findByEmail(email);
    if (user && user.status === 'ACTIVE') {
      // 1. Generate unguessable 32-byte raw token
      const rawToken = crypto.randomBytes(32).toString('hex');
      // 2. Hash token with SHA-256 before storing in database
      const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15-minute validity

      await this.authRepo.setPasswordResetToken(user.userId, tokenHash, expiresAt);

      // In production: send email with reset link containing rawToken
      // console.log for verification in dev
      console.log(`[AUTH] Password reset requested for ${user.email}. Demo Raw Token: ${rawToken}`);
    }

    // Anti-Enumeration: Always respond with identical message and 200 OK
    return {
      success: true,
      message: 'Nếu email tồn tại trong hệ thống, chúng tôi đã gửi hướng dẫn đặt lại mật khẩu.',
    };
  }

  /**
   * 8. Reset Password with Token (SHA-256 Verification + Single-Use Invalidation)
   */
  async resetPassword(body: ResetPasswordDto) {
    const { token, newPassword } = body;
    if (!token || !newPassword) {
      throw new BadRequestException({
        success: false,
        message: 'Thiếu thông tin mã xác thực hoặc mật khẩu mới',
      });
    }

    // Hash the incoming raw token with SHA-256 to compare against stored hash
    const tokenHash = crypto.createHash('sha256').update(token.trim()).digest('hex');

    const user = await this.authRepo.findByPasswordResetToken(tokenHash);
    if (!user) {
      throw new BadRequestException({
        success: false,
        message: 'Mã đặt lại mật khẩu không hợp lệ hoặc đã hết hạn',
      });
    }

    // Hash new password with bcrypt (salt rounds 12)
    const newPasswordHash = await bcrypt.hash(newPassword, 12);

    // Update password and invalidate reset token immediately (single-use)
    await this.authRepo.updatePasswordAndClearResetToken(user.userId, newPasswordHash);

    return {
      success: true,
      message: 'Mật khẩu đã được cập nhật thành công. Vui lòng đăng nhập lại.',
    };
  }

  /**
   * 9. Verify Email (SHA-256 Hashed Token Verification)
   */
  async verifyEmail(body: VerifyEmailDto) {
    const { token } = body;
    if (!token) {
      throw new BadRequestException('Vui lòng cung cấp mã xác minh email');
    }

    const tokenHash = crypto.createHash('sha256').update(token.trim()).digest('hex');
    const user = await this.authRepo.findByEmailVerificationToken(tokenHash);

    if (!user) {
      throw new BadRequestException('Mã xác minh email không hợp lệ hoặc đã hết hạn');
    }

    await this.authRepo.markEmailVerified(user.userId);

    return {
      success: true,
      message: 'Xác minh email thành công! Bạn có thể đăng nhập ngay bây giờ.',
    };
  }

  /**
   * 10. Resend Verification (Anti-Timing Enumeration)
   */
  async resendVerification(body: ResendVerificationDto) {
    const email = body.email?.trim().toLowerCase();
    if (email) {
      const user = await this.authRepo.findByEmail(email);
      if (user) {
        const rawToken = crypto.randomBytes(32).toString('hex');
        const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours
        await this.authRepo.setEmailVerificationToken(user.userId, tokenHash, expiresAt);
        console.log(`[AUTH] Resent email verification for ${user.email}. Demo Raw Token: ${rawToken}`);
      }
    }

    return {
      success: true,
      message: 'Nếu tài khoản chưa xác minh, chúng tôi đã gửi lại email xác nhận mới.',
    };
  }

  /**
   * 11. Get current authenticated user
   */
  async getMe(userId: string | number | bigint) {
    if (!userId) {
      return { success: false, data: null };
    }

    const user = await this.authRepo.findById(BigInt(userId));

    if (!user) {
      return { success: false, data: null };
    }

    let role = 'CUSTOMER';
    let storeId: string | null = null;
    if (user.username === 'admin' || user.email === 'admin@smartorder.local') {
      role = 'SUPER_ADMIN';
    } else if (user.ownedStores.length > 0) {
      role = 'STORE_OWNER';
      storeId = user.ownedStores[0].storeId.toString();
    } else if (user.storeStaffs.length > 0) {
      role = user.storeStaffs[0].role?.roleCode || 'STORE_STAFF';
      storeId = user.storeStaffs[0].storeId.toString();
    }

    return {
      success: true,
      data: {
        id: user.userId.toString(),
        userId: user.userId.toString(),
        email: user.email,
        username: user.username,
        fullName: user.fullName,
        phone: user.phone,
        role,
        status: user.status,
        storeId,
        customerProfileId: user.customerProfile?.customerId?.toString() || null,
        customerProfile: user.customerProfile,
        ownedStores: user.ownedStores,
        storeStaffs: user.storeStaffs,
        createdAt: user.createdAt,
      },
    };
  }
}
