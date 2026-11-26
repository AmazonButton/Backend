import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Inject,
  BadRequestException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, of } from 'rxjs';
import { concatMap, catchError, tap } from 'rxjs/operators';
import { IdempotencyService } from './idempotency.service';
import {
  IDEMPOTENCY_OPTIONS_KEY,
  IdempotencyOptions,
} from './idempotency.decorator';

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    @Inject(IdempotencyService)
    private readonly idempotencyService: IdempotencyService,
    @Inject(Reflector)
    private readonly reflector: Reflector,
  ) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<any>> {
    const httpContext = context.switchToHttp();
    const req = httpContext.getRequest();
    const res = httpContext.getResponse();

    if (!req) {
      return next.handle();
    }

    const method = (req.method || 'POST').toUpperCase();
    // Safe read-only HTTP methods must never be persisted into api_idempotency_keys
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
      return next.handle();
    }

    const options =
      this.reflector.getAllAndOverride<IdempotencyOptions>(
        IDEMPOTENCY_OPTIONS_KEY,
        [context.getHandler(), context.getClass()],
      ) || {};

    const headerXKey = req.headers?.['x-idempotency-key'];
    const headerStdKey = req.headers?.['idempotency-key'];
    if (Array.isArray(headerXKey) || Array.isArray(headerStdKey)) {
      throw new BadRequestException('Không được phép gửi trùng lặp header Idempotency-Key');
    }

    const rawKey: unknown =
      headerXKey !== undefined
        ? headerXKey
        : headerStdKey !== undefined
          ? headerStdKey
          : req.body?.idempotencyKey;

    if (rawKey === undefined || rawKey === null || rawKey === '') {
      if (options.required) {
        throw new BadRequestException(
          'Header X-Idempotency-Key là bắt buộc đối với thao tác này',
        );
      }
      // If key is optional and client did not supply one, pass through directly.
      // Never synthesize identity from payload hash to avoid duplicate order blocks & cross-guest response leaks.
      return next.handle();
    }

    if (typeof rawKey !== 'string') {
      throw new BadRequestException('Idempotency-Key phải là chuỗi ký tự hợp lệ');
    }

    const actualPath = (req.originalUrl?.split('?')[0] || req.path || '/').toLowerCase();
    if (actualPath.length > 255) {
      throw new BadRequestException('Đường dẫn yêu cầu vượt quá độ dài tối đa cho phép');
    }
    const routePattern = (req.route?.path || actualPath).toLowerCase().slice(0, 255);

    // Determine security actor scope
    let actorScope = 'public';
    if (req.user?.id || req.user?.userId) {
      const uid = req.user.id || req.user.userId;
      actorScope = req.user.storeId
        ? `store:${req.user.storeId}:user:${uid}`
        : `user:${uid}`;
    } else {
      // Use Express trusted req.ip rather than spoofable raw x-forwarded-for header
      const clientIp = req.ip || req.socket?.remoteAddress || 'guest';
      actorScope = `guest:${clientIp}`;
    }

    const userId = req.user?.id || req.user?.userId ? BigInt(req.user.id || req.user.userId) : null;

    const acquisition = await this.idempotencyService.acquire({
      idempotencyKey: rawKey,
      actorScope,
      method,
      actualPath,
      route: routePattern,
      userId,
      query: req.query,
      body: req.body,
      lockTimeoutMs: options.lockTimeoutMs,
      ttlSeconds: options.ttlSeconds,
    });

    if (acquisition.state === 'CACHED') {
      if (res && typeof res.setHeader === 'function') {
        res.setHeader('X-Cache-Lookup', 'HIT');
        res.setHeader('X-Idempotency-Status', 'CACHED');
        if (acquisition.statusCode && typeof res.status === 'function') {
          res.status(acquisition.statusCode);
        }
      }
      return of(acquisition.responseBody);
    }

    if (res && typeof res.setHeader === 'function') {
      res.setHeader('X-Cache-Lookup', 'MISS');
      res.setHeader('X-Idempotency-Status', 'EXECUTED');
    }

    const recordId = acquisition.recordId!;
    const lockToken = acquisition.lockToken!;
    req.idempotencyContext = {
      actorScope,
      idempotencyKey: rawKey.trim(),
      requestHash: acquisition.requestHash,
      recordId,
      lockToken,
    };

    // Guard against post-commit failure deletion: once next.handle() emits, business commit
    // already succeeded, so catchError must never delete/fail the idempotency row.
    let businessCommitted = false;

    return next.handle().pipe(
      tap(() => {
        businessCommitted = true;
      }),
      concatMap(async (data) => {
        const statusCode = res?.statusCode || 200;
        await this.idempotencyService.finalizeSuccess(
          recordId,
          statusCode,
          data,
          lockToken,
        );
        return data;
      }),
      catchError(async (err) => {
        if (!businessCommitted) {
          const isClientError =
            err?.status && typeof err.status === 'number' && err.status < 500;
          await this.idempotencyService.finalizeFailure(
            recordId,
            lockToken,
            isClientError,
          );
        }
        throw err;
      }),
    );
  }
}
