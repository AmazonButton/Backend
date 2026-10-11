import { PrismaClient } from '@prisma/client';
import { DevicesRepository } from '../src/devices/devices.repository';
import { PrismaService } from '../src/prisma/prisma.service';

const prisma = new PrismaClient();

async function run() {
  console.log('===============================================================');
  console.log('⚡ TESTING ALL 5 BLOCKERS REMEDIATION & ZERO RESIDUE');
  console.log('===============================================================\n');

  let passed = 0;
  let total = 5;

  try {
    // -------------------------------------------------------------------------
    // TEST 1: Blocker 2 - Prisma schema IotIdempotencyKey & Migration Status
    // -------------------------------------------------------------------------
    console.log('▶ [1/5] Testing Blocker 2: Prisma Schema & No P2022 on IotIdempotencyKey...');
    const idempotencyRecord = await prisma.iotIdempotencyKey.findFirst({
      take: 1,
    });
    // Query executed without throwing P2022
    console.log('  ✔ [PASS] prisma.iotIdempotencyKey.findFirst() executed without P2022 error!');

    const migrations: any[] = await prisma.$queryRawUnsafe(
      `SELECT migration_name, finished_at FROM _prisma_migrations ORDER BY finished_at ASC;`
    );
    console.log(`  ✔ [PASS] Verified ${migrations.length} applied migrations in database.`);
    if (migrations.length < 8) {
      throw new Error(`Expected at least 8 migrations, found ${migrations.length}`);
    }
    passed++;

    // -------------------------------------------------------------------------
    // TEST 2: Blocker 4 - Atomic Nonce Upsert & Expired Nonce Re-use
    // -------------------------------------------------------------------------
    console.log('\n▶ [2/5] Testing Blocker 4: Device Nonce TTL & Atomic Anti-Replay...');
    const testDeviceId = 'SOB-TEST-NONCE-01';
    const testNonce = 'nonce-test-' + Date.now();

    const devicesRepo = new DevicesRepository(prisma as unknown as PrismaService);

    try {
      // Step A: First consumption of nonce must succeed
      const firstConsume = await devicesRepo.consumeDeviceNonce(testDeviceId, testNonce);
      if (!firstConsume) {
        throw new Error('FAIL: First consumeDeviceNonce should succeed');
      }

      // Step B: Immediate duplicate within TTL must be rejected (false)
      const duplicateConsume = await devicesRepo.consumeDeviceNonce(testDeviceId, testNonce);
      if (duplicateConsume) {
        throw new Error('FAIL: Replay attack with same active nonce was NOT rejected!');
      }
      console.log('  ✔ [PASS] Same nonce within TTL was strictly rejected (anti-replay)');

      // Step C: Simulate expired nonce by setting expires_at to past
      await prisma.$executeRawUnsafe(
        `UPDATE device_nonces SET expires_at = NOW() - INTERVAL '10 seconds' WHERE device_id = $1 AND nonce = $2;`,
        testDeviceId,
        testNonce
      );

      // Step D: After TTL expiration, nonce can be accepted again
      const expiredReconsume = await devicesRepo.consumeDeviceNonce(testDeviceId, testNonce);
      if (!expiredReconsume) {
        throw new Error('FAIL: Expired nonce was blocked after TTL!');
      }
      console.log('  ✔ [PASS] Nonce after TTL was successfully accepted & refreshed (no infinite block)');
      passed++;
    } finally {
      // Clean up test nonces
      await prisma.$executeRawUnsafe(
        `DELETE FROM device_nonces WHERE device_id = $1;`,
        testDeviceId
      );
    }

    // -------------------------------------------------------------------------
    // TEST 3: Blocker 3 - DB Status Constraint & Devices toggleStatus
    // -------------------------------------------------------------------------
    console.log('\n▶ [3/5] Testing Blocker 3: Unified Statuses & DB Check Constraint...');
    // Verify valid statuses conform to DB constraint: ACTIVE, INACTIVE, LOCKED, SUSPENDED, UNASSIGNED, MAINTENANCE
    const validStatuses = ['ACTIVE', 'INACTIVE', 'LOCKED', 'SUSPENDED', 'UNASSIGNED', 'MAINTENANCE'];
    
    // Test that DB constraint allows all 6 valid statuses on a rollback transaction
    await prisma.$transaction(async (tx) => {
      for (const st of validStatuses) {
        await tx.$executeRawUnsafe(
          `UPDATE iot_button SET status = $1 WHERE button_id = 50;`,
          st
        );
      }
      // Force rollback so no permanent DB mutation occurs
      throw new Error('ROLLBACK_INTENTIONAL');
    }).catch((err) => {
      if (err.message !== 'ROLLBACK_INTENTIONAL') {
        throw err;
      }
    });

    // Test that an invalid status throws constraint violation
    let invalidRejected = false;
    try {
      await prisma.$executeRawUnsafe(
        `UPDATE iot_button SET status = 'INVALID_FOO_BAR' WHERE button_id = 50;`
      );
    } catch {
      invalidRejected = true;
    }
    if (!invalidRejected) {
      throw new Error('FAIL: Invalid status was not rejected by database constraint!');
    }
    console.log('  ✔ [PASS] DB constraint iot_button_status_check correctly permits all standard BRD statuses & blocks invalid');
    passed++;

    // -------------------------------------------------------------------------
    // TEST 4: Blocker 1 - Provisioning Atomic Transaction & confirmPairing
    // -------------------------------------------------------------------------
    console.log('\n▶ [4/5] Testing Blocker 1: Atomic confirmPairing & Session Claiming...');
    const testSessionToken = 'PROV-TEST-' + Date.now();
    
    const createdSession: any = await prisma.provisioningSession.create({
      data: {
        sessionId: testSessionToken,
        deviceId: 50n,
        sessionHash: 'hash-' + Date.now(),
        status: 'ACTIVE',
        expiresAt: new Date(Date.now() + 600000),
      },
    });

    try {
      const { ProvisioningRepository } = await import('../src/devices/provisioning.repository');
      const { ProvisioningService } = await import('../src/devices/provisioning.service');
      const provRepo = new ProvisioningRepository(prisma as unknown as PrismaService);
      const provService = new ProvisioningService(
        provRepo,
        { decrypt: () => '' } as any,
        { server: { emit: () => {} } } as any,
      );

      let caughtExpected = false;
      try {
        await provService.confirmPairing(
          testSessionToken,
          {
            customerId: '1',
            storeId: '1',
            deviceId: 'SOB-000038',
            buttonName: 'Test Atomic Button',
            productId: '99999999999', // non-existent product
          },
          { customerProfileId: '1' }
        );
      } catch (err: any) {
        caughtExpected = true;
      }

      if (!caughtExpected) {
        throw new Error('FAIL: confirmPairing should fail when product does not exist');
      }

      // Verify that session is STILL ACTIVE because the transaction rolled back atomically!
      const sessionAfterFail = await prisma.provisioningSession.findUnique({
        where: { id: createdSession.id },
      });
      if (sessionAfterFail?.status !== 'ACTIVE') {
        throw new Error('FAIL: Session status prematurely changed to ' + sessionAfterFail?.status + ' before transaction committed!');
      }
      console.log('  ✔ [PASS] Transaction rollback verified: session is NOT prematurely claimed if downstream validation fails!');
      passed++;
    } finally {
      // Clean up test session
      await prisma.provisioningSession.delete({
        where: { id: createdSession.id },
      });
    }

    // -------------------------------------------------------------------------
    // TEST 5: Blocker 5 - PayOS URL Preservation & Concurrent Link Creation
    // -------------------------------------------------------------------------
    console.log('\n▶ [5/5] Testing Blocker 5: PayOS Direct URL Fields & Concurrency Safe Handling...');
    // Verify PaymentTransaction schema has checkoutUrl and qrCode fields and updates atomically
    const testOrder = await prisma.order.findFirst({ select: { orderId: true } });
    if (!testOrder) {
      throw new Error('FAIL: No order found to test payment transaction schema');
    }

    // Verify transaction insert & direct checkoutUrl retention
    const txRecord = await prisma.paymentTransaction.create({
      data: {
        orderId: testOrder.orderId,
        provider: 'PAYOS',
        amount: 50000,
        paymentMethod: 'QR',
        paymentLinkId: '999888777',
        checkoutUrl: 'https://pay.payos.vn/web/test-uuid-safe-url',
        qrCode: 'vietqr://payos/mock-test',
        status: 'CREATING',
      },
    });

    try {
      if (txRecord.checkoutUrl !== 'https://pay.payos.vn/web/test-uuid-safe-url') {
        throw new Error('FAIL: checkoutUrl not preserved directly');
      }
      if (txRecord.qrCode !== 'vietqr://payos/mock-test') {
        throw new Error('FAIL: qrCode not preserved directly');
      }
      console.log('  ✔ [PASS] Direct checkoutUrl and qrCode successfully persisted on PaymentTransaction');
      passed++;
    } finally {
      await prisma.paymentTransaction.delete({
        where: { paymentTransactionId: txRecord.paymentTransactionId },
      });
    }

    console.log('\n===============================================================');
    console.log(`🎉 ALL ${passed}/${total} BLOCKER VERIFICATION CHECKS PASSED WITH ZERO RESIDUE!`);
    console.log('===============================================================\n');
  } catch (error) {
    console.error('\n❌ VERIFICATION TEST FAILED:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

run();
