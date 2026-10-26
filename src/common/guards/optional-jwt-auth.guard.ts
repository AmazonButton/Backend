import { Injectable, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

@Injectable()
export class OptionalJwtAuthGuard extends AuthGuard('jwt') {
  handleRequest(err: any, user: any, info: any) {
    if (info) {
      // If a token was supplied in headers, but failed verification (tampered, malformed, or expired):
      // Reject with 401 Unauthorized so authenticated users never accidentally place orders as guests when their token expired!
      if (
        info.name === 'TokenExpiredError' ||
        info.message?.toLowerCase().includes('expired')
      ) {
        throw new UnauthorizedException('Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại để tiếp tục.');
      }

      if (
        info.name === 'JsonWebTokenError' ||
        info.message?.toLowerCase().includes('invalid signature') ||
        info.message?.toLowerCase().includes('jwt malformed') ||
        info.message?.toLowerCase().includes('invalid token')
      ) {
        throw new UnauthorizedException('Chữ ký token không hợp lệ hoặc token bị làm giả');
      }
    }

    if (err) {
      if (err instanceof UnauthorizedException) throw err;
      throw new UnauthorizedException('Xác thực token thất bại');
    }

    // No token provided in Authorization header -> guest user
    return user || null;
  }
}
