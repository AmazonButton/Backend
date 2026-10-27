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

  // Volatile emergency buffer structures (non-durable; in-memory fallback & temporary unpersisted cache)
  private readonly waitingQueues: Map<string, QueueJob[]> = new Map();
  private readonly deadLetterStore: Map<string, DeadLetterJob> = new Map();
  private readonly unpersistedDeadLetterJobs: Map<string, DeadLetterJob> = new Map();
  private readonly processors: Map<string, (job: QueueJob) => Promise<any>> = new Map();
  private readonly processingJobs: Set<string> = new Set();
  private readonly stats: Map<string, { completed: number; failed: number }> = new Map();

  private isFlushingUnpersistedDlq = false;
  private isShuttingDown = false;
  private workerInterval: NodeJS.Timeout | null = null;
  private reconciliationInterval: NodeJS.Timeout | null = null;
  private activeConcurrency = 0;
  private readonly MAX_CONCURRENCY = 10;

  constructor(@Optional() @Inject(PrismaService) private readonly prisma?: PrismaService) {}

  async onModuleInit() {
    await this.initRedisAndBullMQ();
    this.startWorkerLoop();
    this.startReconciliationScheduler();
  }

  async onModuleDestroy() {
    this.isShuttingDown = true;
    if (this.workerInterval) {
      clearInterval(this.workerInterval);
      this.workerInterval = null;
    }
    if (this.reconciliationInterval) {
      clearInterval(this.reconciliationInterval);
      this.reconciliationInterval = null;
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
   * Fails if volatile emergency buffer has unpersisted DLQ jobs awaiting PostgreSQL flush.
   */
  async isReady(): Promise<boolean> {
    if (this.isShuttingDown) return false;

    if (this.unpersistedDeadLetterJobs.size > 0) {
      return false;
    }

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

  private startReconciliationScheduler() {
    if (!this.prisma) return;
    // Immediate startup reconciliation & unpersisted DLQ flush
    this.reconcileStaleRetryingJobs().catch((err) => {
      this.logger.error(`Initial startup DLQ reconciliation encountered error: ${err.message}`);
    });
    this.flushUnpersistedDeadLetterJobs().catch((err) => {
      this.logger.error(`Initial unpersisted DLQ flush encountered error: ${err.message}`);
    });

    // Run periodic check every 60 seconds
    this.reconciliationInterval = setInterval(() => {
      if (!this.isShuttingDown) {
        this.reconcileStaleRetryingJobs().catch((err) => {
          this.logger.error(`Periodic DLQ reconciliation encountered error: ${err.message}`);
        });
        this.flushUnpersistedDeadLetterJobs().catch((err) => {
          this.logger.error(`Periodic unpersisted DLQ flush encountered error: ${err.message}`);
        });
      }
    }, 60000);
  }

  private extractReplayDlqId(jobId: string): string | null {
    const prefix = 'dlq-replay__';

    if (jobId.startsWith(prefix)) {
      const timestampSeparator = jobId.lastIndexOf('__');

      if (timestampSeparator <= prefix.length) {
        return null;
      }

      return jobId.slice(prefix.length, timestampSeparator);
    }

    const legacyPrefix = 'dlq-replay:';
    if (jobId.startsWith(legacyPrefix)) {
      return jobId.slice(legacyPrefix.length);
    }

    return null;
  }

  private async flushUnpersistedDeadLetterJobs() {
    if (this.isFlushingUnpersistedDlq || !this.prisma || this.unpersistedDeadLetterJobs.size === 0) return;

    this.isFlushingUnpersistedDlq = true;
    try {
      for (const [dlqId, deadJob] of Array.from(this.unpersistedDeadLetterJobs.entries())) {
        try {
          await this.prisma.deadLetterJob.create({
            data: {
              id: dlqId,
              queueName: deadJob.queueName,
              jobName: deadJob.jobName,
              payload: deadJob.data ?? {},
              attemptsMade: deadJob.attemptsMade,
              maxAttempts: deadJob.maxAttempts,
              failedReason: deadJob.failedReason,
              stacktrace: deadJob.stacktrace ?? [],
              status: deadJob.status,
              failedAt: deadJob.failedAt,
            },
          });

          this.unpersistedDeadLetterJobs.delete(dlqId);
          this.logger.log(`Successfully flushed previously unpersisted DLQ job ${dlqId} to PostgreSQL.`);
        } catch (error: any) {
          if (error.code === 'P2002') {
            const existing = await this.prisma.deadLetterJob.findUnique({
              where: { id: dlqId },
              select: { id: true },
            });

            if (existing) {
              this.unpersistedDeadLetterJobs.delete(dlqId);
              continue;
            }
          }

          this.logger.error(`Failed to flush unpersisted DLQ job ${dlqId}: ${error.message}`);
          throw error;
        }
      }
    } finally {
      this.isFlushingUnpersistedDlq = false;
    }
  }

  private async handleJobCompletion(job: QueueJob) {
    const dlqId = this.extractReplayDlqId(job.id);

    if (dlqId) {
      if (this.prisma) {
        let success = false;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            const updateResult = await this.prisma.deadLetterJob.updateMany({
              where: {
                id: dlqId,
                status: 'RETRY_QUEUED',
                replayJobId: job.id,
              },
              data: {
                status: 'RESOLVED',
                failedReason: null,
              },
            });
            if (updateResult.count > 0) {
              this.logger.log(`DLQ job ${dlqId} (replay ${job.id}) processed successfully and marked RESOLVED in DB.`);
            } else {
              this.logger.warn(
                `DLQ completion for ${dlqId} (replay ${job.id}) did not match active RETRY_QUEUED state (possible superseded replay).`,
              );
            }
            success = true;
            break;
          } catch (dbErr: any) {
            this.logger.error(`Attempt ${attempt}/3 failed to mark DLQ job ${dlqId} as RESOLVED: ${dbErr.message}`);
            if (attempt < 3) {
              await new Promise((r) => setTimeout(r, 100 * attempt));
            }
          }
        }
        if (!success) {
          this.logger.error(`🚨 [CRITICAL_DLQ_UPDATE_FAILED] Exhausted retries marking DLQ job ${dlqId} as RESOLVED!`);
        }
      }

      const memoryJob = this.deadLetterStore.get(dlqId);
      if (
        memoryJob?.status === 'RETRY_QUEUED' &&
        memoryJob.replayJobId === job.id
      ) {
        this.deadLetterStore.delete(dlqId);
      }

      const unpersistedJob = this.unpersistedDeadLetterJobs.get(dlqId);
      if (
        unpersistedJob?.status === 'RETRY_QUEUED' &&
        unpersistedJob.replayJobId === job.id
      ) {
        this.unpersistedDeadLetterJobs.delete(dlqId);
      }
    }
  }

  private maskUrl(url: string): string {
    return url.replace(/(:\/\/[^:]+:)[^@]+(@)/, '$1***$2');
  }

  private async initRedisAndBullMQ() {
    const isProduction = process.env.NODE_ENV === 'production';
    const redisDisabled = process.env.DISABLE_REDIS === 'true';
    const rawRedisUrl = process.env.REDIS_URL || process.env.REDIS_HOST;

    if (isProduction && redisDisabled) {
      throw new Error(
        'Invalid production configuration: DISABLE_REDIS=true is not permitted',
      );
    }

    if (isProduction && !rawRedisUrl) {
      throw new Error(
        'Invalid production configuration: REDIS_URL is required',
      );
    }

    if (!rawRedisUrl || redisDisabled) {
      this.logger.log('QueueService operating in in-memory development mode');
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
        this.logger.warn(`Redis connection error (${safeUrl}): ${err.message}.`);
        if (process.env.NODE_ENV === 'production') {
          this.isBullMqActive = false;
        }
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
      const failedClient = this.redisClient;

      this.redisClient = null;
      this.isBullMqActive = false;

      if (failedClient) {
        failedClient.removeAllListeners();

        try {
          failedClient.disconnect();
        } catch {
          // Client may already be closed.
        }
      }

      if (process.env.NODE_ENV === 'production') {
        this.logger.error(
          `Redis initialization failed (${safeUrl}): ${err.message}`,
        );
        throw new Error('Redis initialization failed');
      }

      this.logger.warn(
        `Could not connect to Redis at ${safeUrl}: ${err.message}. ` +
        'Running in in-memory development mode.',
      );
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

      worker.on('completed', async (bullJob) => {
        if (!bullJob) return;
        const stat = this.stats.get(queueName);
        if (stat) {
          stat.completed++;
        } else {
          this.stats.set(queueName, { completed: 1, failed: 0 });
        }
        await this.handleJobCompletion({
          id: bullJob.id || '',
          queueName,
          jobName: bullJob.name,
          data: bullJob.data,
          opts: { attempts: bullJob.opts.attempts },
          attemptsMade: bullJob.attemptsMade,
          createdAt: new Date(bullJob.timestamp),
        });
      });

      worker.on('failed', async (bullJob, err) => {
        if (!bullJob) return;
        const stat = this.stats.get(queueName);
        if (stat) {
          stat.failed++;
        } else {
          this.stats.set(queueName, { completed: 0, failed: 1 });
        }
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

    if (
      process.env.NODE_ENV === 'production' &&
      (!bullQueue || !this.isBullMqActive)
    ) {
      throw new Error('QUEUE_UNAVAILABLE');
    }

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
        if (process.env.NODE_ENV === 'production') {
          this.logger.error(`BullMQ enqueue failed in production: ${err.message}`);
          throw new Error('QUEUE_UNAVAILABLE');
        }
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
          await this.handleJobCompletion(job);
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
    // If this failed job was a DLQ replay job, update the existing DLQ record rather than creating an orphan
    const originalDlqId = this.extractReplayDlqId(job.id);

    if (originalDlqId) {
      const failureReason = `REPLAY_FAILED: ${error?.message || 'Unknown processing failure'}`;
      if (this.prisma) {
        try {
          const result = await this.prisma.deadLetterJob.updateMany({
            where: {
              id: originalDlqId,
              status: 'RETRY_QUEUED',
              replayJobId: job.id,
            },
            data: {
              status: 'DEAD',
              attemptsMade: { increment: job.attemptsMade },
              failedReason: failureReason,
              failedAt: new Date(),
            },
          });

          if (result.count === 0) {
            this.logger.warn(
              `Ignored stale replay failure ${job.id}; it is no longer the active replay`,
            );
            return;
          }

          this.logger.warn(
            `🚨 [DLQ ALERT] Replayed DLQ job ${originalDlqId} (${job.jobName}) failed again and was restored to DEAD status in DB.`,
          );
        } catch (dbErr: any) {
          this.logger.error(`Failed to restore DLQ job ${originalDlqId} to DEAD in DB: ${dbErr.message}`);
        }
      }
      const deadJob = this.deadLetterStore.get(originalDlqId);
      if (
        deadJob?.status === 'RETRY_QUEUED' &&
        deadJob.replayJobId === job.id
      ) {
        deadJob.status = 'DEAD';
        deadJob.failedReason = failureReason;
        deadJob.failedAt = new Date();
      }
      const unpersisted = this.unpersistedDeadLetterJobs.get(originalDlqId);
      if (
        unpersisted?.status === 'RETRY_QUEUED' &&
        unpersisted.replayJobId === job.id
      ) {
        unpersisted.status = 'DEAD';
        unpersisted.failedReason = failureReason;
        unpersisted.failedAt = new Date();
      }
      return;
    }

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
      replayJobId: null,
    };

    this.deadLetterStore.set(dlqId, deadJob);

    // Persist to PostgreSQL dead_letter_jobs table if prisma is available
    if (this.prisma) {
      let persisted = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
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
          persisted = true;
          break;
        } catch (dbErr: any) {
          this.logger.error(`Attempt ${attempt}/3 failed to persist dead letter job to database: ${dbErr.message}`);
          if (attempt < 3) {
            await new Promise((r) => setTimeout(r, 100 * attempt));
          }
        }
      }
      if (!persisted) {
        this.logger.error(
          `🚨 [CRITICAL_DLQ_PERSISTENCE_FAILED] Dead letter job ${dlqId} failed all 3 attempts to persist to PostgreSQL! Retaining in unpersisted fallback store.`,
        );
        this.unpersistedDeadLetterJobs.set(dlqId, deadJob);
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
      try {
        const rows = await this.prisma.deadLetterJob.findMany({
          where: queueName ? { queueName } : {},
          orderBy: { createdAt: 'desc' },
        });
        const dbJobs: DeadLetterJob[] = rows.map((r: any) => ({
          id: r.id,
          queueName: r.queueName,
          jobName: r.jobName,
          data: r.payload,
          attemptsMade: r.attemptsMade,
          maxAttempts: r.maxAttempts,
          failedReason: r.failedReason || '',
          status: r.status,
          replayJobId: r.replayJobId,
          failedAt: r.failedAt || r.createdAt,
        }));

        // Merge unpersisted jobs if any exist
        if (this.unpersistedDeadLetterJobs.size > 0) {
          for (const [id, unpersisted] of this.unpersistedDeadLetterJobs.entries()) {
            if (!queueName || unpersisted.queueName === queueName) {
              if (!dbJobs.some((j) => j.id === id)) {
                dbJobs.unshift(unpersisted);
              }
            }
          }
        }

        return dbJobs;
      } catch (dbErr: any) {
        this.logger.error(
          `[QueueService] Failed to query PostgreSQL dead_letter_jobs: ${dbErr.message}. Serving unpersisted and in-memory jobs in degraded mode.`,
        );
        const unpersisted = Array.from(this.unpersistedDeadLetterJobs.values());
        const memoryJobs = Array.from(this.deadLetterStore.values());
        const combined = [...unpersisted];
        for (const m of memoryJobs) {
          if (!combined.some((j) => j.id === m.id)) {
            combined.push(m);
          }
        }
        if (queueName) {
          return combined.filter((j) => j.queueName === queueName);
        }
        return combined;
      }
    }
    const all = Array.from(this.deadLetterStore.values());
    if (queueName) {
      return all.filter((j) => j.queueName === queueName);
    }
    return all;
  }

  /**
   * Re-enqueue a job from DLQ back into the active waiting queue.
   * Atomically claims the job in DB first (marking status as RETRY_QUEUED and setting replayJobId) before enqueueing.
   * Uses colon-free deterministic jobId 'dlq-replay__${dlqId}__${Date.now()}' compatible with BullMQ.
   * Transitions status to RETRY_QUEUED on successful enqueue (only moves to RESOLVED on completion).
   * If enqueueing fails, cleanly rolls back status to DEAD with the enqueue failure reason.
   */
  async retryDeadLetterJob(dlqId: string): Promise<boolean> {
    let queueName: string | undefined;
    let jobName: string | undefined;
    let jobData: any;
    let maxAttempts = 3;
    const replayJobId = `dlq-replay__${dlqId}__${Date.now()}`;

    if (this.prisma) {
      try {
        const dbJob = await this.prisma.deadLetterJob.findUnique({
          where: { id: dlqId },
        });
        if (!dbJob || dbJob.status !== 'DEAD') {
          this.logger.warn(
            `DLQ job ${dlqId} cannot be claimed from DB (status is ${dbJob?.status ?? 'NOT_FOUND'})`,
          );
          return false;
        }

        queueName = dbJob.queueName;
        jobName = dbJob.jobName;
        jobData = dbJob.payload;
        maxAttempts = dbJob.maxAttempts;

        // Atomically set RETRY_QUEUED and replayJobId in DB BEFORE enqueueing
        const claimResult = await this.prisma.deadLetterJob.updateMany({
          where: { id: dlqId, status: 'DEAD' },
          data: {
            status: 'RETRY_QUEUED',
            replayJobId,
          },
        });
        if (claimResult.count === 0) {
          this.logger.warn(`DLQ job ${dlqId} could not be claimed from DB (concurrent transition detected)`);
          return false;
        }
      } catch (err: any) {
        this.logger.error(`Failed to claim DLQ job ${dlqId} in DB: ${err.message}`);
        return false;
      }
    } else {
      const deadJob = this.deadLetterStore.get(dlqId);
      if (!deadJob || deadJob.status !== 'DEAD') {
        return false;
      }
      deadJob.status = 'RETRY_QUEUED';
      deadJob.replayJobId = replayJobId;
      queueName = deadJob.queueName;
      jobName = deadJob.jobName;
      jobData = deadJob.data;
      maxAttempts = deadJob.maxAttempts || 3;
    }

    if (!queueName || !jobName) {
      if (this.prisma) {
        await this.prisma.deadLetterJob.updateMany({
          where: { id: dlqId, replayJobId, status: 'RETRY_QUEUED' },
          data: { status: 'DEAD', failedReason: 'MISSING_QUEUE_OR_JOB_NAME' },
        });
      }
      return false;
    }

    try {
      await this.enqueueJob(queueName, jobName, jobData, {
        jobId: replayJobId,
        attempts: maxAttempts,
        backoffDelayMs: 1000,
      });

      this.logger.log(
        `Job ${dlqId} safely claimed and enqueued as ${replayJobId} from DLQ into active queue [${queueName}] (status: RETRY_QUEUED)`,
      );
      return true;
    } catch (enqueueErr: any) {
      this.logger.error(`Failed to re-enqueue DLQ job ${dlqId}: ${enqueueErr.message}`);
      if (this.prisma) {
        try {
          await this.prisma.deadLetterJob.updateMany({
            where: { id: dlqId, replayJobId, status: 'RETRY_QUEUED' },
            data: {
              status: 'DEAD',
              failedReason: `RETRY_ENQUEUE_FAILED: ${enqueueErr.message}`,
            },
          });
        } catch (rollbackErr: any) {
          this.logger.error(
            `CRITICAL_DLQ_ROLLBACK_FAILURE: Failed to rollback status to DEAD for DLQ job ${dlqId}: ${rollbackErr.message}`,
          );
          throw new Error(
            `CRITICAL: Re-enqueue failed and DB rollback failed for DLQ job ${dlqId}: ${rollbackErr.message}`,
          );
        }
      } else {
        const deadJob = this.deadLetterStore.get(dlqId);
        if (deadJob) {
          deadJob.status = 'DEAD';
          deadJob.failedReason = `RETRY_ENQUEUE_FAILED: ${enqueueErr.message}`;
        }
      }
      return false;
    }
  }

  /**
   * Reconciles stale DLQ jobs stuck in RETRYING or RETRY_QUEUED state for longer than timeoutMs (default: 10m).
   * Restores status to DEAD with a timeout reason so they can be reclaimed.
   * Throws DB errors rather than masking as 0 so monitoring is alerted.
   */
  async reconcileStaleRetryingJobs(timeoutMs = 600000): Promise<number> {
    if (!this.prisma) return 0;
    try {
      const cutoff = new Date(Date.now() - timeoutMs);
      const result = await this.prisma.deadLetterJob.updateMany({
        where: {
          status: { in: ['RETRYING', 'RETRY_QUEUED'] },
          updatedAt: { lt: cutoff },
        },
        data: {
          status: 'DEAD',
          failedReason: 'RETRY_TIMEOUT_RECONCILED: Stale RETRYING/RETRY_QUEUED lease expired',
        },
      });
      if (result.count > 0) {
        this.logger.warn(`Reconciled ${result.count} stale RETRYING/RETRY_QUEUED DLQ jobs back to DEAD`);
      }
      return result.count;
    } catch (err: any) {
      this.logger.error(`Failed to reconcile stale RETRYING/RETRY_QUEUED DLQ jobs: ${err.message}`, err.stack);
      throw err;
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
      for (const [id, job] of this.unpersistedDeadLetterJobs.entries()) {
        if (!queueName || job.queueName === queueName) {
          this.unpersistedDeadLetterJobs.delete(id);
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
    for (const [id, job] of this.unpersistedDeadLetterJobs.entries()) {
      if (!queueName || job.queueName === queueName) {
        this.unpersistedDeadLetterJobs.delete(id);
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
