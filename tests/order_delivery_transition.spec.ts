import assert from 'node:assert';
import { OrdersService } from '../src/orders/orders.service';

async function run() {
  console.log('🧪 Testing Task 5: Delivery Order Status Transition Invariant...');

  const mockOrdersRepo = {
    findOrderById: async (id: bigint) => ({
      orderId: id,
      orderCode: 'ORD_TRANS_01',
      storeId: BigInt(1),
      customerId: BigInt(2),
      orderStatus: 'SHIPPING',
    }),
  };

  const ordersService = new OrdersService(
    mockOrdersRepo as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
  );

  const storeManagerUser = {
    role: 'STORE_MANAGER',
    storeId: '1',
    userId: BigInt(10),
  };

  // Test 1: Generic updateOrderStatus must NOT allow jumping to DELIVERED without completeDelivery POD workflow
  await assert.rejects(
    async () => {
      await ordersService.updateOrderStatus(BigInt(1), 'DELIVERED', storeManagerUser);
    },
    (err: any) => {
      assert.strictEqual(
        err.message.includes('complete-delivery') || err.message.includes('DELIVERED'),
        true,
        `Expected error about POD / complete-delivery requirement but got: ${err.message}`,
      );
      return true;
    },
    'Expected updateOrderStatus to reject transition to DELIVERED',
  );

  // Test 2: Generic updateOrderStatus must NOT allow jumping to DELIVERY_FAILED without failDelivery workflow
  await assert.rejects(
    async () => {
      await ordersService.updateOrderStatus(BigInt(1), 'DELIVERY_FAILED', storeManagerUser);
    },
    (err: any) => {
      assert.strictEqual(
        err.message.includes('chuyên dụng') || err.message.includes('DELIVERY_FAILED'),
        true,
        `Expected error about specialized workflow but got: ${err.message}`,
      );
      return true;
    },
    'Expected updateOrderStatus to reject transition to DELIVERY_FAILED',
  );

  console.log('✅ Task 5 Order Delivery Transition Invariant tests PASSED!');
}

run().catch((err) => {
  console.error('❌ Test failed with error:', err.message);
  process.exit(1);
});
