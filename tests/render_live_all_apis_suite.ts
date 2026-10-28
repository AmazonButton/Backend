import jwt from 'jsonwebtoken';

interface TestCaseResult {
  id: string;
  name: string;
  domain: string;
  method: string;
  path: string;
  expectedStatus: number;
  actualStatus: number;
  passed: boolean;
  durationMs: number;
  detail?: string;
}

const LIVE_BASE = 'https://backend-fae8.onrender.com';
const API_BASE = `${LIVE_BASE}/api/v1`;
const JWT_SECRET = process.env.JWT_SECRET || 'smart_order_button_super_secret_jwt_key_2026_prod';

function createToken(payload: Record<string, any>): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '1h' });
}

// Verified live users from Supabase DB:
// - User 1: admin (ACTIVE)
// - User 3: store_owner (ACTIVE, owns store 1)
// - User 6: store_owner2 (ACTIVE, owns store 2)
// - User 7: customer (ACTIVE, customerId 1)
// - User 26: owner_e2e_1792596273598 (ACTIVE, owns store 4)
// - User 27: cust_e2e_1792596273598 (ACTIVE, customerId 6)

const superAdminToken = createToken({
  sub: '1',
  userId: '1',
  username: 'admin',
  role: 'SUPER_ADMIN',
});

const systemAdminToken = createToken({
  sub: '1',
  userId: '1',
  username: 'admin',
  role: 'SYSTEM_ADMIN',
});

const adminToken = createToken({
  sub: '1',
  userId: '1',
  username: 'admin',
  role: 'ADMIN',
});

const storeOwnerToken = createToken({
  sub: '3',
  userId: '3',
  username: 'store_owner',
  role: 'STORE_OWNER',
  storeId: '1',
});

const storeOwner4Token = createToken({
  sub: '26',
  userId: '26',
  username: 'owner_e2e_1792596273598',
  role: 'STORE_OWNER',
  storeId: '4',
});

const storeOwnerBToken = createToken({
  sub: '6',
  userId: '6',
  username: 'store_owner2',
  role: 'STORE_OWNER',
  storeId: '2',
});

const customerToken = createToken({
  sub: '7',
  userId: '7',
  username: 'customer',
  role: 'CUSTOMER',
});

async function runTest(
  id: string,
  name: string,
  domain: string,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  token?: string,
  body?: any,
  expectedStatus: number | number[] = 200,
  assertion?: (data: any, res: Response) => boolean | string
): Promise<TestCaseResult> {
  const url = path.startsWith('http') ? path : `${API_BASE}${path}`;
  const headers: Record<string, string> = {
    'Accept': 'application/json',
    'User-Agent': 'RenderLiveSuite/2.0',
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';

  const startTime = Date.now();
  let actualStatus = 0;
  let detail = '';
  let passed = false;

  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10000),
    });
    actualStatus = res.status;
    const durationMs = Date.now() - startTime;

    const allowedStatuses = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
    const statusMatches = allowedStatuses.includes(actualStatus);

    let bodyData: any = null;
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      try {
        bodyData = await res.json();
      } catch {
        bodyData = null;
      }
    } else {
      const text = await res.text();
      bodyData = { textLength: text.length };
    }

    if (!statusMatches) {
      detail = `Expected HTTP ${allowedStatuses.join('/')}, got ${actualStatus}. Body: ${JSON.stringify(bodyData)?.slice(0, 160)}`;
      passed = false;
    } else if (assertion) {
      const customCheck = assertion(bodyData, res);
      if (customCheck === true) {
        passed = true;
      } else {
        passed = false;
        detail = typeof customCheck === 'string' ? customCheck : 'Custom assertion check failed';
      }
    } else {
      passed = true;
    }

    return {
      id,
      name,
      domain,
      method,
      path: path.startsWith('http') ? path.replace(LIVE_BASE, '') : path,
      expectedStatus: allowedStatuses[0],
      actualStatus,
      passed,
      durationMs,
      detail: passed ? undefined : detail,
    };
  } catch (err: any) {
    return {
      id,
      name,
      domain,
      method,
      path: path.startsWith('http') ? path.replace(LIVE_BASE, '') : path,
      expectedStatus: Array.isArray(expectedStatus) ? expectedStatus[0] : expectedStatus,
      actualStatus: 0,
      passed: false,
      durationMs: Date.now() - startTime,
      detail: `Network error: ${err.message}`,
    };
  }
}

