import {
  Injectable,
  Inject,
  BadRequestException,
  ConflictException,
  UnprocessableEntityException,
} from '@nestjs/common';
import * as crypto from 'crypto';
import {
  IdempotencyRepository,
  IdempotencyAcquireResult,
} from './idempotency.repository';

@Injectable()
export class IdempotencyService {
  constructor(
    @Inject(IdempotencyRepository)
    private readonly repository: IdempotencyRepository,
  ) {}

  /**
   * Validates the idempotency key format according to IETF draft standards:
   * 1-128 characters, visible ASCII characters only [A-Za-z0-9._:-].
   */
  validateKey(key?: string): string | null {
    if (!key) return null;
    const trimmed = key.trim();
    if (trimmed.length < 1 || trimmed.length > 128) {
      throw new BadRequestException(
        'Header X-Idempotency-Key phải có độ dài từ 1 đến 128 ký tự',
      );
    }
    if (!/^[A-Za-z0-9._:-]+$/.test(trimmed)) {
      throw new BadRequestException(
        'Header X-Idempotency-Key chỉ được chứa chữ cái, chữ số và các ký tự: . _ : -',
      );
    }
    return trimmed;
  }

  /**
   * Computes a deterministic SHA-256 hash of the complete request:
   * method, actual path, query parameters, and recursive key-sorted body.
   */
  computeRequestHash(params: {
    method?: string;
    path?: string;
    query?: any;
    body?: any;
  } | any): string {
    const isParamObject =
      params &&
      typeof params === 'object' &&
      ('method' in params || 'path' in params || 'body' in params);

    const method = (isParamObject ? params.method || 'POST' : 'POST').toUpperCase();
    const path = isParamObject ? params.path || '/' : '/';
    const query = isParamObject ? params.query || {} : {};
    const body = isParamObject ? params.body : params;

    const sortObject = (item: any): any => {
      if (item === null || typeof item !== 'object') {
        return item;
      }
      if (Array.isArray(item)) {
        return item.map(sortObject);
      }
      return Object.keys(item)
        .sort()
        .reduce((acc: Record<string, any>, key: string) => {
          acc[key] = sortObject(item[key]);
          return acc;
        }, {});
    };

    const signature = {
      method,
      path,
      query: sortObject(query),
      body: sortObject(body ?? null),
    };

    const canonicalJson = JSON.stringify(signature, (_, v) =>
      typeof v === 'bigint' ? v.toString() : v,
    );

    return crypto.createHash('sha256').update(canonicalJson).digest('hex');
  }

  /**
   * Attempts to acquire an idempotency lock for the current request.
   * Scoped by actorScope, method, actualPath to guarantee zero cross-user/resource leakage.
   */
  async acquire(params: {
    idempotencyKey: string;
    actorScope?: string;
    method?: string;
    actualPath?: string;
    route: string;
    userId?: bigint | null;
    query?: any;
    body: any;
    lockTimeoutMs?: number;
    ttlSeconds?: number;
  }): Promise<
    | { state: 'ACQUIRED'; recordId: bigint; lockToken: string }
    | { state: 'CACHED'; statusCode: number; responseBody: any }
  > {
    const validKey = this.validateKey(params.idempotencyKey);
    if (!validKey) {
      throw new BadRequestException('Khóa idempotency không hợp lệ');
    }

    const method = (params.method || 'POST').toUpperCase();
    const actualPath = params.actualPath || params.route || '/';
    const actorScope = params.actorScope || (params.userId ? `user:${params.userId}` : 'public');

    const requestHash = this.computeRequestHash({
      method,
      path: actualPath,
      query: params.query,
      body: params.body,
    });

    const result: IdempotencyAcquireResult = await this.repository.acquireKeyAtomic({
      actorScope,
      idempotencyKey: validKey,
      method,
      actualPath,
      route: params.route,
      userId: params.userId,
      requestHash,
      lockTimeoutMs: params.lockTimeoutMs,
      ttlSeconds: params.ttlSeconds,
    });

    if (result.state === 'MISMATCH') {
      throw new UnprocessableEntityException(
        'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD: Khóa Idempotency đã được sử dụng với nội dung yêu cầu khác',
      );
    }

    if (result.state === 'IN_FLIGHT') {
      throw new ConflictException(
        'IDEMPOTENCY_REQUEST_IN_FLIGHT: Một yêu cầu với khóa Idempotency này đang được xử lý, vui lòng chờ',
      );
    }

    if (result.state === 'CACHED') {
      return {
        state: 'CACHED',
        statusCode: result.statusCode,
        responseBody: result.responseBody,
      };
    }

    return {
      state: 'ACQUIRED',
      recordId: result.recordId,
      lockToken: result.lockToken,
    };
  }

  async finalizeSuccess(
    recordId: bigint,
    statusCode: number,
    responseBody: any,
    lockToken: string,
  ): Promise<boolean> {
    return this.repository.finalizeSuccess(recordId, statusCode, responseBody, lockToken);
  }

  async finalizeFailure(
    recordId: bigint,
    lockToken: string,
    removeOnFailure = true,
  ): Promise<boolean> {
    return this.repository.finalizeFailure(recordId, lockToken, removeOnFailure);
  }
}
