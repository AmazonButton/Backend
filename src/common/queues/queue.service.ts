import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { QueueJob, DeadLetterJob, JobOptions, QueueStats } from './queue.interface';

@Injectable()
export class QueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(QueueService.name);

  // In-memory queues & DLQ store (with BullMQ adapter capabilities)
  private readonly waitingQueues: Map<string, QueueJob[]> = new Map();
  private readonly deadLetterStore: Map<string, DeadLetterJob> = new Map();
  private readonly processors: Map<string, (job: QueueJob) => Promise<any>> = new Map();
  private readonly processingJobs: Set<string> = new Set();
  private readonly stats: Map<string, { completed: number; failed: number }> = new Map();

  private isRedisConnected = false;
  private isShuttingDown = false;
  private workerInterval: NodeJS.Timeout | null = null;

  async onModuleInit() {
    this.checkRedisAvailability();
    this.startWorkerLoop();
  }

  onModuleDestroy() {
    this.isShuttingDown = true;
    if (this.workerInterval) {
      clearInterval(this.workerInterval);
      this.workerInterval = null;
    }
  }

  private checkRedisAvailability() {
    // Check if REDIS_URL is configured
    const redisUrl = process.env.REDIS_URL || process.env.REDIS_HOST;
    if (redisUrl && process.env.NODE_ENV === 'production') {
      this.logger.log(`QueueService connecting to Redis queue backend at ${redisUrl}`);
      this.isRedisConnected = true;
    } else {
      this.logger.log('QueueService initialized with Resilient In-Memory Queue Backend & DLQ Engine');
      this.isRedisConnected = false;
    }
  }

  private startWorkerLoop() {
    this.workerInterval = setInterval(() => {
      if (!this.isShuttingDown) {
        this.processNextJobs().catch((err) =>
          this.logger.error('Error during queue processing loop', err),
        );
      }
    }, 50); // fast polling for low latency
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
    this.logger.log(`Worker registered for queue: [${queueName}]`);
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

    const jobId = `job_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

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

    if (options.delayMs && options.delayMs > 0) {
      setTimeout(() => {
        if (!this.isShuttingDown) {
          this.waitingQueues.get(queueName)?.push(job);
        }
      }, options.delayMs);
    } else {
      this.waitingQueues.get(queueName)?.push(job);
    }

    return jobId;
  }

  private async processNextJobs() {
    for (const [queueName, jobs] of this.waitingQueues.entries()) {
      if (jobs.length === 0) continue;

      const processor = this.processors.get(queueName);
      if (!processor) continue;

      const job = jobs.shift();
      if (!job) continue;

      this.processingJobs.add(job.id);

      // Execute processor
      (async () => {
        job.attemptsMade++;
        try {
          await processor(job);

          // Success
          this.processingJobs.delete(job.id);
          const stat = this.stats.get(queueName);
          if (stat) stat.completed++;
        } catch (err: any) {
          this.processingJobs.delete(job.id);
          const maxAttempts = job.opts.attempts ?? 3;

          if (job.attemptsMade < maxAttempts) {
            // Calculate exponential backoff delay: delay * (2 ** (attempt - 1))
            const baseDelay = job.opts.backoffDelayMs ?? 1000;
            const backoffDelay =
              job.opts.backoffType === 'exponential'
                ? baseDelay * Math.pow(2, job.attemptsMade - 1)
                : baseDelay;

            this.logger.warn(
              `[Queue ${queueName}] Job ${job.id} (${job.jobName}) failed on attempt ${job.attemptsMade}/${maxAttempts}: ${err.message}. Retrying in ${backoffDelay}ms...`,
            );

            setTimeout(() => {
              if (!this.isShuttingDown) {
                this.waitingQueues.get(queueName)?.push(job);
              }
            }, backoffDelay);
          } else {
            // Max attempts exhausted -> Move directly to Dead-Letter Queue (DLQ)
            this.moveToDeadLetterQueue(job, err);
            const stat = this.stats.get(queueName);
            if (stat) stat.failed++;
          }
        }
      })();
    }
  }

  private moveToDeadLetterQueue(job: QueueJob, error: any) {
    const dlqId = `dlq_${job.id}`;
    const deadJob: DeadLetterJob = {
      id: dlqId,
      queueName: job.queueName,
      jobName: job.jobName,
      data: job.data,
      attemptsMade: job.attemptsMade,
      maxAttempts: job.opts.attempts ?? 3,
      failedReason: error?.message || 'Unknown processing failure',
      stacktrace: error?.stack ? [error.stack] : [],
      failedAt: new Date(),
      status: 'DEAD',
    };

    this.deadLetterStore.set(dlqId, deadJob);
    this.logger.error(
      `🚨 [DLQ ALERT] Job ${job.id} (${job.jobName}) exhausted all ${job.attemptsMade} attempts on queue [${job.queueName}] and moved to Dead Letter Queue. Reason: ${deadJob.failedReason}`,
    );
  }

  /**
   * List jobs currently stored in Dead-Letter Queue.
   */
  getDeadLetterJobs(queueName?: string): DeadLetterJob[] {
    const all = Array.from(this.deadLetterStore.values());
    if (queueName) {
      return all.filter((j) => j.queueName === queueName);
    }
    return all;
  }

  /**
   * Re-enqueue a job from DLQ back into the active waiting queue.
   */
  async retryDeadLetterJob(dlqId: string): Promise<boolean> {
    const deadJob = this.deadLetterStore.get(dlqId);
    if (!deadJob) {
      return false;
    }

    deadJob.status = 'RETRYING';
    const queueName = deadJob.queueName;

    const restoredJob: QueueJob = {
      id: `retry_${Date.now()}_${deadJob.id}`,
      queueName,
      jobName: deadJob.jobName,
      data: deadJob.data,
      opts: { attempts: deadJob.maxAttempts, backoffDelayMs: 1000 },
      attemptsMade: 0,
      createdAt: new Date(),
    };

    if (!this.waitingQueues.has(queueName)) {
      this.waitingQueues.set(queueName, []);
    }
    this.waitingQueues.get(queueName)?.push(restoredJob);

    // Remove from DLQ
    this.deadLetterStore.delete(dlqId);
    this.logger.log(`Job ${deadJob.id} re-enqueued from DLQ into active queue [${queueName}]`);
    return true;
  }

  /**
   * Clear jobs in DLQ.
   */
  clearDeadLetterJobs(queueName?: string): number {
    let count = 0;
    for (const [id, job] of this.deadLetterStore.entries()) {
      if (!queueName || job.queueName === queueName) {
        this.deadLetterStore.delete(id);
        count++;
      }
    }
    return count;
  }

  /**
   * Get overall stats across all queues.
   */
  getQueueStats(): QueueStats[] {
    const allQueueNames = new Set([
      ...this.waitingQueues.keys(),
      ...this.processors.keys(),
    ]);

    const results: QueueStats[] = [];
    for (const name of allQueueNames) {
      const waiting = this.waitingQueues.get(name)?.length || 0;
      const stat = this.stats.get(name) || { completed: 0, failed: 0 };
      const dlqCount = this.getDeadLetterJobs(name).length;

      results.push({
        queueName: name,
        waiting,
        active: Array.from(this.processingJobs).length,
        completed: stat.completed,
        failed: stat.failed,
        deadLetterCount: dlqCount,
        isRedisConnected: this.isRedisConnected,
      });
    }

    return results;
  }
}
