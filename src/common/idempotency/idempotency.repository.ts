import { Injectable, Inject, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

export type IdempotencyAcquireResult =
  | { state: 'ACQUIRED'; recordId: bigint }
  | { state: 'CACHED'; statusCode: number; responseBody: any }
  | { state: 'IN_FLIGHT'; lockedUntil: Date }
  | { state: 'MISMATCH'; expectedHash: string; actualHash: string };

@Injectable()
export class IdempotencyRepository {
  private readonly logger = new Logger(IdempotencyRepository.name);

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * Atomically acquires an idempotency key using row-level locking or conditional upsert.
   */
  async acquireKeyAtomic(params: {
    idempotencyKey: string;
    route: string;
    userId?: bigint | null;
    requestHash: string;
    lockTimeoutMs?: number;
    ttlSeconds?: number;
  }): Promise<IdempotencyAcquireResult> {
    const lockMs = params.lockTimeoutMs ?? 30000;
    const ttlSec = params.ttlSeconds ?? 86400; // 24 hours default

    return this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const lockedUntil = new Date(now.getTime() + lockMs);
      const expiresAt = new Date(now.getTime() + ttlSec * 1000);

      // 1. Lock existing record for update
      const existing = await tx.$queryRaw<Array<{
        id: bigint;
        idempotency_key: string;
        route: string;
        user_id: bigint | null;
        request_hash: string;
        status_code: number | null;
        response_body: any;
        status: string;
        locked_until: Date;
        expires_at: Date;
      }>>`
        SELECT id, idempotency_key, route, user_id, request_hash, status_code, response_body, status, locked_until, expires_at
        FROM api_idempotency_keys
        WHERE idempotency_key = ${params.idempotencyKey} AND route = ${params.route}
        FOR UPDATE
      `;

      if (existing && existing.length > 0) {
        const row = existing[0];

        // Verify request payload hash integrity
        if (row.request_hash.trim() !== params.requestHash.trim()) {
          return {
            state: 'MISMATCH',
            expectedHash: row.request_hash.trim(),
            actualHash: params.requestHash.trim(),
          };
        }

        // If completed, return cached response
        if (row.status === 'COMPLETED') {
          return {
            state: 'CACHED',
            statusCode: row.status_code ?? 200,
            responseBody: row.response_body,
          };
        }

        // If still processing, check lock expiration
        if (row.status === 'PROCESSING') {
          if (new Date(row.locked_until).getTime() > now.getTime()) {
            return {
              state: 'IN_FLIGHT',
              lockedUntil: new Date(row.locked_until),
            };
          }
          // Lock expired (crash recovery) - reacquire
          this.logger.warn(
            `Recovering expired lock for idempotency key: ${params.idempotencyKey} on route: ${params.route}`,
          );
          await tx.$executeRaw`
            UPDATE api_idempotency_keys
            SET status = 'PROCESSING',
                locked_until = ${lockedUntil},
                expires_at = ${expiresAt},
                updated_at = ${now}
            WHERE id = ${row.id}
          `;
          return { state: 'ACQUIRED', recordId: row.id };
        }

        // If previously failed, re-attempt
        await tx.$executeRaw`
          UPDATE api_idempotency_keys
          SET status = 'PROCESSING',
              locked_until = ${lockedUntil},
              expires_at = ${expiresAt},
              updated_at = ${now}
          WHERE id = ${row.id}
        `;
        return { state: 'ACQUIRED', recordId: row.id };
      }

      // 2. Insert new idempotency entry
      const insertResult = await tx.$queryRaw<Array<{ id: bigint }>>`
        INSERT INTO api_idempotency_keys (
          idempotency_key,
          route,
          user_id,
          request_hash,
          status,
          locked_until,
          expires_at,
          created_at,
          updated_at
        ) VALUES (
          ${params.idempotencyKey},
          ${params.route},
          ${params.userId ?? null},
          ${params.requestHash},
          'PROCESSING',
          ${lockedUntil},
          ${expiresAt},
          ${now},
          ${now}
        )
        ON CONFLICT (idempotency_key, route) DO NOTHING
        RETURNING id
      `;

      if (insertResult && insertResult.length > 0) {
        return { state: 'ACQUIRED', recordId: insertResult[0].id };
      }

      // Conflict occurred on insert - lock and re-evaluate
      const retryRow = await tx.$queryRaw<Array<{
        id: bigint;
        request_hash: string;
        status_code: number | null;
        response_body: any;
        status: string;
        locked_until: Date;
      }>>`
        SELECT id, request_hash, status_code, response_body, status, locked_until
        FROM api_idempotency_keys
        WHERE idempotency_key = ${params.idempotencyKey} AND route = ${params.route}
        FOR UPDATE
      `;

      if (!retryRow || retryRow.length === 0) {
        throw new Error('Failed to acquire idempotency lock concurrently');
      }

      const conflict = retryRow[0];
      if (conflict.request_hash.trim() !== params.requestHash.trim()) {
        return {
          state: 'MISMATCH',
          expectedHash: conflict.request_hash.trim(),
          actualHash: params.requestHash.trim(),
        };
      }

      if (conflict.status === 'COMPLETED') {
        return {
          state: 'CACHED',
          statusCode: conflict.status_code ?? 200,
          responseBody: conflict.response_body,
        };
      }

      return {
        state: 'IN_FLIGHT',
        lockedUntil: new Date(conflict.locked_until),
      };
    });
  }

  /**
   * Finalize an acquired idempotency key with successful execution result.
   */
  async finalizeSuccess(recordId: bigint, statusCode: number, responseBody: any): Promise<void> {
    const serializedBody = responseBody !== undefined ? JSON.stringify(responseBody, (_, v) =>
      typeof v === 'bigint' ? v.toString() : v
    ) : null;

    await this.prisma.$executeRaw`
      UPDATE api_idempotency_keys
      SET status = 'COMPLETED',
          status_code = ${statusCode},
          response_body = ${serializedBody}::jsonb,
          updated_at = NOW()
      WHERE id = ${recordId}
    `;
  }

  /**
   * Finalize or remove a failed idempotency record to permit clean client retries.
   */
  async finalizeFailure(recordId: bigint, removeOnFailure = true): Promise<void> {
    if (removeOnFailure) {
      await this.prisma.$executeRaw`
        DELETE FROM api_idempotency_keys
        WHERE id = ${recordId}
      `;
    } else {
      await this.prisma.$executeRaw`
        UPDATE api_idempotency_keys
        SET status = 'FAILED',
            updated_at = NOW()
        WHERE id = ${recordId}
      `;
    }
  }
}
