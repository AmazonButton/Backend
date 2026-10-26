import { Injectable, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

@Injectable()
export class OptionalJwtAuthGuard extends AuthGuard('jwt') {
  handleRequest(err: any, user: any, info: any) {
    if (info) {
      // If a token was provided but the cryptographic signature is invalid or tampered:
      if (
        info.name === 'JsonWebTokenError' ||
        info.message?.toLowerCase().includes('invalid signature') ||
        info.message?.toLowerCase().includes('jwt malformed') ||
        info.message?.toLowerCase().includes('invalid token')
      ) {
        throw new UnauthorizedException('Chữ ký token không hợp lệ hoặc token bị làm giả');
      }

      // If token expired: the signature was valid, but expiration time passed
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
