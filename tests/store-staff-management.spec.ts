import * as dotenv from 'dotenv';
dotenv.config();
import { PrismaClient } from '@prisma/client';
import jwt from 'jsonwebtoken';

const prisma = new PrismaClient();
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000/api/v1';

function logTest(name: string, passed: boolean, detail?: string) {
  if (passed) {
    console.log(`\x1b[32m  ✔ [PASS]\x1b[0m ${name}`);
  } else {
    console.log(`\x1b[31m  ✖ [FAIL]\x1b[0m ${name}${detail ? ` -> ${detail}` : ''}`);
  }
}

async function runStoreStaffManagementSuite() {
  console.log('\n========================================================================');
  console.log('🚀 SUITE: STORE STAFF MANAGEMENT & ANTI-ROLE-ESCALATION WHITELIST');
  console.log('========================================================================\n');

  let passed = 0;
  let failed = 0;

  let ownerA: any = null;
  let storeA: any = null;
  let tokenOwnerA = '';

  let ownerB: any = null;
  let storeB: any = null;
  let tokenOwnerB = '';

  let candidateUser1: any = null;
  let candidateUser2: any = null;
  let createdStaff1Id: string | null = null;

  try {
    const jwtSecret = process.env.JWT_SECRET || 'smart_order_button_super_secret_jwt_key_2026_prod';

    // Ensure roles exist in DB
    const requiredRoles = [
      { roleCode: 'STORE_MANAGER', roleName: 'Quản lý cửa hàng' },
      { roleCode: 'STAFF_ORDER', roleName: 'Nhân viên xử lý đơn' },
      { roleCode: 'STAFF_INVENTORY', roleName: 'Nhân viên kho' },
      { roleCode: 'STAFF_DELIVERY', roleName: 'Nhân viên giao nhận' },
      { roleCode: 'STAFF_BUTTON', roleName: 'Kỹ thuật viên nút bấm' },
      { roleCode: 'ADMIN', roleName: 'Quản trị viên hệ thống' },
    ];

    for (const r of requiredRoles) {
      await prisma.role.upsert({
        where: { roleCode: r.roleCode },
        update: {},
        create: {
          roleCode: r.roleCode,
          roleName: r.roleName,
          description: `Auto-created ${r.roleCode}`,
        },
      });
    }

    // Create Owner A & Store A
    ownerA = await prisma.user.create({
      data: {
        username: `staff_owner_a_${Date.now()}`,
        email: `staff_owner_a_${Date.now()}@test.com`,
        phone: `0973${Math.floor(Math.random() * 1000000).toString().padStart(6, '0')}`,
        fullName: 'Store Staff Owner A',
        status: 'ACTIVE',
      },
    });

    storeA = await prisma.store.create({
      data: {
        name: 'Staff Test Store A',
        code: `STORE-STAFF-A-${Date.now()}`,
        phone: '0901234567',
        address: '123 Staff St A',
        ownerUserId: ownerA.userId,
        status: 'ACTIVE',
      },
    });

    tokenOwnerA = jwt.sign(
      {
        userId: ownerA.userId.toString(),
        sub: ownerA.userId.toString(),
        email: ownerA.email,
        role: 'STORE_OWNER',
        storeId: storeA.storeId.toString(),
      },
      jwtSecret,
      { expiresIn: '1h' },
    );

    // Create Owner B & Store B for BOLA testing
    ownerB = await prisma.user.create({
      data: {
        username: `staff_owner_b_${Date.now()}`,
        email: `staff_owner_b_${Date.now()}@test.com`,
        phone: `0974${Math.floor(Math.random() * 1000000).toString().padStart(6, '0')}`,
        fullName: 'Store Staff Owner B',
        status: 'ACTIVE',
      },
    });

    storeB = await prisma.store.create({
      data: {
        name: 'Staff Test Store B',
        code: `STORE-STAFF-B-${Date.now()}`,
        phone: '0907654321',
        address: '456 Staff St B',
        ownerUserId: ownerB.userId,
        status: 'ACTIVE',
      },
    });

    tokenOwnerB = jwt.sign(
      {
        userId: ownerB.userId.toString(),
        sub: ownerB.userId.toString(),
        email: ownerB.email,
        role: 'STORE_OWNER',
        storeId: storeB.storeId.toString(),
      },
      jwtSecret,
      { expiresIn: '1h' },
    );

    // Create candidate users to be staff
    candidateUser1 = await prisma.user.create({
      data: {
        username: `staff_cand_1_${Date.now()}`,
        email: `staff_cand_1_${Date.now()}@test.com`,
        phone: `0975${Math.floor(Math.random() * 1000000).toString().padStart(6, '0')}`,
        fullName: 'Candidate Staff 1',
        status: 'ACTIVE',
      },
    });

    candidateUser2 = await prisma.user.create({
      data: {
        username: `staff_cand_2_${Date.now()}`,
        email: `staff_cand_2_${Date.now()}@test.com`,
        phone: `0976${Math.floor(Math.random() * 1000000).toString().padStart(6, '0')}`,
        fullName: 'Candidate Staff 2',
        status: 'ACTIVE',
      },
    });

    // Test 1: GET /store-staff-roles returns whitelist of assignable roles
    try {
      const res = await fetch(`${BASE_URL}/store-staff-roles`);
      const body = await res.json();

      if (
        res.status === 200 &&
        body.success === true &&
        Array.isArray(body.data) &&
        body.data.length === 5 &&
        body.data.some((r: any) => r.roleCode === 'STORE_MANAGER')
      ) {
        logTest('GET /store-staff-roles returns 5 assignable staff roles', true);
        passed++;
      } else {
        logTest('GET /store-staff-roles returns 5 assignable staff roles', false, JSON.stringify(body));
        failed++;
      }
    } catch (err: any) {
      logTest('GET /store-staff-roles returns 5 assignable staff roles', false, err.message);
      failed++;
    }

    // Test 2: POST /stores/:storeId/staff adds staff member with whitelisted role
    try {
      const res = await fetch(`${BASE_URL}/stores/${storeA.storeId}/staff`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenOwnerA}`,
        },
        body: JSON.stringify({
          userId: candidateUser1.userId.toString(),
          roleCode: 'STORE_MANAGER',
        }),
      });
      const body = await res.json();

      if (
        res.status === 201 &&
        body.success === true &&
        body.data.userId === candidateUser1.userId.toString() &&
        body.data.role.roleCode === 'STORE_MANAGER' &&
        body.data.status === 'ACTIVE'
      ) {
        createdStaff1Id = body.data.storeStaffId;
        logTest('POST /stores/:storeId/staff adds staff member with STORE_MANAGER role', true);
        passed++;
      } else {
        logTest('POST /stores/:storeId/staff adds staff member with STORE_MANAGER role', false, JSON.stringify(body));
        failed++;
      }
    } catch (err: any) {
      logTest('POST /stores/:storeId/staff adds staff member with STORE_MANAGER role', false, err.message);
      failed++;
    }

    // Test 3: Anti-Role-Escalation Whitelist: Rejects ADMIN role assignment with 403
    try {
      const res = await fetch(`${BASE_URL}/stores/${storeA.storeId}/staff`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenOwnerA}`,
        },
        body: JSON.stringify({
          userId: candidateUser2.userId.toString(),
          roleCode: 'ADMIN',
        }),
      });
      const body = await res.json();

      if (
        res.status === 403 &&
        body.message.includes('ROLE_ESCALATION_PROHIBITED')
      ) {
        logTest('Anti-Role-Escalation rejects ADMIN role with 403 Forbidden', true);
        passed++;
      } else {
        logTest('Anti-Role-Escalation rejects ADMIN role with 403 Forbidden', false, `Status: ${res.status}, body: ${JSON.stringify(body)}`);
        failed++;
      }
    } catch (err: any) {
      logTest('Anti-Role-Escalation rejects ADMIN role with 403 Forbidden', false, err.message);
      failed++;
    }

    // Test 4: Duplicate staff assignment returns 409 Conflict
    try {
      const res = await fetch(`${BASE_URL}/stores/${storeA.storeId}/staff`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenOwnerA}`,
        },
        body: JSON.stringify({
          userId: candidateUser1.userId.toString(),
          roleCode: 'STAFF_ORDER',
        }),
      });
      const body = await res.json();

      if (res.status === 409 && body.success === false) {
        logTest('Duplicate staff assignment in same store returns 409 Conflict', true);
        passed++;
      } else {
        logTest('Duplicate staff assignment in same store returns 409 Conflict', false, `Status: ${res.status}`);
        failed++;
      }
    } catch (err: any) {
      logTest('Duplicate staff assignment in same store returns 409 Conflict', false, err.message);
      failed++;
    }

    // Test 5: BOLA Protection: Owner B cannot add staff to Store A
    try {
      const res = await fetch(`${BASE_URL}/stores/${storeA.storeId}/staff`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenOwnerB}`,
        },
        body: JSON.stringify({
          userId: candidateUser2.userId.toString(),
          roleCode: 'STAFF_DELIVERY',
        }),
      });
      const body = await res.json();

      if (res.status === 403 && body.success === false) {
        logTest('BOLA: Owner B cannot add staff to Store A (403 Forbidden)', true);
        passed++;
      } else {
        logTest('BOLA: Owner B cannot add staff to Store A (403 Forbidden)', false, `Status: ${res.status}`);
        failed++;
      }
    } catch (err: any) {
      logTest('BOLA: Owner B cannot add staff to Store A (403 Forbidden)', false, err.message);
      failed++;
    }

    // Test 6: GET /stores/:storeId/staff returns paginated staff list with canonical envelope
    try {
      const res = await fetch(`${BASE_URL}/stores/${storeA.storeId}/staff?page=1&pageSize=20`, {
        headers: { Authorization: `Bearer ${tokenOwnerA}` },
      });
      const body = await res.json();

      if (
        res.status === 200 &&
        body.success === true &&
        Array.isArray(body.data) &&
        body.data.length >= 1 &&
        body.pagination !== undefined &&
        body.pagination.totalItems >= 1
      ) {
        logTest('GET /stores/:storeId/staff returns paginated staff with canonical envelope', true);
        passed++;
      } else {
        logTest('GET /stores/:storeId/staff returns paginated staff with canonical envelope', false, JSON.stringify(body));
        failed++;
      }
    } catch (err: any) {
      logTest('GET /stores/:storeId/staff returns paginated staff with canonical envelope', false, err.message);
      failed++;
    }

    // Test 7: PATCH /store-staff/:id updates role & status
    if (createdStaff1Id) {
      try {
        const res = await fetch(`${BASE_URL}/store-staff/${createdStaff1Id}`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${tokenOwnerA}`,
          },
          body: JSON.stringify({
            roleCode: 'STAFF_INVENTORY',
            status: 'INACTIVE',
          }),
        });
        const body = await res.json();

        if (
          res.status === 200 &&
          body.success === true &&
          body.data.role.roleCode === 'STAFF_INVENTORY' &&
          (body.data.status === 'TERMINATED' || body.data.status === 'INACTIVE') &&
          body.data.leftAt !== null
        ) {
          logTest('PATCH /store-staff/:id updates role to STAFF_INVENTORY and records leftAt', true);
          passed++;
        } else {
          logTest('PATCH /store-staff/:id updates role to STAFF_INVENTORY and records leftAt', false, JSON.stringify(body));
          failed++;
        }
      } catch (err: any) {
        logTest('PATCH /store-staff/:id updates role to STAFF_INVENTORY and records leftAt', false, err.message);
        failed++;
      }

      // Test 8: DELETE /store-staff/:id removes staff member
      try {
        const res = await fetch(`${BASE_URL}/store-staff/${createdStaff1Id}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${tokenOwnerA}` },
        });
        const body = await res.json();

        if (res.status === 200 && body.success === true) {
          logTest('DELETE /store-staff/:id removes staff member successfully', true);
          passed++;
        } else {
          logTest('DELETE /store-staff/:id removes staff member successfully', false, JSON.stringify(body));
          failed++;
        }
      } catch (err: any) {
        logTest('DELETE /store-staff/:id removes staff member successfully', false, err.message);
        failed++;
      }
    }

  } finally {
    // Cleanup
    if (storeA) {
      await prisma.storeStaff.deleteMany({ where: { storeId: storeA.storeId } }).catch(() => {});
      await prisma.store.delete({ where: { storeId: storeA.storeId } }).catch(() => {});
    }
    if (storeB) {
      await prisma.storeStaff.deleteMany({ where: { storeId: storeB.storeId } }).catch(() => {});
      await prisma.store.delete({ where: { storeId: storeB.storeId } }).catch(() => {});
    }
    if (candidateUser1) {
      await prisma.user.delete({ where: { userId: candidateUser1.userId } }).catch(() => {});
    }
    if (candidateUser2) {
      await prisma.user.delete({ where: { userId: candidateUser2.userId } }).catch(() => {});
    }
    if (ownerA) {
      await prisma.user.delete({ where: { userId: ownerA.userId } }).catch(() => {});
    }
    if (ownerB) {
      await prisma.user.delete({ where: { userId: ownerB.userId } }).catch(() => {});
    }
    await prisma.$disconnect();
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) {
    process.exit(1);
  }
}

runStoreStaffManagementSuite().catch((e) => {
  console.error(e);
  process.exit(1);
});
