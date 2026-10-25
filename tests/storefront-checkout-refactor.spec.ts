import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000/api/v1';

function logTest(name: string, passed: boolean, detail?: string) {
  if (passed) {
    console.log(`\x1b[32m  ✔ [PASS]\x1b[0m ${name}`);
  } else {
    console.log(`\x1b[31m  ✖ [FAIL]\x1b[0m ${name}${detail ? ` -> ${detail}` : ''}`);
  }
}

async function runStorefrontCheckoutRefactorSuite() {
  console.log('\n========================================================================');
  console.log('🚀 SUITE: STOREFRONT CHECKOUT 6-LAYER REFACTOR TEST');
  console.log('========================================================================\n');

  let passed = 0;
  let failed = 0;

  let testStore: any = null;
  let testProduct: any = null;
  let originalReservedQuantity = 0;
  let createdOrderId: bigint | null = null;

  try {
    // 0. Setup test store and product fixtures
    testStore = await prisma.store.findFirst({
      where: { status: 'ACTIVE' },
    });

    if (!testStore) {
      testStore = await (prisma.store as any).create({
        data: {
          name: 'Storefront Refactor Test Store',
          code: `STORE-REF-${Date.now()}`,
          phone: '0901234567',
          address: '123 Storefront St',
          ownerId: 1n,
          status: 'ACTIVE',
        },
      });
    }

    testProduct = await prisma.product.create({
      data: {
        storeId: testStore.storeId,
        productCode: `P-REF-${Date.now()}`,
        productName: 'Storefront Refactor Test Product',
        basePrice: 50000,
        status: 'ACTIVE',
      },
    });

    await prisma.inventory.upsert({
      where: { productId: testProduct.productId },
      create: {
        storeId: testStore.storeId,
        productId: testProduct.productId,
        quantityOnHand: 20,
        reservedQuantity: 0,
        minStockAlert: 2,
      },
      update: {
        quantityOnHand: 20,
        reservedQuantity: 0,
        minStockAlert: 2,
      },
    });

    originalReservedQuantity = 0;

    // -------------------------------------------------------------------------
    // Test 1: Successful storefront order creation
    // -------------------------------------------------------------------------
    const orderPayload = {
      storeId: testStore.storeId.toString(),
      items: [
        {
          productId: testProduct.productId.toString(),
          quantity: 2,
        },
      ],
      customerName: 'Nguyễn Văn Test',
      customerPhone: '0912345678',
      deliveryAddress: '123 Đường Test, Quận 1, TP.HCM',
      paymentMethod: 'COD',
      orderNote: 'Giao giờ hành chính',
    };

    const res = await fetch(`${BASE_URL}/storefront/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(orderPayload),
    });

    const body = (await res.json()) as any;
    const isSuccess = res.status === 200 || res.status === 201;
    const hasEnvelope = body.success === true && body.message === 'Đặt hàng thành công' && body.data?.orderId;

    if (isSuccess && hasEnvelope) {
      logTest('1.1 Storefront Checkout: Returns uniform envelope with orderId and code (200/201)', true);
      passed++;
      createdOrderId = BigInt(body.data.orderId);
    } else {
      logTest('1.1 Storefront Checkout: Returns uniform envelope with orderId and code', false, `status=${res.status}, body=${JSON.stringify(body)}`);
      failed++;
    }

    // -------------------------------------------------------------------------
    // Test 2: Database state & inventory reservation check
    // -------------------------------------------------------------------------
    if (createdOrderId) {
      const dbOrder = await prisma.order.findUnique({
        where: { orderId: createdOrderId },
        include: { items: true },
      });

      const updatedInventory = await prisma.inventory.findUnique({
        where: { productId: testProduct.productId },
      });

      const orderValid = dbOrder?.orderStatus === 'PENDING' && dbOrder.items.length === 1 && Number(dbOrder.totalAmount) === 100000;
      const invValid = updatedInventory?.reservedQuantity === originalReservedQuantity + 2;

      if (orderValid && invValid) {
        logTest('1.2 Database State: Order created PENDING and inventory reserved by 2', true);
        passed++;
      } else {
        logTest('1.2 Database State: Order created PENDING and inventory reserved by 2', false, `orderValid=${orderValid}, invValid=${invValid}`);
        failed++;
      }
    }

    // -------------------------------------------------------------------------
    // Test 3: Invalid store ID rejected with 400
    // -------------------------------------------------------------------------
    const invalidStoreRes = await fetch(`${BASE_URL}/storefront/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...orderPayload,
        storeId: '99999999',
      }),
    });
    const invalidStoreBody = (await invalidStoreRes.json()) as any;
    if (invalidStoreRes.status === 400 && invalidStoreBody.success === false) {
      logTest('1.3 Validation Guard: Non-existent storeId rejected with 400 Bad Request', true);
      passed++;
    } else {
      logTest('1.3 Validation Guard: Non-existent storeId rejected with 400', false, `status=${invalidStoreRes.status}`);
      failed++;
    }

    // -------------------------------------------------------------------------
    // Test 4: Insufficient inventory rejected with 400
    // -------------------------------------------------------------------------
    const excessiveRes = await fetch(`${BASE_URL}/storefront/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...orderPayload,
        items: [{ productId: testProduct.productId.toString(), quantity: 9999 }],
      }),
    });
    const excessiveBody = (await excessiveRes.json()) as any;
    if (excessiveRes.status === 400 && excessiveBody.success === false) {
      logTest('1.4 Inventory Guard: Insufficient inventory quantity rejected with 400 Bad Request', true);
      passed++;
    } else {
      logTest('1.4 Inventory Guard: Insufficient inventory quantity rejected with 400', false, `status=${excessiveRes.status}`);
      failed++;
    }

  } catch (err: any) {
    console.error('Unexpected test error:', err);
    failed++;
  } finally {
    // Teardown
    console.log('\n🧹 Cleaning up test fixtures...');
    if (createdOrderId) {
      await prisma.orderStatusHistory.deleteMany({ where: { orderId: createdOrderId } });
      await prisma.orderItem.deleteMany({ where: { orderId: createdOrderId } });
      await prisma.order.deleteMany({ where: { orderId: createdOrderId } });
    }
    if (testProduct) {
      await prisma.inventory.deleteMany({ where: { productId: testProduct.productId } });
      await prisma.product.deleteMany({ where: { productId: testProduct.productId } });
    }
    await prisma.$disconnect();
    console.log('Cleanup complete.');
  }

  console.log('\n========================================================================');
  console.log(`📊 SUMMARY: PASSED: ${passed} | FAILED: ${failed}`);
  console.log('========================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runStorefrontCheckoutRefactorSuite();
