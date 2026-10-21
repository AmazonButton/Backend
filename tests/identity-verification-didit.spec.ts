import * as dotenv from 'dotenv';
dotenv.config();
import 'reflect-metadata';

import { PrismaClient } from '@prisma/client';
import * as crypto from 'crypto';
import * as bcrypt from 'bcryptjs';
import { NotFoundException, ForbiddenException, UnauthorizedException, BadGatewayException, GatewayTimeoutException } from '@nestjs/common';
import { IdentityVerificationsRepository } from '../src/identity-verifications/identity-verifications.repository';
import { IdentityVerificationsService } from '../src/identity-verifications/identity-verifications.service';
import { DiditClientService } from '../src/identity-verifications/didit-client.service';
import { DiditWebhookGuard } from '../src/identity-verifications/guards/didit-webhook.guard';

const prisma = new PrismaClient();

async function runDiditKycTestSuite() {
  console.log('================================================================================');
  console.log('🛡️ DIDIT eKYC IDENTITY VERIFICATION COMPREHENSIVE TEST SUITE');
  console.log('================================================================================\n');

  let passed = 0;
  let failed = 0;

  const assert = (condition: boolean, testName: string, detail?: string) => {
    if (condition) {
      console.log(`  \x1b[32m✔ [PASS]\x1b[0m ${testName}`);
      passed++;
    } else {
      console.error(`  \x1b[31m✖ [FAIL]\x1b[0m ${testName}${detail ? ` -> ${detail}` : ''}`);
      failed++;
    }
  };

  const ts = Date.now();
  let userA: any = null;
  let userB: any = null;
  let userAdmin: any = null;
  const mockWebhookSecret = 'test_webhook_secret_key_12345';
  process.env.DIDIT_WEBHOOK_SECRET = mockWebhookSecret;
  process.env.DIDIT_API_KEY = 'didit_live_secret_key_abcxyz';
  process.env.DIDIT_WORKFLOW_ID = 'wf_vn_cccd_001';
  process.env.DIDIT_CALLBACK_URL = 'https://buttontdash.vercel.app/verification/callback';

  try {
    // -------------------------------------------------------------------------
    // Phase 0: Test Fixtures Setup
    // -------------------------------------------------------------------------
    console.log('[Setup: Creating Isolated Test Users]');
    const passwordHash = await bcrypt.hash('SecurePassword123!', 10);

    userA = await prisma.user.create({
      data: {
        username: `didit_user_a_${ts}`,
        email: `didit_a_${ts}@test.com`,
        fullName: 'Nguyen Van A',
        passwordHash,
        kycStatus: 'UNVERIFIED',
      },
    });

    userB = await prisma.user.create({
      data: {
        username: `didit_user_b_${ts}`,
        email: `didit_b_${ts}@test.com`,
        fullName: 'Tran Thi B',
        passwordHash,
        kycStatus: 'UNVERIFIED',
      },
    });

    userAdmin = await prisma.user.create({
      data: {
        username: `didit_admin_${ts}`,
        email: `didit_admin_${ts}@test.com`,
        fullName: 'Admin User',
        passwordHash,
        kycStatus: 'APPROVED',
      },
    });

    console.log(`  Created User A (#${userA.userId}), User B (#${userB.userId}), Admin (#${userAdmin.userId})`);

    const repo = new IdentityVerificationsRepository(prisma as any);
    const diditClient = new DiditClientService();

    // -------------------------------------------------------------------------
    // Phase 1: DiditClientService Mock & Protocol Testing
    // -------------------------------------------------------------------------
    console.log('\n[Phase 1: Didit Client Protocol, Headers & Error Handling]');

    // Intercept global fetch for deterministic testing
    const originalFetch = global.fetch;
    let lastRequestUrl = '';
    let lastRequestOptions: any = {};

    global.fetch = async (url: any, options: any) => {
      lastRequestUrl = url.toString();
      lastRequestOptions = options;

      if (lastRequestUrl.includes('/v3/session/') && options.method === 'POST') {
        const body = JSON.parse(options.body);
        return {
          ok: true,
          status: 201,
          text: async () =>
            JSON.stringify({
              session_id: `sess_didit_${Date.now()}`,
              url: `https://verify.didit.me/session/01J${Date.now()}`,
              status: 'PENDING',
              expires_at: new Date(Date.now() + 3600000).toISOString(),
              workflow_id: body.workflow_id,
              vendor_data: body.vendor_data,
            }),
        } as any;
      }

      if (lastRequestUrl.includes('/decision/')) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              status: 'Approved',
              decision: {
                id_card: '001200000001',
                full_name: 'NGUYEN VAN A',
              },
            }),
        } as any;
      }

      if (lastRequestUrl.includes('/v1/session/') && lastRequestUrl.includes('/delete/')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ success: true }),
        } as any;
      }

      return {
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ message: 'Bad Request' }),
      } as any;
    };

    // 1a. Test x-api-key header on Create Session
    const mockVendorData = `user-${userA.userId}`;
    const createRes = await diditClient.createSession(mockVendorData, process.env.DIDIT_CALLBACK_URL!);
    assert(
      lastRequestOptions.headers['x-api-key'] === process.env.DIDIT_API_KEY,
      'DiditClient sends x-api-key header in CreateSession request',
    );
    assert(
      lastRequestUrl.includes('/v3/session/'),
      'DiditClient calls v3 endpoint for CreateSession',
    );
    assert(
      createRes.session_id.startsWith('sess_didit_'),
      'DiditClient returns session_id from response',
    );

    // 1b. Test x-api-key header and v1 endpoint on Delete Session
    await diditClient.deleteSession(createRes.session_id);
    assert(
      lastRequestOptions.headers['x-api-key'] === process.env.DIDIT_API_KEY,
      'DiditClient sends x-api-key header in DeleteSession request',
    );
    assert(
      lastRequestUrl.includes('/v1/session/') && lastRequestUrl.endsWith('/delete/'),
      'DiditClient calls v1 endpoint for DeleteSession (/v1/session/{id}/delete/)',
    );

    // 1c. Zero secret leakage on 5xx error (and logger never prints response body)
    let loggedErrors: string[] = [];
    const originalLoggerError = (diditClient as any).logger.error.bind((diditClient as any).logger);
    (diditClient as any).logger.error = (msg: string) => {
      loggedErrors.push(msg);
    };

    global.fetch = async () => {
      return {
        ok: false,
        status: 502,
        text: async () => JSON.stringify({ secret_dump: process.env.DIDIT_API_KEY, sensitive_vendor_data: 'leak_check' }),
      } as any;
    };

    try {
      await diditClient.createSession(mockVendorData, 'http://callback');
      assert(false, 'Expected BadGatewayException on 502');
    } catch (err: any) {
      assert(err instanceof BadGatewayException, 'Throws BadGatewayException on vendor 502');
      assert(
        !err.message.includes(process.env.DIDIT_API_KEY!),
        'Error envelope never leaks DIDIT_API_KEY',
      );
      assert(
        loggedErrors.some((m) => m.includes('failed with HTTP 502')),
        'Logger records sanitized HTTP status code',
      );
      assert(
        !loggedErrors.some((m) => m.includes('secret_dump') || m.includes('sensitive_vendor_data')),
        'Zero vendor body leak: Logger never outputs vendor response payload',
      );
    } finally {
      (diditClient as any).logger.error = originalLoggerError;
    }

    // Restore standard mock fetch
    global.fetch = async (url: any, options: any) => {
      lastRequestUrl = url.toString();
      lastRequestOptions = options;
      if (lastRequestUrl.includes('/decision/')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ status: 'Approved' }),
        } as any;
      }
      if (lastRequestUrl.includes('/delete/')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ success: true }),
        } as any;
      }
      return {
        ok: true,
        status: 201,
        text: async () =>
          JSON.stringify({
            session_id: `sess_didit_${Date.now()}_${Math.random().toString(36).substring(7)}`,
            url: `https://verify.didit.me/session/${Date.now()}`,
            status: 'PENDING',
            expires_at: new Date(Date.now() + 3600000).toISOString(),
          }),
      } as any;
    };

    // -------------------------------------------------------------------------
    // Phase 2: Webhook Guard & HMAC Signature Verification
    // -------------------------------------------------------------------------
    console.log('\n[Phase 2: Timing-Safe HMAC-SHA256 Webhook Guard]');

    const guard = new DiditWebhookGuard();

    const samplePayload = {
      event_id: `evt_${Date.now()}`,
      event_type: 'status.updated',
      session_id: 'sess_sample_123',
      status: 'Approved',
    };
    const rawBuffer = Buffer.from(JSON.stringify(samplePayload));
    const validHexSignature = crypto
      .createHmac('sha256', mockWebhookSecret)
      .update(rawBuffer)
      .digest('hex');

    // 2a. Valid raw hex signature
    const mockContextA = {
      switchToHttp: () => ({
        getRequest: () => ({
          headers: { 'x-signature-v2': validHexSignature },
          rawBody: rawBuffer,
          body: samplePayload,
        }),
      }),
    } as any;
    assert(guard.canActivate(mockContextA) === true, 'Guard accepts valid raw hex HMAC signature');

    // 2b. Signature with v2= prefix
    const mockContextB = {
      switchToHttp: () => ({
        getRequest: () => ({
          headers: { 'x-signature-v2': `v2=${validHexSignature}` },
          rawBody: rawBuffer,
          body: samplePayload,
        }),
      }),
    } as any;
    assert(guard.canActivate(mockContextB) === true, 'Guard accepts signature with v2= prefix');

    // 2c. Invalid / Tampered signature
    const invalidSignature = 'a'.repeat(64);
    const mockContextC = {
      switchToHttp: () => ({
        getRequest: () => ({
          headers: { 'x-signature-v2': invalidSignature },
          rawBody: rawBuffer,
          body: samplePayload,
        }),
      }),
    } as any;
    try {
      guard.canActivate(mockContextC);
      assert(false, 'Guard should reject invalid signature');
    } catch (err: any) {
      assert(err instanceof UnauthorizedException, 'Guard rejects invalid signature with 401 Unauthorized');
    }

    // 2d. Missing signature
    const mockContextD = {
      switchToHttp: () => ({
        getRequest: () => ({
          headers: {},
          rawBody: rawBuffer,
          body: samplePayload,
        }),
      }),
    } as any;
    try {
      guard.canActivate(mockContextD);
      assert(false, 'Guard should reject missing signature');
    } catch (err: any) {
      assert(err instanceof UnauthorizedException, 'Guard rejects missing signature with 401');
    }

    // 2e. Fail-closed: Missing rawBody buffer (no fallback stringify)
    const mockContextNoRawBody = {
      switchToHttp: () => ({
        getRequest: () => ({
          headers: { 'x-signature-v2': validHexSignature },
          rawBody: undefined,
          body: samplePayload,
        }),
      }),
    } as any;
    try {
      guard.canActivate(mockContextNoRawBody);
      assert(false, 'Guard should reject request missing rawBody buffer');
    } catch (err: any) {
      assert(
        err instanceof UnauthorizedException && err.message.includes('raw body'),
        'Guard strictly fails closed with 401 when rawBody buffer is missing',
      );
    }

    // 2f. Fail-closed: String rawBody instead of Buffer
    const mockContextStringBody = {
      switchToHttp: () => ({
        getRequest: () => ({
          headers: { 'x-signature-v2': validHexSignature },
          rawBody: JSON.stringify(samplePayload), // String, not Buffer!
          body: samplePayload,
        }),
      }),
    } as any;
    try {
      guard.canActivate(mockContextStringBody);
      assert(false, 'Guard should reject string rawBody');
    } catch (err: any) {
      assert(
        err instanceof UnauthorizedException,
        'Guard strictly fails closed when rawBody is not an instance of Buffer',
      );
    }

    // -------------------------------------------------------------------------
    // Phase 3: IdentityVerificationsService CRUD & Business Invariants
    // -------------------------------------------------------------------------
    console.log('\n[Phase 3: Service Session Management & BOLA Protection]');

    const service = new IdentityVerificationsService(repo, diditClient);

    // 3a. Create Session
    const sessionA = await service.createSession(userA.userId);
    assert(sessionA.userId === userA.userId.toString(), 'Session created with verified user ID');
    assert(sessionA.status === 'PENDING', 'Initial session status is PENDING');
    assert(sessionA.verificationUrl.startsWith('https://verify.didit.me'), 'Session returns valid verification URL');

    const freshUserA = await prisma.user.findUnique({ where: { userId: userA.userId } });
    assert(freshUserA?.kycStatus === 'PENDING', 'User kycStatus transitions to PENDING upon session creation');

    // 3b. Session Reuse (Anti-duplicate fees)
    const sessionAReused = await service.createSession(userA.userId);
    assert(
      sessionAReused.sessionId === sessionA.sessionId,
      'Reuses active unexpired pending session rather than creating duplicate Didit session',
    );

    // 3c. BOLA Protection: User B accessing User A's session is rejected
    try {
      await service.getSession(BigInt(sessionA.sessionId), { id: userB.userId.toString(), role: 'CUSTOMER' });
      assert(false, 'BOLA: User B should be forbidden from reading User A session');
    } catch (err: any) {
      assert(err instanceof ForbiddenException, 'BOLA: User B rejected with 403 Forbidden');
    }

    // 3d. Owner and Admin can access session
    const ownerFetch = await service.getSession(BigInt(sessionA.sessionId), { id: userA.userId.toString(), role: 'CUSTOMER' });
    assert(ownerFetch.sessionId === sessionA.sessionId, 'Owner can access their own session');

    const adminFetch = await service.getSession(BigInt(sessionA.sessionId), { id: userAdmin.userId.toString(), role: 'ADMIN' });
    assert(adminFetch.sessionId === sessionA.sessionId, 'Admin can access any user session');

    // 3e. Session Not Found
    try {
      await service.getSession(BigInt(999999999), { id: userA.userId.toString(), role: 'ADMIN' });
      assert(false, 'Should throw 404 for non-existent session');
    } catch (err: any) {
      assert(err instanceof NotFoundException, 'Non-existent session returns 404 NotFoundException');
    }

    // 3f. List Sessions (BOLA Scoping)
    const userAList = await service.listSessions({ id: userA.userId.toString(), role: 'CUSTOMER' }, 1, 20);
    assert(
      userAList.data.every((s) => s.userId === userA.userId.toString()),
      'Customer list is strictly scoped to own userId',
    );

    const adminList = await service.listSessions({ id: userAdmin.userId.toString(), role: 'ADMIN' }, 1, 20);
    assert(adminList.pagination.totalItems >= 1, 'Admin list includes sessions across all users');

    // -------------------------------------------------------------------------
    // Phase 4: Webhook State Machine, Anti-Downgrade & Idempotency
    // -------------------------------------------------------------------------
    console.log('\n[Phase 4: Webhook Processing, Anti-Downgrade & Idempotency]');

    // 4a. Approved transition
    const webhookApprovedPayload = {
      event_id: `evt_appr_${ts}`,
      event_type: 'status.updated',
      session_id: sessionA.diditSessionId,
      status: 'Approved',
    };
    const approvedBuffer = Buffer.from(JSON.stringify(webhookApprovedPayload));
    const webhookResA = await service.handleWebhook(approvedBuffer, webhookApprovedPayload);
    assert(webhookResA.success === true, 'Webhook Approved handled successfully');

    const updatedSessionA = await repo.findSessionById(BigInt(sessionA.sessionId));
    assert(updatedSessionA?.status === 'APPROVED', 'Session status updated to APPROVED');

    const approvedUserA = await prisma.user.findUnique({ where: { userId: userA.userId } });
    assert(approvedUserA?.kycStatus === 'APPROVED', 'User kycStatus updated to APPROVED');

    // 4b. Webhook Idempotency: Duplicate delivery returns early
    const duplicateRes = await service.handleWebhook(approvedBuffer, webhookApprovedPayload);
    assert(
      duplicateRes.message === 'Event already processed',
      'Duplicate webhook payload safely detected and ignored via payloadHash uniqueness',
    );

    // 4b-2. Concurrent Webhooks: Atomic race condition resilience
    // Two identical webhooks dispatched concurrently via Promise.all
    const concurrentPayload = {
      event_id: `evt_conc_${ts}`,
      event_type: 'status.updated',
      session_id: sessionA.diditSessionId,
      status: 'Approved',
    };
    const concurrentBuffer = Buffer.from(JSON.stringify(concurrentPayload));
    const [res1, res2] = await Promise.all([
      service.handleWebhook(concurrentBuffer, concurrentPayload),
      service.handleWebhook(concurrentBuffer, concurrentPayload),
    ]);
    const resMessages = [res1.message, res2.message].sort();
    assert(
      resMessages[0] === 'Event already processed' && resMessages[1] === 'Webhook processed successfully',
      'Atomic Idempotency Lock: Exactly one concurrent webhook wins lock, duplicate returns HTTP 200 without race condition',
    );

    // 4b-3. Idempotency across different payloads sharing the same event_id
    const eventIdReplayPayload = {
      event_id: `evt_conc_${ts}`, // Same event_id as 4b-2, but different status and body
      event_type: 'status.updated',
      session_id: sessionA.diditSessionId,
      status: 'In_Review',
      different_random_field: 'replayed_event_id_with_mutated_payload',
    };
    const eventIdReplayBuffer = Buffer.from(JSON.stringify(eventIdReplayPayload));
    const replayRes = await service.handleWebhook(eventIdReplayBuffer, eventIdReplayPayload);
    assert(
      replayRes.message === 'Event already processed',
      'Idempotency by event_id: Replay with same event_id but different payload is rejected',
    );

    // 4b-4. Row-level Lock Concurrency: Concurrent Approved and Declined webhooks for same session
    // Create a new fresh session for User B
    const sessionForConflict = await service.createSession(userB.userId);
    const approvedWebhook = {
      event_id: `evt_conf_appr_${ts}`,
      event_type: 'status.updated',
      session_id: sessionForConflict.diditSessionId,
      status: 'Approved',
    };
    const declinedWebhook = {
      event_id: `evt_conf_decl_${ts}`,
      event_type: 'status.updated',
      session_id: sessionForConflict.diditSessionId,
      status: 'Declined',
    };
    await Promise.all([
      service.handleWebhook(Buffer.from(JSON.stringify(approvedWebhook)), approvedWebhook),
      service.handleWebhook(Buffer.from(JSON.stringify(declinedWebhook)), declinedWebhook),
    ]);
    const finalConfSession = await repo.findSessionById(BigInt(sessionForConflict.sessionId));
    const finalConfUserB = await prisma.user.findUnique({ where: { userId: userB.userId } });
    assert(
      finalConfSession?.status === 'APPROVED',
      'Row Lock Concurrency: Concurrent Approved & Declined webhooks guarantee APPROVED terminal state',
    );
    assert(
      finalConfUserB?.kycStatus === 'APPROVED',
      'Row Lock Concurrency: User retains APPROVED kycStatus under concurrent conflicting webhooks',
    );

    // 4c. Anti-Downgrade Protection: Delayed Declined webhook CANNOT downgrade APPROVED session
    const lateDeclinedPayload = {
      event_id: `evt_late_dec_${ts}`,
      event_type: 'status.updated',
      session_id: sessionA.diditSessionId,
      status: 'Declined',
    };
    const lateDeclinedBuffer = Buffer.from(JSON.stringify(lateDeclinedPayload));
    await service.handleWebhook(lateDeclinedBuffer, lateDeclinedPayload);

    const preservedSessionA = await repo.findSessionById(BigInt(sessionA.sessionId));
    assert(
      preservedSessionA?.status === 'APPROVED',
      'Anti-Downgrade: Session retains APPROVED status despite late Declined webhook',
    );

    const preservedUserA = await prisma.user.findUnique({ where: { userId: userA.userId } });
    assert(
      preservedUserA?.kycStatus === 'APPROVED',
      'Anti-Downgrade: User retains APPROVED kycStatus despite late Declined webhook',
    );

    // 4d. data.updated without status updates metadata only
    const dataUpdatedPayload = {
      event_id: `evt_data_${ts}`,
      event_type: 'data.updated',
      session_id: sessionA.diditSessionId,
      data: {
        full_name: 'NGUYEN VAN A',
        document_number: '001200000001',
        date_of_birth: '1995-05-15',
        nationality: 'VNM',
        ignored_image_blob: 'base64_massive_string_should_be_stripped',
      },
    };
    const dataBuffer = Buffer.from(JSON.stringify(dataUpdatedPayload));
    await service.handleWebhook(dataBuffer, dataUpdatedPayload);

    const metadataSession = await repo.findSessionById(BigInt(sessionA.sessionId));
    const meta: any = metadataSession?.metadata;
    assert(meta?.fullName === 'NGUYEN VAN A', 'data.updated saves fullName to metadata');
    assert(meta?.documentNumber === '001200000001', 'data.updated saves documentNumber to metadata');
    assert(!meta?.ignored_image_blob, 'Sanitizes OCR metadata: does not persist raw image blobs');

    // 4e. Unknown session webhook: safely logged, no crash
    const unknownSessionPayload = {
      event_id: `evt_unknown_${ts}`,
      event_type: 'status.updated',
      session_id: 'sess_unknown_99999',
      status: 'Declined',
    };
    const unknownBuffer = Buffer.from(JSON.stringify(unknownSessionPayload));
    const unknownRes = await service.handleWebhook(unknownBuffer, unknownSessionPayload);
    assert(unknownRes.success === true, 'Webhook for unknown session logs audit record safely');

    // -------------------------------------------------------------------------
    // Phase 5: Safe Delete Session
    // -------------------------------------------------------------------------
    console.log('\n[Phase 5: Safe Delete Session]');

    // Session for User B to delete
    const sessionB = await service.createSession(userB.userId);
    const deleteRes = await service.deleteSession(BigInt(sessionB.sessionId), { id: userAdmin.userId.toString(), role: 'ADMIN' });
    assert(deleteRes.success === true, 'deleteSession completes successfully');

    const deletedSession = await repo.findSessionById(BigInt(sessionB.sessionId));
    assert(deletedSession?.status === 'DELETED', 'Session marked with status DELETED (soft-delete)');
    assert(deletedSession?.deletedAt !== null, 'Session has deletedAt timestamp populated');

    // Querying soft-deleted session returns 404
    try {
      await service.getSession(BigInt(sessionB.sessionId), { id: userB.userId.toString(), role: 'CUSTOMER' });
      assert(false, 'Getting soft-deleted session should return 404');
    } catch (err: any) {
      assert(err instanceof NotFoundException, 'Soft-deleted session is hidden from getSession (404)');
    }

    // -------------------------------------------------------------------------
    // Phase 6: Zero Secret Exposure Verification
    // -------------------------------------------------------------------------
    console.log('\n[Phase 6: Zero Secret Exposure & Mobile Isolation]');

    const serializedDto = JSON.stringify(sessionA);
    assert(!serializedDto.includes(process.env.DIDIT_API_KEY!), 'DTO does not contain DIDIT_API_KEY');
    assert(!serializedDto.includes(mockWebhookSecret), 'DTO does not contain DIDIT_WEBHOOK_SECRET');
    assert(serializedDto.includes('verificationUrl'), 'Mobile payload contains only verificationUrl');

    // Restore fetch
    global.fetch = originalFetch;
  } finally {
    // -------------------------------------------------------------------------
    // Cleanup: Zero-Residue Database Purge
    // -------------------------------------------------------------------------
    console.log('\n[Cleanup: Removing Test Fixtures]');
    try {
      if (userA || userB || userAdmin) {
        const userIds = [userA?.userId, userB?.userId, userAdmin?.userId].filter(Boolean);

        // Delete webhook events for test sessions
        await prisma.diditWebhookEvent.deleteMany({
          where: {
            session: {
              userId: { in: userIds },
            },
          },
        });

        // Delete test sessions
        await prisma.identityVerificationSession.deleteMany({
          where: {
            userId: { in: userIds },
          },
        });

        // Delete test users
        await prisma.user.deleteMany({
          where: {
            userId: { in: userIds },
          },
        });
        console.log('  Cleaned up all test sessions, webhook events, and users.');
      }
    } catch (cleanupErr: any) {
      console.warn('  Cleanup warning:', cleanupErr.message);
    }
  }

  console.log('\n================================================================================');
  console.log(`📊 TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('================================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runDiditKycTestSuite().catch((err) => {
  console.error('Test Suite encountered fatal error:', err);
  process.exit(1);
});
