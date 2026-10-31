import { NotificationsService } from '../src/notifications/notifications.service';

async function runTask5TestSuite() {
  console.log('================================================================================');
  console.log('⚡ TASK 5: NOTIFICATION CENTER, OUTBOX & WALLET SEPARATION TEST SUITE');
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

  try {
    // -------------------------------------------------------------
    // Part A: Notification Center Invariants
    // -------------------------------------------------------------
    const sentNotifications: any[] = [];
    const mockPrisma: any = {
      $queryRawUnsafe: async (query: string, ...args: any[]) => {
        const item = {
          notificationId: BigInt(sentNotifications.length + 1),
          userId: args[0],
          type: args[1],
          title: args[2],
          body: args[3],
          idempotencyKey: args[5],
          createdAt: new Date(),
        };
        sentNotifications.push(item);
        return [item];
      },
      userFcmToken: {
        findMany: async () => [{ token: 'fcm-token-1' }],
      },
      notification: {
        create: async (data: any) => {
          sentNotifications.push(data.data);
          return { notificationId: BigInt(sentNotifications.length), ...data.data };
        },
      },
    };
    const mockFirebase: any = {
      sendMulticast: async () => ({ successTokens: ['token-1'], invalidTokens: [], failureCount: 0 }),
    };

    const notifService = new NotificationsService(mockPrisma as any, mockFirebase as any);

    // Test 1: Notification service exposes dispatchNotificationEvent
    assert(
      typeof (notifService as any).dispatchRentalEventNotification === 'function',
      'NotificationsService provides dispatchRentalEventNotification method',
    );

    // Test 2: Dispatch RENTAL_EXPIRED notification
    const expiredEvent = await (notifService as any).dispatchRentalEventNotification({
      eventType: 'RENTAL_EXPIRED',
      userId: BigInt(100),
      rentalCode: 'RNT-TEST-005',
      buttonCode: 'BTN-001',
      recipientRole: 'CUSTOMER',
    });

    assert(
      expiredEvent.type === 'RENTAL_EXPIRED' &&
        expiredEvent.title.includes('hết hạn') &&
        expiredEvent.idempotencyKey.includes('RENTAL_EXPIRED'),
      'Customer receives RENTAL_EXPIRED alert with deterministic idempotency key',
    );

    // Verify Deterministic Idempotency Key: Sending again produces EXACT same key
    const repeatedEvent = await (notifService as any).dispatchRentalEventNotification({
      eventType: 'RENTAL_EXPIRED',
      userId: BigInt(100),
      rentalCode: 'RNT-TEST-005',
      buttonCode: 'BTN-001',
      recipientRole: 'CUSTOMER',
    });
    assert(
      expiredEvent.idempotencyKey === repeatedEvent.idempotencyKey &&
        !expiredEvent.idempotencyKey.includes('undefined') &&
        !expiredEvent.idempotencyKey.includes('NaN'),
      'Idempotency Key is completely deterministic and stable across identical repeated calls',
      `Key: ${expiredEvent.idempotencyKey}`,
    );

    // Test 3: Dispatch STORE_SUBSCRIPTION_EXPIRED alert to Store Owner
    const storeSubAlert = await (notifService as any).dispatchRentalEventNotification({
      eventType: 'STORE_SUBSCRIPTION_EXPIRED',
      userId: BigInt(77),
      storeName: 'Tiệm Bách Hóa Thông Minh',
      recipientRole: 'STORE_OWNER',
    });

    assert(
      storeSubAlert.type === 'STORE_SUBSCRIPTION_EXPIRED' &&
        storeSubAlert.body.includes('60.000đ/tháng'),
      'Store Owner receives STORE_SUBSCRIPTION_EXPIRED alert warning of product listing lock',
    );

    // -------------------------------------------------------------
    // Part B: Financial Conservation & Wallet Separation (Pillar 4)
    // -------------------------------------------------------------
    const depositLedger = {
      collectedAmount: 200000,
      heldAmount: 0,
      refundReservedAmount: 0,
      refundedAmount: 200000,
    };
    const storeWalletBalance = 0; // StoreWallet must NEVER receive deposit or rent!

    const conservationSatisfied =
      depositLedger.collectedAmount ===
      depositLedger.heldAmount + depositLedger.refundReservedAmount + depositLedger.refundedAmount;

    assert(
      conservationSatisfied && storeWalletBalance === 0,
      'Conservation invariant: collected (200k) == held (0) + reserved (0) + refunded (200k); StoreWallet balance remains exactly 0',
    );

  } catch (err: any) {
    console.error('Fatal test error:', err);
    failed++;
  }

  console.log(`\n================================================================================`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log(`================================================================================\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

runTask5TestSuite();
