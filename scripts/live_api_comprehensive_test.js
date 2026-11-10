const https = require('https');
const http = require('http');

const TARGET_HOST = process.env.API_HOST || 'https://backend-fae8.onrender.com';

function request(options, body = null) {
  return new Promise((resolve) => {
    const isHttps = TARGET_HOST.startsWith('https');
    const client = isHttps ? https : http;
    const u = new URL(options.path, TARGET_HOST);

    const reqOptions = {
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      method: options.method || 'GET',
      headers: {
        'Accept': 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers,
      },
      timeout: 15000,
    };

    const req = client.request(reqOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(data);
        } catch (e) {
          json = null;
        }
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          data: json,
          raw: data,
        });
      });
    });

    req.on('error', (err) => resolve({ error: err.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ error: 'Request timeout' });
    });

    if (body) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

const results = [];

function recordTest(name, category, passed, details) {
  results.push({ name, category, passed, details });
  const icon = passed ? '✅' : '❌';
  console.log(`${icon} [${category}] ${name}: ${details}`);
}

async function runComprehensiveTests() {
  console.log(`\n🚀 Starting Comprehensive Live API Verification against: ${TARGET_HOST}\n`);

  // =========================================================================
  // CATEGORY 1: INFRASTRUCTURE & HEALTH PROBES (Public)
  // =========================================================================
  {
    const res = await request({ path: '/healthz' });
    const passed = res.statusCode === 200 && res.data?.status === 'UP';
    recordTest('GET /healthz Liveness Probe', 'INFRASTRUCTURE', passed, `HTTP ${res.statusCode}, status=${res.data?.status}`);
  }

  {
    const res = await request({ path: '/readyz' });
    const passed = res.statusCode === 200 && res.data?.status === 'READY';
    recordTest('GET /readyz Readiness Probe', 'INFRASTRUCTURE', passed, `HTTP ${res.statusCode}, DB=${res.data?.checks?.database}, Queue=${res.data?.checks?.queue}`);
  }

  {
    const res = await request({ path: '/api/v1/banks' });
    const passed = res.statusCode === 200 && res.data?.success === true && Array.isArray(res.data?.data) && res.data.data.length > 0;
    recordTest('GET /api/v1/banks Vietnam Banks Catalog', 'PUBLIC_CATALOG', passed, `HTTP ${res.statusCode}, returned ${res.data?.data?.length || 0} banks`);
  }

  {
    const res = await request({ path: '/api/v1/rentals/packages' });
    const passed = res.statusCode === 200 && res.data?.success === true && Array.isArray(res.data?.data);
    recordTest('GET /api/v1/rentals/packages Rental Packages', 'PUBLIC_CATALOG', passed, `HTTP ${res.statusCode}, returned ${res.data?.data?.length || 0} packages`);
  }

  {
    const res = await request({ path: '/api/v1/stores' });
    const passed = res.statusCode === 200 && res.data?.success === true;
    recordTest('GET /api/v1/stores Public Store Directory', 'PUBLIC_CATALOG', passed, `HTTP ${res.statusCode}, total=${res.data?.pagination?.total || res.data?.data?.length || 0}`);
  }

  // =========================================================================
  // CATEGORY 2: AUTHENTICATION & SESSION LIFECYCLE
  // =========================================================================
  let adminToken = null;
  let storeToken = null;
  let customerToken = null;

  // 2.1 Admin Login
  {
    const res = await request(
      { path: '/api/v1/auth/login', method: 'POST' },
      { email: 'admin@smartorder.local', password: 'Password123!' }
    );
    const passed = res.statusCode === 200 && res.data?.success === true && res.data?.data?.user?.role === 'SUPER_ADMIN' && !!res.data?.data?.accessToken;
    if (passed) adminToken = res.data.data.accessToken;
    recordTest('POST /api/v1/auth/login as SUPER_ADMIN', 'AUTH', passed, `HTTP ${res.statusCode}, role=${res.data?.data?.user?.role}, token=${!!adminToken}`);
  }

  // 2.2 Store Owner Login
  {
    const res = await request(
      { path: '/api/v1/auth/login', method: 'POST' },
      { email: 'store@smartorder.local', password: 'Password123!' }
    );
    const passed = res.statusCode === 200 && res.data?.success === true && res.data?.data?.user?.role === 'STORE_OWNER' && !!res.data?.data?.accessToken;
    if (passed) storeToken = res.data.data.accessToken;
    recordTest('POST /api/v1/auth/login as STORE_OWNER', 'AUTH', passed, `HTTP ${res.statusCode}, role=${res.data?.data?.user?.role}, token=${!!storeToken}`);
  }

  // 2.3 Customer Login
  {
    const res = await request(
      { path: '/api/v1/auth/login', method: 'POST' },
      { email: 'customer@smartorder.local', password: 'Password123!' }
    );
    const passed = res.statusCode === 200 && res.data?.success === true && res.data?.data?.user?.role === 'CUSTOMER' && !!res.data?.data?.accessToken;
    if (passed) customerToken = res.data.data.accessToken;
    recordTest('POST /api/v1/auth/login as CUSTOMER', 'AUTH', passed, `HTTP ${res.statusCode}, role=${res.data?.data?.user?.role}, token=${!!customerToken}`);
  }

  // 2.4 Invalid Credentials Rejection
  {
    const res = await request(
      { path: '/api/v1/auth/login', method: 'POST' },
      { email: 'admin@smartorder.local', password: 'WrongPassword!' }
    );
    const passed = res.statusCode === 401 && res.data?.success === false;
    recordTest('POST /api/v1/auth/login Invalid Credentials Rejection', 'AUTH', passed, `HTTP ${res.statusCode}, message="${res.data?.message}"`);
  }

  // 2.5 Profile with Token (GET /api/v1/auth/me)
  {
    const res = await request({
      path: '/api/v1/auth/me',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const passed = res.statusCode === 200 && res.data?.success === true && res.data?.data?.email === 'admin@smartorder.local';
    recordTest('GET /api/v1/auth/me Authenticated Session', 'AUTH', passed, `HTTP ${res.statusCode}, email=${res.data?.data?.email}`);
  }

  // 2.6 Unauthenticated Protected Route Rejection
  {
    const res = await request({ path: '/api/v1/auth/me' });
    const passed = res.statusCode === 401;
    recordTest('GET /api/v1/auth/me Missing Token Guard', 'AUTH', passed, `HTTP ${res.statusCode} (Properly guarded)`);
  }

  // =========================================================================
  // CATEGORY 3: ROLE-BASED ACCESS CONTROL (RBAC)
  // =========================================================================
  // 3.1 Customer accessing Admin Dashboard -> 403 Forbidden
  {
    const res = await request({
      path: '/api/v1/admin/dashboard',
      headers: { Authorization: `Bearer ${customerToken}` },
    });
    const passed = res.statusCode === 403;
    recordTest('RBAC: Customer denied Admin Dashboard', 'RBAC', passed, `HTTP ${res.statusCode} (Expected 403 Forbidden)`);
  }

  // 3.2 Store Owner accessing Admin Dashboard -> 403 Forbidden
  {
    const res = await request({
      path: '/api/v1/admin/dashboard',
      headers: { Authorization: `Bearer ${storeToken}` },
    });
    const passed = res.statusCode === 403;
    recordTest('RBAC: Store Owner denied Admin Dashboard', 'RBAC', passed, `HTTP ${res.statusCode} (Expected 403 Forbidden)`);
  }

  // 3.3 Admin accessing Admin Dashboard -> 200 OK
  {
    const res = await request({
      path: '/api/v1/admin/dashboard',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const passed = res.statusCode === 200 && res.data?.success === true;
    recordTest('RBAC: Admin granted Admin Dashboard', 'RBAC', passed, `HTTP ${res.statusCode}, data keys=${Object.keys(res.data?.data || {}).join(',')}`);
  }

  // 3.4 Admin accessing Admin Stores List -> 200 OK
  {
    const res = await request({
      path: '/api/v1/admin/stores',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const passed = res.statusCode === 200 && res.data?.success === true && Array.isArray(res.data?.data);
    recordTest('RBAC: Admin list all stores', 'ADMIN_PORTAL', passed, `HTTP ${res.statusCode}, count=${res.data?.data?.length || 0}`);
  }

  // =========================================================================
  // CATEGORY 4: STORE TENANT ISOLATION & OPERATIONS
  // =========================================================================
  // 4.1 Store Owner fetching their store profile
  {
    const res = await request({
      path: '/api/v1/stores/me',
      headers: { Authorization: `Bearer ${storeToken}` },
    });
    const passed = res.statusCode === 200 && res.data?.success === true && !!res.data?.data?.name;
    recordTest('GET /api/v1/stores/me Store Profile', 'STORE_PORTAL', passed, `HTTP ${res.statusCode}, storeName="${res.data?.data?.name}"`);
  }

  // 4.2 Store Bank Account Lookup Fail-Closed (VietQR isolated credentials unset)
  {
    const res = await request(
      {
        path: '/api/v1/stores/bank-accounts/lookup',
        method: 'POST',
        headers: { Authorization: `Bearer ${storeToken}` },
      },
      { bankBin: '970422', accountNumber: '123456789' }
    );
    const passed = res.statusCode === 503 && res.data?.success === false;
    recordTest('POST /api/v1/stores/bank-accounts/lookup Fail-Closed Guard', 'BANK_VERIFICATION', passed, `HTTP ${res.statusCode}, message="${res.data?.message}"`);
  }

  // =========================================================================
  // CATEGORY 5: CUSTOMER DOMAIN OPERATIONS
  // =========================================================================
  // 5.1 Customer Dashboard
  {
    const res = await request({
      path: '/api/v1/customers/me/dashboard',
      headers: { Authorization: `Bearer ${customerToken}` },
    });
    const passed = res.statusCode === 200 && res.data?.success === true;
    recordTest('GET /api/v1/customers/me/dashboard Customer Dashboard', 'CUSTOMER_PORTAL', passed, `HTTP ${res.statusCode}`);
  }

  // 5.2 Customer Rentals (Verified Fixed with Migration)
  {
    const res = await request({
      path: '/api/v1/rentals/my-rentals',
      headers: { Authorization: `Bearer ${customerToken}` },
    });
    const passed = res.statusCode === 200 && res.data?.success === true && Array.isArray(res.data?.data);
    recordTest('GET /api/v1/rentals/my-rentals Customer Rentals List', 'CUSTOMER_PORTAL', passed, `HTTP ${res.statusCode}, count=${res.data?.data?.length || 0}`);
  }

  // 5.3 Customer Bank Accounts List
  {
    const res = await request({
      path: '/api/v1/customers/me/bank-accounts',
      headers: { Authorization: `Bearer ${customerToken}` },
    });
    const passed = res.statusCode === 200 && res.data?.success === true && Array.isArray(res.data?.data);
    recordTest('GET /api/v1/customers/me/bank-accounts Customer Bank List', 'CUSTOMER_PORTAL', passed, `HTTP ${res.statusCode}, count=${res.data?.data?.length || 0}`);
  }

  // 5.4 Customer Bank Verification History
  {
    const res = await request({
      path: '/api/v1/customers/me/bank-accounts/verification-history',
      headers: { Authorization: `Bearer ${customerToken}` },
    });
    const passed = res.statusCode === 200 && res.data?.success === true && Array.isArray(res.data?.data);
    recordTest('GET /api/v1/customers/me/bank-accounts/verification-history', 'CUSTOMER_PORTAL', passed, `HTTP ${res.statusCode}, count=${res.data?.data?.length || 0}`);
  }

  // =========================================================================
  // CATEGORY 6: CONTRACT HARDENING & REGRESSION VERIFICATION (ea18b01)
  // =========================================================================
  // 6.1 PayOS Webhook accepts success: true and evaluates HMAC signature
  {
    const res = await request(
      {
        path: '/api/v1/webhooks/payos/customer-bank-verification',
        method: 'POST',
      },
      {
        code: '00',
        desc: 'success',
        success: true,
        data: {
          orderCode: 999999,
          amount: 2000,
          description: 'E2E_PROBE',
          accountNumber: '999',
          reference: 'e2e_ref',
          transactionDateTime: '2026-11-10 12:00:00',
          currency: 'VND',
          paymentLinkId: 'link',
          code: '00',
          desc: 'success',
        },
        signature: 'invalid_hmac_probe',
      }
    );
    const passed = res.statusCode === 400 && res.data?.message === 'Chữ ký webhook không hợp lệ';
    recordTest('POST Webhook: accepts success:true & verifies HMAC signature', 'WEBHOOK_CONTRACT', passed, `HTTP ${res.statusCode}, message="${res.data?.message}"`);
  }

  // 6.2 Simulate Button Press rejects client-supplied shippingFee (Zero manipulation)
  {
    const res = await request(
      {
        path: '/api/v1/orders/simulate-button-press',
        method: 'POST',
        headers: { Authorization: `Bearer ${customerToken}` },
      },
      {
        buttonCode: 'BTN-NONEXISTENT',
        shippingFee: 15000,
      }
    );
    const passed = res.statusCode === 400 && Array.isArray(res.data?.errors) && res.data.errors.some((e) => e.includes('shippingFee'));
    recordTest('POST Simulate Button Press: rejects client shippingFee', 'ORDER_INTEGRITY', passed, `HTTP ${res.statusCode}, errors=${JSON.stringify(res.data?.errors || [])}`);
  }

  // 6.3 IoT Telemetry rejects out-of-bounds battery / missing security headers
  {
    const res = await request(
      {
        path: '/api/v1/iot/telemetry',
        method: 'POST',
      },
      {
        deviceId: '00000000-0000-0000-0000-000000000001',
        battery: 150,
        rssi: -50,
      }
    );
    const passed = res.statusCode === 401 || res.statusCode === 400;
    recordTest('POST IoT Telemetry: Hardware security / DTO boundary protection', 'HARDWARE_SECURITY', passed, `HTTP ${res.statusCode}, message="${res.data?.message}"`);
  }

  // =========================================================================
  // CATEGORY 7: SENSITIVE DATA LEAKAGE AUDIT (Rule 8 & 13)
  // =========================================================================
  {
    const userRes = await request({
      path: '/api/v1/auth/me',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const raw = JSON.stringify(userRes.data || {});
    const leakedPasswordHash = raw.includes('passwordHash') || raw.includes('password_hash');
    const leakedRefreshToken = raw.includes('refreshToken') || raw.includes('refresh_token');
    const passed = !leakedPasswordHash && !leakedRefreshToken;
    recordTest('Response Sanitization: No password_hash or refresh_token', 'DATA_SECURITY', passed, `leakedPasswordHash=${leakedPasswordHash}, leakedRefreshToken=${leakedRefreshToken}`);
  }

  // =========================================================================
  // SUMMARY
  // =========================================================================
  const total = results.length;
  const passedCount = results.filter((r) => r.passed).length;
  const failedCount = total - passedCount;

  console.log('\n=============================================================');
  console.log(`📊 FINAL API TEST SUMMARY: ${passedCount}/${total} PASSED (${failedCount} FAILED)`);
  console.log('=============================================================\n');

  return { total, passedCount, failedCount, results };
}

runComprehensiveTests().then((summary) => {
  if (summary.failedCount > 0) {
    process.exit(1);
  }
  process.exit(0);
});
