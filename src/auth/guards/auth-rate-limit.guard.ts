import {
  Injectable,
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { extractTrustedClientIp } from '../../common/utils/client-ip.util';

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

function extractLoginIdentifier(body: any): string {
  const raw = body?.email ?? body?.username ?? body?.identifier;
  if (typeof raw !== 'string') return '';
  return raw.trim().toLowerCase().slice(0, 120);
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

  private static consumeBucket(
    key: string,
    maxRequests: number,
    windowMs: number,
    now: number,
  ): { allowed: boolean; retryAfterSec: number } {
    const record = AuthRateLimitGuard.limits.get(key);
    if (!record || now > record.resetTime) {
      AuthRateLimitGuard.limits.set(key, {
        count: 1,
        resetTime: now + windowMs,
      });
      return { allowed: true, retryAfterSec: Math.ceil(windowMs / 1000) };
    }

    if (record.count >= maxRequests) {
      const retryAfterSec = Math.max(1, Math.ceil((record.resetTime - now) / 1000));
      return { allowed: false, retryAfterSec };
    }

    record.count++;
    return {
      allowed: true,
      retryAfterSec: Math.max(1, Math.ceil((record.resetTime - now) / 1000)),
    };
  }

  private static throwRateLimited(response: any, retryAfterSec: number): never {
    if (typeof response?.setHeader === 'function') {
      response.setHeader('Retry-After', String(retryAfterSec));
    }
    throw new HttpException(
      {
        success: false,
        code: 'RATE_LIMITED',
        retryAfter: retryAfterSec,
        message: `Bạn đã thử thao tác quá nhiều lần. Vui lòng thử lại sau ${retryAfterSec} giây.`,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  canActivate(context: ExecutionContext): boolean {
    if (process.env.NODE_ENV === 'test') {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const response = context.switchToHttp().getResponse();
    const ip = normalizeClientIp(extractTrustedClientIp(request));

    const path = request.route?.path || request.url || '';
    const now = Date.now();
    AuthRateLimitGuard.cleanupExpired(now);

    if (path.includes('login')) {
      const windowMs = 60 * 1000;
      const identifier = extractLoginIdentifier(request.body);
      const ipBucket = AuthRateLimitGuard.consumeBucket(
        `login-ip:${ip}:${path}`,
        identifier ? 40 : 10,
        windowMs,
        now,
      );
      if (!ipBucket.allowed) {
        AuthRateLimitGuard.throwRateLimited(response, ipBucket.retryAfterSec);
      }

      if (identifier) {
        const accountBucket = AuthRateLimitGuard.consumeBucket(
          `login-acct:${ip}:${identifier}`,
          10,
          windowMs,
          now,
        );
        if (!accountBucket.allowed) {
          AuthRateLimitGuard.throwRateLimited(response, accountBucket.retryAfterSec);
        }
      }
      return true;
    }

    // Default window: 1 minute
    let windowMs = 60 * 1000;
    let maxRequests = 30;

    if (path.includes('register')) {
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

    const bucket = AuthRateLimitGuard.consumeBucket(`${ip}:${path}`, maxRequests, windowMs, now);
    if (!bucket.allowed) {
      AuthRateLimitGuard.throwRateLimited(response, bucket.retryAfterSec);
    }

    return true;
  }
}