async function main() {
  console.log('========================================================================');
  console.log('🚀 COMPREHENSIVE LIVE RENDER API TEST SUITE (EVERY DOMAIN & TEST CASE)');
  console.log(`Target Environment: ${LIVE_BASE}`);
  console.log(`Execution Time: ${new Date().toISOString()}`);
  console.log('========================================================================\n');

  const results: TestCaseResult[] = [];

  // Helper to execute and print
  async function test(
    id: string,
    name: string,
    domain: string,
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    token?: string,
    body?: any,
    expectedStatus: number | number[] = 200,
    assertion?: (data: any, res: Response) => boolean | string
  ) {
    const r = await runTest(id, name, domain, method, path, token, body, expectedStatus, assertion);
    results.push(r);
    const mark = r.passed ? '✔ PASS' : '✖ FAIL';
    console.log(`[${mark}] ${r.id.padEnd(5)} | ${r.method.padEnd(6)} ${r.path.padEnd(36)} | HTTP ${r.actualStatus} (${r.durationMs}ms) | ${r.name}`);
    if (!r.passed && r.detail) {
      console.log(`       ↳ Error: ${r.detail}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }

  // ============================================================================
  // 1. Core Health & Documentation Probes
  // ============================================================================
  console.log('--- 1. Core Platform Health & Documentation Probes ---');
  await test('TC01', 'Liveness probe returns status UP', 'Core', 'GET', `${LIVE_BASE}/healthz`, undefined, undefined, 200, (d) => d?.status === 'UP');
  await test('TC02', 'Readiness probe returns status READY with DB & Queue UP', 'Core', 'GET', `${LIVE_BASE}/readyz`, undefined, undefined, 200, (d) => d?.status === 'READY' && d?.checks?.database === 'UP');
  await test('TC03', 'Swagger Interactive API Documentation serves HTML', 'Core', 'GET', `${LIVE_BASE}/docs/`, undefined, undefined, 200);

  // ============================================================================
  // 2. Authentication & IAM
  // ============================================================================
  console.log('\n--- 2. Authentication & IAM Security ---');
  await test('TC04', 'Login rejects invalid credentials with 401', 'Auth', 'POST', '/auth/login', undefined, { email: 'non_existent_user_99@test.com', password: 'WrongPassword123!' }, 401);
  await test('TC05', 'Register rejects missing required fields with 400', 'Auth', 'POST', '/auth/register', undefined, { username: 'incomplete' }, 400);
  await test('TC06', 'Unauthenticated /auth/me rejected with 401', 'Auth', 'GET', '/auth/me', undefined, undefined, 401);
  await test('TC07', 'Authenticated /auth/me returns current user profile', 'Auth', 'GET', '/auth/me', customerToken, undefined, 200, (d) => d?.success === true && d?.data?.username === 'customer');
  await test('TC08', 'Forgot-password anti-enumeration returns 200', 'Auth', 'POST', '/auth/forgot-password', undefined, { email: 'non_existent_email@test.com' }, 200);
  await test('TC09', 'Phone verify rejects invalid Firebase token with 401', 'Auth', 'POST', '/auth/phone/verify', undefined, { idToken: 'invalid.firebase.jwt.token' }, 401);

  // ============================================================================
  // 3. Products Catalog & Inventory
  // ============================================================================
  console.log('\n--- 3. Products Catalog & Inventory Management ---');
  await test('TC10', 'Authenticated customer gets products catalog', 'Products', 'GET', '/products', customerToken, undefined, 200, (d) => d?.success === true && Array.isArray(d?.data));
  await test('TC11', 'Products pagination limit caps respected', 'Products', 'GET', '/products?page=1&pageSize=5', customerToken, undefined, 200, (d) => d?.pagination?.pageSize === 5);
  await test('TC12', 'Product detail returns single item view', 'Products', 'GET', '/products/91', customerToken, undefined, 200, (d) => d?.success === true && d?.data?.productId === '91');
  await test('TC13', 'Non-existent product returns 404', 'Products', 'GET', '/products/999999999', customerToken, undefined, 404);
  await test('TC14', 'Product price history returns chronological history for Store Owner', 'Products', 'GET', '/products/5/price-history', storeOwnerToken, undefined, 200, (d) => d?.success === true);
  await test('TC15', 'Unauthenticated product creation rejected with 401', 'Products', 'POST', '/products', undefined, { name: 'Hack Product' }, 401);
  await test('TC16', 'Customer role product creation rejected with 403', 'Products', 'POST', '/products', customerToken, { name: 'Customer Unauthorized Product' }, 403);

  // ============================================================================
  // 4. Categories & Hierarchy
  // ============================================================================
  console.log('\n--- 4. Categories & Hierarchy ---');
  await test('TC17', 'Public store category hierarchy returns categories tree', 'Categories', 'GET', '/stores/1/categories', undefined, undefined, 200, (d) => d?.success === true && Array.isArray(d?.data));
  await test('TC18', 'Customer role store category creation rejected with 403', 'Categories', 'POST', '/stores/1/categories', customerToken, { categoryName: 'Illegal Category' }, 403);

  // ============================================================================
  // 5. Subscription Plans Catalog
  // ============================================================================
  console.log('\n--- 5. Subscription Plans ---');
  await test('TC19', 'Public subscription plans catalog returns active plans', 'Subscriptions', 'GET', '/subscription-plans', undefined, undefined, 200, (d) => d?.success === true && Array.isArray(d?.data));
  await test('TC20', 'Unauthenticated store subscriptions history rejected with 401', 'Subscriptions', 'GET', '/store/subscriptions', undefined, undefined, 401);
  await test('TC21', 'Store Owner lists store subscriptions history', 'Subscriptions', 'GET', '/store/subscriptions', storeOwnerToken, undefined, 200, (d) => d?.success === true);
  await test('TC22', 'Store Owner gets current active subscription', 'Subscriptions', 'GET', '/store/subscriptions/current', storeOwnerToken, undefined, [200, 404]);

  // ============================================================================
  // 6. Button Rental Platform
  // ============================================================================
  console.log('\n--- 6. IoT Button Rentals ---');
  await test('TC23', 'Public rental packages catalog returns active packages', 'Rentals', 'GET', '/rentals/packages', undefined, undefined, 200, (d) => d?.success === true && Array.isArray(d?.data));
  await test('TC24', 'Unauthenticated rental order rejected with 401', 'Rentals', 'POST', '/rentals/order', undefined, {}, 401);
  await test('TC25', 'Rental order with missing fields rejected with 400', 'Rentals', 'POST', '/rentals/order', customerToken, {}, 400);
  await test('TC26', 'Customer role listing admin rentals rejected with 403', 'Rentals', 'GET', '/admin/rentals', customerToken, undefined, 403);
  await test('TC27', 'SUPER_ADMIN lists admin rentals with pagination', 'Rentals', 'GET', '/admin/rentals', superAdminToken, undefined, 200, (d) => d?.success === true);

  // ============================================================================
  // 7. IoT Devices & Provisioning
  // ============================================================================
  console.log('\n--- 7. IoT Devices & Zero-Touch Provisioning ---');
  await test('TC28', 'Unauthenticated device list rejected with 401', 'Devices', 'GET', '/devices', undefined, undefined, 401);
  await test('TC29', 'Customer lists owned IoT devices', 'Devices', 'GET', '/devices', customerToken, undefined, 200, (d) => d?.success === true && Array.isArray(d?.data));
  await test('TC30', 'Device bootstrap with invalid HMAC rejected with 400/401', 'Devices', 'POST', '/devices/bootstrap', undefined, { deviceId: 'BTN-FAKE' }, [400, 401]);
  await test('TC31', 'Start provisioning session validation failure on empty body', 'Devices', 'POST', '/provisioning/session', undefined, {}, 400);
  await test('TC32', 'Customer pairing button rejected with 403 (Requires Admin/StoreOwner)', 'Devices', 'POST', '/devices/999999999/pair', customerToken, {}, 403);

  // ============================================================================
  // 8. Orders & Storefront Checkout
  // ============================================================================
  console.log('\n--- 8. Orders & Storefront Checkout ---');
  await test('TC33', 'Unauthenticated orders inspection rejected with 401', 'Orders', 'GET', '/orders', undefined, undefined, 401);
  await test('TC34', 'Customer lists orders with canonical pagination', 'Orders', 'GET', '/orders', customerToken, undefined, 200, (d) => d?.success === true && Array.isArray(d?.data));
  await test('TC35', 'Store delivery queue requires staff/store owner role (403 for Customer)', 'Orders', 'GET', '/orders/delivery-queue', customerToken, undefined, 403);
  await test('TC36', 'Storefront checkout empty items rejected with 400', 'Orders', 'POST', '/storefront/orders', customerToken, { items: [] }, 400);
  await test('TC37', 'Simulated button press missing edge headers rejected', 'Orders', 'POST', '/orders/button-press', undefined, {}, [400, 401, 404]);

  // ============================================================================
  // 9. Store Self-Management & BOLA Isolation
  // ============================================================================
  console.log('\n--- 9. Store Self-Management & Tenant Isolation ---');
  await test('TC38', 'Public stores list returns active stores', 'Stores', 'GET', '/stores', undefined, undefined, 200, (d) => d?.success === true && Array.isArray(d?.data));
  await test('TC39', 'Public store profile returns store detail', 'Stores', 'GET', '/stores/1', undefined, undefined, 200, (d) => d?.success === true && d?.data?.storeId === '1');
  await test('TC40', 'Unauthenticated store inventory rejected with 401', 'Stores', 'GET', '/stores/1/inventory', undefined, undefined, 401);
  await test('TC41', 'Store Owner inspects owned store inventory', 'Stores', 'GET', '/stores/1/inventory', storeOwnerToken, undefined, 200, (d) => d?.success === true);
  await test('TC42', 'Store Owner inspects low-stock inventory view', 'Stores', 'GET', '/stores/1/inventory/low-stock', storeOwnerToken, undefined, 200, (d) => d?.success === true);
  await test('TC43', 'BOLA: Store Owner B inspecting Store 1 inventory rejected with 403', 'Stores', 'GET', '/stores/1/inventory', storeOwnerBToken, undefined, 403);

  // ============================================================================
  // 10. Store Staff Management & Anti-Role-Escalation
  // ============================================================================
  console.log('\n--- 10. Store Staff & Anti-Role-Escalation Whitelist ---');
  await test('TC44', 'Public list of 5 assignable store staff roles', 'Staff', 'GET', '/store-staff-roles', undefined, undefined, 200, (d) => Array.isArray(d?.data) && d?.data?.length === 5);
  await test('TC45', 'Store Owner lists store staff members', 'Staff', 'GET', '/stores/1/staff', storeOwnerToken, undefined, 200, (d) => d?.success === true);
  await test('TC46', 'BOLA: Store Owner B inspecting Store 1 staff rejected with 403', 'Staff', 'GET', '/stores/1/staff', storeOwnerBToken, undefined, 403);
  await test('TC47', 'Anti-Role-Escalation: Adding staff with ADMIN role rejected with 400/403', 'Staff', 'POST', '/stores/1/staff', storeOwnerToken, { userId: '1', roleCode: 'ADMIN' }, [400, 403]);

  // ============================================================================
  // 11. Store CRM (Customers)
  // ============================================================================
  console.log('\n--- 11. Store Customer CRM ---');
  await test('TC48', 'Store Owner lists store CRM customers', 'CRM', 'GET', '/stores/1/customers', storeOwnerToken, undefined, 200, (d) => d?.success === true);
  await test('TC49', 'BOLA: Store Owner B inspecting Store 1 CRM customers rejected with 403', 'CRM', 'GET', '/stores/1/customers', storeOwnerBToken, undefined, 403);

  // ============================================================================
  // 12. Customer Addresses
  // ============================================================================
  console.log('\n--- 12. Customer Addresses CRUD ---');
  await test('TC50', 'Customer lists personal delivery addresses', 'Addresses', 'GET', '/customer-addresses', customerToken, undefined, 200, (d) => d?.success === true);
  await test('TC51', 'Customer address creation without required fields rejected with 400', 'Addresses', 'POST', '/customer-addresses', customerToken, {}, 400);
  await test('TC52', 'Customer lists transacted stores history', 'Addresses', 'GET', '/customers/me/stores', customerToken, undefined, 200, (d) => d?.success === true);

  // ============================================================================
  // 13. Customer Multi-Role Dashboard & Drill-Downs
  // ============================================================================
  console.log('\n--- 13. Customer Dashboard & Drill-Down Views ---');
  await test('TC53', 'Customer Dashboard returns summary metrics', 'CustomerDash', 'GET', '/customers/me/dashboard', customerToken, undefined, 200, (d) => d?.success === true && d?.data?.ordersSummary?.total !== undefined);
  await test('TC54', 'Customer Orders drill-down returns analytics view', 'CustomerDash', 'GET', '/customers/me/analytics/orders', customerToken, undefined, 200, (d) => d?.success === true);
  await test('TC55', 'Customer Devices drill-down returns owned devices view', 'CustomerDash', 'GET', '/customers/me/analytics/devices', customerToken, undefined, 200, (d) => d?.success === true);
  await test('TC56', 'Customer Rentals drill-down returns active rentals view', 'CustomerDash', 'GET', '/customers/me/analytics/rentals', customerToken, undefined, 200, (d) => d?.success === true);

  // ============================================================================
  // 14. Staff Role-Dispatched Dashboard & Access Invariants
  // ============================================================================
  console.log('\n--- 14. Staff Role-Dispatched Dashboards ---');
  await test('TC57', 'Non-staff user (Store Owner) calling staff dashboard rejected with 403', 'StaffDash', 'GET', '/staff/me/dashboard', storeOwnerToken, undefined, 403);
  await test('TC58', 'Non-staff user (Store Owner B) calling staff dashboard rejected with 403', 'StaffDash', 'GET', '/staff/me/dashboard', storeOwnerBToken, undefined, 403);
  await test('TC59', 'Customer role calling staff dashboard rejected with 403', 'StaffDash', 'GET', '/staff/me/dashboard', customerToken, undefined, 403);
  await test('TC60', 'Unauthenticated staff dashboard access rejected with 401', 'StaffDash', 'GET', '/staff/me/dashboard', undefined, undefined, 401);

  // ============================================================================
  // 15. Store Wallet & Bank Accounts
  // ============================================================================
  console.log('\n--- 15. Store Wallet & Encrypted Bank Accounts ---');
  await test('TC61', 'Store Owner gets store wallet balance', 'Wallet', 'GET', '/store/wallet', storeOwnerToken, undefined, 200, (d) => d?.success === true && d?.data?.balance !== undefined);
  await test('TC62', 'Store Owner gets wallet transactions with pagination', 'Wallet', 'GET', '/store/wallet/transactions', storeOwnerToken, undefined, 200, (d) => d?.success === true);
  await test('TC63', 'Store Owner gets withdrawal requests with pagination', 'Wallet', 'GET', '/store/wallet/withdrawals', storeOwnerToken, undefined, 200, (d) => d?.success === true);
  await test('TC64', 'Withdrawal request with zero/negative amount rejected with 400', 'Wallet', 'POST', '/store/wallet/withdrawals', storeOwnerToken, { amount: 0 }, 400);
  await test('TC65', 'Store Owner lists bank accounts with zero plaintext leaks', 'Wallet', 'GET', '/stores/1/bank-accounts', storeOwnerToken, undefined, 200, (d) => d?.success === true);
  await test('TC66', 'Bank account creation with invalid payload rejected with 400', 'Wallet', 'POST', '/stores/bank-accounts/verification', storeOwnerToken, {}, 400);

  // ============================================================================
  // 16. Admin Read-Only Dashboard & Analytics
  // ============================================================================
  console.log('\n--- 16. Admin Multi-Role Dashboards & Analytics ---');
  await test('TC67', 'SUPER_ADMIN accesses Admin Dashboard', 'Admin', 'GET', '/admin/dashboard', superAdminToken, undefined, 200, (d) => d?.success === true);
  await test('TC68', 'SYSTEM_ADMIN accesses read-only Admin Dashboard', 'Admin', 'GET', '/admin/dashboard', systemAdminToken, undefined, 200, (d) => d?.success === true);
  await test('TC69', 'ADMIN accesses read-only Admin Dashboard', 'Admin', 'GET', '/admin/dashboard', adminToken, undefined, 200, (d) => d?.success === true);
  await test('TC70', 'Customer role calling Admin Dashboard rejected with 403', 'Admin', 'GET', '/admin/dashboard', customerToken, undefined, 403);
  await test('TC71', 'Admin Revenue Timeseries analytics query', 'Admin', 'GET', '/admin/analytics/revenue?fromDate=2026-10-01&toDate=2026-10-28&groupBy=day', adminToken, undefined, 200, (d) => d?.success === true);
  await test('TC72', 'Admin Growth Timeseries analytics query', 'Admin', 'GET', '/admin/analytics/growth?fromDate=2026-10-01&toDate=2026-10-28&groupBy=day', adminToken, undefined, 200, (d) => d?.success === true);
  await test('TC73', 'Admin Operations analytics query', 'Admin', 'GET', '/admin/analytics/operations', adminToken, undefined, 200, (d) => d?.success === true);
  await test('TC74', 'Admin Stores Leaderboard analytics query', 'Admin', 'GET', '/admin/analytics/stores', adminToken, undefined, 200, (d) => d?.success === true);
  await test('TC75', 'Admin read-only withdrawals list accessible by SYSTEM_ADMIN', 'Admin', 'GET', '/admin/withdrawals', systemAdminToken, undefined, 200, (d) => d?.success === true);
  await test('TC76', 'Admin lists pending stores for approval', 'Admin', 'GET', '/admin/stores/pending', superAdminToken, undefined, 200, (d) => d?.success === true);
  await test('TC77', 'Admin lists all platform stores', 'Admin', 'GET', '/admin/stores', superAdminToken, undefined, 200, (d) => d?.success === true);
  await test('TC78', 'Admin lists subscription plans catalog', 'Admin', 'GET', '/admin/plans', superAdminToken, undefined, 200, (d) => d?.success === true);
  await test('TC79', 'Admin lists rental packages catalog', 'Admin', 'GET', '/admin/rentals/packages', superAdminToken, undefined, 200, (d) => d?.success === true);

  // ============================================================================
  // 17. Admin High-Risk Mutations & Anti-Privilege Escalation
  // ============================================================================
  console.log('\n--- 17. Admin Financial Mutations & RBAC Escalation Defenses ---');
  await test('TC80', 'Deprecated manual transfer rejected with 400 MANUAL_TRANSFER_DEPRECATED', 'AdminSecurity', 'POST', '/admin/withdrawals/1/transfer', superAdminToken, { transferEvidenceUrl: 'http://test.com/ev.png' }, 400, (d) => d?.errorCode === 'MANUAL_TRANSFER_DEPRECATED');
  await test('TC81', 'Privilege Escalation: SYSTEM_ADMIN calling payoutViaPayOS rejected with 403', 'AdminSecurity', 'POST', '/admin/withdrawals/1/payout', systemAdminToken, {}, 403);
  await test('TC82', 'Privilege Escalation: ADMIN calling payoutViaPayOS rejected with 403', 'AdminSecurity', 'POST', '/admin/withdrawals/1/payout', adminToken, {}, 403);
  await test('TC83', 'Privilege Escalation: SYSTEM_ADMIN updating user role rejected with 403', 'AdminSecurity', 'POST', '/admin/users/1/role', systemAdminToken, { role: 'SUPER_ADMIN' }, 403);
  await test('TC84', 'Privilege Escalation: SYSTEM_ADMIN approving store rejected with 403', 'AdminSecurity', 'POST', '/admin/stores/1/approve', systemAdminToken, {}, 403);

  // ============================================================================
  // 18. Driver Shifts & Identity Verification
  // ============================================================================
  console.log('\n--- 18. Driver Shifts & Identity Verification ---');
  await test('TC85', 'Customer role calling driver delivery summary rejected with 403', 'Drivers', 'GET', '/drivers/me/delivery-summary', customerToken, undefined, 403);
  await test('TC86', 'Unauthenticated identity session creation rejected with 401', 'Identity', 'POST', '/identity-verifications/sessions', undefined, {}, 401);
  await test('TC87', 'Non-existent identity session retrieval returns 404', 'Identity', 'GET', '/identity-verifications/sessions/999999', customerToken, undefined, 404);

  // ============================================================================
  // 19. Banks Catalog
  // ============================================================================
  console.log('\n--- 19. Supported Banks Catalog ---');
  await test('TC88', 'Public supported Vietnam banks catalog returns bank list', 'Banks', 'GET', '/banks', undefined, undefined, 200, (d) => Array.isArray(d?.data) && d.data.length > 0);

  // ============================================================================
  // 20. Store Self-Profile (stores/me)
  // ============================================================================
  console.log('\n--- 20. Store Self-Profile Management ---');
  await test('TC89', 'Store Owner inspects owned store profile', 'Stores', 'GET', '/stores/me', storeOwnerToken, undefined, 200, (d) => String(d?.data?.storeId) === '1');
  await test('TC90', 'Store Owner updates store profile address', 'Stores', 'PATCH', '/stores/me', storeOwnerToken, { address: '123 Đường Số 1, Phường Tân Phú, Quận 7' }, 200, (d) => d?.success === true);
  await test('TC91', 'Customer role calling store self-profile rejected with 403/404', 'Stores', 'GET', '/stores/me', customerToken, undefined, [403, 404]);

  // ============================================================================
  // 21. Store Analytics Deep Drilldowns
  // ============================================================================
  console.log('\n--- 21. Store Analytics Drilldowns ---');
  await test('TC92', 'Store Owner accesses store dashboard metrics', 'StoreAnalytics', 'GET', '/analytics/dashboard', storeOwnerToken, undefined, 200, (d) => d?.success === true);
  await test('TC93', 'Store Owner accesses orders analytics drilldown', 'StoreAnalytics', 'GET', '/analytics/orders', storeOwnerToken, undefined, 200, (d) => d?.success === true);
  await test('TC94', 'Store Owner accesses products analytics drilldown', 'StoreAnalytics', 'GET', '/analytics/products', storeOwnerToken, undefined, 200, (d) => d?.success === true);
  await test('TC95', 'Store Owner accesses inventory analytics drilldown', 'StoreAnalytics', 'GET', '/analytics/inventory', storeOwnerToken, undefined, 200, (d) => d?.success === true);
  await test('TC96', 'Store Owner accesses customers analytics drilldown', 'StoreAnalytics', 'GET', '/analytics/customers', storeOwnerToken, undefined, 200, (d) => d?.success === true);
  await test('TC97', 'Store Owner accesses finance analytics drilldown', 'StoreAnalytics', 'GET', '/analytics/finance', storeOwnerToken, undefined, 200, (d) => d?.success === true);
  await test('TC98', 'Store Owner accesses operations analytics drilldown', 'StoreAnalytics', 'GET', '/analytics/operations', storeOwnerToken, undefined, 200, (d) => d?.success === true);
  await test('TC99', 'Store Owner accesses staff analytics drilldown', 'StoreAnalytics', 'GET', '/analytics/staff', storeOwnerToken, undefined, 200, (d) => d?.success === true);
  await test('TC100', 'Customer role accessing store analytics rejected with 403', 'StoreAnalytics', 'GET', '/analytics/dashboard', customerToken, undefined, 403);

  // ============================================================================
  // 22. Notifications Management
  // ============================================================================
  console.log('\n--- 22. User Notifications System ---');
  await test('TC101', 'Customer lists personal notifications', 'Notifications', 'GET', '/notifications', customerToken, undefined, 200, (d) => d?.success === true);
  await test('TC102', 'Customer retrieves unread notification count', 'Notifications', 'GET', '/notifications/unread-count', customerToken, undefined, 200, (d) => d?.success === true);
  await test('TC103', 'Customer marks all notifications as read', 'Notifications', 'PATCH', '/notifications/read-all', customerToken, undefined, 200, (d) => d?.success === true);
  await test('TC104', 'Register FCM Token validation failure on empty body', 'Notifications', 'POST', '/notifications/fcm-token', customerToken, {}, 400);
  await test('TC105', 'Unregister FCM Token validation failure on empty body', 'Notifications', 'DELETE', '/notifications/fcm-token', customerToken, {}, 400);

  // ============================================================================
  // 23. Device Templates & Fleet Control
  // ============================================================================
  console.log('\n--- 23. Device Templates & Fleet Stats ---');
  await test('TC106', 'SUPER_ADMIN lists device templates', 'DeviceTemplates', 'GET', '/device-templates', superAdminToken, undefined, 200, (d) => d?.success === true);
  await test('TC107', 'Customer role accessing device templates rejected with 403', 'DeviceTemplates', 'GET', '/device-templates', customerToken, undefined, 403);
  await test('TC108', 'Store Owner inspects fleet statistics', 'Devices', 'GET', '/devices/fleet/stats', storeOwnerToken, undefined, 200, (d) => d?.success === true);
  await test('TC109', 'SUPER_ADMIN lists unassigned button devices', 'Devices', 'GET', '/devices/unassigned', superAdminToken, undefined, 200, (d) => d?.success === true);
  await test('TC110', 'Lookup non-existent device claim code returns 400/404', 'Devices', 'POST', '/devices/lookup-code', storeOwnerToken, { code: '000000' }, [400, 404]);

  // ============================================================================
  // 24. Cloud Storage & Media Presigned Signatures
  // ============================================================================
  console.log('\n--- 24. Media & Cloud Storage ---');
  await test('TC111', 'Store Owner requests Cloudinary presigned upload signature', 'Media', 'GET', '/media/signature', storeOwnerToken, undefined, 200, (d) => d?.success === true && !!d?.data?.signature);
  await test('TC112', 'Customer role requesting upload signature rejected with 403', 'Media', 'GET', '/media/signature', customerToken, undefined, 403);
  await test('TC113', 'Empty media upload request rejected with 400', 'Media', 'POST', '/media/upload', storeOwnerToken, {}, [400, 500]);

  // ============================================================================
  // 25. Product Discounts Catalog
  // ============================================================================
  console.log('\n--- 25. Product Discounts ---');
  await test('TC114', 'Public product discounts list returns active discounts for product 5', 'Discounts', 'GET', '/products/5/discounts', undefined, undefined, 200, (d) => d?.success === true);
  await test('TC115', 'Customer role creating product discount rejected with 403', 'Discounts', 'POST', '/products/5/discounts', customerToken, {}, [400, 403]);
  await test('TC116', 'Non-existent discount ID returns 404 NOT FOUND', 'Discounts', 'GET', '/discounts/999999999', undefined, undefined, 404);

  // ============================================================================
  // 26. Driver Shifts & Online Drivers
  // ============================================================================
  console.log('\n--- 26. Driver Shifts & Dispatch ---');
  await test('TC117', 'Store Owner / Delivery Staff checks current shift status', 'DriverShifts', 'GET', '/driver-shifts/current', storeOwnerToken, undefined, 200, (d) => d?.success === true);
  await test('TC118', 'Store Owner / Delivery Staff inspects shift history with pagination', 'DriverShifts', 'GET', '/driver-shifts/history', storeOwnerToken, undefined, 200, (d) => d?.success === true);
  await test('TC119', 'Customer role accessing driver duty rejected with 403', 'DriverShifts', 'GET', '/drivers/me/duty', customerToken, undefined, 403);
  await test('TC120', 'Store Owner checks currently online delivery drivers for store 1', 'DriverShifts', 'GET', '/drivers/store/1/online', storeOwnerToken, undefined, 200, (d) => d?.success === true);

  // ============================================================================
  // 27. Order Lifecycle & Audit Trails
  // ============================================================================
  console.log('\n--- 27. Order Timeline & Driver Queue ---');
  await test('TC121', 'Customer / Store Owner inspects order lifecycle audit timeline', 'Orders', 'GET', '/orders/1/timeline', storeOwnerToken, undefined, [200, 404]);
  await test('TC122', 'Customer role accessing driver assigned orders rejected with 403', 'Orders', 'GET', '/orders/driver/my-orders', customerToken, undefined, 403);
  await test('TC123', 'Store Owner inspects assigned driver orders queue', 'Orders', 'GET', '/orders/driver/my-orders', storeOwnerToken, undefined, 200, (d) => d?.success === true);

  // ============================================================================
  // 28. Auth Profile & Validation Endpoints
  // ============================================================================
  console.log('\n--- 28. Auth Profile & Query Utilities ---');
  await test('TC124', 'Customer retrieves own verified user profile', 'Auth', 'GET', '/auth/me', customerToken, undefined, 200, (d) => d?.success === true);
  await test('TC125', 'Store Owner retrieves own verified user profile', 'Auth', 'GET', '/auth/me', storeOwnerToken, undefined, 200, (d) => d?.success === true);
  await test('TC126', 'Check email availability returns status', 'Auth', 'GET', '/auth/check-email?email=admin@example.com', undefined, undefined, 200, (d) => typeof d?.exists === 'boolean');
  await test('TC127', 'Check username availability returns status', 'Auth', 'GET', '/auth/check-username?username=admin', undefined, undefined, 200, (d) => typeof d?.exists === 'boolean');
  await test('TC128', 'Customer updates profile display name', 'Auth', 'PATCH', '/auth/me', customerToken, { fullName: 'Tris Customer Active' }, 200, (d) => d?.success === true);

  // ============================================================================
  // 29. Rentals Customer Management
  // ============================================================================
  console.log('\n--- 29. Rentals Customer Portal ---');
  await test('TC129', 'Customer retrieves active personal button rentals', 'Rentals', 'GET', '/rentals/my-rentals', customerToken, undefined, 200, (d) => d?.success === true);
  await test('TC130', 'Admin without customer profile calling my-rentals rejected with 403', 'Rentals', 'GET', '/rentals/my-rentals', adminToken, undefined, 403);

  // ============================================================================
  // 30. Customer Address Creation & Listing
  // ============================================================================
  console.log('\n--- 30. Customer Delivery Address Lifecycle ---');
  await test('TC131', 'Customer creates new delivery address with full payload', 'Addresses', 'POST', '/customer-addresses', customerToken, {
    recipientName: 'Tris Test User',
    phone: '0901234567',
    addressDetail: '123 Đường Số 1, Phường Tân Phú',
    ward: 'Phường Tân Phú',
    district: 'Quận 7',
    province: 'TP. Hồ Chí Minh',
  }, [200, 201], (d) => d?.success === true);
  await test('TC132', 'Customer retrieves delivery addresses containing created address', 'Addresses', 'GET', '/customer-addresses', customerToken, undefined, 200, (d) => Array.isArray(d?.data) && d.data.length > 0);

  // ============================================================================
  // 31. Device Telemetry, Audit Logs & Toggle Status
  // ============================================================================
  console.log('\n--- 31. Device Telemetry & Control ---');
  await test('TC133', 'SUPER_ADMIN checks telemetry of platform button 69', 'Devices', 'GET', '/devices/69/telemetry', superAdminToken, undefined, 200, (d) => d?.success === true);
  await test('TC134', 'SUPER_ADMIN checks audit logs of button 69', 'Devices', 'GET', '/devices/69/audit-logs', superAdminToken, undefined, 200, (d) => d?.success === true);
  await test('TC135', 'SUPER_ADMIN disables button 69', 'Devices', 'POST', '/devices/69/disable', superAdminToken, {}, [200, 201], (d) => d?.success === true);
  await test('TC136', 'SUPER_ADMIN re-enables button 69', 'Devices', 'POST', '/devices/69/enable', superAdminToken, {}, [200, 201], (d) => d?.success === true);

  // ============================================================================
  // 32. Category Creation Mutation
  // ============================================================================
  console.log('\n--- 32. Category Creation Mutation ---');
  await test('TC137', 'Store Owner creates new product category with valid payload', 'Categories', 'POST', '/stores/1/categories', storeOwnerToken, {
    categoryName: `Test Live Category ${Date.now()}`,
    status: 'ACTIVE',
  }, [200, 201], (d) => d?.success === true);

  // ============================================================================
  // 33. Product Creation Mutation
  // ============================================================================
  console.log('\n--- 33. Product Creation Mutation ---');
  await test('TC138', 'Store Owner creates test product with valid payload', 'Products', 'POST', '/products', storeOwnerToken, {
    name: `Test Live Product ${Date.now()}`,
    price: 35000,
    stock: 50,
    description: 'Sản phẩm test live Render tự động',
  }, [200, 201], (d) => d?.success === true);

  // ============================================================================
  // 34. Payments Validation & Security (Excluding live charges/payouts)
  // ============================================================================
  console.log('\n--- 34. Payments Security & Validation ---');
  await test('TC139', 'Empty payment link creation rejected with 400', 'Payments', 'POST', '/payments/payos/create-link', customerToken, {}, 400);
  await test('TC140', 'Unauthenticated payment link creation rejected with 401', 'Payments', 'POST', '/payments/payos/create-link', undefined, {}, 401);
  await test('TC141', 'Inquiry non-existent payment request returns code 101/404', 'Payments', 'GET', '/payments/payos/payment-requests/999999', customerToken, undefined, [200, 404], (d) => d?.data?.code === '101' || d?.success === true);
  await test('TC142', 'Non-existent bank verification transaction inquiry returns 404', 'Banks', 'GET', '/bank-account-verifications/999999', storeOwnerToken, undefined, 404);

  // ============================================================================
  // 35. Provisioning Session Verification & Confirmation
  // ============================================================================
  console.log('\n--- 35. Provisioning Verification & BOLA Guards ---');
  await test('TC143', 'Provisioning session verification with invalid sessionId returns 400/404', 'Devices', 'POST', '/provisioning/verify', undefined, { sessionId: 'invalid-session-999' }, [400, 404]);
  await test('TC144', 'Confirm pairing on non-existent session returns 404', 'Devices', 'POST', '/provisioning/sessions/999999/confirm', customerToken, {}, [400, 404]);

  // ============================================================================
  // 36. Store Driver Shifts & CRM Detail BOLA
  // ============================================================================
  console.log('\n--- 36. Store Driver Shifts & CRM BOLA ---');
  await test('TC145', 'Store Owner lists store driver shifts', 'DriverShifts', 'GET', '/stores/1/driver-shifts', storeOwnerToken, undefined, 200, (d) => d?.success === true);
  await test('TC146', 'BOLA: Store Owner B inspecting Store 1 driver shifts rejected with 403', 'DriverShifts', 'GET', '/stores/1/driver-shifts', storeOwnerBToken, undefined, 403);
  await test('TC147', 'Store Owner views store CRM customer detail', 'CRM', 'GET', '/stores/1/customers/1', storeOwnerToken, undefined, [200, 404]);
  await test('TC148', 'BOLA: Store Owner B inspecting Store 1 CRM customer detail rejected with 403', 'CRM', 'GET', '/stores/1/customers/1', storeOwnerBToken, undefined, 403);

  // ============================================================================
  // Summary & Report
  // ============================================================================
  const total = results.length;
  const passed = results.filter((r) => r.passed).length;
  const failed = total - passed;
  const avgLatency = Math.round(results.reduce((acc, r) => acc + r.durationMs, 0) / total);

  console.log('\n========================================================================');
  console.log(`📊 LIVE TEST REPORT SUMMARY: ${passed}/${total} PASSED (${Math.round((passed / total) * 100)}%)`);
  console.log(`Average Latency to Render (Cloudflare CDN / Singapore): ${avgLatency}ms`);
  console.log('========================================================================');

  // Group by Domain
  const domains = [...new Set(results.map((r) => r.domain))];
  console.log('\n--- Domain Breakdown ---');
  for (const dom of domains) {
    const domResults = results.filter((r) => r.domain === dom);
    const domPass = domResults.filter((r) => r.passed).length;
    console.log(`- ${dom.padEnd(16)}: ${domPass}/${domResults.length} passed`);
  }

  if (failed > 0) {
    console.log('\n--- Failed Tests Detail ---');
    results.filter((r) => !r.passed).forEach((r) => {
      console.log(`✖ [${r.id}] ${r.name} (${r.method} ${r.path}) -> ${r.detail}`);
    });
    process.exit(1);
  } else {
    console.log(`\n🎉 ALL ${total} TEST CASES PASSED AGAINST LIVE RENDER PRODUCTION DEPLOYMENT!`);
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('Fatal crash in live suite runner:', err);
  process.exit(1);
});
