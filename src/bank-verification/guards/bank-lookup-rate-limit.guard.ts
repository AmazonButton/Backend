import {
  Injectable,
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Logger,
  OnModuleDestroy,
} from '@nestjs/common';
import Redis from 'ioredis';

interface RateLimitRecord {
  count: number;
  resetTime: number;
}

@Injectable()
export class BankLookupRateLimitGuard implements CanActivate, OnModuleDestroy {
  private static readonly logger = new Logger(BankLookupRateLimitGuard.name);
  private static readonly memoryLimits = new Map<string, RateLimitRecord>();
  private static redisClient: Redis | null = null;
  private static redisInitialized = false;

  /**
   * Khởi tạo hoặc tái sử dụng Redis Client kết nối an toàn với graceful fallback
   */
  private static getRedisClient(): Redis | null {
    if (this.redisInitialized) {
      return this.redisClient;
    }

    const redisUrl = process.env.REDIS_URL || process.env.REDIS_CACHE_URL;
    const redisHost = process.env.REDIS_HOST;

    if (redisUrl || redisHost) {
      try {
        const client = redisUrl
          ? new Redis(redisUrl, {
              lazyConnect: true,
              maxRetriesPerRequest: 1,
              enableOfflineQueue: false,
            })
          : new Redis({
              host: redisHost || '127.0.0.1',
              port: Number(process.env.REDIS_PORT) || 6379,
              password: process.env.REDIS_PASSWORD || undefined,
              lazyConnect: true,
              maxRetriesPerRequest: 1,
              enableOfflineQueue: false,
            });

        client.on('error', (err) => {
          this.logger.warn(`Redis connection error, falling back to memory: ${err?.message}`);
        });

        this.redisClient = client;
      } catch (err: any) {
        this.logger.warn(`Failed to initialize Redis client: ${err?.message}`);
      }
    }

    this.redisInitialized = true;
    return this.redisClient;
  }

  /**
   * Reset rate limit cache (dành cho test suites)
   */
  static async reset(): Promise<void> {
    BankLookupRateLimitGuard.memoryLimits.clear();
    const redis = BankLookupRateLimitGuard.redisClient;
    if (redis && redis.status === 'ready') {
      try {
        const keys = await redis.keys('rate_limit:bank_lookup:*');
        if (keys.length > 0) {
          await redis.del(...keys);
        }
      } catch {
        // Ignore test cleanup errors
      }
    }
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const userId = request.user?.userId || request.user?.id || 'anonymous';
    const ip = request.ip || request.socket?.remoteAddress || '127.0.0.1';

    const maxRequests = Number(process.env.BANK_LOOKUP_RATE_LIMIT || 15); // Giới hạn 15 lần tra cứu/phút
    const windowSec = 60; // 60 giây TTL
    const key = `rate_limit:bank_lookup:${userId}:${ip}`;

    const redis = BankLookupRateLimitGuard.getRedisClient();
    const isProduction = process.env.NODE_ENV === 'production';

    // 1. Kiểm tra trạng thái Redis trong môi trường Production (Bắt buộc phân tán, cấm RAM fallback)
    if (isProduction && (!redis || redis.status !== 'ready')) {
      BankLookupRateLimitGuard.logger.error(
        `[BankLookupRateLimitGuard] Production fail-closed: Redis client is not ready (status: ${redis?.status || 'unconfigured'})`,
      );
      throw new HttpException(
        {
          success: false,
          code: 'RATE_LIMIT_SERVICE_UNAVAILABLE',
          message: 'Dịch vụ tra cứu tài khoản đang tạm thời bảo trì hệ thống phân tán. Vui lòng thử lại sau ít phút.',
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    // 2. Thao tác atomic INCR trên Redis nếu có kết nối
    if (redis && redis.status === 'ready') {
      try {
        const currentCount = await redis.incr(key);
        if (currentCount === 1) {
          await redis.expire(key, windowSec);
        }

        if (currentCount > maxRequests) {
          throw new HttpException(
            {
              success: false,
              code: 'RATE_LIMITED',
              message: 'Bạn đã thực hiện tra cứu tài khoản quá nhiều lần. Vui lòng thử lại sau 1 phút.',
            },
            HttpStatus.TOO_MANY_REQUESTS,
          );
        }
        return true;
      } catch (err: any) {
        if (err instanceof HttpException) throw err;

        if (isProduction) {
          BankLookupRateLimitGuard.logger.error(
            `[BankLookupRateLimitGuard] Redis atomic INCR failed in production: ${err?.message}`,
          );
          throw new HttpException(
            {
              success: false,
              code: 'RATE_LIMIT_SERVICE_UNAVAILABLE',
              message: 'Dịch vụ tra cứu tài khoản đang tạm thời bảo trì hệ thống phân tán. Vui lòng thử lại sau ít phút.',
            },
            HttpStatus.SERVICE_UNAVAILABLE,
          );
        }

        BankLookupRateLimitGuard.logger.warn(
          `Redis INCR error, falling back to in-memory rate limiting: ${err?.message}`,
        );
      }
    }

    // 3. In-memory Fallback (CHỈ cho phép trong môi trường Non-Production / Test / Local Dev)
    const now = Date.now();
    const windowMs = windowSec * 1000;
    const record = BankLookupRateLimitGuard.memoryLimits.get(key);

    if (!record || now > record.resetTime) {
      BankLookupRateLimitGuard.memoryLimits.set(key, {
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

  onModuleDestroy() {
    if (BankLookupRateLimitGuard.redisClient) {
      BankLookupRateLimitGuard.redisClient.disconnect();
      BankLookupRateLimitGuard.redisClient = null;
      BankLookupRateLimitGuard.redisInitialized = false;
    }
  }
}
