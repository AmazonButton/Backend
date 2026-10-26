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
import { concatMap, catchError } from 'rxjs/operators';
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

    const options =
      this.reflector.getAllAndOverride<IdempotencyOptions>(
        IDEMPOTENCY_OPTIONS_KEY,
        [context.getHandler(), context.getClass()],
      ) || {};

    const rawKey =
      (req.headers?.['x-idempotency-key'] as string) ||
      (req.headers?.['idempotency-key'] as string) ||
      (req.body?.idempotencyKey as string) ||
      undefined;

    if (!rawKey) {
      if (options.required) {
        throw new BadRequestException(
          'Header X-Idempotency-Key là bắt buộc đối với thao tác này',
        );
      }
      return next.handle();
    }

    const method = (req.method || 'POST').toUpperCase();
    const actualPath = (req.originalUrl?.split('?')[0] || req.path || '/').toLowerCase();
    const routePattern = (req.route?.path || actualPath).toLowerCase();

    // Determine security actor scope
    let actorScope = 'public';
    if (req.user?.id || req.user?.userId) {
      const uid = req.user.id || req.user.userId;
      actorScope = req.user.storeId
        ? `store:${req.user.storeId}:user:${uid}`
        : `user:${uid}`;
    } else {
      const clientIp =
        req.headers['x-forwarded-for']?.toString()?.split(',')[0]?.trim() ||
        req.ip ||
        'guest';
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

    const recordId = acquisition.recordId;

    // Use concatMap to guarantee finalizeSuccess is 100% awaited BEFORE response is emitted
    return next.handle().pipe(
      concatMap(async (data) => {
        const statusCode = res?.statusCode || 200;
        await this.idempotencyService.finalizeSuccess(
          recordId,
          statusCode,
          data,
        );
        return data;
      }),
      catchError(async (err) => {
        // If error is client-side (< 500), remove key to permit immediate clean correction
        const isClientError =
          err?.status && typeof err.status === 'number' && err.status < 500;
        await this.idempotencyService.finalizeFailure(
          recordId,
          isClientError,
        );
        throw err;
      }),
    );
  }
}
