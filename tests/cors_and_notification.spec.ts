import assert from 'node:assert';
import { NotificationsService } from '../src/notifications/notifications.service';

async function run() {
  console.log('🧪 Testing Task 1: Notification snake_case to camelCase formatting...');
  const service = new NotificationsService({} as any, {} as any, {} as any);

  const snakeRow = {
    notification_id: BigInt(123),
    user_id: BigInt(456),
    type: 'ORDER_STATUS_CHANGED',
    title: 'Đơn hàng mới',
    body: 'Bạn có đơn hàng mới',
    data: { orderId: '1' },
    idempotency_key: 'idem-123',
    read_at: null,
    created_at: new Date('2026-10-31T00:00:00.000Z'),
  };

  const formattedFromSnake = (service as any).formatNotification(snakeRow);
  assert.strictEqual(formattedFromSnake.notificationId, '123', 'notificationId should be 123');
  assert.strictEqual(formattedFromSnake.userId, '456', 'userId should be 456');
  assert.strictEqual(formattedFromSnake.idempotencyKey, 'idem-123', 'idempotencyKey should be idem-123');

  const camelRow = {
    notificationId: BigInt(789),
    userId: BigInt(101112),
    type: 'RENTAL_EXPIRED',
    title: 'Hết hạn thuê',
    body: 'Nút của bạn đã hết hạn',
    data: null,
    idempotencyKey: 'idem-456',
    readAt: null,
    createdAt: new Date('2026-10-31T00:00:00.000Z'),
  };

  const formattedFromCamel = (service as any).formatNotification(camelRow);
  assert.strictEqual(formattedFromCamel.notificationId, '789', 'notificationId should be 789');
  assert.strictEqual(formattedFromCamel.userId, '101112', 'userId should be 101112');
  assert.strictEqual(formattedFromCamel.idempotencyKey, 'idem-456', 'idempotencyKey should be idem-456');

  console.log('✅ Task 1 Notification tests PASSED!');
}

run().catch((err) => {
  console.error('❌ Test failed with error:', err.message);
  process.exit(1);
});
