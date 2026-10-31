import assert from 'node:assert';
import { AuthService } from '../src/auth/auth.service';

async function run() {
  console.log('🧪 Testing Task 2: Auth role resolution & Inactive user protection...');
  const authService = new AuthService({} as any, {} as any, {} as any, {} as any);

  // Test 1: SYSTEM_ADMIN role resolution must NOT be elevated to SUPER_ADMIN
  const systemAdminUser = {
    userId: BigInt(99),
    email: 'operator@smartorder.local',
    username: 'operator',
    storeStaffs: [
      {
        status: 'ACTIVE',
        storeId: BigInt(1),
        role: { roleCode: 'SYSTEM_ADMIN' },
      },
    ],
  };

  const resolved = authService.resolveUserRole(systemAdminUser);
  assert.strictEqual(
    resolved.role,
    'SYSTEM_ADMIN',
    `Expected role to be SYSTEM_ADMIN but got ${resolved.role}`,
  );

  // Test 2: Inactive staff role must be revoked to CUSTOMER
  const inactiveStaffUser = {
    userId: BigInt(100),
    email: 'fired@store.local',
    username: 'fired_staff',
    storeStaffs: [
      {
        status: 'INACTIVE',
        storeId: BigInt(1),
        role: { roleCode: 'STORE_MANAGER' },
      },
    ],
  };

  const resolvedInactive = authService.resolveUserRole(inactiveStaffUser);
  assert.strictEqual(
    resolvedInactive.role,
    'CUSTOMER',
    `Expected role to be CUSTOMER for inactive staff but got ${resolvedInactive.role}`,
  );

  console.log('✅ Task 2 Auth role resolution tests PASSED!');
}

run().catch((err) => {
  console.error('❌ Test failed with error:', err.message);
  process.exit(1);
});
