import crypto from 'crypto';

const BASE_URL = 'http://localhost:5000';

function logTest(name: string, passed: boolean, detail?: string) {
  if (passed) {
    console.log(`\x1b[32m  ✔ [PASS]\x1b[0m ${name}`);
  } else {
    console.log(`\x1b[31m  ✖ [FAIL]\x1b[0m ${name} - ${detail || ''}`);
  }
}

async function runTests() {
  console.log('\n======================================================');
  console.log('🧪 ZERO-TOUCH DEVICE PROVISIONING & ONBOARDING SUITE');
  console.log('======================================================\n');

  let passed = 0;
  let failed = 0;

  // 1. Auth: Store Owner Login
  let storeToken = '';
  try {
    const res = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'store@smartorder.local',
        password: 'Password123!',
      }),
    });
    const data = await res.json();
    if (res.status === 200 && data.data?.token) {
      storeToken = data.data.token;
      logTest('1. Auth: Store Owner Login', true);
      passed++;
    } else {
      throw new Error(data.message);
    }
  } catch (e: any) {
    logTest('1. Auth: Store Owner Login', false, e.message);
    failed++;
  }

  // 2. Auth: Customer Login
  let customerToken = '';
  let customerProfileId = '';
  try {
    const res = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'customer@smartorder.local',
        password: 'Password123!',
      }),
    });
    const data = await res.json();
    if (res.status === 200 && data.data?.token) {
      customerToken = data.data.token;
      customerProfileId = data.data.user.customerProfileId;
      logTest('2. Auth: Customer Login', true, `Profile: ${customerProfileId}`);
      passed++;
    } else {
      throw new Error(data.message);
    }
  } catch (e: any) {
    logTest('2. Auth: Customer Login', false, e.message);
    failed++;
  }

  // 3. Register New Hardware Device with Pairing Token
  let registeredDevice: any = null;
  const mockDeviceSecret = `sec_zt_${crypto.randomBytes(16).toString('hex')}`;
  try {
    const res = await fetch(`${BASE_URL}/api/devices`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${storeToken}`,
      },
      body: JSON.stringify({
        customName: 'Nút Thông Minh Zero-Touch',
        macAddress: `24:6F:28:${Math.floor(10 + Math.random() * 89)}:${Math.floor(10 + Math.random() * 89)}:88`,
        location: 'Phòng Bếp Gia Đình',
      }),
    });
    const data = await res.json();
    if (res.status === 200 || res.status === 201) {
      registeredDevice = data.data;
      logTest('3. Register Physical Device (Hardware Identity)', true, `ID: ${registeredDevice.deviceId}`);
      passed++;
    } else {
      throw new Error(data.message);
    }
  } catch (e: any) {
    logTest('3. Register Physical Device (Hardware Identity)', false, e.message);
    failed++;
  }

  // 4. Start Provisioning Session via QR Code Payload
  let provisioningSession: any = null;
  try {
    const qrPayload = registeredDevice.qrPayload || `SOBPAIR://setup?device=${registeredDevice.deviceId}&token=${registeredDevice.pairingToken}&v=1`;
    const res = await fetch(`${BASE_URL}/api/provisioning/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ qrPayload }),
    });
    const data = await res.json();
    if (res.status === 200 || res.status === 201) {
      provisioningSession = data.data;
      logTest('4. Create Provisioning Session via QR Payload', true, `Session: ${provisioningSession.sessionId}`);
      passed++;
    } else {
      throw new Error(data.message);
    }
  } catch (e: any) {
    logTest('4. Create Provisioning Session via QR Payload', false, e.message);
    failed++;
  }

  // 5. Verify Session Validity
  try {
    const res = await fetch(`${BASE_URL}/api/provisioning/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: provisioningSession.sessionId }),
    });
    const data = await res.json();
    if ((res.status === 200 || res.status === 201) && data.valid) {
      logTest('5. Verify Active 10-Minute Provisioning Session', true);
      passed++;
    } else {
      throw new Error(data.message || `Status: ${res.status}`);
    }
  } catch (e: any) {
    logTest('5. Verify Active 10-Minute Provisioning Session', false, e.message);
    failed++;
  }

  // 6. Security: Tampered Token Rejection
  try {
    const res = await fetch(`${BASE_URL}/api/provisioning/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceId: registeredDevice.deviceId,
        token: 'INVALID_ATTACKER_TOKEN_9999',
      }),
    });
    const data = await res.json();
    if (res.status === 401) {
      logTest('6. Security: Reject Invalid Pairing Token (401)', true);
      passed++;
    } else {
      throw new Error(`Expected 401, got ${res.status}`);
    }
  } catch (e: any) {
    logTest('6. Security: Reject Invalid Pairing Token (401)', false, e.message);
    failed++;
  }

  // 7. ESP32 Cloud Bootstrap via HMAC-SHA256
  try {
    // Lookup device secret directly from backend db (known for seeded test devices, e.g. BTN-8829-WTR)
    const testDeviceId = 'BTN-8829-WTR';
    const testSecret = 'sec_smart_button_8829_wtr_key_99';

    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = `boot_${crypto.randomBytes(8).toString('hex')}`;
    const body = {
      deviceId: testDeviceId,
      wifiRssi: -48,
      batteryLevel: 92,
      ipAddress: '192.168.1.155',
      uptime: 45,
    };
    const bodyJson = JSON.stringify(body);
    const signature = crypto
      .createHmac('sha256', testSecret)
      .update(`${testDeviceId}:${timestamp}:${nonce}:${bodyJson}`)
      .digest('hex');

    const res = await fetch(`${BASE_URL}/api/devices/bootstrap`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-device-id': testDeviceId,
        'x-timestamp': timestamp,
        'x-nonce': nonce,
        'x-signature': signature,
      },
      body: bodyJson,
    });
    const data = await res.json();
    if (res.status === 200 || res.status === 201) {
      logTest('7. Hardware: ESP32 Outbound Bootstrap via HMAC-SHA256', true, data.message);
      passed++;
    } else {
      throw new Error(data.message);
    }
  } catch (e: any) {
    logTest('7. Hardware: ESP32 Outbound Bootstrap via HMAC-SHA256', false, e.message);
    failed++;
  }

  // 8. Security: Anti-Replay Attack on Bootstrap (Reused Nonce)
  try {
    const testDeviceId = 'BTN-8829-WTR';
    const testSecret = 'sec_smart_button_8829_wtr_key_99';
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = 'FIXED_REPLAY_NONCE_9988';
    const body = { deviceId: testDeviceId, uptime: 10 };
    const bodyJson = JSON.stringify(body);
    const signature = crypto
      .createHmac('sha256', testSecret)
      .update(`${testDeviceId}:${timestamp}:${nonce}:${bodyJson}`)
      .digest('hex');

    // First request
    await fetch(`${BASE_URL}/api/devices/bootstrap`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-device-id': testDeviceId,
        'x-timestamp': timestamp,
        'x-nonce': nonce,
        'x-signature': signature,
      },
      body: bodyJson,
    });

    // Replayed request
    const replayRes = await fetch(`${BASE_URL}/api/devices/bootstrap`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-device-id': testDeviceId,
        'x-timestamp': timestamp,
        'x-nonce': nonce,
        'x-signature': signature,
      },
      body: bodyJson,
    });

    if (replayRes.status === 409) {
      logTest('8. Security: Anti-Replay Defense Blocked Reused Nonce (409)', true);
      passed++;
    } else {
      throw new Error(`Expected 409, got ${replayRes.status}`);
    }
  } catch (e: any) {
    logTest('8. Security: Anti-Replay Defense Blocked Reused Nonce (409)', false, e.message);
    failed++;
  }

  // 9. Customer Claims Device Ownership
  try {
    const res = await fetch(`${BASE_URL}/api/devices/${registeredDevice.deviceId}/claim`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${customerToken}`,
      },
      body: JSON.stringify({}),
    });
    const data = await res.json();
    if (res.status === 200 || res.status === 201) {
      logTest('9. Customer Claims Device Ownership (ACTIVE)', true, data.message);
      passed++;
    } else {
      throw new Error(data.message);
    }
  } catch (e: any) {
    logTest('9. Customer Claims Device Ownership (ACTIVE)', false, e.message);
    failed++;
  }

  // 10. Customer Unclaims Device
  try {
    const res = await fetch(`${BASE_URL}/api/devices/${registeredDevice.deviceId}/unclaim`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${customerToken}`,
      },
    });
    const data = await res.json();
    if (res.status === 200 || res.status === 201) {
      logTest('10. Customer Releases / Unclaims Device', true, data.message);
      passed++;
    } else {
      throw new Error(data.message);
    }
  } catch (e: any) {
    logTest('10. Customer Releases / Unclaims Device', false, e.message);
    failed++;
  }

  // 11. Transfer Device Workflow
  try {
    // First claim again
    await fetch(`${BASE_URL}/api/devices/${registeredDevice.deviceId}/claim`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${customerToken}`,
      },
    });

    // Transfer
    const res = await fetch(`${BASE_URL}/api/devices/${registeredDevice.deviceId}/transfer`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${customerToken}`,
      },
    });
    const data = await res.json();
    if ((res.status === 200 || res.status === 201) && data.data?.qrPayload) {
      logTest('11. Transfer Device (Generates Fresh QR Token)', true, data.data.qrPayload);
      passed++;
    } else {
      throw new Error(data.message);
    }
  } catch (e: any) {
    logTest('11. Transfer Device (Generates Fresh QR Token)', false, e.message);
    failed++;
  }

  // 12. Factory Reset (Keeps Hardware ID & HMAC Key)
  try {
    const res = await fetch(`${BASE_URL}/api/devices/${registeredDevice.deviceId}/factory-reset`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${storeToken}`,
      },
    });
    const data = await res.json();
    if ((res.status === 200 || res.status === 201) && data.data?.status === 'READY_FOR_CUSTOMER') {
      logTest('12. Factory Reset: Clears Wi-Fi & Ownership, Retains Hardware ID', true);
      passed++;
    } else {
      throw new Error(data.message);
    }
  } catch (e: any) {
    logTest('12. Factory Reset: Clears Wi-Fi & Ownership, Retains Hardware ID', false, e.message);
    failed++;
  }

  // 13. Admin Security Hub: Review Recorded Incidents
  try {
    // Admin login
    const adminLoginRes = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'admin@smartorder.local',
        password: 'Password123!',
      }),
    });
    const adminData = await adminLoginRes.json();
    const adminToken = adminData.data.token;

    const res = await fetch(`${BASE_URL}/api/admin/security/devices`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const data = await res.json();
    if (res.status === 200 && Array.isArray(data.data)) {
      logTest('13. Super Admin Security Hub Incidents Stream', true, `${data.data.length} recorded events`);
      passed++;
    } else {
      throw new Error('Could not fetch security incidents');
    }
  } catch (e: any) {
    logTest('13. Super Admin Security Hub Incidents Stream', false, e.message);
    failed++;
  }

  console.log('\n------------------------------------------------------');
  console.log(`TOTAL: ${passed + failed} | PASSED: ${passed} | FAILED: ${failed}`);
  console.log('------------------------------------------------------\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((e) => {
  console.error('Fatal error in tests:', e);
  process.exit(1);
});
