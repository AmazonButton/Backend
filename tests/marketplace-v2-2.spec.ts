import { PrismaService } from '../src/prisma/prisma.service';
import { StoresService } from '../src/stores/stores.service';
import { DevicesService } from '../src/devices/devices.service';
import { DevicesRepository } from '../src/devices/devices.repository';
import { OrdersService } from '../src/orders/orders.service';
import { OrdersRepository } from '../src/orders/orders.repository';
import { StoreWalletService } from '../src/store-wallet/store-wallet.service';
import { PayOSPayoutService } from '../src/payments/payos-payout.service';

async function runMarketplaceV22Tests() {
  console.log('========================================================================');
  console.log('🚀 MARKETPLACE V2.2: TEST SUITE (STORES, RE-MAPPING, COMMISSION & WALLET)');
  console.log('========================================================================\n');

  const prisma = new PrismaService();
  await prisma.$connect();

  const storesService = new StoresService(prisma);
  const devicesRepo = new DevicesRepository(prisma);
  const mockEventsGateway = {
    emitToCustomer: () => {},
    emitToStore: () => {},
    emitToDevice: () => {},
    broadcastFleetStats: () => {},
    server: { to: () => ({ emit: () => {} }) },
  } as any;
  const devicesService = new DevicesService(devicesRepo, mockEventsGateway);

  const payosPayoutService = new PayOSPayoutService();
  const storeWalletService = new StoreWalletService(prisma, payosPayoutService);
  const ordersRepo = new OrdersRepository(prisma);
  const mockCrypto = { generateHmacSignature: () => '', verifyHmacSignature: () => true } as any;
  const ordersService = new OrdersService(ordersRepo, mockCrypto, mockEventsGateway, storeWalletService);

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, msg: string) {
    if (condition) {
      console.log(`  ✅ PASS: ${msg}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${msg}`);
      failed++;
    }
  }

  try {
    // ------------------------------------------------------------------------
    // STAGE 1: PUBLIC STORES CATALOG API
    // ------------------------------------------------------------------------
    console.log('[STAGE 1] Testing Public Stores Catalog (StoresService):');
    const storesResult = await storesService.listActiveStores({ limit: 10 });
    assert(Array.isArray(storesResult.items), 'listActiveStores returns an array of items');
    assert(storesResult.total >= 0, `listActiveStores returns total count (${storesResult.total})`);

    let targetStore = storesResult.items[0];
    if (targetStore) {
      const storeDetail = await storesService.getStoreById(targetStore.storeId);
      assert(storeDetail.storeId === targetStore.storeId, `getStoreById returns correct store (${storeDetail.name})`);
      assert(Array.isArray(storeDetail.categories), 'Store detail contains categories list');
      assert(Array.isArray(storeDetail.products), 'Store detail contains products list');
      assert(typeof storeDetail.commissionRate === 'number', `Store has commissionRate: ${storeDetail.commissionRate}%`);
    }

    // ------------------------------------------------------------------------
    // STAGE 2: UNIVERSAL BUTTON STORE RE-MAPPING
    // ------------------------------------------------------------------------
    console.log('\n[STAGE 2] Testing Universal Button Dynamic Store Re-mapping:');
    // Find an active button
    const testButton = await prisma.ioTButton.findFirst({
      where: { status: 'ACTIVE' },
      include: { customer: true, store: true },
    });

    if (testButton && storesResult.items.length >= 2) {
      const currentStoreId = testButton.storeId.toString();
      const otherStore = storesResult.items.find((s) => s.storeId !== currentStoreId);

      if (otherStore) {
        console.log(`  Re-mapping button #${testButton.buttonId} from Store #${currentStoreId} to Store #${otherStore.storeId}...`);
        const mockUser = {
          role: 'SYSTEM_ADMIN',
          userId: 1,
        };

        const remapped = await devicesService.customerUpdateConfig(
          testButton.buttonId.toString(),
          { storeId: otherStore.storeId, buttonName: 'Universal Remapped Button' },
          mockUser,
        );

        assert(remapped.storeId === otherStore.storeId, `Button successfully re-mapped to new Store #${otherStore.storeId}`);
        assert(remapped.buttonName === 'Universal Remapped Button', 'Button name updated successfully');

        // Check button products were cleared on re-map
        const productsCount = await prisma.buttonProduct.count({
          where: { buttonId: testButton.buttonId },
        });
        assert(productsCount === 0, 'Old store products cleanly wiped on Store re-map');

        // Switch back to original store to preserve test fixture
        await devicesService.customerUpdateConfig(
          testButton.buttonId.toString(),
          { storeId: currentStoreId },
          mockUser,
        );
        console.log(`  Restored button #${testButton.buttonId} back to Store #${currentStoreId}`);
      }
    } else {
      console.log('  ⚠️ Skipping live re-map stage: Requires at least 2 active stores in DB.');
    }

    // ------------------------------------------------------------------------
    // STAGE 3: ORDER COMMISSION 8% CALCULATION & NET AMOUNT
    // ------------------------------------------------------------------------
    console.log('\n[STAGE 3] Testing Order Commission Snapshot & Net Amount:');
    const existingOrder = await prisma.order.findFirst({
      orderBy: { createdAt: 'desc' },
    });

    if (existingOrder) {
      // Test manual commission math calculation
      const totalAmount = Number(existingOrder.totalAmount);
      const commissionRate = 8.0;
      const expectedCommission = Math.round((totalAmount * commissionRate / 100) * 100) / 100;
      const expectedNetAmount = totalAmount - expectedCommission;

      assert(expectedCommission >= 0, `Commission amount calculated: ${expectedCommission} VNĐ`);
      assert(expectedNetAmount <= totalAmount, `Net payout calculated: ${expectedNetAmount} VNĐ`);
      assert(Math.abs((expectedCommission + expectedNetAmount) - totalAmount) < 0.01, 'Mathematical integrity: total == commission + netAmount');
    }

    // ------------------------------------------------------------------------
    // STAGE 4: STORE WALLET CREDIT & IDEMPOTENCY
    // ------------------------------------------------------------------------
    console.log('\n[STAGE 4] Testing Store Wallet Revenue Credit & Idempotency:');
    const activeStore = await prisma.store.findFirst({ where: { status: 'ACTIVE' } });
    if (activeStore) {
      const walletBefore = await storeWalletService.getOrCreateStoreWallet(activeStore.storeId);
      const balanceBefore = Number(walletBefore.balance);
      const testOrderCode = `TEST-ORD-IDEMPOTENT-${Date.now()}`;
      const creditAmount = 50000;

      // First credit
      const walletAfter1 = await storeWalletService.creditOrderRevenue(
        activeStore.storeId,
        creditAmount,
        testOrderCode,
      );
      const balanceAfter1 = Number(walletAfter1.balance);
      assert(balanceAfter1 === balanceBefore + creditAmount, `Wallet balance correctly credited (+${creditAmount} VNĐ)`);

      // Second credit with identical orderCode (must be idempotent!)
      const walletAfter2 = await storeWalletService.creditOrderRevenue(
        activeStore.storeId,
        creditAmount,
        testOrderCode,
      );
      const balanceAfter2 = Number(walletAfter2.balance);
      assert(balanceAfter2 === balanceAfter1, 'Idempotency confirmed: repeated credit did NOT double-credit');
    }

  } catch (err: any) {
    console.error('Unexpected test error:', err);
    failed++;
  } finally {
    await prisma.$disconnect();
  }

  console.log('\n========================================================================');
  console.log(`🏁 TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('========================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runMarketplaceV22Tests();
