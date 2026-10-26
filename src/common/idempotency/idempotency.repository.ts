import { Injectable, Inject, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

import * as crypto from 'crypto';

export type IdempotencyAcquireResult =
  | { state: 'ACQUIRED'; recordId: bigint; lockToken: string }
  | { state: 'CACHED'; statusCode: number; responseBody: any }
  | { state: 'IN_FLIGHT'; lockedUntil: Date }
  | { state: 'MISMATCH'; expectedHash: string; actualHash: string };

@Injectable()
export class IdempotencyRepository {
  private readonly logger = new Logger(IdempotencyRepository.name);

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * Atomically acquires an idempotency key using actor-scoped row-level locking or conditional upsert.
   * Scoped by (actorScope, idempotencyKey, method, actualPath) to prevent cross-user/resource collisions.
   */
  async acquireKeyAtomic(params: {
    actorScope: string;
    idempotencyKey: string;
    method: string;
    actualPath: string;
    route: string;
    userId?: bigint | null;
    requestHash: string;
    lockTimeoutMs?: number;
    ttlSeconds?: number;
  }): Promise<IdempotencyAcquireResult> {
    const lockMs = params.lockTimeoutMs ?? 30000;
    const ttlSec = params.ttlSeconds ?? 86400; // 24 hours default
    const normalizedMethod = (params.method || 'POST').toUpperCase();
    const normalizedPath = params.actualPath || params.route || '/';
    const actorScope = params.actorScope || 'public';

    const lockToken = crypto.randomUUID();

    return this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const lockedUntil = new Date(now.getTime() + lockMs);
      const expiresAt = new Date(now.getTime() + ttlSec * 1000);

      // 1. Lock existing record for update with full security scope
      const existing = await tx.$queryRaw<Array<{
        id: bigint;
        idempotency_key: string;
        method: string;
        actual_path: string;
        actor_scope: string;
        request_hash: string;
        status_code: number | null;
        response_body: any;
        status: string;
        locked_until: Date;
        expires_at: Date;
      }>>`
        SELECT id, idempotency_key, method, actual_path, actor_scope, request_hash, status_code, response_body, status, locked_until, expires_at
        FROM api_idempotency_keys
        WHERE actor_scope = ${actorScope}
          AND idempotency_key = ${params.idempotencyKey}
          AND method = ${normalizedMethod}
          AND actual_path = ${normalizedPath}
        FOR UPDATE
      `;

      if (existing && existing.length > 0) {
        const row = existing[0];

        // 1a. Check expiration: if expired, permit clean new execution
        if (new Date(row.expires_at).getTime() <= now.getTime()) {
          this.logger.log(
            `Idempotency key expired for [${actorScope}] ${normalizedMethod} ${normalizedPath}. Refreshing key entry.`,
          );
          await tx.$executeRaw`
            UPDATE api_idempotency_keys
            SET request_hash = ${params.requestHash},
                status = 'PROCESSING',
                lock_token = ${lockToken},
                status_code = NULL,
                response_body = NULL,
                locked_until = ${lockedUntil},
                expires_at = ${expiresAt},
                updated_at = ${now}
            WHERE id = ${row.id}
          `;
          return { state: 'ACQUIRED', recordId: row.id, lockToken };
        }

        // 1b. Verify request payload hash integrity
        if (row.request_hash.trim() !== params.requestHash.trim()) {
          return {
            state: 'MISMATCH',
            expectedHash: row.request_hash.trim(),
            actualHash: params.requestHash.trim(),
          };
        }

        // 1c. If completed, return cached response
        if (row.status === 'COMPLETED') {
          return {
            state: 'CACHED',
            statusCode: row.status_code ?? 200,
            responseBody: row.response_body,
          };
        }

        // 1d. If still processing, check lock expiration
        if (row.status === 'PROCESSING') {
          if (new Date(row.locked_until).getTime() > now.getTime()) {
            return {
              state: 'IN_FLIGHT',
              lockedUntil: new Date(row.locked_until),
            };
          }
          // Lock expired (crash recovery) - reacquire
          this.logger.warn(
            `Recovering expired lock for idempotency key: ${params.idempotencyKey} on [${actorScope}] ${normalizedMethod} ${normalizedPath}`,
          );
          await tx.$executeRaw`
            UPDATE api_idempotency_keys
            SET status = 'PROCESSING',
                lock_token = ${lockToken},
                locked_until = ${lockedUntil},
                expires_at = ${expiresAt},
                updated_at = ${now}
            WHERE id = ${row.id}
          `;
          return { state: 'ACQUIRED', recordId: row.id, lockToken };
        }

        // 1e. If previously failed, re-attempt
        await tx.$executeRaw`
          UPDATE api_idempotency_keys
          SET status = 'PROCESSING',
              lock_token = ${lockToken},
              locked_until = ${lockedUntil},
              expires_at = ${expiresAt},
              updated_at = ${now}
          WHERE id = ${row.id}
        `;
        return { state: 'ACQUIRED', recordId: row.id, lockToken };
      }

      // 2. Insert new idempotency entry
      const insertResult = await tx.$queryRaw<Array<{ id: bigint }>>`
        INSERT INTO api_idempotency_keys (
          actor_scope,
          idempotency_key,
          method,
          actual_path,
          route,
          user_id,
          request_hash,
          lock_token,
          status,
          locked_until,
          expires_at,
          created_at,
          updated_at
        ) VALUES (
          ${actorScope},
          ${params.idempotencyKey},
          ${normalizedMethod},
          ${normalizedPath},
          ${params.route},
          ${params.userId ?? null},
          ${params.requestHash},
          ${lockToken},
          'PROCESSING',
          ${lockedUntil},
          ${expiresAt},
          ${now},
          ${now}
        )
        ON CONFLICT (actor_scope, idempotency_key, method, actual_path) DO NOTHING
        RETURNING id
      `;

      if (insertResult && insertResult.length > 0) {
        return { state: 'ACQUIRED', recordId: insertResult[0].id, lockToken };
      }

      // Conflict occurred on insert - lock and re-evaluate
      const retryRow = await tx.$queryRaw<Array<{
        id: bigint;
        request_hash: string;
        status_code: number | null;
        response_body: any;
        status: string;
        locked_until: Date;
        expires_at: Date;
      }>>`
        SELECT id, request_hash, status_code, response_body, status, locked_until, expires_at
        FROM api_idempotency_keys
        WHERE actor_scope = ${actorScope}
          AND idempotency_key = ${params.idempotencyKey}
          AND method = ${normalizedMethod}
          AND actual_path = ${normalizedPath}
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
   * Strictly requires lockToken matching the active lease.
   */
  async finalizeSuccess(
    recordId: bigint,
    statusCode: number,
    responseBody: any,
    lockToken: string,
  ): Promise<boolean> {
    const serializedBody =
      responseBody !== undefined
        ? JSON.stringify(responseBody, (_, v) =>
            typeof v === 'bigint' ? v.toString() : v,
          )
        : null;

    const updatedCount = await this.prisma.$executeRaw`
      UPDATE api_idempotency_keys
      SET status = 'COMPLETED',
          status_code = ${statusCode},
          response_body = ${serializedBody}::jsonb,
          updated_at = NOW()
      WHERE id = ${recordId}
        AND lock_token = ${lockToken}
        AND status = 'PROCESSING'
    `;
    return updatedCount > 0;
  }

  /**
   * Finalize or remove a failed idempotency record to permit clean client retries.
   * Strictly requires lockToken matching the active lease.
   */
  async finalizeFailure(
    recordId: bigint,
    lockToken: string,
    removeOnFailure = true,
  ): Promise<boolean> {
    let affectedCount = 0;
    if (removeOnFailure) {
      affectedCount = await this.prisma.$executeRaw`
        DELETE FROM api_idempotency_keys
        WHERE id = ${recordId}
          AND lock_token = ${lockToken}
          AND status = 'PROCESSING'
      `;
    } else {
      affectedCount = await this.prisma.$executeRaw`
        UPDATE api_idempotency_keys
        SET status = 'FAILED',
            updated_at = NOW()
        WHERE id = ${recordId}
          AND lock_token = ${lockToken}
          AND status = 'PROCESSING'
      `;
    }
    return affectedCount > 0;
  }
}
