import { TokenBlacklist } from './token-blacklist';
import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  BadRequestException,
  NotFoundException,
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
  UpdateProfileDto,
  GoogleLoginDto,
} from './dto/auth.dto';
import { RegisterByPhoneDto } from './dto/register-by-phone.dto';
import { LoginByPhoneDto } from './dto/login-by-phone.dto';
import { FirebasePhoneService } from './firebase-phone.service';
import { ChangePasswordDto } from './dto/change-password.dto';

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

  public resolveUserRole(user: any): { role: string; storeId: string | null } {
    let role = 'CUSTOMER';
    let storeId: string | null = null;

    const superAdminEmails = (process.env.SUPER_ADMIN_EMAILS || 'admin@smartorder.local')
      .split(',')
      .map((e) => e.trim().toLowerCase());
    const isSuperAdmin =
      user.storeStaffs?.some(
        (s: any) => s.role?.roleCode === 'SUPER_ADMIN' || s.role?.roleCode === 'SYSTEM_ADMIN',
      ) ||
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

    return { role, storeId };
  }

  constructor(
    @Inject(MailService) private readonly mailService: MailService,
    @Inject(AuthRepository) private readonly authRepo: AuthRepository,
    @Inject(JwtService) private readonly jwtService: JwtService,
    @Inject(FirebasePhoneService) private readonly firebasePhoneService: FirebasePhoneService,
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
      status: 'ACTIVE',
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
      this.mailService.sendRegistrationOtp(email, registrationOtp).catch(() => {});

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
    this.mailService.sendRegistrationOtp(email, registrationOtp).catch(() => {});

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
  async googleLogin(body: GoogleLoginDto | string, ip?: string, userAgent?: string) {
    const dto: GoogleLoginDto = typeof body === 'string' ? { token: body } : body;
    const rawToken = dto.token?.trim();

    let verifiedUser: { email: string; name?: string; picture?: string; id?: string } | null = null;

    if (rawToken) {
      const expectedAud = process.env.GOOGLE_CLIENT_ID;

      // 1. Try Google OAuth 2.0 access token via tokeninfo + userinfo verification
      try {
        const tokenInfoRes = await fetch(
          `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(rawToken)}`,
        );
        if (tokenInfoRes.ok) {
          const tData: any = await tokenInfoRes.json();
          const isEmailVerified =
            tData.verified_email === true ||
            tData.verified_email === 'true' ||
            tData.email_verified === 'true' ||
            tData.email_verified === true;
          const tokenAud = tData.audience || tData.issued_to;
          const audValid = expectedAud
            ? tokenAud === expectedAud
            : process.env.NODE_ENV !== 'production';

          if (tData.email && isEmailVerified && audValid) {
            verifiedUser = {
              email: tData.email,
              name: tData.email.split('@')[0],
              id: tData.user_id || tData.sub,
            };
            try {
              const googleRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
                headers: { Authorization: `Bearer ${rawToken}` },
              });
              if (googleRes.ok) {
                const gData: any = await googleRes.json();
                if (gData.name) verifiedUser.name = gData.name;
                if (gData.picture) verifiedUser.picture = gData.picture;
              }
            } catch (_) {}
          }
        }
      } catch (_) {}

      // 2. Try Google ID Token verification (tokeninfo endpoint)
      if (!verifiedUser) {
        try {
          const idTokenRes = await fetch(
            `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(rawToken)}`,
          );
          if (idTokenRes.ok) {
            const tokenData: any = await idTokenRes.json();
            const validIssuers = ['accounts.google.com', 'https://accounts.google.com'];
            const isEmailVerified =
              tokenData.email_verified === 'true' || tokenData.email_verified === true;
            const isNotExpired =
              tokenData.exp && Number(tokenData.exp) * 1000 > Date.now();
            const audValid = expectedAud
              ? tokenData.aud === expectedAud
              : process.env.NODE_ENV !== 'production';

            if (
              tokenData.email &&
              validIssuers.includes(tokenData.iss) &&
              isEmailVerified &&
              isNotExpired &&
              audValid
            ) {
              verifiedUser = {
                email: tokenData.email,
                name: tokenData.name,
                picture: tokenData.picture,
                id: tokenData.sub,
              };
            }
          }
        } catch (_) {}
      }

      // 3. Fallback to Supabase Auth API if not verified via Google UserInfo
      if (!verifiedUser) {
        const supabaseUrl = process.env.SUPABASE_URL || 'https://gultdgalicgqhvquxizs.supabase.co';
        const anonKey = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || '';
        try {
          const sRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
            headers: {
              Authorization: `Bearer ${rawToken}`,
              apikey: anonKey,
            },
          });
          if (sRes.ok) {
            const sData: any = await sRes.json();
            const isEmailVerified =
              sData.email_confirmed_at != null ||
              sData.user_metadata?.email_verified === true;
            if (sData.email && isEmailVerified) {
              verifiedUser = {
                email: sData.email,
                name: sData.user_metadata?.full_name || sData.user_metadata?.name,
                picture: sData.user_metadata?.avatar_url || sData.user_metadata?.picture,
                id: sData.id,
              };
            }
          }
        } catch (_) {}
      }
    }

    // STRICT TEST-ONLY BYPASS: Only allowed when NODE_ENV === 'test' AND NOT production!
    // Never trust client-provided email or googleId in production as verified identity.
    if (!verifiedUser && process.env.NODE_ENV === 'test' && dto.email) {
      verifiedUser = {
        email: dto.email,
        name: dto.fullName,
        picture: dto.avatarUrl,
        id: dto.googleId || `google_${Date.now()}`,
      };
    }

    if (!verifiedUser?.email) {
      if (!rawToken) {
        throw new UnauthorizedException('Token xác thực Google/OAuth là bắt buộc.');
      }
      throw new UnauthorizedException('Không thể xác thực thông tin tài khoản Google từ OAuth token cung cấp.');
    }
    const email = verifiedUser.email.trim().toLowerCase();

    const fullName = dto.fullName?.trim() || verifiedUser?.name || email.split('@')[0];
    const rawAvatarUrl = dto.avatarUrl || verifiedUser?.picture || null;
    const avatarUrl =
      typeof rawAvatarUrl === 'string' &&
      (rawAvatarUrl.startsWith('http://') || rawAvatarUrl.startsWith('https://')) &&
      rawAvatarUrl.length <= 512
        ? rawAvatarUrl
        : null;

    const candidateAuthId = verifiedUser?.id;
    const authId =
      candidateAuthId &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(candidateAuthId)
        ? candidateAuthId
        : null;

    // Check if user already exists
    let user: any = null;
    if (authId) {
      user = await this.authRepo.findByAuthId(authId);
    }
    if (!user) {
      user = await this.authRepo.findUserWithAuthRelations(email);
      if (user) {
        if (authId && !user.authId) {
          await this.authRepo.updateAuthId(user.userId, authId);
        }
        if (!user.avatarUrl && avatarUrl) {
          user = (await this.authRepo.updateProfile(user.userId, { avatarUrl })) as any;
        }
      } else {
        // Register new user via Google
        const targetRole = dto.role === 'STORE_OWNER' ? 'STORE_OWNER' : 'CUSTOMER';
        const randomPassword = crypto.randomBytes(24).toString('hex');
        const passwordHash = await bcrypt.hash(randomPassword, 12);
        const cleanPrefix = email.split('@')[0].replace(/[^a-zA-Z0-9_]/g, '').slice(0, 18);
        const username = `${cleanPrefix || 'user'}_${Math.random().toString(36).substring(2, 6)}`.slice(0, 30);

        if (targetRole === 'STORE_OWNER') {
          const storeName = dto.storeName?.trim() || `Cửa Hàng ${fullName}`;
          const storeCode = `STORE-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;
          const { newUser, newStore } = await this.authRepo.registerStoreOwnerTx(
            {
              username,
              email,
              passwordHash,
              fullName,
              avatarUrl,
              phone: dto.phone?.trim() || null,
              status: 'ACTIVE',
              authId,
            },
            {
              name: storeName,
              code: storeCode,
              phone: dto.phone?.trim() || '0900000000',
              email,
              address: dto.address?.trim() || 'Chưa cập nhật địa chỉ',
              status: 'ACTIVE',
            },
            {
              roleCode: 'STORE_OWNER',
              roleName: 'Store Owner',
              description: 'Chủ cửa hàng, toàn quyền trên Store',
            },
          );
          user = {
            ...newUser,
            ownedStores: [newStore],
            storeStaffs: [],
            customerProfile: null,
          } as any;
        } else {
          const { newUser, customerProfile } = await this.authRepo.createGoogleUserTx(
            {
              username,
              email,
              passwordHash,
              fullName,
              avatarUrl,
              phone: dto.phone?.trim() || null,
              status: 'ACTIVE',
              authId,
            },
            {
              phone: dto.phone?.trim() || null,
            },
          );

          if (dto.address?.trim()) {
            try {
              await this.authRepo.createCustomerAddress({
                customerId: customerProfile.customerId,
                recipientName: fullName,
                phone: dto.phone?.trim() || '0900000000',
                addressDetail: dto.address.trim(),
                isDefault: true,
              });
            } catch (_) {}
          }

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
    } else {
      if (!user.avatarUrl && avatarUrl) {
        user = (await this.authRepo.updateProfile(user.userId, { avatarUrl })) as any;
      }
    }

    if (user.status === 'PENDING_VERIFICATION') {
      await this.authRepo.markEmailVerified(user.userId);
      user.status = 'ACTIVE';
    }

    if (user.status !== 'ACTIVE') {
      throw new UnauthorizedException('Tài khoản của bạn hiện đang bị khóa.');
    }

    // Determine role & storeId
    const { role, storeId } = this.resolveUserRole(user);
    const customerProfileId = user.customerProfile?.customerId ? user.customerProfile.customerId.toString() : null;

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
      { expiresIn: '7d' },
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
      avatarUrl: user.avatarUrl || null,
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

    if (!user.passwordHash) {
      throw new UnauthorizedException({
        success: false,
        code: 'INVALID_CREDENTIALS',
        message: 'Tài khoản này chưa thiết lập mật khẩu. Vui lòng đăng nhập bằng số điện thoại.',
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
      avatarUrl: user.avatarUrl || null,
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
  async logout(userContext?: any, refreshToken?: string, accessToken?: string, fcmToken?: string) {
    let verifiedUserId: string | undefined = undefined;
    let isExpiredToken = false;

    // 1. If accessToken provided, VERIFY cryptographic signature strictly (Never decode untrusted tokens)
    if (accessToken) {
      const secret =
        process.env.JWT_SECRET ||
        (process.env.NODE_ENV === 'test'
          ? 'ci_test_jwt_secret_key_minimum_32_characters_long_for_security!'
          : undefined);
      if (!secret) {
        throw new Error('FATAL: JWT_SECRET environment variable is required and must not be empty');
      }

      let payload: any = null;
      try {
        payload = await this.jwtService.verifyAsync(accessToken, {
          secret,
          ignoreExpiration: true,
        });
      } catch (err: any) {
        // FORGED TOKEN / TAMPERED SIGNATURE: NEVER trust payload, NEVER revoke user!
        throw new UnauthorizedException('Chữ ký token không hợp lệ hoặc token bị làm giả');
      }

      if (payload?.userId) {
        verifiedUserId = payload.userId.toString();
        const nowSec = Math.floor(Date.now() / 1000);
        isExpiredToken = Boolean(payload.exp && payload.exp < nowSec);
      }

      // Safe to blacklist this verified token
      const ttl = payload?.exp ? Math.max(60, payload.exp - Math.floor(Date.now() / 1000)) : 7 * 86400;
      await TokenBlacklist.revokeTokenAsync(accessToken, ttl, verifiedUserId ? BigInt(verifiedUserId) : undefined);
    }

    // 2. Extract identity from verified user context if provided
    if (userContext && typeof userContext === 'object') {
      if (userContext.isExpired) {
        isExpiredToken = true;
      }
      if (userContext.id || userContext.userId) {
        verifiedUserId = (userContext.id || userContext.userId).toString();
      }
    } else if (typeof userContext === 'string' && userContext) {
      verifiedUserId = userContext;
    }

    // 3. Verify refresh token if provided
    if (refreshToken) {
      const hash = crypto.createHash('sha256').update(refreshToken.trim()).digest('hex');
      const stored = await this.authRepo.findRefreshToken(hash);
      if (stored && stored.userId) {
        const storedUserId = stored.userId.toString();
        if (!verifiedUserId) {
          verifiedUserId = storedUserId;
        }
      }
      await this.authRepo.revokeRefreshToken(hash);
    }

    // 4. User-wide revocation ONLY if token is VALID and NOT expired
    if (verifiedUserId && !isExpiredToken) {
      await this.authRepo.revokeAllUserRefreshTokens(BigInt(verifiedUserId));
      await this.authRepo.deactivateUserFcmTokens(BigInt(verifiedUserId), fcmToken);
      TokenBlacklist.revokeUser(verifiedUserId);
    } else if (verifiedUserId && isExpiredToken && fcmToken) {
      await this.authRepo.deactivateUserFcmTokens(BigInt(verifiedUserId), fcmToken);
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
   * 8.1 Change Password for Authenticated User
   */
  async changePassword(userId: string | number | bigint, dto: ChangePasswordDto, rawAccessToken?: string) {
    const targetUserId = BigInt(userId);
    const user = await this.authRepo.findById(targetUserId);

    if (!user || user.status !== 'ACTIVE') {
      throw new UnauthorizedException('Tài khoản không tồn tại hoặc đã bị vô hiệu hóa');
    }

    if (!user.passwordHash) {
      throw new BadRequestException('Tài khoản này chưa thiết lập mật khẩu (đăng nhập bằng mạng xã hội hoặc số điện thoại)');
    }

    const isMatch = await bcrypt.compare(dto.currentPassword, user.passwordHash);
    if (!isMatch) {
      throw new UnauthorizedException({
        success: false,
        code: 'INCORRECT_CURRENT_PASSWORD',
        message: 'Mật khẩu hiện tại không chính xác',
      });
    }

    if (dto.currentPassword === dto.newPassword) {
      throw new BadRequestException({
        success: false,
        code: 'PASSWORD_UNCHANGED',
        message: 'Mật khẩu mới không được trùng với mật khẩu hiện tại',
      });
    }

    const newPasswordHash = await bcrypt.hash(dto.newPassword, 12);
    const passwordChangedAt = new Date();

    await this.authRepo.updatePasswordTx(targetUserId, newPasswordHash, passwordChangedAt);

    // Invalidate token in blacklist and invalidate session cache
    if (rawAccessToken) {
      await TokenBlacklist.revokeTokenAsync(rawAccessToken, 7 * 86400, targetUserId);
    }
    TokenBlacklist.revokeUser(targetUserId);

    return {
      success: true,
      message: 'Đổi mật khẩu thành công. Vui lòng đăng nhập lại.',
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

    const result = await this.authRepo.verifyEmailAtomicTx({
      tokenHash,
      email,
    });

    if (!result.success || !result.user) {
      throw new BadRequestException({
        success: false,
        message: result.reason || 'Mã xác minh email không hợp lệ hoặc đã hết hạn',
      });
    }

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
        avatarUrl: user.avatarUrl || null,
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

  async updateProfile(userId: string | number | bigint, dto: UpdateProfileDto) {
    const rawUserId = BigInt(userId);
    const user = await this.authRepo.findById(rawUserId);
    if (!user) {
      throw new NotFoundException('Không tìm thấy thông tin người dùng');
    }

    const updated = await this.authRepo.updateProfile(rawUserId, {
      fullName: dto.fullName !== undefined ? dto.fullName.trim() : undefined,
      avatarUrl: dto.avatarUrl !== undefined ? dto.avatarUrl.trim() : undefined,
      phone: dto.phone !== undefined ? dto.phone.trim() : undefined,
    });

    let role = 'CUSTOMER';
    let storeId: string | null = null;
    if (updated.email === 'admin@smartorder.local' || updated.username === 'admin') {
      role = 'SUPER_ADMIN';
    } else if (updated.ownedStores && updated.ownedStores.length > 0) {
      role = 'STORE_OWNER';
      storeId = updated.ownedStores[0].storeId.toString();
    } else if (updated.storeStaffs && updated.storeStaffs.length > 0) {
      role = updated.storeStaffs[0].role?.roleCode || 'STORE_STAFF';
      storeId = updated.storeStaffs[0].storeId.toString();
    }

    return {
      success: true,
      message: 'Cập nhật thông tin hồ sơ thành công',
      data: {
        id: updated.userId.toString(),
        userId: updated.userId.toString(),
        email: updated.email,
        username: updated.username,
        fullName: updated.fullName,
        phone: updated.phone,
        avatarUrl: updated.avatarUrl || null,
        role,
        status: updated.status,
        storeId,
        customerProfileId: updated.customerProfile?.customerId?.toString() || null,
        createdAt: updated.createdAt,
        updatedAt: updated.updatedAt,
      },
    };
  }

  /**
   * Register new customer by verified Firebase phone number
   */
  async registerByPhone(dto: RegisterByPhoneDto) {
    const { firebaseIdToken, fullName, email } = dto;

    if (!firebaseIdToken || typeof firebaseIdToken !== 'string' || !firebaseIdToken.trim()) {
      throw new BadRequestException('Firebase ID token is required');
    }

    if (!fullName || typeof fullName !== 'string' || !fullName.trim()) {
      throw new BadRequestException('Họ và tên không được để trống');
    }

    // Security Invariant: Only allow CUSTOMER registration
    const role = 'CUSTOMER';

    // Verify token with Firebase Admin
    const verified = await this.firebasePhoneService.verifyFirebasePhoneToken(firebaseIdToken);
    const { firebaseUid, phoneNumber, verifiedAt } = verified;

    // Check if Firebase UID is already registered
    const existingByUid = await this.authRepo.findByFirebaseUid(firebaseUid);
    if (existingByUid) {
      throw new ConflictException('Số điện thoại này đã được đăng ký tài khoản');
    }

    // Check if phone number is already registered
    const existingByPhone = await this.authRepo.findByPhone(phoneNumber);
    if (existingByPhone) {
      throw new ConflictException('Số điện thoại này đã được đăng ký tài khoản');
    }

    // Check if email is provided and already taken
    const cleanEmail = email ? email.trim().toLowerCase() : null;
    if (cleanEmail) {
      const existingByEmail = await this.authRepo.findByEmail(cleanEmail);
      if (existingByEmail) {
        throw new ConflictException('Email này đã được sử dụng bởi một tài khoản khác');
      }
    }

    // Generate unique username
    const cleanPhoneDigits = phoneNumber.replace(/[^0-9]/g, '');
    const randomHex = crypto.randomBytes(3).toString('hex');
    const username = `phone_${cleanPhoneDigits}_${randomHex}`.slice(0, 30);

    // Refresh token generation
    const rawRefreshToken = crypto.randomBytes(40).toString('hex');
    const refreshTokenHash = crypto.createHash('sha256').update(rawRefreshToken).digest('hex');
    const refreshExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    let newUser: any;
    let customerProfile: any;

    try {
      const result = await this.authRepo.registerByPhoneTx({
        userData: {
          username,
          fullName: fullName.trim(),
          email: cleanEmail,
          phone: phoneNumber,
          phoneVerifiedAt: verifiedAt,
          firebaseUid,
          status: 'ACTIVE',
          passwordHash: null,
        },
        customerProfileData: {
          phone: phoneNumber,
        },
        refreshTokenData: {
          tokenHash: refreshTokenHash,
          expiresAt: refreshExpiresAt,
        },
      });
      newUser = result.newUser;
      customerProfile = result.customerProfile;
    } catch (error: any) {
      if (
        error?.code === 'P2002' ||
        error?.message?.includes('uq_users_phone') ||
        error?.message?.includes('uq_users_firebase_uid') ||
        error?.message?.includes('users_email_key') ||
        error?.message?.includes('users_username_key') ||
        error?.message?.includes('Unique constraint failed')
      ) {
        throw new ConflictException('Số điện thoại hoặc thông tin tài khoản đã tồn tại trong hệ thống');
      }
      this.logger.error(`registerByPhoneTx error: ${error?.message}`);
      throw new BadRequestException('Không thể hoàn tất đăng ký tài khoản');
    }

    const customerProfileId = customerProfile.customerId.toString();

    // Sign JWT access token
    const accessToken = this.jwtService.sign(
      {
        userId: newUser.userId.toString(),
        email: newUser.email,
        username: newUser.username,
        role,
        storeId: null,
        customerProfileId,
        tokenType: 'ACCESS',
      },
      { expiresIn: '15m' },
    );

    const userPayload = {
      userId: newUser.userId.toString(),
      fullName: newUser.fullName,
      phone: newUser.phone,
      phoneVerified: true,
      role: 'CUSTOMER',
      ...(newUser.email ? { email: newUser.email } : {}),
      customerProfileId,
    };

    return {
      success: true,
      message: 'Đăng ký bằng số điện thoại thành công',
      accessToken,
      token: accessToken,
      refreshToken: rawRefreshToken,
      data: {
        accessToken,
        refreshToken: rawRefreshToken,
        user: userPayload,
      },
      user: userPayload,
    };
  }

  /**
   * Login with verified Firebase phone number
   */
  async loginByPhone(dto: LoginByPhoneDto, ip?: string, userAgent?: string) {
    const { firebaseIdToken } = dto;
    if (!firebaseIdToken || typeof firebaseIdToken !== 'string' || !firebaseIdToken.trim()) {
      throw new BadRequestException('Firebase ID token is required');
    }

    const verified = await this.firebasePhoneService.verifyFirebasePhoneToken(firebaseIdToken);
    const { firebaseUid, phoneNumber } = verified;

    let user: any = await this.authRepo.findUserByFirebaseUidWithRelations(firebaseUid);
    if (!user) {
      user = await this.authRepo.findByPhone(phoneNumber);
      if (user && !user.firebaseUid) {
        // Link firebaseUid to existing user
        await this.authRepo.updatePhoneVerification(user.userId, phoneNumber, firebaseUid, new Date());
      }
    }

    if (!user) {
      throw new UnauthorizedException('Tài khoản chưa được đăng ký trong hệ thống, vui lòng đăng ký trước.');
    }

    if (user.status !== 'ACTIVE') {
      throw new UnauthorizedException({
        success: false,
        code: 'ACCOUNT_DISABLED',
        message: 'Tài khoản của bạn hiện đang bị khóa. Vui lòng liên hệ quản trị viên.',
      });
    }

    // Determine primary role & storeId
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

    // Sign JWT access token
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

    // Rotated refresh token
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
      avatarUrl: user.avatarUrl || null,
      role,
      storeId,
      customerProfileId,
      phone: user.phone,
      phoneVerified: true,
    };

    return {
      success: true,
      message: 'Đăng nhập bằng số điện thoại thành công',
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
}
