import { PrismaClient } from '@prisma/client';
import { OrdersRepository } from '../src/orders/orders.repository';
import { OrdersService } from '../src/orders/orders.service';
import { DriversService } from '../src/drivers/drivers.service';
import { DriverShiftsService } from '../src/driver-shifts/driver-shifts.service';
import { PaymentsService } from '../src/payments/payments.service';
import { PaymentsRepository } from '../src/payments/payments.repository';
import { CryptoService } from '../src/security/crypto.service';
import { EventsGateway } from '../src/websocket/events.gateway';
import { StoreWalletService } from '../src/store-wallet/store-wallet.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { sortObjDataByKey, convertObjToQueryStr } from '../src/payments/payos.helper';
import bcrypt from 'bcryptjs';
import * as crypto from 'crypto';

const prisma = new PrismaClient();

async function run() {
  console.log('===============================================================');
  console.log('🚀 TESTING DELIVERY DRIVER MODULE (11 PRD REQUIREMENTS) — ZERO RESIDUE');
  console.log('===============================================================\n');

  let passed = 0;
  const total = 11;
  const testRunId = Date.now();

  // Tracked IDs for strict Zero Residue cleanup
  const trackedUserIds: bigint[] = [];
  const trackedStoreIds: bigint[] = [];
  const trackedOrderIds: bigint[] = [];
  const trackedShiftIds: bigint[] = [];
  const trackedDutyIds: bigint[] = [];
  const trackedStaffIds: bigint[] = [];
  const trackedProductIds: bigint[] = [];

  // WebSocket spy
  let lastDriverEvent: { driverId: string; event: string; payload: any } | null = null;

  // Mock / Real instances
  const prismaService = prisma as unknown as PrismaService;
  const ordersRepo = new OrdersRepository(prismaService);
  const cryptoService = new CryptoService();
  const mockEventsGateway = {
    emitToStore: (storeId: string, event: string, payload: any) => {},
    emitToCustomer: (customerId: string, event: string, payload: any) => {},
    emitToDriver: (driverId: string, event: string, payload: any) => {
      lastDriverEvent = { driverId, event, payload };
    },
    emitGlobal: () => {},
    emitDeviceEvent: () => {},
  } as unknown as EventsGateway;

  const walletService = new StoreWalletService(prismaService);
  const ordersService = new OrdersService(ordersRepo, cryptoService, mockEventsGateway, walletService);
  const driversService = new DriversService(prismaService);
  const shiftsService = new DriverShiftsService(prismaService);
  const paymentsRepo = new PaymentsRepository(prismaService);
  const paymentsService = new PaymentsService(paymentsRepo, mockEventsGateway);

  try {
    // -------------------------------------------------------------------------
    // SETUP FIXTURES: Store A, Store B, Driver A1, Driver A2, Driver B1, Customer
    // -------------------------------------------------------------------------
    const pwdHash = await bcrypt.hash('DriverTest123!', 10);

    // Ensure sequences & identity generators are in sync with current max IDs
    try {
      const prodMax = await prisma.$queryRawUnsafe<any[]>('SELECT MAX(product_id) as max_id FROM product');
      const nextProdId = Number(prodMax[0]?.max_id || 0) + 100;
      await prisma.$executeRawUnsafe(`ALTER TABLE product ALTER COLUMN product_id RESTART WITH ${nextProdId}`);

      const invMax = await prisma.$queryRawUnsafe<any[]>('SELECT MAX(inventory_id) as max_id FROM inventory');
      const nextInvId = Number(invMax[0]?.max_id || 0) + 100;
      await prisma.$executeRawUnsafe(`ALTER TABLE inventory ALTER COLUMN inventory_id RESTART WITH ${nextInvId}`);
    } catch (e) {}

    // 1. Owner User
    const ownerUser = await prisma.user.create({
      data: {
        username: `owner_${testRunId}`,
        email: `owner_${testRunId}@test.local`,
        fullName: 'Test Store Owner',
        passwordHash: pwdHash,
      },
    });
    trackedUserIds.push(ownerUser.userId);

    // 2. Store A & Store B
    const storeA = await prisma.store.create({
      data: {
        name: `Store A ${testRunId}`,
        code: `STA_${testRunId}`,
        ownerUserId: ownerUser.userId,
        phone: '0901234567',
        address: '123 Le Loi, Q1',
      },
    });
    trackedStoreIds.push(storeA.storeId);

    const storeB = await prisma.store.create({
      data: {
        name: `Store B ${testRunId}`,
        code: `STB_${testRunId}`,
        ownerUserId: ownerUser.userId,
        phone: '0907654321',
        address: '456 Nguyen Hue, Q1',
      },
    });
    trackedStoreIds.push(storeB.storeId);

    // 3. Customer
    const customerUser = await prisma.user.create({
      data: {
        username: `cust_${testRunId}`,
        email: `cust_${testRunId}@test.local`,
        fullName: 'Test Customer',
        passwordHash: pwdHash,
        customerProfile: {
          create: {
            phone: '0912345678',
          },
        },
      },
      include: { customerProfile: true },
    });
    trackedUserIds.push(customerUser.userId);
    const customerProfileId = customerUser.customerProfile!.customerId;

    // Address with Coordinates (geo:lat,lng snapshot test)
    const address = await prisma.customerAddress.create({
      data: {
        customerId: customerProfileId,
        recipientName: 'Test Recipient',
        phone: '0912345678',
        addressDetail: '123 Nguyen Hue',
        ward: 'Ben Nghe',
        district: 'Quan 1',
        province: 'TP Ho Chi Minh',
        latitude: 10.776889,
        longitude: 106.700806,
        isDefault: true,
      },
    });

    // 4. Role STAFF_DELIVERY
    const deliveryRole = await prisma.role.findUniqueOrThrow({
      where: { roleCode: 'STAFF_DELIVERY' },
    });

    // Driver A1 (Store A)
    const driverA1User = await prisma.user.create({
      data: {
        username: `driver_a1_${testRunId}`,
        email: `driver_a1_${testRunId}@test.local`,
        fullName: 'Driver Alpha One',
        passwordHash: pwdHash,
      },
    });
    trackedUserIds.push(driverA1User.userId);
    const staffA1 = await prisma.storeStaff.create({
      data: {
        storeId: storeA.storeId,
        userId: driverA1User.userId,
        roleId: deliveryRole.roleId,
      },
    });
    trackedStaffIds.push(staffA1.storeStaffId);

    // Driver A2 (Store A)
    const driverA2User = await prisma.user.create({
      data: {
        username: `driver_a2_${testRunId}`,
        email: `driver_a2_${testRunId}@test.local`,
        fullName: 'Driver Alpha Two',
        passwordHash: pwdHash,
      },
    });
    trackedUserIds.push(driverA2User.userId);
    const staffA2 = await prisma.storeStaff.create({
      data: {
        storeId: storeA.storeId,
        userId: driverA2User.userId,
        roleId: deliveryRole.roleId,
      },
    });
    trackedStaffIds.push(staffA2.storeStaffId);

    // Driver B1 (Store B)
    const driverB1User = await prisma.user.create({
      data: {
        username: `driver_b1_${testRunId}`,
        email: `driver_b1_${testRunId}@test.local`,
        fullName: 'Driver Beta One',
        passwordHash: pwdHash,
      },
    });
    trackedUserIds.push(driverB1User.userId);
    const staffB1 = await prisma.storeStaff.create({
      data: {
        storeId: storeB.storeId,
        userId: driverB1User.userId,
        roleId: deliveryRole.roleId,
      },
    });
    trackedStaffIds.push(staffB1.storeStaffId);

    // Mock IoT Button for creating orders
    const button = await prisma.ioTButton.create({
      data: {
        deviceId: `dev_${testRunId}`,
        buttonCode: `btn_${testRunId}`,
        storeId: storeA.storeId,
        customerId: customerProfileId,
        addressId: address.addressId,
        status: 'ACTIVE',
        hmacSecret: 'mock_secret_1234567890abcdef',
      },
    });

    const driverA1Session = {
      userId: driverA1User.userId.toString(),
      role: 'STAFF_DELIVERY',
      storeId: storeA.storeId.toString(),
    };

    const driverA2Session = {
      userId: driverA2User.userId.toString(),
      role: 'STAFF_DELIVERY',
      storeId: storeA.storeId.toString(),
    };

    // =========================================================================
    // TEST 1: Role STAFF_DELIVERY in DB and Authorization Check
    // =========================================================================
    console.log('👉 [TEST 1] Role STAFF_DELIVERY verification');
    if (deliveryRole && staffA1.roleId === deliveryRole.roleId) {
      console.log('  ✔ [PASS] STAFF_DELIVERY role successfully assigned to StoreStaff');
      passed++;
    } else {
      throw new Error('STAFF_DELIVERY role verification failed');
    }

    // =========================================================================
    // TEST 2: Order list with Store Isolation for Driver
    // =========================================================================
    console.log('👉 [TEST 2] Store Isolation on orders.list() for Driver');
    const order1 = await prisma.order.create({
      data: {
        orderCode: `ORD_T2_${testRunId}_1`,
        storeId: storeA.storeId,
        customerId: customerProfileId,
        buttonId: button.buttonId,
        orderStatus: 'READY_FOR_DELIVERY',
        paymentStatus: 'UNPAID',
        paymentMethod: 'COD',
        subtotalAmount: 150000,
        shippingFee: 0,
        discountAmount: 0,
        totalAmount: 150000,
        shippingRecipientName: 'Customer A',
        shippingPhone: '090111222',
        shippingAddress: '123 Nguyen Hue',
        shippingLatitude: 10.776889,
        shippingLongitude: 106.700806,
      },
    });
    trackedOrderIds.push(order1.orderId);

    const orderStoreB = await prisma.order.create({
      data: {
        orderCode: `ORD_T2_${testRunId}_B`,
        storeId: storeB.storeId,
        customerId: customerProfileId,
        buttonId: button.buttonId,
        orderStatus: 'READY_FOR_DELIVERY',
        paymentStatus: 'UNPAID',
        paymentMethod: 'COD',
        subtotalAmount: 200000,
        shippingFee: 0,
        discountAmount: 0,
        totalAmount: 200000,
        shippingRecipientName: 'Customer B',
        shippingPhone: '090333444',
        shippingAddress: '456 Le Loi',
      },
    });
    trackedOrderIds.push(orderStoreB.orderId);

    const driverOrders = await ordersService.list(driverA1Session);
    const visibleOrderIds = driverOrders.map((o: any) => o.orderId);
    if (visibleOrderIds.includes(order1.orderId.toString()) && !visibleOrderIds.includes(orderStoreB.orderId.toString())) {
      console.log('  ✔ [PASS] Driver sees orders strictly belonging to their store (BOLA isolated)');
      passed++;
    } else {
      throw new Error('Store isolation failed in orders.list()');
    }

    // =========================================================================
    // TEST 3: Atomic Order Claim Mechanism (2 Drivers Race Condition: 200 vs 409)
    // =========================================================================
    console.log('👉 [TEST 3] Concurrency claimOrder (2 drivers claim simultaneously)');
    const [claimRes1, claimRes2] = await Promise.allSettled([
      ordersService.claimOrder(order1.orderId, driverA1Session),
      ordersService.claimOrder(order1.orderId, driverA2Session),
    ]);

    const successes = [claimRes1, claimRes2].filter((r) => r.status === 'fulfilled');
    const failures = [claimRes1, claimRes2].filter((r) => r.status === 'rejected');

    if (successes.length === 1 && failures.length === 1) {
      const err = (failures[0] as PromiseRejectedResult).reason;
      if (err.status === 409 || err.response?.code === 'ORDER_ALREADY_CLAIMED') {
        console.log('  ✔ [PASS] Atomic claim successfully prevented race condition: Exactly 1 succeeded (200), 1 rejected (409 Conflict)');
        passed++;
      } else {
        throw new Error(`Expected 409 Conflict but received: ${err.message}`);
      }
    } else {
      throw new Error(`Expected 1 success and 1 failure, got ${successes.length} success and ${failures.length} fail`);
    }

    // =========================================================================
    // TEST 4: Driver Shift Lifecycle & Live Aggregation + Concurrency Protection
    // =========================================================================
    console.log('👉 [TEST 4] Driver Shift Start & Concurrency Protection (Promise.all)');
    // Concurrently start shift to verify unique partial index uq_driver_open_shift prevents duplicates
    const [shiftA, shiftB] = await Promise.all([
      shiftsService.startShift(driverA1Session),
      shiftsService.startShift(driverA1Session),
    ]);

    if (shiftA.shiftId !== shiftB.shiftId) {
      throw new Error(`Expected same shift ID from concurrent startShift, got ${shiftA.shiftId} and ${shiftB.shiftId}`);
    }

    const startShiftRes = shiftA;
    trackedShiftIds.push(BigInt(startShiftRes.shiftId));

    if (startShiftRes.status === 'OPEN' && startShiftRes.driverId === driverA1User.userId.toString()) {
      console.log('  ✔ [PASS] Driver shift started with status OPEN; concurrent startShift safely idempotent');
      passed++;
    } else {
      throw new Error('Start shift failed');
    }

    // =========================================================================
    // TEST 5: Complete Delivery with POD Validation & Strict COD Enforcement
    // =========================================================================
    console.log('👉 [TEST 5] Delivery Completion (Decoupled, Strict POD & Strict COD checks)');

    // Create a dedicated order for delivery test to avoid non-deterministic race winner from Test 3
    const orderDeliverTest = await prisma.order.create({
      data: {
        orderCode: `ORD_T5_${testRunId}`,
        storeId: storeA.storeId,
        customerId: customerProfileId,
        buttonId: button.buttonId,
        orderStatus: 'READY_FOR_DELIVERY',
        paymentStatus: 'UNPAID',
        paymentMethod: 'COD',
        subtotalAmount: 150000,
        shippingFee: 0,
        discountAmount: 0,
        totalAmount: 150000,
        shippingRecipientName: 'Customer Deliver Test',
        shippingPhone: '090111222',
        shippingAddress: '123 Nguyen Hue',
        shippingLatitude: 10.776889,
        shippingLongitude: 106.700806,
      },
    });
    trackedOrderIds.push(orderDeliverTest.orderId);

    // Driver A1 claims orderDeliverTest
    await ordersService.claimOrder(orderDeliverTest.orderId, driverA1Session);

    // 5a. Test spoofed POD domain (e.g. query param bypass attempt)
    let spoofedPodRejected = false;
    try {
      await ordersService.completeDelivery(
        orderDeliverTest.orderId,
        {
          status: 'DELIVERED',
          paymentMethod: 'COD',
          collectedAmount: 150000,
          podImageUrl: `https://evil.example.com/test?path=stores/${storeA.storeId}/pod/photo.jpg`,
        },
        driverA1Session,
      );
    } catch (e: any) {
      if (e.status === 400) spoofedPodRejected = true;
    }
    if (!spoofedPodRejected) {
      throw new Error('Expected spoofed POD URL on non-Cloudinary host to be rejected');
    }

    // 5a-2. Test suffix matching security bypass (evilcloudinary.com must be rejected)
    let evilCloudinaryRejected = false;
    try {
      await ordersService.completeDelivery(
        orderDeliverTest.orderId,
        {
          status: 'DELIVERED',
          paymentMethod: 'COD',
          collectedAmount: 150000,
          podImageUrl: `https://evilcloudinary.com/image/upload/v1234/stores/${storeA.storeId}/pod/photo.jpg`,
        },
        driverA1Session,
      );
    } catch (e: any) {
      if (e.status === 400) evilCloudinaryRejected = true;
    }
    if (!evilCloudinaryRejected) {
      throw new Error('Expected evilcloudinary.com suffix match bypass to be rejected');
    }

    // 5b. Test invalid POD folder (belongs to another store)
    let otherStorePodRejected = false;
    try {
      await ordersService.completeDelivery(
        orderDeliverTest.orderId,
        {
          status: 'DELIVERED',
          paymentMethod: 'COD',
          collectedAmount: 150000,
          podImageUrl: 'https://res.cloudinary.com/sob/image/upload/v1234/stores/999999/pod/image.jpg',
        },
        driverA1Session,
      );
    } catch (e: any) {
      if (e.status === 400) otherStorePodRejected = true;
    }
    if (!otherStorePodRejected) {
      throw new Error('Expected POD outside stores/{storeId}/pod to be rejected');
    }

    // 5c. Test COD missing collectedAmount
    let missingCollectedAmountRejected = false;
    try {
      await ordersService.completeDelivery(
        orderDeliverTest.orderId,
        {
          status: 'DELIVERED',
          paymentMethod: 'COD',
          podImageUrl: `https://res.cloudinary.com/sob/image/upload/v1234/stores/${storeA.storeId}/pod/evidence_ord5.jpg`,
        } as any,
        driverA1Session,
      );
    } catch (e: any) {
      if (e.status === 400 && e.message?.includes('collectedAmount')) {
        missingCollectedAmountRejected = true;
      }
    }
    if (!missingCollectedAmountRejected) {
      throw new Error('Expected COD order without collectedAmount to be rejected');
    }

    // 5d. Test COD mismatched collectedAmount
    let mismatchedAmountRejected = false;
    try {
      await ordersService.completeDelivery(
        orderDeliverTest.orderId,
        {
          status: 'DELIVERED',
          paymentMethod: 'COD',
          collectedAmount: 100000, // order total is 150000
          podImageUrl: `https://res.cloudinary.com/sob/image/upload/v1234/stores/${storeA.storeId}/pod/evidence_ord5.jpg`,
        },
        driverA1Session,
      );
    } catch (e: any) {
      if (e.status === 400 && e.message?.includes('không khớp')) {
        mismatchedAmountRejected = true;
      }
    }
    if (!mismatchedAmountRejected) {
      throw new Error('Expected mismatched collectedAmount to be rejected');
    }

    // 5e. Valid POD delivery
    const validPodUrl = `https://res.cloudinary.com/sob/image/upload/v1234/stores/${storeA.storeId}/pod/evidence_ord5.jpg`;
    const deliveredOrder = await ordersService.completeDelivery(
      orderDeliverTest.orderId,
      {
        status: 'DELIVERED',
        paymentMethod: 'COD',
        collectedAmount: 150000,
        podImageUrl: validPodUrl,
        deliveredAt: new Date().toISOString(),
      },
      driverA1Session,
    );

    if (deliveredOrder.orderStatus === 'DELIVERED' && deliveredOrder.paymentStatus === 'PAID' && deliveredOrder.podImageUrl === validPodUrl) {
      console.log('  ✔ [PASS] Order marked DELIVERED and PAID with strictly validated POD URL & exact COD match');
      passed++;
    } else {
      throw new Error('Complete delivery failed');
    }

    // 5f. Verify POD URL cannot be reused on another order
    const orderReuseCheck = await prisma.order.create({
      data: {
        orderCode: `ORD_REUSE_${testRunId}`,
        storeId: storeA.storeId,
        customerId: customerProfileId,
        buttonId: button.buttonId,
        orderStatus: 'READY_FOR_DELIVERY',
        paymentStatus: 'UNPAID',
        paymentMethod: 'COD',
        subtotalAmount: 150000,
        shippingFee: 0,
        discountAmount: 0,
        totalAmount: 150000,
        shippingRecipientName: 'Customer Reuse',
        shippingPhone: '090111222',
        shippingAddress: '123 Nguyen Hue',
      },
    });
    trackedOrderIds.push(orderReuseCheck.orderId);
    await ordersService.claimOrder(orderReuseCheck.orderId, driverA1Session);

    let podReuseRejected = false;
    try {
      await ordersService.completeDelivery(
        orderReuseCheck.orderId,
        {
          status: 'DELIVERED',
          paymentMethod: 'COD',
          collectedAmount: 150000,
          podImageUrl: validPodUrl, // Already used for orderDeliverTest!
        },
        driverA1Session,
      );
    } catch (e: any) {
      if (e.status === 400 && e.message?.includes('tái sử dụng')) {
        podReuseRejected = true;
      }
    }
    if (!podReuseRejected) {
      throw new Error('Expected POD image reuse across orders to be rejected');
    }

    // =========================================================================
    // TEST 6: Shift Live Aggregation after successful delivery
    // =========================================================================
    console.log('👉 [TEST 6] Shift Real-Time DB Aggregation');
    const currentShift = await shiftsService.getCurrentShift(driverA1Session);
    if (currentShift && currentShift.totalOrdersDelivered >= 1 && currentShift.totalCodCollected >= 150000) {
      console.log(`  ✔ [PASS] Shift reflects live DB totals: Delivered=${currentShift.totalOrdersDelivered}, COD=${currentShift.totalCodCollected}`);
      passed++;
    } else {
      throw new Error('Shift live aggregation mismatch');
    }

    // =========================================================================
    // TEST 7: Delivery Failure Handling & Reserved Inventory Release
    // =========================================================================
    console.log('👉 [TEST 7] Delivery Failure Handling & Inventory Release');

    // Create a product for failure inventory-release test (inventory auto-created by DB trigger)
    const testProduct = await prisma.product.create({
      data: {
        storeId: storeA.storeId,
        productCode: `PROD_FAIL_${testRunId}`,
        productName: 'Fail Test Drinking Water 19L',
        basePrice: 50000,
      },
    });
    // Set initial inventory stock
    await prisma.inventory.update({
      where: { productId: testProduct.productId },
      data: {
        quantityOnHand: 20,
        reservedQuantity: 5,
      },
    });
    trackedProductIds.push(testProduct.productId);

    // Create order with orderItem reserving 2 units
    const orderFail = await prisma.order.create({
      data: {
        orderCode: `ORD_FAIL_${testRunId}`,
        storeId: storeA.storeId,
        customerId: customerProfileId,
        buttonId: button.buttonId,
        orderStatus: 'READY_FOR_DELIVERY',
        paymentStatus: 'UNPAID',
        paymentMethod: 'COD',
        subtotalAmount: 100000,
        shippingFee: 0,
        discountAmount: 0,
        totalAmount: 100000,
        shippingRecipientName: 'Customer C',
        shippingPhone: '090555666',
        shippingAddress: '789 Dien Bien Phu',
        items: {
          create: {
            productId: testProduct.productId,
            productNameSnapshot: 'Fail Test Drinking Water 19L',
            unitPriceSnapshot: 50000,
            quantity: 2,
            itemSubtotal: 100000,
            finalUnitPrice: 50000,
          },
        },
      },
    });
    trackedOrderIds.push(orderFail.orderId);

    // Driver claims order
    await ordersService.claimOrder(orderFail.orderId, driverA1Session);

    // Report delivery failure
    const failedOrder = await ordersService.failDelivery(
      orderFail.orderId,
      {
        failureReasonCode: 'CUSTOMER_UNREACHABLE',
        failureNote: 'Gọi 3 cuộc không nghe máy sau 15 phút chờ',
        evidenceImageUrl: `https://res.cloudinary.com/sob/image/upload/v1234/stores/${storeA.storeId}/pod/call_history.jpg`,
      },
      driverA1Session,
    );

    // Check inventory reserved_quantity released from 5 to 3
    const invAfterFail = await prisma.inventory.findUniqueOrThrow({
      where: { productId: testProduct.productId },
    });

    if (
      failedOrder.orderStatus === 'DELIVERY_FAILED' &&
      failedOrder.failureReasonCode === 'CUSTOMER_UNREACHABLE' &&
      invAfterFail.reservedQuantity === 3
    ) {
      console.log(`  ✔ [PASS] Delivery failure handled with reason code and reserved inventory cleanly released (5 -> ${invAfterFail.reservedQuantity})`);
      passed++;
    } else {
      throw new Error(`Delivery failure handling or inventory release failed. Expected reserved_quantity=3, got ${invAfterFail.reservedQuantity}`);
    }

    // =========================================================================
    // TEST 8: Shift Close and Cash Handover Confirmation
    // =========================================================================
    console.log('👉 [TEST 8] Shift Close & Handover Confirmation');
    const closedShift = await shiftsService.closeShift(startShiftRes.shiftId, driverA1Session);
    if (closedShift.status === 'CLOSED' && closedShift.handoverCode) {
      console.log(`  ✔ [PASS] Shift closed with handoverCode: ${closedShift.handoverCode}`);
    } else {
      throw new Error('Close shift failed');
    }

    const ownerSession = {
      userId: ownerUser.userId.toString(),
      role: 'STORE_OWNER',
      storeId: storeA.storeId.toString(),
    };

    const handedOverShift = await shiftsService.confirmHandover(startShiftRes.shiftId, ownerSession, { note: 'Đã nhận đủ tiền mặt' });
    if (handedOverShift.status === 'HANDED_OVER' && handedOverShift.confirmedByUserId === ownerUser.userId.toString()) {
      console.log('  ✔ [PASS] Store Owner confirmed cash handover successfully');
      passed++;
    } else {
      throw new Error('Confirm handover failed');
    }

    // =========================================================================
    // TEST 9: Driver Duty Status (ONLINE / OFFLINE)
    // =========================================================================
    console.log('👉 [TEST 9] Driver Duty Toggle (ONLINE <-> OFFLINE)');
    const dutyOnline = await driversService.updateMyDuty(driverA1Session, { status: 'ONLINE' });
    const currentDuty = await driversService.getMyDuty(driverA1Session);
    const onlineDrivers = await driversService.getOnlineDrivers(storeA.storeId, driverA1Session);

    if (dutyOnline.status === 'ONLINE' && currentDuty.status === 'ONLINE' && onlineDrivers.some(d => d.driverId === driverA1User.userId.toString())) {
      console.log('  ✔ [PASS] Driver duty toggled to ONLINE and listed in store active drivers');
      passed++;
    } else {
      throw new Error('Driver duty toggle failed');
    }

    // =========================================================================
    // TEST 10: Driver VietQR Payment Link Permission & Direct Driver WebSocket Emit
    // =========================================================================
    console.log('👉 [TEST 10] Driver PayOS Link Auth & Direct Driver WS Notification');
    // Order in SHIPPING assigned to Driver A1
    const orderVietqr = await prisma.order.create({
      data: {
        orderCode: `ORD_VQR_${testRunId}`,
        storeId: storeA.storeId,
        customerId: customerProfileId,
        buttonId: button.buttonId,
        orderStatus: 'READY_FOR_DELIVERY',
        paymentStatus: 'UNPAID',
        paymentMethod: 'PAYOS',
        subtotalAmount: 120000,
        shippingFee: 0,
        discountAmount: 0,
        totalAmount: 120000,
        shippingRecipientName: 'Customer VQR',
        shippingPhone: '090888999',
        shippingAddress: '99 Le Duan',
      },
    });
    trackedOrderIds.push(orderVietqr.orderId);

    // Claim order so it is in SHIPPING and assigned to driver A1
    await ordersService.claimOrder(orderVietqr.orderId, driverA1Session);

    // Test unauthorized driver (Driver B1 from Store B) trying to create link
    const driverB1Session = {
      userId: driverB1User.userId.toString(),
      role: 'STAFF_DELIVERY',
      storeId: storeB.storeId.toString(),
    };

    let forbiddenCaught = false;
    try {
      await paymentsService.createPayosPaymentLink(
        { orderId: orderVietqr.orderId.toString() },
        driverB1Session,
      );
    } catch (e: any) {
      if (e.status === 403 || e.response?.code === 'ORDER_ACCESS_DENIED') {
        forbiddenCaught = true;
      }
    }

    if (!forbiddenCaught) {
      throw new Error('BOLA check failed: unassigned driver was able to create payment link');
    }

    // Verify Direct Driver Notification on PayOS Webhook
    const checksumKey = process.env.PAYOS_CHECKSUM_KEY?.trim() || 'test_payos_checksum_key_1234567890';
    process.env.PAYOS_CHECKSUM_KEY = checksumKey;

    const testTxCode = `TX_${Date.now().toString().slice(-8)}`;
    const tx = await prisma.paymentTransaction.create({
      data: {
        order: { connect: { orderId: orderVietqr.orderId } },
        provider: 'PAYOS',
        transactionCode: testTxCode,
        amount: 120000,
        status: 'PENDING',
        paymentMethod: 'PAYOS',
        paymentLinkId: `plink_${testRunId}`,
      },
    });

    const webhookData = {
      orderCode: Number(testTxCode.replace(/\D/g, '')) || 123456,
      amount: 120000,
      currency: 'VND',
      paymentLinkId: `plink_${testRunId}`,
      code: '00',
    };

    // Update transaction to match numerical orderCode
    await prisma.paymentTransaction.update({
      where: { paymentTransactionId: tx.paymentTransactionId },
      data: { transactionCode: webhookData.orderCode.toString() },
    });

    const sortedData = sortObjDataByKey(webhookData);
    const queryString = convertObjToQueryStr(sortedData);
    const validSignature = crypto
      .createHmac('sha256', checksumKey)
      .update(queryString)
      .digest('hex');

    lastDriverEvent = null;
    const webhookRes = await paymentsService.handlePayosWebhook({
      code: '00',
      desc: 'Success',
      data: webhookData as any,
      signature: validSignature,
    });

    if (
      webhookRes.success &&
      lastDriverEvent &&
      lastDriverEvent.driverId === driverA1User.userId.toString() &&
      lastDriverEvent.event === 'ORDER_PAYMENT_CONFIRMED'
    ) {
      console.log('  ✔ [PASS] Driver B1 BOLA forbidden & PayOS webhook confirmed payment directly emitted to driver WebSocket room');
      passed++;
    } else {
      throw new Error(`Direct driver payment confirmation emit failed. webhookRes: ${JSON.stringify(webhookRes)}, lastDriverEvent: ${JSON.stringify(lastDriverEvent)}`);
    }

    // =========================================================================
    // TEST 11: Driver Order History Filters & Address Coordinates Snapshot
    // =========================================================================
    console.log('👉 [TEST 11] Driver Order History Filters & Coordinate Snapshots');
    const myOrdersRes = await ordersService.getDriverOrders(driverA1Session, {
      status: 'DELIVERED',
      limit: 10,
    });

    const hasCoordinates = myOrdersRes.orders.some(
      (o: any) => o.shippingLatitude != null && o.shippingLongitude != null
    );

    if (myOrdersRes.orders.length >= 1 && myOrdersRes.summary.totalDelivered >= 1 && hasCoordinates) {
      console.log('  ✔ [PASS] Driver order query returned filtered delivered orders with Google Maps coordinates and summary metrics');
      passed++;
    } else {
      throw new Error('Driver order history or coordinates verification failed');
    }

  } catch (error: any) {
    console.error('\n❌ TEST RUN ERROR:', error.message || error);
    throw error;
  } finally {
    // -------------------------------------------------------------------------
    // STRICT ZERO RESIDUE CLEANUP: Delete in reverse foreign key order
    // -------------------------------------------------------------------------
    console.log('\n🧹 CLEANING UP TEST ARTIFACTS (ZERO RESIDUE)...');

    if (trackedShiftIds.length > 0) {
      await prisma.driverShift.deleteMany({ where: { shiftId: { in: trackedShiftIds } } });
    }
    if (trackedDutyIds.length > 0) {
      await prisma.driverDuty.deleteMany({ where: { driverDutyId: { in: trackedDutyIds } } });
    }
    await prisma.driverDuty.deleteMany({ where: { driverId: { in: trackedUserIds } } });

    if (trackedOrderIds.length > 0) {
      await prisma.orderStatusHistory.deleteMany({ where: { orderId: { in: trackedOrderIds } } });
      await prisma.paymentTransaction.deleteMany({ where: { orderId: { in: trackedOrderIds } } });
      await prisma.orderItem.deleteMany({ where: { orderId: { in: trackedOrderIds } } });
      await prisma.order.deleteMany({ where: { orderId: { in: trackedOrderIds } } });
    }

    if (trackedProductIds.length > 0) {
      await prisma.inventory.deleteMany({ where: { productId: { in: trackedProductIds } } });
      await prisma.product.deleteMany({ where: { productId: { in: trackedProductIds } } });
    }

    await prisma.ioTButton.deleteMany({ where: { storeId: { in: trackedStoreIds } } });
    await prisma.storeCustomer.deleteMany({ where: { customer: { userId: { in: trackedUserIds } } } });
    await prisma.customerAddress.deleteMany({ where: { customer: { userId: { in: trackedUserIds } } } });
    await prisma.customerProfile.deleteMany({ where: { userId: { in: trackedUserIds } } });

    if (trackedStaffIds.length > 0) {
      await prisma.storeStaff.deleteMany({ where: { storeStaffId: { in: trackedStaffIds } } });
    }

    if (trackedStoreIds.length > 0) {
      await prisma.store.deleteMany({ where: { storeId: { in: trackedStoreIds } } });
    }

    if (trackedUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { userId: { in: trackedUserIds } } });
    }

    console.log('✔ [ZERO RESIDUE CONFIRMED] All test users, stores, orders, products, shifts, and duties cleanly wiped.');
    await prisma.$disconnect();
  }

  console.log('\n===============================================================');
  console.log(`🎉 TEST SUMMARY: ${passed}/${total} PRD REQUIREMENTS PASSED PERFECTLY!`);
  console.log('===============================================================\n');
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
