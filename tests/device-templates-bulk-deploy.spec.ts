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

async function runDeviceTemplateAndBulkDeployTests() {
  console.log('\n========================================================================');
  console.log('🚀 SUITE 14: DEVICE TEMPLATES, BULK DEPLOYMENT, ALLOCATION & RBAC SUITE');
  console.log('========================================================================\n');

  let passed = 0;
  let failed = 0;

  // Track created entities for cleanup
  const createdTemplateIds: string[] = [];
  const createdDeviceIds: string[] = [];
  let testOrderId: string | null = null;

  try {
    // -------------------------------------------------------------------------
    // 1. Authenticate All Personas
    // -------------------------------------------------------------------------
    let store1Token = '';
    let store1Id = '';
    let store2Token = '';
    let store2Id = '';
    let adminToken = '';
    let customerToken = '';

    // 1.1 Store 1 Login (store@smartorder.local)
    try {
      const res = await fetch(`${BASE_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'store@smartorder.local', password: 'Password123!' }),
      });
      const data = await res.json();
      if (res.status === 200 && data.data?.token) {
        store1Token = data.data.token;
        store1Id = String(data.data.user.storeId);
        logTest('1.1 Auth: Store Owner 1 Login', true);
        passed++;
      } else {
        throw new Error(data.message || 'Store 1 login failed');
      }
    } catch (e: any) {
      logTest('1.1 Auth: Store Owner 1 Login', false, e.message);
      failed++;
    }

    // 1.2 Store 2 Login (minhkhoi@smartorder.local)
    try {
      const res = await fetch(`${BASE_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'minhkhoi@smartorder.local', password: 'Password123!' }),
      });
      const data = await res.json();
      if (res.status === 200 && data.data?.token) {
        store2Token = data.data.token;
        store2Id = String(data.data.user.storeId);
        logTest('1.2 Auth: Store Owner 2 Login', true);
        passed++;
      } else {
        throw new Error(data.message || 'Store 2 login failed');
      }
    } catch (e: any) {
      logTest('1.2 Auth: Store Owner 2 Login', false, e.message);
      failed++;
    }

    // 1.3 System Admin Login (admin@smartorder.local)
    try {
      const res = await fetch(`${BASE_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'admin@smartorder.local', password: 'Password123!' }),
      });
      const data = await res.json();
      if (res.status === 200 && data.data?.token) {
        adminToken = data.data.token;
        logTest('1.3 Auth: System Admin Login', true);
        passed++;
      } else {
        throw new Error(data.message || 'Admin login failed');
      }
    } catch (e: any) {
      logTest('1.3 Auth: System Admin Login', false, e.message);
      failed++;
    }

    // 1.4 Customer Login (customer@smartorder.local)
    try {
      const res = await fetch(`${BASE_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'customer@smartorder.local', password: 'Password123!' }),
      });
      const data = await res.json();
      if (res.status === 200 && data.data?.token) {
        customerToken = data.data.token;
        logTest('1.4 Auth: Customer Login', true);
        passed++;
      } else {
        throw new Error(data.message || 'Customer login failed');
      }
    } catch (e: any) {
      logTest('1.4 Auth: Customer Login', false, e.message);
      failed++;
    }

    // -------------------------------------------------------------------------
    // 2. Fetch Products for Testing Default Product Mappings & Boundaries
    // -------------------------------------------------------------------------
    let store1Product: any = null;
    let otherStoreProduct: any = null;

    try {
      const p1Res = await fetch(`${BASE_URL}/products`, {
        headers: { Authorization: `Bearer ${store1Token}` },
      });
      const p1Data = await p1Res.json();
      if (p1Res.status === 200 && p1Data.data?.length > 0) {
        store1Product = p1Data.data[0];
      }

      // Find another product that belongs to another store
      otherStoreProduct = await prisma.product.findFirst({
        where: {
          storeId: { not: BigInt(store1Id) },
          status: 'ACTIVE',
        },
      });

      if (!otherStoreProduct) {
        // Create a temporary product for Store 2 to test cross-store isolation
        const cat = await prisma.category.findFirst();
        otherStoreProduct = await prisma.product.create({
          data: {
            storeId: BigInt(store2Id),
            categoryId: cat ? cat.categoryId : 1n,
            productCode: `PRD-T2-${Date.now().toString().slice(-4)}`,
            productName: 'Other Store Item Test',
            basePrice: 50000,
            status: 'ACTIVE',
          },
        });
      }

      const foundBoth = !!store1Product && !!otherStoreProduct;
      logTest('2. Products Catalog Resolved for Stores', foundBoth, `Store1: ${store1Product?.id}, OtherStore: ${otherStoreProduct?.productId}`);
      if (foundBoth) passed++; else failed++;
    } catch (e: any) {
      logTest('2. Products Catalog Resolved for Stores', false, e.message);
      failed++;
    }

    // -------------------------------------------------------------------------
    // 3. Phase 1 & 2: Template Creation with defaultProductId & longPressAction
    // -------------------------------------------------------------------------
    let template1Id: string = '';
    try {
      const res = await fetch(`${BASE_URL}/device-templates`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${store1Token}`,
        },
        body: JSON.stringify({
          name: 'Water Quick Order Button V1',
          description: 'Official template for single-click water delivery',
          defaultProductId: String(store1Product.id),
          longPressAction: 'WIFI_CONFIGURATION',
          defaultQuantity: 2,
          cancelWindowSeconds: 60,
        }),
      });
      const data = await res.json();
      if (res.status === 201 && data.data?.id) {
        template1Id = data.data.id;
        createdTemplateIds.push(template1Id);
        const hasProductId = String(data.data.defaultProductId) === String(store1Product.id);
        const hasLongPress = data.data.longPressAction === 'WIFI_CONFIGURATION';
        if (hasProductId && hasLongPress) {
          logTest('3. Phase 1 & 2: Template Created with defaultProductId and longPressAction', true);
          passed++;
        } else {
          throw new Error(`defaultProductId or longPressAction mismatch: ${JSON.stringify(data.data)}`);
        }
      } else {
        throw new Error(data.message || `Status: ${res.status}`);
      }
    } catch (e: any) {
      logTest('3. Phase 1 & 2: Template Created with defaultProductId and longPressAction', false, e.message);
      failed++;
    }

    // -------------------------------------------------------------------------
    // 4. Phase 3: Tenant Product Boundary Check (Cross-Store Product Rejection)
    // -------------------------------------------------------------------------
    try {
      // Store 1 tries to use another store's product as defaultProductId
      const res = await fetch(`${BASE_URL}/device-templates`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${store1Token}`,
        },
        body: JSON.stringify({
          name: 'Cross Tenant Template',
          defaultProductId: String(otherStoreProduct.productId), // BELONGS TO ANOTHER STORE
          longPressAction: 'WIFI_CONFIGURATION',
        }),
      });
      const data = await res.json();
      // Should reject with 403 Forbidden or 400 Bad Request
      if (res.status === 403 || res.status === 400) {
        logTest('4. Phase 3: Tenant Boundary Enforced (Cross-store product rejected)', true);
        passed++;
      } else {
        logTest('4. Phase 3: Tenant Boundary Enforced (Cross-store product rejected)', false, `Expected 403/400 but got ${res.status}: ${JSON.stringify(data)}`);
        failed++;
      }
    } catch (e: any) {
      logTest('4. Phase 3: Tenant Boundary Enforced (Cross-store product rejected)', false, e.message);
      failed++;
    }

    // -------------------------------------------------------------------------
    // 5. Phase 2: Validation of Invalid longPressAction
    // -------------------------------------------------------------------------
    try {
      const res = await fetch(`${BASE_URL}/device-templates`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${store1Token}`,
        },
        body: JSON.stringify({
          name: 'Invalid Action Template',
          longPressAction: 'DISCO_LIGHTS_PARTY_MODE', // INVALID ACTION
        }),
      });
      if (res.status === 400) {
        logTest('5. Phase 2: Invalid longPressAction Enum Rejected (400 Bad Request)', true);
        passed++;
      } else {
        logTest('5. Phase 2: Invalid longPressAction Enum Rejected (400 Bad Request)', false, `Expected 400 but got ${res.status}`);
        failed++;
      }
    } catch (e: any) {
      logTest('5. Phase 2: Invalid longPressAction Enum Rejected (400 Bad Request)', false, e.message);
      failed++;
    }

    // -------------------------------------------------------------------------
    // Pre-create Devices in Store 1 for Deployment Testing
    // -------------------------------------------------------------------------
    const singleDeviceId = `SOB-SGL-${Date.now().toString().slice(-6)}`;
    const bulkId1 = `SOB-BLK1-${Date.now().toString().slice(-6)}`;
    const bulkId2 = `SOB-BLK2-${Date.now().toString().slice(-6)}`;
    const rngPrefix = `SOB-RNG-${Date.now().toString().slice(-4)}-`;
    const rngExpected = [
      `${rngPrefix}001`,
      `${rngPrefix}002`,
      `${rngPrefix}003`,
    ];

    const defaultAddress = await prisma.customerAddress.findFirst();
    const seedCustomerId = defaultAddress!.customerId;
    const seedAddressId = defaultAddress!.addressId;

    const allTestDevicesToSeed = [singleDeviceId, bulkId1, bulkId2, ...rngExpected];
    createdDeviceIds.push(...allTestDevicesToSeed);

    for (let i = 0; i < allTestDevicesToSeed.length; i++) {
      const dId = allTestDevicesToSeed[i];
      await prisma.ioTButton.create({
        data: {
          storeId: BigInt(store1Id),
          customerId: seedCustomerId,
          addressId: seedAddressId,
          deviceId: dId,
          buttonCode: dId,
          buttonName: `Test Button ${dId}`,
          hmacSecret: `secret_${dId}_32bytes_sample_hmac_key`,
          status: 'ACTIVE',
        },
      });
    }

    // -------------------------------------------------------------------------
    // 6. Phase 4: Single Device Deployment Mode
    // -------------------------------------------------------------------------
    try {
      const res = await fetch(`${BASE_URL}/device-templates/${template1Id}/deploy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${store1Token}`,
        },
        body: JSON.stringify({
          deviceId: singleDeviceId,
        }),
      });
      const data = await res.json();
      if (res.status === 201 && (data.total === 1 || data.data?.total === 1) && (data.succeeded === 1 || data.data?.succeeded === 1)) {
        // Verify in DB that device was configured and product was mapped
        const dbBtn = await prisma.ioTButton.findUnique({
          where: { deviceId: singleDeviceId },
          include: { buttonProducts: true },
        });
        const hasProductAssigned = dbBtn?.buttonProducts?.some(
          (bp) => String(bp.productId) === String(store1Product.id)
        );
        const hasLongPress = dbBtn?.longPressAction === 'WIFI_CONFIGURATION';

        if (dbBtn && hasProductAssigned && hasLongPress) {
          logTest('6. Phase 4: Single Device Deployed with Template defaults and Product Mapping', true);
          passed++;
        } else {
          throw new Error(`Device verification failed: longPress=${dbBtn?.longPressAction}, assigned=${hasProductAssigned}`);
        }
      } else {
        throw new Error(data.message || `Status: ${res.status}`);
      }
    } catch (e: any) {
      logTest('6. Phase 4: Single Device Deployed with Template defaults and Product Mapping', false, e.message);
      failed++;
    }

    // -------------------------------------------------------------------------
    // 7. Phase 4: Multi-Device Array Deployment Mode (deviceIds <= 100)
    // -------------------------------------------------------------------------
    try {
      const res = await fetch(`${BASE_URL}/device-templates/${template1Id}/deploy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${store1Token}`,
        },
        body: JSON.stringify({
          deviceIds: [bulkId1, bulkId2],
        }),
      });
      const data = await res.json();
      if (res.status === 201 && (data.total === 2 || data.data?.total === 2) && (data.succeeded === 2 || data.data?.succeeded === 2)) {
        logTest('7. Phase 4: Multi-Device Array Deployment Succeeded (Report: 2/2)', true);
        passed++;
      } else {
        throw new Error(data.message || `Status: ${res.status}`);
      }
    } catch (e: any) {
      logTest('7. Phase 4: Multi-Device Array Deployment Succeeded (Report: 2/2)', false, e.message);
      failed++;
    }

    // -------------------------------------------------------------------------
    // 8. Phase 4: Range Deployment Mode (prefix + startRange + endRange + padLength)
    // -------------------------------------------------------------------------
    try {
      const res = await fetch(`${BASE_URL}/device-templates/${template1Id}/deploy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${store1Token}`,
        },
        body: JSON.stringify({
          prefix: rngPrefix,
          startRange: 1,
          endRange: 3,
          padLength: 3,
        }),
      });
      const data = await res.json();
      if (res.status === 201 && (data.total === 3 || data.data?.total === 3) && (data.succeeded === 3 || data.data?.succeeded === 3)) {
        const dbDevices = await prisma.ioTButton.findMany({
          where: { deviceId: { in: rngExpected } },
          include: { buttonProducts: true },
        });
        const allAssigned = dbDevices.every((d) => d.buttonProducts.length > 0 && d.longPressAction === 'WIFI_CONFIGURATION');
        if (dbDevices.length === 3 && allAssigned) {
          logTest('8. Phase 4: Range Deployment Succeeded (SOB-RNG-001..003)', true);
          passed++;
        } else {
          throw new Error(`Expected 3 configured devices, found ${dbDevices.length}`);
        }
      } else {
        throw new Error(data.message || `Status: ${res.status}`);
      }
    } catch (e: any) {
      logTest('8. Phase 4: Range Deployment Succeeded (SOB-RNG-001..003)', false, e.message);
      failed++;
    }

    // -------------------------------------------------------------------------
    // 9. Phase 4: Deployment Guardrails (Overflow & Mutual Exclusivity)
    // -------------------------------------------------------------------------
    // 9.1 Range Overflow (> 100 devices)
    try {
      const res = await fetch(`${BASE_URL}/device-templates/${template1Id}/deploy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${store1Token}`,
        },
        body: JSON.stringify({
          prefix: 'SOB-OVER-',
          startRange: 1,
          endRange: 105, // 105 devices > 100
          padLength: 3,
        }),
      });
      if (res.status === 400) {
        logTest('9.1 Phase 4: Range Deployment Overflow (> 100 devices) Rejected (400)', true);
        passed++;
      } else {
        logTest('9.1 Phase 4: Range Deployment Overflow (> 100 devices) Rejected (400)', false, `Expected 400 but got ${res.status}`);
        failed++;
      }
    } catch (e: any) {
      logTest('9.1 Phase 4: Range Deployment Overflow (> 100 devices) Rejected (400)', false, e.message);
      failed++;
    }

    // 9.1b Exact Boundary Case (1 -> 101 = 101 devices)
    try {
      const res = await fetch(`${BASE_URL}/device-templates/${template1Id}/deploy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${store1Token}`,
        },
        body: JSON.stringify({
          prefix: 'SOB-101-',
          startRange: 1,
          endRange: 101, // Exactly 101 devices > 100
          padLength: 3,
        }),
      });
      if (res.status === 400) {
        logTest('9.1b Phase 4: Exact Boundary Range Overflow (1 -> 101 = 101 devices) Rejected (400)', true);
        passed++;
      } else {
        logTest('9.1b Phase 4: Exact Boundary Range Overflow (1 -> 101 = 101 devices) Rejected (400)', false, `Expected 400 but got ${res.status}`);
        failed++;
      }
    } catch (e: any) {
      logTest('9.1b Phase 4: Exact Boundary Range Overflow (1 -> 101 = 101 devices) Rejected (400)', false, e.message);
      failed++;
    }

    // 9.2 Mutual Exclusivity (Providing both deviceId and deviceIds)
    try {
      const res = await fetch(`${BASE_URL}/device-templates/${template1Id}/deploy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${store1Token}`,
        },
        body: JSON.stringify({
          deviceId: 'DEVICE-1',
          deviceIds: ['DEVICE-2', 'DEVICE-3'],
        }),
      });
      if (res.status === 400) {
        logTest('9.2 Phase 4: Mutual Exclusivity Violation Rejected (400 Bad Request)', true);
        passed++;
      } else {
        logTest('9.2 Phase 4: Mutual Exclusivity Violation Rejected (400 Bad Request)', false, `Expected 400 but got ${res.status}`);
        failed++;
      }
    } catch (e: any) {
      logTest('9.2 Phase 4: Mutual Exclusivity Violation Rejected (400 Bad Request)', false, e.message);
      failed++;
    }

    // -------------------------------------------------------------------------
    // 10. Phase 5: Secure Device Update Hygiene
    // -------------------------------------------------------------------------
    // 10.1 Valid Update (batteryLevel: 88, warrantyUntil: valid ISO, location)
    try {
      const res = await fetch(`${BASE_URL}/devices/${singleDeviceId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${store1Token}`,
        },
        body: JSON.stringify({
          batteryLevel: 88,
          warrantyUntil: '2028-06-30T00:00:00.000Z',
          location: 'Building B - Pantry 3F',
          description: 'Refurbished smart button',
        }),
      });
      const data = await res.json();
      if (res.status === 200 && data.data?.batteryLevel === 88 && data.data?.location === 'Building B - Pantry 3F') {
        logTest('10.1 Phase 5: Device Update with valid battery and warranty date accepted', true);
        passed++;
      } else {
        throw new Error(data.message || `Status: ${res.status}`);
      }
    } catch (e: any) {
      logTest('10.1 Phase 5: Device Update with valid battery and warranty date accepted', false, e.message);
      failed++;
    }

    // 10.2 Invalid Battery (> 100) Rejected
    try {
      const res = await fetch(`${BASE_URL}/devices/${singleDeviceId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${store1Token}`,
        },
        body: JSON.stringify({
          batteryLevel: 150, // OUT OF RANGE
        }),
      });
      if (res.status === 400) {
        logTest('10.2 Phase 5: Invalid Battery Level (> 100) Rejected (400 Bad Request)', true);
        passed++;
      } else {
        logTest('10.2 Phase 5: Invalid Battery Level (> 100) Rejected (400 Bad Request)', false, `Expected 400 but got ${res.status}`);
        failed++;
      }
    } catch (e: any) {
      logTest('10.2 Phase 5: Invalid Battery Level (> 100) Rejected (400 Bad Request)', false, e.message);
      failed++;
    }

    // 10.3 Invalid Warranty Date format Rejected
    try {
      const res = await fetch(`${BASE_URL}/devices/${singleDeviceId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${store1Token}`,
        },
        body: JSON.stringify({
          warrantyUntil: 'next-year-sometime', // INVALID DATE
        }),
      });
      if (res.status === 400) {
        logTest('10.3 Phase 5: Invalid Warranty Date Format Rejected (400 Bad Request)', true);
        passed++;
      } else {
        logTest('10.3 Phase 5: Invalid Warranty Date Format Rejected (400 Bad Request)', false, `Expected 400 but got ${res.status}`);
        failed++;
      }
    } catch (e: any) {
      logTest('10.3 Phase 5: Invalid Warranty Date Format Rejected (400 Bad Request)', false, e.message);
      failed++;
    }

    // 10.4 Tenant Mass-Assignment Immunity (storeId & customerId cannot be injected)
    try {
      const originalDevice = await prisma.ioTButton.findUnique({ where: { deviceId: singleDeviceId } });
      const res = await fetch(`${BASE_URL}/devices/${singleDeviceId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${store1Token}`,
        },
        body: JSON.stringify({
          storeId: 999999, // FORBIDDEN MASS ASSIGNMENT
          customerId: 888888, // FORBIDDEN MASS ASSIGNMENT
          description: 'Mass assignment check',
        }),
      });
      const dbDeviceAfter = await prisma.ioTButton.findUnique({ where: { deviceId: singleDeviceId } });
      const storeUntouched = String(dbDeviceAfter?.storeId) === String(originalDevice?.storeId);
      const customerUntouched = dbDeviceAfter?.customerId === originalDevice?.customerId;

      if (storeUntouched && customerUntouched) {
        logTest('10.4 Phase 5: Mass Assignment Immunity (storeId and customerId protected)', true);
        passed++;
      } else {
        logTest('10.4 Phase 5: Mass Assignment Immunity (storeId and customerId protected)', false, `Store or Customer mutated!`);
        failed++;
      }
    } catch (e: any) {
      logTest('10.4 Phase 5: Mass Assignment Immunity (storeId and customerId protected)', false, e.message);
      failed++;
    }

    // 10.5 Quantity without Product rejected (400 Bad Request)
    try {
      const noProdDeviceId = `SOB-NOPROD-${Date.now().toString().slice(-6)}`;
      createdDeviceIds.push(noProdDeviceId);
      await prisma.ioTButton.create({
        data: {
          storeId: BigInt(store1Id),
          customerId: seedCustomerId,
          addressId: seedAddressId,
          deviceId: noProdDeviceId,
          buttonCode: noProdDeviceId,
          buttonName: `No Prod ${noProdDeviceId}`,
          hmacSecret: 'test_secret_32bytes_sample_hmac_noprod',
          status: 'ACTIVE',
        },
      });

      const res = await fetch(`${BASE_URL}/devices/${noProdDeviceId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${store1Token}`,
        },
        body: JSON.stringify({
          quantity: 5,
        }),
      });
      if (res.status === 400) {
        logTest('10.5 Phase 5: Setting Quantity Without Product Rejected (400 Bad Request)', true);
        passed++;
      } else {
        logTest('10.5 Phase 5: Setting Quantity Without Product Rejected (400 Bad Request)', false, `Expected 400 but got ${res.status}`);
        failed++;
      }
    } catch (e: any) {
      logTest('10.5 Phase 5: Setting Quantity Without Product Rejected (400 Bad Request)', false, e.message);
      failed++;
    }

    // -------------------------------------------------------------------------
    // 11. Phase 6: Device Allocation with Row-Locking & WebSockets
    // -------------------------------------------------------------------------
    const allocTestDeviceId = `SOB-ALLOC-${Date.now().toString().slice(-6)}`;
    createdDeviceIds.push(allocTestDeviceId);
    await prisma.ioTButton.create({
      data: {
        deviceId: allocTestDeviceId,
        buttonCode: allocTestDeviceId,
        buttonName: `Alloc Button ${allocTestDeviceId}`,
        hmacSecret: 'test_secret_key_allocated_32bytes',
        status: 'UNASSIGNED',
        storeId: BigInt(store1Id),
        customerId: seedCustomerId,
        addressId: seedAddressId,
      },
    });

    // 11.1 Allocation to current store succeeds
    try {
      const res = await fetch(`${BASE_URL}/devices/allocate-store`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          deviceIds: [allocTestDeviceId],
          targetStoreId: store1Id,
        }),
      });
      const data = await res.json();
      if ((res.status === 200 || res.status === 201) && (data.data?.succeeded === 1 || data.succeeded === 1)) {
        const dbDev = await prisma.ioTButton.findUnique({ where: { deviceId: allocTestDeviceId } });
        if (String(dbDev?.storeId) === String(store1Id) && dbDev?.status === 'ACTIVE') {
          logTest('11.1 Phase 6: Atomic Device Allocation with Row-Locking Succeeded', true);
          passed++;
        } else {
          throw new Error(`Device state after allocation invalid: storeId=${dbDev?.storeId}, status=${dbDev?.status}`);
        }
      } else {
        throw new Error(data.message || `Status: ${res.status}`);
      }
    } catch (e: any) {
      logTest('11.1 Phase 6: Atomic Device Allocation with Row-Locking Succeeded', false, e.message);
      failed++;
    }

    // 11.2 Conflict check: allocating an already assigned device to another store is rejected
    try {
      const res = await fetch(`${BASE_URL}/devices/allocate-store`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          deviceIds: [allocTestDeviceId],
          targetStoreId: store2Id, // DIFFERENT STORE!
        }),
      });
      if (res.status === 400) {
        logTest('11.2 Phase 6: Re-allocating Assigned Device to Different Store Rejected (400)', true);
        passed++;
      } else {
        logTest('11.2 Phase 6: Re-allocating Assigned Device to Different Store Rejected (400)', false, `Expected 400 but got ${res.status}`);
        failed++;
      }
    } catch (e: any) {
      logTest('11.2 Phase 6: Re-allocating Assigned Device to Different Store Rejected (400)', false, e.message);
      failed++;
    }

    // -------------------------------------------------------------------------
    // 12. Phase 7: Granular Role Enforcement (SYSTEM_ADMIN allowed, CUSTOMER forbidden)
    // -------------------------------------------------------------------------
    // 12.1 Customer is blocked with 403 Forbidden on Device Templates
    try {
      const res = await fetch(`${BASE_URL}/device-templates`, {
        headers: { Authorization: `Bearer ${customerToken}` },
      });
      if (res.status === 403) {
        logTest('12.1 Phase 7: Customer blocked from /device-templates (403 Forbidden)', true);
        passed++;
      } else {
        logTest('12.1 Phase 7: Customer blocked from /device-templates (403 Forbidden)', false, `Expected 403 but got ${res.status}`);
        failed++;
      }
    } catch (e: any) {
      logTest('12.1 Phase 7: Customer blocked from /device-templates (403 Forbidden)', false, e.message);
      failed++;
    }

    // 12.2 Customer is blocked with 403 Forbidden on Device Allocation
    try {
      const res = await fetch(`${BASE_URL}/devices/allocate-store`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${customerToken}`,
        },
        body: JSON.stringify({
          deviceIds: [allocTestDeviceId],
          targetStoreId: store1Id,
        }),
      });
      if (res.status === 403) {
        logTest('12.2 Phase 7: Customer blocked from /devices/allocate-store (403 Forbidden)', true);
        passed++;
      } else {
        logTest('12.2 Phase 7: Customer blocked from /devices/allocate-store (403 Forbidden)', false, `Expected 403 but got ${res.status}`);
        failed++;
      }
    } catch (e: any) {
      logTest('12.2 Phase 7: Customer blocked from /devices/allocate-store (403 Forbidden)', false, e.message);
      failed++;
    }

    // 12.3 System Admin is granted access to Device Templates
    try {
      const res = await fetch(`${BASE_URL}/device-templates`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      if (res.status === 200) {
        logTest('12.3 Phase 7: System Admin granted access to /device-templates (200 OK)', true);
        passed++;
      } else {
        logTest('12.3 Phase 7: System Admin granted access to /device-templates (200 OK)', false, `Expected 200 but got ${res.status}`);
        failed++;
      }
    } catch (e: any) {
      logTest('12.3 Phase 7: System Admin granted access to /device-templates (200 OK)', false, e.message);
      failed++;
    }

    // -------------------------------------------------------------------------
    // 13. Phase 8: Order Status Normalization (OUT_FOR_DELIVERY -> READY_FOR_DELIVERY)
    // -------------------------------------------------------------------------
    try {
      // Create a test order directly in PREPARING status
      const customer = await prisma.user.findUnique({ where: { email: 'customer@smartorder.local' } });
      const sglBtn = await prisma.ioTButton.findUnique({ where: { deviceId: singleDeviceId } });
      const testOrder = await prisma.order.create({
        data: {
          orderCode: `ORD-TST-${Date.now().toString().slice(-6)}`,
          storeId: BigInt(store1Id),
          customerId: seedCustomerId,
          buttonId: sglBtn!.buttonId,
          orderStatus: 'PREPARING',
          paymentMethod: 'COD',
          subtotalAmount: 35000,
          discountAmount: 0,
          shippingFee: 15000,
          totalAmount: 50000,
          shippingRecipientName: 'Nguyen Van An',
          shippingPhone: '0988776655',
          shippingAddress: '123 Le Loi, Dist 1, HCMC',
        },
      });
      testOrderId = String(testOrder.orderId);

      // Store Owner transitions status using the frontend alias "OUT_FOR_DELIVERY"
      const res = await fetch(`${BASE_URL}/orders/${testOrderId}/status`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${store1Token}`,
        },
        body: JSON.stringify({
          status: 'OUT_FOR_DELIVERY', // Frontend alias
        }),
      });
      const data = await res.json();

      // Check DB order status: should be normalized to 'READY_FOR_DELIVERY'
      const updatedOrder = await prisma.order.findUnique({
        where: { orderId: BigInt(testOrderId) },
      });

      if (res.status === 200 && updatedOrder?.orderStatus === 'READY_FOR_DELIVERY') {
        logTest('13. Phase 8: OUT_FOR_DELIVERY alias normalized to READY_FOR_DELIVERY and state machine updated', true);
        passed++;
      } else {
        logTest(
          '13. Phase 8: OUT_FOR_DELIVERY alias normalized to READY_FOR_DELIVERY and state machine updated',
          false,
          `HTTP ${res.status}, DB Status: ${updatedOrder?.orderStatus}, Resp: ${JSON.stringify(data)}`
        );
        failed++;
      }
    } catch (e: any) {
      logTest('13. Phase 8: OUT_FOR_DELIVERY alias normalized to READY_FOR_DELIVERY and state machine updated', false, e.message);
      failed++;
    }

  } finally {
    // -------------------------------------------------------------------------
    // Cleanup
    // -------------------------------------------------------------------------
    console.log('\n🧹 Cleaning up test artifacts...');
    try {
      if (testOrderId) {
        await prisma.orderStatusHistory.deleteMany({ where: { orderId: BigInt(testOrderId) } });
        await prisma.orderItem.deleteMany({ where: { orderId: BigInt(testOrderId) } });
        await prisma.order.deleteMany({ where: { orderId: BigInt(testOrderId) } });
      }
      if (createdDeviceIds.length > 0) {
        await prisma.buttonProduct.deleteMany({
          where: { button: { deviceId: { in: createdDeviceIds } } },
        });
        await prisma.ioTButton.deleteMany({
          where: { deviceId: { in: createdDeviceIds } },
        });
      }
      if (createdTemplateIds.length > 0) {
        await prisma.deviceTemplate.deleteMany({
          where: { templateId: { in: createdTemplateIds.map((id) => BigInt(id)) } },
        });
      }
      console.log('✔ Cleanup complete.');
    } catch (e: any) {
      console.warn('⚠️ Cleanup error:', e.message);
    }
  }

  console.log('\n------------------------------------------------------------------------');
  console.log(`TOTAL: ${passed + failed} | PASSED: ${passed} | FAILED: ${failed}`);
  console.log('------------------------------------------------------------------------\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runDeviceTemplateAndBulkDeployTests().catch((err) => {
  console.error('Fatal Test Runner Error:', err);
  process.exit(1);
});
