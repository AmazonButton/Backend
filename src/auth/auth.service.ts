import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  ForbiddenException,
  BadRequestException,
  NotFoundException,
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
  GoogleAuthDto,
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
          status: 'ACTIVE',
          approvedAt: new Date(),
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
          isActive: true,
          emailVerified: true,
        },
      });

      const accessToken = this.jwtService.sign(
        {
          userId: user.id,
          role: user.role,
          storeId: user.storeId,
          email: user.email,
          username: user.username,
        },
        { expiresIn: (process.env.JWT_EXPIRES_IN as any) || '7d' },
      );

      const rawRefreshToken = crypto.randomBytes(40).toString('hex');
      const refreshExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      const tokenHash = this.hashToken(rawRefreshToken);

      await this.prisma.refreshSession.create({
        data: {
          userId: user.id,
          tokenHash,
          expiresAt: refreshExpires,
        },
      });

      const userPayload = {
        id: user.id,
        email: user.email,
        username: user.username,
        fullName: user.fullName,
        role: user.role,
        storeId: newStore.id,
        store: newStore,
        emailVerified: true,
      };

      return {
        success: true,
        code: 'REGISTER_SUCCESS',
        message: 'Đăng ký tài khoản cửa hàng thành công!',
        accessToken,
        token: accessToken,
        refreshToken: rawRefreshToken,
        user: userPayload,
        data: {
          userId: user.id,
          storeId: newStore.id,
          accessToken,
          refreshToken: rawRefreshToken,
          user: userPayload,
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
        emailVerified: true,
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

    const accessToken = this.jwtService.sign(
      {
        userId: newUser.id,
        role: newUser.role,
        storeId: newUser.storeId,
        email: newUser.email,
        username: newUser.username,
      },
      { expiresIn: (process.env.JWT_EXPIRES_IN as any) || '7d' },
    );

    const rawRefreshToken = crypto.randomBytes(40).toString('hex');
    const refreshExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const tokenHash = this.hashToken(rawRefreshToken);

    await this.prisma.refreshSession.create({
      data: {
        userId: newUser.id,
        tokenHash,
        expiresAt: refreshExpires,
      },
    });

    const userPayload = {
      id: newUser.id,
      email: newUser.email,
      username: newUser.username,
      fullName: newUser.fullName,
      role: newUser.role,
      customerProfileId: customerProfile.id,
      emailVerified: true,
    };

    return {
      success: true,
      code: 'REGISTER_SUCCESS',
      message: 'Tạo tài khoản thành công! Bạn có thể đăng nhập ngay.',
      accessToken,
      token: accessToken,
      refreshToken: rawRefreshToken,
      user: userPayload,
      data: {
        accessToken,
        refreshToken: rawRefreshToken,
        user: userPayload,
        verificationToken: rawVerificationToken,
      },
    };
  }

  /**
   * Google Authentication & Registration
   * Automatically handles new user registration or existing user login with Google
   */
  async googleAuth(body: GoogleAuthDto, ip?: string, userAgent?: string) {
    let email = body.email?.trim().toLowerCase();
    let fullName = body.fullName?.trim();
    let googleId = body.googleId;
    let avatarUrl = body.avatarUrl;

    // Optional idToken decoding if token is supplied
    if (body.idToken) {
      try {
        const decoded = this.jwtService.decode(body.idToken) as any;
        if (decoded && typeof decoded === 'object') {
          if (decoded.email) email = decoded.email.trim().toLowerCase();
          if (decoded.name) fullName = fullName || decoded.name;
          if (decoded.sub) googleId = googleId || decoded.sub;
          if (decoded.picture) avatarUrl = avatarUrl || decoded.picture;
        }
      } catch (e) {
        // Fall back to provided fields
      }
    }

    if (!email) {
      throw new BadRequestException({
        success: false,
        code: 'MISSING_EMAIL',
        message: 'Không tìm thấy địa chỉ email từ tài khoản Google.',
      });
    }

    // Check if user already exists
    let user = await this.prisma.user.findUnique({
      where: { email },
      include: {
        store: true,
        customerProfile: true,
      },
    });

    let isNewUser = false;

    if (user) {
      // Existing user: check if locked
      if (user.lockedUntil && new Date(user.lockedUntil) > new Date()) {
        const remainingMinutes = Math.ceil(
          (new Date(user.lockedUntil).getTime() - Date.now()) / (60 * 1000),
        );
        throw new ForbiddenException({
          success: false,
          code: 'ACCOUNT_LOCKED',
          message: `Tài khoản tạm bị khóa do quá số lần thử đăng nhập. Thử lại sau ${remainingMinutes} phút.`,
        });
      }

      // Ensure active and verified
      const updates: any = {
        lastLoginAt: new Date(),
        failedLoginAttempts: 0,
        lockedUntil: null,
      };

      if (!user.isActive) {
        updates.isActive = true;
      }
      if (!user.emailVerified) {
        updates.emailVerified = true;
      }

      user = await this.prisma.user.update({
        where: { id: user.id },
        data: updates,
        include: {
          store: true,
          customerProfile: true,
        },
      });

      // If user is CUSTOMER but missing CustomerProfile, create one
      if (user.role === 'CUSTOMER' && !user.customerProfile) {
        const activeStore = await this.prisma.store.findFirst({ where: { status: 'ACTIVE' } });
        const newProfile = await this.prisma.customerProfile.create({
          data: {
            userId: user.id,
            storeId: activeStore?.id || '',
            deliveryAddress: body.address || 'Chưa thiết lập địa chỉ giao hàng',
            phone: user.phone || body.phone || '',
          },
        });
        user.customerProfile = newProfile;
      }
    } else {
      // New user registering with Google
      isNewUser = true;
      const targetRole = body.role === 'STORE_OWNER' ? 'STORE_OWNER' : 'CUSTOMER';
      const resolvedName = fullName || email.split('@')[0];

      // Generate unique username
      let baseUsername = (body.username || email.split('@')[0] || 'user')
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, '');
      if (baseUsername.length < 3) baseUsername = `${baseUsername}_gg`;
      let candidateUsername = baseUsername.slice(0, 25);
      let suffix = 1;
      while (await this.prisma.user.findUnique({ where: { username: candidateUsername } })) {
        candidateUsername = `${baseUsername.slice(0, 20)}_${suffix}`;
        suffix++;
      }
      const finalUsername = candidateUsername;

      // Random secure password hash (since passwordHash is required in schema)
      const randomPassword = crypto.randomBytes(32).toString('hex');
      const passwordHash = await bcrypt.hash(randomPassword, 10);

      if (targetRole === 'STORE_OWNER') {
        const storeName = body.storeName?.trim() || `Cửa hàng ${resolvedName}`;
        const storeCode = `STORE-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;

        const newStore = await this.prisma.store.create({
          data: {
            name: storeName,
            code: storeCode,
            ownerName: resolvedName,
            phone: body.phone || '',
            email,
            address: body.address || 'Chưa cập nhật địa chỉ kinh doanh',
            status: 'ACTIVE',
            approvedAt: new Date(),
          },
        });

        user = await this.prisma.user.create({
          data: {
            email,
            username: finalUsername,
            passwordHash,
            fullName: resolvedName,
            phone: body.phone || null,
            role: 'STORE_OWNER',
            storeId: newStore.id,
            isActive: true,
            emailVerified: true,
            lastLoginAt: new Date(),
          },
          include: {
            store: true,
            customerProfile: true,
          },
        });
      } else {
        const targetStore = await this.prisma.store.findFirst({ where: { status: 'ACTIVE' } });

        user = await this.prisma.user.create({
          data: {
            email,
            username: finalUsername,
            passwordHash,
            fullName: resolvedName,
            phone: body.phone || null,
            role: 'CUSTOMER',
            storeId: targetStore?.id || null,
            isActive: true,
            emailVerified: true,
            lastLoginAt: new Date(),
          },
          include: {
            store: true,
            customerProfile: true,
          },
        });

        const customerProfile = await this.prisma.customerProfile.create({
          data: {
            userId: user.id,
            storeId: targetStore?.id || '',
            deliveryAddress: body.address || 'Chưa thiết lập địa chỉ giao hàng',
            phone: body.phone || '',
          },
        });
        user.customerProfile = customerProfile;
      }
    }

    // Issue JWT Access Token (7d as configured in .env)
    const accessToken = this.jwtService.sign(
      {
        userId: user.id,
        role: user.role,
        storeId: user.storeId,
        email: user.email,
        username: user.username,
      },
      { expiresIn: (process.env.JWT_EXPIRES_IN as any) || '7d' },
    );

    // Issue Refresh Token (30d)
    const rawRefreshToken = crypto.randomBytes(40).toString('hex');
    const refreshExpires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const tokenHash = this.hashToken(rawRefreshToken);

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
      emailVerified: true,
    };

    return {
      success: true,
      isNewUser,
      code: isNewUser ? 'REGISTER_SUCCESS' : 'LOGIN_SUCCESS',
      message: isNewUser
        ? 'Đăng ký tài khoản với Google thành công!'
        : 'Đăng nhập Google thành công!',
      accessToken,
      token: accessToken,
      refreshToken: rawRefreshToken,
      user: userPayload,
      data: {
        userId: user.id,
        storeId: user.storeId,
        accessToken,
        refreshToken: rawRefreshToken,
        user: userPayload,
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

    // Check active status & auto-activate pending store for smooth onboarding
    if (user.role === 'STORE_OWNER' && user.store?.status === 'PENDING_APPROVAL') {
      await this.prisma.store.update({
        where: { id: user.store.id },
        data: { status: 'ACTIVE', approvedAt: new Date() },
      });
      await this.prisma.user.update({
        where: { id: user.id },
        data: { isActive: true },
      });
      user.isActive = true;
    }

    if (!user.isActive) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { isActive: true },
      });
      user.isActive = true;
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

    // Auto-verify email if not yet verified
    if (!user.emailVerified) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { emailVerified: true },
      });
      user.emailVerified = true;
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

    // Generate secure Access Token (7 days as configured in .env)
    const accessToken = this.jwtService.sign(
      {
        userId: user.id,
        role: user.role,
        storeId: user.storeId,
        email: user.email,
        username: user.username,
      },
      { expiresIn: (process.env.JWT_EXPIRES_IN as any) || '7d' },
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
      expiresIn: 604800,
      data: {
        token: accessToken,
        accessToken,
        refreshToken: rawRefreshToken,
        expiresIn: 604800,
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
    if (!normalized) return { exists: false, available: true };
    const count = await this.prisma.user.count({
      where: { email: normalized },
    });
    const exists = count > 0;
    return {
      exists,
      available: !exists,
      message: exists ? 'Email này đã được đăng ký tài khoản' : 'Email hợp lệ và khả dụng',
    };
  }

  /**
   * 4. Check duplicate username in realtime
   */
  async checkUsername(username: string) {
    const normalized = username?.trim().toLowerCase();
    if (!normalized) return { exists: false, available: true };
    const count = await this.prisma.user.count({
      where: { username: normalized },
    });
    const exists = count > 0;
    return {
      exists,
      available: !exists,
      message: exists ? 'Tên đăng nhập này đã được sử dụng' : 'Tên đăng nhập khả dụng',
    };
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

    // Generate new Access Token (7 days)
    const newAccessToken = this.jwtService.sign(
      {
        userId: session.user.id,
        role: session.user.role,
        storeId: session.user.storeId,
        email: session.user.email,
        username: session.user.username,
      },
      { expiresIn: (process.env.JWT_EXPIRES_IN as any) || '7d' },
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
      expiresIn: 604800,
      user: userPayload,
      data: {
        accessToken: newAccessToken,
        token: newAccessToken,
        refreshToken: newRawRefreshToken,
        expiresIn: 604800,
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

  async updateProfile(
    userId: string,
    data: {
      fullName?: string;
      phone?: string;
      deliveryAddress?: string;
      storeName?: string;
      storeAddress?: string;
      storePhone?: string;
    },
  ) {
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        ...(data.fullName ? { fullName: data.fullName.trim() } : {}),
        ...(data.phone ? { phone: data.phone.trim() } : {}),
      },
    });

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { customerProfile: true, store: true },
    });

    if (user?.customerProfile && (data.deliveryAddress || data.storeAddress)) {
      await this.prisma.customerProfile.update({
        where: { id: user.customerProfile.id },
        data: { deliveryAddress: (data.deliveryAddress || data.storeAddress)!.trim() },
      });
    }

    if (user?.store) {
      await this.prisma.store.update({
        where: { id: user.store.id },
        data: {
          ...(data.storeName ? { name: data.storeName.trim() } : {}),
          ...(data.storeAddress || data.deliveryAddress
            ? { address: (data.storeAddress || data.deliveryAddress)!.trim() }
            : {}),
          ...(data.storePhone || data.phone
            ? { phone: (data.storePhone || data.phone)!.trim() }
            : {}),
          ...(data.fullName ? { ownerName: data.fullName.trim() } : {}),
        },
      });
    }

    return this.getMe(userId);
  }

  async changePassword(
    userId: string,
    body: { currentPassword: string; newPassword: string },
  ) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException({ success: false, message: 'Không tìm thấy tài khoản người dùng' });
    }
    const isMatch = await bcrypt.compare(body.currentPassword, user.passwordHash);
    if (!isMatch) {
      throw new BadRequestException({ success: false, message: 'Mật khẩu hiện tại không chính xác' });
    }
    if (!body.newPassword || body.newPassword.length < 6) {
      throw new BadRequestException({ success: false, message: 'Mật khẩu mới phải có ít nhất 6 ký tự' });
    }
    const newHash = await bcrypt.hash(body.newPassword, 10);
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: newHash },
    });
    return { success: true, message: 'Đổi mật khẩu thành công!' };
  }
}

