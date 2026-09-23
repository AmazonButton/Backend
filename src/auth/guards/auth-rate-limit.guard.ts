import {
  Injectable,
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
} from '@nestjs/common';

interface RateLimitRecord {
  count: number;
  resetTime: number;
}

@Injectable()
export class AuthRateLimitGuard implements CanActivate {
  private static limits = new Map<string, RateLimitRecord>();

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const ip =
      request.headers['x-forwarded-for']?.toString()?.split(',')[0]?.trim() ||
      request.ip ||
      request.connection?.remoteAddress ||
      '127.0.0.1';

    const path = request.route?.path || request.url;
    const now = Date.now();

    // Default window: 1 minute
    let windowMs = 60 * 1000;
    let maxRequests = 30;

    if (path.includes('login')) {
      maxRequests = 10;
      windowMs = 60 * 1000;
    } else if (path.includes('register')) {
      maxRequests = 10;
      windowMs = 60 * 1000;
    } else if (path.includes('forgot-password') || path.includes('reset-password')) {
      maxRequests = 6;
      windowMs = 15 * 60 * 1000; // 15 minutes
    } else if (path.includes('check-email') || path.includes('check-username')) {
      maxRequests = 100;
      windowMs = 60 * 1000;
    }

    const key = `${ip}:${path}`;
    const record = AuthRateLimitGuard.limits.get(key);

    if (!record || now > record.resetTime) {
      AuthRateLimitGuard.limits.set(key, {
        count: 1,
        resetTime: now + windowMs,
      });
      return true;
    }

    if (record.count >= maxRequests) {
      throw new HttpException(
        {
          success: false,
          code: 'RATE_LIMITED',
          message: 'Bạn đã thử thao tác quá nhiều lần. Vui lòng thử lại sau.',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    record.count++;
    return true;
  }
}
