import * as dotenv from 'dotenv';
dotenv.config();

import { PrismaService } from '../src/prisma/prisma.service';
import { OrdersService } from '../src/orders/orders.service';
import { OrdersRepository } from '../src/orders/orders.repository';
import { OrdersLifecycleWorker } from '../src/orders/orders-lifecycle.worker';
import { BadRequestException } from '@nestjs/common';

async function runOrderLifecycleSuite() {
  console.log('🧪 Starting Order Lifecycle, Auto-Confirmation & Inventory Safety Test Suite...');

  const prisma = new PrismaService();
  await prisma.$connect();

  const ordersRepo = new OrdersRepository(prisma);
  const mockNotifications = {
    sendPushNotification: async () => {},
    sendOrderStatusChanged: async () => {},
  } as any;
  const mockWallet = {} as any;
  const mockCrypto = {} as any;
  const mockWebSocketGateway = {
    emitToStore: () => {},
    emitToCustomer: () => {},
    server: {
      to: () => ({ emit: () => {} }),
      emit: () => {},
    },
  } as any;

  const ordersService = new OrdersService(
    ordersRepo,
    mockCrypto,
    mockWebSocketGateway,
    mockWallet,
    mockNotifications,
  );

  const lifecycleWorker = new OrdersLifecycleWorker(
    prisma,
    ordersRepo,
    ordersService,
    mockWebSocketGateway,
    mockNotifications,
  );

  let passed = 0;
  let failed = 0;

  const createdOrderIds: bigint[] = [];
  let testButton: any = null;
  let testStore: any = null;
  let testCustomerUser: any = null;
  let testCustomerProfile: any = null;
  let testProduct: any = null;
  let originalInventory: any = null;

  try {
    // 0. Setup Fixtures
    testStore = (await prisma.store.findFirst({ where: { products: { some: {} } } })) || (await prisma.store.findFirst());
    if (!testStore) throw new Error('No store found in database');

    testCustomerProfile = await prisma.customerProfile.findFirst({
      include: { user: true },
    });
    if (!testCustomerProfile) {
      throw new Error('No customer profile found in database');
    }
    testCustomerUser = {
      userId: testCustomerProfile.userId,
      role: 'CUSTOMER',
      customerProfileId: testCustomerProfile.customerId,
    };

    testProduct = await prisma.product.findFirst({
      where: { storeId: testStore.storeId },
    });
    if (!testProduct) throw new Error('No product found for store');

    // Get or create inventory for test product
    let inv = await prisma.inventory.findUnique({
      where: { productId: testProduct.productId },
    });
    if (!inv) {
      inv = await prisma.inventory.create({
        data: {
          storeId: testStore.storeId,
          productId: testProduct.productId,
          quantityOnHand: 100,
          reservedQuantity: 0,
          minStockAlert: 5,
        },
      });
    }
    originalInventory = {
      quantityOnHand: inv.quantityOnHand,
      reservedQuantity: inv.reservedQuantity,
    };

    // Ensure inventory has positive stock for testing
    await prisma.inventory.update({
      where: { productId: testProduct.productId },
      data: {
        quantityOnHand: 100,
        reservedQuantity: 10,
      },
    });

    // Create a dedicated IoT Button with cancelWindowSeconds = 60
    const uniqueDeviceId = `DEV-TEST-${Date.now()}`;
    const uniqueButtonCode = `BTN-TEST-${Date.now()}`;
    testButton = await prisma.ioTButton.create({
      data: {
        storeId: testStore.storeId,
        customerId: testCustomerProfile.customerId,
        deviceId: uniqueDeviceId,
        buttonCode: uniqueButtonCode,
        buttonName: 'Nút Test Lifecycle',
        hmacSecret: 'secret_test_key_order_lifecycle',
        status: 'ACTIVE',
        cancelWindowSeconds: 60,
      },
    });

    console.log(`✅ Setup completed. Test Button: ${testButton.buttonCode}, Product: ${testProduct.productId}`);

    // Helper to create an order
    const createTestOrder = async (orderCodePrefix: string, createdAt: Date, orderStatus: string = 'PENDING', quantity: number = 1) => {
      const order = await prisma.order.create({
        data: {
          orderCode: `ORD-${orderCodePrefix}-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
          storeId: testStore.storeId,
          customerId: testCustomerProfile.customerId,
          buttonId: testButton.buttonId,
          orderStatus,
          paymentStatus: 'UNPAID',
          paymentMethod: 'COD',
          subtotalAmount: 150000,
          discountAmount: 0,
          shippingFee: 0,
          totalAmount: 150000,
          commissionRate: 8.0,
          commissionAmount: 12000,
          netAmount: 138000,
          shippingRecipientName: 'Test Recipient',
          shippingPhone: '0901234567',
          shippingAddress: '123 Test St, TP.HCM',
          createdAt,
          items: {
            create: [
              {
                productId: testProduct.productId,
                productNameSnapshot: testProduct.productName,
                unitPriceSnapshot: 150000,
                finalUnitPrice: 150000,
                quantity,
                itemSubtotal: 150000 * quantity,
              },
            ],
          },
        },
      });
      createdOrderIds.push(order.orderId);
      return order;
    };

    // TEST 1: Customer cancels within cancel window (elapsed < 60s)
    console.log('\n--- Test 1: Customer Cancels Within 60s Window ---');
    try {
      const order1 = await createTestOrder('TST1', new Date());

      const cancelRes = await ordersService.cancelOrder(
        order1.orderId,
        'Customer changed mind in 10s',
        testCustomerUser,
      );

      if (cancelRes.orderStatus === 'CANCELLED') {
        console.log('✅ PASS: Order cancelled successfully within window');
        passed++;
      } else {
        console.error('❌ FAIL: Expected CANCELLED status, got', cancelRes.orderStatus);
        failed++;
      }
    } catch (err: any) {
      console.error('❌ FAIL: Test 1 threw error:', err.message);
      failed++;
    }

    // TEST 2: Customer attempts to cancel after cancel window expired (elapsed > 60s)
    console.log('\n--- Test 2: Customer Rejection After 60s Window Expired ---');
    try {
      const expiredDate = new Date(Date.now() - 120 * 1000); // 120s ago
      const order2 = await createTestOrder('TST2', expiredDate);

      let rejected = false;
      try {
        await ordersService.cancelOrder(
          order2.orderId,
          'Customer trying late cancel',
          testCustomerUser,
        );
      } catch (err: any) {
        if (err instanceof BadRequestException && err.message.includes('Đã hết thời gian cho phép hủy đơn hàng')) {
          rejected = true;
          console.log('✅ PASS: Rejected with correct BadRequestException:', err.message);
        } else {
          console.error('❌ FAIL: Threw unexpected error:', err.message);
        }
      }

      if (rejected) {
        passed++;
      } else {
        console.error('❌ FAIL: Expected late cancellation to be rejected, but it succeeded!');
        failed++;
      }
    } catch (err: any) {
      console.error('❌ FAIL: Test 2 setup error:', err.message);
      failed++;
    }

    // TEST 3: Privileged Staff (Store Owner) CAN cancel even if > 60s
    console.log('\n--- Test 3: Store Owner Can Cancel After 60s Window ---');
    try {
      const expiredDate = new Date(Date.now() - 120 * 1000);
      const order3 = await createTestOrder('TST3', expiredDate);

      const storeOwnerUser = {
        userId: BigInt(999),
        role: 'STORE_OWNER',
        storeId: testStore.storeId,
      };

      const staffCancelRes = await ordersService.cancelOrder(
        order3.orderId,
        'Store out of stock',
        storeOwnerUser,
      );

      if (staffCancelRes.orderStatus === 'CANCELLED') {
        console.log('✅ PASS: Store owner bypassed cancel window and cancelled successfully');
        passed++;
      } else {
        console.error('❌ FAIL: Expected CANCELLED status, got', staffCancelRes.orderStatus);
        failed++;
      }
    } catch (err: any) {
      console.error('❌ FAIL: Test 3 error:', err.message);
      failed++;
    }

    // TEST 4: Customer cannot cancel non-PENDING orders (e.g., CONFIRMED)
    console.log('\n--- Test 4: Customer Cannot Cancel CONFIRMED Order Even Within 60s ---');
    try {
      const order4 = await createTestOrder('TST4', new Date(), 'CONFIRMED');

      let rejectedNonPending = false;
      try {
        await ordersService.cancelOrder(
          order4.orderId,
          'Customer trying to cancel confirmed order',
          testCustomerUser,
        );
      } catch (err: any) {
        if (err instanceof BadRequestException && err.message.includes('chỉ có thể hủy đơn hàng khi đơn ở trạng thái PENDING')) {
          rejectedNonPending = true;
          console.log('✅ PASS: Customer rejected from cancelling CONFIRMED order');
        } else {
          console.error('❌ FAIL: Threw unexpected error:', err.message);
        }
      }

      if (rejectedNonPending) {
        passed++;
      } else {
        console.error('❌ FAIL: Expected cancel to be rejected for CONFIRMED status!');
        failed++;
      }
    } catch (err: any) {
      console.error('❌ FAIL: Test 4 error:', err.message);
      failed++;
    }

    // TEST 5: Auto-Confirmation Worker Transitions Overdue PENDING Orders
    console.log('\n--- Test 5: OrdersLifecycleWorker Auto-Confirms Overdue Orders ---');
    try {
      const timeRows = await prisma.$queryRawUnsafe<any[]>('SELECT NOW() as pg_now');
      const pgNow = new Date(timeRows[0].pg_now);
      const overdueDate = new Date(pgNow.getTime() - 90 * 1000); // 90s ago in PG timeline (> 60s)
      const freshDate = new Date(pgNow.getTime() + 60 * 1000); // fresh in PG timeline (< 60s elapsed)

      const overdueOrder = await createTestOrder('TST5-OVERDUE', overdueDate);
      const freshOrder = await createTestOrder('TST5-FRESH', freshDate);

      // Trigger the lifecycle worker tick
      await lifecycleWorker.autoConfirmPendingOrders();

      const checkedOverdue = await prisma.order.findUnique({
        where: { orderId: overdueOrder.orderId },
      });
      const checkedFresh = await prisma.order.findUnique({
        where: { orderId: freshOrder.orderId },
      });

      if (checkedOverdue?.orderStatus === 'CONFIRMED' && checkedFresh?.orderStatus === 'PENDING') {
        console.log('✅ PASS: Overdue order transitioned to CONFIRMED, fresh order remained PENDING');
        passed++;
      } else {
        console.error(
          `❌ FAIL: Overdue status: ${checkedOverdue?.orderStatus} (expected CONFIRMED), Fresh status: ${checkedFresh?.orderStatus} (expected PENDING)`,
        );
        failed++;
      }
    } catch (err: any) {
      console.error('❌ FAIL: Test 5 error:', err.message);
      failed++;
    }

    // TEST 6: Inventory Clamping & Safety under Inconsistent State
    console.log('\n--- Test 6: Inventory Clamping with GREATEST(0, ...) under Discrepancy ---');
    try {
      // Intentionally set reservedQuantity to 0 on inventory
      await prisma.inventory.update({
        where: { productId: testProduct.productId },
        data: {
          quantityOnHand: 50,
          reservedQuantity: 0,
        },
      });

      const discrepancyOrder = await createTestOrder('TST6-DISC', new Date(), 'PENDING', 5);

      // Cancel order with quantity=5 when reservedQuantity=0. Must NOT throw 400!
      await ordersRepo.cancelOrderAtomicTx(discrepancyOrder.orderId, 'Test safety clamping');

      const updatedInv = await prisma.inventory.findUnique({
        where: { productId: testProduct.productId },
      });

      if (updatedInv && updatedInv.reservedQuantity >= 0) {
        console.log(`✅ PASS: Clamping succeeded. reservedQuantity remains ${updatedInv.reservedQuantity} (>= 0) without 400 error`);
        passed++;
      } else {
        console.error('❌ FAIL: Inventory went negative:', updatedInv?.reservedQuantity);
        failed++;
      }
    } catch (err: any) {
      console.error('❌ FAIL: Test 6 threw unexpected error:', err.message);
      failed++;
    }

    // TEST 7: Seed active reservation aggregation & reconciliation query
    console.log('\n--- Test 7: Seed Active Reservation Reconciliation ---');
    try {
      await prisma.$executeRawUnsafe(`
        UPDATE inventory inv
        SET reserved_quantity = LEAST(
          inv.quantity_on_hand,
          COALESCE(
            (
              SELECT SUM(oi.quantity)::integer
              FROM order_item oi
              JOIN orders o ON oi.order_id = o.order_id
              WHERE oi.product_id = inv.product_id
                AND o.order_status IN ('PENDING', 'CONFIRMED', 'PREPARING', 'PROCESSING', 'READY_FOR_DELIVERY', 'SHIPPING')
            ),
            0
          )
        ),
        updated_at = NOW()
        WHERE inv.product_id = $1;
      `, testProduct.productId);

      const reconciledInv = await prisma.inventory.findUnique({
        where: { productId: testProduct.productId },
      });

      console.log(`✅ PASS: Reconciliation query executed smoothly. Reconciled reservedQuantity: ${reconciledInv?.reservedQuantity} (<= onHand: ${reconciledInv?.quantityOnHand})`);
      passed++;
    } catch (err: any) {
      console.error('❌ FAIL: Test 7 aggregation error:', err.message);
      failed++;
    }

  } finally {
    // CLEANUP BY EXACT IDS ONLY
    console.log('\n🧹 Performing Scoped Teardown (Exact IDs Only)...');
    try {
      if (createdOrderIds.length > 0) {
        await prisma.orderStatusHistory.deleteMany({
          where: { orderId: { in: createdOrderIds } },
        });
        await prisma.orderItem.deleteMany({
          where: { orderId: { in: createdOrderIds } },
        });
        await prisma.order.deleteMany({
          where: { orderId: { in: createdOrderIds } },
        });
        console.log(`🧹 Cleaned up ${createdOrderIds.length} test orders and associated items/histories`);
      }

      if (testButton) {
        await prisma.ioTButton.delete({
          where: { buttonId: testButton.buttonId },
        });
        console.log(`🧹 Cleaned up test button ${testButton.buttonCode}`);
      }

      if (originalInventory && testProduct) {
        await prisma.inventory.update({
          where: { productId: testProduct.productId },
          data: {
            quantityOnHand: originalInventory.quantityOnHand,
            reservedQuantity: originalInventory.reservedQuantity,
          },
        });
        console.log('🧹 Restored test product inventory to original state');
      }
    } catch (cleanupErr: any) {
      console.error('⚠️ Cleanup warning:', cleanupErr.message);
    }

    await prisma.$disconnect();
  }

  console.log(`\n==============================================`);
  console.log(`Order Lifecycle Test Results: ${passed} Passed, ${failed} Failed`);
  console.log(`==============================================\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

runOrderLifecycleSuite().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
