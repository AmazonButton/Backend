export interface JobOptions {
  jobId?: string;
  attempts?: number;
  backoffDelayMs?: number;
  backoffType?: 'fixed' | 'exponential';
  priority?: number;
  delayMs?: number;
}

export interface DeadLetterJob {
  id: string;
  queueName: string;
  jobName: string;
  data: any;
  attemptsMade: number;
  maxAttempts: number;
  failedReason: string;
  stacktrace?: string[];
  failedAt: Date;
  status: 'DEAD' | 'RETRYING' | 'RETRY_QUEUED' | 'RESOLVED';
  replayJobId?: string | null;
}

export interface QueueJob<T = any> {
  id: string;
  queueName: string;
  jobName: string;
  data: T;
  opts: JobOptions;
  attemptsMade: number;
  createdAt: Date;
}

export interface QueueStats {
  queueName: string;
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  deadLetterCount: number;
  isRedisConnected: boolean;
}
