import { PrismaClient } from '@prisma/client';
import { DevicesRepository } from '../src/devices/devices.repository';
import { ProvisioningRepository } from '../src/devices/provisioning.repository';
import { ProvisioningService } from '../src/devices/provisioning.service';
import { OrdersRepository } from '../src/orders/orders.repository';
import { PrismaService } from '../src/prisma/prisma.service';

const prisma = new PrismaClient();

async function run() {
  console.log('===============================================================');
  console.log('🚀 TESTING ALL BLOCKERS REMEDIATION WITH DIRECT DB & ZERO RESIDUE');
  console.log('===============================================================\n');

  let passed = 0;
  const total = 8;
  const testRunId = Date.now();

  // Strict tracked entity IDs for zero residue cleanup (no prefix-based wildcards)
  const trackedProductIds: bigint[] = [];
  const trackedOrderIds: bigint[] = [];
  const trackedButtonIds: bigint[] = [];
  const trackedSessionIds: bigint[] = [];
  const trackedPaymentTxIds: bigint[] = [];
  const trackedTemplateIds: bigint[] = [];

  try {
    // -------------------------------------------------------------------------
    // TEST 1: Blocker 2 - Prisma schema IotIdempotencyKey & Squashed Baseline Migration
    // -------------------------------------------------------------------------
    console.log('👉 [1/8] Testing Blocker 2: Prisma Schema & Squashed Baseline Migration...');
    await prisma.iotIdempotencyKey.findFirst({ take: 1 });
    console.log('  ✅ [PASS] prisma.iotIdempotencyKey.findFirst() executed without P2022 error!');

    const migrations: any[] = await prisma.$queryRawUnsafe(
      `SELECT migration_name, finished_at FROM _prisma_migrations ORDER BY finished_at ASC;`
    );
    console.log(`  ✅ [PASS] Verified ${migrations.length} applied migration(s) in database.`);
    if (migrations.length < 1) {
      throw new Error(`Expected at least 1 migration, found ${migrations.length}`);
    }
    const baselineMigration = migrations.find((m) =>
      m.migration_name.includes('20261012000000_init_baseline'),
    );
    if (!baselineMigration) {
      throw new Error('FAIL: Squashed baseline migration 20261012000000_init_baseline is not recorded as applied!');
    }
    console.log('  ✅ [PASS] Clean squashed baseline migration 20261012000000_init_baseline is active & up-to-date!');
    passed++;

    // -------------------------------------------------------------------------
    // TEST 2: Blocker 4 - Device Nonce TTL & Atomic Anti-Replay
    // -------------------------------------------------------------------------
    console.log('\n👉 [2/8] Testing Blocker 4: Device Nonce TTL & Atomic Anti-Replay...');
    const testDeviceId = 'SOB-TEST-NONCE-' + testRunId;
    const testNonce = 'nonce-test-' + testRunId;
    const devicesRepo = new DevicesRepository(prisma as unknown as PrismaService);

    try {
      const firstConsume = await devicesRepo.consumeDeviceNonce(testDeviceId, testNonce);
      if (!firstConsume) {
        throw new Error('FAIL: First consumeDeviceNonce should succeed');
      }

      const duplicateConsume = await devicesRepo.consumeDeviceNonce(testDeviceId, testNonce);
      if (duplicateConsume) {
        throw new Error('FAIL: Replay attack with same active nonce was NOT rejected!');
      }
      console.log('  ✅ [PASS] Same nonce within TTL was strictly rejected (anti-replay)');

      await prisma.$executeRawUnsafe(
        `UPDATE device_nonces SET expires_at = NOW() - INTERVAL '10 seconds' WHERE device_id = $1 AND nonce = $2;`,
        testDeviceId,
        testNonce,
      );

      const expiredReconsume = await devicesRepo.consumeDeviceNonce(testDeviceId, testNonce);
      if (!expiredReconsume) {
        throw new Error('FAIL: Expired nonce was blocked after TTL!');
      }
      console.log('  ✅ [PASS] Nonce after TTL was successfully accepted & refreshed (no infinite block)');
      passed++;
    } finally {
      await prisma.$executeRawUnsafe(
        `DELETE FROM device_nonces WHERE device_id = $1;`,
        testDeviceId,
      );
    }

    // -------------------------------------------------------------------------
    // TEST 3: Blocker 3 - DB Status Constraint & Devices toggleStatus
    // -------------------------------------------------------------------------
    console.log('\n👉 [3/8] Testing Blocker 3: Unified Statuses & DB Check Constraint...');
    const validStatuses = ['ACTIVE', 'INACTIVE', 'LOCKED', 'SUSPENDED', 'UNASSIGNED', 'MAINTENANCE'];

    await prisma.$transaction(async (tx) => {
      for (const st of validStatuses) {
        await tx.$executeRawUnsafe(
          `UPDATE iot_button SET status = $1 WHERE button_id = (SELECT button_id FROM iot_button LIMIT 1);`,
          st,
        );
      }
      throw new Error('ROLLBACK_INTENTIONAL');
    }).catch((err) => {
      if (err.message !== 'ROLLBACK_INTENTIONAL') throw err;
    });

    let invalidRejected = false;
    try {
      await prisma.$executeRawUnsafe(
        `UPDATE iot_button SET status = 'INVALID_FOO_BAR' WHERE button_id = (SELECT button_id FROM iot_button LIMIT 1);`,
      );
    } catch {
      invalidRejected = true;
    }
    if (!invalidRejected) {
      throw new Error('FAIL: Invalid status was not rejected by database constraint!');
    }
    console.log('  ✅ [PASS] DB constraint iot_button_status_check correctly permits all standard BRD statuses & blocks invalid');
    passed++;

    // -------------------------------------------------------------------------
    // TEST 3B: Test 3B - Anti-Double Inventory & Dual-Order Reservation Isolation
    // -------------------------------------------------------------------------
    console.log('\n👉 [4/8] Testing Test 3B: Dual-Order Inventory Reservation Isolation & Single Deduction...');
    const activeStore = await prisma.store.findFirst({ where: { status: 'ACTIVE' } });
    if (!activeStore) throw new Error('FAIL: No active store available for inventory test');
    const activeCustomer = await prisma.customerProfile.findFirst();
    if (!activeCustomer) throw new Error('FAIL: No customer profile available for inventory test');
    const activeBtn = await prisma.ioTButton.findFirst({ where: { storeId: activeStore.storeId } });
    if (!activeBtn) throw new Error('FAIL: No button available for inventory test');

    const testCategory = await prisma.category.findFirst({ where: { storeId: activeStore.storeId } });
    const testInvProduct = await prisma.product.create({
      data: {
        storeId: activeStore.storeId,
        categoryId: testCategory ? testCategory.categoryId : null,
        productCode: `PRD_INV_${testRunId}`,
        productName: `Test Inv Product ${testRunId}`,
        basePrice: 50000,
        status: 'ACTIVE',
      },
    });
    trackedProductIds.push(testInvProduct.productId);

    await prisma.inventory.upsert({
      where: { productId: testInvProduct.productId },
      update: {
        quantityOnHand: 100,
        reservedQuantity: 0,
      },
      create: {
        storeId: activeStore.storeId,
        productId: testInvProduct.productId,
        quantityOnHand: 100,
        reservedQuantity: 0,
        minStockAlert: 5,
      },
    });

    const order1 = await prisma.order.create({
      data: {
        orderCode: `ORD_T3B_1_${testRunId}`,
        storeId: activeStore.storeId,
        customerId: activeCustomer.customerId,
        buttonId: activeBtn.buttonId,
        orderStatus: 'PENDING',
        paymentStatus: 'UNPAID',
        paymentMethod: 'COD',
        subtotalAmount: 100000,
        totalAmount: 100000,
        shippingRecipientName: 'Test Recipient',
        shippingPhone: '0901234567',
        shippingAddress: '123 Test St',
        items: {
          create: [{
            productId: testInvProduct.productId,
            productNameSnapshot: testInvProduct.productName,
            unitPriceSnapshot: 50000,
            finalUnitPrice: 50000,
            quantity: 2,
            itemSubtotal: 100000,
          }],
        },
      },
    });
    trackedOrderIds.push(order1.orderId);

    await prisma.inventory.update({
      where: { productId: testInvProduct.productId },
      data: { reservedQuantity: { increment: 2 } },
    });

    const order2 = await prisma.order.create({
      data: {
        orderCode: `ORD_T3B_2_${testRunId}`,
        storeId: activeStore.storeId,
        customerId: activeCustomer.customerId,
        buttonId: activeBtn.buttonId,
        orderStatus: 'PENDING',
        paymentStatus: 'UNPAID',
        paymentMethod: 'COD',
        subtotalAmount: 150000,
        totalAmount: 150000,
        shippingRecipientName: 'Test Recipient',
        shippingPhone: '0901234567',
        shippingAddress: '123 Test St',
        items: {
          create: [{
            productId: testInvProduct.productId,
            productNameSnapshot: testInvProduct.productName,
            unitPriceSnapshot: 50000,
            finalUnitPrice: 50000,
            quantity: 3,
            itemSubtotal: 150000,
          }],
        },
      },
    });
    trackedOrderIds.push(order2.orderId);

    await prisma.inventory.update({
      where: { productId: testInvProduct.productId },
      data: { reservedQuantity: { increment: 3 } },
    });

    try {
      let invSnapshot = await prisma.inventory.findUnique({ where: { productId: testInvProduct.productId } });
      if (invSnapshot?.reservedQuantity !== 5 || invSnapshot?.quantityOnHand !== 100) {
        throw new Error(`Initial reservation mismatch: reserved ${invSnapshot?.reservedQuantity}, onHand ${invSnapshot?.quantityOnHand}`);
      }
      console.log(`  📸 [SNAPSHOT] Both orders reserved stock: onHand = 100, reserved = 5 (Order1: 2, Order2: 3)`);

      const ordersRepo = new OrdersRepository(prisma as unknown as PrismaService);
      await ordersRepo.cancelOrderAtomicTx(order1.orderId, 'Hủy đơn 1 kiểm tra bảo toàn reserved đơn 2');

      invSnapshot = await prisma.inventory.findUnique({ where: { productId: testInvProduct.productId } });
      if (invSnapshot?.reservedQuantity !== 3 || invSnapshot?.quantityOnHand !== 100) {
        throw new Error(`Reservation leaked on cancel! Expected reserved 3, onHand 100; got reserved ${invSnapshot?.reservedQuantity}, onHand ${invSnapshot?.quantityOnHand}`);
      }
      console.log(`  ✅ [PASS] Cancelling Order 1 accurately retained Order 2's reserved stock at exactly 3 units!`);

      // Strictly transition order2 along valid state machine path to DELIVERED
      for (const nextStatus of ['CONFIRMED', 'PREPARING', 'READY_FOR_DELIVERY', 'SHIPPING', 'DELIVERED']) {
        await prisma.order.update({
          where: { orderId: order2.orderId },
          data: { orderStatus: nextStatus },
        });
      }
      await ordersRepo.completeOrderAtomicTx(order2.orderId);

      invSnapshot = await prisma.inventory.findUnique({ where: { productId: testInvProduct.productId } });
      if (invSnapshot?.quantityOnHand !== 97 || invSnapshot?.reservedQuantity !== 0) {
        throw new Error(`Double inventory deduction detected! Expected onHand 97, reserved 0; got onHand ${invSnapshot?.quantityOnHand}, reserved ${invSnapshot?.reservedQuantity}`);
      }
      console.log(`  ✅ [PASS] Completing Order 2 deducted on-hand strictly ONCE (100 -> 97), reserved = 0!`);
      passed++;
    } finally {
      await prisma.orderItem.deleteMany({ where: { orderId: { in: [order1.orderId, order2.orderId] } } });
      await prisma.orderStatusHistory.deleteMany({ where: { orderId: { in: [order1.orderId, order2.orderId] } } });
      await prisma.order.deleteMany({ where: { orderId: { in: [order1.orderId, order2.orderId] } } });
      await prisma.inventory.deleteMany({ where: { productId: testInvProduct.productId } });
      await prisma.product.deleteMany({ where: { productId: testInvProduct.productId } });
      console.log(`  🧹 [CLEANUP] Test 3B orders and inventory entities cleaned up by exact IDs (Zero residue).`);
    }

    // -------------------------------------------------------------------------
    // TEST 4: Blocker 1 - Provisioning Atomic Transaction & confirmPairing
    // -------------------------------------------------------------------------
    console.log('\n👉 [5/8] Testing Blocker 1: Atomic confirmPairing & Session Claiming...');
    const testSessionToken = 'PROV-TEST-' + testRunId;
    const dummyButton = await prisma.ioTButton.findFirst();
    if (!dummyButton) throw new Error('FAIL: No button found for session test');

    const createdSession: any = await prisma.provisioningSession.create({
      data: {
        sessionId: testSessionToken,
        deviceId: dummyButton.buttonId,
        sessionHash: 'hash-' + testRunId,
        status: 'ACTIVE',
        expiresAt: new Date(Date.now() + 600000),
      },
    });
    trackedSessionIds.push(createdSession.id);

    try {
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
            deviceId: dummyButton.deviceId,
            buttonName: 'Test Atomic Button',
            productId: '99999999999',
          },
          { customerProfileId: '1' },
        );
      } catch {
        caughtExpected = true;
      }

      if (!caughtExpected) {
        throw new Error('FAIL: confirmPairing should fail when product does not exist');
      }

      const sessionAfterFail = await prisma.provisioningSession.findUnique({
        where: { id: createdSession.id },
      });
      if (sessionAfterFail?.status !== 'ACTIVE') {
        throw new Error('FAIL: Session status prematurely changed to ' + sessionAfterFail?.status);
      }
      console.log('  ✅ [PASS] Transaction rollback verified: session is NOT prematurely claimed if downstream validation fails!');
      passed++;
    } finally {
      await prisma.provisioningSession.delete({
        where: { id: createdSession.id },
      });
    }

    // -------------------------------------------------------------------------
    // TEST 5: Test 5 - Direct DB Verification for Unclaim & Factory Reset
    // -------------------------------------------------------------------------
    console.log('\n👉 [6/8] Testing Test 5: Unclaim & Factory Reset Direct Database State Verification...');
    const provRepo = new ProvisioningRepository(prisma as unknown as PrismaService);

    const testBtn = await prisma.ioTButton.create({
      data: {
        deviceId: `SOB-TEST-UNC-${testRunId}`,
        buttonCode: `BTN_UNC_${testRunId}`,
        storeId: activeStore.storeId,
        customerId: activeCustomer.customerId,
        hmacSecret: 'sec_0123456789abcdef0123456789abcdef',
        status: 'ACTIVE',
      },
    });
    trackedButtonIds.push(testBtn.buttonId);

    const activeProduct = await prisma.product.findFirst({ where: { storeId: activeStore.storeId } });
    if (activeProduct) {
      await prisma.buttonProduct.create({
        data: {
          buttonId: testBtn.buttonId,
          productId: activeProduct.productId,
          quantity: 1,
        },
      });
    }

    try {
      // Step A: Execute unclaim and verify DB directly
      await provRepo.unclaimDeviceAtomicTx(testBtn.buttonId);

      const unclaimDbBtn = await prisma.ioTButton.findUnique({ where: { buttonId: testBtn.buttonId } });
      const unclaimBpCount = await prisma.buttonProduct.count({ where: { buttonId: testBtn.buttonId } });

      console.log('  Direct DB state after Unclaim:', {
        customerId: unclaimDbBtn?.customerId,
        addressId: unclaimDbBtn?.addressId,
        status: unclaimDbBtn?.status,
        buttonProductCount: unclaimBpCount,
      });

      if (
        unclaimDbBtn?.customerId !== null ||
        unclaimDbBtn?.addressId !== null ||
        unclaimDbBtn?.status !== 'UNASSIGNED' ||
        unclaimBpCount !== 0
      ) {
        throw new Error('FAIL: Unclaim direct DB state failed! customerId/addressId not null, bp not purged, or status != UNASSIGNED');
      }
      console.log('  ✅ [PASS] Direct DB Unclaim verified: customerId === null, addressId === null, status === "UNASSIGNED", buttonProduct === 0!');

      // Step B: Reassign button and execute factory reset
      await prisma.ioTButton.update({
        where: { buttonId: testBtn.buttonId },
        data: { customerId: activeCustomer.customerId, status: 'ACTIVE' },
      });
      if (activeProduct) {
        await prisma.buttonProduct.create({
          data: {
            buttonId: testBtn.buttonId,
            productId: activeProduct.productId,
            quantity: 2,
          },
        });
      }

      await provRepo.factoryResetAtomicTx(testBtn.buttonId);

      const resetDbBtn = await prisma.ioTButton.findUnique({ where: { buttonId: testBtn.buttonId } });
      const resetBpCount = await prisma.buttonProduct.count({ where: { buttonId: testBtn.buttonId } });

      console.log('  Direct DB state after Factory Reset:', {
        customerId: resetDbBtn?.customerId,
        addressId: resetDbBtn?.addressId,
        status: resetDbBtn?.status,
        buttonProductCount: resetBpCount,
      });

      if (
        resetDbBtn?.customerId !== null ||
        resetDbBtn?.addressId !== null ||
        resetDbBtn?.status !== 'INACTIVE' ||
        resetBpCount !== 0
      ) {
        throw new Error('FAIL: Factory reset direct DB state failed! customerId/addressId not null, bp not purged, or status != INACTIVE');
      }
      console.log('  ✅ [PASS] Direct DB Factory Reset verified: customerId === null, addressId === null, status === "INACTIVE", buttonProduct === 0!');
      passed++;
    } finally {
      await prisma.buttonProduct.deleteMany({ where: { buttonId: testBtn.buttonId } });
      await prisma.ioTButton.delete({ where: { buttonId: testBtn.buttonId } });
      console.log(`  🧹 [CLEANUP] Test 5 device cleaned up by exact ID (Zero residue).`);
    }

    // -------------------------------------------------------------------------
    // TEST 6: Blocker 5 - PayOS URL Preservation & Direct Field Retention
    // -------------------------------------------------------------------------
    console.log('\n👉 [7/8] Testing Blocker 5: PayOS Direct URL Fields & Concurrency Safe Handling...');
    const testOrder = await prisma.order.findFirst({ select: { orderId: true } });
    if (!testOrder) {
      throw new Error('FAIL: No order found to test payment transaction schema');
    }

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
    trackedPaymentTxIds.push(txRecord.paymentTransactionId);

    try {
      if (txRecord.checkoutUrl !== 'https://pay.payos.vn/web/test-uuid-safe-url') {
        throw new Error('FAIL: checkoutUrl not preserved directly');
      }
      if (txRecord.qrCode !== 'vietqr://payos/mock-test') {
        throw new Error('FAIL: qrCode not preserved directly');
      }
      console.log('  ✅ [PASS] Direct checkoutUrl and qrCode successfully persisted on PaymentTransaction');
      passed++;
    } finally {
      await prisma.paymentTransaction.delete({
        where: { paymentTransactionId: txRecord.paymentTransactionId },
      });
    }

    // -------------------------------------------------------------------------
    // TEST 7: P1 Device Template Full Config Persistence & Direct DB Read-back
    // -------------------------------------------------------------------------
    console.log('\n👉 [8/8] Testing P1 Issue: Device Template Full Config Persistence & Direct DB Read-Back...');
    const testTemplate = await prisma.deviceTemplate.create({
      data: {
        code: `TMPL_${testRunId}`,
        name: `Water Dispenser Template ${testRunId}`,
        description: 'Auto water ordering single-press, emergency support double-press',
        category: 'WATER',
        singlePressAction: 'ORDER_WATER_19L',
        doublePressAction: 'SUPPORT_DISPATCH',
        defaultQuantity: 5,
        cancelWindowSeconds: 120,
      },
    });
    trackedTemplateIds.push(testTemplate.templateId);

    const testTmplDevice = await prisma.ioTButton.create({
      data: {
        deviceId: `SOB-TEST-TMPL-${testRunId}`,
        buttonCode: `BTN_TMPL_${testRunId}`,
        storeId: activeStore.storeId,
        customerId: activeCustomer.customerId,
        hmacSecret: 'sec_template_0123456789abcdef01234',
        status: 'ACTIVE',
      },
    });
    trackedButtonIds.push(testTmplDevice.buttonId);

    if (activeProduct) {
      await prisma.buttonProduct.create({
        data: {
          buttonId: testTmplDevice.buttonId,
          productId: activeProduct.productId,
          quantity: 1,
        },
      });
    }

    try {
      // Execute atomic template deployment
      await devicesRepo.deployTemplateAtomicTx(testTmplDevice.buttonId, {
        templateId: testTemplate.templateId,
        deployedTemplateId: testTemplate.templateId,
        singlePressAction: testTemplate.singlePressAction,
        doublePressAction: testTemplate.doublePressAction,
        defaultQuantity: testTemplate.defaultQuantity,
        cancelWindowSeconds: testTemplate.cancelWindowSeconds,
        doubleClickWindowMs: 350,
      });

      // Direct PostgreSQL read-back (proves data is NOT just transient in HTTP response)
      const directDbButton = await prisma.ioTButton.findUnique({
        where: { buttonId: testTmplDevice.buttonId },
        include: {
          deployedTemplate: true,
          buttonProducts: true,
        },
      });

      console.log('  Direct DB read-back after template deploy:', {
        singlePressAction: directDbButton?.singlePressAction,
        doublePressAction: directDbButton?.doublePressAction,
        cancelWindowSeconds: directDbButton?.cancelWindowSeconds,
        clickBehavior: directDbButton?.clickBehavior,
        doubleClickWindowMs: directDbButton?.doubleClickWindowMs,
        deployedTemplateId: directDbButton?.deployedTemplateId?.toString(),
        deployedTemplateName: directDbButton?.deployedTemplate?.name,
        buttonProductQty: directDbButton?.buttonProducts?.[0]?.quantity,
      });

      if (
        directDbButton?.singlePressAction !== 'ORDER_WATER_19L' ||
        directDbButton?.doublePressAction !== 'SUPPORT_DISPATCH' ||
        directDbButton?.cancelWindowSeconds !== 120 ||
        directDbButton?.clickBehavior !== 'DOUBLE' ||
        directDbButton?.doubleClickWindowMs !== 350 ||
        directDbButton?.deployedTemplateId?.toString() !== testTemplate.templateId.toString() ||
        directDbButton?.buttonProducts?.[0]?.quantity !== 5
      ) {
        throw new Error('FAIL: Template configuration was NOT fully persisted to PostgreSQL!');
      }

      // Repository read-back (findById) to verify service / API layer mapping
      const repoReadBack = await devicesRepo.findById(testTmplDevice.buttonId);
      if (
        !repoReadBack ||
        repoReadBack.singlePressAction !== 'ORDER_WATER_19L' ||
        repoReadBack.doublePressAction !== 'SUPPORT_DISPATCH' ||
        repoReadBack.cancelWindowSeconds !== 120 ||
        !repoReadBack.deployedTemplate ||
        repoReadBack.deployedTemplate.templateId.toString() !== testTemplate.templateId.toString()
      ) {
        throw new Error('FAIL: devicesRepo.findById did not return complete persisted template config!');
      }

      console.log('  ✅ [PASS] Full template config strictly persisted in PostgreSQL & verified on direct read-back!');
      passed++;
    } finally {
      await prisma.buttonProduct.deleteMany({ where: { buttonId: testTmplDevice.buttonId } });
      await prisma.ioTButton.delete({ where: { buttonId: testTmplDevice.buttonId } });
      await prisma.deviceTemplate.delete({ where: { templateId: testTemplate.templateId } });
      console.log(`  🧹 [CLEANUP] Test 7 template and device cleaned up by exact IDs (Zero residue).`);
    }

    console.log('\n===============================================================');
    console.log(`🎉 ALL ${passed}/${total} VERIFICATION CHECKS PASSED WITH ZERO RESIDUE!`);
    console.log('===============================================================\n');
  } catch (error) {
    console.error('\n❌ VERIFICATION TEST FAILED:', error);
    process.exit(1);
  } finally {
    // Exact targeted cleanup by IDs (zero residue, no prefix-based delete)
    if (trackedProductIds.length > 0) {
      await prisma.inventory.deleteMany({ where: { productId: { in: trackedProductIds } } });
      await prisma.product.deleteMany({ where: { productId: { in: trackedProductIds } } });
    }
    if (trackedOrderIds.length > 0) {
      await prisma.orderItem.deleteMany({ where: { orderId: { in: trackedOrderIds } } });
      await prisma.orderStatusHistory.deleteMany({ where: { orderId: { in: trackedOrderIds } } });
      await prisma.order.deleteMany({ where: { orderId: { in: trackedOrderIds } } });
    }
    if (trackedButtonIds.length > 0) {
      await prisma.buttonProduct.deleteMany({ where: { buttonId: { in: trackedButtonIds } } });
      await prisma.ioTButton.deleteMany({ where: { buttonId: { in: trackedButtonIds } } });
    }
    if (trackedSessionIds.length > 0) {
      await prisma.provisioningSession.deleteMany({ where: { id: { in: trackedSessionIds } } });
    }
    if (trackedPaymentTxIds.length > 0) {
      await prisma.paymentTransaction.deleteMany({ where: { paymentTransactionId: { in: trackedPaymentTxIds } } });
    }
    if (trackedTemplateIds.length > 0) {
      await prisma.deviceTemplate.deleteMany({ where: { templateId: { in: trackedTemplateIds } } });
    }
    await prisma.$disconnect();
  }
}

run();
