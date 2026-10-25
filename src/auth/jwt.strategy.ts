import { Injectable, UnauthorizedException, Inject } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../prisma/prisma.service';
import { TokenBlacklist } from './token-blacklist';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: process.env.JWT_SECRET || 'sob_jwt_secret_dev_2026',
      passReqToCallback: true,
    });
  }

  async validate(req: any, payload: any) {
    if (!payload || !payload.userId) {
      throw new UnauthorizedException('Token không hợp lệ');
    }

    const rawToken = ExtractJwt.fromAuthHeaderAsBearerToken()(req);

    // Multi-Instance Distributed Blacklist Check via PostgreSQL
    if (rawToken) {
      const tokenHash = TokenBlacklist.hashToken(rawToken);
      const revokedInDb = await this.prisma.revokedToken.findUnique({
        where: { tokenHash },
      });
      if (revokedInDb) {
        throw new UnauthorizedException('Phiên đăng nhập đã kết thúc do bạn đã đăng xuất. Vui lòng đăng nhập lại.');
      }
    }

    // Check local memory cache & user-wide logout timestamp
    if (TokenBlacklist.isRevoked(payload.userId, payload.iat, rawToken || undefined)) {
      throw new UnauthorizedException('Phiên đăng nhập đã kết thúc do bạn đã đăng xuất. Vui lòng đăng nhập lại.');
    }

    try {
      const targetUserId = BigInt(payload.userId);
      const user = await this.prisma.user.findUnique({
        where: { userId: targetUserId },
        include: {
          customerProfile: true,
          ownedStores: true,
          storeStaffs: { include: { role: true, store: true } },
        },
      });

      if (!user || user.status !== 'ACTIVE') {
        throw new UnauthorizedException('Tài khoản không tồn tại hoặc đã bị vô hiệu hóa');
      }

      if (user.passwordChangedAt && payload.iat) {
        const passwordChangedSec = Math.floor(new Date(user.passwordChangedAt).getTime() / 1000);
        if (payload.iat < passwordChangedSec) {
          throw new UnauthorizedException('Mật khẩu đã được thay đổi. Vui lòng đăng nhập lại.');
        }
      }

      let role = payload.role || 'CUSTOMER';
      let storeId = payload.storeId || null;
      let customerProfileId = user.customerProfile?.customerId?.toString() || payload.customerProfileId || null;

      const superAdminEmails = (process.env.SUPER_ADMIN_EMAILS || 'admin@smartorder.local')
        .split(',')
        .map((e) => e.trim().toLowerCase());
      const isPlatformAdmin =
        payload.role === 'SUPER_ADMIN' ||
        payload.role === 'SYSTEM_ADMIN' ||
        payload.role === 'ADMIN' ||
        superAdminEmails.includes((user.email || '').toLowerCase()) ||
        user.username === 'admin' ||
        user.storeStaffs?.some(
          (s: any) => s.role?.roleCode === 'SUPER_ADMIN' || s.role?.roleCode === 'SYSTEM_ADMIN',
        );

      if (isPlatformAdmin) {
        role = payload.role || 'SUPER_ADMIN';
      } else if (user.ownedStores && user.ownedStores.length > 0) {
        storeId = user.ownedStores[0].storeId.toString();
        role = 'STORE_OWNER';
      } else if (user.storeStaffs && user.storeStaffs.length > 0) {
        // If payload had a storeId, ensure it matches an active membership
        const activeMembership = payload.storeId
          ? user.storeStaffs.find(
              (s: any) => s.storeId.toString() === payload.storeId.toString() && s.status === 'ACTIVE',
            )
          : user.storeStaffs.find((s: any) => s.status === 'ACTIVE');

        if (activeMembership) {
          storeId = activeMembership.storeId.toString();
          role = activeMembership.role?.roleCode || payload.role || 'STORE_STAFF';
        } else {
          // Stale authority revocation: Staff member has records in DB, but NONE are ACTIVE (e.g. TERMINATED/INACTIVE)
          storeId = null;
          role = 'CUSTOMER';
        }
      } else {
        // Fallback for direct token roles (e.g. system tests, custom driver tokens)
        role = payload.role || 'CUSTOMER';
        storeId = payload.storeId || null;
      }

      return {
        id: user.userId.toString(),
        userId: user.userId.toString(),
        email: user.email,
        username: user.username,
        fullName: user.fullName,
        avatarUrl: user.avatarUrl || null,
        role,
        storeId,
        customerProfileId,
      };
    } catch (err: any) {
      if (err instanceof UnauthorizedException) {
        throw err;
      }
      throw new UnauthorizedException('Không thể xác thực phiên làm việc');
    }
  }
}
