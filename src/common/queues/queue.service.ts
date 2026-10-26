import { Injectable, Logger, OnModuleInit, OnModuleDestroy, Inject, Optional } from '@nestjs/common';
import { QueueJob, DeadLetterJob, JobOptions, QueueStats } from './queue.interface';
import { PrismaService } from '../../prisma/prisma.service';
import { Queue as BullQueue, Worker as BullWorker, Job as BullJob } from 'bullmq';
import Redis from 'ioredis';

@Injectable()
export class QueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(QueueService.name);

  // BullMQ instances
  private redisClient: Redis | null = null;
  private isBullMqActive = false;
  private readonly bullQueues: Map<string, BullQueue> = new Map();
  private readonly bullWorkers: Map<string, BullWorker> = new Map();

  // In-memory fallback structures
  private readonly waitingQueues: Map<string, QueueJob[]> = new Map();
  private readonly deadLetterStore: Map<string, DeadLetterJob> = new Map();
  private readonly processors: Map<string, (job: QueueJob) => Promise<any>> = new Map();
  private readonly processingJobs: Set<string> = new Set();
  private readonly stats: Map<string, { completed: number; failed: number }> = new Map();

  private isShuttingDown = false;
  private workerInterval: NodeJS.Timeout | null = null;
  private activeConcurrency = 0;
  private readonly MAX_CONCURRENCY = 10;

  constructor(@Optional() @Inject(PrismaService) private readonly prisma?: PrismaService) {}

  async onModuleInit() {
    await this.initRedisAndBullMQ();
    this.startWorkerLoop();
  }

  async onModuleDestroy() {
    this.isShuttingDown = true;
    if (this.workerInterval) {
      clearInterval(this.workerInterval);
      this.workerInterval = null;
    }

    // Gracefully close BullMQ workers
    const workerClosePromises: Promise<any>[] = [];
    for (const [name, worker] of this.bullWorkers.entries()) {
      this.logger.log(`Closing BullMQ worker for queue [${name}]...`);
      workerClosePromises.push(worker.close());
    }
    await Promise.allSettled(workerClosePromises);

    // Gracefully close BullMQ queues
    const queueClosePromises: Promise<any>[] = [];
    for (const [name, queue] of this.bullQueues.entries()) {
      queueClosePromises.push(queue.close());
    }
    await Promise.allSettled(queueClosePromises);

    // Drain active in-memory jobs if any
    let drainWaitMs = 0;
    while (this.activeConcurrency > 0 && drainWaitMs < 3000) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      drainWaitMs += 100;
    }

    if (this.redisClient) {
      try {
        await this.redisClient.quit();
      } catch (_) {}
      this.redisClient = null;
    }
    this.logger.log('QueueService workers drained and shut down cleanly.');
  }

  /**
   * Health and readiness check: verifies Redis connection ping or in-memory readiness.
   */
  async isReady(): Promise<boolean> {
    if (this.isShuttingDown) return false;

    const isProduction = process.env.NODE_ENV === 'production';
    const requireRedis = isProduction || process.env.REQUIRE_REDIS === 'true';

    if (this.redisClient && this.isBullMqActive) {
      try {
        const pingRes = await this.redisClient.ping();
        return pingRes === 'PONG';
      } catch {
        return false;
      }
    }

    // In production, if Redis is missing or disconnected, fail closed!
    if (requireRedis) {
      return false;
    }

    return true; // Resilient in-memory mode is ready in dev/test
  }

  private maskUrl(url: string): string {
    return url.replace(/(:\/\/[^:]+:)[^@]+(@)/, '$1***$2');
  }

  private async initRedisAndBullMQ() {
    const rawRedisUrl = process.env.REDIS_URL || process.env.REDIS_HOST;
    if (!rawRedisUrl || process.env.DISABLE_REDIS === 'true') {
      this.logger.log('QueueService operating in Resilient In-Memory Mode with PostgreSQL DLQ');
      return;
    }

    const safeUrl = this.maskUrl(rawRedisUrl);
    try {
      this.redisClient = new Redis(rawRedisUrl, {
        maxRetriesPerRequest: null, // Required by BullMQ
        enableReadyCheck: false,
        retryStrategy: (times) => {
          if (times > 5) return null; // Fall back to in-memory if Redis is unreachable
          return Math.min(times * 200, 1000);
        },
      });

      this.redisClient.on('error', (err) => {
        this.logger.warn(`Redis connection error (${safeUrl}): ${err.message}. Retaining in-memory fallback.`);
      });

      // Verify connection with 2s timeout
      const pingPromise = this.redisClient.ping();
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Redis ping timeout')), 2000),
      );
      await Promise.race([pingPromise, timeoutPromise]);

      this.isBullMqActive = true;
      this.logger.log(`BullMQ connected to Redis at ${safeUrl}`);

      // Instantiate BullWorkers for all processors registered before onModuleInit
      for (const [qName, handler] of this.processors.entries()) {
        if (!this.bullWorkers.has(qName)) {
          this.attachBullWorker(qName, handler);
        }
      }

      this.redisClient.on('error', (err) => {
        this.logger.warn(`Redis connection error (${safeUrl}): ${err.message}.`);
        if (process.env.NODE_ENV === 'production') {
          this.isBullMqActive = false;
        }
      });

      this.redisClient.on('close', () => {
        this.logger.warn('Redis connection closed.');
        if (process.env.NODE_ENV === 'production') {
          this.isBullMqActive = false;
        }
      });

      this.redisClient.on('ready', () => {
        this.logger.log('Redis connection re-established.');
        this.isBullMqActive = true;
      });
    } catch (err: any) {
      this.logger.warn(`Could not connect to Redis at ${safeUrl}: ${err.message}. Running in In-Memory fallback.`);
      if (this.redisClient) {
        try {
          this.redisClient.disconnect();
        } catch (_) {}
        this.redisClient = null;
      }
      this.isBullMqActive = false;
    }
  }

  private startWorkerLoop() {
    this.workerInterval = setInterval(() => {
      if (!this.isShuttingDown && !this.isBullMqActive) {
        this.processNextJobs().catch((err) =>
          this.logger.error('Error during queue processing loop', err),
        );
      }
    }, 50);
  }

  /**
   * Register a background worker handler for a specific queue name.
   */
  registerProcessor(queueName: string, handler: (job: QueueJob) => Promise<any>) {
    this.processors.set(queueName, handler);
    if (!this.waitingQueues.has(queueName)) {
      this.waitingQueues.set(queueName, []);
    }
    if (!this.stats.has(queueName)) {
      this.stats.set(queueName, { completed: 0, failed: 0 });
    }

    // If BullMQ is active, instantiate true BullWorker
    if (this.isBullMqActive && this.redisClient) {
      this.attachBullWorker(queueName, handler);
    } else {
      this.logger.log(`In-Memory Worker registered for queue: [${queueName}]`);
    }
  }

  private attachBullWorker(queueName: string, handler: (job: QueueJob) => Promise<any>) {
    if (!this.redisClient) return;
    try {
      const worker = new BullWorker(
        queueName,
        async (bullJob: BullJob) => {
          const queueJob: QueueJob = {
            id: bullJob.id || `job_${Date.now()}`,
            queueName,
            jobName: bullJob.name,
            data: bullJob.data,
            opts: {
              attempts: bullJob.opts.attempts,
              backoffDelayMs: typeof bullJob.opts.backoff === 'object' ? bullJob.opts.backoff?.delay : 1000,
              priority: bullJob.opts.priority,
            },
            attemptsMade: bullJob.attemptsMade,
            createdAt: new Date(bullJob.timestamp),
          };
          return handler(queueJob);
        },
        {
          connection: this.redisClient.duplicate({ maxRetriesPerRequest: null }),
          concurrency: 5,
        },
      );

      worker.on('failed', async (bullJob, err) => {
        if (!bullJob) return;
        const maxAttempts = bullJob.opts.attempts || 3;
        if (bullJob.attemptsMade >= maxAttempts) {
          await this.moveToDeadLetterQueue(
            {
              id: bullJob.id || `job_${Date.now()}`,
              queueName,
              jobName: bullJob.name,
              data: bullJob.data,
              opts: { attempts: maxAttempts },
              attemptsMade: bullJob.attemptsMade,
              createdAt: new Date(bullJob.timestamp),
            },
            err,
          );
        }
      });

      this.bullWorkers.set(queueName, worker);
      this.logger.log(`BullMQ Worker registered for queue: [${queueName}]`);
    } catch (err: any) {
      this.logger.error(`Failed to register BullMQ worker for [${queueName}]: ${err.message}`);
    }
  }

  private getOrCreateBullQueue(queueName: string): BullQueue | null {
    if (!this.isBullMqActive || !this.redisClient) return null;
    let queue = this.bullQueues.get(queueName);
    if (!queue) {
      queue = new BullQueue(queueName, {
        connection: this.redisClient.duplicate({ maxRetriesPerRequest: null }),
      });
      this.bullQueues.set(queueName, queue);
    }
    return queue;
  }

  /**
   * Enqueue a job into the queue with configurable retry options and exponential backoff.
   */
  async enqueueJob<T = any>(
    queueName: string,
    jobName: string,
    data: T,
    options: JobOptions = {},
  ): Promise<string> {
    const defaultAttempts = options.attempts ?? 3;
    const defaultBackoff = options.backoffDelayMs ?? 1000;
    const defaultType = options.backoffType ?? 'exponential';
    const jobId = options.jobId || `job_${jobName}_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

    // Try BullMQ dispatch first if available
    const bullQueue = this.getOrCreateBullQueue(queueName);
    if (bullQueue) {
      try {
        const addedJob = await bullQueue.add(jobName, data, {
          jobId,
          attempts: defaultAttempts,
          backoff: {
            type: defaultType,
            delay: defaultBackoff,
          },
          delay: options.delayMs,
          priority: options.priority,
          removeOnComplete: 100,
          removeOnFail: false,
        });
        return addedJob.id || jobId;
      } catch (err: any) {
        this.logger.warn(`BullMQ enqueue failed: ${err.message}. Enqueueing to in-memory fallback.`);
      }
    }

    // In-memory queue fallback
    const job: QueueJob<T> = {
      id: jobId,
      queueName,
      jobName,
      data,
      opts: {
        attempts: defaultAttempts,
        backoffDelayMs: defaultBackoff,
        backoffType: defaultType,
        ...options,
      },
      attemptsMade: 0,
      createdAt: new Date(),
    };

    if (!this.waitingQueues.has(queueName)) {
      this.waitingQueues.set(queueName, []);
    }
    if (!this.stats.has(queueName)) {
      this.stats.set(queueName, { completed: 0, failed: 0 });
    }

    const pushJob = () => {
      if (this.isShuttingDown) return;
      const list = this.waitingQueues.get(queueName);
      if (list) {
        list.push(job);
        // Sort by priority descending if priority specified
        if (options.priority !== undefined) {
          list.sort((a, b) => (b.opts.priority ?? 0) - (a.opts.priority ?? 0));
        }
      }
    };

    if (options.delayMs && options.delayMs > 0) {
      setTimeout(pushJob, options.delayMs);
    } else {
      pushJob();
    }

    return jobId;
  }

  private async processNextJobs() {
    if (this.activeConcurrency >= this.MAX_CONCURRENCY) return;

    for (const [queueName, jobs] of this.waitingQueues.entries()) {
      if (jobs.length === 0) continue;

      const processor = this.processors.get(queueName);
      if (!processor) continue;

      const job = jobs.shift();
      if (!job) continue;

      this.activeConcurrency++;
      this.processingJobs.add(job.id);

      (async () => {
        job.attemptsMade++;
        try {
          await processor(job);
          this.processingJobs.delete(job.id);
          this.activeConcurrency = Math.max(0, this.activeConcurrency - 1);
          const stat = this.stats.get(queueName);
          if (stat) stat.completed++;
        } catch (err: any) {
          this.processingJobs.delete(job.id);
          this.activeConcurrency = Math.max(0, this.activeConcurrency - 1);
          const maxAttempts = job.opts.attempts ?? 3;

          if (job.attemptsMade < maxAttempts) {
            const baseDelay = job.opts.backoffDelayMs ?? 1000;
            const jitter = Math.floor(Math.random() * 200);
            const backoffDelay =
              job.opts.backoffType === 'exponential'
                ? baseDelay * Math.pow(2, job.attemptsMade - 1) + jitter
                : baseDelay + jitter;

            this.logger.warn(
              `[Queue ${queueName}] Job ${job.id} (${job.jobName}) failed on attempt ${job.attemptsMade}/${maxAttempts}: ${err.message}. Retrying in ${backoffDelay}ms...`,
            );

            setTimeout(() => {
              if (!this.isShuttingDown) {
                this.waitingQueues.get(queueName)?.push(job);
              }
            }, backoffDelay);
          } else {
            await this.moveToDeadLetterQueue(job, err);
            const stat = this.stats.get(queueName);
            if (stat) stat.failed++;
          }
        }
      })();
    }
  }

  private sanitizePayload(data: any): any {
    if (!data || typeof data !== 'object') {
      if (typeof data === 'string') {
        return data.replace(/\b\d{6}\b/g, '******');
      }
      return data;
    }
    try {
      const sanitized = Array.isArray(data) ? [...data] : { ...data };
      for (const key of Object.keys(sanitized)) {
        const lower = key.toLowerCase();
        if (
          lower.includes('otp') ||
          lower.includes('password') ||
          lower.includes('secret') ||
          lower.includes('privatekey')
        ) {
          sanitized[key] = '******';
        } else if (typeof sanitized[key] === 'string') {
          sanitized[key] = sanitized[key].replace(/\b\d{6}\b/g, '******');
        } else if (typeof sanitized[key] === 'object' && sanitized[key] !== null) {
          sanitized[key] = this.sanitizePayload(sanitized[key]);
        }
      }
      return sanitized;
    } catch {
      return { sanitized: true };
    }
  }

  private async moveToDeadLetterQueue(job: QueueJob, error: any) {
    const dlqId = `dlq_${job.id}`;
    const safeData = this.sanitizePayload(job.data);
    const deadJob: DeadLetterJob = {
      id: dlqId,
      queueName: job.queueName,
      jobName: job.jobName,
      data: safeData,
      attemptsMade: job.attemptsMade,
      maxAttempts: job.opts.attempts ?? 3,
      failedReason: error?.message || 'Unknown processing failure',
      stacktrace: error?.stack ? [error.stack] : [],
      failedAt: new Date(),
      status: 'DEAD',
    };

    this.deadLetterStore.set(dlqId, deadJob);

    // Persist to PostgreSQL dead_letter_jobs table if prisma is available
    if (this.prisma) {
      try {
        await this.prisma.deadLetterJob.create({
          data: {
            id: dlqId,
            queueName: job.queueName,
            jobName: job.jobName,
            payload: safeData ?? {},
            attemptsMade: job.attemptsMade,
            maxAttempts: job.opts.attempts ?? 3,
            failedReason: deadJob.failedReason,
            stacktrace: deadJob.stacktrace ?? [],
            status: 'DEAD',
            failedAt: deadJob.failedAt,
          },
        });
      } catch (dbErr: any) {
        this.logger.error(`Failed to persist dead letter job to database: ${dbErr.message}`);
      }
    }

    this.logger.error(
      `🚨 [DLQ ALERT] Job ${job.id} (${job.jobName}) exhausted all ${job.attemptsMade} attempts on queue [${job.queueName}] and moved to Dead Letter Queue. Reason: ${deadJob.failedReason}`,
    );
  }

  /**
   * List jobs currently stored in Dead-Letter Queue.
   * PostgreSQL table dead_letter_jobs is the authoritative durable source of truth.
   */
  async getDeadLetterJobs(queueName?: string): Promise<DeadLetterJob[]> {
    if (this.prisma) {
      const rows = await this.prisma.deadLetterJob.findMany({
        where: queueName ? { queueName } : {},
        orderBy: { createdAt: 'desc' },
      });
      return rows.map((r: any) => ({
        id: r.id,
        queueName: r.queueName,
        jobName: r.jobName,
        data: r.payload,
        attemptsMade: r.attemptsMade,
        maxAttempts: r.maxAttempts,
        failedReason: r.failedReason || '',
        status: r.status,
        failedAt: r.failedAt || r.createdAt,
      }));
    }
    const all = Array.from(this.deadLetterStore.values());
    if (queueName) {
      return all.filter((j) => j.queueName === queueName);
    }
    return all;
  }

  /**
   * Re-enqueue a job from DLQ back into the active waiting queue.
   * Atomically claims the job in DB first (marking status as RETRYING) before enqueueing.
   * If enqueueing fails, cleanly rolls back status to DEAD with the enqueue failure reason.
   */
  async retryDeadLetterJob(dlqId: string): Promise<boolean> {
    let queueName: string | undefined;
    let jobName: string | undefined;
    let jobData: any;
    let maxAttempts = 3;

    if (this.prisma) {
      try {
        // Atomic status transition in DB from DEAD to RETRYING
        const claimResult = await this.prisma.deadLetterJob.updateMany({
          where: { id: dlqId, status: 'DEAD' },
          data: { status: 'RETRYING' },
        });
        if (claimResult.count === 0) {
          this.logger.warn(`DLQ job ${dlqId} could not be claimed from DB (already RETRYING or not found)`);
          return false;
        }

        const dbJob = await this.prisma.deadLetterJob.findUnique({
          where: { id: dlqId },
        });
        if (dbJob) {
          queueName = dbJob.queueName;
          jobName = dbJob.jobName;
          jobData = dbJob.payload;
          maxAttempts = dbJob.maxAttempts;
        }
      } catch (err: any) {
        this.logger.error(`Failed to atomically claim DLQ job ${dlqId} in DB: ${err.message}`);
        return false;
      }
    } else {
      const deadJob = this.deadLetterStore.get(dlqId);
      if (!deadJob || deadJob.status === 'RETRYING') {
        return false;
      }
      deadJob.status = 'RETRYING';
      queueName = deadJob.queueName;
      jobName = deadJob.jobName;
      jobData = deadJob.data;
      maxAttempts = deadJob.maxAttempts || 3;
    }

    if (!queueName || !jobName) {
      return false;
    }

    // Now safely re-enqueue with rollback on failure
    try {
      await this.enqueueJob(queueName, jobName, jobData, {
        attempts: maxAttempts,
        backoffDelayMs: 1000,
      });

      this.deadLetterStore.delete(dlqId);
      this.logger.log(`Job ${dlqId} safely claimed and re-enqueued from DLQ into active queue [${queueName}]`);
      return true;
    } catch (enqueueErr: any) {
      this.logger.error(`Failed to re-enqueue DLQ job ${dlqId}: ${enqueueErr.message}`);
      if (this.prisma) {
        await this.prisma.deadLetterJob.update({
          where: { id: dlqId },
          data: {
            status: 'DEAD',
            failedReason: `RETRY_ENQUEUE_FAILED: ${enqueueErr.message}`,
          },
        }).catch((err: any) => this.logger.error(`Failed to rollback status for DLQ job ${dlqId}: ${err.message}`));
      } else {
        const deadJob = this.deadLetterStore.get(dlqId);
        if (deadJob) deadJob.status = 'DEAD';
      }
      return false;
    }
  }

  /**
   * Clear jobs in DLQ. Awaits database deletion and returns the total deleted count.
   */
  async clearDeadLetterJobs(queueName?: string): Promise<number> {
    if (this.prisma) {
      const result = await this.prisma.deadLetterJob.deleteMany({
        where: queueName ? { queueName } : {},
      });
      for (const [id, job] of this.deadLetterStore.entries()) {
        if (!queueName || job.queueName === queueName) {
          this.deadLetterStore.delete(id);
        }
      }
      return result.count;
    }
    let memoryCount = 0;
    for (const [id, job] of this.deadLetterStore.entries()) {
      if (!queueName || job.queueName === queueName) {
        this.deadLetterStore.delete(id);
        memoryCount++;
      }
    }
    return memoryCount;
  }

  /**
   * Get overall stats across all queues.
   */
  getQueueStats(): QueueStats[] {
    const allQueueNames = new Set([
      ...this.waitingQueues.keys(),
      ...this.processors.keys(),
      ...this.bullQueues.keys(),
    ]);

    const results: QueueStats[] = [];
    for (const name of allQueueNames) {
      const waiting = this.waitingQueues.get(name)?.length || 0;
      const stat = this.stats.get(name) || { completed: 0, failed: 0 };
      const dlqCount = Array.from(this.deadLetterStore.values()).filter(
        (j) => j.queueName === name,
      ).length;

      results.push({
        queueName: name,
        waiting,
        active: Array.from(this.processingJobs).length,
        completed: stat.completed,
        failed: stat.failed,
        deadLetterCount: dlqCount,
        isRedisConnected: this.isBullMqActive,
      });
    }

    return results;
  }
}
