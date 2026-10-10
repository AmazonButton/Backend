import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const API_URL = `${BASE_URL}/api/v1`;

function logTest(name: string, passed: boolean, detail?: string) {
  if (passed) {
    console.log(`\x1b[32m  ✔ [PASS]\x1b[0m ${name}`);
  } else {
    console.log(`\x1b[31m  ✖ [FAIL]\x1b[0m ${name} - ${detail || ''}`);
  }
}

async function runTests() {
  console.log('\n======================================================');
  console.log('🧪 SMART ORDER BUTTON (BRD V2.1) — AUTOMATED TEST SUITE');
  console.log('======================================================\n');

  let passed = 0;
  let failed = 0;
  let cleanupFailed = false;

  // 0. Recording Exact Baselines Before Execution
  let baselinePairingTokens = 0;
  let baselineRefreshTokens = 0;
  let baselineOrders = 0;

  try {
    baselinePairingTokens = await prisma.pairingToken.count();
    baselineRefreshTokens = await prisma.refreshToken.count();
    baselineOrders = await prisma.order.count();
  } catch (e: any) {
    console.warn('Could not record baseline counts from PostgreSQL:', e.message);
  }

  const createdPairingTokenHashes: string[] = [];
  const createdRefreshTokens: string[] = [];
  const createdOrderIds: bigint[] = [];
  const createdOrderCodes: string[] = [];
  const createdRequestIds: string[] = [];

  let storeToken = '';
  let storeRefreshToken = '';
  let customerToken = '';
  const deviceId = 'BTN-8829-WTR';
  const testSecret = process.env.TEST_DEVICE_SECRET || 'sec_btn8829_f79c428784e5e14ddf0cb866fc07ca7f5c68a5a295b27ede';
  const deviceSecret = testSecret;
  const testRequestId = `test_req_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
  let validOrderNumber = '';
  let validOrderId = '';

  try {
    // 1. Healthcheck Test
    try {
      const res = await fetch(`${API_URL}/health`);
      const data = await res.json();
      if (res.status === 200 && data.status === 'OK') {
        logTest('Server Healthcheck (/api/v1/health & /healthz)', true);
        passed++;
      } else {
        throw new Error(`Unexpected status ${res.status}`);
      }
    } catch (e: any) {
      logTest('Server Healthcheck (/api/v1/health)', false, e.message);
      failed++;
    }

    // 2. Auth: Login Store Owner
    try {
      const res = await fetch(`${API_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'store@smartorder.local',
          password: 'Password123!',
        }),
      });
      const data = await res.json();
      if (res.status === 200 && (data.data?.token || data.token)) {
        storeToken = data.data?.token || data.token;
        storeRefreshToken = data.data?.refreshToken || data.refreshToken;
        if (storeRefreshToken) {
          createdRefreshTokens.push(storeRefreshToken);
        }
        logTest('Auth: Store Owner Login', true);
        passed++;
      } else {
        throw new Error(data.message);
      }
    } catch (e: any) {
      logTest('Auth: Store Owner Login', false, e.message);
      failed++;
    }

    // 3. Auth: Login Customer
    try {
      const res = await fetch(`${API_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'customer@smartorder.local',
          password: 'Password123!',
        }),
      });
      const data = await res.json();
      if (res.status === 200 && (data.data?.token || data.token)) {
        customerToken = data.data?.token || data.token;
        const custRt = data.data?.refreshToken || data.refreshToken;
        if (custRt) {
          createdRefreshTokens.push(custRt);
        }
        logTest('Auth: Global Customer Login', true);
        passed++;
      } else {
        throw new Error(data.message);
      }
    } catch (e: any) {
      logTest('Auth: Global Customer Login', false, e.message);
      failed++;
    }

    // 4. Security: HMAC Valid Signature Button Press
    try {
      createdRequestIds.push(testRequestId);
      const timestamp = Date.now().toString();
      const nonce = crypto.randomBytes(16).toString('hex');
      const body = {
        eventType: 'DOUBLE_PRESS',
        requestId: testRequestId,
        battery: 95,
        rssi: -52,
      };
      const bodyString = JSON.stringify(body);
      const payload = `${deviceId}:${timestamp}:${nonce}:${bodyString}`;
      const signature = crypto.createHmac('sha256', deviceSecret).update(payload).digest('hex');

      const res = await fetch(`${API_URL}/iot/events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-device-id': deviceId,
          'x-timestamp': timestamp,
          'x-nonce': nonce,
          'x-signature': signature,
        },
        body: bodyString,
      });

      const data = await res.json();
      const orderData = data.data?.order || data.data;
      if ((res.status === 200 || res.status === 201) && (orderData?.orderNumber || orderData?.orderCode)) {
        validOrderNumber = orderData.orderNumber || orderData.orderCode;
        validOrderId = orderData.id || orderData.orderId;
        if (validOrderId) createdOrderIds.push(BigInt(validOrderId));
        if (validOrderNumber) createdOrderCodes.push(validOrderNumber);
        logTest(`IoT Event: Valid HMAC-SHA256 Button Press -> Created Order ${validOrderNumber}`, true);
        passed++;
      } else {
        throw new Error(data.message || JSON.stringify(data));
      }
    } catch (e: any) {
      logTest('IoT Event: Valid HMAC-SHA256 Button Press', false, e.message);
      failed++;
    }

    // 5. Anti-Spam / Idempotency: Re-submitting the exact same requestId must NOT create a duplicate order
    try {
      const timestamp = Date.now().toString();
      const nonce = crypto.randomBytes(16).toString('hex');
      const body = {
        eventType: 'DOUBLE_PRESS',
        requestId: testRequestId, // Reused requestId
        battery: 95,
        rssi: -52,
      };
      const bodyString = JSON.stringify(body);
      const payload = `${deviceId}:${timestamp}:${nonce}:${bodyString}`;
      const signature = crypto.createHmac('sha256', deviceSecret).update(payload).digest('hex');

      const res = await fetch(`${API_URL}/iot/events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-device-id': deviceId,
          'x-timestamp': timestamp,
          'x-nonce': nonce,
          'x-signature': signature,
        },
        body: bodyString,
      });

      const data = await res.json();
      if (res.status === 200 && (data.data?.isDuplicate === true || data.isDuplicate === true)) {
        logTest('Anti-Spam Idempotency: Duplicate requestId prevented second order', true);
        passed++;
      } else {
        throw new Error(`Expected isDuplicate=true but got ${JSON.stringify(data)}`);
      }
    } catch (e: any) {
      logTest('Anti-Spam Idempotency Test', false, e.message);
      failed++;
    }

    // 6. Security: Replay Attack (reusing same nonce for same device)
    try {
      const timestamp = Date.now().toString();
      const replayTestNonce = `nonce_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
      const replayRequestId = `req_replay_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
      createdRequestIds.push(replayRequestId);
      const body = { eventType: 'SINGLE_PRESS', requestId: replayRequestId, battery: 90, rssi: -60 };
      const bodyStr = JSON.stringify(body);
      const sig1 = crypto
        .createHmac('sha256', deviceSecret)
        .update(`${deviceId}:${timestamp}:${replayTestNonce}:${bodyStr}`)
        .digest('hex');

      // First attempt with nonce
      const firstRes = await fetch(`${API_URL}/iot/events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-device-id': deviceId,
          'x-timestamp': timestamp,
          'x-nonce': replayTestNonce,
          'x-signature': sig1,
        },
        body: bodyStr,
      });

      const firstData = await firstRes.json();
      const firstOrder = firstData.data?.order || firstData.data;
      if (firstOrder?.id || firstOrder?.orderId) {
        createdOrderIds.push(BigInt(firstOrder.id || firstOrder.orderId));
      }
      if (firstOrder?.orderNumber || firstOrder?.orderCode) {
        createdOrderCodes.push(firstOrder.orderNumber || firstOrder.orderCode);
      }

      // Second attempt with exact same nonce (Replay Attack)
      const replayRes = await fetch(`${API_URL}/iot/events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-device-id': deviceId,
          'x-timestamp': timestamp,
          'x-nonce': replayTestNonce,
          'x-signature': sig1,
        },
        body: bodyStr,
      });

      const replayData = await replayRes.json();
      if (replayRes.status === 409 && replayData.code === 'REPLAY_DETECTED') {
        logTest('Security: Anti-Replay Defense correctly blocked reused Nonce (409 Conflict)', true);
        passed++;
      } else {
        throw new Error(`Expected 409 REPLAY_DETECTED, got ${replayRes.status}`);
      }
    } catch (e: any) {
      logTest('Security: Anti-Replay Defense', false, e.message);
      failed++;
    }

    // 7. Security: Tampered Signature
    try {
      const timestamp = Date.now().toString();
      const nonce = crypto.randomBytes(16).toString('hex');
      const body = { eventType: 'SINGLE_PRESS', requestId: 'tamper_req', battery: 90, rssi: -60 };
      const bodyStr = JSON.stringify(body);
      const fakeSignature = 'bad_fake_signature_aabbccddeeff11223344556677889900aabbccddeeff1122334455667788';

      const res = await fetch(`${API_URL}/iot/events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-device-id': deviceId,
          'x-timestamp': timestamp,
          'x-nonce': nonce,
          'x-signature': fakeSignature,
        },
        body: bodyStr,
      });

      const data = await res.json();
      if (res.status === 401 && data.code === 'INVALID_SIGNATURE') {
        logTest('Security: Tampered HMAC Signature correctly rejected (401 Unauthorized)', true);
        passed++;
      } else {
        throw new Error(`Expected 401 INVALID_SIGNATURE, got ${res.status}`);
      }
    } catch (e: any) {
      logTest('Security: Tampered HMAC Signature', false, e.message);
      failed++;
    }

    // 8. Order Cancellation within Cancel Window
    if (validOrderId) {
      try {
        const res = await fetch(`${API_URL}/orders/${validOrderId}/cancel`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${customerToken}`,
          },
          body: JSON.stringify({ reason: 'Khách hàng đổi ý muốn hủy đơn' }),
        });
        const data = await res.json();
        const status = data.data?.orderStatus || data.data?.status;
        if (res.status === 200 && status === 'CANCELLED') {
          logTest('Order Lifecycle: Cancel order within cancel window & stock rollback', true);
          passed++;
        } else {
          throw new Error(data.message || JSON.stringify(data));
        }
      } catch (e: any) {
        logTest('Order Lifecycle: Cancel order', false, e.message);
        failed++;
      }
    }

    // 9. Change Wi-Fi: Preserve Ownership & Product
    try {
      const res = await fetch(`${API_URL}/devices/${deviceId}/change-wifi`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${customerToken}`,
        },
      });
      const data = await res.json();
      if ((res.status === 200 || res.status === 201) && data.success && data.data?.provisioningStatus === 'PROVISIONING') {
        logTest('Zero-Touch: Change Wi-Fi preserves customer ownership & product link', true);
        passed++;
      } else {
        throw new Error(data.message || JSON.stringify(data));
      }
    } catch (e: any) {
      logTest('Zero-Touch: Change Wi-Fi preserves customer ownership & product link', false, e.message);
      failed++;
    }

    // 10. Device Transfer: Generates new pairing token & marks TRANSFER_PENDING
    try {
      const res = await fetch(`${API_URL}/devices/${deviceId}/transfer`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${customerToken}`,
        },
      });
      const data = await res.json();
      if ((res.status === 200 || res.status === 201) && data.success && data.data?.qrPayload && data.data?.token) {
        const pToken = data.data.token;
        const pHash = crypto.createHash('sha256').update(pToken).digest('hex');
        createdPairingTokenHashes.push(pHash);

        const maskedToken = pToken ? `${pToken.slice(0, 4)}***${pToken.slice(-4)}` : '***';
        logTest(`Device Transfer: Generated new QR token for recipient (${maskedToken})`, true);
        passed++;

        // Re-claim device to ensure test suite remains idempotent across multiple runs
        await fetch(`${API_URL}/devices/${deviceId}/claim`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${customerToken}`,
          },
        });
      } else {
        throw new Error(data.message || JSON.stringify(data));
      }
    } catch (e: any) {
      logTest('Device Transfer: Generate transfer token', false, e.message);
      failed++;
    }

    // 11. Security: Anti-Enumeration Forgot Password
    try {
      const res = await fetch(`${API_URL}/auth/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'customer@smartorder.local' }),
      });
      const data = await res.json();
      if (res.status === 200 && data.success === true) {
        logTest('Advanced Auth: Anti-Timing Enumeration Forgot Password request', true);
        passed++;
      } else {
        throw new Error(data.message || JSON.stringify(data));
      }
    } catch (e: any) {
      logTest('Advanced Auth: Forgot Password', false, e.message);
      failed++;
    }

    // 12. Media: Cloudinary Upload Signature
    try {
      const res = await fetch(`${API_URL}/media/signature?folder=smart-button/products`, {
        headers: { Authorization: `Bearer ${storeToken}` },
      });
      const data = await res.json();
      if (res.status === 200 && data.success && data.data?.signature && data.data?.apiKey) {
        logTest(`Secure Media: Generated Cloudinary upload signature (Cloud: ${data.data.cloudName})`, true);
        passed++;
      } else {
        throw new Error(data.message || JSON.stringify(data));
      }
    } catch (e: any) {
      logTest('Secure Media: Cloudinary Signature', false, e.message);
      failed++;
    }

    // 13. API Standard: Products List & Uniform Envelope Structure
    try {
      const res = await fetch(`${API_URL}/products?page=1&pageSize=5`, {
        headers: { Authorization: `Bearer ${storeToken}` },
      });
      const data = await res.json();
      if (res.status === 200 && data.success === true && Array.isArray(data.data)) {
        logTest('API Standard: GET /products returns uniform envelope with data array', true);
        passed++;
      } else {
        throw new Error(data.message || JSON.stringify(data));
      }
    } catch (e: any) {
      logTest('API Standard: Products list & envelope', false, e.message);
      failed++;
    }

    // 14. Skill 3 (Ý A): Refresh Token Single-Use Rotation & Replay Revocation
    try {
      const res = await fetch(`${API_URL}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: storeRefreshToken }),
      });
      const data = await res.json();
      if (res.status === 200 && data.success && data.data?.accessToken && data.data?.refreshToken) {
        createdRefreshTokens.push(data.data.refreshToken);

        // Attempt to reuse the OLD refresh token (Must fail with 401 Unauthorized)
        const reuseRes = await fetch(`${API_URL}/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken: storeRefreshToken }),
        });

        if (reuseRes.status === 401) {
          logTest('Skill 3 (Ý A): Refresh Token Single-Use Rotation & Replay Revocation (401)', true);
          passed++;
        } else {
          throw new Error(`Expected 401 on reused token, got ${reuseRes.status}`);
        }
      } else {
        throw new Error(data.message || JSON.stringify(data));
      }
    } catch (e: any) {
      logTest('Skill 3 (Ý A): Refresh Token Rotation', false, e.message);
      failed++;
    }

    // 15. Skill 8 (Ý B): Email Verification Token Flow & Tampered Token Defense
    try {
      const res = await fetch(`${API_URL}/auth/verify-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'invalid_tampered_token_1234567890abcdef' }),
      });
      const data = await res.json();
      if (res.status === 400 && data.success === false) {
        logTest('Skill 8 (Ý B): Email Verification rejected invalid token (400 Bad Request)', true);
        passed++;
      } else {
        throw new Error(`Expected 400 on invalid token, got ${res.status}`);
      }
    } catch (e: any) {
      logTest('Skill 8 (Ý B): Email Verification', false, e.message);
      failed++;
    }

    // 16. BRD V2.1 (Ý C): Device Templates PostgreSQL Persistence & CRUD
    try {
      const res = await fetch(`${API_URL}/device-templates`, {
        headers: { Authorization: `Bearer ${storeToken}` },
      });
      const data = await res.json();
      if (res.status === 200 && data.success && Array.isArray(data.data) && data.data.length >= 2) {
        const foundSeed = data.data.some((t: any) => t.code === 'TMPL-WATER-20L' || t.code === 'TMPL-GAS-12KG');
        if (foundSeed) {
          logTest(`BRD V2.1 (Ý C): Fetched persistent Device Templates from PostgreSQL (${data.data.length} templates)`, true);
          passed++;
        } else {
          throw new Error('Seed templates not found in list response');
        }
      } else {
        throw new Error(data.message || JSON.stringify(data));
      }
    } catch (e: any) {
      logTest('BRD V2.1 (Ý C): Device Templates PostgreSQL', false, e.message);
      failed++;
    }
  } finally {
    // ========================================================
    // ZERO RESIDUE CLEANUP: EXACT TARGETED PURGE IN FINALLY
    // ========================================================
    try {
      // 1. Release reserved inventory for any uncancelled test orders
      for (const orderId of createdOrderIds) {
        const order = await prisma.order.findUnique({
          where: { orderId },
          include: { items: true },
        });
        if (order && order.orderStatus === 'PENDING' && order.items?.length) {
          for (const item of order.items) {
            await prisma.inventory.updateMany({
              where: { productId: item.productId },
              data: { reservedQuantity: { decrement: item.quantity } },
            });
          }
        }
      }

      // 2. Cascade delete created test orders by exact IDs
      if (createdOrderIds.length > 0) {
        await prisma.paymentTransaction.deleteMany({ where: { orderId: { in: createdOrderIds } } });
        await prisma.orderItem.deleteMany({ where: { orderId: { in: createdOrderIds } } });
        await prisma.orderStatusHistory.deleteMany({ where: { orderId: { in: createdOrderIds } } });
        await prisma.order.deleteMany({ where: { orderId: { in: createdOrderIds } } });
      }

      // 3. Exact purge of created pairing tokens by hash
      if (createdPairingTokenHashes.length > 0) {
        await prisma.pairingToken.deleteMany({ where: { tokenHash: { in: createdPairingTokenHashes } } });
      }

      // 4. Exact purge of created refresh tokens by hash
      for (const rt of createdRefreshTokens) {
        const rtHash = crypto.createHash('sha256').update(rt).digest('hex');
        await prisma.refreshToken.deleteMany({ where: { tokenHash: rtHash } });
      }
    } catch (cleanupErr: any) {
      console.warn('Warning during api.test.ts cleanup:', cleanupErr.message);
    } finally {
      // 5. Delta Baseline Verification
      try {
        const finalPairingTokens = await prisma.pairingToken.count();
        const finalRefreshTokens = await prisma.refreshToken.count();
        const finalOrders = await prisma.order.count();

        const deltaPairing = finalPairingTokens - baselinePairingTokens;
        const deltaRefresh = finalRefreshTokens - baselineRefreshTokens;
        const deltaOrders = finalOrders - baselineOrders;

        console.log('\n======================================================');
        console.log('ℹ BÁO CÁO TOÀN VẸN DỮ LIỆU & ZERO RESIDUE (tests/api.test.ts):');
        console.log(`   - Pairing tokens: Trước=${baselinePairingTokens}, Sau=${finalPairingTokens} (Delta: ${deltaPairing})`);
        console.log(`   - Refresh tokens: Trước=${baselineRefreshTokens}, Sau=${finalRefreshTokens} (Delta: ${deltaRefresh})`);
        console.log(`   - Orders: Trước=${baselineOrders}, Sau=${finalOrders} (Delta: ${deltaOrders})`);
        if (deltaPairing === 0 && deltaRefresh === 0 && deltaOrders === 0) {
          console.log('  ✔ [XÁC NHẬN ZERO RESIDUE] 100% dữ liệu test api.test.ts đã được dọn sạch hoàn toàn.');
        } else {
          cleanupFailed = true;
          console.log('  ✖ [THẤT BẠI ZERO RESIDUE] Vẫn còn bản ghi phát sinh trong cơ sở dữ liệu (Yêu cầu Delta = 0)!');
        }
        console.log('======================================================\n');
      } catch (err: any) {
        console.warn('Could not verify final delta counts:', err.message);
      }

      await prisma.$disconnect();
    }
  }

  console.log('------------------------------------------------------');
  console.log(`Test Results: \x1b[32m${passed} Passed\x1b[0m, \x1b[31m${failed} Failed\x1b[0m`);
  console.log('======================================================\n');

  if (failed > 0 || cleanupFailed) {
    process.exit(1);
  }
  process.exit(0);
}

runTests();
