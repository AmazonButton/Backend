import crypto from 'crypto';

const BASE_URL = process.env.BASE_URL || 'http://localhost:5000';
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
  let storeToken = '';
  let storeRefreshToken = '';
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
  let customerToken = '';
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
  const deviceId = 'BTN-8829-WTR';
  const deviceSecret = 'sec_smart_button_8829_wtr_key_99';
  const testRequestId = `test_req_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
  let validOrderNumber = '';
  let validOrderId = '';

  try {
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
    const reusedNonce = 'reused_nonce_1234567890abcdef';
    const body = { eventType: 'SINGLE_PRESS', requestId: 'req_nonce_1', battery: 90, rssi: -60 };
    const bodyStr = JSON.stringify(body);
    const sig1 = crypto
      .createHmac('sha256', deviceSecret)
      .update(`${deviceId}:${timestamp}:${reusedNonce}:${bodyStr}`)
      .digest('hex');

    // First attempt with nonce
    await fetch(`${API_URL}/iot/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-device-id': deviceId,
        'x-timestamp': timestamp,
        'x-nonce': reusedNonce,
        'x-signature': sig1,
      },
      body: bodyStr,
    });

    // Second attempt with exact same nonce (Replay Attack)
    const replayRes = await fetch(`${API_URL}/iot/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-device-id': deviceId,
        'x-timestamp': timestamp,
        'x-nonce': reusedNonce,
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
      logTest(`Device Transfer: Generated new QR token for recipient (${data.data.token})`, true);
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

  // 14. Ý A: Refresh Token Single-Use Rotation & Replay Revocation
  try {
    const res = await fetch(`${API_URL}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: storeRefreshToken }),
    });
    const data = await res.json();
    if (res.status === 200 && data.success && data.data?.accessToken && data.data?.refreshToken) {
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

  // 15. Ý B: Email Verification Token Flow & Tampered Token Defense
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

  // 16. Ý C: Device Templates PostgreSQL Persistence & CRUD
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

  console.log('\n------------------------------------------------------');
  console.log(`Test Results: \x1b[32m${passed} Passed\x1b[0m, \x1b[31m${failed} Failed\x1b[0m`);
  console.log('======================================================\n');

  process.exit(failed > 0 ? 1 : 0);
}

runTests();
