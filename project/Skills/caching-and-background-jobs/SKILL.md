---
name: caching-and-background-jobs
description: >-
  Use this skill when implementing high-performance caching (Cache-Aside pattern with Redis),
  cache invalidation on mutations, or running asynchronous background tasks (BullMQ queues) for emails, reports, or image processing.
---

# Caching with Redis & Asynchronous Job Queues with BullMQ

This skill establishes patterns for scaling read performance and offloading heavy computational or external I/O tasks away from the Express HTTP event loop.

---

## 1. Redis Client Configuration (`src/config/redis.js`)

Centralize the Redis connection with auto-reconnect, error logging, and graceful teardown:

```javascript
import Redis from 'ioredis';
import { env } from './env.js';
import { logger } from '../utils/logger.js';

export const redis = new Redis(env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: null, // Required by BullMQ
  enableReadyCheck: false,
  retryStrategy(times) {
    const delay = Math.min(times * 100, 3000);
    return delay;
  }
});

redis.on('connect', () => logger.info('✅ Redis connected successfully'));
redis.on('error', (err) => logger.error('❌ Redis connection error', err));
```

---

## 2. Cache-Aside Pattern & Invalidation Helper (`src/utils/cache.js`)

Fetch from Redis first; on a cache miss, query the database, store in Redis with a TTL, and return the result:

```javascript
import { redis } from '../config/redis.js';
import { logger } from './logger.js';

/**
 * Cache-Aside generic runner
 * @param {string} key - Redis key
 * @param {number} ttlSeconds - Expiration time in seconds
 * @param {Function} fetchFn - Database fallback fetch function
 */
export const getOrSetCache = async (key, ttlSeconds, fetchFn) => {
  try {
    const cached = await redis.get(key);
    if (cached) {
      return JSON.parse(cached);
    }
  } catch (err) {
    logger.warn(`Redis get failed for key: ${key}, falling back to DB`, err);
  }

  // Fallback to database
  const freshData = await fetchFn();

  if (freshData !== null && freshData !== undefined) {
    try {
      await redis.setex(key, ttlSeconds, JSON.stringify(freshData));
    } catch (err) {
      logger.warn(`Redis set failed for key: ${key}`, err);
    }
  }

  return freshData;
};

/**
 * Invalidate multiple keys matching a wildcard pattern
 * Example: invalidateCachePattern('books:*')
 */
export const invalidateCachePattern = async (pattern) => {
  try {
    const stream = redis.scanStream({ match: pattern, count: 100 });
    stream.on('data', async (keys = []) => {
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    });
  } catch (err) {
    logger.error(`Failed to invalidate cache pattern: ${pattern}`, err);
  }
};
```

---

## 3. Background Job Queue with BullMQ (`src/queues/email.queue.js`)

Offload long-running operations (such as sending verification emails or generating export files) so they do not block API latency:

### A. Queue Producer
```javascript
import { Queue } from 'bullmq';
import { redis } from '../config/redis.js';

export const emailQueue = new Queue('email-queue', {
  connection: redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000
    },
    removeOnComplete: true,
    removeOnFail: false
  }
});

export const addWelcomeEmailJob = async (user) => {
  return await emailQueue.add('send-welcome-email', {
    to: user.email,
    username: user.username,
    subject: 'Welcome to our platform!'
  });
};
```

### B. Worker Consumer (`src/workers/email.worker.js`)
Runs as a background process or alongside the main server:

```javascript
import { Worker } from 'bullmq';
import { redis } from '../config/redis.js';
import { logger } from '../utils/logger.js';

export const emailWorker = new Worker(
  'email-queue',
  async (job) => {
    logger.info(`Processing job ${job.id} of type ${job.name}`);

    if (job.name === 'send-welcome-email') {
      const { to, username } = job.data;
      // Call SMTP / SendGrid / Resend API here
      logger.info(`Sent welcome email to ${to} (${username})`);
    }
  },
  { connection: redis, concurrency: 5 }
);

emailWorker.on('completed', (job) => {
  logger.info(`Job ${job.id} completed successfully`);
});

emailWorker.on('failed', (job, err) => {
  logger.error(`Job ${job?.id} failed with error: ${err.message}`);
});
```
