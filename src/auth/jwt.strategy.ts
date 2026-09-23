import { Injectable, UnauthorizedException, Inject } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: process.env.JWT_SECRET || 'sob_jwt_secret_dev_2026',
    });
  }

  async validate(payload: any) {
    if (!payload || !payload.userId) {
      throw new UnauthorizedException('Token không hợp lệ');
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

      let role = payload.role || 'CUSTOMER';
      let storeId = payload.storeId || null;
      let customerProfileId = user.customerProfile?.customerId?.toString() || payload.customerProfileId || null;

      if (!storeId && user.ownedStores.length > 0) {
        storeId = user.ownedStores[0].storeId.toString();
        role = 'STORE_OWNER';
      } else if (!storeId && user.storeStaffs.length > 0) {
        storeId = user.storeStaffs[0].storeId.toString();
        role = user.storeStaffs[0].role?.roleCode || 'STORE_STAFF';
      }

      return {
        id: user.userId.toString(),
        userId: user.userId.toString(),
        email: user.email,
        username: user.username,
        fullName: user.fullName,
        role,
        storeId,
        customerProfileId,
      };
    } catch {
      throw new UnauthorizedException('Không thể xác thực phiên làm việc');
    }
  }
}
