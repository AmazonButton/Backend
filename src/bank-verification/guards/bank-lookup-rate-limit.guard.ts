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
export class BankLookupRateLimitGuard implements CanActivate {
  private static readonly limits = new Map<string, RateLimitRecord>();

  /**
   * Reset rate limit cache (dành cho test suites)
   */
  static reset(): void {
    BankLookupRateLimitGuard.limits.clear();
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const userId = request.user?.userId || request.user?.id || 'anonymous';
    let ip = request.ip || request.socket?.remoteAddress || '127.0.0.1';

    if (process.env.TRUST_PROXY === 'true' && request.headers['x-forwarded-for']) {
      const raw = request.headers['x-forwarded-for'];
      const first = Array.isArray(raw) ? raw[0] : raw.split(',')[0];
      if (first) ip = first.trim();
    }

    const now = Date.now();
    const windowMs = 60 * 1000; // Cửa sổ 1 phút
    const maxRequests = Number(process.env.BANK_LOOKUP_RATE_LIMIT || 15); // Giới hạn 15 lần tra cứu/phút

    const key = `lookup:${userId}:${ip}`;
    const record = BankLookupRateLimitGuard.limits.get(key);

    if (!record || now > record.resetTime) {
      BankLookupRateLimitGuard.limits.set(key, {
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
          message: 'Bạn đã thực hiện tra cứu tài khoản quá nhiều lần. Vui lòng thử lại sau 1 phút.',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    record.count++;
    return true;
  }
}
