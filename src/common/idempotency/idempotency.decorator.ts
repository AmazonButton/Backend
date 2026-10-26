import { SetMetadata } from '@nestjs/common';

export const IDEMPOTENCY_OPTIONS_KEY = 'IDEMPOTENCY_OPTIONS';

export interface IdempotencyOptions {
  required?: boolean;
  ttlSeconds?: number;
  lockTimeoutMs?: number;
}

export const Idempotent = (options: IdempotencyOptions = {}) =>
  SetMetadata(IDEMPOTENCY_OPTIONS_KEY, options);
