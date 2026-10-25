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

async function runRentalsLifecycleSuite() {
  console.log('\n========================================================================');
  console.log('🚀 SUITE: BUTTON RENTAL LIFECYCLE, PAYMENTS & ADR-1 INTEGRATION');
  console.log('========================================================================\n');

  let passed = 0;
  let failed = 0;

  let userA: any = null;
  let profileA: any = null;
  let tokenA = '';

  let userB: any = null;
  let profileB: any = null;
  let tokenB = '';

  let adminUser: any = null;
  let adminToken = '';

  let rentalPkg: any = null;
  let rentalA: any = null;

  try {
    const jwtSecret = process.env.JWT_SECRET || 'smart_order_button_super_secret_jwt_key_2026_prod';

    // Ensure RentalPackage
    rentalPkg = await prisma.rentalPackage.upsert({
      where: { packageCode: 'RNT-PKG-TEST' },
      update: { isActive: true },
      create: {
        packageCode: 'RNT-PKG-TEST',
        packageName: 'Gói Thuê 1 Nút Test',
        description: 'Bao gồm 1 nút bấm IoT',
        buttonQuantity: 1,
        monthlyPrice: 50000,
        depositFee: 100000,
        isActive: true,
      },
    });

    // Customer A
    userA = await prisma.user.create({
      data: {
        username: `rnt_user_a_${Date.now()}`,
        email: `rnt_user_a_${Date.now()}@test.com`,
        phone: `0981${Math.floor(Math.random() * 1000000).toString().padStart(6, '0')}`,
        fullName: 'Rental Customer A',
        status: 'ACTIVE',
      },
    });

    profileA = await prisma.customerProfile.create({
      data: {
        userId: userA.userId,
        phone: userA.phone,
      },
    });

    tokenA = jwt.sign(
      {
        userId: userA.userId.toString(),
        sub: userA.userId.toString(),
        email: userA.email,
        role: 'CUSTOMER',
        customerProfileId: profileA.customerId.toString(),
      },
      jwtSecret,
      { expiresIn: '1h' },
    );

    // Customer B (for BOLA)
    userB = await prisma.user.create({
      data: {
        username: `rnt_user_b_${Date.now()}`,
        email: `rnt_user_b_${Date.now()}@test.com`,
        phone: `0982${Math.floor(Math.random() * 1000000).toString().padStart(6, '0')}`,
        fullName: 'Rental Customer B',
        status: 'ACTIVE',
      },
    });

    profileB = await prisma.customerProfile.create({
      data: {
        userId: userB.userId,
        phone: userB.phone,
      },
    });

    tokenB = jwt.sign(
      {
        userId: userB.userId.toString(),
        sub: userB.userId.toString(),
        email: userB.email,
        role: 'CUSTOMER',
        customerProfileId: profileB.customerId.toString(),
      },
      jwtSecret,
      { expiresIn: '1h' },
    );

    // Admin User
    adminUser = await prisma.user.create({
      data: {
        username: `rnt_admin_${Date.now()}`,
        email: `rnt_admin_${Date.now()}@test.com`,
        phone: `0983${Math.floor(Math.random() * 1000000).toString().padStart(6, '0')}`,
        fullName: 'Rental System Admin',
        status: 'ACTIVE',
      },
    });

    adminToken = jwt.sign(
      {
        userId: adminUser.userId.toString(),
        sub: adminUser.userId.toString(),
        email: adminUser.email,
        role: 'ADMIN',
      },
      jwtSecret,
      { expiresIn: '1h' },
    );

    // Test 1: GET /rentals/packages returns active rental packages
    try {
      const res = await fetch(`${BASE_URL}/rentals/packages`);
      const body = await res.json();

      if (
        res.status === 200 &&
        body.success === true &&
        Array.isArray(body.data) &&
        body.data.length >= 1
      ) {
        logTest('GET /rentals/packages returns active packages catalog', true);
        passed++;
      } else {
        logTest('GET /rentals/packages returns active packages catalog', false, JSON.stringify(body));
        failed++;
      }
    } catch (err: any) {
      logTest('GET /rentals/packages returns active packages catalog', false, err.message);
      failed++;
    }

    // Test 2: POST /rentals/order creates rental contract
    try {
      const res = await fetch(`${BASE_URL}/rentals/order`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenA}`,
        },
        body: JSON.stringify({
          packageId: rentalPkg.packageId.toString(),
          monthsRented: 3,
        }),
      });
      const body = await res.json();

      if (
        res.status === 201 &&
        body.success === true &&
        body.data.monthsRented === 3 &&
        body.data.status === 'PENDING_PAYMENT' &&
        body.data.totalRentAmount === 50000 * 3 + 100000
      ) {
        rentalA = body.data;
        logTest('POST /rentals/order creates rental contract with months & deposit', true);
        passed++;
      } else {
        logTest('POST /rentals/order creates rental contract with months & deposit', false, JSON.stringify(body));
        failed++;
      }
    } catch (err: any) {
      logTest('POST /rentals/order creates rental contract with months & deposit', false, err.message);
      failed++;
    }

    // Test 3: GET /rentals/:id returns rental detail
    if (rentalA) {
      try {
        const res = await fetch(`${BASE_URL}/rentals/${rentalA.rentalId}`, {
          headers: { Authorization: `Bearer ${tokenA}` },
        });
        const body = await res.json();

        if (
          res.status === 200 &&
          body.success === true &&
          body.data.rentalId === rentalA.rentalId &&
          body.data.package.packageId === rentalPkg.packageId.toString()
        ) {
          logTest('GET /rentals/:id returns rental detail with package and status', true);
          passed++;
        } else {
          logTest('GET /rentals/:id returns rental detail with package and status', false, JSON.stringify(body));
          failed++;
        }
      } catch (err: any) {
        logTest('GET /rentals/:id returns rental detail with package and status', false, err.message);
        failed++;
      }

      // Test 4: POST /rentals/:id/payment-requests links payment to rental (ADR-1)
      try {
        const res = await fetch(`${BASE_URL}/rentals/${rentalA.rentalId}/payment-requests`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${tokenA}` },
        });
        const body = await res.json();

        if (
          res.status === 201 &&
          body.success === true &&
          body.data.rentalId === rentalA.rentalId &&
          body.data.checkoutUrl !== undefined &&
          body.data.paymentTransactionId !== undefined
        ) {
          // Verify in DB that PaymentTransaction has rentalId and orderId is null
          const txInDb = await prisma.paymentTransaction.findUnique({
            where: { paymentTransactionId: BigInt(body.data.paymentTransactionId) },
          });

          if (txInDb && txInDb.rentalId?.toString() === rentalA.rentalId && txInDb.orderId === null) {
            logTest('POST /rentals/:id/payment-requests creates PaymentTransaction with rentalId & null orderId (ADR-1)', true);
            passed++;
          } else {
            logTest('POST /rentals/:id/payment-requests creates PaymentTransaction with rentalId & null orderId (ADR-1)', false, `DB record: ${JSON.stringify(txInDb)}`);
            failed++;
          }
        } else {
          logTest('POST /rentals/:id/payment-requests creates PaymentTransaction with rentalId & null orderId (ADR-1)', false, JSON.stringify(body));
          failed++;
        }
      } catch (err: any) {
        logTest('POST /rentals/:id/payment-requests creates PaymentTransaction with rentalId & null orderId (ADR-1)', false, err.message);
        failed++;
      }

      // Test 5: POST /rentals/:id/extensions extends contract endDate
      try {
        const res = await fetch(`${BASE_URL}/rentals/${rentalA.rentalId}/extensions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${tokenA}`,
          },
          body: JSON.stringify({ additionalMonths: 2 }),
        });
        const body = await res.json();

        if (
          res.status === 201 &&
          body.success === true &&
          body.data.monthsRented === 5 &&
          body.data.totalRentAmount === 50000 * 5 + 100000
        ) {
          logTest('POST /rentals/:id/extensions extends contract duration and fee', true);
          passed++;
        } else {
          logTest('POST /rentals/:id/extensions extends contract duration and fee', false, JSON.stringify(body));
          failed++;
        }
      } catch (err: any) {
        logTest('POST /rentals/:id/extensions extends contract duration and fee', false, err.message);
        failed++;
      }

      // Test 6: POST /rentals/:id/return-requests requests return
      try {
        const res = await fetch(`${BASE_URL}/rentals/${rentalA.rentalId}/return-requests`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${tokenA}` },
        });
        const body = await res.json();

        if (
          res.status === 201 &&
          body.success === true &&
          body.data.status === 'RETURN_REQUESTED'
        ) {
          logTest('POST /rentals/:id/return-requests transitions status to RETURN_REQUESTED', true);
          passed++;
        } else {
          logTest('POST /rentals/:id/return-requests transitions status to RETURN_REQUESTED', false, JSON.stringify(body));
          failed++;
        }
      } catch (err: any) {
        logTest('POST /rentals/:id/return-requests transitions status to RETURN_REQUESTED', false, err.message);
        failed++;
      }

      // Test 7: GET /admin/rentals returns paginated rentals for admin
      try {
        const res = await fetch(`${BASE_URL}/admin/rentals?page=1&pageSize=20`, {
          headers: { Authorization: `Bearer ${adminToken}` },
        });
        const body = await res.json();

        if (
          res.status === 200 &&
          body.success === true &&
          Array.isArray(body.data) &&
          body.data.length >= 1 &&
          body.pagination !== undefined
        ) {
          logTest('GET /admin/rentals returns paginated rental list for admin', true);
          passed++;
        } else {
          logTest('GET /admin/rentals returns paginated rental list for admin', false, JSON.stringify(body));
          failed++;
        }
      } catch (err: any) {
        logTest('GET /admin/rentals returns paginated rental list for admin', false, err.message);
        failed++;
      }

      // Test 8: PATCH /admin/rentals/:id/status updates status to RETURNED
      try {
        const res = await fetch(`${BASE_URL}/admin/rentals/${rentalA.rentalId}/status`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${adminToken}`,
          },
          body: JSON.stringify({ status: 'RETURNED' }),
        });
        const body = await res.json();

        if (
          res.status === 200 &&
          body.success === true &&
          body.data.status === 'RETURNED'
        ) {
          logTest('PATCH /admin/rentals/:id/status updates rental status to RETURNED', true);
          passed++;
        } else {
          logTest('PATCH /admin/rentals/:id/status updates rental status to RETURNED', false, JSON.stringify(body));
          failed++;
        }
      } catch (err: any) {
        logTest('PATCH /admin/rentals/:id/status updates rental status to RETURNED', false, err.message);
        failed++;
      }

      // Test 9: BOLA: Customer B cannot access Customer A rental
      try {
        const res = await fetch(`${BASE_URL}/rentals/${rentalA.rentalId}`, {
          headers: { Authorization: `Bearer ${tokenB}` },
        });
        const body = await res.json();

        if (res.status === 403 && body.success === false) {
          logTest('BOLA: Customer B cannot access Customer A rental contract (403)', true);
          passed++;
        } else {
          logTest('BOLA: Customer B cannot access Customer A rental contract (403)', false, `Status: ${res.status}`);
          failed++;
        }
      } catch (err: any) {
        logTest('BOLA: Customer B cannot access Customer A rental contract (403)', false, err.message);
        failed++;
      }
    }

  } finally {
    // Cleanup
    if (rentalA) {
      await prisma.paymentTransaction.deleteMany({ where: { rentalId: BigInt(rentalA.rentalId) } }).catch(() => {});
      await prisma.buttonRental.delete({ where: { rentalId: BigInt(rentalA.rentalId) } }).catch(() => {});
    }
    if (profileA) {
      await prisma.customerProfile.delete({ where: { customerId: profileA.customerId } }).catch(() => {});
    }
    if (profileB) {
      await prisma.customerProfile.delete({ where: { customerId: profileB.customerId } }).catch(() => {});
    }
    if (userA) {
      await prisma.user.delete({ where: { userId: userA.userId } }).catch(() => {});
    }
    if (userB) {
      await prisma.user.delete({ where: { userId: userB.userId } }).catch(() => {});
    }
    if (adminUser) {
      await prisma.user.delete({ where: { userId: adminUser.userId } }).catch(() => {});
    }
    await prisma.$disconnect();
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) {
    process.exit(1);
  }
}

runRentalsLifecycleSuite().catch((e) => {
  console.error(e);
  process.exit(1);
});
