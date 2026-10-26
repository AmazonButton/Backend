import { Logger } from '@nestjs/common';

const logger = new Logger('TransactionRetry');

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  operationName?: string;
}

/**
 * Checks if a database error is a transient concurrency deadlock or serialization conflict
 */
export function isTransientConcurrencyError(error: any): boolean {
  if (!error) return false;

  // Prisma write conflict or deadlock code
  if (error.code === 'P2034') return true;

  // Raw PostgreSQL error codes
  if (error.code === '40P01' || error.code === '40001') return true;

  const message = String(error.message || '').toLowerCase();
  if (
    message.includes('deadlock detected') ||
    message.includes('could not serialize access') ||
    message.includes('concurrent update') ||
    message.includes('transaction failed due to a write conflict')
  ) {
    return true;
  }

  return false;
}

/**
 * Executes a transactional database operation with bounded exponential backoff & jitter for transient concurrency conflicts
 */
export async function runWithTransactionRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 100;
  const maxDelayMs = options.maxDelayMs ?? 1500;
  const opName = options.operationName ?? 'DatabaseTransaction';

  let lastError: any;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (err: any) {
      lastError = err;

      if (!isTransientConcurrencyError(err) || attempt === maxRetries) {
        throw err;
      }

      // Exponential backoff + full jitter to prevent thundering herd
      const exponentialDelay = baseDelayMs * Math.pow(2, attempt - 1);
      const jitter = Math.floor(Math.random() * baseDelayMs);
      const delay = Math.min(exponentialDelay + jitter, maxDelayMs);

      logger.warn(
        `[${opName}] Transient concurrency conflict (code: ${err.code || 'UNKNOWN'}). Retrying attempt ${attempt}/${maxRetries} after ${delay}ms...`,
      );

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}
