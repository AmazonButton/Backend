import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

@Injectable()
export class DashboardCacheService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DashboardCacheService.name);
  private redisClient: Redis | null = null;
  private readonly memoryCache = new Map<string, CacheEntry<any>>();
  private cleanupTimer: NodeJS.Timeout | null = null;

  async onModuleInit() {
    const rawRedisUrl = process.env.REDIS_CACHE_URL || process.env.REDIS_URL || process.env.REDIS_HOST;
    const redisDisabled = process.env.DISABLE_REDIS === 'true';

    if (!rawRedisUrl || redisDisabled) {
      this.logger.log('DashboardCache operating in in-memory mode.');
      this.startMemoryCleanup();
      return;
    }

    try {
      this.redisClient = new Redis(rawRedisUrl, {
        maxRetriesPerRequest: 1,
        enableReadyCheck: true,
        connectTimeout: 2000,
        retryStrategy: (times) => (times > 3 ? null : Math.min(times * 100, 1000)),
      });

      this.redisClient.on('error', (err) => {
        this.logger.warn(`DashboardCache Redis error: ${err.message}. Serving memory cache.`);
      });

      await Promise.race([
        this.redisClient.ping(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Redis ping timeout')), 1500)),
      ]);

      this.logger.log('DashboardCache connected to Redis.');
    } catch (err: any) {
      this.logger.warn(`DashboardCache Redis connect failed: ${err.message}. Falling back to memory.`);
      if (this.redisClient) {
        try {
          this.redisClient.disconnect();
        } catch (_) {}
        this.redisClient = null;
      }
      this.startMemoryCleanup();
    }
  }

  async onModuleDestroy() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    if (this.redisClient) {
      try {
        await this.redisClient.quit();
      } catch (_) {}
      this.redisClient = null;
    }
  }

  private startMemoryCleanup() {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of this.memoryCache.entries()) {
        if (entry.expiresAt <= now) {
          this.memoryCache.delete(key);
        }
      }
    }, 30000);
  }

  async get<T = any>(key: string): Promise<T | null> {
    if (this.redisClient) {
      try {
        const raw = await this.redisClient.get(key);
        if (raw) return JSON.parse(raw) as T;
      } catch (err: any) {
        this.logger.warn(`Redis get failed for [${key}]: ${err.message}`);
      }
    }

    const entry = this.memoryCache.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.memoryCache.delete(key);
      return null;
    }
    return entry.value as T;
  }

  async set<T = any>(key: string, value: T, ttlSeconds = 60): Promise<void> {
    const serialized = JSON.stringify(value);
    if (this.redisClient) {
      try {
        await this.redisClient.setex(key, ttlSeconds, serialized);
        return;
      } catch (err: any) {
        this.logger.warn(`Redis set failed for [${key}]: ${err.message}`);
      }
    }

    if (this.memoryCache.size > 2000) {
      const firstKey = this.memoryCache.keys().next().value;
      if (firstKey) this.memoryCache.delete(firstKey);
    }

    this.memoryCache.set(key, {
      value,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  }

  async getOrSet<T = any>(key: string, ttlSeconds: number, fetcher: () => Promise<T>): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== null) return cached;

    const fresh = await fetcher();
    await this.set(key, fresh, ttlSeconds);
    return fresh;
  }

  async invalidateKey(key: string): Promise<void> {
    this.memoryCache.delete(key);

    if (!this.redisClient) return;

    try {
      await this.redisClient.del(key);
    } catch {
      this.logger.warn('Dashboard cache key invalidation failed');
    }
  }

  async invalidatePrefix(prefix: string): Promise<void> {
    for (const key of Array.from(this.memoryCache.keys())) {
      if (key.startsWith(prefix)) {
        this.memoryCache.delete(key);
      }
    }

    if (this.redisClient) {
      try {
        let cursor = '0';
        do {
          const [nextCursor, keys] = await this.redisClient.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 100);
          cursor = nextCursor;
          if (keys && keys.length > 0) {
            if (typeof (this.redisClient as any).unlink === 'function') {
              await (this.redisClient as any).unlink(...keys);
            } else {
              await this.redisClient.del(...keys);
            }
          }
        } while (cursor !== '0');
      } catch (err: any) {
        this.logger.warn(`Redis invalidatePrefix failed for [${prefix}]: ${err.message}`);
      }
    }
  }
}
