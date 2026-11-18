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

    const tokenCandidate1 = jwt.sign(
      {
        userId: candidateUser1.userId.toString(),
        sub: candidateUser1.userId.toString(),
        email: candidateUser1.email,
        role: 'CUSTOMER',
      },
      jwtSecret,
      { expiresIn: '1h' },
    );

    const tokenCandidate2 = jwt.sign(
      {
        userId: candidateUser2.userId.toString(),
        sub: candidateUser2.userId.toString(),
        email: candidateUser2.email,
        role: 'CUSTOMER',
      },
      jwtSecret,
      { expiresIn: '1h' },
    );

    // Test 1: GET /store-staff-roles returns empty whitelist after store-staff/shipper deprecation
    try {
      const res = await fetch(`${BASE_URL}/store-staff-roles`);
      const body = await res.json();

      if (res.status === 200 && body.success === true && Array.isArray(body.data) && body.data.length === 0) {
        logTest('GET /store-staff-roles returns empty list after deprecation', true);
        passed++;
      } else {
        logTest('GET /store-staff-roles returns empty list after deprecation', false, JSON.stringify(body));
        failed++;
      }
    } catch (err: any) {
      logTest('GET /store-staff-roles returns empty list after deprecation', false, err.message);
      failed++;
    }

    // Test 2: POST /stores/:storeId/staff rejects new invitations across STORE_MANAGER, STAFF_DELIVERY, ADMIN
    try {
      const rejectedCodes: string[] = [];
      for (const roleCode of ['STORE_MANAGER', 'STAFF_DELIVERY', 'ADMIN']) {
        const res = await fetch(`${BASE_URL}/stores/${storeA.storeId}/staff`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${tokenOwnerA}`,
          },
          body: JSON.stringify({
            userId: candidateUser1.userId.toString(),
            roleCode,
          }),
        });
        const body = await res.json();
        if (res.status === 403 && body.code === 'STORE_STAFF_ROLE_DEPRECATED') {
          rejectedCodes.push(roleCode);
        }
      }

      if (rejectedCodes.length === 3) {
        logTest('POST /stores/:storeId/staff rejects new store staff & shipper assignments with 403 STORE_STAFF_ROLE_DEPRECATED', true);
        passed++;
      } else {
        logTest(
          'POST /stores/:storeId/staff rejects new store staff & shipper assignments with 403 STORE_STAFF_ROLE_DEPRECATED',
          false,
          `Rejected: ${rejectedCodes.join(',')}`,
        );
        failed++;
      }
    } catch (err: any) {
      logTest('POST /stores/:storeId/staff rejects new store staff & shipper assignments with 403 STORE_STAFF_ROLE_DEPRECATED', false, err.message);
      failed++;
    }

    // Seed legacy DB fixture rows directly to test legacy accept/reactivate blocking, BOLA, listing & historical soft-termination
    const staffRole = await prisma.role.findUnique({ where: { roleCode: 'STAFF_ORDER' } });
    const legacyPending = await prisma.storeStaff.create({
      data: {
        storeId: storeA.storeId,
        userId: candidateUser1.userId,
        roleId: staffRole!.roleId,
        status: 'PENDING',
      },
    });
    const legacyActive = await prisma.storeStaff.create({
      data: {
        storeId: storeA.storeId,
        userId: candidateUser2.userId,
        roleId: staffRole!.roleId,
        status: 'ACTIVE',
      },
    });
    createdStaff1Id = legacyActive.storeStaffId.toString();

    // Test 3: Legacy PENDING invitation accept & direct PATCH reactivation/role-change are blocked with 403
    try {
      const acceptRes = await fetch(`${BASE_URL}/store-staff/${legacyPending.storeStaffId}/accept`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokenCandidate1}` },
      });
      const acceptBody = await acceptRes.json();

      const reactivateRes = await fetch(`${BASE_URL}/store-staff/${legacyPending.storeStaffId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenOwnerA}`,
        },
        body: JSON.stringify({ status: 'ACTIVE' }),
      });
      const roleChangeRes = await fetch(`${BASE_URL}/store-staff/${legacyActive.storeStaffId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenOwnerA}`,
        },
        body: JSON.stringify({ roleCode: 'STAFF_INVENTORY' }),
      });

      if (
        acceptRes.status === 403 &&
        acceptBody.code === 'STORE_STAFF_ROLE_DEPRECATED' &&
        reactivateRes.status === 403 &&
        roleChangeRes.status === 403
      ) {
        logTest('Legacy acceptInvitation, PATCH ACTIVE & PATCH roleCode are blocked with 403 STORE_STAFF_ROLE_DEPRECATED', true);
        passed++;
      } else {
        logTest(
          'Legacy acceptInvitation, PATCH ACTIVE & PATCH roleCode are blocked with 403 STORE_STAFF_ROLE_DEPRECATED',
          false,
          `accept=${acceptRes.status}, reactivate=${reactivateRes.status}, roleChange=${roleChangeRes.status}`,
        );
        failed++;
      }
    } catch (err: any) {
      logTest('Legacy acceptInvitation, PATCH ACTIVE & PATCH roleCode are blocked with 403 STORE_STAFF_ROLE_DEPRECATED', false, err.message);
      failed++;
    }

    // Test 4: BOLA Protection: Owner B cannot terminate/update Store A's legacy staff row
    try {
      const res = await fetch(`${BASE_URL}/store-staff/${legacyActive.storeStaffId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenOwnerB}`,
        },
        body: JSON.stringify({ status: 'TERMINATED' }),
      });
      const delRes = await fetch(`${BASE_URL}/store-staff/${legacyActive.storeStaffId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${tokenOwnerB}` },
      });

      if (res.status === 403 && delRes.status === 403) {
        logTest('BOLA: Owner B cannot modify or terminate Store A legacy staff (403 Forbidden)', true);
        passed++;
      } else {
        logTest('BOLA: Owner B cannot modify or terminate Store A legacy staff (403 Forbidden)', false, `patch=${res.status}, del=${delRes.status}`);
        failed++;
      }
    } catch (err: any) {
      logTest('BOLA: Owner B cannot modify or terminate Store A legacy staff (403 Forbidden)', false, err.message);
      failed++;
    }

    // Test 5: GET /stores/:storeId/staff returns paginated legacy staff history with canonical envelope
    try {
      const res = await fetch(`${BASE_URL}/stores/${storeA.storeId}/staff?page=1&pageSize=20`, {
        headers: { Authorization: `Bearer ${tokenOwnerA}` },
      });
      const body = await res.json();

      if (
        res.status === 200 &&
        body.success === true &&
        Array.isArray(body.data) &&
        body.data.length >= 2 &&
        body.pagination !== undefined &&
        body.pagination.totalItems >= 2
      ) {
        logTest('GET /stores/:storeId/staff returns paginated historical records with canonical envelope', true);
        passed++;
      } else {
        logTest('GET /stores/:storeId/staff returns paginated historical records with canonical envelope', false, JSON.stringify(body));
        failed++;
      }
    } catch (err: any) {
      logTest('GET /stores/:storeId/staff returns paginated historical records with canonical envelope', false, err.message);
      failed++;
    }

    // Test 6: PATCH /store-staff/:id allows deactivating legacy PENDING row to TERMINATED with leftAt
    try {
      const res = await fetch(`${BASE_URL}/store-staff/${legacyPending.storeStaffId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenOwnerA}`,
        },
        body: JSON.stringify({ status: 'TERMINATED' }),
      });
      const body = await res.json();

      if (res.status === 200 && body.success === true && body.data?.status === 'TERMINATED' && body.data?.leftAt !== null) {
        logTest('PATCH /store-staff/:id allows terminating legacy PENDING row with leftAt', true);
        passed++;
      } else {
        logTest('PATCH /store-staff/:id allows terminating legacy PENDING row with leftAt', false, JSON.stringify(body));
        failed++;
      }
    } catch (err: any) {
      logTest('PATCH /store-staff/:id allows terminating legacy PENDING row with leftAt', false, err.message);
      failed++;
    }

    // Test 7: DELETE /store-staff/:id preserves record as TERMINATED + leftAt (no physical delete)
    try {
      const res = await fetch(`${BASE_URL}/store-staff/${legacyActive.storeStaffId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${tokenOwnerA}` },
      });
      const body = await res.json();
      const preservedRow = await prisma.storeStaff.findUnique({ where: { storeStaffId: legacyActive.storeStaffId } });

      if (
        res.status === 200 &&
        body.success === true &&
        preservedRow !== null &&
        preservedRow.status === 'TERMINATED' &&
        preservedRow.leftAt !== null
      ) {
        logTest('DELETE /store-staff/:id soft-terminates record to TERMINATED & preserves DB history', true);
        passed++;
      } else {
        logTest('DELETE /store-staff/:id soft-terminates record to TERMINATED & preserves DB history', false, JSON.stringify(body));
        failed++;
      }
    } catch (err: any) {
      logTest('DELETE /store-staff/:id soft-terminates record to TERMINATED & preserves DB history', false, err.message);
      failed++;
    }

    // Touch unused tokenCandidate2 reference guard if linter checks
    void tokenCandidate2;

  } finally {
    // Cleanup
    if (createdStaff1Id) {
      await prisma.rentalAuditLog
        .deleteMany({ where: { targetType: 'STORE_STAFF', targetId: BigInt(createdStaff1Id) } })
        .catch(() => {});
    }
    if (storeA) {
      await prisma.storeStaff.deleteMany({ where: { storeId: storeA.storeId } }).catch(() => {});
      await prisma.store.delete({ where: { storeId: storeA.storeId } }).catch(() => {});
    }
    if (storeB) {
      await prisma.storeStaff.deleteMany({ where: { storeId: storeB.storeId } }).catch(() => {});
      await prisma.store.delete({ where: { storeId: storeB.storeId } }).catch(() => {});
    }
    if (candidateUser1) {
      await prisma.refreshToken.deleteMany({ where: { userId: candidateUser1.userId } }).catch(() => {});
      await prisma.user.delete({ where: { userId: candidateUser1.userId } }).catch(() => {});
    }
    if (candidateUser2) {
      await prisma.refreshToken.deleteMany({ where: { userId: candidateUser2.userId } }).catch(() => {});
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
