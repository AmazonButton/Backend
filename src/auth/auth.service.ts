import { TokenBlacklist } from './token-blacklist';
import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  BadRequestException,
  Inject,
  Logger,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import { AuthRepository } from './auth.repository';
import { MailService } from '../mail/mail.service';
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
  private readonly logger = new Logger(AuthService.name);
  private resendCooldowns = new Map<string, number>();

  private getOtpPepper(): string {
    const pepper = process.env.OTP_PEPPER?.trim();
    if (!pepper) {
      if (process.env.NODE_ENV === 'production') {
        throw new Error('CẤU HÌNH BẢO MẬT BẮT BUỘC: OTP_PEPPER chưa được thiết lập trong biến môi trường');
      }
      return process.env.JWT_SECRET || 'sob_secure_otp_pepper_2026';
    }
    return pepper;
  }

  private hashOtp(otpCode: string, purpose: 'EMAIL_VERIFICATION' | 'PASSWORD_RESET'): string {
    const pepper = this.getOtpPepper();
    return crypto.createHmac('sha256', pepper).update(`${otpCode.trim()}:${purpose}`).digest('hex');
  }

  constructor(
    @Inject(MailService) private readonly mailService: MailService,
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

    // Generate secure email verification token using crypto.randomInt and HMAC pepper
    const registrationOtp = crypto.randomInt(100000, 1_000_000).toString();
    const verificationTokenHash = this.hashOtp(registrationOtp, 'EMAIL_VERIFICATION');
    const verificationExpiresAt = new Date(Date.now() + 15 * 60 * 1000);

    // 1. Transactional Registration with PENDING_VERIFICATION status
    const userCreateData = {
      username,
      email,
      passwordHash,
      fullName,
      phone: phone || null,
      status: 'PENDING_VERIFICATION',
      emailVerificationToken: verificationTokenHash,
      emailVerificationExpiresAt: verificationExpiresAt,
    };

    if (role === 'STORE_OWNER') {
      if (!storeName) {
        throw new BadRequestException({
          success: false,
          code: 'MISSING_STORE_INFO',
          message: 'Vui lòng cung cấp tên cửa hàng',
        });
      }

      const storeCode = `STORE-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;
      const { newUser, newStore } = await this.authRepo.registerStoreOwnerTx(
        userCreateData,
        {
          name: storeName,
          code: storeCode,
          phone: phone || '0900000000',
          email,
          address: address || 'Chưa cập nhật địa chỉ',
          status: 'ACTIVE',
        },
        {
          roleCode: 'STORE_OWNER',
          roleName: 'Store Owner',
          description: 'Chủ cửa hàng, toàn quyền trên Store',
        }
      );

      await this.authRepo.createAuthOtp({
        userId: newUser.userId,
        email: newUser.email,
        purpose: 'EMAIL_VERIFICATION',
        tokenHash: verificationTokenHash,
        expiresAt: verificationExpiresAt,
      });

      // Dispatch 6-digit OTP to store owner's email
      await this.mailService.sendRegistrationOtp(email, registrationOtp);

      return {
        success: true,
        message: 'Đăng ký cửa hàng thành công! Vui lòng kiểm tra email để xác minh mã OTP 6 số kích hoạt tài khoản.',
        data: {
          user: {
            id: newUser.userId.toString(),
            userId: newUser.userId.toString(),
            email: newUser.email,
            username: newUser.username,
            fullName: newUser.fullName,
            role: 'STORE_OWNER',
            storeId: newStore.storeId.toString(),
            status: newUser.status,
          },
          store: {
            storeId: newStore.storeId.toString(),
            name: newStore.name,
            code: newStore.code,
          },
        },
      };
    }

    // Handle Global Customer registration transactionally
    const { newUser, customerProfile } = await this.authRepo.registerCustomerTx(
      userCreateData,
      { phone: phone || null },
      address ? {
        recipientName: fullName,
        phone: phone || '0900000000',
        addressDetail: address,
        isDefault: true,
      } : undefined
    );

    await this.authRepo.createAuthOtp({
      userId: newUser.userId,
      email: newUser.email,
      purpose: 'EMAIL_VERIFICATION',
      tokenHash: verificationTokenHash,
      expiresAt: verificationExpiresAt,
    });

    // Dispatch 6-digit OTP to customer's email
    await this.mailService.sendRegistrationOtp(email, registrationOtp);

    return {
      success: true,
      message: 'Tạo tài khoản khách hàng thành công! Vui lòng kiểm tra email để xác minh mã OTP 6 số kích hoạt tài khoản.',
      data: {
        user: {
          id: newUser.userId.toString(),
          userId: newUser.userId.toString(),
          email: newUser.email,
          username: newUser.username,
          fullName: newUser.fullName,
          role: 'CUSTOMER',
          customerProfileId: customerProfile.customerId.toString(),
          status: newUser.status,
        },
      },
    };
  }


  /**
   * Google Social Login via Supabase OAuth token
   */
  async googleLogin(token: string, ip?: string, userAgent?: string) {
    if (!token) {
      throw new BadRequestException('Vui lòng cung cấp access token từ Supabase Google OAuth');
    }

    const supabaseUrl = process.env.SUPABASE_URL || 'https://gultdgalicgqhvquxizs.supabase.co';
    const anonKey = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || '';

    // Verify token with Supabase Auth API
    let supabaseUser: any = null;
    try {
      const response = await fetch(`${supabaseUrl}/auth/v1/user`, {
        headers: {
          Authorization: `Bearer ${token.trim()}`,
          apikey: anonKey,
        },
      });

      if (!response.ok) {
        throw new UnauthorizedException('Token Supabase Google không hợp lệ hoặc đã hết hạn');
      }

      supabaseUser = await response.json();

      // Enforce explicit Google identity & email verification
      const identities = supabaseUser.identities || [];
      const hasGoogleIdentity =
        identities.some((id: any) => id.provider === 'google') ||
        supabaseUser.app_metadata?.provider === 'google';
      if (!hasGoogleIdentity) {
        throw new UnauthorizedException('Token không có định danh Google OAuth hợp lệ');
      }

      const emailVerified =
        !!supabaseUser.email_confirmed_at ||
        supabaseUser.user_metadata?.email_verified === true ||
        supabaseUser.app_metadata?.email_verified === true;
      if (!emailVerified && !supabaseUser.email_confirmed_at) {
        throw new UnauthorizedException('Email Google chưa được xác minh');
      }
    } catch (err: any) {
      if (err instanceof UnauthorizedException) throw err;
      throw new UnauthorizedException('Không thể xác thực token với Supabase Auth: ' + err.message);
    }

    if (!supabaseUser || !supabaseUser.email) {
      throw new BadRequestException('Tài khoản Google không trả về địa chỉ email');
    }

    const email = supabaseUser.email.trim().toLowerCase();
    const authId = supabaseUser.id; // Supabase auth UUID
    const metadata = supabaseUser.user_metadata || {};
    const fullName = metadata.full_name || metadata.name || email.split('@')[0];

    // Check if user already exists by authId or email
    let user = await this.authRepo.findByAuthId(authId);
    if (!user) {
      user = await this.authRepo.findUserWithAuthRelations(email);
      if (user) {
        // Link authId to existing user
        await this.authRepo.updateAuthId(user.userId, authId);
      } else {
        // Create new User and CustomerProfile
        const randomPassword = crypto.randomBytes(24).toString('hex');
        const passwordHash = await bcrypt.hash(randomPassword, 12);
        const username = `google_${email.split('@')[0]}_${Math.random().toString(36).substring(2, 6)}`.slice(0, 30);

        const { newUser, customerProfile } = await this.authRepo.createGoogleUserTx(
          {
            username,
            email,
            passwordHash,
            fullName,
            phone: metadata.phone || null,
            status: 'ACTIVE',
            authId,
          },
          {
            phone: metadata.phone || null,
          },
        );

        user = {
          ...newUser,
          customerProfile: {
            ...customerProfile,
            addresses: [],
          },
          ownedStores: [],
          storeStaffs: [],
        } as any;
      }
    }

    if (user.status !== 'ACTIVE') {
      throw new UnauthorizedException('Tài khoản của bạn hiện đang bị khóa.');
    }

    // Determine role & storeId
    let role = 'CUSTOMER';
    let storeId: string | null = null;
    const customerProfileId = user.customerProfile?.customerId ? user.customerProfile.customerId.toString() : null;

    const isSuperAdmin = user.storeStaffs?.some(
      (s: any) => s.role?.roleCode === 'SUPER_ADMIN' || s.role?.roleCode === 'SYSTEM_ADMIN',
    );

    if (isSuperAdmin) {
      role = 'SUPER_ADMIN';
    } else if (user.ownedStores && user.ownedStores.length > 0) {
      role = 'STORE_OWNER';
      storeId = user.ownedStores[0].storeId.toString();
    } else if (user.storeStaffs && user.storeStaffs.length > 0) {
      role = user.storeStaffs[0].role?.roleCode || 'STORE_STAFF';
      storeId = user.storeStaffs[0].storeId.toString();
    }

    // Generate JWT access token
    const accessToken = this.jwtService.sign(
      {
        userId: user.userId.toString(),
        email: user.email,
        username: user.username,
        role,
        storeId,
        customerProfileId,
        tokenType: 'ACCESS',
      },
      { expiresIn: '15m' },
    );

    // Generate rotated refresh token
    const rawRefreshToken = crypto.randomBytes(40).toString('hex');
    const refreshTokenHash = crypto.createHash('sha256').update(rawRefreshToken).digest('hex');
    const refreshExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
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
      message: 'Đăng nhập Google thành công',
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

    const superAdminEmails = (process.env.SUPER_ADMIN_EMAILS || 'admin@smartorder.local')
      .split(',')
      .map((e) => e.trim().toLowerCase());
    const isSuperAdmin =
      user.storeStaffs?.some((s: any) => s.role?.roleCode === 'SUPER_ADMIN') ||
      superAdminEmails.includes((user.email || '').toLowerCase()) ||
      user.username === 'admin';

    if (isSuperAdmin) {
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
        tokenType: 'ACCESS',
      },
      { expiresIn: '15m' },
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
      let newRawRefreshToken = '';

      if (storedToken) {
        if (storedToken.isRevoked || storedToken.expiresAt < new Date()) {
          throw new UnauthorizedException('Refresh token không hợp lệ hoặc đã bị thu hồi/hết hạn');
        }

        // Atomic refresh token rotation
        newRawRefreshToken = crypto.randomBytes(40).toString('hex');
        const newHash = crypto.createHash('sha256').update(newRawRefreshToken).digest('hex');
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        await this.authRepo.rotateRefreshToken(tokenHash, {
          userId: storedToken.userId,
          tokenHash: newHash,
          expiresAt,
        });
        user = await this.authRepo.findById(storedToken.userId);
      } else {
        // Fallback for JWT format tokens
        const payload = this.jwtService.verify(cleanToken);
        if (payload.tokenType !== 'REFRESH') {
          throw new UnauthorizedException('Token không hợp lệ: Yêu cầu Refresh Token, không chấp nhận Access Token.');
        }
        user = await this.authRepo.findById(BigInt(payload.userId));
        newRawRefreshToken = crypto.randomBytes(40).toString('hex');
        const newHash = crypto.createHash('sha256').update(newRawRefreshToken).digest('hex');
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        await this.authRepo.createRefreshToken(user.userId, newHash, expiresAt);
      }

      if (!user || user.status !== 'ACTIVE') {
        throw new UnauthorizedException('Tài khoản không tồn tại hoặc đã bị khóa');
      }

      const isAdmin = user.storeStaffs?.some((s: any) => s.role?.roleCode === 'SUPER_ADMIN' || s.role?.roleCode === 'SYSTEM_ADMIN');
      if (isAdmin) {
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
          tokenType: 'ACCESS',
        },
        { expiresIn: '15m' },
      );

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
  async logout(userId?: string, refreshToken?: string, accessToken?: string) {
    if (accessToken) {
      await TokenBlacklist.revokeTokenAsync(accessToken, 7 * 86400, userId ? BigInt(userId) : undefined);
      try {
        const decoded: any = this.jwtService.decode(accessToken);
        if (decoded?.userId) {
          TokenBlacklist.revokeUser(decoded.userId.toString());
        }
      } catch {}
    }
    if (refreshToken) {
      const hash = crypto.createHash('sha256').update(refreshToken.trim()).digest('hex');
      const stored = await this.authRepo.findRefreshToken(hash);
      if (stored && stored.userId) {
        TokenBlacklist.revokeUser(stored.userId.toString());
      }
      await this.authRepo.revokeRefreshToken(hash);
    }
    if (userId) {
      await this.authRepo.revokeAllUserRefreshTokens(BigInt(userId));
      TokenBlacklist.revokeUser(userId.toString());
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
      await bcrypt.hash('dummy_timing_salt_anti_enumeration_pad', 12);
      return {
        success: true,
        message: 'Nếu email tồn tại trong hệ thống, chúng tôi đã gửi hướng dẫn đặt lại mật khẩu.',
      };
    }

    const user = await this.authRepo.findByEmail(email);
    if (user && user.status === 'ACTIVE') {
      const otpCode = crypto.randomInt(100000, 1_000_000).toString();
      const tokenHash = this.hashOtp(otpCode, 'PASSWORD_RESET');
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

      await this.authRepo.createAuthOtp({
        userId: user.userId,
        email: user.email,
        purpose: 'PASSWORD_RESET',
        tokenHash,
        expiresAt,
      });
      await this.authRepo.setPasswordResetToken(user.userId, tokenHash, expiresAt);

      // Asynchronous / non-blocking email dispatch to prevent timing enumeration
      this.mailService.sendPasswordResetOtp(user.email, otpCode).catch((err) => {
        this.logger.error(`Failed to send password reset email: ${err.message}`);
      });
    } else {
      // Dummy bcrypt hashing pad to neutralize timing enumeration when email does not exist
      await bcrypt.hash('dummy_timing_salt_anti_enumeration_pad', 12);
    }

    return {
      success: true,
      message: 'Nếu email tồn tại trong hệ thống, chúng tôi đã gửi hướng dẫn đặt lại mật khẩu.',
    };
  }

  /**
   * 8. Reset Password with Token (SHA-256 Verification + Single-Use Invalidation)
   */
  async resetPassword(body: ResetPasswordDto) {
    const { token, newPassword, email } = body;
    if (!token || !newPassword) {
      throw new BadRequestException({
        success: false,
        message: 'Thiếu thông tin mã xác thực hoặc mật khẩu mới',
      });
    }

    const tokenHash = this.hashOtp(token.trim(), 'PASSWORD_RESET');

    // Atomic OTP consumption in PostgreSQL
    const newPasswordHash = await bcrypt.hash(newPassword, 12);

    const resetResult = await this.authRepo.atomicResetPasswordWithOtpTx({
      tokenHash,
      purpose: 'PASSWORD_RESET',
      email,
      newPasswordHash,
    });

    if (!resetResult.success) {
      throw new BadRequestException({
        success: false,
        message: resetResult.reason || 'Mã đặt lại mật khẩu không hợp lệ hoặc đã hết hạn',
      });
    }

    const targetUserId = BigInt(resetResult.userId);

    // Invalidate local session cache
    TokenBlacklist.revokeUser(targetUserId);

    return {
      success: true,
      message: 'Mật khẩu đã được cập nhật thành công. Vui lòng đăng nhập lại.',
    };
  }

  /**
   * 9. Verify Email (SHA-256 Hashed Token Verification)
   */
  async verifyEmail(body: VerifyEmailDto) {
    const { token, email } = body;
    if (!token) {
      throw new BadRequestException('Vui lòng cung cấp mã xác minh email');
    }

    const tokenHash = this.hashOtp(token.trim(), 'EMAIL_VERIFICATION');

    const consumeResult = await this.authRepo.consumeOtpAtomically({
      tokenHash,
      purpose: 'EMAIL_VERIFICATION',
      email,
    });

    if (!consumeResult.success || !consumeResult.otp) {
      throw new BadRequestException({
        success: false,
        message: consumeResult.reason || 'Mã xác minh email không hợp lệ hoặc đã hết hạn',
      });
    }

    const targetUserId = BigInt(consumeResult.otp.user_id);
    await this.authRepo.markEmailVerified(targetUserId, consumeResult.otp.id);

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
      if (user && user.status === 'PENDING_VERIFICATION') {
        const otpCode = crypto.randomInt(100000, 1_000_000).toString();
        const tokenHash = this.hashOtp(otpCode, 'EMAIL_VERIFICATION');
        const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

        await this.authRepo.createAuthOtp({
          userId: user.userId,
          email: user.email,
          purpose: 'EMAIL_VERIFICATION',
          tokenHash,
          expiresAt,
        });
        await this.authRepo.setEmailVerificationToken(user.userId, tokenHash, expiresAt);

        this.mailService.sendRegistrationOtp(user.email, otpCode).catch((err) => {
          this.logger.error(`Failed to resend registration OTP: ${err.message}`);
        });
      } else {
        await bcrypt.hash('dummy_resend_verification_salt', 12);
      }
    } else {
      await bcrypt.hash('dummy_resend_verification_salt', 12);
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
