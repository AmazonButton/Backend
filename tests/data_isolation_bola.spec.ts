import assert from 'node:assert';
import { OrdersService } from '../src/orders/orders.service';
import { StoreMeResponseDto } from '../src/stores/dto/store-me-response.dto';
import { DevicesService } from '../src/devices/devices.service';

async function run() {
  console.log('🧪 Testing Task 4: Data Isolation & BOLA Protections...');

  // -------------------------------------------------------------
  // Test 1: BOLA check in cancelOrder must execute BEFORE checking orderStatus === 'CANCELLED'
  // -------------------------------------------------------------
  const mockOrdersRepo = {
    findOrderById: async (id: bigint) => ({
      orderId: id,
      orderCode: 'ORD_CANCELLED_99',
      customerId: BigInt(888),
      storeId: BigInt(777),
      orderStatus: 'CANCELLED',
      paymentStatus: 'UNPAID',
      createdAt: new Date(),
    }),
  };

  const ordersService = new OrdersService(
    mockOrdersRepo as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
  );

  const attackerUser = {
    userId: BigInt(999),
    role: 'CUSTOMER',
    customerProfileId: BigInt(999), // Different customer!
    storeId: null,
  };

  try {
    await ordersService.cancelOrder(BigInt(1), 'Attacker trying to view cancelled order', attackerUser);
    assert.fail('CRITICAL BOLA FLAW: Attacker was able to access cancelled order details!');
  } catch (err: any) {
    assert.strictEqual(
      err?.response?.code === 'ACCESS_DENIED' || err?.message?.includes('Bạn không có quyền') || err?.status === 403,
      true,
      `Expected Forbidden ACCESS_DENIED error but got: ${err.message}`,
    );
  }

  // -------------------------------------------------------------
  // Test 2: Store Staff must NOT see wallet balance in StoreMeResponseDto
  // -------------------------------------------------------------
  const mockStoreEntity = {
    storeId: BigInt(1),
    name: 'Test Store',
    code: 'TEST_01',
    phone: '0901234567',
    address: '123 Test St',
    status: 'ACTIVE',
    ownerUserId: BigInt(10),
    wallet: {
      balance: 50000000,
      frozenBalance: 2000000,
    },
  };

  const ownerDto = StoreMeResponseDto.fromEntity(mockStoreEntity, 'STORE_OWNER');
  assert.notStrictEqual(ownerDto.wallet, null, 'Owner must see wallet');
  assert.strictEqual(ownerDto.wallet?.balance, 50000000);

  const staffDto = StoreMeResponseDto.fromEntity(mockStoreEntity, 'STORE_STAFF');
  assert.strictEqual(
    staffDto.wallet,
    null,
    'SECURITY FLAW: Store staff was able to see store wallet balance!',
  );

  // -------------------------------------------------------------
  // Test 3: assignProduct must reject products not belonging to button store
  // -------------------------------------------------------------
  const mockDevicesRepo = {
    findByIdentifier: async () => ({
      buttonId: BigInt(1),
      deviceId: 'BTN_001',
      buttonCode: 'CODE_001',
      storeId: BigInt(10),
      customerId: BigInt(20),
    }),
    findActiveProductInStore: async (productId: bigint, storeId: bigint) => {
      // Product 99 belongs to store 999, not store 10!
      if (productId === BigInt(99) && storeId === BigInt(10)) {
        return null;
      }
      return { productId, storeId, productName: 'Valid Product' };
    },
    setButtonProducts: async () => {},
  };

  const devicesService = new DevicesService(
    mockDevicesRepo as any,
    {} as any,
  );
  (devicesService as any).invalidateDeviceCaches = async () => {};

  const storeOwnerUser = {
    role: 'STORE_OWNER',
    storeId: '10',
  };

  try {
    await devicesService.assignProduct(
      BigInt(1),
      { productId: 99 },
      storeOwnerUser,
    );
    assert.fail('CROSS-STORE SECURITY FLAW: Store was able to assign product belonging to another store!');
  } catch (err: any) {
    assert.strictEqual(
      err?.message?.includes('không thuộc cửa hàng') || err?.status === 400,
      true,
      `Expected cross-store assignment rejection but got: ${err.message}`,
    );
  }

  console.log('✅ Task 4 Data Isolation & BOLA tests PASSED!');
}

run().catch((err) => {
  console.error('❌ Test failed with error:', err.message);
  process.exit(1);
});
