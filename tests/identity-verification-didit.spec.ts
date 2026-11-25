import * as dotenv from 'dotenv';
dotenv.config();
import 'reflect-metadata';

import { PrismaClient } from '@prisma/client';
import * as crypto from 'crypto';
import * as bcrypt from 'bcryptjs';
import {
  NotFoundException,
  ForbiddenException,
  UnauthorizedException,
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ValidationPipe,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import * as jwt from 'jsonwebtoken';
import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/filters/http-exception.filter';
import { UpdateProfileDto } from '../src/auth/dto/update-profile.dto';
import { IdentityVerificationsRepository } from '../src/identity-verifications/identity-verifications.repository';
import { IdentityVerificationsService } from '../src/identity-verifications/identity-verifications.service';
import { DiditClientService } from '../src/identity-verifications/didit-client.service';
import { DiditWebhookGuard } from '../src/identity-verifications/guards/didit-webhook.guard';
import {
  compareIdentityNames,
  extractDiditOcrIdentity,
  normalizeVietnameseIdentityName,
} from '../src/identity-verifications/identity-match.util';
import { CryptoVaultUtil } from '../src/common/utils/crypto-vault.util';
import { IdentityVerificationsController } from '../src/identity-verifications/identity-verifications.controller';
import { ReviewKycSessionDto } from '../src/identity-verifications/dto/review-kyc-session.dto';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';

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
  const prevNodeEnv = process.env.NODE_ENV;
  const prevDisableRedis = process.env.DISABLE_REDIS;
  const prevJwtSecret = process.env.JWT_SECRET;
  let httpApp: any = null;
  let createdAdminMembershipId: bigint | null = null;
  let userA: any = null;
  let userB: any = null;
  let userAdmin: any = null;
  const extraUsers: any[] = [];
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

    // 1d. Surfacing Didit 400 credit exhaustion safely & masking any echoed API key
    loggedErrors = [];
    (diditClient as any).logger.error = (msg: string) => {
      loggedErrors.push(msg);
    };
    try {
      global.fetch = async () => {
        return {
          ok: false,
          status: 400,
          text: async () =>
            JSON.stringify({
              detail:
                "You don't have enough credits to perform this request. Please top up at https://business.didit.me",
              extra_secret_field: process.env.DIDIT_API_KEY,
            }),
        } as any;
      };
      try {
        await diditClient.createSession(mockVendorData, 'http://callback');
        assert(false, 'Expected BadGatewayException on Didit 400 credit error');
      } catch (err: any) {
        assert(err instanceof BadGatewayException, 'Throws BadGatewayException on Didit 400 credit error');
        assert(
          err.message.includes('credit') && err.message.includes('400'),
          'Surfaces actionable credit-exhaustion guidance on Didit 400 response',
        );
        assert(!err.message.includes(process.env.DIDIT_API_KEY!), 'Didit 400 message never leaks DIDIT_API_KEY');
        assert(
          loggedErrors.some((m) => m.includes('HTTP 400') && m.includes('insufficient_credits')) &&
          !loggedErrors.some((m) => m.includes('extra_secret_field')),
          'Logger logs sanitized insufficient_credits marker without dumping arbitrary JSON fields',
        );
      }

      global.fetch = async () => {
        return {
          ok: false,
          status: 400,
          text: async () => JSON.stringify({ detail: `Workflow inactive key=${process.env.DIDIT_API_KEY}` }),
        } as any;
      };
      try {
        await diditClient.createSession(mockVendorData, 'http://callback');
        assert(false, 'Expected BadGatewayException on Didit 400 workflow error');
      } catch (err: any) {
        assert(
          err.message.includes('Workflow inactive') &&
          err.message.includes('[REDACTED]') &&
          !err.message.includes(process.env.DIDIT_API_KEY!),
          'Redacts DIDIT_API_KEY if ever echoed inside Didit detail string',
        );
      }
    } finally {
      (diditClient as any).logger.error = originalLoggerError;
    }

    // Restore standard mock fetch
    let mockDecisionBodyBySession: Record<string, any> = {};
    global.fetch = async (url: any, options: any) => {
      lastRequestUrl = url.toString();
      lastRequestOptions = options;
      if (lastRequestUrl.includes('/decision/')) {
        const matchedEntry = Object.entries(mockDecisionBodyBySession).find(([sid]) =>
          lastRequestUrl.includes(encodeURIComponent(sid)) || lastRequestUrl.includes(sid),
        );
        const body = matchedEntry ? matchedEntry[1] : { status: 'Pending' };
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify(body),
        } as any;
      }
      if (lastRequestUrl.includes('/delete/')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ success: true }),
        } as any;
      }
      const reqBody = options?.body ? JSON.parse(options.body) : {};
      return {
        ok: true,
        status: 201,
        text: async () =>
          JSON.stringify({
            session_id: `sess_didit_${Date.now()}_${Math.random().toString(36).substring(7)}`,
            url: `https://verify.didit.me/session/${Date.now()}`,
            status: 'PENDING',
            expires_at: new Date(Date.now() + 3600000).toISOString(),
            workflow_id: reqBody.workflow_id,
            vendor_data: reqBody.vendor_data,
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
    // Phase 3b: Verify expected_details sent on CreateSession
    // -------------------------------------------------------------------------
    const lastCreateBody = lastRequestOptions?.body ? JSON.parse(lastRequestOptions.body) : {};
    assert(
      lastCreateBody?.expected_details?.last_name === 'Nguyen' &&
      lastCreateBody?.expected_details?.first_name === 'Van A',
      'createSession passes split expected_details (first_name, last_name) to Didit v3',
    );

    // -------------------------------------------------------------------------
    // Phase 4: Webhook State Machine, OCR Gate, Name Matching, Anti-Downgrade & Idempotency
    // -------------------------------------------------------------------------
    console.log('\n[Phase 4: Webhook Processing, OCR Gate, Identity Match & Idempotency]');

    const docNumberA = `001200${String(ts).slice(-6)}`;
    const docHashA = CryptoVaultUtil.hashIdentityDocument(docNumberA);
    const docMaskedA = CryptoVaultUtil.maskIdentityDocument(docNumberA);
    const docNumberB = `079200${String(ts).slice(-6)}`;

    // 4.0 Vulnerability Guard: Thin Approved webhook WITHOUT OCR cannot approve blindly
    mockDecisionBodyBySession[sessionA.diditSessionId] = { status: 'Approved' };
    const thinApprovedPayload = {
      event_id: `evt_thin_appr_${ts}`,
      event_type: 'status.updated',
      session_id: sessionA.diditSessionId,
      status: 'Approved',
    };
    await service.handleWebhook(
      Buffer.from(JSON.stringify(thinApprovedPayload)),
      thinApprovedPayload,
    );
    const afterThinSessionA = await repo.findSessionById(BigInt(sessionA.sessionId));
    const afterThinUserA = await prisma.user.findUnique({ where: { userId: userA.userId } });
    assert(
      afterThinSessionA?.status === 'IN_REVIEW' && afterThinSessionA?.reviewReason === 'OCR_DATA_MISSING',
      'OCR Gate: Thin Approved webhook without OCR moves session to IN_REVIEW (OCR_DATA_MISSING)',
    );
    assert(
      afterThinUserA?.kycStatus === 'IN_REVIEW',
      'OCR Gate: User kycStatus is NOT promoted to APPROVED without verified OCR data',
    );

    // 4.0b Vulnerability Guard: /decision Approved without OCR cannot approve blindly
    const decisionNoOcr = await service.getDecision(BigInt(sessionA.sessionId), {
      id: userA.userId.toString(),
      role: 'CUSTOMER',
    });
    assert(
      decisionNoOcr.status === 'IN_REVIEW' && decisionNoOcr.reviewReason === 'OCR_DATA_MISSING',
      'OCR Gate (/decision): Reconcile blocks APPROVED when Didit /decision omits OCR identity fields',
    );

    // 4a. Approved transition with Didit v3 id_verifications[] OCR payload -> resolves IN_REVIEW -> APPROVED
    const webhookApprovedPayload = {
      event_id: `evt_appr_${ts}`,
      event_type: 'status.updated',
      session_id: sessionA.diditSessionId,
      status: 'Approved',
      decision: {
        id_verifications: [
          {
            status: 'Approved',
            full_name: 'NGUYỄN VĂN A',
            document_number: docNumberA,
            date_of_birth: '1995-05-15',
            nationality: 'VNM',
          },
        ],
      },
    };
    const approvedBuffer = Buffer.from(JSON.stringify(webhookApprovedPayload));
    const webhookResA = await service.handleWebhook(approvedBuffer, webhookApprovedPayload);
    assert(webhookResA.success === true, 'Webhook Approved with OCR handled successfully');

    const updatedSessionA = await repo.findSessionById(BigInt(sessionA.sessionId));
    assert(updatedSessionA?.status === 'APPROVED', 'Session status updated to APPROVED when OCR matches');
    assert(
      updatedSessionA?.verifiedDocumentHash === docHashA,
      'Session stores HMAC blind-index verifiedDocumentHash',
    );

    const approvedUserA = await prisma.user.findUnique({ where: { userId: userA.userId } });
    assert(approvedUserA?.kycStatus === 'APPROVED', 'User kycStatus updated to APPROVED');
    assert(approvedUserA?.verifiedLegalName === 'NGUYỄN VĂN A', 'User persists verifiedLegalName separately');
    assert(approvedUserA?.verifiedDocumentHash === docHashA, 'User persists unique verifiedDocumentHash');
    assert(approvedUserA?.verifiedDocumentMasked === docMaskedA, 'User persists masked document number');
    assert(
      Boolean(approvedUserA?.verifiedDocumentEncrypted) &&
      CryptoVaultUtil.decryptAccountNumber(approvedUserA!.verifiedDocumentEncrypted!) ===
      CryptoVaultUtil.normalizeIdentityDocument(docNumberA),
      'User encrypts CCCD with AES-256-GCM cleanly',
    );

    // 4b. Webhook Idempotency: Duplicate delivery returns early
    const duplicateRes = await service.handleWebhook(approvedBuffer, webhookApprovedPayload);
    assert(
      duplicateRes.message === 'Event already processed',
      'Duplicate webhook payload safely detected and ignored via payloadHash uniqueness',
    );

    // 4b-2. Concurrent Webhooks: Atomic race condition resilience
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
      event_id: `evt_conc_${ts}`,
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

    // 4b-4. Row-level Lock Concurrency: Concurrent Approved and Declined webhooks for User B (with valid matching OCR)
    const sessionForConflict = await service.createSession(userB.userId);
    const approvedWebhook = {
      event_id: `evt_conf_appr_${ts}`,
      event_type: 'status.updated',
      session_id: sessionForConflict.diditSessionId,
      status: 'Approved',
      decision: {
        id_verifications: [
          {
            status: 'Approved',
            full_name: 'TRẦN THỊ B',
            document_number: docNumberB,
          },
        ],
      },
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
    await service.handleWebhook(Buffer.from(JSON.stringify(lateDeclinedPayload)), lateDeclinedPayload);
    const preservedSessionA = await repo.findSessionById(BigInt(sessionA.sessionId));
    const preservedUserA = await prisma.user.findUnique({ where: { userId: userA.userId } });
    assert(
      preservedSessionA?.status === 'APPROVED' && preservedUserA?.kycStatus === 'APPROVED',
      'Anti-Downgrade: Session & User retain APPROVED status despite late Declined webhook',
    );

    // 4d. data.updated masks raw documentNumber in metadata and strips raw image blobs
    const dataUpdatedPayload = {
      event_id: `evt_data_${ts}`,
      event_type: 'data.updated',
      session_id: sessionA.diditSessionId,
      data: {
        full_name: 'NGUYỄN VĂN A',
        document_number: docNumberA,
        date_of_birth: '1995-05-15',
        nationality: 'VNM',
        ignored_image_blob: 'base64_massive_string_should_be_stripped',
      },
    };
    await service.handleWebhook(Buffer.from(JSON.stringify(dataUpdatedPayload)), dataUpdatedPayload);
    const metadataSession = await repo.findSessionById(BigInt(sessionA.sessionId));
    const meta: any = metadataSession?.metadata;
    assert(meta?.fullName === 'NGUYỄN VĂN A', 'data.updated saves fullName to metadata');
    assert(meta?.documentNumber === docMaskedA, 'data.updated masks documentNumber in metadata (zero raw CCCD leakage)');
    assert(!meta?.ignored_image_blob, 'Sanitizes OCR metadata: does not persist raw image blobs');
    const dtoA = await service.getSession(BigInt(sessionA.sessionId), { id: userA.userId.toString(), role: 'CUSTOMER' });
    assert(!dtoA.metadata?.documentEncrypted, 'DTO strips internal documentEncrypted ciphertext from responses');

    // 4e. Unknown session webhook: safely logged, no crash
    const unknownSessionPayload = {
      event_id: `evt_unknown_${ts}`,
      event_type: 'status.updated',
      session_id: 'sess_unknown_99999',
      status: 'Declined',
    };
    const unknownRes = await service.handleWebhook(Buffer.from(JSON.stringify(unknownSessionPayload)), unknownSessionPayload);
    assert(unknownRes.success === true, 'Webhook for unknown session logs audit record safely');

    // -------------------------------------------------------------------------
    // Phase 5: Safe Delete Session
    // -------------------------------------------------------------------------
    console.log('\n[Phase 5: Safe Delete Session]');
    const sessionB2 = await service.createSession(userB.userId);
    const deleteRes = await service.deleteSession(BigInt(sessionB2.sessionId), { id: userAdmin.userId.toString(), role: 'SUPER_ADMIN' });
    assert(deleteRes.success === true, 'deleteSession succeeds for SUPER_ADMIN');
    const deletedSession = await repo.findSessionById(BigInt(sessionB2.sessionId));
    assert(deletedSession?.status === 'DELETED' && deletedSession?.deletedAt !== null, 'Session soft-deleted cleanly');
    try {
      await service.getSession(BigInt(sessionB2.sessionId), { id: userB.userId.toString(), role: 'CUSTOMER' });
      assert(false, 'Getting soft-deleted session should return 404');
    } catch (err: any) {
      assert(err instanceof NotFoundException, 'Soft-deleted session hidden from getSession (404)');
    }

    // -------------------------------------------------------------------------
    // Phase 6: Zero Secret Exposure Verification
    // -------------------------------------------------------------------------
    console.log('\n[Phase 6: Zero Secret Exposure & Mobile Isolation]');
    const serializedDto = JSON.stringify(sessionA);
    assert(!serializedDto.includes(process.env.DIDIT_API_KEY!), 'DTO does not contain DIDIT_API_KEY');
    assert(!serializedDto.includes(mockWebhookSecret), 'DTO does not contain DIDIT_WEBHOOK_SECRET');
    assert(serializedDto.includes('verificationUrl'), 'Mobile payload contains only verificationUrl');

    // -------------------------------------------------------------------------
    // Phase 7: Vietnamese Identity Normalization, Name Mismatch, Typo Recovery & Re-Verification
    // -------------------------------------------------------------------------
    console.log('\n[Phase 7: Identity Normalization, Name Mismatch & Re-Verification]');

    assert(
      normalizeVietnameseIdentityName('Nguyễn Đặng Ánh Tuyết') === 'NGUYEN DANG ANH TUYET',
      'Vietnamese normalizer maps đ/Đ -> D and strips combining accents cleanly',
    );
    assert(
      compareIdentityNames('An Nguyễn Đặng', 'NGUYEN DANG AN').matched === true &&
      compareIdentityNames('An', 'NGUYEN VAN AN').matched === false &&
      compareIdentityNames('Tran Thi B', 'NGUYEN VAN A').matched === false,
      'Name comparator accepts Western/VN multi-token reorder while rejecting single-token or surname mismatches',
    );

    const parsedV3 = extractDiditOcrIdentity({
      id_verifications: [{ status: 'Approved', first_name: 'ĐẶNG ANH', last_name: 'NGUYỄN', document_number: '0012 3456 7890' }],
    });
    assert(
      parsedV3?.fullName === 'NGUYỄN ĐẶNG ANH' && parsedV3?.documentNumberNormalized === '001234567890',
      'extractDiditOcrIdentity parses Didit v3 id_verifications[] and normalizes spaced CCCD',
    );

    // 7a. Account A named "Lê Văn Dũng" but person B ("Phạm Thị Hoa") completes KYC -> BLOCKED in IN_REVIEW (NAME_MISMATCH)
    const userMismatch = await prisma.user.create({
      data: {
        username: `didit_mismatch_${ts}`,
        email: `didit_mismatch_${ts}@test.com`,
        fullName: 'Le Van Dung',
        passwordHash,
        kycStatus: 'UNVERIFIED',
      },
    });
    extraUsers.push(userMismatch);

    const sessionMismatch = await service.createSession(userMismatch.userId);
    const mismatchDoc = `034099${String(ts).slice(-6)}`;
    const mismatchWebhook = {
      event_id: `evt_mismatch_${ts}`,
      event_type: 'status.updated',
      session_id: sessionMismatch.diditSessionId,
      status: 'Approved',
      decision: {
        id_verifications: [{ status: 'Approved', full_name: 'PHAM THI HOA', document_number: mismatchDoc }],
      },
    };
    await service.handleWebhook(Buffer.from(JSON.stringify(mismatchWebhook)), mismatchWebhook);
    const dbMismatchSess = await repo.findSessionById(BigInt(sessionMismatch.sessionId));
    const dbMismatchUser = await prisma.user.findUnique({ where: { userId: userMismatch.userId } });
    assert(
      dbMismatchSess?.status === 'IN_REVIEW' && dbMismatchSess?.reviewReason === 'NAME_MISMATCH',
      'Name Mismatch Guard (Webhook): Different person CCCD stays in IN_REVIEW (NAME_MISMATCH)',
    );
    assert(
      dbMismatchUser?.kycStatus === 'IN_REVIEW' && !dbMismatchUser?.verifiedDocumentHash,
      'Name Mismatch Guard: User not promoted to APPROVED and CCCD not bound',
    );

    // 7b. Out-of-order status.updated (Approved without OCR) -> later data.updated delivers matching OCR -> auto-settles
    const userOutOfOrder = await prisma.user.create({
      data: {
        username: `didit_ooo_${ts}`,
        email: `didit_ooo_${ts}@test.com`,
        fullName: 'Hoàng Văn Minh',
        passwordHash,
        kycStatus: 'UNVERIFIED',
      },
    });
    extraUsers.push(userOutOfOrder);
    const sessOoo = await service.createSession(userOutOfOrder.userId);
    const oooDoc = `048095${String(ts).slice(-6)}`;
    mockDecisionBodyBySession[sessOoo.diditSessionId] = { status: 'Approved' };
    const oooStatusEvt = { event_id: `evt_ooo_s_${ts}`, event_type: 'status.updated', session_id: sessOoo.diditSessionId, status: 'Approved' };
    await service.handleWebhook(Buffer.from(JSON.stringify(oooStatusEvt)), oooStatusEvt);
    const oooParked = await repo.findSessionById(BigInt(sessOoo.sessionId));
    assert(oooParked?.status === 'IN_REVIEW' && oooParked?.reviewReason === 'OCR_DATA_MISSING', 'Out-of-order status arrives first -> safely parked in OCR_DATA_MISSING');

    const oooDataEvt = {
      event_id: `evt_ooo_d_${ts}`,
      event_type: 'data.updated',
      session_id: sessOoo.diditSessionId,
      data: { full_name: 'HOANG VAN MINH', document_number: oooDoc },
    };
    await service.handleWebhook(Buffer.from(JSON.stringify(oooDataEvt)), oooDataEvt);
    const oooSettled = await repo.findSessionById(BigInt(sessOoo.sessionId));
    const oooUserSettled = await prisma.user.findUnique({ where: { userId: userOutOfOrder.userId } });
    assert(
      oooSettled?.status === 'APPROVED' && oooUserSettled?.kycStatus === 'APPROVED',
      'Out-of-order recovery: Delayed data.updated matching OCR settles OCR_DATA_MISSING -> APPROVED cleanly',
    );

    // 7c. Self-service typo recovery on /decision after fixing fullName
    const userTypo = await prisma.user.create({
      data: {
        username: `didit_typo_${ts}`,
        email: `didit_typo_${ts}@test.com`,
        fullName: 'Nguyen Van Typo',
        passwordHash,
        kycStatus: 'UNVERIFIED',
      },
    });
    extraUsers.push(userTypo);
    const sessTypo = await service.createSession(userTypo.userId);
    const typoDoc = `052096${String(ts).slice(-6)}`;
    mockDecisionBodyBySession[sessTypo.diditSessionId] = {
      status: 'Approved',
      id_verifications: [{ status: 'Approved', full_name: 'NGUYỄN VĂN CHUẨN', document_number: typoDoc }],
    };
    const firstTypoSync = await service.getDecision(BigInt(sessTypo.sessionId), { id: userTypo.userId.toString(), role: 'CUSTOMER' });
    assert(firstTypoSync.status === 'IN_REVIEW' && firstTypoSync.reviewReason === 'NAME_MISMATCH', '/decision rejects mismatch when profile name differs from OCR');

    await prisma.user.update({ where: { userId: userTypo.userId }, data: { fullName: 'Nguyễn Văn Chuẩn' } });
    const recoveredSync = await service.getDecision(BigInt(sessTypo.sessionId), { id: userTypo.userId.toString(), role: 'CUSTOMER' });
    assert(recoveredSync.status === 'APPROVED' && recoveredSync.reviewReason === null, 'Updating display name before approval lets /decision complete APPROVED cleanly');

    // 7d. Same-account re-verification succeeds even after display name edit; DIFFERENT CCCD on verified account is blocked
    await prisma.user.update({ where: { userId: userA.userId }, data: { fullName: 'Cửa Hàng Nước Gia Định' } });
    const sessReverifySame = await service.createSession(userA.userId);
    const reverifyBody = lastRequestOptions?.body ? JSON.parse(lastRequestOptions.body) : {};
    assert(
      reverifyBody?.expected_details?.identification_number === CryptoVaultUtil.normalizeIdentityDocument(docNumberA),
      'Re-verification session includes decrypted identification_number in Didit expected_details',
    );
    mockDecisionBodyBySession[sessReverifySame.diditSessionId] = {
      status: 'Approved',
      id_verifications: [{ status: 'Approved', full_name: 'NGUYEN VAN A', document_number: docNumberA }],
    };
    const reverifySameRes = await service.getDecision(BigInt(sessReverifySame.sessionId), { id: userA.userId.toString(), role: 'CUSTOMER' });
    assert(reverifySameRes.status === 'APPROVED', 'Same account re-verifies with same CCCD despite display fullName alias change');

    const sessDiffDoc = await service.createSession(userA.userId);
    mockDecisionBodyBySession[sessDiffDoc.diditSessionId] = {
      status: 'Approved',
      id_verifications: [{ status: 'Approved', full_name: 'NGUYEN VAN A', document_number: `099999${String(ts).slice(-6)}` }],
    };
    const diffDocRes = await service.getDecision(BigInt(sessDiffDoc.sessionId), { id: userA.userId.toString(), role: 'CUSTOMER' });
    const userAAfterDiff = await prisma.user.findUnique({ where: { userId: userA.userId } });
    assert(
      diffDocRes.status === 'IN_REVIEW' && diffDocRes.reviewReason === 'USER_DOCUMENT_CONFLICT',
      'Already-verified account cannot overwrite verified CCCD with a different document number',
    );
    assert(userAAfterDiff?.verifiedDocumentHash === docHashA, 'Original verifiedDocumentHash preserved intact');

    // -------------------------------------------------------------------------
    // Phase 8: 1-CCCD-1-Account Real PostgreSQL Concurrency Race, Admin Review & Dispute Revocation
    // -------------------------------------------------------------------------
    console.log('\n[Phase 8: 1-CCCD-1-Account Concurrency Race & Admin Review/Revoke Flows]');

    const sharedDoc = `075198${String(ts).slice(-6)}`;
    const userRace1 = await prisma.user.create({
      data: { username: `didit_r1_${ts}`, email: `didit_r1_${ts}@test.com`, fullName: 'Đỗ Hoàng Nam', passwordHash, kycStatus: 'UNVERIFIED' },
    });
    const userRace2 = await prisma.user.create({
      data: { username: `didit_r2_${ts}`, email: `didit_r2_${ts}@test.com`, fullName: 'Đỗ Hoàng Nam', passwordHash, kycStatus: 'UNVERIFIED' },
    });
    extraUsers.push(userRace1, userRace2);

    const sessR1 = await service.createSession(userRace1.userId);
    const sessR2 = await service.createSession(userRace2.userId);
    const raceEvt1 = {
      event_id: `evt_race1_${ts}`,
      event_type: 'status.updated',
      session_id: sessR1.diditSessionId,
      status: 'Approved',
      decision: { id_verifications: [{ status: 'Approved', full_name: 'DO HOANG NAM', document_number: sharedDoc }] },
    };
    const raceEvt2 = {
      event_id: `evt_race2_${ts}`,
      event_type: 'status.updated',
      session_id: sessR2.diditSessionId,
      status: 'Approved',
      decision: { id_verifications: [{ status: 'Approved', full_name: 'DO HOANG NAM', document_number: sharedDoc }] },
    };

    const [r1Out, r2Out] = await Promise.all([
      service.handleWebhook(Buffer.from(JSON.stringify(raceEvt1)), raceEvt1),
      service.handleWebhook(Buffer.from(JSON.stringify(raceEvt2)), raceEvt2),
    ]);
    assert(r1Out.success === true && r2Out.success === true, 'Concurrent duplicate CCCD race settles cleanly without HTTP 500 or rollback loss');

    const [postR1Sess, postR2Sess, postR1User, postR2User] = await Promise.all([
      repo.findSessionById(BigInt(sessR1.sessionId)),
      repo.findSessionById(BigInt(sessR2.sessionId)),
      prisma.user.findUnique({ where: { userId: userRace1.userId } }),
      prisma.user.findUnique({ where: { userId: userRace2.userId } }),
    ]);

    const raceStatuses = [postR1Sess?.status, postR2Sess?.status].sort();
    const raceUserKyc = [postR1User?.kycStatus, postR2User?.kycStatus].sort();
    const losingSess = postR1Sess?.status === 'APPROVED' ? postR2Sess : postR1Sess;
    const winningUserId = postR1User?.kycStatus === 'APPROVED' ? userRace1.userId : userRace2.userId;
    const losingUserId = winningUserId === userRace1.userId ? userRace2.userId : userRace1.userId;

    assert(
      raceStatuses[0] === 'APPROVED' && raceStatuses[1] === 'IN_REVIEW',
      'Concurrent 1-CCCD-1-Account: Strictly 1 session APPROVED and 1 session IN_REVIEW',
    );
    assert(
      raceUserKyc[0] === 'APPROVED' && raceUserKyc[1] === 'IN_REVIEW' && losingSess?.reviewReason === 'DUPLICATE_DOCUMENT',
      'Concurrent 1-CCCD-1-Account: Losing account blocked with reviewReason=DUPLICATE_DOCUMENT',
    );

    // Also verify /decision blocks duplicate CCCD cleanly against another account
    const userDupDecision = await prisma.user.create({
      data: { username: `didit_dupd_${ts}`, email: `didit_dupd_${ts}@test.com`, fullName: 'Đỗ Hoàng Nam', passwordHash, kycStatus: 'UNVERIFIED' },
    });
    extraUsers.push(userDupDecision);
    const sessDupDecision = await service.createSession(userDupDecision.userId);
    mockDecisionBodyBySession[sessDupDecision.diditSessionId] = {
      status: 'Approved',
      id_verifications: [{ status: 'Approved', full_name: 'DO HOANG NAM', document_number: sharedDoc }],
    };
    const dupDecisionRes = await service.getDecision(BigInt(sessDupDecision.sessionId), { id: userDupDecision.userId.toString(), role: 'CUSTOMER' });
    assert(
      dupDecisionRes.status === 'IN_REVIEW' && dupDecisionRes.reviewReason === 'DUPLICATE_DOCUMENT',
      '1-CCCD-1-Account (/decision): Rejects CCCD already bound to another verified account',
    );

    // Admin cannot force-approve duplicate CCCD while old owner is still active
    try {
      await service.reviewSession(
        BigInt(losingSess!.id),
        { id: userAdmin.userId.toString(), role: 'SUPER_ADMIN' },
        { decision: 'APPROVE', reason: 'Attempt override before revoking prior account' },
      );
      assert(false, 'Expected ConflictException when CCCD still bound to winningUserId');
    } catch (err: any) {
      assert(err instanceof ConflictException, 'Admin reviewSession refuses APPROVE while CCCD still owned by another active account');
    }

    // Account transfer / dispute flow: Admin revokes old owner -> then approving losingSess succeeds cleanly
    const revokeRes = await service.revokeUserIdentity(
      winningUserId,
      { id: userAdmin.userId.toString(), role: 'SUPER_ADMIN' },
      { reason: 'Account ownership dispute resolved in favor of transferred account' },
    );
    assert(revokeRes.revokedSessionCount >= 1, 'Admin revokeUserIdentity revokes prior approved sessions cleanly');

    const oldOwnerAfterRevoke = await prisma.user.findUnique({ where: { userId: winningUserId } });
    assert(
      oldOwnerAfterRevoke?.kycStatus === 'UNVERIFIED' && oldOwnerAfterRevoke?.verifiedDocumentHash === null,
      'Revoke clears verifiedDocumentHash and verifiedLegalName on old account',
    );

    const adminApproveRes = await service.reviewSession(
      BigInt(losingSess!.id),
      { id: userAdmin.userId.toString(), role: 'SUPER_ADMIN' },
      { decision: 'APPROVE', reason: 'Approved after revoking duplicate legacy account' },
    );
    const transferredOwner = await prisma.user.findUnique({ where: { userId: losingUserId } });
    assert(
      adminApproveRes.status === 'APPROVED' &&
      transferredOwner?.kycStatus === 'APPROVED' &&
      transferredOwner?.verifiedDocumentHash === CryptoVaultUtil.hashIdentityDocument(sharedDoc),
      'After audited revocation, transferred account approves and binds the CCCD exclusively',
    );

    // Admin review NAME_MISMATCH session with acceptOcrNameAsVerified=true
    const mismatchApproveRes = await service.reviewSession(
      BigInt(sessionMismatch.sessionId),
      { id: userAdmin.userId.toString(), role: 'SYSTEM_ADMIN' },
      { decision: 'APPROVE', reason: 'Verified legal document ownership against user ticket', acceptOcrNameAsVerified: true },
    );
    const mismatchUserAfterOverride = await prisma.user.findUnique({ where: { userId: userMismatch.userId } });
    assert(
      mismatchApproveRes.status === 'APPROVED' &&
      mismatchUserAfterOverride?.kycStatus === 'APPROVED' &&
      mismatchUserAfterOverride?.verifiedLegalName === 'PHAM THI HOA' &&
      mismatchUserAfterOverride?.fullName === 'Le Van Dung',
      'Admin acceptOcrNameAsVerified binds verifiedLegalName cleanly while keeping display fullName untouched',
    );

    // Controller & DTO validation assertions
    const controller = new IdentityVerificationsController(service);
    try {
      await controller.reviewSession(
        sessionMismatch.sessionId,
        { decision: 'APPROVE', reason: 'Non admin test' } as any,
        { id: userA.userId.toString(), role: 'CUSTOMER' },
      );
      assert(false, 'Expected ForbiddenException for CUSTOMER calling reviewSession');
    } catch (err: any) {
      assert(err instanceof ForbiddenException, 'RBAC: CUSTOMER blocked (403) from admin reviewSession');
    }

    const badReviewDto = plainToInstance(ReviewKycSessionDto, { decision: 'INVALID', reason: 'no' });
    const dtoErrors = await validate(badReviewDto);
    assert(dtoErrors.length >= 2, 'ReviewKycSessionDto validates decision enum and reason length');

    // -------------------------------------------------------------------------
    // Phase 8B: Post-Review Security & Concurrency Hardening Verification
    // -------------------------------------------------------------------------
    console.log('\n[Phase 8B: Legacy Approved Guard, Decline Lock, Watermark, Lock-Order & Response Sanitization]');

    // 8B.1 Legacy APPROVED with missing verified_document_hash must NOT short-circuit
    const legacyValidDoc = `060094${String(ts).slice(-6)}`;
    const legacyValidUser = await prisma.user.create({
      data: {
        username: `didit_legacy_ok_${ts}`,
        email: `didit_legacy_ok_${ts}@test.com`,
        fullName: 'Nguyen Van Legacy',
        passwordHash,
        kycStatus: 'APPROVED',
      },
    });
    extraUsers.push(legacyValidUser);
    const legacyValidSession = await repo.createSession({
      userId: legacyValidUser.userId,
      diditSessionId: `sess_legacy_ok_${ts}`,
      workflowId: 'wf_test',
      vendorData: `user-${legacyValidUser.userId}`,
      status: 'APPROVED',
      verificationUrl: `https://verify.didit.me/session/legacy_ok_${ts}`,
      metadata: {
        fullName: 'NGUYỄN VĂN LEGACY',
        documentNumber: legacyValidDoc,
        front_image: 'https://vendor-blob.example/legacy_front.jpg',
      },
    });
    mockDecisionBodyBySession[legacyValidSession.diditSessionId] = {
      status: 'Approved',
      id_verifications: [{ status: 'Approved', full_name: 'NGUYỄN VĂN LEGACY', document_number: legacyValidDoc }],
    };
    const legacySyncOk = await service.getDecision(BigInt(legacyValidSession.id), {
      id: legacyValidUser.userId.toString(),
      role: 'CUSTOMER',
    });
    const boundLegacyUser = await prisma.user.findUnique({ where: { userId: legacyValidUser.userId } });
    assert(
      legacySyncOk.status === 'APPROVED' &&
        boundLegacyUser?.verifiedDocumentHash === CryptoVaultUtil.hashIdentityDocument(legacyValidDoc) &&
        boundLegacyUser?.verifiedLegalName === 'NGUYỄN VĂN LEGACY',
      'Legacy Guard: Re-syncing unbound APPROVED session with valid OCR binds hash and legal name onto user',
    );

    // 8B.2 Legacy APPROVED lacking OCR drops BOTH session and user from false APPROVED to IN_REVIEW
    const legacyNoOcrUser = await prisma.user.create({
      data: {
        username: `didit_legacy_noocr_${ts}`,
        email: `didit_legacy_noocr_${ts}@test.com`,
        fullName: 'Tran Thi Legacy Empty',
        passwordHash,
        kycStatus: 'APPROVED',
      },
    });
    extraUsers.push(legacyNoOcrUser);
    const legacyNoOcrSession = await repo.createSession({
      userId: legacyNoOcrUser.userId,
      diditSessionId: `sess_legacy_noocr_${ts}`,
      workflowId: 'wf_test',
      vendorData: `user-${legacyNoOcrUser.userId}`,
      status: 'APPROVED',
      verificationUrl: `https://verify.didit.me/session/legacy_noocr_${ts}`,
    });
    mockDecisionBodyBySession[legacyNoOcrSession.diditSessionId] = { status: 'Approved' };
    const legacyNoOcrSync = await service.getDecision(BigInt(legacyNoOcrSession.id), {
      id: legacyNoOcrUser.userId.toString(),
      role: 'CUSTOMER',
    });
    const legacyNoOcrUserAfter = await prisma.user.findUnique({ where: { userId: legacyNoOcrUser.userId } });
    assert(
      legacyNoOcrSync.status === 'IN_REVIEW' &&
        legacyNoOcrSync.reviewReason === 'OCR_DATA_MISSING' &&
        legacyNoOcrUserAfter?.kycStatus === 'IN_REVIEW',
      'Legacy Guard: Unbound APPROVED user lacking OCR is downgraded to IN_REVIEW (not left APPROVED with hash=NULL)',
    );

    // 8B.3 Legacy APPROVED colliding with another bound user's CCCD drops cleanly to IN_REVIEW (DUPLICATE_DOCUMENT)
    const legacyDupUser = await prisma.user.create({
      data: {
        username: `didit_legacy_dup_${ts}`,
        email: `didit_legacy_dup_${ts}@test.com`,
        fullName: 'Nguyen Van Legacy',
        passwordHash,
        kycStatus: 'APPROVED',
      },
    });
    extraUsers.push(legacyDupUser);
    const legacyDupSession = await repo.createSession({
      userId: legacyDupUser.userId,
      diditSessionId: `sess_legacy_dup_${ts}`,
      workflowId: 'wf_test',
      vendorData: `user-${legacyDupUser.userId}`,
      status: 'APPROVED',
      verificationUrl: `https://verify.didit.me/session/legacy_dup_${ts}`,
    });
    const legacyDupHook = {
      event_id: `evt_legacy_dup_${ts}`,
      event_type: 'status.updated',
      session_id: legacyDupSession.diditSessionId,
      status: 'Approved',
      decision: {
        id_verifications: [{ status: 'Approved', full_name: 'NGUYỄN VĂN LEGACY', document_number: legacyValidDoc }],
      },
    };
    await service.handleWebhook(Buffer.from(JSON.stringify(legacyDupHook)), legacyDupHook);
    const legacyDupSessDb = await repo.findSessionById(legacyDupSession.id);
    const legacyDupUserDb = await prisma.user.findUnique({ where: { userId: legacyDupUser.userId } });
    assert(
      legacyDupSessDb?.status === 'IN_REVIEW' &&
        legacyDupSessDb?.reviewReason === 'DUPLICATE_DOCUMENT' &&
        legacyDupUserDb?.kycStatus === 'IN_REVIEW',
      'Legacy Guard: Unbound APPROVED user sharing existing CCCD moves to IN_REVIEW (DUPLICATE_DOCUMENT)',
    );

    // 8B.4 Backfill script (--dry-run and live execution) migrates legacy APPROVED rows safely
    const { backfillDiditKycIdentities } = require('../scripts/backfill_didit_kyc_identities');
    const bfDoc = `061096${String(ts).slice(-6)}`;
    const bfCleanUser = await prisma.user.create({
      data: {
        username: `didit_bf_clean_${ts}`,
        email: `didit_bf_clean_${ts}@test.com`,
        fullName: 'Phạm Minh Tuấn',
        passwordHash,
        kycStatus: 'APPROVED',
      },
    });
    const bfDupUser = await prisma.user.create({
      data: {
        username: `didit_bf_dup_${ts}`,
        email: `didit_bf_dup_${ts}@test.com`,
        fullName: 'Phạm Minh Tuấn',
        passwordHash,
        kycStatus: 'APPROVED',
      },
    });
    const bfMissingUser = await prisma.user.create({
      data: {
        username: `didit_bf_miss_${ts}`,
        email: `didit_bf_miss_${ts}@test.com`,
        fullName: 'Lê Thị Thiếu OCR',
        passwordHash,
        kycStatus: 'APPROVED',
      },
    });
    extraUsers.push(bfCleanUser, bfDupUser, bfMissingUser);
    const bfCleanSess = await repo.createSession({
      userId: bfCleanUser.userId,
      diditSessionId: `sess_bf_clean_${ts}`,
      workflowId: 'wf_test',
      vendorData: `user-${bfCleanUser.userId}`,
      status: 'APPROVED',
      verificationUrl: `https://verify.didit.me/session/bf_clean_${ts}`,
      createdAt: new Date(Date.now() - 20000),
      metadata: {
        fullName: 'PHẠM MINH TUẤN',
        documentNumber: bfDoc,
        portrait_image: 'https://raw-didit.example/bf_face.jpg',
      },
    });
    const bfDupSess = await repo.createSession({
      userId: bfDupUser.userId,
      diditSessionId: `sess_bf_dup_${ts}`,
      workflowId: 'wf_test',
      vendorData: `user-${bfDupUser.userId}`,
      status: 'APPROVED',
      verificationUrl: `https://verify.didit.me/session/bf_dup_${ts}`,
      createdAt: new Date(Date.now() - 10000),
      metadata: { fullName: 'PHẠM MINH TUẤN', documentNumber: bfDoc },
    });
    const bfMissingSess = await repo.createSession({
      userId: bfMissingUser.userId,
      diditSessionId: `sess_bf_miss_${ts}`,
      workflowId: 'wf_test',
      vendorData: `user-${bfMissingUser.userId}`,
      status: 'APPROVED',
      verificationUrl: `https://verify.didit.me/session/bf_miss_${ts}`,
    });

    const dryRunReport = await backfillDiditKycIdentities({ prismaClient: prisma, dryRun: true });
    const bfCleanPreCheck = await prisma.user.findUnique({ where: { userId: bfCleanUser.userId } });
    assert(
      dryRunReport.dryRun === true && bfCleanPreCheck?.verifiedDocumentHash === null,
      'Backfill Script --dry-run inspects legacy records without mutating DB',
    );

    const liveBackfillReport = await backfillDiditKycIdentities({ prismaClient: prisma, dryRun: false });
    const [bfCleanAfter, bfDupAfter, bfMissingAfter, bfCleanSessAfter, bfDupSessAfter, bfMissingSessAfter] =
      await Promise.all([
        prisma.user.findUnique({ where: { userId: bfCleanUser.userId } }),
        prisma.user.findUnique({ where: { userId: bfDupUser.userId } }),
        prisma.user.findUnique({ where: { userId: bfMissingUser.userId } }),
        repo.findSessionById(bfCleanSess.id),
        repo.findSessionById(bfDupSess.id),
        repo.findSessionById(bfMissingSess.id),
      ]);
    assert(
      bfCleanAfter?.kycStatus === 'APPROVED' &&
        bfCleanAfter?.verifiedDocumentHash === CryptoVaultUtil.hashIdentityDocument(bfDoc) &&
        !(bfCleanSessAfter?.metadata as any)?.portrait_image &&
        (bfCleanSessAfter?.metadata as any)?.documentNumber === CryptoVaultUtil.maskIdentityDocument(bfDoc),
      'Backfill Script binds earliest valid legacy user hash, masks CCCD, and strips raw media keys',
    );
    assert(
      bfDupAfter?.kycStatus === 'IN_REVIEW' &&
        bfDupSessAfter?.status === 'IN_REVIEW' &&
        bfDupSessAfter?.reviewReason === 'DUPLICATE_DOCUMENT' &&
        bfMissingAfter?.kycStatus === 'IN_REVIEW' &&
        bfMissingSessAfter?.status === 'IN_REVIEW' &&
        bfMissingSessAfter?.reviewReason === 'LEGACY_OCR_MISSING' &&
        liveBackfillReport.remainingUnhashedApproved === 0,
      'Backfill Script parks legacy duplicate & missing-OCR rows into IN_REVIEW leaving 0 unhashed APPROVED accounts',
    );

    // 8B.4b Backfill TOCTOU Lock Re-evaluation Tests (Mock DB Repro #1 & #2 + Live Postgres Partial-OCR #3)
    const makeStaleBackfillMockHarness = (config: {
      staleCandidateRow: any;
      liveUser: any;
      liveSession: any;
    }) => {
      let userWriteCount = 0;
      let sessionWriteCount = 0;
      const stateUser = { ...config.liveUser };
      const stateSession = { ...config.liveSession };

      const txMock: any = {
        $executeRaw: async () => 1,
        $executeRawUnsafe: async () => 0,
        $queryRaw: async (strings: TemplateStringsArray, ...values: any[]) => {
          const sql = strings.join(' ? ');
          if (sql.includes('FROM "identity_verification_sessions"') && sql.includes('LIMIT 1')) {
            return [{ id: stateSession.id, user_id: stateSession.userId, deleted_at: stateSession.deletedAt }];
          }
          if (sql.includes('FROM "users"') && sql.includes('FOR UPDATE')) {
            return [
              {
                user_id: stateUser.userId,
                full_name: stateUser.fullName,
                kyc_status: stateUser.kycStatus,
                verified_legal_name: stateUser.verifiedLegalName,
                verified_document_hash: stateUser.verifiedDocumentHash,
                verified_document_encrypted: stateUser.verifiedDocumentEncrypted,
                verified_document_masked: stateUser.verifiedDocumentMasked,
                verified_date_of_birth: stateUser.verifiedDateOfBirth,
                verified_nationality: stateUser.verifiedNationality,
                kyc_verified_at: stateUser.kycVerifiedAt,
                kyc_revoked_at: stateUser.kycRevokedAt,
              },
            ];
          }
          if (sql.includes('FROM "identity_verification_sessions"') && sql.includes('FOR UPDATE')) {
            return [
              {
                id: stateSession.id,
                user_id: stateSession.userId,
                status: stateSession.status,
                metadata: stateSession.metadata,
                verified_document_hash: stateSession.verifiedDocumentHash,
                review_reason: stateSession.reviewReason,
                reviewed_by_user_id: stateSession.reviewedByUserId,
                completed_at: stateSession.completedAt,
                created_at: stateSession.createdAt,
                deleted_at: stateSession.deletedAt,
              },
            ];
          }
          if (sql.includes('FROM "users"') && sql.includes('verified_document_hash')) {
            return stateUser.verifiedDocumentHash === String(values[0])
              ? [{ user_id: stateUser.userId }]
              : [];
          }
          return [];
        },
        user: {
          update: async ({ data }: any) => {
            userWriteCount++;
            Object.assign(stateUser, data);
            return stateUser;
          },
          updateMany: async ({ data }: any) => {
            userWriteCount++;
            Object.assign(stateUser, data);
            return { count: 1 };
          },
        },
        identityVerificationSession: {
          update: async ({ data }: any) => {
            sessionWriteCount++;
            Object.assign(stateSession, data);
            return stateSession;
          },
        },
      };

      const prismaMock: any = {
        identityVerificationSession: { findMany: async () => [] },
        $queryRaw: async () => [config.staleCandidateRow],
        $executeRaw: async () => 0,
        $transaction: async (fn: any) => fn(txMock),
        user: { count: async () => 0 },
      };

      return {
        prismaMock,
        getCounts: () => ({ userWriteCount, sessionWriteCount }),
        stateUser,
        stateSession,
      };
    };

    // Mock Repro #1a: Candidate initially APPROVED without hash, locked live state already ADMIN_DECLINED + bound to another CCCD
    const toctouDeclined = makeStaleBackfillMockHarness({
      staleCandidateRow: {
        id: BigInt(9001),
        user_id: BigInt(8001),
        didit_session_id: 'sess_toctou_1a',
        status: 'APPROVED',
        review_reason: null,
        reviewed_by_user_id: null,
        metadata: { fullName: 'NGUYEN VAN TOCTOU', documentNumber: '079091000001' },
        verified_document_hash: null,
        completed_at: new Date(),
        created_at: new Date(),
        user_full_name: 'Nguyen Van Toctou',
        user_kyc_status: 'APPROVED',
        user_doc_hash: null,
        user_legal_name: null,
        user_verified_at: null,
        user_kyc_revoked_at: null,
      },
      liveUser: {
        userId: BigInt(8001),
        fullName: 'Nguyen Van Toctou',
        kycStatus: 'APPROVED',
        verifiedLegalName: 'OTHER LEGAL OWNER',
        verifiedDocumentHash: 'bound_other_cccd_hash_8001',
        verifiedDocumentEncrypted: null,
        verifiedDocumentMasked: '********9999',
        verifiedDateOfBirth: null,
        verifiedNationality: 'VNM',
        kycVerifiedAt: new Date(),
        kycRevokedAt: null,
      },
      liveSession: {
        id: BigInt(9001),
        userId: BigInt(8001),
        status: 'DECLINED',
        metadata: { fullName: 'NGUYEN VAN TOCTOU', documentNumber: '079091000001' },
        verifiedDocumentHash: null,
        reviewReason: 'ADMIN_DECLINED',
        reviewedByUserId: BigInt(1),
        completedAt: new Date(),
        createdAt: new Date(),
        deletedAt: null,
      },
    });
    const toctouDeclinedReport = await backfillDiditKycIdentities({
      prismaClient: toctouDeclined.prismaMock,
      dryRun: false,
    });
    assert(
      toctouDeclinedReport.skippedStaleOrProtected === 1 &&
        toctouDeclinedReport.promotedUsers === 0 &&
        toctouDeclined.getCounts().userWriteCount === 0 &&
        toctouDeclined.getCounts().sessionWriteCount === 0 &&
        toctouDeclined.stateSession.status === 'DECLINED' &&
        toctouDeclined.stateUser.verifiedDocumentHash === 'bound_other_cccd_hash_8001',
      'Backfill TOCTOU Guard (#1a): Locked ADMIN_DECLINED / already-bound user is skipped with zero overwrites',
    );

    // Mock Repro #1b: Pre-TX user_full_name matched OCR, but live user.fullName changed before lock -> must park NAME_MISMATCH
    const toctouRename = makeStaleBackfillMockHarness({
      staleCandidateRow: {
        id: BigInt(9002),
        user_id: BigInt(8002),
        didit_session_id: 'sess_toctou_1b',
        status: 'APPROVED',
        review_reason: null,
        reviewed_by_user_id: null,
        metadata: { fullName: 'NGUYEN VAN TOCTOU', documentNumber: '079091000002' },
        verified_document_hash: null,
        completed_at: new Date(),
        created_at: new Date(),
        user_full_name: 'Nguyen Van Toctou',
        user_kyc_status: 'APPROVED',
        user_doc_hash: null,
        user_legal_name: null,
        user_verified_at: null,
        user_kyc_revoked_at: null,
      },
      liveUser: {
        userId: BigInt(8002),
        fullName: 'Tran Thi Doi Ten',
        kycStatus: 'APPROVED',
        verifiedLegalName: null,
        verifiedDocumentHash: null,
        verifiedDocumentEncrypted: null,
        verifiedDocumentMasked: null,
        verifiedDateOfBirth: null,
        verifiedNationality: null,
        kycVerifiedAt: null,
        kycRevokedAt: null,
      },
      liveSession: {
        id: BigInt(9002),
        userId: BigInt(8002),
        status: 'APPROVED',
        metadata: { fullName: 'NGUYEN VAN TOCTOU', documentNumber: '079091000002' },
        verifiedDocumentHash: null,
        reviewReason: null,
        reviewedByUserId: null,
        completedAt: new Date(),
        createdAt: new Date(),
        deletedAt: null,
      },
    });
    const toctouRenameReport = await backfillDiditKycIdentities({
      prismaClient: toctouRename.prismaMock,
      dryRun: false,
    });
    assert(
      toctouRenameReport.mismatchParked === 1 &&
        toctouRenameReport.promotedUsers === 0 &&
        toctouRename.stateSession.status === 'IN_REVIEW' &&
        toctouRename.stateSession.reviewReason === 'NAME_MISMATCH' &&
        toctouRename.stateUser.kycStatus === 'IN_REVIEW',
      'Backfill TOCTOU Guard (#1b): Re-checks live locked user.fullName and parks NAME_MISMATCH instead of stale approval',
    );

    // Mock Repro #2: Missing-OCR candidate concurrently REVOKED + UNVERIFIED -> must NOT overwrite into IN_REVIEW
    const toctouRevokedNoOcr = makeStaleBackfillMockHarness({
      staleCandidateRow: {
        id: BigInt(9003),
        user_id: BigInt(8003),
        didit_session_id: 'sess_toctou_2',
        status: 'APPROVED',
        review_reason: null,
        reviewed_by_user_id: null,
        metadata: null,
        verified_document_hash: null,
        completed_at: new Date(),
        created_at: new Date(Date.now() - 5000),
        user_full_name: 'Revoked Missing OCR User',
        user_kyc_status: 'APPROVED',
        user_doc_hash: null,
        user_legal_name: null,
        user_verified_at: null,
        user_kyc_revoked_at: null,
      },
      liveUser: {
        userId: BigInt(8003),
        fullName: 'Revoked Missing OCR User',
        kycStatus: 'UNVERIFIED',
        verifiedLegalName: null,
        verifiedDocumentHash: null,
        verifiedDocumentEncrypted: null,
        verifiedDocumentMasked: null,
        verifiedDateOfBirth: null,
        verifiedNationality: null,
        kycVerifiedAt: null,
        kycRevokedAt: new Date(),
      },
      liveSession: {
        id: BigInt(9003),
        userId: BigInt(8003),
        status: 'REVOKED',
        metadata: null,
        verifiedDocumentHash: null,
        reviewReason: 'ADMIN_REVOKED',
        reviewedByUserId: BigInt(1),
        completedAt: new Date(),
        createdAt: new Date(Date.now() - 5000),
        deletedAt: null,
      },
    });
    const toctouRevokedReport = await backfillDiditKycIdentities({
      prismaClient: toctouRevokedNoOcr.prismaMock,
      dryRun: false,
    });
    assert(
      toctouRevokedReport.skippedStaleOrProtected === 1 &&
        toctouRevokedReport.ocrMissingParked === 0 &&
        toctouRevokedNoOcr.getCounts().userWriteCount === 0 &&
        toctouRevokedNoOcr.getCounts().sessionWriteCount === 0 &&
        toctouRevokedNoOcr.stateSession.status === 'REVOKED' &&
        toctouRevokedNoOcr.stateUser.kycStatus === 'UNVERIFIED',
      'Backfill Revocation Guard (#2): Locked REVOKED / watermarked missing-OCR candidate stays REVOKED + UNVERIFIED cleanly',
    );

    // Medium Repro #3 (Real DB + Webhook Partial OCR): existing unmasked documentNumber must still be masked when incoming OCR only contains fullName
    const partialOcrDoc = `067091${String(ts).slice(-6)}`;
    const partialOcrUser = await prisma.user.create({
      data: {
        username: `didit_partial_${ts}`,
        email: `didit_partial_${ts}@test.com`,
        fullName: 'Vũ Thị Che Số',
        passwordHash,
        kycStatus: 'PENDING',
      },
    });
    extraUsers.push(partialOcrUser);
    const partialOcrSess = await repo.createSession({
      userId: partialOcrUser.userId,
      diditSessionId: `sess_partial_${ts}`,
      workflowId: 'wf_test',
      vendorData: `user-${partialOcrUser.userId}`,
      status: 'IN_REVIEW',
      verificationUrl: `https://verify.didit.me/session/partial_${ts}`,
      metadata: {
        documentNumber: partialOcrDoc,
        personal_number: partialOcrDoc,
      },
    });
    const partialOcrHook = {
      event_id: `evt_partial_name_only_${ts}`,
      event_type: 'data.updated',
      session_id: partialOcrSess.diditSessionId,
      data: { full_name: 'VŨ THỊ CHE SỐ' },
    };
    await service.handleWebhook(Buffer.from(JSON.stringify(partialOcrHook)), partialOcrHook);
    const partialSessAfterDb = await repo.findSessionById(partialOcrSess.id);
    const partialMetaJson = JSON.stringify(partialSessAfterDb?.metadata || {});
    assert(
      !partialMetaJson.includes(partialOcrDoc) &&
        !partialMetaJson.includes('personal_number') &&
        (partialSessAfterDb?.metadata as any)?.documentNumber ===
          CryptoVaultUtil.maskIdentityDocument(partialOcrDoc) &&
        typeof (partialSessAfterDb?.metadata as any)?.documentEncrypted === 'string',
      'Partial OCR Masking (#3): Incoming fullName-only OCR still strips/masks existing plaintext documentNumber in persisted DB metadata',
    );

    // 8B.5 Admin manual DECLINE lock: neither /decision nor webhook can override ADMIN_DECLINED
    const declinedUser = await prisma.user.create({
      data: {
        username: `didit_declined_lock_${ts}`,
        email: `didit_declined_lock_${ts}@test.com`,
        fullName: 'Đặng Văn Từ Chối',
        passwordHash,
        kycStatus: 'IN_REVIEW',
      },
    });
    extraUsers.push(declinedUser);
    const declinedDoc = `062095${String(ts).slice(-6)}`;
    const declinedSession = await repo.createSession({
      userId: declinedUser.userId,
      diditSessionId: `sess_admin_decl_${ts}`,
      workflowId: 'wf_test',
      vendorData: `user-${declinedUser.userId}`,
      status: 'IN_REVIEW',
      verificationUrl: `https://verify.didit.me/session/admin_decl_${ts}`,
    });
    const declineAdminRes = await service.reviewSession(
      declinedSession.id,
      { id: userAdmin.userId.toString(), role: 'SUPER_ADMIN' },
      { decision: 'DECLINE', reason: 'Suspected tampered portrait photo on ID card' },
    );
    mockDecisionBodyBySession[declinedSession.diditSessionId] = {
      status: 'Approved',
      id_verifications: [{ status: 'Approved', full_name: 'ĐẶNG VĂN TỪ CHỐI', document_number: declinedDoc }],
    };
    const decisionAfterAdminDecline = await service.getDecision(declinedSession.id, {
      id: declinedUser.userId.toString(),
      role: 'CUSTOMER',
    });
    const hookOverDecline = {
      event_id: `evt_override_decl_${ts}`,
      event_type: 'status.updated',
      session_id: declinedSession.diditSessionId,
      status: 'Approved',
      decision: {
        id_verifications: [{ status: 'Approved', full_name: 'ĐẶNG VĂN TỪ CHỐI', document_number: declinedDoc }],
      },
    };
    await service.handleWebhook(Buffer.from(JSON.stringify(hookOverDecline)), hookOverDecline);
    const declinedSessFinal = await repo.findSessionById(declinedSession.id);
    const declinedUserFinal = await prisma.user.findUnique({ where: { userId: declinedUser.userId } });
    assert(
      declineAdminRes.status === 'DECLINED' &&
        decisionAfterAdminDecline.status === 'DECLINED' &&
        decisionAfterAdminDecline.reviewReason === 'ADMIN_DECLINED' &&
        declinedSessFinal?.status === 'DECLINED' &&
        declinedSessFinal?.reviewReason === 'ADMIN_DECLINED' &&
        declinedUserFinal?.kycStatus === 'DECLINED' &&
        declinedUserFinal?.verifiedDocumentHash === null,
      'Admin Decline Lock: Subsequent /decision and Approved webhook cannot override ADMIN_DECLINED',
    );

    // 8B.6 Revoke ALL non-deleted statuses (DECLINED / EXPIRED / APPROVED) + watermark blocks pre-revoke syncs
    const wmUser = await prisma.user.create({
      data: {
        username: `didit_wm_${ts}`,
        email: `didit_wm_${ts}@test.com`,
        fullName: 'Bùi Thanh Thủy',
        passwordHash,
        kycStatus: 'UNVERIFIED',
      },
    });
    extraUsers.push(wmUser);
    const wmDoc = `063097${String(ts).slice(-6)}`;
    const tBase = Date.now() - 60000;
    const oldDeclinedSess = await repo.createSession({
      userId: wmUser.userId,
      diditSessionId: `sess_wm_decl_${ts}`,
      workflowId: 'wf_test',
      vendorData: `user-${wmUser.userId}`,
      status: 'DECLINED',
      verificationUrl: `https://verify.didit.me/session/wm_decl_${ts}`,
      createdAt: new Date(tBase),
    });
    const oldExpiredSess = await repo.createSession({
      userId: wmUser.userId,
      diditSessionId: `sess_wm_exp_${ts}`,
      workflowId: 'wf_test',
      vendorData: `user-${wmUser.userId}`,
      status: 'EXPIRED',
      verificationUrl: `https://verify.didit.me/session/wm_exp_${ts}`,
      createdAt: new Date(tBase + 1000),
    });
    const oldApprovedSess = await repo.createSession({
      userId: wmUser.userId,
      diditSessionId: `sess_wm_app_${ts}`,
      workflowId: 'wf_test',
      vendorData: `user-${wmUser.userId}`,
      status: 'PENDING',
      verificationUrl: `https://verify.didit.me/session/wm_app_${ts}`,
      createdAt: new Date(tBase + 2000),
    });
    const wmApproveHook = {
      event_id: `evt_wm_app_${ts}`,
      event_type: 'status.updated',
      session_id: oldApprovedSess.diditSessionId,
      status: 'Approved',
      decision: {
        id_verifications: [{ status: 'Approved', full_name: 'BÙI THANH THỦY', document_number: wmDoc }],
      },
    };
    await service.handleWebhook(Buffer.from(JSON.stringify(wmApproveHook)), wmApproveHook);
    const wmRevokeRes = await service.revokeUserIdentity(
      wmUser.userId,
      { id: userAdmin.userId.toString(), role: 'SUPER_ADMIN' },
      { reason: 'Revoke all historical KYC sessions and stamp watermark' },
    );
    const [wmDeclAfter, wmExpAfter, wmAppAfter, wmUserAfterRevoke] = await Promise.all([
      repo.findSessionById(oldDeclinedSess.id),
      repo.findSessionById(oldExpiredSess.id),
      repo.findSessionById(oldApprovedSess.id),
      prisma.user.findUnique({ where: { userId: wmUser.userId } }),
    ]);
    assert(
      wmRevokeRes.revokedSessionCount === 3 &&
        wmDeclAfter?.status === 'REVOKED' &&
        wmExpAfter?.status === 'REVOKED' &&
        wmAppAfter?.status === 'REVOKED' &&
        Boolean(wmUserAfterRevoke?.kycRevokedAt),
      'Revocation Watermark: Revokes DECLINED, EXPIRED, and APPROVED sessions and stamps kycRevokedAt',
    );

    // Even if a pre-revoke timestamped session tries /decision or webhook later, watermark forces REVOKED
    const stalePreRevokeSess = await repo.createSession({
      userId: wmUser.userId,
      diditSessionId: `sess_wm_stale_${ts}`,
      workflowId: 'wf_test',
      vendorData: `user-${wmUser.userId}`,
      status: 'EXPIRED',
      verificationUrl: `https://verify.didit.me/session/wm_stale_${ts}`,
      createdAt: new Date(wmUserAfterRevoke!.kycRevokedAt!.getTime() - 5000),
    });
    mockDecisionBodyBySession[stalePreRevokeSess.diditSessionId] = {
      status: 'Approved',
      id_verifications: [{ status: 'Approved', full_name: 'BÙI THANH THỦY', document_number: wmDoc }],
    };
    const staleSync = await service.getDecision(stalePreRevokeSess.id, {
      id: wmUser.userId.toString(),
      role: 'CUSTOMER',
    });
    const staleHook = {
      event_id: `evt_wm_stale_${ts}`,
      event_type: 'status.updated',
      session_id: oldExpiredSess.diditSessionId,
      status: 'Approved',
      decision: {
        id_verifications: [{ status: 'Approved', full_name: 'BÙI THANH THỦY', document_number: wmDoc }],
      },
    };
    await service.handleWebhook(Buffer.from(JSON.stringify(staleHook)), staleHook);
    const wmUserBlocked = await prisma.user.findUnique({ where: { userId: wmUser.userId } });
    assert(
      staleSync.status === 'REVOKED' &&
        wmUserBlocked?.kycStatus === 'UNVERIFIED' &&
        wmUserBlocked?.verifiedDocumentHash === null,
      'Revocation Watermark: Pre-revoke DECLINED/EXPIRED sessions stay permanently REVOKED under webhook & /decision',
    );

    // Brand-new session created AFTER revoke proceeds cleanly
    const postRevokeSess = await service.createSession(wmUser.userId);
    const postRevokeHook = {
      event_id: `evt_wm_post_${ts}`,
      event_type: 'status.updated',
      session_id: postRevokeSess.diditSessionId,
      status: 'Approved',
      decision: {
        id_verifications: [{ status: 'Approved', full_name: 'BÙI THANH THỦY', document_number: wmDoc }],
      },
    };
    await service.handleWebhook(Buffer.from(JSON.stringify(postRevokeHook)), postRevokeHook);
    const wmUserReverified = await prisma.user.findUnique({ where: { userId: wmUser.userId } });
    assert(
      wmUserReverified?.kycStatus === 'APPROVED' &&
        wmUserReverified?.verifiedDocumentHash === CryptoVaultUtil.hashIdentityDocument(wmDoc),
      'Post-Revoke Reverification: New session created after kycRevokedAt approves cleanly',
    );

    // 8B.7 Real PostgreSQL concurrency tests (revoke vs webhook, revoke vs /decision, revoke vs admin review)
    const runRaceCheck = async (mode: 'webhook' | 'decision' | 'review', idx: number) => {
      const raceDoc = `06409${idx}${String(ts).slice(-5)}`;
      const raceUser = await prisma.user.create({
        data: {
          username: `didit_race_${mode}_${idx}_${ts}`,
          email: `didit_race_${mode}_${idx}_${ts}@test.com`,
          fullName: `Race User ${idx}`,
          passwordHash,
          kycStatus: mode === 'review' ? 'IN_REVIEW' : 'PENDING',
        },
      });
      extraUsers.push(raceUser);
      const raceSess = await repo.createSession({
        userId: raceUser.userId,
        diditSessionId: `sess_race_${mode}_${idx}_${ts}`,
        workflowId: 'wf_test',
        vendorData: `user-${raceUser.userId}`,
        status: mode === 'review' ? 'IN_REVIEW' : 'PENDING',
        verificationUrl: `https://verify.didit.me/session/race_${mode}_${idx}_${ts}`,
        ...(mode === 'review'
          ? {
              reviewReason: 'NAME_MISMATCH',
              metadata: { fullName: `RACE USER ${idx}`, documentNumber: raceDoc },
              verifiedDocumentHash: CryptoVaultUtil.hashIdentityDocument(raceDoc),
            }
          : {}),
      });

      const revokePromise = service.revokeUserIdentity(
        raceUser.userId,
        { id: userAdmin.userId.toString(), role: 'SUPER_ADMIN' },
        { reason: `Concurrent race revoke test (${mode} #${idx})` },
      );

      let opPromise: Promise<any>;
      if (mode === 'webhook') {
        const payload = {
          event_id: `evt_race_${idx}_${ts}`,
          event_type: 'status.updated',
          session_id: raceSess.diditSessionId,
          status: 'Approved',
          decision: {
            id_verifications: [{ status: 'Approved', full_name: `RACE USER ${idx}`, document_number: raceDoc }],
          },
        };
        opPromise = service.handleWebhook(Buffer.from(JSON.stringify(payload)), payload);
      } else if (mode === 'decision') {
        mockDecisionBodyBySession[raceSess.diditSessionId] = {
          status: 'Approved',
          id_verifications: [{ status: 'Approved', full_name: `RACE USER ${idx}`, document_number: raceDoc }],
        };
        opPromise = service.getDecision(raceSess.id, {
          id: raceUser.userId.toString(),
          role: 'CUSTOMER',
        });
      } else {
        opPromise = service.reviewSession(
          raceSess.id,
          { id: userAdmin.userId.toString(), role: 'SUPER_ADMIN' },
          { decision: 'APPROVE', reason: `Concurrent race review #${idx}`, acceptOcrNameAsVerified: true },
        );
      }

      const settled = await Promise.allSettled([revokePromise, opPromise]);
      const unexpectedErr = settled.find((r) => {
        if (r.status !== 'rejected') return false;
        // review running after revoke cleanly throws ConflictException (session already REVOKED)
        if (mode === 'review' && r.reason instanceof ConflictException) return false;
        return true;
      });
      const finalUser = await prisma.user.findUnique({ where: { userId: raceUser.userId } });
      const finalSess = await repo.findSessionById(raceSess.id);
      const validInvariant =
        !unexpectedErr &&
        finalUser !== null &&
        finalSess?.status === 'REVOKED' &&
        finalUser.kycStatus === 'UNVERIFIED' &&
        finalUser.verifiedDocumentHash === null;
      return {
        ok: validInvariant,
        errMsg: unexpectedErr ? String((unexpectedErr as PromiseRejectedResult).reason) : '',
      };
    };

    const raceResults = await Promise.all([
      runRaceCheck('webhook', 1),
      runRaceCheck('webhook', 2),
      runRaceCheck('decision', 3),
      runRaceCheck('decision', 4),
      runRaceCheck('review', 5),
      runRaceCheck('review', 6),
    ]);
    assert(
      raceResults.every((r) => r.ok),
      'PostgreSQL Concurrency (Canonical Lock Order): Parallel revoke vs webhook / decision / review execute with zero deadlocks',
      raceResults.map((r) => r.errMsg).filter(Boolean).join('; '),
    );

    // 8B.8 Response sanitization: strip raw CCCD, personal_number, ciphertexts, and media URLs
    const rawLeakDoc = `065098${String(ts).slice(-6)}`;
    const rawLeakUser = await prisma.user.create({
      data: {
        username: `didit_leak_${ts}`,
        email: `didit_leak_${ts}@test.com`,
        fullName: 'Hoàng Thị Bảo Mật',
        passwordHash,
        kycStatus: 'PENDING',
      },
    });
    extraUsers.push(rawLeakUser);
    const rawLeakSess = await repo.createSession({
      userId: rawLeakUser.userId,
      diditSessionId: `sess_leak_${ts}`,
      workflowId: 'wf_test',
      vendorData: `user-${rawLeakUser.userId}`,
      status: 'IN_REVIEW',
      verificationUrl: `https://verify.didit.me/session/leak_${ts}`,
      metadata: {
        fullName: 'HOÀNG THỊ BẢO MẬT',
        documentNumber: rawLeakDoc,
        personal_number: rawLeakDoc,
        documentEncrypted: 'fake_cipher_blob',
        front_image: 'https://didit-private.example/front_raw.jpg',
        portrait_image: 'https://didit-private.example/portrait_raw.jpg',
      },
    });
    const sanitizedSessDto = await service.getSession(rawLeakSess.id, {
      id: rawLeakUser.userId.toString(),
      role: 'CUSTOMER',
    });
    const sanitizedSessList = await service.listSessions(
      { id: rawLeakUser.userId.toString(), role: 'CUSTOMER' },
      1,
      20,
    );
    mockDecisionBodyBySession[rawLeakSess.diditSessionId] = {
      session_id: rawLeakSess.diditSessionId,
      workflow_id: 'wf_test',
      status: 'Approved',
      id_verifications: [
        {
          status: 'Approved',
          full_name: 'HOÀNG THỊ BẢO MẬT',
          document_number: rawLeakDoc,
          personal_number: rawLeakDoc,
          front_image: 'https://didit-private.example/front_live.jpg',
          portrait_image: 'https://didit-private.example/portrait_live.jpg',
        },
      ],
    };
    const sanitizedDecisionDto = await service.getDecision(rawLeakSess.id, {
      id: rawLeakUser.userId.toString(),
      role: 'CUSTOMER',
    });
    const serializedAllResponses = JSON.stringify({
      sess: sanitizedSessDto,
      list: sanitizedSessList,
      dec: sanitizedDecisionDto,
    });
    assert(
      !serializedAllResponses.includes(rawLeakDoc) &&
        !serializedAllResponses.includes('didit-private.example') &&
        !serializedAllResponses.includes('fake_cipher_blob') &&
        !serializedAllResponses.includes('personal_number') &&
        !serializedAllResponses.includes('front_image') &&
        sanitizedSessDto.metadata?.documentNumber === CryptoVaultUtil.maskIdentityDocument(rawLeakDoc) &&
        sanitizedDecisionDto.status === 'APPROVED' &&
        sanitizedDecisionDto.decision?.status === 'Approved' &&
        sanitizedDecisionDto.decision?.verifiedIdentity?.documentNumberMasked ===
          CryptoVaultUtil.maskIdentityDocument(rawLeakDoc),
      'Response Sanitization: getSession, listSessions, and getDecision mask CCCD and strip raw vendor URLs/blobs',
    );

    // -------------------------------------------------------------------------
    // Phase 9: Real NestJS HTTP Pipeline & Auth Profile Display vs Legal Identity Contract
    // -------------------------------------------------------------------------
    console.log('\n[Phase 9: Real Nest HTTP Pipeline & Auth Profile Display-vs-Legal Separation]');

    // Restore native fetch before making real HTTP calls to local Nest server
    global.fetch = originalFetch;

    process.env.NODE_ENV = 'test';
    process.env.DISABLE_REDIS = 'true';
    const testJwtSecret =
      process.env.JWT_SECRET || 'ci_test_jwt_secret_key_minimum_32_characters_long_for_security!';
    process.env.JWT_SECRET = testJwtSecret;

    const superAdminRole = await prisma.role.upsert({
      where: { roleCode: 'SUPER_ADMIN' },
      update: {},
      create: {
        roleCode: 'SUPER_ADMIN',
        roleName: 'Super Administrator',
        description: 'Platform root role',
      },
    });
    const adminMembership = await prisma.platformMembership.create({
      data: {
        userId: userAdmin.userId,
        roleId: superAdminRole.roleId,
        status: 'ACTIVE',
      },
    });
    createdAdminMembershipId = adminMembership.membershipId;

    httpApp = await NestFactory.create(AppModule, { rawBody: true, logger: ['error'] });
    httpApp.useGlobalFilters(new AllExceptionsFilter());
    httpApp.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    httpApp.setGlobalPrefix('api/v1', { exclude: ['health', 'healthz', 'readyz'] });
    await httpApp.listen(0);
    const addr: any = httpApp.getHttpServer().address();
    const httpBase = `http://127.0.0.1:${addr.port}/api/v1`;

    const iatSec = Math.floor(Date.now() / 1000);
    const userMismatchToken = jwt.sign(
      {
        userId: userMismatch.userId.toString(),
        email: userMismatch.email,
        role: 'CUSTOMER',
        iat: iatSec,
      },
      testJwtSecret,
      { expiresIn: '1h' },
    );
    const adminHttpToken = jwt.sign(
      {
        userId: userAdmin.userId.toString(),
        email: userAdmin.email,
        role: 'SUPER_ADMIN',
        iat: iatSec,
      },
      testJwtSecret,
      { expiresIn: '1h' },
    );

    // 9a. Anti-mass-assignment: UpdateProfileDto ValidationPipe rejects extra fields (400) AND AuthService preserves verifiedLegalName
    const strictPipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
    let rejectedExtraField = false;
    try {
      await strictPipe.transform(
        { fullName: 'Valid Display', verifiedLegalName: 'SPOOFED LEGAL NAME' },
        { type: 'body', metatype: UpdateProfileDto },
      );
    } catch (err: any) {
      rejectedExtraField = err instanceof BadRequestException;
    }
    assert(rejectedExtraField, 'DTO ValidationPipe: UpdateProfileDto rejects unknown verifiedLegalName with 400');

    const spoofHttpRes = await fetch(`${httpBase}/auth/profile`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${userMismatchToken}`,
      },
      body: JSON.stringify({ fullName: 'Valid Display', verifiedLegalName: 'SPOOFED LEGAL NAME' }),
    });
    const spoofUserDb = await prisma.user.findUnique({ where: { userId: userMismatch.userId } });
    assert(
      (spoofHttpRes.status === 400 || spoofHttpRes.status === 200) &&
      spoofUserDb?.verifiedLegalName === 'PHAM THI HOA',
      'HTTP Auth: PATCH /auth/profile cannot alter immutable verifiedLegalName',
    );

    // 9b. Updating display fullName preserves APPROVED kycStatus and immutable verifiedLegalName
    const updRes = await fetch(`${httpBase}/auth/profile`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${userMismatchToken}`,
      },
      body: JSON.stringify({ fullName: 'Tên Hiển Thị Mới Của Dũng' }),
    });
    const updJson: any = await updRes.json();
    assert(
      updRes.status === 200 &&
      updJson.data?.fullName === 'Tên Hiển Thị Mới Của Dũng' &&
      updJson.data?.kycStatus === 'APPROVED' &&
      updJson.data?.verifiedLegalName === 'PHAM THI HOA' &&
      typeof updJson.data?.verifiedDocumentMasked === 'string',
      'HTTP Auth: updateProfile changes display fullName while keeping kycStatus=APPROVED and immutable verifiedLegalName',
    );

    // 9c. GET /auth/me returns safe read-only KYC fields and zero encrypted/hash secrets
    const meRes = await fetch(`${httpBase}/auth/me`, {
      headers: { Authorization: `Bearer ${userMismatchToken}` },
    });
    const meJson: any = await meRes.json();
    assert(
      meRes.status === 200 &&
      meJson.data?.kycStatus === 'APPROVED' &&
      meJson.data?.verifiedLegalName === 'PHAM THI HOA' &&
      meJson.data?.verifiedDocumentMasked === CryptoVaultUtil.maskIdentityDocument(mismatchDoc) &&
      meJson.data?.verifiedDocumentEncrypted === undefined &&
      meJson.data?.verifiedDocumentHash === undefined,
      'HTTP Auth: GET /auth/me exposes verifiedLegalName & masked CCCD without leaking hash/ciphertext',
    );

    // 9d. RBAC & ValidationPipe on /review and /revoke over HTTP
    const custReviewHttp = await fetch(`${httpBase}/identity-verifications/sessions/${sessionMismatch.sessionId}/review`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${userMismatchToken}`,
      },
      body: JSON.stringify({ decision: 'APPROVE', reason: 'Attempt bypass' }),
    });
    assert(custReviewHttp.status === 403, 'HTTP RBAC: CUSTOMER receives 403 on POST /sessions/:id/review');

    const overflowIdRes = await fetch(
      `${httpBase}/identity-verifications/sessions/9223372036854775808/review`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminHttpToken}`,
        },
        body: JSON.stringify({ decision: 'DECLINE', reason: 'Out of range BIGINT test' }),
      },
    );
    assert(overflowIdRes.status === 400, 'HTTP Validation: BIGINT overflow sessionId returns 400 Bad Request');

    // 9e. Live HTTP rawBody HMAC webhook triggers NAME_MISMATCH cleanly, followed by Admin HTTP review & revoke
    const httpUser = await prisma.user.create({
      data: {
        username: `didit_http_${ts}`,
        email: `didit_http_${ts}@test.com`,
        fullName: 'Vũ Thị Hà',
        passwordHash,
        kycStatus: 'PENDING',
      },
    });
    extraUsers.push(httpUser);
    const httpSession = await repo.createSession({
      userId: httpUser.userId,
      diditSessionId: `sess_http_${ts}`,
      workflowId: process.env.DIDIT_WORKFLOW_ID || 'wf_test',
      vendorData: `user-${httpUser.userId.toString()}`,
      status: 'PENDING',
      verificationUrl: `https://verify.didit.me/session/http_${ts}`,
    });
    const httpDoc = `089197${String(ts).slice(-6)}`;
    const httpWebhookBody = JSON.stringify({
      event_id: `evt_http_nm_${ts}`,
      event_type: 'status.updated',
      session_id: httpSession.diditSessionId,
      status: 'Approved',
      decision: {
        id_verifications: [{ status: 'Approved', full_name: 'TRAN VAN KHAC', document_number: httpDoc }],
      },
    });
    const httpWebhookSig = crypto
      .createHmac('sha256', mockWebhookSecret)
      .update(Buffer.from(httpWebhookBody))
      .digest('hex');
    const httpHookRes = await fetch(`${httpBase}/webhooks/didit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-signature-v2': httpWebhookSig,
      },
      body: httpWebhookBody,
    });
    const dbHttpSess = await repo.findSessionById(httpSession.id);
    assert(
      httpHookRes.status === 200 && dbHttpSess?.status === 'IN_REVIEW' && dbHttpSess?.reviewReason === 'NAME_MISMATCH',
      'HTTP Webhook: Signed rawBody webhook blocks name mismatch cleanly into IN_REVIEW (NAME_MISMATCH)',
    );

    const adminApproveHttp = await fetch(
      `${httpBase}/identity-verifications/sessions/${httpSession.id.toString()}/review`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminHttpToken}`,
        },
        body: JSON.stringify({
          decision: 'APPROVE',
          reason: 'HTTP Admin approved verified mismatch case',
          acceptOcrNameAsVerified: true,
        }),
      },
    );
    const adminApproveJson: any = await adminApproveHttp.json();
    assert(
      adminApproveHttp.status === 200 && adminApproveJson.data?.status === 'APPROVED',
      'HTTP Admin Review: SUPER_ADMIN approves IN_REVIEW session with acceptOcrNameAsVerified',
    );

    const adminRevokeHttp = await fetch(
      `${httpBase}/identity-verifications/users/${httpUser.userId.toString()}/revoke`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminHttpToken}`,
        },
        body: JSON.stringify({ reason: 'HTTP Admin revoked verified identity for transfer test' }),
      },
    );
    const adminRevokeJson: any = await adminRevokeHttp.json();
    const httpUserAfterRevoke = await prisma.user.findUnique({ where: { userId: httpUser.userId } });
    assert(
      adminRevokeHttp.status === 200 &&
      adminRevokeJson.data?.revokedSessionCount === 1 &&
      httpUserAfterRevoke?.kycStatus === 'UNVERIFIED' &&
      httpUserAfterRevoke?.verifiedDocumentHash === null,
      'HTTP Admin Revoke: SUPER_ADMIN revokes verified user identity and releases CCCD hash',
    );

    // 9B. Real HTTP /sessions/:id and /sessions/:id/decision never leak raw CCCD or vendor media URLs
    const { DiditClientService: HttpDiditClientClass } = await import(
      '../src/identity-verifications/didit-client.service'
    );
    const liveDiditClient = httpApp.get(HttpDiditClientClass);
    const prevLiveGetDecision = liveDiditClient.getDecision.bind(liveDiditClient);
    const httpRawLeakDoc = `066099${String(ts).slice(-6)}`;
    const httpSanitizeUser = await prisma.user.create({
      data: {
        username: `didit_http_san_${ts}`,
        email: `didit_http_san_${ts}@test.com`,
        fullName: 'Đỗ Quốc Dũng',
        passwordHash,
        kycStatus: 'PENDING',
      },
    });
    extraUsers.push(httpSanitizeUser);
    const httpSanitizeSess = await repo.createSession({
      userId: httpSanitizeUser.userId,
      diditSessionId: `sess_http_san_${ts}`,
      workflowId: process.env.DIDIT_WORKFLOW_ID || 'wf_test',
      vendorData: `user-${httpSanitizeUser.userId.toString()}`,
      status: 'PENDING',
      verificationUrl: `https://verify.didit.me/session/http_san_${ts}`,
      metadata: {
        fullName: 'ĐỖ QUỐC DŨNG',
        documentNumber: httpRawLeakDoc,
        personal_number: httpRawLeakDoc,
        front_image: 'https://didit-secret.example/front_http.jpg',
      },
    });
    const httpSanitizeToken = jwt.sign(
      {
        userId: httpSanitizeUser.userId.toString(),
        email: httpSanitizeUser.email,
        role: 'CUSTOMER',
        iat: iatSec,
      },
      testJwtSecret,
      { expiresIn: '1h' },
    );

    liveDiditClient.getDecision = async () => ({
      session_id: httpSanitizeSess.diditSessionId,
      workflow_id: 'wf_test',
      status: 'Approved',
      id_verifications: [
        {
          status: 'Approved',
          full_name: 'ĐỖ QUỐC DŨNG',
          document_number: httpRawLeakDoc,
          personal_number: httpRawLeakDoc,
          front_image: 'https://didit-secret.example/decision_front.jpg',
          portrait_image: 'https://didit-secret.example/decision_face.jpg',
        },
      ],
    });
    try {
      const httpGetSessRes = await fetch(
        `${httpBase}/identity-verifications/sessions/${httpSanitizeSess.id.toString()}`,
        {
          headers: { Authorization: `Bearer ${httpSanitizeToken}` },
        },
      );
      const httpGetSessText = await httpGetSessRes.text();
      const httpGetDecRes = await fetch(
        `${httpBase}/identity-verifications/sessions/${httpSanitizeSess.id.toString()}/decision`,
        {
          headers: { Authorization: `Bearer ${httpSanitizeToken}` },
        },
      );
      const httpGetDecText = await httpGetDecRes.text();
      const httpGetDecJson: any = JSON.parse(httpGetDecText);
      const combinedHttpText = `${httpGetSessText}\n${httpGetDecText}`;
      assert(
        httpGetSessRes.status === 200 &&
          httpGetDecRes.status === 200 &&
          httpGetDecJson.data?.status === 'APPROVED' &&
          httpGetDecJson.data?.decision?.status === 'Approved' &&
          httpGetDecJson.data?.decision?.verifiedIdentity?.documentNumberMasked ===
            CryptoVaultUtil.maskIdentityDocument(httpRawLeakDoc) &&
          !combinedHttpText.includes(httpRawLeakDoc) &&
          !combinedHttpText.includes('didit-secret.example') &&
          !combinedHttpText.includes('personal_number') &&
          !combinedHttpText.includes('front_image') &&
          !combinedHttpText.includes('portrait_image'),
        'HTTP Response Sanitization: GET /sessions/:id and /sessions/:id/decision never leak raw CCCD or vendor URLs',
      );
    } finally {
      liveDiditClient.getDecision = prevLiveGetDecision;
    }
  } finally {
    if (httpApp) {
      await httpApp.close().catch(() => { });
    }
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;
    if (prevDisableRedis === undefined) delete process.env.DISABLE_REDIS;
    else process.env.DISABLE_REDIS = prevDisableRedis;
    if (prevJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = prevJwtSecret;

    // -------------------------------------------------------------------------
    // Cleanup: Zero-Residue Database Purge
    // -------------------------------------------------------------------------
    console.log('\n[Cleanup: Removing Test Fixtures]');
    try {
      if (createdAdminMembershipId) {
        await prisma.platformMembership.deleteMany({
          where: { membershipId: createdAdminMembershipId },
        });
      }
      const userIds = [userA?.userId, userB?.userId, userAdmin?.userId, ...extraUsers.map((u) => u?.userId)].filter(
        Boolean,
      );
      if (userIds.length > 0) {
        const sessions = await prisma.identityVerificationSession.findMany({
          where: { userId: { in: userIds } },
          select: { diditSessionId: true },
        });
        const diditIds = sessions.map((s) => s.diditSessionId);

        if (diditIds.length > 0) {
          await prisma.diditWebhookEvent.deleteMany({
            where: { diditSessionId: { in: diditIds } },
          });
        }
        await prisma.diditWebhookEvent.deleteMany({
          where: { eventId: { in: [`evt_unknown_${ts}`] } },
        });

        await prisma.identityVerificationSession.deleteMany({
          where: { userId: { in: userIds } },
        });

        await prisma.user.deleteMany({
          where: { userId: { in: userIds } },
        });
        console.log(`  Cleaned up all ${userIds.length} test users, sessions, and webhook events.`);
      }
    } catch (cleanupErr: any) {
      console.warn('  Cleanup warning:', cleanupErr.message);
    } finally {
      await prisma.$disconnect();
    }
  }

  console.log('\n================================================================================');
  console.log(`📊 TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('================================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
  process.exit(0);
}

runDiditKycTestSuite().catch((err) => {
  console.error('Test Suite encountered fatal error:', err);
  process.exit(1);
});
