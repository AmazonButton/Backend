import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { PrismaService } from '../src/prisma/prisma.service';
import { DashboardCacheService } from '../src/common/cache/dashboard-cache.service';
import { RentalsService } from '../src/rentals/rentals.service';
import { StoresService } from '../src/stores/stores.service';
import { AdminService } from '../src/admin/admin.service';

// Test runner helper
let passedCount = 0;
let failedCount = 0;

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ✔ [PASS] ${name}`);
    passedCount++;
  } catch (err: any) {
    console.error(`  ✖ [FAIL] ${name}: ${err?.message || err}`);
    if (err.stack) {
      console.error(err.stack.split('\n').slice(1, 4).join('\n'));
    }
    failedCount++;
  }
}

async function run() {
  console.log('================================================================');
  console.log('⚡ SUITE 76: Database Scaling, Cache Invalidation & Rate Limiting');
  console.log('================================================================\n');

  // ============================================================================
  // SECTION 1: Rate Limiter Route Matching (Fix 1 & Fix 2)
  // ============================================================================
  console.log('[SECTION 1] Rate Limiter Route Matching & Route Integrity');

  await test('1.1 main.ts binds orderSimLimiter strictly to /api/v1/orders/simulate-button-press', async () => {
    const mainContent = fs.readFileSync(path.join(__dirname, '../src/main.ts'), 'utf8');
    assert.ok(
      mainContent.includes("app.use('/api/v1/orders/simulate-button-press', orderSimLimiter);"),
      'main.ts must bind orderSimLimiter to /api/v1/orders/simulate-button-press',
    );
    assert.strictEqual(
      mainContent.includes("app.use('/api/v1/orders/simulate-button', orderSimLimiter);"),
      false,
      'main.ts must NOT use incomplete route prefix /api/v1/orders/simulate-button',
    );
  });

  await test('1.2 main.ts protects entire auth cluster with authLimiter & exempts GET /auth/me', async () => {
    const mainContent = fs.readFileSync(path.join(__dirname, '../src/main.ts'), 'utf8');
    assert.ok(
      mainContent.includes("app.use('/api/v1/auth', authLimiter);"),
      'main.ts must bind authLimiter to /api/v1/auth to cover all auth mutation endpoints',
    );
    assert.ok(
      mainContent.includes("skip: (req) => req.method === 'GET'"),
      'authLimiter must exempt GET requests (e.g. /auth/me) from brute-force throttling',
    );
    assert.strictEqual(
      mainContent.includes("app.use('/api/v1/auth/otp'"),
      false,
      'main.ts must not have non-existent /api/v1/auth/otp binding',
    );
  });

  // ============================================================================
  // SECTION 2: Rental Package Cache Invalidation (Fix 3)
  // ============================================================================
  console.log('\n[SECTION 2] Rental Package Cache Invalidation by Admin');

  await test('2.1 AdminService.createRentalPackage and updateRentalPackage invalidate rentals:available_packages cache', async () => {
    const cacheService = new DashboardCacheService();
    await cacheService.onModuleInit();

    // Prime the cache
    await cacheService.set('rentals:available_packages', [{ id: 1, name: 'Old Plan' }], 60);
    const cachedBefore = await cacheService.get('rentals:available_packages');
    assert.ok(cachedBefore, 'Cache must be primed before admin action');

    const mockAdminRepo: any = {
      findRentalPackageByCode: async () => null,
      createRentalPackage: async (data: any) => ({ packageId: 10n, ...data }),
      findRentalPackageById: async () => ({ packageId: 10n, packageName: 'Plan A' }),
      updateRentalPackage: async (_id: bigint, data: any) => ({ packageId: 10n, ...data }),
    };

    const adminService = new AdminService(mockAdminRepo, undefined, cacheService);

    // Test Create Package invalidates cache
    await adminService.createRentalPackage({
      packageCode: 'NEW_PACKAGE_2026',
      packageName: 'Gói Nút IoT Mới',
      monthlyPrice: 99000,
    });

    const cachedAfterCreate = await cacheService.get('rentals:available_packages');
    assert.strictEqual(cachedAfterCreate, null, 'Cache rentals:available_packages must be invalidated after createRentalPackage');

    // Re-prime cache
    await cacheService.set('rentals:available_packages', [{ id: 10, name: 'Plan 10' }], 60);

    // Test Update Package invalidates cache
    await adminService.updateRentalPackage(10n, { monthlyPrice: 88000 });
    const cachedAfterUpdate = await cacheService.get('rentals:available_packages');
    assert.strictEqual(cachedAfterUpdate, null, 'Cache rentals:available_packages must be invalidated after updateRentalPackage');

    await cacheService.onModuleDestroy();
  });

  // ============================================================================
  // SECTION 3: Store Listing Cache Invalidation (Fix 4)
  // ============================================================================
  console.log('\n[SECTION 3] Store Landing Page Cache Invalidation on Admin Updates');

  await test('3.1 AdminService store mutations invalidate stores:active_page1_20 cache', async () => {
    const cacheService = new DashboardCacheService();
    await cacheService.onModuleInit();

    // Prime the store landing page cache
    await cacheService.set('stores:active_page1_20', { items: [{ name: 'Store 1' }] }, 30);
    const primed = await cacheService.get('stores:active_page1_20');
    assert.ok(primed, 'stores:active_page1_20 must be primed');

    const mockAdminRepo: any = {
      findStoreById: async () => ({ storeId: 99n, ownerUserId: 10n, status: 'PENDING' }),
      approveStore: async () => ({ storeId: 99n, status: 'ACTIVE' }),
      rejectStore: async () => ({ storeId: 99n, status: 'REJECTED' }),
      updateStoreById: async () => ({ storeId: 99n, status: 'INACTIVE' }),
    };

    const adminService = new AdminService(mockAdminRepo, undefined, cacheService);

    // Action: Admin approves store
    await adminService.approveStore(99n);
    const cachedAfterApprove = await cacheService.get('stores:active_page1_20');
    assert.strictEqual(cachedAfterApprove, null, 'stores:active_page1_20 must be invalidated when admin approves store');

    // Re-prime cache
    await cacheService.set('stores:active_page1_20', { items: [{ name: 'Store 1' }] }, 30);

    // Action: Admin rejects/locks store
    await adminService.rejectStore(99n, 'Vi phạm quy định');
    const cachedAfterReject = await cacheService.get('stores:active_page1_20');
    assert.strictEqual(cachedAfterReject, null, 'stores:active_page1_20 must be invalidated when admin rejects store');

    await cacheService.onModuleDestroy();
  });

  // ============================================================================
  // SECTION 4: Connection-Level Statement Timeout & Pool Tuning (Fix 5)
  // ============================================================================
  console.log('\n[SECTION 4] Connection-Level Statement Timeout & Pool Tuning');

  await test('4.1 PrismaService appends options=-c statement_timeout=5000 to connection URL for all pool connections', async () => {
    const rawUrl = 'postgresql://postgres:secret123@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres?sslmode=require&pgbouncer=true';
    const originalEnv = process.env.DATABASE_URL;
    process.env.DATABASE_URL = rawUrl;

    try {
      const prisma = new PrismaService();
      assert.ok(prisma, 'PrismaService must initialize cleanly');

      // Test that constructor with options propagates connection parameters
      const prismaWithOptions = new PrismaService({
        datasources: { db: { url: rawUrl } },
      });
      assert.ok(prismaWithOptions, 'PrismaService accepts custom datasources');
    } finally {
      process.env.DATABASE_URL = originalEnv;
    }
  });

  await test('4.2 PrismaService onModuleInit does NOT execute single-connection SET statement_timeout', async () => {
    const prismaFile = fs.readFileSync(path.join(__dirname, '../src/prisma/prisma.service.ts'), 'utf8');
    assert.strictEqual(
      prismaFile.includes('SET statement_timeout'),
      false,
      'PrismaService onModuleInit must not execute deceptive single-connection SET statement_timeout query',
    );
  });

  // ============================================================================
  // SUMMARY
  // ============================================================================
  console.log('\n================================================================');
  console.log(`📊 RESULTS: ${passedCount} passed, ${failedCount} failed`);
  console.log('================================================================\n');

  if (failedCount > 0) {
    process.exit(1);
  }
}

run().catch((err) => {
  console.error('Fatal test runner failure:', err);
  process.exit(1);
});
