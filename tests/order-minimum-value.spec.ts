import * as dotenv from 'dotenv';
dotenv.config();
import 'reflect-metadata';

import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { BadRequestException } from '@nestjs/common';

import { OrdersRepository } from '../src/orders/orders.repository';
import { OrdersService, MIN_ORDER_TOTAL_VND } from '../src/orders/orders.service';

const prisma = new PrismaClient();

async function runOrderMinimumValueTestSuite() {
  console.log('================================================================================');
  console.log('🛡️ ORDER MINIMUM VALUE (>= 2,000 VND) CONSTRAINT TEST SUITE');
  console.log('================================================================================\n');

  let passed = 0;
  let failed = 0;

  const assert = (condition: boolean, testName: string, detail?: string) => {
    if (condition) {
      console.log(`  \x1b[32m✔ [PASS]\x1b[0m ${testName}`);
      passed++;
    } else {
      console.error(`  \x1b[31m✖ [FAIL]\x1b[0m ${testName}${detail ? ` -> ${detail}` : ''}`);
      failed++;
    }
  };

  const ts = Date.now();
  let testUser: any = null;
  let testCustomerProfile: any = null;
  let testAddress: any = null;
  let testStore: any = null;

  // Products
  let prod1999: any = null;
  let prod2000: any = null;
  let prod2001: any = null;
  let prod1500: any = null;
  let prod2500Discounted: any = null;
  let activeDiscount: any = null;

  // Buttons
  let btn1999: any = null;
  let btn2000: any = null;
  let btn2001: any = null;
  let btn1500WithShip: any = null;
  let btnDiscountUnder2000: any = null;

  const createdOrderIds: bigint[] = [];

  try {
    // -------------------------------------------------------------------------
    // SETUP FIXTURES
    // -------------------------------------------------------------------------
    console.log('[Setup: Creating Test Store, Customer, Products & IoT Buttons]');

    // 1. User & Customer
    const passwordHash = await bcrypt.hash('TestPass123!', 10);
    testUser = await prisma.user.create({
      data: {
        username: `min_val_user_${ts}`,
        email: `min_val_${ts}@smartorder.test`,
        fullName: 'Test User Minimum Order',
        passwordHash,
        status: 'ACTIVE',
      },
    });

    testCustomerProfile = await prisma.customerProfile.create({
      data: {
        userId: testUser.userId,
        phone: '+84900000001',
      },
    });

    testAddress = await prisma.customerAddress.create({
      data: {
        customerId: testCustomerProfile.customerId,
        recipientName: 'Test Recipient',
        phone: '+84900000001',
        addressDetail: '123 Hoa Sen',
        ward: 'Phuong 1',
        district: 'Quan 1',
        province: 'Ho Chi Minh',
        isDefault: true,
      },
    });

    // 2. Store
    testStore = await prisma.store.create({
      data: {
        name: `Min Val Store ${ts}`,
        code: `STR_MIN_${ts}`,
        phone: '+84900000002',
        address: '456 Le Loi, Quan 1, TP HCM',
        ownerUserId: testUser.userId,
        status: 'ACTIVE',
        commissionRate: 8.0,
      },
    });

    // 3. Products
    prod1999 = await prisma.product.create({
      data: {
        storeId: testStore.storeId,
        productCode: `PROD_1999_${ts}`,
        productName: `Product 1999 VND ${ts}`,
        basePrice: 1999,
        status: 'ACTIVE',
      },
    });
    await prisma.inventory.upsert({
      where: { productId: prod1999.productId },
      create: {
        storeId: testStore.storeId,
        productId: prod1999.productId,
        quantityOnHand: 100,
        reservedQuantity: 0,
      },
      update: {
        quantityOnHand: 100,
        reservedQuantity: 0,
      },
    });

    prod2000 = await prisma.product.create({
      data: {
        storeId: testStore.storeId,
        productCode: `PROD_2000_${ts}`,
        productName: `Product 2000 VND ${ts}`,
        basePrice: 2000,
        status: 'ACTIVE',
      },
    });
    await prisma.inventory.upsert({
      where: { productId: prod2000.productId },
      create: {
        storeId: testStore.storeId,
        productId: prod2000.productId,
        quantityOnHand: 100,
        reservedQuantity: 0,
      },
      update: {
        quantityOnHand: 100,
        reservedQuantity: 0,
      },
    });

    prod2001 = await prisma.product.create({
      data: {
        storeId: testStore.storeId,
        productCode: `PROD_2001_${ts}`,
        productName: `Product 2001 VND ${ts}`,
        basePrice: 2001,
        status: 'ACTIVE',
      },
    });
    await prisma.inventory.upsert({
      where: { productId: prod2001.productId },
      create: {
        storeId: testStore.storeId,
        productId: prod2001.productId,
        quantityOnHand: 100,
        reservedQuantity: 0,
      },
      update: {
        quantityOnHand: 100,
        reservedQuantity: 0,
      },
    });

    prod1500 = await prisma.product.create({
      data: {
        storeId: testStore.storeId,
        productCode: `PROD_1500_${ts}`,
        productName: `Product 1500 VND ${ts}`,
        basePrice: 1500,
        status: 'ACTIVE',
      },
    });
    await prisma.inventory.upsert({
      where: { productId: prod1500.productId },
      create: {
        storeId: testStore.storeId,
        productId: prod1500.productId,
        quantityOnHand: 100,
        reservedQuantity: 0,
      },
      update: {
        quantityOnHand: 100,
        reservedQuantity: 0,
      },
    });

    prod2500Discounted = await prisma.product.create({
      data: {
        storeId: testStore.storeId,
        productCode: `PROD_2500_${ts}`,
        productName: `Product 2500 VND ${ts}`,
        basePrice: 2500,
        status: 'ACTIVE',
      },
    });
    await prisma.inventory.upsert({
      where: { productId: prod2500Discounted.productId },
      create: {
        storeId: testStore.storeId,
        productId: prod2500Discounted.productId,
        quantityOnHand: 100,
        reservedQuantity: 0,
      },
      update: {
        quantityOnHand: 100,
        reservedQuantity: 0,
      },
    });

    // Discount: 1,000 VND discount -> total becomes 2500 - 1000 = 1500 VND (< 2000)
    activeDiscount = await (prisma as any).productDiscount.create({
      data: {
        productId: prod2500Discounted.productId,
        discountAmount: 1000,
        status: 'ACTIVE',
        startAt: new Date(Date.now() - 3600000),
        endAt: new Date(Date.now() + 3600000),
      },
    });

    // 4. Buttons
    // Button 1: Product 1,999 VND
    btn1999 = await prisma.ioTButton.create({
      data: {
        deviceId: `BTN_1999_${ts}`,
        buttonCode: `BTN_1999_${ts}`,
        hmacSecret: 'test-hmac-secret-12345',
        storeId: testStore.storeId,
        customerId: testCustomerProfile.customerId,
        addressId: testAddress.addressId,
        status: 'ACTIVE',
      },
    });
    await prisma.buttonProduct.create({
      data: {
        buttonId: btn1999.buttonId,
        productId: prod1999.productId,
        quantity: 1,
      },
    });

    // Button 2: Product 2,000 VND
    btn2000 = await prisma.ioTButton.create({
      data: {
        deviceId: `BTN_2000_${ts}`,
        buttonCode: `BTN_2000_${ts}`,
        hmacSecret: 'test-hmac-secret-12345',
        storeId: testStore.storeId,
        customerId: testCustomerProfile.customerId,
        addressId: testAddress.addressId,
        status: 'ACTIVE',
      },
    });
    await prisma.buttonProduct.create({
      data: {
        buttonId: btn2000.buttonId,
        productId: prod2000.productId,
        quantity: 1,
      },
    });

    // Button 3: Product 2,001 VND
    btn2001 = await prisma.ioTButton.create({
      data: {
        deviceId: `BTN_2001_${ts}`,
        buttonCode: `BTN_2001_${ts}`,
        hmacSecret: 'test-hmac-secret-12345',
        storeId: testStore.storeId,
        customerId: testCustomerProfile.customerId,
        addressId: testAddress.addressId,
        status: 'ACTIVE',
      },
    });
    await prisma.buttonProduct.create({
      data: {
        buttonId: btn2001.buttonId,
        productId: prod2001.productId,
        quantity: 1,
      },
    });

    // Button 4: Product 1,500 VND (will be tested with shippingFee = 600)
    btn1500WithShip = await prisma.ioTButton.create({
      data: {
        deviceId: `BTN_1500_${ts}`,
        buttonCode: `BTN_1500_${ts}`,
        hmacSecret: 'test-hmac-secret-12345',
        storeId: testStore.storeId,
        customerId: testCustomerProfile.customerId,
        addressId: testAddress.addressId,
        status: 'ACTIVE',
      },
    });
    await prisma.buttonProduct.create({
      data: {
        buttonId: btn1500WithShip.buttonId,
        productId: prod1500.productId,
        quantity: 1,
      },
    });

    // Button 5: Product 2,500 VND with 1,000 VND discount
    btnDiscountUnder2000 = await prisma.ioTButton.create({
      data: {
        deviceId: `BTN_DISC_${ts}`,
        buttonCode: `BTN_DISC_${ts}`,
        hmacSecret: 'test-hmac-secret-12345',
        storeId: testStore.storeId,
        customerId: testCustomerProfile.customerId,
        addressId: testAddress.addressId,
        status: 'ACTIVE',
      },
    });
    await prisma.buttonProduct.create({
      data: {
        buttonId: btnDiscountUnder2000.buttonId,
        productId: prod2500Discounted.productId,
        quantity: 1,
      },
    });

    console.log('  ✔ All test fixtures created successfully.\n');

    const ordersRepo = new OrdersRepository(prisma as any);
    const mockCrypto: any = { verifyHmac: () => true };
    const mockGateway: any = { emitToStore: () => {}, emitToCustomer: () => {} };
    const mockWallet: any = { debitWallet: async () => {}, creditWallet: async () => {} };
    const mockNotif: any = { sendOrderCreated: async () => {} };
    const ordersService = new OrdersService(ordersRepo, mockCrypto, mockGateway, mockWallet, mockNotif);

    // -------------------------------------------------------------------------
    // PHASE 1: STORED PROCEDURE DIRECT EXECUTION (sp_create_order_from_button)
    // -------------------------------------------------------------------------
    console.log('[Phase 1: PostgreSQL Stored Procedure sp_create_order_from_button]');

    // 1a. Total = 1,999 VND -> REJECTED
    let sp1999Failed = false;
    let sp1999ErrMsg = '';
    try {
      await ordersRepo.executeSpCreateOrder(btn1999.buttonId, 'COD', 0, 'Test SP 1999', `sp_req_1999_${ts}`);
    } catch (e: any) {
      sp1999Failed = true;
      sp1999ErrMsg = e.message || '';
    }
    assert(
      sp1999Failed && sp1999ErrMsg.includes('Giá trị đơn hàng tối thiểu là 2.000 VND'),
      'Stored Procedure rejects order with total = 1,999 VND (< 2,000 VND) with P0010 exception',
    );

    // 1b. Total = 2,000 VND -> SUCCESS
    let sp2000OrderId: any = null;
    try {
      sp2000OrderId = await ordersRepo.executeSpCreateOrder(btn2000.buttonId, 'COD', 0, 'Test SP 2000', `sp_req_2000_${ts}`);
      if (sp2000OrderId) createdOrderIds.push(BigInt(sp2000OrderId));
    } catch (e: any) {
      console.error('SP 2000 error:', e);
    }
    assert(sp2000OrderId !== null && sp2000OrderId !== undefined, 'Stored Procedure accepts order with total exactly 2,000 VND');

    // 1c. Total = 2,001 VND -> SUCCESS
    let sp2001OrderId: any = null;
    try {
      sp2001OrderId = await ordersRepo.executeSpCreateOrder(btn2001.buttonId, 'COD', 0, 'Test SP 2001', `sp_req_2001_${ts}`);
      if (sp2001OrderId) createdOrderIds.push(BigInt(sp2001OrderId));
    } catch (e: any) {
      console.error('SP 2001 error:', e);
    }
    assert(sp2001OrderId !== null && sp2001OrderId !== undefined, 'Stored Procedure accepts order with total = 2,001 VND');

    // 1d. Subtotal = 1,500 VND + Shipping = 600 VND -> Total = 2,100 VND -> SUCCESS
    let spShipOrderId: any = null;
    try {
      spShipOrderId = await ordersRepo.executeSpCreateOrder(btn1500WithShip.buttonId, 'COD', 600, 'Test SP with Ship', `sp_req_ship_${ts}`);
      if (spShipOrderId) createdOrderIds.push(BigInt(spShipOrderId));
    } catch (e: any) {
      console.error('SP Ship error:', e);
    }
    assert(
      spShipOrderId !== null && spShipOrderId !== undefined,
      'Stored Procedure accepts order when subtotal (1,500) < 2,000 but shippingFee (600) makes total (2,100) >= 2,000',
    );

    // 1e. Subtotal = 2,500 VND - Discount = 1,000 VND -> Total = 1,500 VND -> REJECTED
    let spDiscountFailed = false;
    try {
      await ordersRepo.executeSpCreateOrder(btnDiscountUnder2000.buttonId, 'COD', 0, 'Test SP Discount', `sp_req_disc_${ts}`);
    } catch (e: any) {
      spDiscountFailed = true;
    }
    assert(
      spDiscountFailed,
      'Stored Procedure rejects order when subtotal >= 2,000 but active discount makes total < 2,000 VND',
    );

    // -------------------------------------------------------------------------
    // PHASE 2: FALLBACK TRANSACTION DIRECT EXECUTION (createOrderFallbackTx)
    // -------------------------------------------------------------------------
    console.log('\n[Phase 2: Fallback Transaction createOrderFallbackTx]');

    // Reload button fixtures with relations
    const btn1999Full = await ordersRepo.findButtonByIdentifier(btn1999.deviceId);
    const btn2000Full = await ordersRepo.findButtonByIdentifier(btn2000.deviceId);
    const btn2001Full = await ordersRepo.findButtonByIdentifier(btn2001.deviceId);
    const btn1500Full = await ordersRepo.findButtonByIdentifier(btn1500WithShip.deviceId);
    const btnDiscountFull = await ordersRepo.findButtonByIdentifier(btnDiscountUnder2000.deviceId);

    // 2a. Fallback: Total = 1,999 VND -> REJECTED
    let fallback1999Thrown = false;
    let fallback1999Err: any = null;
    try {
      await ordersRepo.createOrderFallbackTx(btn1999Full, 'COD', 0, `fb_req_1999_${ts}`);
    } catch (e: any) {
      fallback1999Thrown = true;
      fallback1999Err = e;
    }
    assert(
      fallback1999Thrown &&
        fallback1999Err instanceof BadRequestException &&
        (fallback1999Err.getResponse() as any)?.errorCode === 'ORDER_TOTAL_BELOW_MINIMUM',
      'Fallback transaction throws BadRequestException with errorCode ORDER_TOTAL_BELOW_MINIMUM for total = 1,999 VND',
    );

    // 2b. Fallback: Total = 2,000 VND -> SUCCESS
    let fb2000OrderId: any = null;
    try {
      fb2000OrderId = await ordersRepo.createOrderFallbackTx(btn2000Full, 'COD', 0, `fb_req_2000_${ts}`);
      if (fb2000OrderId) createdOrderIds.push(BigInt(fb2000OrderId));
    } catch (e: any) {
      console.error('FB 2000 error:', e);
    }
    assert(fb2000OrderId !== null && fb2000OrderId !== undefined, 'Fallback transaction creates order with total exactly 2,000 VND');

    // 2c. Fallback: Total = 2,001 VND -> SUCCESS
    let fb2001OrderId: any = null;
    try {
      fb2001OrderId = await ordersRepo.createOrderFallbackTx(btn2001Full, 'COD', 0, `fb_req_2001_${ts}`);
      if (fb2001OrderId) createdOrderIds.push(BigInt(fb2001OrderId));
    } catch (e: any) {
      console.error('FB 2001 error:', e);
    }
    assert(fb2001OrderId !== null && fb2001OrderId !== undefined, 'Fallback transaction creates order with total = 2,001 VND');

    // 2d. Fallback: Subtotal = 1,500 VND + Shipping = 600 VND -> Total = 2,100 VND -> SUCCESS
    let fbShipOrderId: any = null;
    try {
      fbShipOrderId = await ordersRepo.createOrderFallbackTx(btn1500Full, 'COD', 600, `fb_req_ship_${ts}`);
      if (fbShipOrderId) createdOrderIds.push(BigInt(fbShipOrderId));
    } catch (e: any) {
      console.error('FB Ship error:', e);
    }
    assert(
      fbShipOrderId !== null && fbShipOrderId !== undefined,
      'Fallback transaction creates order when subtotal < 2,000 but subtotal + shippingFee >= 2,000 VND',
    );

    // 2e. Fallback: Subtotal = 2,500 VND - 1,000 VND discount -> Total = 1,500 VND -> REJECTED
    let fbDiscountFailed = false;
    let fbDiscountErr: any = null;
    try {
      await ordersRepo.createOrderFallbackTx(btnDiscountFull, 'COD', 0, `fb_req_disc_${ts}`);
    } catch (e: any) {
      fbDiscountFailed = true;
      fbDiscountErr = e;
    }
    assert(
      fbDiscountFailed &&
        fbDiscountErr instanceof BadRequestException &&
        (fbDiscountErr.getResponse() as any)?.errorCode === 'ORDER_TOTAL_BELOW_MINIMUM',
      'Fallback transaction rejects order when discount reduces total below 2,000 VND',
    );

    // -------------------------------------------------------------------------
    // PHASE 3: SERVICE LAYER END-TO-END PIPELINE (handleButtonEvent)
    // -------------------------------------------------------------------------
    console.log('\n[Phase 3: OrdersService.handleButtonEvent Execution]');

    // 3a. Rejection response contract
    let serviceRejected = false;
    let serviceResponse: any = null;
    try {
      await ordersService.handleButtonEvent(
        { deviceId: btn1999.deviceId },
        {
          eventType: 'SINGLE_PRESS',
          requestId: `svc_req_1999_${ts}`,
          paymentMethod: 'COD',
          shippingFee: 0,
        },
      );
    } catch (e: any) {
      serviceRejected = true;
      serviceResponse = e.getResponse ? e.getResponse() : e;
    }
    assert(
      serviceRejected &&
        serviceResponse?.errorCode === 'ORDER_TOTAL_BELOW_MINIMUM' &&
        serviceResponse?.message === 'Giá trị đơn hàng tối thiểu là 2.000 VND',
      'OrdersService rejects sub-2000 order with HTTP 400, errorCode ORDER_TOTAL_BELOW_MINIMUM and standard message',
    );

    // 3b. Success response contract
    const svcSuccessRes = await ordersService.handleButtonEvent(
      { deviceId: btn2000.deviceId },
      {
        eventType: 'SINGLE_PRESS',
        requestId: `svc_req_2000_${ts}`,
        paymentMethod: 'COD',
        shippingFee: 0,
      },
    );
    if (svcSuccessRes?.order?.orderId) {
      createdOrderIds.push(BigInt(svcSuccessRes.order.orderId));
    }
    assert(
      svcSuccessRes?.order && Number(svcSuccessRes.order.totalAmount) >= MIN_ORDER_TOTAL_VND,
      'OrdersService creates order successfully when totalAmount >= 2,000 VND',
    );

    // -------------------------------------------------------------------------
    // PHASE 4: IDEMPOTENCY & ZERO RESIDUE INTEGRITY
    // -------------------------------------------------------------------------
    console.log('\n[Phase 4: Idempotency & Zero Residue Integrity]');

    // 4a. Idempotent hit with duplicate requestId
    const duplicateRequestId = `idemp_req_${ts}`;
    const firstCall = await ordersService.handleButtonEvent(
      { deviceId: btn2001.deviceId },
      {
        eventType: 'SINGLE_PRESS',
        requestId: duplicateRequestId,
        paymentMethod: 'COD',
        shippingFee: 0,
      },
    );
    if (firstCall?.order?.orderId) {
      createdOrderIds.push(BigInt(firstCall.order.orderId));
    }

    const secondCall = await ordersService.handleButtonEvent(
      { deviceId: btn2001.deviceId },
      {
        eventType: 'SINGLE_PRESS',
        requestId: duplicateRequestId,
        paymentMethod: 'COD',
        shippingFee: 0,
      },
    );

    assert(
      secondCall?.isDuplicate === true &&
        secondCall?.order?.orderId === firstCall?.order?.orderId,
      'Duplicate IoT request with identical requestId safely returns existing order (isDuplicate: true) without duplicating orders',
    );

    // 4b. Zero Residue Check on Rejected Request
    const rejectedRequestId = `rejected_zero_residue_${ts}`;
    try {
      await ordersService.handleButtonEvent(
        { deviceId: btn1999.deviceId },
        {
          eventType: 'SINGLE_PRESS',
          requestId: rejectedRequestId,
          paymentMethod: 'COD',
          shippingFee: 0,
        },
      );
    } catch (e: any) {
      // Expected rejection
    }

    // Verify database state: no order exists for rejectedRequestId
    const residueOrder = await prisma.order.findFirst({
      where: { iotRequestId: rejectedRequestId },
    });
    assert(residueOrder === null, 'Rejected sub-2000 order leaves NO row in orders table');

    // Verify inventory reserved_quantity was NOT incremented on rejection
    const inv1999 = await prisma.inventory.findUnique({
      where: { productId: prod1999.productId },
    });
    assert(
      inv1999?.reservedQuantity === 0,
      'Rejected order leaves NO inventory reservation (reserved_quantity remains 0)',
    );

  } catch (err: any) {
    console.error('Fatal test error occurred:', err);
    failed++;
  } finally {
    // -------------------------------------------------------------------------
    // PHASE 5: ZERO TEST RESIDUE TEARDOWN
    // -------------------------------------------------------------------------
    console.log('\n[Phase 5: Zero Test Residue Cleanup]');
    try {
      // Delete orders and dependencies
      for (const orderId of createdOrderIds) {
        await prisma.orderStatusHistory.deleteMany({ where: { orderId } });
        await prisma.orderItem.deleteMany({ where: { orderId } });
        await prisma.paymentTransaction.deleteMany({ where: { orderId } });
        await prisma.order.deleteMany({ where: { orderId } });
      }

      // Delete buttons
      const btnIds = [
        btn1999?.buttonId,
        btn2000?.buttonId,
        btn2001?.buttonId,
        btn1500WithShip?.buttonId,
        btnDiscountUnder2000?.buttonId,
      ].filter(Boolean);

      for (const buttonId of btnIds) {
        await prisma.buttonProduct.deleteMany({ where: { buttonId } });
        await prisma.ioTButton.deleteMany({ where: { buttonId } });
      }

      // Delete discounts
      if (activeDiscount) {
        await (prisma as any).productDiscount.deleteMany({
          where: { discountId: activeDiscount.discountId },
        });
      }

      // Delete products and inventory
      const prodIds = [
        prod1999?.productId,
        prod2000?.productId,
        prod2001?.productId,
        prod1500?.productId,
        prod2500Discounted?.productId,
      ].filter(Boolean);

      for (const productId of prodIds) {
        await prisma.inventory.deleteMany({ where: { productId } });
        await prisma.product.deleteMany({ where: { productId } });
      }

      // Delete customer address, profile, store, and user
      if (testAddress) {
        await prisma.customerAddress.deleteMany({ where: { addressId: testAddress.addressId } });
      }
      if (testCustomerProfile) {
        await (prisma as any).storeCustomer.deleteMany({ where: { customerId: testCustomerProfile.customerId } });
        await prisma.customerAddress.deleteMany({ where: { customerId: testCustomerProfile.customerId } });
        await prisma.customerProfile.deleteMany({ where: { customerId: testCustomerProfile.customerId } });
      }
      if (testStore) {
        await (prisma as any).storeCustomer.deleteMany({ where: { storeId: testStore.storeId } });
        await prisma.store.deleteMany({ where: { storeId: testStore.storeId } });
      }
      if (testUser) {
        await prisma.user.deleteMany({ where: { userId: testUser.userId } });
      }

      console.log('  \x1b[32m✔ [CLEANUP]\x1b[0m Successfully purged all test orders, products, buttons, and fixtures.');
    } catch (cleanErr: any) {
      console.error('  \x1b[31m✖ [CLEANUP ERROR]\x1b[0m Could not complete cleanup:', cleanErr.message);
    }
    await prisma.$disconnect();
  }

  console.log('\n================================================================================');
  console.log(`📊 TEST SUITE SUMMARY: PASSED: ${passed} | FAILED: ${failed}`);
  console.log('================================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runOrderMinimumValueTestSuite();
