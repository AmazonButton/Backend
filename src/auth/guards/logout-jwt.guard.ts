import { Injectable, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

@Injectable()
export class LogoutJwtGuard extends AuthGuard('jwt') {
  handleRequest(err: any, user: any, info: any) {
    if (info) {
      if (
        info.name === 'JsonWebTokenError' ||
        info.message?.toLowerCase().includes('invalid signature') ||
        info.message?.toLowerCase().includes('jwt malformed') ||
        info.message?.toLowerCase().includes('invalid token')
      ) {
        throw new UnauthorizedException('Chữ ký token không hợp lệ hoặc token bị làm giả');
      }

      // Expired token is allowed for logout revocation so long as signature was valid
      if (info.name === 'TokenExpiredError') {
        return { isExpired: true };
      }
    }

    if (err) {
      if (err instanceof UnauthorizedException) throw err;
      throw new UnauthorizedException('Xác thực token thất bại');
    }

    return user || null;
  }
}
