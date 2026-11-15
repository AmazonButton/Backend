import { OrdersService } from '../src/orders/orders.service';
import { OrdersRepository } from '../src/orders/orders.repository';
import { EventsGateway } from '../src/websocket/events.gateway';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';

async function runOrderRefundSuite() {
  console.log('================================================================================');
  console.log('⚡ ORDER CANCELLATION & REFUND (12-24H FLOW) TEST SUITE');
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

  // Mock Dependencies
  let mockOrders: Record<string, any> = {};
  let statusHistories: any[] = [];
  let emittedEvents: any[] = [];
  let dispatchedNotifications: any[] = [];

  const mockRepo = {
    findOrderById: async (id: bigint) => {
      const order = mockOrders[id.toString()];
      return order ? { ...order } : null;
    },
    refundOrderAtomicTx: async (orderId: bigint, note: string, changedByUserId?: bigint | null) => {
      const order = mockOrders[orderId.toString()];
      if (!order) throw new NotFoundException('Đơn hàng không tồn tại');
      order.paymentStatus = 'REFUNDED';
      statusHistories.push({
        orderId,
        oldStatus: order.orderStatus,
        newStatus: order.orderStatus,
        changedByUserId,
        reason: note,
      });
      return { ...order };
    },
  } as any;

  const mockGateway = {
    emitToStore: (storeId: string, event: string, payload: any) => {
      emittedEvents.push({ target: 'store', storeId, event, payload });
    },
    emitToCustomer: (customerId: string, event: string, payload: any) => {
      emittedEvents.push({ target: 'customer', customerId, event, payload });
    },
  } as any;

  const mockNotifications = {
    createAndDispatchNotification: async (params: any) => {
      dispatchedNotifications.push(params);
    },
  } as any;

  const mockCache = {
    invalidatePrefix: async () => {},
    invalidateKey: async () => {},
  } as any;

  const ordersService = new OrdersService(
    mockRepo,
    {} as any,
    mockGateway,
    {} as any,
    mockNotifications,
    mockCache,
  );

  try {
    // -------------------------------------------------------------------------
    // 1. ORDER NOT FOUND
    // -------------------------------------------------------------------------
    console.log('--- Test Section 1: Non-Existent Order ---');
    try {
      await ordersService.refundOrder(999999, { adminNote: 'Refund test' }, { role: 'SUPER_ADMIN' });
      assert(false, 'Should throw NotFoundException for non-existent order');
    } catch (err: any) {
      assert(err instanceof NotFoundException, 'Throws NotFoundException for invalid order ID');
    }

    // -------------------------------------------------------------------------
    // 2. BOLA TENANT ISOLATION CHECK
    // -------------------------------------------------------------------------
    console.log('\n--- Test Section 2: BOLA / Multi-Tenant Isolation ---');
    mockOrders['1001'] = {
      orderId: BigInt(1001),
      orderCode: 'ORD-1001',
      storeId: BigInt(1),
      customerId: BigInt(501),
      customer: { userId: BigInt(201) },
      orderStatus: 'CANCELLED',
      paymentStatus: 'REFUND_PENDING',
      totalAmount: 150000,
      paymentMethod: 'PAYOS',
    };

    // Store 2 user attempting to refund Store 1's order
    try {
      await ordersService.refundOrder(
        1001,
        { adminNote: 'Cross-tenant refund attempt' },
        { role: 'STORE_OWNER', storeId: '2', userId: '88' },
      );
      assert(false, 'Should block cross-tenant store owner from refunding another store order');
    } catch (err: any) {
      assert(err instanceof ForbiddenException, 'Blocks cross-store owner with ForbiddenException (BOLA guard)');
    }

    // -------------------------------------------------------------------------
    // 3. INVALID PAYMENT STATUS CHECK
    // -------------------------------------------------------------------------
    console.log('\n--- Test Section 3: Status Transition Guard ---');
    mockOrders['1002'] = {
      orderId: BigInt(1002),
      orderCode: 'ORD-1002',
      storeId: BigInt(1),
      customerId: BigInt(501),
      customer: { userId: BigInt(201) },
      orderStatus: 'CONFIRMED',
      paymentStatus: 'PAID', // Not REFUND_PENDING
      totalAmount: 200000,
      paymentMethod: 'PAYOS',
    };

    try {
      await ordersService.refundOrder(
        1002,
        { adminNote: 'Premature refund' },
        { role: 'STORE_OWNER', storeId: '1', userId: '10' },
      );
      assert(false, 'Should reject refund when paymentStatus is not REFUND_PENDING');
    } catch (err: any) {
      assert(err instanceof BadRequestException, 'Rejects refund when paymentStatus !== REFUND_PENDING');
    }

    // -------------------------------------------------------------------------
    // 4. SUCCESSFUL REFUND FLOW (STORE OWNER)
    // -------------------------------------------------------------------------
    console.log('\n--- Test Section 4: Valid Refund Flow (Store Owner) ---');
    const refundResult = await ordersService.refundOrder(
      1001,
      { refundReference: 'PAYOS-REF-998877', adminNote: 'Hoàn tiền online theo yêu cầu hủy của khách' },
      { role: 'STORE_OWNER', storeId: '1', userId: '10' },
    );

    assert(refundResult.paymentStatus === 'REFUNDED', 'Order paymentStatus updated to REFUNDED');
    assert(mockOrders['1001'].paymentStatus === 'REFUNDED', 'Database record updated atomically');
    assert(statusHistories.length === 1, 'Audit log created in orderStatusHistory');
    assert(statusHistories[0].reason.includes('PAYOS-REF-998877'), 'History records refund reference');

    // Check Realtime WebSockets
    const storeEvent = emittedEvents.find(e => e.event === 'ORDER_REFUNDED' && e.target === 'store');
    const customerEvent = emittedEvents.find(e => e.event === 'ORDER_REFUNDED' && e.target === 'customer');
    assert(!!storeEvent, 'Realtime ORDER_REFUNDED emitted to store');
    assert(!!customerEvent, 'Realtime ORDER_REFUNDED emitted to customer');

    // Check Customer Notification
    assert(dispatchedNotifications.length === 1, 'Notification dispatched to customer');
    assert(dispatchedNotifications[0].userId === BigInt(201), 'Notification target matches customer userId');
    assert(dispatchedNotifications[0].type === 'ORDER_REFUNDED', 'Notification type is ORDER_REFUNDED');

    // -------------------------------------------------------------------------
    // 5. IDEMPOTENT RE-EXECUTION
    // -------------------------------------------------------------------------
    console.log('\n--- Test Section 5: Idempotency Check ---');
    const repeatResult = await ordersService.refundOrder(
      1001,
      { refundReference: 'PAYOS-REF-998877' },
      { role: 'STORE_OWNER', storeId: '1', userId: '10' },
    );
    assert(repeatResult.paymentStatus === 'REFUNDED', 'Idempotent refund returns order without error');
    assert(statusHistories.length === 1, 'Does not duplicate history log on idempotent call');

    // -------------------------------------------------------------------------
    // 6. ADMIN OVERRIDE REFUND
    // -------------------------------------------------------------------------
    console.log('\n--- Test Section 6: Admin Authority Check ---');
    mockOrders['1003'] = {
      orderId: BigInt(1003),
      orderCode: 'ORD-1003',
      storeId: BigInt(99), // Store 99
      customerId: BigInt(502),
      customer: { userId: BigInt(202) },
      orderStatus: 'CANCELLED',
      paymentStatus: 'REFUND_PENDING',
      totalAmount: 350000,
      paymentMethod: 'PAYOS',
    };

    const adminResult = await ordersService.refundOrder(
      1003,
      { adminNote: 'Super Admin manual reconciliation refund' },
      { role: 'SUPER_ADMIN', userId: '1' },
    );
    assert(adminResult.paymentStatus === 'REFUNDED', 'SUPER_ADMIN can refund cross-store order cleanly');

  } catch (error: any) {
    console.error('Test execution failed:', error);
    failed++;
  }

  console.log('\n================================================================================');
  console.log(`SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log('================================================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runOrderRefundSuite();
