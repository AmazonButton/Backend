import { Injectable, UnauthorizedException, Inject } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../prisma/prisma.service';
import { TokenBlacklist } from './token-blacklist';
import { isTokenInvalidatedByTimestamps, resolveAuthority } from './authority.policy';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: (() => {
        const secret = process.env.JWT_SECRET;
        if (!secret) {
          if (process.env.NODE_ENV === 'test') {
            return 'ci_test_jwt_secret_key_minimum_32_characters_long_for_security!';
          }
          throw new Error('FATAL: JWT_SECRET environment variable is required and must not be empty');
        }
        return secret;
      })(),
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
          platformMemberships: { where: { status: 'ACTIVE' }, include: { role: true } },
        },
      });

      if (!user || user.status !== 'ACTIVE') {
        throw new UnauthorizedException('Tài khoản không tồn tại hoặc đã bị vô hiệu hóa');
      }

      if (isTokenInvalidatedByTimestamps(payload.iat, user.passwordChangedAt, user.tokensInvalidBefore)) {
        throw new UnauthorizedException('Phiên đăng nhập đã bị thu hồi hoặc mật khẩu đã đổi. Vui lòng đăng nhập lại.');
      }

      const customerProfileId = user.customerProfile?.customerId?.toString() || payload.customerProfileId || null;
      const authority = resolveAuthority(user, {
        payloadRole: payload.role,
        payloadStoreId: payload.storeId,
        allowTestPayloadFallback: true,
      });

      return {
        id: user.userId.toString(),
        userId: user.userId.toString(),
        email: user.email,
        username: user.username,
        fullName: user.fullName,
        avatarUrl: user.avatarUrl || null,
        role: authority.role,
        storeId: authority.storeId,
        platformRole: authority.platformRole,
        capabilities: authority.capabilities,
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
