import { StoreSubscriptionsService } from '../src/store-subscriptions/store-subscriptions.service';
import { DevicesService } from '../src/devices/devices.service';
import { ForbiddenException, BadRequestException } from '@nestjs/common';

async function runTask2TestSuite() {
  console.log('================================================================================');
  console.log('⚡ TASK 2: STORE 60K SHELF FEE & DEVICE WAREHOUSE INVENTORY TEST SUITE');
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

  try {
    // -------------------------------------------------------------
    // Part A: Store 60k Shelf Fee & Product Publishing Lock
    // -------------------------------------------------------------
    const mockSubRepo: any = {
      getCurrentSubscription: async () => null,
      countStoreProducts: async () => 0,
      countTotalPlans: async () => 1,
    };
    const mockWalletService: any = {};
    const subService = new StoreSubscriptionsService(mockSubRepo, mockWalletService);

    // Test 1: Store has active 60k subscription -> allowed to list products
    mockSubRepo.getCurrentSubscription = async () => ({
      subscriptionId: BigInt(1),
      storeId: BigInt(10),
      status: 'ACTIVE',
      endDate: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000), // 15 days left
      plan: { maxProducts: 50, planName: 'Gói Duy Trì Kệ 60k' },
    });
    mockSubRepo.countStoreProducts = async () => 10;

    const canList = await subService.validateStoreCanListProducts(BigInt(10));
    assert(canList === true, 'Store with active 60k subscription is allowed to list products');

    // Test 2: Store subscription expired -> throws ForbiddenException (product lock invariant)
    mockSubRepo.getCurrentSubscription = async () => null;

    let expiredBlocked = false;
    try {
      await subService.validateStoreCanListProducts(BigInt(10));
    } catch (err: any) {
      if (err instanceof ForbiddenException || err.status === 403) {
        expiredBlocked = true;
      }
    }
    assert(
      expiredBlocked === true,
      'Expired shelf fee strictly blocks product listing (ForbiddenException / 403)',
    );

    // -------------------------------------------------------------
    // Part B: Device Custody & Warehouse Inventory Tracking
    // -------------------------------------------------------------
    const mockDevicesRepo: any = {
      allocateDevicesToStoreTx: async () => ({}),
      getStoreDeviceInventory: async () => ({}),
    };
    const mockEventsGateway: any = {
      emitToStore: () => {},
      emitToUser: () => {},
    };

    const devicesService = new DevicesService(mockDevicesRepo, null as any, mockEventsGateway as any);

    // Test 3: Allocate devices from platform warehouse to store custody
    mockDevicesRepo.allocateDevicesToStoreTx = async () => ({
      targetStoreId: BigInt(77),
      ownerUserId: '1',
      deviceIds: ['DEV-TEST-01', 'DEV-TEST-02'],
      inventoryState: 'ALLOCATED_TO_STORE',
      custodyStoreId: BigInt(77),
    });

    const allocRes = await devicesService.allocateDevicesToStore(
      { targetStoreId: '77', deviceIds: ['DEV-TEST-01', 'DEV-TEST-02'] },
      { role: 'SUPER_ADMIN' },
    );

    assert(
      allocRes.success === true && allocRes.data.succeeded === 2,
      'Admin allocates buttons to Store warehouse custody (ALLOCATED_TO_STORE)',
    );

    // Test 4: Device inventory tracking by store
    mockDevicesRepo.getStoreDeviceInventory = async () => ({
      storeId: '77',
      inStockInStore: 5,
      deployedOnStoreCatalog: 12,
      rentedByCustomers: 8,
      totalCustody: 25,
    });

    const inv = await devicesService.getStoreDeviceInventory(BigInt(77), {
      userId: 10,
      storeId: 77,
      role: 'STORE_OWNER',
    });
    assert(
      inv.inStockInStore === 5 &&
        inv.deployedOnStoreCatalog === 12 &&
        inv.rentedByCustomers === 8 &&
        inv.totalCustody === 25,
      'Store device inventory returns precise counts of in-stock, catalog deployed, and user-rented buttons',
      `Got inStock=${inv.inStockInStore}, deployed=${inv.deployedOnStoreCatalog}, rented=${inv.rentedByCustomers}`,
    );

    // Test 5: BOLA protection on getStoreDeviceInventory
    let storeBolaCaught = false;
    try {
      // Store Owner of Store 99 tries to inspect Store 77 inventory
      await devicesService.getStoreDeviceInventory(BigInt(77), {
        userId: 20,
        storeId: 99,
        role: 'STORE_OWNER',
      });
    } catch (e: any) {
      storeBolaCaught = e.status === 403 || e.name === 'ForbiddenException';
    }
    assert(storeBolaCaught, 'BOLA: Store Owner of Store 99 is rejected with 403 Forbidden when accessing Store 77 inventory');

  } catch (err: any) {
    console.error('Fatal test error:', err);
    failed++;
  }

  console.log(`\n================================================================================`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log(`================================================================================\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

runTask2TestSuite();
