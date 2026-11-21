import assert from 'node:assert';
import 'reflect-metadata';
import { Reflector } from '@nestjs/core';
import { ForbiddenException, BadRequestException, ConflictException } from '@nestjs/common';
import { ROLES_KEY } from '../src/common/decorators/roles.decorator';
import { OrdersController } from '../src/orders/orders.controller';
import { MediaController } from '../src/media/media.controller';
import { DriversController } from '../src/drivers/drivers.controller';
import { DriverShiftsController } from '../src/driver-shifts/driver-shifts.controller';
import { StoreDriverShiftsController } from '../src/driver-shifts/store-driver-shifts.controller';
import { OrdersService } from '../src/orders/orders.service';
import { OrdersRepository } from '../src/orders/orders.repository';
import { DriverShiftsService } from '../src/driver-shifts/driver-shifts.service';

async function run() {
  console.log('🧪 Running Step 5 Verification Suite: Store Owner Delivery, POD & Legacy Shipper/COD Handover...');
  const reflector = new Reflector();
  let passed = 0;

  // 1. Controller @Roles Metadata: STORE_OWNER allowed, legacy delivery/staff roles & SYSTEM_STAFF strictly excluded
  {
    const orderDeliveryMethods = [
      'getDeliveryQueue',
      'getDriverOrders',
      'claimOrder',
      'takeoverDelivery',
      'deliverOrder',
      'failDelivery',
      'updateStatus',
    ];
    for (const m of orderDeliveryMethods) {
      const roles: string[] = reflector.get(ROLES_KEY, (OrdersController.prototype as any)[m]) || [];
      assert.ok(roles.includes('STORE_OWNER'), `OrdersController.${m} must allow STORE_OWNER`);
      assert.ok(!roles.includes('SYSTEM_STAFF'), `OrdersController.${m} must NOT allow SYSTEM_STAFF`);
      for (const dep of ['STAFF_DELIVERY', 'STORE_MANAGER', 'STAFF_ORDER', 'STORE_STAFF', 'DRIVER']) {
        assert.ok(!roles.includes(dep), `OrdersController.${m} must NOT allow deprecated role ${dep}`);
      }
    }

    for (const m of ['uploadPodImage', 'getPodPresignedUpload']) {
      const roles: string[] = reflector.get(ROLES_KEY, (MediaController.prototype as any)[m]) || [];
      assert.ok(roles.includes('STORE_OWNER'), `MediaController.${m} must allow STORE_OWNER`);
      assert.ok(!roles.includes('STAFF_DELIVERY'), `MediaController.${m} must NOT allow STAFF_DELIVERY`);
      assert.ok(!roles.includes('SYSTEM_STAFF'), `MediaController.${m} must NOT allow SYSTEM_STAFF`);
    }

    for (const m of ['updateDuty', 'getMyDuty', 'getMyDeliverySummary', 'getOnlineDrivers']) {
      const roles: string[] = reflector.get(ROLES_KEY, (DriversController.prototype as any)[m]) || [];
      assert.ok(roles.includes('STORE_OWNER'));
      assert.ok(!roles.includes('STAFF_DELIVERY'));
    }

    for (const m of ['startShift', 'getCurrentShift', 'getShiftHistory', 'getShiftById', 'closeShift', 'confirmHandover']) {
      const roles: string[] = reflector.get(ROLES_KEY, (DriverShiftsController.prototype as any)[m]) || [];
      assert.ok(roles.includes('STORE_OWNER'));
      assert.ok(!roles.includes('STAFF_DELIVERY'));
      assert.ok(!roles.includes('STORE_MANAGER'));
    }

    for (const m of ['getStoreShifts', 'getLegacyHandoverStatus', 'settleLegacyHandover']) {
      const roles: string[] = reflector.get(ROLES_KEY, (StoreDriverShiftsController.prototype as any)[m]) || [];
      assert.ok(roles.includes('STORE_OWNER'));
      assert.ok(!roles.includes('STAFF_ORDER'));
      assert.ok(!roles.includes('STORE_MANAGER'));
    }

    passed++;
    console.log('  ✔ [PASS] Delivery, POD & Shift endpoints authorize STORE_OWNER and strip deprecated shipper/staff roles');
  }

  // 2. OrdersService & Repository: BOLA store check & missing storeId blocked; Store Owner can claim, takeover, deliver, fail & view POD
  {
    const mockOrdersService = new OrdersService(
      {
        findOrderById: async (id: bigint) => ({
          orderId: id,
          storeId: BigInt(10),
          customerId: BigInt(5),
          orderStatus: 'DELIVERED',
          podImageUrl: 'stores/10/pod/proof.jpg',
        }),
      } as any,
      { emitToStore: () => {}, emitToCustomer: () => {} } as any,
    );

    // Missing storeId on STORE_OWNER must throw ForbiddenException (no unscoped queue leak)
    await assert.rejects(
      () => mockOrdersService.getDeliveryQueue({ userId: '1', role: 'STORE_OWNER', storeId: null }),
      (err: any) => err instanceof ForbiddenException,
    );
    await assert.rejects(
      () => mockOrdersService.getPodViewUrl('50', { userId: '1', role: 'STORE_OWNER', storeId: '99' }),
      (err: any) => err instanceof ForbiddenException,
    );
    await assert.rejects(
      () => mockOrdersService.getPodViewUrl('50', { userId: '1', role: 'SYSTEM_STAFF', storeId: null }),
      (err: any) => err instanceof ForbiddenException,
    );

    // Repository takeoverShippingOrderTx & completeDeliveryAtomicTx store isolation
    let dbAssignedDriverId = BigInt(888); // legacy shipper userId
    const txOrderPrisma: any = {
      $transaction: async (cb: any) =>
        cb({
          $queryRawUnsafe: async () => [
            {
              order_id: BigInt(50),
              store_id: BigInt(10),
              order_status: 'SHIPPING',
              assigned_driver_id: dbAssignedDriverId,
              shipping_latitude: null,
              shipping_longitude: null,
              payment_method: 'COD',
              payment_status: 'UNPAID',
              total_amount: 150000,
              customer_id: BigInt(5),
            },
          ],
          $executeRawUnsafe: async (sql: string, ...args: any[]) => {
            if (sql.includes('SET assigned_driver_id = $1')) {
              dbAssignedDriverId = args[0];
            }
            return 1;
          },
          order: {
            findUnique: async () => ({
              orderId: BigInt(50),
              orderCode: 'ORD-50',
              storeId: BigInt(10),
              customerId: BigInt(5),
              assignedDriverId: dbAssignedDriverId,
              orderStatus: 'SHIPPING',
              paymentMethod: 'COD',
              paymentStatus: 'UNPAID',
              totalAmount: 150000,
              subtotalAmount: 150000,
              shippingFee: 0,
              discountAmount: 0,
              items: [],
              customer: { userId: BigInt(5) },
            }),
            update: async ({ data }: any) => data,
          },
        }),
    };
    const ordersRepo = new OrdersRepository(txOrderPrisma);

    // Cross-store Store Owner B blocked from taking over or delivering Store 10's order
    await assert.rejects(
      () => ordersRepo.takeoverShippingOrderTx(BigInt(50), BigInt(99), BigInt(2), false),
      (err: any) => err instanceof ForbiddenException,
    );
    await assert.rejects(
      () => ordersRepo.completeDeliveryAtomicTx(BigInt(50), { userId: '2', role: 'STORE_OWNER', storeId: '99' }, { podObjectKey: 'stores/10/pod/x.jpg' } as any),
      (err: any) => err instanceof ForbiddenException,
    );
    await assert.rejects(
      () => ordersRepo.failDeliveryAtomicTx(BigInt(50), { userId: '2', role: 'STORE_OWNER', storeId: '99' }, { evidenceImageUrl: 'https://x/img.jpg', failureReasonCode: 'NO_ANSWER' } as any),
      (err: any) => err instanceof ForbiddenException,
    );

    // Same-store Store Owner A (storeId 10) successfully takes over in-flight order from legacy shipper 888
    const reclaimed = await ordersRepo.takeoverShippingOrderTx(BigInt(50), BigInt(10), BigInt(1), false);
    assert.strictEqual(reclaimed?.assignedDriverId?.toString(), '1');

    passed++;
    console.log('  ✔ [PASS] Store Owner delivery/POD/takeover enforces strict storeId BOLA and supports reclaiming legacy orders');
  }

  // 3. MediaController POD upload & presigned upload strict store checks for STORE_OWNER
  {
    const mediaCtrl = new MediaController(
      { uploadImageBuffer: async () => ({ url: 'https://cdn/test.jpg', publicId: 'p1' }) } as any,
      {
        generatePresignedUploadUrl: async ({ folder }: any) => ({
          uploadUrl: 'https://r2/presigned',
          objectKey: `${folder}/file.jpg`,
          expiresAt: new Date().toISOString(),
        }),
      } as any,
      {} as any,
      {
        order: {
          findUnique: async () => ({
            orderId: BigInt(60),
            storeId: BigInt(10),
            orderStatus: 'SHIPPING',
          }),
        },
      } as any,
    );

    await assert.rejects(
      () =>
        mediaCtrl.uploadPodImage(
          { originalname: 'a.jpg', buffer: Buffer.from('abc') } as any,
          '60',
          { user: { userId: '2', role: 'STORE_OWNER', storeId: '99' } },
        ),
      (err: any) => err instanceof ForbiddenException,
    );

    const podUploadRes = await mediaCtrl.uploadPodImage(
      { originalname: 'pod.jpg', buffer: Buffer.from('abc') } as any,
      '60',
      { user: { userId: '1', role: 'STORE_OWNER', storeId: '10' } },
    );
    assert.strictEqual(podUploadRes.success, true);
    assert.strictEqual(podUploadRes.data.podFolder, 'stores/10/pod');

    const presigned = await mediaCtrl.getPodPresignedUpload(
      { orderId: '60', mimeType: 'image/jpeg', fileSize: 1024 } as any,
      { user: { userId: '1', role: 'STORE_OWNER', storeId: '10' } },
    );
    assert.strictEqual(presigned.success, true);

    passed++;
    console.log('  ✔ [PASS] MediaController allows same-store STORE_OWNER POD upload/presign and blocks cross-store BOLA');
  }

  // 4. DriverShiftsService: STORE_OWNER can close open legacy shift, settle COD on confirmHandover & bulk reconcile
  {
    const shiftsState = [
      {
        shiftId: BigInt(101),
        storeId: BigInt(10),
        driverId: BigInt(888),
        status: 'OPEN',
        startedAt: new Date(Date.now() - 3600_000),
        endedAt: null as Date | null,
        handedOverAt: null as Date | null,
        confirmedByUserId: null as bigint | null,
        handoverCode: 'HO-101',
        totalOrdersDelivered: 0,
        totalOrdersFailed: 0,
        totalCodCollected: 0,
        totalVietqrCollected: 0,
        handoverNote: null as string | null,
        createdAt: new Date(),
      },
      {
        shiftId: BigInt(102),
        storeId: BigInt(10),
        driverId: BigInt(889),
        status: 'CLOSED',
        startedAt: new Date(Date.now() - 7200_000),
        endedAt: new Date(Date.now() - 1800_000),
        handedOverAt: null as Date | null,
        confirmedByUserId: null as bigint | null,
        handoverCode: 'HO-102',
        totalOrdersDelivered: 1,
        totalOrdersFailed: 0,
        totalCodCollected: 90000,
        totalVietqrCollected: 0,
        handoverNote: null as string | null,
        createdAt: new Date(),
      },
    ];
    const inFlightOrders = [
      {
        orderId: BigInt(701),
        orderCode: 'ORD-701',
        storeId: BigInt(10),
        orderStatus: 'SHIPPING',
        paymentMethod: 'COD',
        totalAmount: 120000,
        assignedDriverId: BigInt(888),
      },
    ];
    let offlineDutiesCalled = false;

    const makeShiftClient = () => ({
      store: {
        findUnique: async () => ({ storeId: BigInt(10), ownerUserId: BigInt(1), name: 'Store 10' }),
      },
      driverShift: {
        findUnique: async ({ where }: any) => shiftsState.find((s) => s.shiftId === where.shiftId) || null,
        findMany: async ({ where }: any) =>
          shiftsState.filter((s) => {
            if (where?.storeId && s.storeId !== where.storeId) return false;
            if (typeof where?.status === 'string' && s.status !== where.status) return false;
            if (where?.status?.in && !where.status.in.includes(s.status)) return false;
            return true;
          }),
        update: async ({ where, data }: any) => {
          const idx = shiftsState.findIndex((s) => s.shiftId === where.shiftId);
          shiftsState[idx] = { ...shiftsState[idx], ...data };
          return shiftsState[idx];
        },
        updateMany: async ({ where, data }: any) => {
          let count = 0;
          for (let i = 0; i < shiftsState.length; i++) {
            const s = shiftsState[i];
            if (where?.shiftId !== undefined && s.shiftId !== where.shiftId) continue;
            if (typeof where?.status === 'string' && s.status !== where.status) continue;
            if (where?.status?.in && !where.status.in.includes(s.status)) continue;
            shiftsState[i] = { ...s, ...data };
            count++;
          }
          return { count };
        },
      },
      order: {
        findMany: async ({ where }: any) => {
          if (where?.orderStatus === 'SHIPPING') {
            return inFlightOrders.filter(
              (o) => o.orderStatus === 'SHIPPING' && o.assignedDriverId !== BigInt(1),
            );
          }
          // Delivered COD order on open shift 101 (driver 888)
          if (where?.assignedDriverId === BigInt(888)) {
            return [{ totalAmount: 250000, paymentMethod: 'COD' }];
          }
          return [];
        },
        count: async () => 0,
        updateMany: async ({ data }: any) => {
          let count = 0;
          for (const o of inFlightOrders) {
            if (o.orderStatus === 'SHIPPING' && o.assignedDriverId !== BigInt(1)) {
              o.assignedDriverId = data.assignedDriverId;
              count++;
            }
          }
          return { count };
        },
      },
      driverDuty: {
        updateMany: async () => {
          offlineDutiesCalled = true;
          return { count: 1 };
        },
      },
    });

    const shiftPrisma: any = {
      ...makeShiftClient(),
      $transaction: async (cb: any) => cb(makeShiftClient()),
    };
    const shiftsService = new DriverShiftsService(shiftPrisma);

    // Cross-store Store Owner B rejected from viewing or settling Store 10 legacy handover
    await assert.rejects(
      () => shiftsService.getLegacyHandoverSummary('10', { userId: '2', role: 'STORE_OWNER', storeId: '99' }),
      (err: any) => err instanceof ForbiddenException,
    );
    await assert.rejects(
      () => shiftsService.closeShift('101', { userId: '2', role: 'STORE_OWNER', storeId: '99' }),
      (err: any) => err instanceof ForbiddenException,
    );

    // Summary reports in-flight shipper order + open shift live COD (250k) + closed shift COD (90k) = 340k
    const summary = await shiftsService.getLegacyHandoverSummary('10', {
      userId: '1',
      role: 'STORE_OWNER',
      storeId: '10',
    });
    assert.strictEqual(summary.inFlightShipperOrders.length, 1);
    assert.strictEqual(summary.openShifts.length, 1);
    assert.strictEqual(summary.pendingHandoverClosedShifts.length, 1);
    assert.strictEqual(summary.pendingCodHandoverTotal, 340000);

    // Bulk settle reclaims in-flight SHIPPING order to Store Owner 1, closes+hands over both shifts with 340k COD
    const settled = await shiftsService.reconcileStoreLegacyShippers(
      '10',
      { userId: '1', role: 'STORE_OWNER', storeId: '10' },
      'Ban giao ca & COD cuoi giai doan shipper',
    );
    assert.strictEqual(settled.reclaimedShippingOrdersCount, 1);
    assert.strictEqual(settled.settledOpenShiftsCount, 1);
    assert.strictEqual(settled.settledClosedShiftsCount, 1);
    assert.strictEqual(settled.totalCodSettled, 340000);
    assert.strictEqual(inFlightOrders[0].assignedDriverId, BigInt(1));
    assert.strictEqual(shiftsState[0].status, 'HANDED_OVER');
    assert.strictEqual(shiftsState[0].totalCodCollected, 250000);
    assert.ok(shiftsState[0].endedAt instanceof Date);
    assert.strictEqual(offlineDutiesCalled, true);

    passed++;
    console.log('  ✔ [PASS] DriverShiftsService settles legacy SHIPPING orders, OPEN shifts & pending COD for STORE_OWNER');
  }

  // 5. Point 3 Regression: HANDED_OVER is terminal; concurrent closeShift cannot revert OPEN -> HANDED_OVER -> CLOSED
  {
    const raceShift: any = {
      shiftId: BigInt(999),
      storeId: BigInt(10),
      driverId: BigInt(888),
      status: 'OPEN',
      startedAt: new Date(Date.now() - 3600_000),
      endedAt: null,
      handedOverAt: null,
      confirmedByUserId: null,
      handoverCode: 'HO-999',
      totalOrdersDelivered: 0,
      totalOrdersFailed: 0,
      totalCodCollected: 0,
      totalVietqrCollected: 0,
      handoverNote: null,
      createdAt: new Date(),
    };

    const raceClient = (forceStaleCas = false) => ({
      driverShift: {
        findUnique: async () => ({ ...raceShift }),
        updateMany: async ({ where, data }: any) => {
          if (forceStaleCas) return { count: 0 };
          const allowed = typeof where.status === 'string' ? [where.status] : where.status?.in || [];
          if (!allowed.includes(raceShift.status)) return { count: 0 };
          Object.assign(raceShift, data);
          return { count: 1 };
        },
      },
      order: {
        findMany: async () => [{ totalAmount: 180000, paymentMethod: 'COD' }],
        count: async () => 0,
      },
    });

    const shiftRaceService = new DriverShiftsService({
      $transaction: async (cb: any) => cb({ $queryRaw: async () => [{ shift_id: BigInt(999), status: raceShift.status }], ...raceClient(false) }),
    } as any);

    // Confirm handover straight from OPEN -> captures 180k COD & finalizes status = HANDED_OVER
    const finalized = await shiftRaceService.confirmHandover(
      '999',
      { userId: '1', role: 'STORE_OWNER', storeId: '10' },
      { note: 'Handover confirmed' },
    );
    assert.strictEqual(finalized.status, 'HANDED_OVER');
    assert.strictEqual(finalized.totalCodCollected, 180000);

    // Calling closeShift AFTER HANDED_OVER MUST fail cleanly with ConflictException & NEVER revert to CLOSED
    await assert.rejects(
      () => shiftRaceService.closeShift('999', { userId: '888', role: 'STORE_OWNER', storeId: '10' }),
      (err: any) => err instanceof ConflictException && (err.getResponse() as any)?.code === 'SHIFT_ALREADY_HANDED_OVER',
    );
    assert.strictEqual(raceShift.status, 'HANDED_OVER');

    // Simulate overlapping request reading OPEN right before handover won the CAS -> CAS rejects stale write
    const staleCasService = new DriverShiftsService({
      $transaction: async (cb: any) =>
        cb({
          $queryRaw: async () => [{ shift_id: BigInt(999), status: 'OPEN' }],
          driverShift: {
            findUnique: async () => ({ ...raceShift, status: 'OPEN' }),
            updateMany: async () => ({ count: 0 }),
          },
          order: { findMany: async () => [], count: async () => 0 },
        }),
    } as any);
    await assert.rejects(
      () => staleCasService.closeShift('999', { userId: '888', role: 'STORE_OWNER', storeId: '10' }),
      (err: any) => err instanceof ConflictException && (err.getResponse() as any)?.code === 'SHIFT_STATE_CONFLICT',
    );

    passed++;
    console.log('  ✔ [PASS] HANDED_OVER is terminal: closeShift and stale CAS cannot revert shift back to CLOSED');
  }

  console.log(`\n🎉 ALL ${passed}/5 STEP-5 VERIFICATION GROUPS PASSED!\n`);
}

run().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
