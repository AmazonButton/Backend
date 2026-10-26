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
   * Computes a deterministic SHA-256 hash of the request body.
   * Recursively sorts object keys so { a: 1, b: 2 } and { b: 2, a: 1 } yield identical hashes.
   */
  computeRequestHash(body: any): string {
    if (body === undefined || body === null) {
      return crypto.createHash('sha256').update('').digest('hex');
    }

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

    const canonicalJson = JSON.stringify(sortObject(body), (_, v) =>
      typeof v === 'bigint' ? v.toString() : v,
    );

    return crypto.createHash('sha256').update(canonicalJson).digest('hex');
  }

  /**
   * Attempts to acquire an idempotency lock for the current request.
   * Throws ConflictException (409) if request is already in-flight.
   * Throws UnprocessableEntityException (422) if key is reused with mismatched payload.
   */
  async acquire(params: {
    idempotencyKey: string;
    route: string;
    userId?: bigint | null;
    body: any;
    lockTimeoutMs?: number;
    ttlSeconds?: number;
  }): Promise<
    | { state: 'ACQUIRED'; recordId: bigint }
    | { state: 'CACHED'; statusCode: number; responseBody: any }
  > {
    const validKey = this.validateKey(params.idempotencyKey);
    if (!validKey) {
      throw new BadRequestException('Khóa idempotency không hợp lệ');
    }

    const requestHash = this.computeRequestHash(params.body);

    const result: IdempotencyAcquireResult = await this.repository.acquireKeyAtomic({
      idempotencyKey: validKey,
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
    };
  }

  async finalizeSuccess(recordId: bigint, statusCode: number, responseBody: any): Promise<void> {
    await this.repository.finalizeSuccess(recordId, statusCode, responseBody);
  }

  async finalizeFailure(recordId: bigint, removeOnFailure = true): Promise<void> {
    await this.repository.finalizeFailure(recordId, removeOnFailure);
  }
}
