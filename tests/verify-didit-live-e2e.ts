import * as dotenv from 'dotenv';
dotenv.config();

import { PrismaClient } from '@prisma/client';
import * as jwt from 'jsonwebtoken';
import * as crypto from 'crypto';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();
const baseUrl = 'http://localhost:3000/api/v1';
const ngrokBaseUrl = 'https://john-antiquely-scoop.ngrok-free.dev/api/v1';

async function main() {
  console.log('================================================================================');
  console.log('🧪 LIVE E2E & DATABASE VERIFICATION FOR DIDIT eKYC MODULE');
  console.log('================================================================================\n');

  let passed = 0;
  let failed = 0;

  const assert = (condition: boolean, name: string, detail?: string) => {
    if (condition) {
      console.log(`  \x1b[32m✔ [PASS]\x1b[0m ${name}`);
      passed++;
    } else {
      console.error(`  \x1b[31m✖ [FAIL]\x1b[0m ${name}${detail ? ` -> ${detail}` : ''}`);
      failed++;
    }
  };

  const ts = Date.now();
  let testUser: any = null;

  try {
    // -------------------------------------------------------------------------
    // 0. Setup active test user & JWT
    // -------------------------------------------------------------------------
    console.log('[Setup: Active Test User & JWT]');
    const passwordHash = await bcrypt.hash('SecurePass123!', 10);
    testUser = await prisma.user.create({
      data: {
        username: `didit_e2e_${ts}`,
        email: `didit_e2e_${ts}@test.com`,
        fullName: 'Nguyen Thi Live Test',
        passwordHash,
        status: 'ACTIVE',
        kycStatus: 'UNVERIFIED',
      },
    });

    const jwtSecret = process.env.JWT_SECRET || 'smart_order_button_super_secret_jwt_key_2026_prod';
    const token = jwt.sign(
      {
        userId: testUser.userId.toString(),
        email: testUser.email,
        role: 'CUSTOMER',
        iat: Math.floor(Date.now() / 1000),
      },
      jwtSecret,
      { expiresIn: '1h' },
    );
    console.log(`  Created test user #${testUser.userId} (${testUser.email})`);

    // -------------------------------------------------------------------------
    // 1. Mobile flow: POST /api/v1/identity-verifications/sessions
    // -------------------------------------------------------------------------
    console.log('\n[1. Mobile Flow: Create Session]');
    const createRes = await fetch(`${baseUrl}/identity-verifications/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    const createData = await createRes.json();
    assert(createRes.status === 201, 'Mobile POST session returns HTTP 201');
    assert(createData.success === true, 'Response envelope has success: true');
    assert(createData.data && createData.data.sessionId, 'Session returns valid sessionId');
    assert(
      createData.data.verificationUrl && createData.data.verificationUrl.startsWith('https://'),
      'Session returns verificationUrl',
    );
    assert(createData.data.status === 'PENDING', 'Initial session status is PENDING');
    assert(!createData.data.DIDIT_API_KEY && !createData.data.apiKey, 'Response never leaks DIDIT_API_KEY');
    assert(!createData.data.DIDIT_WEBHOOK_SECRET, 'Response never leaks DIDIT_WEBHOOK_SECRET');

    const sessionId = createData.data.sessionId;
    const diditSessionId = createData.data.diditSessionId;

    // -------------------------------------------------------------------------
    // 2. Mobile flow: GET /api/v1/identity-verifications/sessions/:sessionId
    // -------------------------------------------------------------------------
    console.log('\n[2. Mobile Flow: Fetch Session Status]');
    const getRes = await fetch(`${baseUrl}/identity-verifications/sessions/${sessionId}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    const getData = await getRes.json();
    assert(getRes.status === 200, 'Mobile GET session returns HTTP 200');
    assert(getData.data.sessionId === sessionId, 'Retrieved session matches requested ID');
    assert(getData.data.status === 'PENDING', 'Session status matches current PENDING state');

    // -------------------------------------------------------------------------
    // 3. Webhook: status.updated (Approved) with HMAC Signature
    // -------------------------------------------------------------------------
    console.log('\n[3. Webhook Flow: status.updated -> Approved]');
    const secret = process.env.DIDIT_WEBHOOK_SECRET || 'Dox9F4yaPHT16JG1Q0zRuvx_0D0vb9PMiNgaCIa3l5Q';
    const statusPayload = {
      event_id: `evt_live_status_${ts}`,
      event_type: 'status.updated',
      session_id: diditSessionId,
      status: 'Approved',
    };
    const statusBody = JSON.stringify(statusPayload);
    const statusSignature = crypto
      .createHmac('sha256', secret)
      .update(Buffer.from(statusBody))
      .digest('hex');

    const webhookRes1 = await fetch(`${baseUrl}/webhooks/didit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-signature-v2': statusSignature,
      },
      body: statusBody,
    });
    const webhookData1 = await webhookRes1.json();
    assert(webhookRes1.status === 200, 'Valid webhook returns HTTP 200 OK');
    assert(webhookData1.success === true, 'Webhook response has success: true');

    // Verify DB update
    const freshSession = await prisma.identityVerificationSession.findUnique({
      where: { diditSessionId },
    });
    assert(freshSession?.status === 'APPROVED', 'Database session status transitioned to APPROVED');

    const freshUser = await prisma.user.findUnique({
      where: { userId: testUser.userId },
    });
    assert(freshUser?.kycStatus === 'APPROVED', 'Database user kycStatus transitioned to APPROVED');

    // -------------------------------------------------------------------------
    // 4. Webhook: data.updated (OCR metadata sanitization)
    // -------------------------------------------------------------------------
    console.log('\n[4. Webhook Flow: data.updated -> Sanitized OCR Metadata]');
    const dataPayload = {
      event_id: `evt_live_data_${ts}`,
      event_type: 'data.updated',
      session_id: diditSessionId,
      data: {
        full_name: 'NGUYEN THI LIVE TEST',
        document_number: '079199000123',
        date_of_birth: '1999-09-09',
        nationality: 'VNM',
        ignored_image_base64: 'super_heavy_image_data_that_must_not_persist',
      },
    };
    const dataBody = JSON.stringify(dataPayload);
    const dataSignature = crypto
      .createHmac('sha256', secret)
      .update(Buffer.from(dataBody))
      .digest('hex');

    const webhookRes2 = await fetch(`${baseUrl}/webhooks/didit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-signature-v2': dataSignature,
      },
      body: dataBody,
    });
    const webhookData2 = await webhookRes2.json();
    assert(webhookRes2.status === 200, 'data.updated returns HTTP 200 OK');
    assert(webhookData2.success === true, 'data.updated response has success: true');

    const metaSession = await prisma.identityVerificationSession.findUnique({
      where: { diditSessionId },
    });
    const meta: any = metaSession?.metadata;
    assert(meta?.fullName === 'NGUYEN THI LIVE TEST', 'Metadata contains parsed fullName');
    assert(meta?.documentNumber === '079199000123', 'Metadata contains parsed documentNumber');
    assert(!meta?.ignored_image_base64, 'Metadata strictly omits heavy image/video payloads');

    // -------------------------------------------------------------------------
    // 5. Duplicate Webhook: Idempotency Check
    // -------------------------------------------------------------------------
    console.log('\n[5. Webhook Idempotency: Duplicate Replay]');
    const replayRes = await fetch(`${baseUrl}/webhooks/didit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-signature-v2': statusSignature,
      },
      body: statusBody,
    });
    const replayData = await replayRes.json();
    assert(replayRes.status === 200, 'Duplicate webhook returns HTTP 200 OK');
    assert(replayData.message === 'Event already processed', 'Duplicate returns "Event already processed" message');

    // -------------------------------------------------------------------------
    // 6. Security Guards: Invalid & Missing Signatures
    // -------------------------------------------------------------------------
    console.log('\n[6. Security Guards: Signature Defenses]');
    const badSigRes = await fetch(`${baseUrl}/webhooks/didit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-signature-v2': 'invalid_signature_hex_1234567890abcdef',
      },
      body: JSON.stringify({ event_type: 'test' }),
    });
    assert(badSigRes.status === 401, 'Invalid signature returns HTTP 401 Unauthorized');

    const missingSigRes = await fetch(`${baseUrl}/webhooks/didit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ event_type: 'test' }),
    });
    assert(missingSigRes.status === 401, 'Missing signature header returns HTTP 401');

    // -------------------------------------------------------------------------
    // 7. Unknown session webhook: safe audit logging
    // -------------------------------------------------------------------------
    console.log('\n[7. Unknown Session Webhook]');
    const unknownPayload = {
      event_id: `evt_unknown_${ts}`,
      event_type: 'status.updated',
      session_id: 'unknown_vendor_session_999999',
      status: 'Declined',
    };
    const unknownBody = JSON.stringify(unknownPayload);
    const unknownSig = crypto.createHmac('sha256', secret).update(Buffer.from(unknownBody)).digest('hex');

    const unknownRes = await fetch(`${baseUrl}/webhooks/didit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-signature-v2': unknownSig,
      },
      body: unknownBody,
    });
    const unknownData = await unknownRes.json();
    assert(unknownRes.status === 200, 'Unknown session returns HTTP 200');
    assert(unknownData.message === 'Webhook received for unknown session', 'Unknown session returns safe warning message');

    // -------------------------------------------------------------------------
    // 8. Test Webhook Through Live ngrok Tunnel
    // -------------------------------------------------------------------------
    console.log('\n[8. Live ngrok Tunnel End-to-End Verification]');
    const ngrokPayload = {
      event_id: `evt_ngrok_${ts}`,
      event_type: 'status.updated',
      session_id: diditSessionId,
      status: 'Approved',
    };
    const ngrokBody = JSON.stringify(ngrokPayload);
    const ngrokSig = crypto.createHmac('sha256', secret).update(Buffer.from(ngrokBody)).digest('hex');

    const ngrokRes = await fetch(`${ngrokBaseUrl}/webhooks/didit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-signature-v2': ngrokSig,
        'ngrok-skip-browser-warning': 'true',
      },
      body: ngrokBody,
    });
    const ngrokData = await ngrokRes.json();
    assert(ngrokRes.status === 200, 'ngrok public tunnel forward returns HTTP 200 OK');
    assert(ngrokData.success === true, 'ngrok forward response confirms success: true');

    // -------------------------------------------------------------------------
    // 9. Inspect Database Rows
    // -------------------------------------------------------------------------
    console.log('\n[9. Database Inspection: Verification Records]');
    const dbEvents = await prisma.diditWebhookEvent.findMany({
      where: {
        eventId: {
          in: [
            `evt_live_status_${ts}`,
            `evt_live_data_${ts}`,
            `evt_unknown_${ts}`,
            `evt_ngrok_${ts}`,
          ],
        },
      },
      orderBy: { id: 'asc' },
    });
    console.log(`  Found ${dbEvents.length} webhook event records in PostgreSQL:`);
    for (const ev of dbEvents) {
      console.log(
        `    - Event #${ev.id}: eventId=${ev.eventId}, type=${ev.eventType}, status=${ev.status}, processedAt=${ev.processedAt?.toISOString()}`,
      );
    }
    assert(dbEvents.length >= 4, 'All test webhook events successfully recorded in PostgreSQL');
    assert(
      dbEvents.every((e) => e.processedAt !== null),
      'All webhook events have processedAt timestamp finalized',
    );

    console.log('\n================================================================================');
    console.log(`📊 E2E LIVE TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
    console.log('================================================================================');
  } catch (err: any) {
    console.error('Fatal test error:', err);
    failed++;
  } finally {
    // Cleanup test user & sessions
    if (testUser) {
      await prisma.diditWebhookEvent.deleteMany({
        where: { diditSessionId: { contains: `${ts}` } },
      }).catch(() => {});
      await prisma.identityVerificationSession.deleteMany({
        where: { userId: testUser.userId },
      }).catch(() => {});
      await prisma.user.delete({
        where: { userId: testUser.userId },
      }).catch(() => {});
      console.log(`\n[Cleanup] Cleaned up test user #${testUser.userId}`);
    }
    await prisma.$disconnect();
  }

  process.exit(failed > 0 ? 1 : 0);
}

main();
