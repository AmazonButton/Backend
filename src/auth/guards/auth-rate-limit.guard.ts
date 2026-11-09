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

function normalizeClientIp(rawIp: string): string {
  let ip = (rawIp || '').trim();
  if (ip.startsWith('::ffff:')) {
    ip = ip.substring(7);
  }
  // Mask IPv6 to /64 subnet
  if (ip.includes(':')) {
    const groups = ip.split(':');
    return groups.slice(0, 4).join(':') + '::/64';
  }
  return ip || '127.0.0.1';
}

@Injectable()
export class AuthRateLimitGuard implements CanActivate {
  private static limits = new Map<string, RateLimitRecord>();
  private static lastCleanup = Date.now();
  private static readonly MAX_ENTRIES = 5000;

  private static cleanupExpired(now: number) {
    if (now - this.lastCleanup > 60000 || this.limits.size > this.MAX_ENTRIES) {
      this.lastCleanup = now;
      for (const [k, v] of this.limits.entries()) {
        if (now > v.resetTime) {
          this.limits.delete(k);
        }
      }
      if (this.limits.size > this.MAX_ENTRIES) {
        const deleteCount = this.limits.size - this.MAX_ENTRIES;
        let deleted = 0;
        for (const k of this.limits.keys()) {
          this.limits.delete(k);
          deleted++;
          if (deleted >= deleteCount) break;
        }
      }
    }
  }

  canActivate(context: ExecutionContext): boolean {
    if (process.env.NODE_ENV === 'test') {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const rawIp = (request.headers?.['cf-connecting-ip'] as string) || request.ip || request.socket?.remoteAddress || '127.0.0.1';
    const ip = normalizeClientIp(rawIp);

    const path = request.route?.path || request.url;
    const now = Date.now();
    AuthRateLimitGuard.cleanupExpired(now);

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
      maxRequests = 30;
      windowMs = 15 * 60 * 1000; // 15 minutes
    } else if (path.includes('check-email') || path.includes('check-username')) {
      maxRequests = 100;
      windowMs = 60 * 1000;
    } else if (path.includes('logout')) {
      maxRequests = 20;
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
