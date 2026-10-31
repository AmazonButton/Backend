import { OutboxConsumerService } from '../src/rentals/outbox-consumer.service';
import { NotificationsService } from '../src/notifications/notifications.service';
import { RentalsRepository } from '../src/rentals/rentals.repository';
import { assertTestDatabase } from './test-db-guard';

async function runPhase6OutboxAndNotificationsSuite() {
  process.env.TEST_DATABASE_URL = 'postgresql://postgres:postgres@localhost:5432/platform_button_rental_test';
  assertTestDatabase('Phase 6: Outbox & Notifications');
  console.log('================================================================================');
  console.log('⚡ PHASE 6: OUTBOX EVENT PRODUCERS & NOTIFICATION CENTER INVARIANTS');
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

  const dispatchedNotifications: any[] = [];
  const notificationsMap = new Map<string, any>();

  const mockNotifRepo: any = {
    createNotification: async (data: any) => {
      if (notificationsMap.has(data.idempotencyKey)) {
        return notificationsMap.get(data.idempotencyKey);
      }
      const record = {
        notificationId: BigInt(notificationsMap.size + 1),
        ...data,
        readAt: null,
        createdAt: new Date(),
      };
      notificationsMap.set(data.idempotencyKey, record);
      return record;
    },
    getUnreadCount: async () => notificationsMap.size,
  };

  const mockFirebaseService: any = {
    sendMulticast: async () => ({ successTokens: [], invalidTokens: [], failureCount: 0 }),
  };

  const mockPrismaNotif: any = {
    userFcmToken: {
      findMany: async () => [],
    },
  };

  const notificationsService = new NotificationsService(
    mockPrismaNotif,
    mockFirebaseService,
    mockNotifRepo,
  );

  // Mock Prisma for OutboxConsumer
  const outboxMap = new Map<string, any>();
  const deadLetterJobs: any[] = [];

  const mockPrismaOutbox: any = {
    depositRefund: {
      findUnique: async () => ({
        refundId: BigInt(701),
        amount: 150000,
        customer: { userId: BigInt(500) },
      }),
    },
    buttonRental: {
      findUnique: async () => ({
        rentalId: BigInt(10),
        rentalCode: 'RNT-2026-888',
        fulfillmentStoreId: BigInt(88),
        customer: { userId: BigInt(500) },
      }),
    },
    store: {
      findUnique: async () => ({
        storeId: BigInt(88),
        name: 'Store Quan 1',
        ownerUserId: BigInt(888),
      }),
    },
    deadLetterJob: {
      create: async (payload: any) => {
        deadLetterJobs.push(payload.data);
        return payload.data;
      },
    },
    $transaction: async (cb: any) => cb(mockPrismaOutbox),
    outboxEvent: {
      updateMany: async () => ({ count: 1 }),
    },
  };

  const outboxConsumer = new OutboxConsumerService(
    mockPrismaOutbox,
    null as any,
    notificationsService,
    null as any,
  );

  try {
    // Test 1: Process RENTAL_EXPIRED outbox event
    const expiredEvent = {
      id: BigInt(1),
      event_type: 'RENTAL_EXPIRED',
      payload: { rentalId: '10' },
      claimToken: 'token-1',
    };

    await (outboxConsumer as any).handleSingleEvent(expiredEvent);

    assert(
      notificationsMap.size === 1 &&
        Array.from(notificationsMap.values())[0].type === 'RENTAL_EXPIRED',
      '6.1 OutboxConsumerService xử lý sự kiện RENTAL_EXPIRED và tạo thông báo cho khách hàng',
    );

    // Test 2: Process DEPOSIT_REFUND_COMPLETED event
    const refundCompletedEvent = {
      id: BigInt(2),
      event_type: 'DEPOSIT_REFUND_COMPLETED',
      payload: { refundId: '701' },
      claimToken: 'token-2',
    };

    await (outboxConsumer as any).handleSingleEvent(refundCompletedEvent);

    assert(
      notificationsMap.size === 2 &&
        Array.from(notificationsMap.values()).some((n) => n.type === 'DEPOSIT_REFUND_COMPLETED'),
      '6.2 OutboxConsumerService xử lý sự kiện DEPOSIT_REFUND_COMPLETED và tạo thông báo hoàn cọc',
    );

    // Test 3: Process BILLING_CHARGE_SETTLED event
    const chargeSettledEvent = {
      id: BigInt(3),
      event_type: 'BILLING_CHARGE_SETTLED',
      payload: {
        purpose: 'RENTAL_INITIAL',
        targetId: '10',
        totalAmount: 230000,
      },
      claimToken: 'token-3',
    };

    await (outboxConsumer as any).handleSingleEvent(chargeSettledEvent);

    assert(
      notificationsMap.size === 3 &&
        Array.from(notificationsMap.values()).some((n) => n.type === 'PAYMENT_RECEIVED'),
      '6.3 OutboxConsumerService xử lý sự kiện BILLING_CHARGE_SETTLED và gửi thông báo thanh toán thành công',
    );

    // Test 4: Deterministic Idempotency Key - Replaying the exact same event does NOT duplicate notification card
    await (outboxConsumer as any).handleSingleEvent(expiredEvent);

    assert(
      notificationsMap.size === 3,
      '6.4 [Idempotency] IdempotencyKey sinh tất định (notif:eventId:recipientId:channel), ngăn chặn trùng lặp khi consumer replay',
    );

    // Test 5: Unknown event type is rejected fail-closed
    try {
      await (outboxConsumer as any).handleSingleEvent({
        id: BigInt(99),
        event_type: 'UNKNOWN_RANDOM_EVENT',
        payload: {},
      });
      assert(false, '6.5 [Fail-Closed] Sự kiện chưa đăng ký handler bị từ chối fail-closed');
    } catch (e: any) {
      assert(
        e.message.includes('Unhandled event type: UNKNOWN_RANDOM_EVENT'),
        '6.5 [Fail-Closed] Sự kiện chưa đăng ký handler bị từ chối fail-closed',
      );
    }

    // Test 6: Process RENTAL_RETURN_REQUESTED event -> Notifies Store Owner (User 888) and Customer (User 500)
    const returnRequestedEvent = {
      id: BigInt(4),
      event_type: 'RENTAL_RETURN_REQUESTED',
      payload: { rentalId: '10', returnId: '901', storeId: '88' },
      claimToken: 'token-4',
    };

    await (outboxConsumer as any).handleSingleEvent(returnRequestedEvent);

    const storeReturnNotif = Array.from(notificationsMap.values()).find(
      (n) => n.type === 'RENTAL_RETURN_REQUESTED' && n.userId.toString() === '888',
    );
    const customerReturnNotif = Array.from(notificationsMap.values()).find(
      (n) => n.type === 'RENTAL_RETURN_REQUESTED' && n.userId.toString() === '500',
    );

    assert(
      storeReturnNotif !== undefined && customerReturnNotif !== undefined,
      '6.6 OutboxConsumerService xử lý sự kiện RENTAL_RETURN_REQUESTED và thông báo cho Cửa hàng nhận trả thiết bị',
    );

    // Test 7: Process STORE_SUBSCRIPTION_EXPIRED event -> Notifies Store Owner (User 888)
    const storeExpiredEvent = {
      id: BigInt(5),
      event_type: 'STORE_SUBSCRIPTION_EXPIRED',
      payload: { storeId: '88', subscriptionId: '1' },
      claimToken: 'token-5',
    };

    await (outboxConsumer as any).handleSingleEvent(storeExpiredEvent);

    const storeExpiredNotif = Array.from(notificationsMap.values()).find(
      (n) => n.type === 'STORE_SUBSCRIPTION_EXPIRED' && n.userId.toString() === '888',
    );

    assert(
      storeExpiredNotif !== undefined,
      '6.7 OutboxConsumerService xử lý sự kiện STORE_SUBSCRIPTION_EXPIRED và gửi thông báo nhắc gia hạn cho chủ cửa hàng',
    );

    // Test 8: Producer createReturnRequestTx prioritizes fulfillmentStoreId over button.store_id
    let capturedOutboxEvent: any = null;
    const mockPrismaRepo: any = {
      $transaction: async (cb: any) => cb(mockPrismaRepo),
      $queryRawUnsafe: async (sql: string, ...params: any[]) => {
        if (sql.includes('FROM iot_button')) {
          return [{
            button_id: BigInt(701),
            rental_id: BigInt(10),
            store_id: BigInt(99), // Sales store ID
            custody_store_id: null,
            inventory_state: 'ASSIGNED_TO_RENTAL',
          }];
        }
        return [];
      },
      rentalReturn: {
        findFirst: async () => null,
        create: async () => ({
          returnId: BigInt(801),
          returnCode: 'RET-2026-001',
          rental: {
            fulfillmentStoreId: BigInt(88), // Fulfillment store ID (different from button.store_id 99)
            customerId: BigInt(500),
          },
        }),
      },
      ioTButton: {
        update: async () => ({}),
      },
      outboxEvent: {
        create: async (args: any) => {
          capturedOutboxEvent = args.data;
          return args.data;
        },
      },
    };

    const repoForProducer = new RentalsRepository(mockPrismaRepo);
    await repoForProducer.createReturnRequestTx(BigInt(10), BigInt(701));

    assert(
      capturedOutboxEvent !== null &&
        capturedOutboxEvent.eventType === 'RENTAL_RETURN_REQUESTED' &&
        capturedOutboxEvent.payload.storeId === '88' &&
        capturedOutboxEvent.payload.storeId !== '99',
      '6.8 [Return Producer Invariant] createReturnRequestTx ưu tiên fulfillmentStoreId (88) thay vì button.store_id (99)',
    );

  } catch (err: any) {
    console.error('Fatal test error in Phase 6 suite:', err);
    failed++;
  }

  console.log(`\n================================================================================`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log(`================================================================================\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

runPhase6OutboxAndNotificationsSuite().catch((err) => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
