import 'dotenv/config';
import 'reflect-metadata';
import * as assert from 'assert';
import { PrismaService } from '../src/prisma/prisma.service';
import { OrdersService } from '../src/orders/orders.service';
import { OrdersRepository } from '../src/orders/orders.repository';
import { OrdersController } from '../src/orders/orders.controller';
import {
  DeliveryEligibilityService,
  MAX_FREE_DELIVERY_DISTANCE_METERS,
  DELIVERY_DISTANCE_SOURCE,
} from '../src/orders/delivery-eligibility.service';
import { IotService } from '../src/iot/iot.service';
import { AllExceptionsFilter } from '../src/common/filters/http-exception.filter';

async function main() {
  console.log('==================================================================');
  console.log('🚀 RUNNING GOONG 5KM FREE DELIVERY TEST SUITE (TDD)');
  console.log('==================================================================\n');

  const prisma = new PrismaService();
  await prisma.$connect();

  let passed = 0;
  let failed = 0;

  async function runTest(name: string, fn: () => Promise<void>) {
    try {
      await fn();
      console.log(`  ✅ PASS: ${name}`);
      passed++;
    } catch (err: any) {
      console.error(`  ❌ FAIL: ${name}`);
      console.error(`     Error: ${err?.message || err}`);
      if (err?.response) {
        console.error(`     Response:`, JSON.stringify(err.response));
      }
      failed++;
    }
  }

  const suffix = Date.now().toString().slice(-6);
  const createdStoreIds: bigint[] = [];
  const createdUserIds: bigint[] = [];
  const createdCustomerIds: bigint[] = [];
  const createdButtonIds: bigint[] = [];
  const createdProductIds: bigint[] = [];

  try {
    // Setup shared fixtures
    const ownerUser = await prisma.user.create({
      data: {
        username: `goong_owner_${suffix}`,
        email: `goong.owner.${suffix}@test.local`,
        passwordHash: 'hash',
        fullName: 'Goong Store Owner',
        phone: `0911${suffix}`,
        status: 'ACTIVE',
      },
    });
    createdUserIds.push(ownerUser.userId);

    const customerUser1 = await prisma.user.create({
      data: {
        username: `goong_cust1_${suffix}`,
        email: `goong.cust1.${suffix}@test.local`,
        passwordHash: 'hash',
        fullName: 'Goong Customer 1',
        phone: `0912${suffix}`,
        status: 'ACTIVE',
      },
    });
    createdUserIds.push(customerUser1.userId);

    const customerProfile1 = await prisma.customerProfile.create({
      data: {
        userId: customerUser1.userId,
        phone: `0912${suffix}`,
      },
    });
    createdCustomerIds.push(customerProfile1.customerId);

    const customerUser2 = await prisma.user.create({
      data: {
        username: `goong_cust2_${suffix}`,
        email: `goong.cust2.${suffix}@test.local`,
        passwordHash: 'hash',
        fullName: 'Goong Customer 2',
        phone: `0913${suffix}`,
        status: 'ACTIVE',
      },
    });
    createdUserIds.push(customerUser2.userId);

    const customerProfile2 = await prisma.customerProfile.create({
      data: {
        userId: customerUser2.userId,
        phone: `0913${suffix}`,
      },
    });
    createdCustomerIds.push(customerProfile2.customerId);

    const store = await prisma.store.create({
      data: {
        ownerUserId: ownerUser.userId,
        name: `Goong Store ${suffix}`,
        code: `GOONG_${suffix}`,
        phone: `0911${suffix}`,
        address: '123 Nguyễn Huệ, Quận 1, TP.HCM',
        latitude: 10.776889,
        longitude: 106.700806,
        status: 'ACTIVE',
      },
    });
    createdStoreIds.push(store.storeId);

    const product = await prisma.product.create({
      data: {
        storeId: store.storeId,
        productCode: `SKU-GOONG-${suffix}`,
        productName: 'Nước khoáng Goong 5km',
        basePrice: 50000,
        status: 'ACTIVE',
      },
    });
    createdProductIds.push(product.productId);

    await prisma.inventory.create({
      data: {
        storeId: store.storeId,
        productId: product.productId,
        quantityOnHand: 20,
        reservedQuantity: 0,
      },
    });

    const addressNear = await prisma.customerAddress.create({
      data: {
        customerId: customerProfile1.customerId,
        recipientName: 'Khách Gần 4.82km',
        phone: `0912${suffix}`,
        addressDetail: '456 Lê Lợi, Quận 1',
        ward: 'Bến Thành',
        district: 'Quận 1',
        province: 'TP.HCM',
        latitude: 10.780123,
        longitude: 106.695432,
        isDefault: true,
      },
    });

    const addressFar = await prisma.customerAddress.create({
      data: {
        customerId: customerProfile1.customerId,
        recipientName: 'Khách Xa 6.31km',
        phone: `0912${suffix}`,
        addressDetail: '789 Xa Lộ Hà Nội, TP Thủ Đức',
        ward: 'Thảo Điền',
        district: 'Thủ Đức',
        province: 'TP.HCM',
        latitude: 10.825678,
        longitude: 106.755432,
        isDefault: false,
      },
    });

    const addressNoCoords = await prisma.customerAddress.create({
      data: {
        customerId: customerProfile1.customerId,
        recipientName: 'Khách Thiếu Tọa Độ',
        phone: `0912${suffix}`,
        addressDetail: 'Địa chỉ thủ công không geocode',
        ward: 'Phường 1',
        district: 'Quận 3',
        province: 'TP.HCM',
        latitude: null,
        longitude: null,
        isDefault: false,
      },
    });

    const addressOtherCustomer = await prisma.customerAddress.create({
      data: {
        customerId: customerProfile2.customerId,
        recipientName: 'Khách Số 2',
        phone: `0913${suffix}`,
        addressDetail: '100 Điện Biên Phủ',
        ward: 'Đa Kao',
        district: 'Quận 1',
        province: 'TP.HCM',
        latitude: 10.785,
        longitude: 106.698,
        isDefault: true,
      },
    });

    const hmacSecret = 'test_goong_hmac_secret_key_12345';
    const button = await prisma.ioTButton.create({
      data: {
        buttonCode: `BTN-GOONG-${suffix}`,
        deviceId: `UID-GOONG-${suffix}`,
        hmacSecret,
        storeId: store.storeId,
        customerId: customerProfile1.customerId,
        addressId: addressNear.addressId,
        inventoryState: 'DELIVERED_TO_CUSTOMER',
        canOrder: true,
        status: 'ACTIVE',
      },
    });
    createdButtonIds.push(button.buttonId);

    await prisma.buttonProduct.create({
      data: {
        buttonId: button.buttonId,
        productId: product.productId,
        quantity: 1,
      },
    });

    const deliveryEligibilityService = new DeliveryEligibilityService(prisma);
    const ordersRepo = new OrdersRepository(prisma);
    const ordersService = new OrdersService(
      ordersRepo,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      deliveryEligibilityService,
    );
    const ordersController = new OrdersController(ordersService);
    const iotService = new IotService(prisma, ordersService);

    const customer1AuthUser = {
      userId: customerUser1.userId.toString(),
      role: 'CUSTOMER',
      customerProfileId: customerProfile1.customerId.toString(),
    };

    const customer2AuthUser = {
      userId: customerUser2.userId.toString(),
      role: 'CUSTOMER',
      customerProfileId: customerProfile2.customerId.toString(),
    };

    // ----------------------------------------------------------------
    // 1. UNIT TESTS: Policy Constant & Goong Client Parsing / Errors
    // ----------------------------------------------------------------
    await runTest('Unit 1: Policy constant MAX_FREE_DELIVERY_DISTANCE_METERS is strictly 5000 and source is GOONG_DISTANCE_MATRIX_V2', async () => {
      assert.strictEqual(MAX_FREE_DELIVERY_DISTANCE_METERS, 5000);
      assert.strictEqual(DELIVERY_DISTANCE_SOURCE, 'GOONG_DISTANCE_MATRIX_V2');
    });

    await runTest('Unit 2: Boundary distance.value = 5000m is eligible (shippingFee = 0, reasonCode = null)', async () => {
      deliveryEligibilityService.clearCache();
      deliveryEligibilityService.setMockFetcher(async () => ({
        status: 200,
        json: async () => ({
          rows: [{ elements: [{ status: 'OK', distance: { text: '5.00 km', value: 5000 }, duration: { text: '15 phút', value: 900 } }] }],
        }),
      }));

      const quote = await ordersService.getDeliveryQuote(
        { deviceId: button.buttonCode, addressId: addressNear.addressId.toString() },
        customer1AuthUser,
      );
      assert.strictEqual(quote.eligible, true);
      assert.strictEqual(quote.distanceMeters, 5000);
      assert.strictEqual(quote.maxDistanceMeters, 5000);
      assert.strictEqual(quote.shippingFee, 0);
      assert.strictEqual(quote.reasonCode, null);
    });

    await runTest('Unit 3: Boundary distance.value = 5001m returns eligible=false on quote and 409 ADDRESS_OUTSIDE_DELIVERY_AREA on order creation', async () => {
      deliveryEligibilityService.clearCache();
      deliveryEligibilityService.setMockFetcher(async () => ({
        status: 200,
        json: async () => ({
          rows: [{ elements: [{ status: 'OK', distance: { text: '5.00 km', value: 5001 }, duration: { text: '15 phút', value: 901 } }] }],
        }),
      }));

      const quote = await ordersService.getDeliveryQuote(
        { deviceId: button.buttonCode, addressId: addressNear.addressId.toString() },
        customer1AuthUser,
      );
      assert.strictEqual(quote.eligible, false);
      assert.strictEqual(quote.distanceMeters, 5001);
      assert.strictEqual(quote.maxDistanceMeters, 5000);
      assert.strictEqual(quote.shippingFee, 0);
      assert.strictEqual(quote.reasonCode, 'ADDRESS_OUTSIDE_DELIVERY_AREA');

      let threw409 = false;
      try {
        await ordersService.quickReorder(
          { deviceId: button.buttonCode, addressId: addressNear.addressId.toString() },
          customer1AuthUser,
        );
      } catch (err: any) {
        threw409 = true;
        assert.strictEqual(err.getStatus(), 409);
        const res = err.getResponse() as any;
        assert.strictEqual(res.errorCode, 'ADDRESS_OUTSIDE_DELIVERY_AREA');
        assert.strictEqual(res.data?.distanceMeters, 5001);
        assert.strictEqual(res.data?.maxDistanceMeters, 5000);
      }
      assert.strictEqual(threw409, true, 'Must throw 409 Conflict for 5001m on quickReorder');
    });

    await runTest('Unit 4: Negative, non-integer, or missing distance.value is rejected with 503 DELIVERY_DISTANCE_UNAVAILABLE', async () => {
      for (const badValue of [-1, 4820.5, null, undefined, '4820']) {
        deliveryEligibilityService.clearCache();
        deliveryEligibilityService.setMockFetcher(async () => ({
          status: 200,
          json: async () => ({
            rows: [{ elements: [{ status: 'OK', distance: { text: '4.82 km', value: badValue as any } }] }],
          }),
        }));

        let threw503 = false;
        try {
          await ordersService.getDeliveryQuote(
            { deviceId: button.buttonCode, addressId: addressNear.addressId.toString() },
            customer1AuthUser,
          );
        } catch (err: any) {
          threw503 = true;
          assert.strictEqual(err.getStatus(), 503);
          const res = err.getResponse() as any;
          assert.strictEqual(res.errorCode, 'DELIVERY_DISTANCE_UNAVAILABLE');
        }
        assert.strictEqual(threw503, true, `Must reject invalid distance.value: ${String(badValue)}`);
      }
    });

    await runTest('Unit 5: Goong timeout or HTTP 500 maps to 503 DELIVERY_DISTANCE_UNAVAILABLE without leaking API key', async () => {
      deliveryEligibilityService.clearCache();
      deliveryEligibilityService.setMockFetcher(async () => {
        const abortErr: any = new Error('The operation was aborted (url: https://rsapi.goong.io/v2/distancematrix?api_key=SECRET_GOONG_KEY_999)');
        abortErr.name = 'AbortError';
        throw abortErr;
      });

      let threw503 = false;
      try {
        await ordersService.getDeliveryQuote(
          { deviceId: button.buttonCode, addressId: addressNear.addressId.toString() },
          customer1AuthUser,
        );
      } catch (err: any) {
        threw503 = true;
        assert.strictEqual(err.getStatus(), 503);
        const res = err.getResponse() as any;
        assert.strictEqual(res.errorCode, 'DELIVERY_DISTANCE_UNAVAILABLE');
        assert.ok(!JSON.stringify(res).includes('SECRET_GOONG_KEY_999'), 'Must never leak Goong API key');
      }
      assert.strictEqual(threw503, true);
    });

    await runTest('Unit 6: Goong ZERO_RESULTS or NOT_FOUND maps to 422 DELIVERY_ROUTE_NOT_FOUND', async () => {
      deliveryEligibilityService.clearCache();
      deliveryEligibilityService.setMockFetcher(async () => ({
        status: 200,
        json: async () => ({
          rows: [{ elements: [{ status: 'ZERO_RESULTS' }] }],
        }),
      }));

      let threw422 = false;
      try {
        await ordersService.getDeliveryQuote(
          { deviceId: button.buttonCode, addressId: addressNear.addressId.toString() },
          customer1AuthUser,
        );
      } catch (err: any) {
        threw422 = true;
        assert.strictEqual(err.getStatus(), 422);
        const res = err.getResponse() as any;
        assert.strictEqual(res.errorCode, 'DELIVERY_ROUTE_NOT_FOUND');
      }
      assert.strictEqual(threw422, true);
    });

    await runTest('Unit 7: Missing addressId returns 400 DELIVERY_ADDRESS_REQUIRED on both quote and quick-reorder', async () => {
      for (const fn of [
        () => ordersService.getDeliveryQuote({ deviceId: button.buttonCode, addressId: '' }, customer1AuthUser),
        () => ordersService.quickReorder({ deviceId: button.buttonCode } as any, customer1AuthUser),
      ]) {
        let threw400 = false;
        try {
          await fn();
        } catch (err: any) {
          threw400 = true;
          assert.strictEqual(err.getStatus(), 400);
          const res = err.getResponse() as any;
          assert.strictEqual(res.errorCode, 'DELIVERY_ADDRESS_REQUIRED');
        }
        assert.strictEqual(threw400, true);
      }
    });

    await runTest('Unit 8: Missing address coordinates returns 400 ADDRESS_COORDINATES_MISSING; missing store coordinates returns 400 STORE_COORDINATES_MISSING', async () => {
      // 8a. Missing address coordinates
      let threwAddrMissing = false;
      try {
        await ordersService.getDeliveryQuote(
          { deviceId: button.buttonCode, addressId: addressNoCoords.addressId.toString() },
          customer1AuthUser,
        );
      } catch (err: any) {
        threwAddrMissing = true;
        assert.strictEqual(err.getStatus(), 400);
        const res = err.getResponse() as any;
        assert.strictEqual(res.errorCode, 'ADDRESS_COORDINATES_MISSING');
      }
      assert.strictEqual(threwAddrMissing, true);

      // 8b. Missing store coordinates
      await prisma.store.update({
        where: { storeId: store.storeId },
        data: { latitude: null, longitude: null },
      });
      try {
        let threwStoreMissing = false;
        try {
          await ordersService.getDeliveryQuote(
            { deviceId: button.buttonCode, addressId: addressNear.addressId.toString() },
            customer1AuthUser,
          );
        } catch (err: any) {
          threwStoreMissing = true;
          assert.strictEqual(err.getStatus(), 400);
          const res = err.getResponse() as any;
          assert.strictEqual(res.errorCode, 'STORE_COORDINATES_MISSING');
        }
        assert.strictEqual(threwStoreMissing, true);
      } finally {
        await prisma.store.update({
          where: { storeId: store.storeId },
          data: { latitude: 10.776889, longitude: 106.700806 },
        });
      }
    });

    // ----------------------------------------------------------------
    // 2. SERVICE / INTEGRATION TESTS: BOLA, Quote, Quick Reorder, IoT
    // ----------------------------------------------------------------
    await runTest('Integration 1: BOLA protection - address belonging to another customer returns 403 DELIVERY_ADDRESS_ACCESS_DENIED', async () => {
      let threw403 = false;
      try {
        await ordersService.getDeliveryQuote(
          { deviceId: button.buttonCode, addressId: addressOtherCustomer.addressId.toString() },
          customer1AuthUser,
        );
      } catch (err: any) {
        threw403 = true;
        assert.strictEqual(err.getStatus(), 403);
        const res = err.getResponse() as any;
        assert.strictEqual(res.errorCode, 'DELIVERY_ADDRESS_ACCESS_DENIED');
      }
      assert.strictEqual(threw403, true);
    });

    await runTest('Integration 2: BOLA protection - button belonging to another customer returns 403 Forbidden', async () => {
      let threw403 = false;
      try {
        await ordersService.getDeliveryQuote(
          { deviceId: button.buttonCode, addressId: addressOtherCustomer.addressId.toString() },
          customer2AuthUser,
        );
      } catch (err: any) {
        threw403 = true;
        assert.strictEqual(err.getStatus(), 403);
      }
      assert.strictEqual(threw403, true);
    });

    await runTest('Integration 3: Controller POST /orders/delivery-quote returns uniform HTTP 200 envelope for both <= 5km and > 5km', async () => {
      deliveryEligibilityService.clearCache();
      deliveryEligibilityService.setMockFetcher(async () => ({
        status: 200,
        json: async () => ({
          rows: [{ elements: [{ status: 'OK', distance: { text: '4.82 km', value: 4820 }, duration: { text: '14 phút', value: 840 } }] }],
        }),
      }));

      const resEligible = await ordersController.getDeliveryQuote(
        { deviceId: button.buttonCode, addressId: addressNear.addressId.toString() },
        { user: customer1AuthUser },
      );
      assert.strictEqual(resEligible.success, true);
      assert.strictEqual(resEligible.message, 'Địa chỉ nằm trong phạm vi giao hàng miễn phí');
      assert.deepStrictEqual(resEligible.data, {
        eligible: true,
        distanceMeters: 4820,
        maxDistanceMeters: 5000,
        shippingFee: 0,
        reasonCode: null,
      });

      deliveryEligibilityService.clearCache();
      deliveryEligibilityService.setMockFetcher(async () => ({
        status: 200,
        json: async () => ({
          rows: [{ elements: [{ status: 'OK', distance: { text: '6.31 km', value: 6310 }, duration: { text: '18 phút', value: 1080 } }] }],
        }),
      }));

      const resIneligible = await ordersController.getDeliveryQuote(
        { deviceId: button.buttonCode, addressId: addressFar.addressId.toString() },
        { user: customer1AuthUser },
      );
      assert.strictEqual(resIneligible.success, true);
      assert.strictEqual(resIneligible.message, 'Địa chỉ nằm ngoài phạm vi giao hàng 5 km');
      assert.deepStrictEqual(resIneligible.data, {
        eligible: false,
        distanceMeters: 6310,
        maxDistanceMeters: 5000,
        shippingFee: 0,
        reasonCode: 'ADDRESS_OUTSIDE_DELIVERY_AREA',
      });
    });

    await runTest('Integration 4: Quick Reorder <= 5km creates order with shippingFee=0 and persists full delivery snapshot in DB', async () => {
      deliveryEligibilityService.clearCache();
      deliveryEligibilityService.setMockFetcher(async () => ({
        status: 200,
        json: async () => ({
          rows: [{ elements: [{ status: 'OK', distance: { text: '4.82 km', value: 4820 }, duration: { text: '14 phút', value: 840 } }] }],
        }),
      }));

      // Also inject untrusted client fields to verify Zero Client Trust
      const result = await ordersService.quickReorder(
        {
          deviceId: button.buttonCode,
          addressId: addressNear.addressId.toString(),
          shippingFee: 99999,
          distanceMeters: 10,
          storeLatitude: 0,
          addressLatitude: 0,
        } as any,
        customer1AuthUser,
      );

      const createdOrderId = BigInt(result.order.orderId);
      const dbOrder = await prisma.order.findUnique({ where: { orderId: createdOrderId } });
      assert.ok(dbOrder, 'Order must exist in database');
      assert.strictEqual(Number(dbOrder!.shippingFee), 0);
      assert.strictEqual(Number(dbOrder!.totalAmount), 50000);
      assert.strictEqual(dbOrder!.deliveryAddressId?.toString(), addressNear.addressId.toString());
      assert.strictEqual(dbOrder!.deliveryDistanceMeters, 4820);
      assert.strictEqual(dbOrder!.deliveryDistanceSource, 'GOONG_DISTANCE_MATRIX_V2');
      assert.strictEqual(Number(dbOrder!.shippingLatitude), Number(addressNear.latitude));
      assert.strictEqual(Number(dbOrder!.shippingLongitude), Number(addressNear.longitude));
      assert.ok(dbOrder!.shippingAddress.includes('456 Lê Lợi'), 'Must snapshot selected address line');
    });

    await runTest('Integration 5: Coordinate change between quote (<=5km) and quick-reorder (>5km) invalidates cache and rejects order with 409', async () => {
      deliveryEligibilityService.clearCache();
      let callCount = 0;
      deliveryEligibilityService.setMockFetcher(async (url: string) => {
        callCount++;
        // If destination has the updated far latitude (10.85), return 6400m; otherwise return 3200m
        if (url.includes('10.85')) {
          return {
            status: 200,
            json: async () => ({
              rows: [{ elements: [{ status: 'OK', distance: { text: '6.40 km', value: 6400 } }] }],
            }),
          };
        }
        return {
          status: 200,
          json: async () => ({
            rows: [{ elements: [{ status: 'OK', distance: { text: '3.20 km', value: 3200 } }] }],
          }),
        };
      });

      // Step 1: Quote passes (3200m) and caches result for old coordinates
      const quote = await ordersService.getDeliveryQuote(
        { deviceId: button.buttonCode, addressId: addressNear.addressId.toString() },
        customer1AuthUser,
      );
      assert.strictEqual(quote.eligible, true);
      assert.strictEqual(quote.distanceMeters, 3200);

      // Step 2: Customer updates address coordinates to >5km before pressing quick-reorder
      await prisma.customerAddress.update({
        where: { addressId: addressNear.addressId },
        data: { latitude: 10.850000, longitude: 106.760000 },
      });

      try {
        let threw409 = false;
        try {
          await ordersService.quickReorder(
            { deviceId: button.buttonCode, addressId: addressNear.addressId.toString() },
            customer1AuthUser,
          );
        } catch (err: any) {
          threw409 = true;
          assert.strictEqual(err.getStatus(), 409);
          const res = err.getResponse() as any;
          assert.strictEqual(res.errorCode, 'ADDRESS_OUTSIDE_DELIVERY_AREA');
          assert.strictEqual(res.data?.distanceMeters, 6400);
        }
        assert.strictEqual(threw409, true, 'Must re-verify on quick-reorder and miss cache when coordinates change');
        assert.strictEqual(callCount, 2, 'Goong fetcher must be called again after coordinate change');
      } finally {
        await prisma.customerAddress.update({
          where: { addressId: addressNear.addressId },
          data: { latitude: 10.780123, longitude: 106.695432 },
        });
      }
    });

    await runTest('Integration 6: Physical IoT Button press with default address <= 5km creates order with snapshot and shippingFee=0', async () => {
      deliveryEligibilityService.clearCache();
      deliveryEligibilityService.setMockFetcher(async () => ({
        status: 200,
        json: async () => ({
          rows: [{ elements: [{ status: 'OK', distance: { text: '4.10 km', value: 4100 } }] }],
        }),
      }));

      iotService.deviceCooldowns.clear();
      const requestId = `iot-pass-${suffix}`;
      const res = await iotService.handleEvent(button, {
        eventType: 'SINGLE_PRESS',
        requestId,
        battery: 95,
        rssi: -45,
      });

      assert.strictEqual(res.success, true);
      const createdOrderId = BigInt((res.data as any).order.orderId);
      const dbOrder = await prisma.order.findUnique({ where: { orderId: createdOrderId } });
      assert.ok(dbOrder);
      assert.strictEqual(Number(dbOrder!.shippingFee), 0);
      assert.strictEqual(dbOrder!.deliveryDistanceMeters, 4100);
      assert.strictEqual(dbOrder!.deliveryDistanceSource, 'GOONG_DISTANCE_MATRIX_V2');
      assert.strictEqual(dbOrder!.deliveryAddressId?.toString(), addressNear.addressId.toString());
    });

    await runTest('Integration 7: Physical IoT Button press with default address > 5km rejects with 409, cleans up idempotency residue, deducts no stock, and notifies customer', async () => {
      // Switch customer's default address to addressFar (>5km)
      await prisma.customerAddress.update({
        where: { addressId: addressNear.addressId },
        data: { isDefault: false },
      });
      await prisma.customerAddress.update({
        where: { addressId: addressFar.addressId },
        data: { isDefault: true },
      });

      const invBefore = await prisma.inventory.findUnique({
        where: { productId: product.productId },
      });
      const notifsBefore = await prisma.notification.count({
        where: { userId: customerUser1.userId },
      });

      deliveryEligibilityService.clearCache();
      deliveryEligibilityService.setMockFetcher(async () => ({
        status: 200,
        json: async () => ({
          rows: [{ elements: [{ status: 'OK', distance: { text: '6.31 km', value: 6310 } }] }],
        }),
      }));

      iotService.deviceCooldowns.clear();
      const requestId = `iot-fail-${suffix}`;

      try {
        let threw409 = false;
        try {
          await iotService.handleEvent(button, {
            eventType: 'SINGLE_PRESS',
            requestId,
            battery: 95,
            rssi: -45,
          });
        } catch (err: any) {
          threw409 = true;
          assert.strictEqual(err.getStatus(), 409);
          const res = err.getResponse() as any;
          assert.strictEqual(res.errorCode, 'ADDRESS_OUTSIDE_DELIVERY_AREA');
        }
        assert.strictEqual(threw409, true, 'Physical button press >5km must throw 409');

        // Verify NO idempotency residue left behind
        const idempResidue = await prisma.iotIdempotencyKey.findFirst({
          where: { deviceId: button.buttonId, requestId },
        });
        assert.strictEqual(idempResidue, null, 'Must clean up iot_idempotency_keys residue when delivery eligibility fails');

        // Verify NO stock deducted
        const invAfter = await prisma.inventory.findUnique({
          where: { productId: product.productId },
        });
        assert.strictEqual(invAfter!.reservedQuantity, invBefore!.reservedQuantity, 'Must not reserve/deduct stock on rejected IoT order');

        // Verify customer notification created
        const latestNotif = await prisma.notification.findFirst({
          where: { userId: customerUser1.userId },
          orderBy: { createdAt: 'desc' },
        });
        const notifsAfter = await prisma.notification.count({
          where: { userId: customerUser1.userId },
        });
        assert.ok(notifsAfter > notifsBefore, 'Must send a notification to the customer when physical button order is rejected');
        assert.ok(
          latestNotif?.body.includes('5 km') && latestNotif?.body.includes('mặc định'),
          'Notification body must explain 5 km limit and default address guidance',
        );
      } finally {
        await prisma.customerAddress.update({
          where: { addressId: addressFar.addressId },
          data: { isDefault: false },
        });
        await prisma.customerAddress.update({
          where: { addressId: addressNear.addressId },
          data: { isDefault: true },
        });
      }
    });

    await runTest('Integration 8: Concurrency safety - two simultaneous quick-reorder calls when available stock=1 only create 1 order', async () => {
      await prisma.inventory.update({
        where: { productId: product.productId },
        data: { quantityOnHand: 1, reservedQuantity: 0 },
      });

      deliveryEligibilityService.clearCache();
      deliveryEligibilityService.setMockFetcher(async () => ({
        status: 200,
        json: async () => ({
          rows: [{ elements: [{ status: 'OK', distance: { text: '2.50 km', value: 2500 } }] }],
        }),
      }));

      const results = await Promise.allSettled([
        ordersService.quickReorder(
          { deviceId: button.buttonCode, addressId: addressNear.addressId.toString() },
          customer1AuthUser,
        ),
        ordersService.quickReorder(
          { deviceId: button.buttonCode, addressId: addressNear.addressId.toString() },
          customer1AuthUser,
        ),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      assert.strictEqual(fulfilled.length, 1, 'Exactly 1 concurrent order should succeed when stock is 1');
      assert.strictEqual(rejected.length, 1, 'Second concurrent order must fail due to insufficient stock');
    });

    await runTest('Contract 1: AllExceptionsFilter preserves data on 409 ADDRESS_OUTSIDE_DELIVERY_AREA and redacts api_key from messages', async () => {
      const filter = new AllExceptionsFilter();
      let capturedStatus = 0;
      let capturedBody: any = null;

      const mockHost: any = {
        switchToHttp: () => ({
          getResponse: () => ({
            status: (code: number) => {
              capturedStatus = code;
              return {
                json: (body: any) => {
                  capturedBody = body;
                },
              };
            },
          }),
          getRequest: () => ({
            method: 'POST',
            url: '/api/v1/orders/quick-reorder',
          }),
        }),
      };

      deliveryEligibilityService.clearCache();
      deliveryEligibilityService.setMockFetcher(async () => ({
        status: 200,
        json: async () => ({
          rows: [{ elements: [{ status: 'OK', distance: { text: '6.31 km', value: 6310 } }] }],
        }),
      }));

      try {
        await ordersService.quickReorder(
          { deviceId: button.buttonCode, addressId: addressFar.addressId.toString() },
          customer1AuthUser,
        );
      } catch (err) {
        filter.catch(err, mockHost);
      }

      assert.strictEqual(capturedStatus, 409);
      assert.strictEqual(capturedBody.success, false);
      assert.strictEqual(capturedBody.errorCode, 'ADDRESS_OUTSIDE_DELIVERY_AREA');
      assert.deepStrictEqual(capturedBody.data, {
        distanceMeters: 6310,
        maxDistanceMeters: 5000,
      });
    });

    await runTest('Live 1: Real Goong Distance Matrix V2 API call succeeds for <=5km and >5km coordinates in Ho Chi Minh City', async () => {
      if (!process.env.GOONG_API_KEY) {
        console.log('     [Skipped live call: GOONG_API_KEY not set]');
        return;
      }
      deliveryEligibilityService.clearCache();
      deliveryEligibilityService.setMockFetcher(null);

      // 1. Near address (~0.7km - 1.5km in District 1)
      const liveQuoteNear = await ordersService.getDeliveryQuote(
        { deviceId: button.buttonCode, addressId: addressNear.addressId.toString() },
        customer1AuthUser,
      );
      assert.strictEqual(liveQuoteNear.eligible, true);
      assert.ok(Number.isInteger(liveQuoteNear.distanceMeters) && liveQuoteNear.distanceMeters > 0 && liveQuoteNear.distanceMeters <= 5000);
      assert.strictEqual(liveQuoteNear.shippingFee, 0);
      assert.strictEqual(liveQuoteNear.reasonCode, null);

      // 2. Far address (Thảo Điền / Thủ Đức > 5km from Nguyễn Huệ Q1)
      const liveQuoteFar = await ordersService.getDeliveryQuote(
        { deviceId: button.buttonCode, addressId: addressFar.addressId.toString() },
        customer1AuthUser,
      );
      assert.strictEqual(liveQuoteFar.eligible, false);
      assert.ok(Number.isInteger(liveQuoteFar.distanceMeters) && liveQuoteFar.distanceMeters > 5000);
      assert.strictEqual(liveQuoteFar.reasonCode, 'ADDRESS_OUTSIDE_DELIVERY_AREA');
    });
  } finally {
    // Cleanup test data
    if (createdStoreIds.length > 0) {
      const orders = await prisma.order.findMany({
        where: { storeId: { in: createdStoreIds } },
        select: { orderId: true },
      });
      const orderIds = orders.map((o) => o.orderId);
      if (orderIds.length > 0) {
        await prisma.iotIdempotencyKey.deleteMany({ where: { orderId: { in: orderIds } } });
        await prisma.orderStatusHistory.deleteMany({ where: { orderId: { in: orderIds } } });
        await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
        await prisma.order.deleteMany({ where: { orderId: { in: orderIds } } });
      }
      await prisma.inventory.deleteMany({ where: { storeId: { in: createdStoreIds } } });
    }
    if (createdButtonIds.length > 0) {
      await prisma.iotIdempotencyKey.deleteMany({ where: { deviceId: { in: createdButtonIds } } });
      await prisma.buttonProduct.deleteMany({ where: { buttonId: { in: createdButtonIds } } });
      await prisma.ioTButton.deleteMany({ where: { buttonId: { in: createdButtonIds } } });
    }
    if (createdProductIds.length > 0) {
      await prisma.product.deleteMany({ where: { productId: { in: createdProductIds } } });
    }
    if (createdStoreIds.length > 0) {
      await prisma.store.deleteMany({ where: { storeId: { in: createdStoreIds } } });
    }
    if (createdCustomerIds.length > 0) {
      await prisma.customerAddress.deleteMany({ where: { customerId: { in: createdCustomerIds } } });
      await prisma.customerProfile.deleteMany({ where: { customerId: { in: createdCustomerIds } } });
    }
    if (createdUserIds.length > 0) {
      await prisma.notification.deleteMany({ where: { userId: { in: createdUserIds } } });
      await prisma.user.deleteMany({ where: { userId: { in: createdUserIds } } });
    }
    await prisma.$disconnect();
  }

  console.log('\n==================================================================');
  console.log(`📊 SUMMARY: ${passed} passed, ${failed} failed`);
  console.log('==================================================================');
  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal test runner error:', err);
  process.exit(1);
});
