import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  ForbiddenException,
  BadRequestException,
  Inject,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
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
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(JwtService) private readonly jwtService: JwtService,
  ) {}

  private hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  /**
   * 1. Register new user (Customer or Store Owner)
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
    const existingEmail = await this.prisma.user.findUnique({ where: { email } });
    if (existingEmail) {
      throw new ConflictException({
        success: false,
        code: 'EMAIL_ALREADY_EXISTS',
        message: 'Email này đã được sử dụng.',
      });
    }

    // Check duplicate username
    const existingUsername = await this.prisma.user.findUnique({ where: { username } });
    if (existingUsername) {
      throw new ConflictException({
        success: false,
        code: 'USERNAME_ALREADY_EXISTS',
        message: 'Username này đã được sử dụng.',
      });
    }

    // Hash password with bcryptjs
    const passwordHash = await bcrypt.hash(password, 10);

    // Create verification token (24h)
    const rawVerificationToken = crypto.randomBytes(32).toString('hex');
    const verificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);

    // Handle Store Owner registration
    if (role === 'STORE_OWNER') {
      if (!storeName || !address) {
        throw new BadRequestException({
          success: false,
          code: 'MISSING_STORE_INFO',
          message: 'Vui lòng cung cấp tên cửa hàng và địa chỉ kinh doanh',
        });
      }

      const storeCode = `STORE-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;
      const newStore = await this.prisma.store.create({
        data: {
          name: storeName,
          code: storeCode,
          ownerName: fullName,
          phone: phone || '',
          email,
          address,
          status: 'PENDING_APPROVAL',
        },
      });

      const user = await this.prisma.user.create({
        data: {
          email,
          username,
          passwordHash,
          fullName,
          phone,
          role: 'STORE_OWNER',
          storeId: newStore.id,
          isActive: false, // Requires Super Admin approval
          emailVerified: true, // Direct verification for store accounts
        },
      });

      return {
        success: true,
        code: 'STORE_REGISTRATION_PENDING',
        message: 'Đăng ký thành công! Hồ sơ cửa hàng của bạn đang chờ Super Admin phê duyệt.',
        data: {
          userId: user.id,
          storeId: newStore.id,
          status: 'PENDING_APPROVAL',
        },
      };
    }

    // Handle Customer registration
    const targetStore = await this.prisma.store.findFirst({ where: { status: 'ACTIVE' } });

    const newUser = await this.prisma.user.create({
      data: {
        email,
        username,
        passwordHash,
        fullName,
        phone,
        role: 'CUSTOMER',
        storeId: targetStore?.id,
        emailVerified: false,
        emailVerificationToken: rawVerificationToken,
        emailVerificationExpires: verificationExpires,
      },
    });

    const customerProfile = await this.prisma.customerProfile.create({
      data: {
        userId: newUser.id,
        storeId: targetStore?.id || '',
        deliveryAddress: address || 'Chưa thiết lập địa chỉ giao hàng',
        phone: phone || '',
      },
    });

    console.log(
      `📧 [Email Service Mock] Link xác minh email cho ${newUser.email}: http://localhost:5173/verify-email?token=${rawVerificationToken}`,
    );

    return {
      success: true,
      message: 'Tạo tài khoản thành công! Chúng tôi đã gửi email xác minh đến địa chỉ email của bạn.',
      data: {
        user: {
          id: newUser.id,
          email: newUser.email,
          username: newUser.username,
          fullName: newUser.fullName,
          role: newUser.role,
          customerProfileId: customerProfile.id,
          emailVerified: newUser.emailVerified,
        },
        verificationToken: rawVerificationToken,
      },
    };
  }

  /**
   * 2. Login with email or username, password, lockout & session generation
   */
  async login(body: LoginDto, ip?: string, userAgent?: string) {
    const rawIdentifier = body.email?.trim().toLowerCase();
    const { password, rememberMe } = body;

    if (!rawIdentifier || !password) {
      throw new BadRequestException({
        success: false,
        code: 'INVALID_CREDENTIALS',
        message: 'Vui lòng nhập đầy đủ tài khoản và mật khẩu',
      });
    }

    // Disallow password that is only whitespace
    if (!password.trim()) {
      throw new UnauthorizedException({
        success: false,
        code: 'INVALID_CREDENTIALS',
        message: 'Email hoặc mật khẩu không chính xác.',
      });
    }

    // Lookup user by email OR username
    let user;
    try {
      user = await this.prisma.user.findFirst({
        where: {
          OR: [{ email: rawIdentifier }, { username: rawIdentifier }],
        },
        include: {
          store: true,
          customerProfile: true,
        },
      });
    } catch (err: any) {
      console.error('❌ [AuthService.login] Database error:', err);
      throw new HttpException(
        {
          success: false,
          code: 'DATABASE_ERROR',
          message: `Lỗi kết nối cơ sở dữ liệu: ${err.message || 'Không thể truy vấn bảng User'}`,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    // Anti-enumeration generic error
    if (!user) {
      throw new UnauthorizedException({
        success: false,
        code: 'INVALID_CREDENTIALS',
        message: 'Email hoặc mật khẩu không chính xác.',
      });
    }

    // Check account lockout
    if (user.lockedUntil && new Date(user.lockedUntil) > new Date()) {
      const remainingMinutes = Math.ceil(
        (new Date(user.lockedUntil).getTime() - Date.now()) / (60 * 1000),
      );
      throw new ForbiddenException({
        success: false,
        code: 'ACCOUNT_LOCKED',
        message: `Bạn đã thử đăng nhập quá nhiều lần. Vui lòng thử lại sau ${remainingMinutes} phút.`,
      });
    }

    // Check active status
    if (user.role === 'STORE_OWNER' && user.store?.status === 'PENDING_APPROVAL') {
      throw new ForbiddenException({
        success: false,
        code: 'ACCOUNT_PENDING_APPROVAL',
        message: 'Tài khoản cửa hàng đang chờ Super Admin xét duyệt. Vui lòng kiểm tra lại sau.',
      });
    }

    if (!user.isActive) {
      throw new ForbiddenException({
        success: false,
        code: 'ACCOUNT_DISABLED',
        message: 'Tài khoản của bạn hiện đang bị khóa. Vui lòng liên hệ quản trị viên.',
      });
    }

    // Verify password hash
    const isMatch = await bcrypt.compare(password, user.passwordHash);
    if (!isMatch) {
      const attempts = (user.failedLoginAttempts || 0) + 1;
      const lockoutTime =
        attempts >= 5 ? new Date(Date.now() + 15 * 60 * 1000) : null;

      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          failedLoginAttempts: attempts,
          lockedUntil: lockoutTime,
        },
      });

      if (attempts >= 5) {
        throw new ForbiddenException({
          success: false,
          code: 'ACCOUNT_LOCKED',
          message: 'Bạn đã thử đăng nhập quá nhiều lần. Tài khoản bị tạm khóa 15 phút.',
        });
      }

      throw new UnauthorizedException({
        success: false,
        code: 'INVALID_CREDENTIALS',
        message: 'Email hoặc mật khẩu không chính xác.',
      });
    }

    // Check email verification (seed users have emailVerified = true)
    if (!user.emailVerified) {
      throw new ForbiddenException({
        success: false,
        code: 'EMAIL_NOT_VERIFIED',
        message: 'Vui lòng xác minh email trước khi đăng nhập.',
      });
    }

    // Reset failed login attempts on success
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginAttempts: 0,
        lockedUntil: null,
        lastLoginAt: new Date(),
      },
    });

    // Generate short-lived Access Token (15 mins)
    const accessToken = this.jwtService.sign(
      {
        userId: user.id,
        role: user.role,
        storeId: user.storeId,
        email: user.email,
        username: user.username,
      },
      { expiresIn: '15m' },
    );

    // Generate long-lived cryptographically secure Refresh Token (7 days / 30 days)
    const rawRefreshToken = crypto.randomBytes(40).toString('hex');
    const refreshExpires = new Date(
      Date.now() + (rememberMe ? 30 : 7) * 24 * 60 * 60 * 1000,
    );
    const tokenHash = this.hashToken(rawRefreshToken);

    // Store refresh session in database
    await this.prisma.refreshSession.create({
      data: {
        userId: user.id,
        tokenHash,
        expiresAt: refreshExpires,
        ipAddress: ip || null,
        userAgent: userAgent || null,
      },
    });

    const userPayload = {
      id: user.id,
      email: user.email,
      username: user.username,
      fullName: user.fullName,
      role: user.role,
      storeId: user.storeId,
      store: user.store,
      customerProfileId: user.customerProfile?.id,
      emailVerified: user.emailVerified,
    };

    return {
      success: true,
      message: 'Đăng nhập thành công',
      accessToken,
      token: accessToken, // Backward compatibility for mobile & existing tests
      refreshToken: rawRefreshToken,
      expiresIn: 900,
      data: {
        token: accessToken,
        accessToken,
        refreshToken: rawRefreshToken,
        expiresIn: 900,
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
    const count = await this.prisma.user.count({
      where: { email: normalized },
    });
    return { exists: count > 0 };
  }

  /**
   * 4. Check duplicate username in realtime
   */
  async checkUsername(username: string) {
    const normalized = username?.trim().toLowerCase();
    if (!normalized) return { exists: false };
    const count = await this.prisma.user.count({
      where: { username: normalized },
    });
    return { exists: count > 0 };
  }

  /**
   * 5. Refresh token rotation
   */
  async refresh(refreshToken: string, ip?: string, userAgent?: string) {
    if (!refreshToken) {
      throw new UnauthorizedException({
        success: false,
        code: 'INVALID_TOKEN',
        message: 'Thiếu refresh token',
      });
    }

    const tokenHash = this.hashToken(refreshToken);
    const session = await this.prisma.refreshSession.findUnique({
      where: { tokenHash },
      include: {
        user: {
          include: {
            store: true,
            customerProfile: true,
          },
        },
      },
    });

    if (!session || session.revokedAt || new Date(session.expiresAt) < new Date()) {
      throw new UnauthorizedException({
        success: false,
        code: 'TOKEN_EXPIRED',
        message: 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.',
      });
    }

    if (!session.user.isActive) {
      throw new ForbiddenException({
        success: false,
        code: 'ACCOUNT_DISABLED',
        message: 'Tài khoản của bạn đã bị khóa hoặc tạm ngưng.',
      });
    }

    // Revoke old session (Rotation)
    await this.prisma.refreshSession.update({
      where: { id: session.id },
      data: { revokedAt: new Date() },
    });

    // Create new refresh session
    const newRawRefreshToken = crypto.randomBytes(40).toString('hex');
    const newExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const newTokenHash = this.hashToken(newRawRefreshToken);

    await this.prisma.refreshSession.create({
      data: {
        userId: session.userId,
        tokenHash: newTokenHash,
        expiresAt: newExpires,
        ipAddress: ip || session.ipAddress,
        userAgent: userAgent || session.userAgent,
      },
    });

    // Generate new Access Token
    const newAccessToken = this.jwtService.sign(
      {
        userId: session.user.id,
        role: session.user.role,
        storeId: session.user.storeId,
        email: session.user.email,
        username: session.user.username,
      },
      { expiresIn: '15m' },
    );

    const userPayload = {
      id: session.user.id,
      email: session.user.email,
      username: session.user.username,
      fullName: session.user.fullName,
      role: session.user.role,
      storeId: session.user.storeId,
      customerProfileId: session.user.customerProfile?.id,
    };

    return {
      success: true,
      message: 'Làm mới token thành công',
      accessToken: newAccessToken,
      token: newAccessToken,
      refreshToken: newRawRefreshToken,
      expiresIn: 900,
      user: userPayload,
      data: {
        accessToken: newAccessToken,
        token: newAccessToken,
        refreshToken: newRawRefreshToken,
        expiresIn: 900,
        user: userPayload,
      },
    };
  }

  /**
   * 6. Logout and session invalidation
   */
  async logout(userId?: string, refreshToken?: string) {
    if (refreshToken) {
      const tokenHash = this.hashToken(refreshToken);
      await this.prisma.refreshSession.updateMany({
        where: { tokenHash, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    } else if (userId) {
      await this.prisma.refreshSession.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }

    return {
      success: true,
      message: 'Đăng xuất thành công.',
    };
  }

  /**
   * 7. Forgot Password (Anti-enumeration generic response)
   */
  async forgotPassword(body: ForgotPasswordDto) {
    const email = body.email?.trim().toLowerCase();
    if (!email) {
      throw new BadRequestException({
        success: false,
        code: 'INVALID_EMAIL',
        message: 'Vui lòng nhập địa chỉ email hợp lệ',
      });
    }

    const user = await this.prisma.user.findUnique({ where: { email } });

    if (user) {
      const rawToken = crypto.randomBytes(32).toString('hex');
      const tokenHash = this.hashToken(rawToken);
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          passwordResetTokenHash: tokenHash,
          passwordResetExpires: expiresAt,
        },
      });

      console.log(
        `🔑 [Email Service Mock] Link đặt lại mật khẩu cho ${user.email}: http://localhost:5173/reset-password?token=${rawToken}`,
      );
    }

    // Always return generic response to prevent email enumeration
    return {
      success: true,
      message: 'Nếu email tồn tại trong hệ thống, chúng tôi đã gửi hướng dẫn đặt lại mật khẩu.',
    };
  }

  /**
   * 8. Reset Password with token validation & session invalidation
   */
  async resetPassword(body: ResetPasswordDto) {
    const { token, newPassword } = body;
    if (!token || !newPassword) {
      throw new BadRequestException({
        success: false,
        code: 'MISSING_FIELDS',
        message: 'Thiếu mã xác nhận hoặc mật khẩu mới',
      });
    }

    const tokenHash = this.hashToken(token);
    const user = await this.prisma.user.findFirst({
      where: {
        passwordResetTokenHash: tokenHash,
        passwordResetExpires: { gt: new Date() },
      },
    });

    if (!user) {
      throw new BadRequestException({
        success: false,
        code: 'INVALID_TOKEN',
        message: 'Mã đặt lại mật khẩu không hợp lệ hoặc đã hết hạn.',
      });
    }

    // Hash new password
    const newPasswordHash = await bcrypt.hash(newPassword, 10);

    // Update user password and clear reset token
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash: newPasswordHash,
        passwordResetTokenHash: null,
        passwordResetExpires: null,
        failedLoginAttempts: 0,
        lockedUntil: null,
      },
    });

    // Invalidate all active refresh sessions to force re-login everywhere
    await this.prisma.refreshSession.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    return {
      success: true,
      message: 'Mật khẩu đã được cập nhật thành công. Vui lòng đăng nhập lại.',
    };
  }

  /**
   * 9. Verify Email
   */
  async verifyEmail(body: VerifyEmailDto) {
    const { token } = body;
    if (!token) {
      throw new BadRequestException({
        success: false,
        code: 'INVALID_TOKEN',
        message: 'Thiếu mã xác minh email',
      });
    }

    const user = await this.prisma.user.findFirst({
      where: {
        emailVerificationToken: token,
        emailVerificationExpires: { gt: new Date() },
      },
    });

    if (!user) {
      throw new BadRequestException({
        success: false,
        code: 'INVALID_TOKEN',
        message: 'Mã xác minh không hợp lệ hoặc đã hết hạn.',
      });
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        emailVerified: true,
        emailVerificationToken: null,
        emailVerificationExpires: null,
      },
    });

    return {
      success: true,
      message: 'Xác minh email thành công! Bạn có thể đăng nhập ngay bây giờ.',
    };
  }

  /**
   * 10. Resend Verification Email with 60-second cooldown
   */
  async resendVerification(body: ResendVerificationDto) {
    const email = body.email?.trim().toLowerCase();
    if (!email) {
      throw new BadRequestException({
        success: false,
        code: 'INVALID_EMAIL',
        message: 'Vui lòng nhập địa chỉ email hợp lệ',
      });
    }

    const now = Date.now();
    const lastSent = this.resendCooldowns.get(email);
    if (lastSent && now - lastSent < 60 * 1000) {
      const waitSecs = Math.ceil((60 * 1000 - (now - lastSent)) / 1000);
      throw new HttpException(
        {
          success: false,
          code: 'RATE_LIMITED',
          message: `Vui lòng đợi ${waitSecs} giây trước khi yêu cầu gửi lại email xác minh.`,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const user = await this.prisma.user.findUnique({ where: { email } });

    if (user && !user.emailVerified) {
      const rawToken = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          emailVerificationToken: rawToken,
          emailVerificationExpires: expiresAt,
        },
      });

      this.resendCooldowns.set(email, now);

      console.log(
        `📧 [Email Service Mock] Link xác minh mới cho ${user.email}: http://localhost:5173/verify-email?token=${rawToken}`,
      );
    }

    return {
      success: true,
      message: 'Nếu tài khoản chưa xác minh, chúng tôi đã gửi lại email xác nhận mới.',
    };
  }

  /**
   * 11. Get current authenticated user
   */
  async getMe(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        store: true,
        customerProfile: {
          include: {
            devices: {
              include: {
                configuration: {
                  include: { product: true },
                },
              },
            },
          },
        },
      },
    });

    if (!user) {
      return { success: false, data: null };
    }

    return {
      success: true,
      data: {
        id: user.id,
        email: user.email,
        username: user.username,
        fullName: user.fullName,
        phone: user.phone,
        role: user.role,
        isActive: user.isActive,
        emailVerified: user.emailVerified,
        storeId: user.storeId,
        store: user.store,
        customerProfileId: user.customerProfile?.id || null,
        customerProfile: user.customerProfile,
        createdAt: user.createdAt,
      },
    };
  }
}
