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

  // -------------------------------------------------------------
  // Test 4: Synchronized row-locking & cross-store invariant in setButtonProducts and remapStore
  // -------------------------------------------------------------
  let lockedButtonInSetProducts = false;
  let currentStoreId = BigInt(10);

  const mockPrismaForDevices = {
    $transaction: async (cb: any) => {
      const tx = {
        $queryRaw: async (query: any) => {
          const qStr = query.strings ? query.strings.join('') : String(query);
          if (qStr.includes('iot_button') && !qStr.includes('iot_buttons') && qStr.includes('FOR UPDATE')) {
            lockedButtonInSetProducts = true;
            return [{ button_id: BigInt(1), store_id: currentStoreId }];
          }
          return [];
        },
        product: {
          findMany: async (args: any) => {
            if (args.where.storeId === BigInt(10) && args.where.productId.in.includes(BigInt(101))) {
              return [{ productId: BigInt(101) }];
            }
            return [];
          },
        },
        buttonProduct: {
          deleteMany: async () => {},
          createMany: async () => {},
        },
        ioTButton: {
          update: async (args: any) => {
            currentStoreId = args.data.storeId;
            return { buttonId: BigInt(1), storeId: currentStoreId };
          },
          findUnique: async () => ({
            buttonId: BigInt(1),
            storeId: currentStoreId,
          }),
        },
        storeCustomer: {
          findFirst: async () => null,
          create: async () => {},
        },
      };
      return cb(tx);
    },
  };

  const realDevicesRepo = new (await import('../src/devices/devices.repository')).DevicesRepository(
    mockPrismaForDevices as any,
  );

  // 4.1. Mapping Store 10 product while button is at Store 10 succeeds
  await realDevicesRepo.setButtonProducts(BigInt(1), [{ productId: BigInt(101), quantity: 1 }]);
  assert.strictEqual(lockedButtonInSetProducts, true, 'setButtonProducts must lock iot_button FOR UPDATE first');

  // 4.2. Remap button to Store 20
  await realDevicesRepo.remapStore(BigInt(1), BigInt(20));
  assert.strictEqual(currentStoreId, BigInt(20));

  // 4.3. Now trying to map Store 10 product (101) to the button must be rejected!
  await assert.rejects(
    async () => {
      await realDevicesRepo.setButtonProducts(BigInt(1), [{ productId: BigInt(101), quantity: 1 }]);
    },
    (err: any) => {
      assert.strictEqual(
        err.message.includes('không thuộc cửa hàng') || err.status === 400,
        true,
        `Expected rejection of Store 10 product on Store 20 button, got: ${err.message}`,
      );
      return true;
    },
    'Expected setButtonProducts to reject products belonging to old store after remap',
  );

  console.log('✅ Task 4 Data Isolation & BOLA tests PASSED!');
}

run().catch((err) => {
  console.error('❌ Test failed with error:', err.message);
  process.exit(1);
});
