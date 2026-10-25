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

async function runInventoryConcurrencyRaceSuite() {
  console.log('\n========================================================================');
  console.log('🚀 SUITE: INVENTORY CONCURRENCY & ROW-LOCKING RACE CONDITION TEST');
  console.log('========================================================================\n');

  let passed = 0;
  let failed = 0;

  let testStore: any = null;
  let testProduct: any = null;
  const createdOrderIds: bigint[] = [];

  try {
    // 0. Setup test store and product with EXACTLY 1 item in stock
    testStore = await prisma.store.findFirst({
      where: { status: 'ACTIVE' },
    });

    if (!testStore) {
      testStore = await (prisma.store as any).create({
        data: {
          name: 'Concurrency Test Store',
          code: `STORE-CONC-${Date.now()}`,
          phone: '0901234567',
          address: '123 Concurrency St',
          ownerId: 1n,
          status: 'ACTIVE',
        },
      });
    }

    testProduct = await prisma.product.create({
      data: {
        storeId: testStore.storeId,
        productCode: `P-CONC-${Date.now()}`,
        productName: 'Single Item Left Product',
        basePrice: 99000,
        status: 'ACTIVE',
      },
    });

    await prisma.inventory.upsert({
      where: { productId: testProduct.productId },
      create: {
        storeId: testStore.storeId,
        productId: testProduct.productId,
        quantityOnHand: 1, // Only 1 left!
        reservedQuantity: 0,
        minStockAlert: 1,
      },
      update: {
        quantityOnHand: 1, // Only 1 left!
        reservedQuantity: 0,
        minStockAlert: 1,
      },
    });

    const orderPayload = {
      storeId: testStore.storeId.toString(),
      items: [
        {
          productId: testProduct.productId.toString(),
          quantity: 1,
        },
      ],
      customerName: 'Khách Hàng Tranh Mua',
      customerPhone: '0988776655',
      deliveryAddress: '456 Phố Tranh Mua, Hà Nội',
      paymentMethod: 'COD',
      orderNote: 'Ai nhanh tay hơn',
    };

    // -------------------------------------------------------------------------
    // Phase 1: Fire 2 concurrent checkout requests for the last remaining item
    // -------------------------------------------------------------------------
    console.log('⚡ Firing 2 simultaneous checkout requests for the last remaining product (stock=1)...');

    const [res1, res2] = await Promise.all([
      fetch(`${BASE_URL}/storefront/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(orderPayload),
      }),
      fetch(`${BASE_URL}/storefront/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(orderPayload),
      }),
    ]);

    const body1 = (await res1.json()) as any;
    const body2 = (await res2.json()) as any;

    if (body1.data?.orderId) createdOrderIds.push(BigInt(body1.data.orderId));
    if (body2.data?.orderId) createdOrderIds.push(BigInt(body2.data.orderId));

    const status1 = res1.status;
    const status2 = res2.status;

    const oneSucceeded = (status1 === 200 || status1 === 201) !== (status2 === 200 || status2 === 201);
    const oneFailed = (status1 === 400) !== (status2 === 400);

    if (oneSucceeded && oneFailed) {
      logTest('1.1 Concurrency Race: Exactly 1 checkout succeeded and 1 failed with 400 Bad Request', true);
      passed++;
    } else {
      logTest('1.1 Concurrency Race: Exactly 1 checkout succeeded and 1 failed', false, `res1=${status1}, res2=${status2}, orders=${createdOrderIds.length}`);
      failed++;
    }

    // -------------------------------------------------------------------------
    // Phase 2: Database Invariant: Stock must not be oversold
    // -------------------------------------------------------------------------
    const updatedInventory = await prisma.inventory.findUnique({
      where: { productId: testProduct.productId },
    });

    const reserved = updatedInventory?.reservedQuantity || 0;
    const onHand = updatedInventory?.quantityOnHand || 0;
    const available = onHand - reserved;

    if (reserved === 1 && available === 0 && createdOrderIds.length === 1) {
      logTest('1.2 Inventory Invariant: Reserved quantity is exactly 1, available is 0, zero oversell', true);
      passed++;
    } else {
      logTest('1.2 Inventory Invariant: Reserved quantity is exactly 1, available is 0', false, `reserved=${reserved}, available=${available}, createdOrders=${createdOrderIds.length}`);
      failed++;
    }

  } catch (err: any) {
    console.error('Unexpected concurrency test error:', err);
    failed++;
  } finally {
    console.log('\n🧹 Cleaning up test fixtures...');
    for (const orderId of createdOrderIds) {
      await prisma.orderStatusHistory.deleteMany({ where: { orderId } });
      await prisma.orderItem.deleteMany({ where: { orderId } });
      await prisma.order.deleteMany({ where: { orderId } });
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

runInventoryConcurrencyRaceSuite();
