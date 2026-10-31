import { RentalExpiryCronService } from '../src/rentals/rental-expiry-cron.service';
import { OrdersService } from '../src/orders/orders.service';
import { assertTestDatabase } from './test-db-guard';
import { BadRequestException } from '@nestjs/common';

async function runPhase4ExpiryAndOrderLockSuite() {
  process.env.TEST_DATABASE_URL = 'postgresql://postgres:postgres@localhost:5432/platform_button_rental_test';
  assertTestDatabase('Phase 4: Expiry Cron & Dual-Layer Order Lock');
  console.log('================================================================================');
  console.log('⚡ PHASE 4: DETERMINISTIC EXPIRY CRON & DUAL-LAYER ORDER LOCKING');
  console.log('================================================================================\n');

  let passed = 0;
  let failed = 0;

  const assert = (condition: boolean, testName: string, detail?: string) => {
    if (condition) {
      console.log(`  ✔ [PASS] ${testName}`);
      passed++;
    } else {
      console.error(`  ✖ [FAIL] ${testName}${detail ? ` -> ${detail}` : ''}`);
      failed++;
    }
  };

  const rentalsMap = new Map<string, any>();
  const buttonsMap = new Map<string, any>();
  const subscriptionsMap = new Map<string, any>();
  const auditLogs: any[] = [];
  const outboxEvents: any[] = [];

  // Setup store subscriptions:
  // Sub 1: Expired (end_date in past)
  subscriptionsMap.set('1', {
    subscription_id: BigInt(1),
    store_id: BigInt(88),
    end_date: new Date(Date.now() - 1000 * 60 * 60 * 2), // 2 hours ago
    status: 'ACTIVE',
  });
  // Sub 2: Active (end_date in future)
  subscriptionsMap.set('2', {
    subscription_id: BigInt(2),
    store_id: BigInt(99),
    end_date: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30),
    status: 'ACTIVE',
  });

  // Setup rentals:
  // Rental 1: Expired (effective_expires_at is in past)
  const pastDate = new Date(Date.now() - 1000 * 60 * 60); // 1 hour ago
  rentalsMap.set('1', {
    rental_id: BigInt(1),
    rental_code: 'RNT-EXPIRED-001',
    customer_id: BigInt(100),
    effective_expires_at: pastDate,
    status: 'ACTIVE',
  });

  // Rental 2: Still active (effective_expires_at is in future)
  const futureDate = new Date(Date.now() + 1000 * 60 * 60 * 24 * 10); // 10 days future
  rentalsMap.set('2', {
    rental_id: BigInt(2),
    rental_code: 'RNT-ACTIVE-002',
    customer_id: BigInt(200),
    effective_expires_at: futureDate,
    status: 'ACTIVE',
  });

  // Buttons:
  // Button 101 belongs to Rental 1
  buttonsMap.set('BTN-101', {
    buttonId: BigInt(101),
    buttonCode: 'BTN-101',
    deviceId: 'DEV-101',
    rentalId: BigInt(1),
    status: 'ACTIVE',
    inventoryState: 'IN_CUSTOMER_CUSTODY',
    canOrder: true,
    buttonProducts: [{ productId: BigInt(1) }],
    rental: rentalsMap.get('1'),
  });

  // Button 201 belongs to Rental 2
  buttonsMap.set('BTN-201', {
    buttonId: BigInt(201),
    buttonCode: 'BTN-201',
    deviceId: 'DEV-201',
    rentalId: BigInt(2),
    status: 'ACTIVE',
    inventoryState: 'IN_CUSTOMER_CUSTODY',
    canOrder: true,
    buttonProducts: [{ productId: BigInt(1) }],
    rental: rentalsMap.get('2'),
  });

  // Mock Prisma for RentalExpiryCronService
  const mockPrisma: any = {
    $transaction: async (cb: any) => {
      const tx = {
        $queryRawUnsafe: async (sql: string, now: Date, limit: number) => {
          if (sql.includes('FROM store_subscriptions')) {
            const matched: any[] = [];
            for (const s of subscriptionsMap.values()) {
              if (s.status === 'ACTIVE' && s.end_date <= now) {
                matched.push(s);
              }
            }
            return matched.slice(0, limit);
          }
          const matched: any[] = [];
          for (const r of rentalsMap.values()) {
            if (r.status === 'ACTIVE' && r.effective_expires_at <= now) {
              matched.push(r);
            }
          }
          return matched.slice(0, limit);
        },
        $executeRawUnsafe: async (sql: string, id: bigint) => {
          if (sql.includes('UPDATE button_rentals')) {
            const r = rentalsMap.get(id.toString());
            if (r) r.status = 'EXPIRED';
          } else if (sql.includes('UPDATE iot_button')) {
            for (const b of buttonsMap.values()) {
              if (b.rentalId === id) {
                b.canOrder = false;
                b.status = 'INACTIVE';
              }
            }
          } else if (sql.includes('UPDATE store_subscriptions')) {
            const s = subscriptionsMap.get(id.toString());
            if (s) s.status = 'EXPIRED';
          }
          return 1;
        },
        rentalAuditLog: {
          create: async (payload: any) => {
            auditLogs.push(payload.data);
            return payload.data;
          },
        },
        outboxEvent: {
          create: async (payload: any) => {
            outboxEvents.push(payload.data);
            return payload.data;
          },
        },
      };
      return cb(tx);
    },
  };

  const cronService = new RentalExpiryCronService(mockPrisma);

  try {
    // Test 1: Run expiry cron - should only expire Rental 1
    const cronResult = await cronService.processExpiredRentals(50);

    assert(
      cronResult.processedCount === 1 &&
        cronResult.expiredRentalIds.includes('1'),
      '4.1 Quét hợp đồng hết hạn thành công: chỉ khóa hợp đồng ACTIVE có effective_expires_at <= now, bỏ qua hợp đồng còn hạn',
    );

    // Test 2: Verify Rental 1 state -> EXPIRED and Button 101 canOrder -> false, status -> INACTIVE
    const r1 = rentalsMap.get('1');
    const b101 = buttonsMap.get('BTN-101');
    assert(
      r1.status === 'EXPIRED' &&
        b101.canOrder === false &&
        b101.status === 'INACTIVE',
      '4.2 Cập nhật hợp đồng sang EXPIRED, vô hiệu hóa quyền đặt hàng của nút (canOrder = false, status = INACTIVE)',
    );

    // Test 3: Rental 2 remains ACTIVE and its button canOrder remains true
    const r2 = rentalsMap.get('2');
    const b201 = buttonsMap.get('BTN-201');
    assert(
      r2.status === 'ACTIVE' &&
        b201.canOrder === true &&
        b201.status === 'ACTIVE',
      '4.3 Hợp đồng còn thời hạn thuê được giữ nguyên trạng thái ACTIVE và canOrder = true',
    );

    // Test 4: Audit log and Outbox event verification
    assert(
      auditLogs.some((a) => a.action === 'RENTAL_EXPIRED' && a.targetId.toString() === '1') &&
        outboxEvents.some((o) => o.eventType === 'RENTAL_EXPIRED' && o.payload.rentalId === '1'),
      '4.4 Ghi nhận đầy đủ RentalAuditLog RENTAL_EXPIRED và phát sinh Outbox event cho khách hàng',
    );

    // Test 5: Dual-Layer Order Lock - Ordering via button of expired rental is REJECTED fail-closed
    const mockOrdersRepo: any = {
      findButtonByIdentifier: async (ident: string) => {
        for (const b of buttonsMap.values()) {
          if (b.buttonCode === ident || b.deviceId === ident || b.buttonId.toString() === ident) {
            return b;
          }
        }
        return null;
      },
    };
    const ordersService = new OrdersService(
      mockOrdersRepo,
      null as any,
      null as any,
      null as any,
      null as any,
      null as any,
    );

    try {
      await ordersService.handleButtonEvent(
        { buttonCode: 'BTN-101', deviceId: 'DEV-101' },
        { eventType: 'SINGLE_PRESS', requestId: 'REQ-001' },
      );
      assert(false, '4.5 [Dual-Layer Order Lock] Chặn nút bấm đặt hàng khi hợp đồng thuê đã hết hạn');
    } catch (e: any) {
      assert(
        e instanceof BadRequestException &&
          (e.message.includes('hết hạn thuê') || e.message.includes('INACTIVE/LOCKED')),
        '4.5 [Dual-Layer Order Lock] Chặn nút bấm đặt hàng khi hợp đồng thuê đã hết hạn',
      );
    }

    // Test 6: Verify processExpiredStoreSubscriptions expires Sub 1 and leaves Sub 2 ACTIVE
    const subResult = await cronService.processExpiredStoreSubscriptions(50);
    const sub1 = subscriptionsMap.get('1');
    const sub2 = subscriptionsMap.get('2');
    const subOutbox = outboxEvents.filter((e) => e.eventType === 'STORE_SUBSCRIPTION_EXPIRED');

    assert(
      subResult.processedCount === 1 &&
        sub1.status === 'EXPIRED' &&
        sub2.status === 'ACTIVE' &&
        subOutbox.length === 1 &&
        subOutbox[0].payload.subscriptionId === '1',
      '4.6 [Store Subscription Expiry] Tự động quét và khóa gói duy trì gian hàng hết hạn, phát sự kiện STORE_SUBSCRIPTION_EXPIRED',
    );

  } catch (err: any) {
    console.error('Fatal test error in Phase 4 suite:', err);
    failed++;
  }

  console.log(`\n================================================================================`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log(`================================================================================\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

runPhase4ExpiryAndOrderLockSuite().catch((err) => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
