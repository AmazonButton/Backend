import 'dotenv/config';
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from '../src/common/guards/roles.guard';
import { PrismaService } from '../src/prisma/prisma.service';
import { ProductsController } from '../src/products/products.controller';
import { ProductsService } from '../src/products/products.service';
import { ProductsRepository } from '../src/products/products.repository';
import { ProvisioningRepository } from '../src/devices/provisioning.repository';
import { BillingChargesRepository } from '../src/billing-charges/billing-charges.repository';
import { OrdersRepository } from '../src/orders/orders.repository';
import { OrdersLifecycleWorker } from '../src/orders/orders-lifecycle.worker';
import { PaymentsRepository } from '../src/payments/payments.repository';
import { WarrantyRepository } from '../src/warranty/warranty.repository';
import { BILLING_PAYOS_CHANNEL } from '../src/store-cash/store-cash-settlement.transaction';

function assertSafeTestDatabaseUrl(): void {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    throw new Error('DATABASE_URL is required for PostgreSQL concurrency tests');
  }
  const parsed = new URL(dbUrl);
  const host = parsed.hostname.toLowerCase();
  const dbName = parsed.pathname.replace(/^\/+/, '').toLowerCase();
  if (host.includes('supabase.co') || host.includes('supabase.com')) {
    throw new Error(`Refusing to run PostgreSQL test against Supabase host: ${host}`);
  }
  if (!dbName.endsWith('_test')) {
    throw new Error(`Refusing to run PostgreSQL test against non-_test database: ${dbName}`);
  }
}

async function runPostgresTests() {
  assertSafeTestDatabaseUrl();

  const prisma = new PrismaService();
  await prisma.$connect();

  const ts = Date.now();
  const phonePrefix = String(ts).slice(-7);

  const createdUserIds: bigint[] = [];
  const createdCustomerIds: bigint[] = [];
  const createdStoreIds: bigint[] = [];
  const createdProductIds: bigint[] = [];
  const createdPlanIds: bigint[] = [];
  const createdChargeIds: bigint[] = [];
  const createdPackageIds: bigint[] = [];
  const createdRentalIds: bigint[] = [];
  const createdButtonIds: bigint[] = [];
  const createdOrderIds: bigint[] = [];
  const createdSessionIds: string[] = [];
  const createdDeviceIds: string[] = [];

  let passed = 0;
  const check = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
      passed++;
      console.log(`  ✔ [PASS] ${name}`);
    } catch (err: any) {
      console.error(`  ✖ [FAIL] ${name}: ${err?.stack || err?.message || err}`);
      throw err;
    }
  };

  console.log('\n========================================================================');
  console.log('🐘 REAL POSTGRESQL VERIFICATION FOR BATCH 2 & 3 (#7, #1, #8, #10)');
  console.log('========================================================================\n');

  try {
    // Shared fixtures
    const ownerA = await prisma.user.create({
      data: {
        username: `pg_b23_ownerA_${ts}`,
        email: `pg_b23_ownerA_${ts}@test.local`,
        fullName: 'PG Owner A',
        status: 'ACTIVE',
      },
    });
    const ownerB = await prisma.user.create({
      data: {
        username: `pg_b23_ownerB_${ts}`,
        email: `pg_b23_ownerB_${ts}@test.local`,
        fullName: 'PG Owner B',
        status: 'ACTIVE',
      },
    });
    const custUserA = await prisma.user.create({
      data: {
        username: `pg_b23_custA_${ts}`,
        email: `pg_b23_custA_${ts}@test.local`,
        fullName: 'PG Cust A',
        status: 'ACTIVE',
      },
    });
    const custUserB = await prisma.user.create({
      data: {
        username: `pg_b23_custB_${ts}`,
        email: `pg_b23_custB_${ts}@test.local`,
        fullName: 'PG Cust B',
        status: 'ACTIVE',
      },
    });
    const custUserC = await prisma.user.create({
      data: {
        username: `pg_b23_custC_${ts}`,
        email: `pg_b23_custC_${ts}@test.local`,
        fullName: 'PG Cust C',
        status: 'ACTIVE',
      },
    });
    createdUserIds.push(ownerA.userId, ownerB.userId, custUserA.userId, custUserB.userId, custUserC.userId);

    const custA = await prisma.customerProfile.create({ data: { userId: custUserA.userId, phone: `091${phonePrefix}` } });
    const custB = await prisma.customerProfile.create({ data: { userId: custUserB.userId, phone: `092${phonePrefix}` } });
    const custC = await prisma.customerProfile.create({ data: { userId: custUserC.userId, phone: `093${phonePrefix}` } });
    createdCustomerIds.push(custA.customerId, custB.customerId, custC.customerId);

    const storeActive = await prisma.store.create({
      data: {
        ownerUserId: ownerA.userId,
        name: `PG Active Store ${ts}`,
        code: `PG_ACT_${ts}`,
        phone: `081${phonePrefix}`,
        address: '10 Active Street',
        status: 'ACTIVE',
      },
    });
    const storeSuspended = await prisma.store.create({
      data: {
        ownerUserId: ownerB.userId,
        name: `PG Suspended Store ${ts}`,
        code: `PG_SUS_${ts}`,
        phone: `082${phonePrefix}`,
        address: '20 Suspended Street',
        status: 'SUSPENDED',
      },
    });
    createdStoreIds.push(storeActive.storeId, storeSuspended.storeId);

    const prodActive = await prisma.product.create({
      data: {
        storeId: storeActive.storeId,
        productCode: `PG_ACT_${ts}`,
        productName: `San pham PG Active ${ts}`,
        basePrice: 45000,
        status: 'ACTIVE',
      },
    });
    const prodInactive = await prisma.product.create({
      data: {
        storeId: storeActive.storeId,
        productCode: `PG_INA_${ts}`,
        productName: `San pham PG Inactive ${ts}`,
        basePrice: 45000,
        status: 'INACTIVE',
      },
    });
    const prodSuspendedStore = await prisma.product.create({
      data: {
        storeId: storeSuspended.storeId,
        productCode: `PG_SUS_${ts}`,
        productName: `San pham PG Suspended Store ${ts}`,
        basePrice: 50000,
        status: 'ACTIVE',
      },
    });
    createdProductIds.push(prodActive.productId, prodInactive.productId, prodSuspendedStore.productId);

    await prisma.inventory.create({
      data: {
        productId: prodActive.productId,
        storeId: storeActive.storeId,
        quantityOnHand: 15,
        reservedQuantity: 4,
        minStockAlert: 3,
      },
    });
    await prisma.inventory.create({
      data: {
        productId: prodInactive.productId,
        storeId: storeActive.storeId,
        quantityOnHand: 8,
        reservedQuantity: 0,
        minStockAlert: 2,
      },
    });

    // -------------------------------------------------------------------------
    // TEST 1 (#7): PostgreSQL GET /products role scoping & public projection
    // -------------------------------------------------------------------------
    await check('#7 [PostgreSQL] CUSTOMER receives only ACTIVE product of ACTIVE store with computed availableStock and stripped internals; STORE_OWNER isolated', async () => {
      const productsRepo = new ProductsRepository(prisma);
      const productsService = new ProductsService(productsRepo, {} as any, {} as any);
      const controller = new ProductsController(productsService);
      const rolesGuard = new RolesGuard(new Reflector());

      // SYSTEM_STAFF blocked by RolesGuard
      assert.throws(
        () =>
          rolesGuard.canActivate({
            getHandler: () => ProductsController.prototype.list,
            getClass: () => ProductsController,
            switchToHttp: () => ({ getRequest: () => ({ user: { role: 'SYSTEM_STAFF' } }) }),
          } as any),
        (err: any) => err instanceof ForbiddenException,
      );

      // CUSTOMER scoped search on active product prefix
      const custRes: any = await controller.list(
        { user: { role: 'CUSTOMER', userId: custUserA.userId.toString() } },
        { page: 1, pageSize: 20, search: String(ts) } as any,
      );
      const ids = custRes.data.map((p: any) => p.productId);
      assert.ok(ids.includes(prodActive.productId.toString()), 'ACTIVE product in ACTIVE store must be returned');
      assert.ok(!ids.includes(prodInactive.productId.toString()), 'INACTIVE product must be excluded for CUSTOMER');
      assert.ok(!ids.includes(prodSuspendedStore.productId.toString()), 'Product of SUSPENDED store must be excluded for CUSTOMER');

      const pubItem = custRes.data.find((p: any) => p.productId === prodActive.productId.toString());
      assert.strictEqual(pubItem.availableStock, 11);
      assert.strictEqual(pubItem.stock, 11);
      assert.strictEqual('reservedQuantity' in pubItem, false);
      assert.strictEqual('minStockAlert' in pubItem, false);
      assert.strictEqual('inventory' in pubItem, false);

      // CUSTOMER trying explicit storeId of SUSPENDED store gets zero rows
      const susRes: any = await controller.list(
        { user: { role: 'CUSTOMER', userId: custUserA.userId.toString() } },
        { page: 1, pageSize: 20, storeId: storeSuspended.storeId.toString() } as any,
      );
      assert.strictEqual(susRes.data.length, 0);

      // STORE_OWNER A gets own store products including INACTIVE, blocked from Store B
      const ownerRes: any = await controller.list(
        { user: { role: 'STORE_OWNER', userId: ownerA.userId.toString(), storeId: storeActive.storeId.toString() } },
        { page: 1, pageSize: 20 } as any,
      );
      assert.strictEqual(ownerRes.data.length, 2);

      await assert.rejects(
        () =>
          controller.list(
            { user: { role: 'STORE_OWNER', userId: ownerA.userId.toString(), storeId: storeActive.storeId.toString() } },
            { page: 1, pageSize: 20, storeId: storeSuspended.storeId.toString() } as any,
          ),
        (err: any) => err instanceof ForbiddenException,
      );
    });

    // -------------------------------------------------------------------------
    // TEST 2 (#1): PostgreSQL Provisioning locks, rental/deposit/return/warranty blocks,
    // rollback preservation & concurrent /transfer race
    // -------------------------------------------------------------------------
    await check('#1a [PostgreSQL] Rental/deposit/locked/return/warranty block confirmPairing, /transfer & /unclaim with full session rollback', async () => {
      const provRepo = new ProvisioningRepository(prisma);
      const pkg = await prisma.rentalPackage.create({
        data: {
          packageCode: `PKG_PG_${ts}`,
          packageName: 'Goi PG Test',
          buttonQuantity: 1,
          monthlyPrice: 50000,
          depositFee: 100000,
          isActive: true,
        },
      });
      createdPackageIds.push(pkg.packageId);

      const rental = await prisma.buttonRental.create({
        data: {
          rentalCode: `RNT_PG_${ts}`,
          customerId: custA.customerId,
          packageId: pkg.packageId,
          fulfillmentStoreId: storeActive.storeId,
          totalRentAmount: 50000,
          depositAmount: 100000,
          startDate: new Date(),
          endDate: new Date(Date.now() + 30 * 86400_000),
          effectiveExpiresAt: new Date(Date.now() + 30 * 86400_000),
          status: 'ACTIVE',
        },
      });
      createdRentalIds.push(rental.rentalId);

      await prisma.rentalDeposit.create({
        data: {
          rentalId: rental.rentalId,
          collectedAmount: 100000,
          heldAmount: 100000,
          refundReservedAmount: 0,
          refundedAmount: 0,
        },
      });

      const rentedDevId = `SOB-PG-RNT-${ts}`;
      createdDeviceIds.push(rentedDevId);
      const rentedBtn = await prisma.ioTButton.create({
        data: {
          deviceId: rentedDevId,
          buttonCode: `BTN_RNT_${ts}`,
          storeId: storeActive.storeId,
          customerId: custA.customerId,
          rentalId: rental.rentalId,
          hmacSecret: 'sec_0123456789abcdef0123456789abcdef',
          status: 'ACTIVE',
          inventoryState: 'IN_CUSTOMER_CUSTODY',
          canOrder: true,
        },
      });
      createdButtonIds.push(rentedBtn.buttonId);

      const sessRented = `sess_pg_rnt_${ts}`;
      createdSessionIds.push(sessRented);
      await provRepo.createProvisioningSession(
        sessRented,
        `hash_${sessRented}`,
        rentedBtn.buttonId,
        { sessionId: sessRented },
        null,
        new Date(Date.now() + 600_000),
      );

      // Customer B cannot take over rented button
      await assert.rejects(
        () => provRepo.confirmPairingAtomicTx(sessRented, custB.customerId, { productId: prodActive.productId }),
        (err: any) => err instanceof ConflictException,
      );
      const sessAfterFail = await prisma.provisioningSession.findUnique({ where: { sessionId: sessRented } });
      assert.strictEqual(sessAfterFail?.status, 'ACTIVE', 'Session must remain ACTIVE after rollback');

      // Customer A cannot /transfer, /unclaim, or factory-reset while rental & deposit held
      await assert.rejects(
        () => provRepo.initiateTransferAtomicTx(rentedBtn.buttonId, `th_${ts}`, new Date(Date.now() + 60_000), custA.customerId),
        (err: any) => err instanceof ConflictException,
      );
      await assert.rejects(
        () => provRepo.unclaimDeviceAtomicTx(rentedBtn.buttonId, custA.customerId),
        (err: any) => err instanceof ConflictException,
      );
      await assert.rejects(
        () => provRepo.factoryResetAtomicTx(rentedBtn.buttonId),
        (err: any) => err instanceof ConflictException,
      );

      // Same Customer A with PENDING RentalReturn is blocked
      const ret = await prisma.rentalReturn.create({
        data: {
          returnCode: `RET_PG_${ts}`,
          rentalId: rental.rentalId,
          buttonId: rentedBtn.buttonId,
          status: 'PENDING_RECEIPT',
        },
      });
      assert.ok(ret.returnId);
      await assert.rejects(
        () => provRepo.confirmPairingAtomicTx(sessRented, custA.customerId, { productId: prodActive.productId }),
        (err: any) => err instanceof ConflictException,
      );
      await prisma.rentalReturn.delete({ where: { returnId: ret.returnId } });

      // Open WarrantyTicket blocks same customer too
      const ticket = await prisma.warrantyTicket.create({
        data: {
          ticketCode: `WT_PG_${ts}`,
          buttonId: rentedBtn.buttonId,
          storeId: storeActive.storeId,
          customerId: custA.customerId,
          rentalId: rental.rentalId,
          reportedByUserId: custUserA.userId,
          faultGroup: 'HARDWARE',
          faultCode: 'BUTTON_DEAD',
          status: 'PENDING',
        },
      });
      await assert.rejects(
        () => provRepo.confirmPairingAtomicTx(sessRented, custA.customerId, { productId: prodActive.productId }),
        (err: any) => err instanceof ConflictException,
      );
      await prisma.warrantyTicket.delete({ where: { ticketId: ticket.ticketId } });

      // LOCKED device blocks pairing even for same customer
      await prisma.ioTButton.update({ where: { buttonId: rentedBtn.buttonId }, data: { status: 'LOCKED' } });
      await assert.rejects(
        () => provRepo.confirmPairingAtomicTx(sessRented, custA.customerId, { productId: prodActive.productId }),
        (err: any) => err instanceof ConflictException,
      );
    });

    await check('#1b [PostgreSQL] Concurrent /transfer confirmPairing races under FOR UPDATE serialize to 1 winner + 1 ConflictException', async () => {
      const provRepo = new ProvisioningRepository(prisma);
      const transferDevId = `SOB-PG-XFR-${ts}`;
      createdDeviceIds.push(transferDevId);
      const btn = await prisma.ioTButton.create({
        data: {
          deviceId: transferDevId,
          buttonCode: `BTN_XFR_${ts}`,
          storeId: storeActive.storeId,
          customerId: custA.customerId,
          rentalId: null,
          hmacSecret: 'sec_0123456789abcdef0123456789abcdef',
          status: 'ACTIVE',
          inventoryState: 'IN_CUSTOMER_CUSTODY',
          canOrder: true,
        },
      });
      createdButtonIds.push(btn.buttonId);

      const xfrRes = await provRepo.initiateTransferAtomicTx(
        btn.buttonId,
        `xfr_hash_${ts}`,
        new Date(Date.now() + 600_000),
        custA.customerId,
      );
      assert.strictEqual(xfrRes.status, 'TRANSFER_PENDING');

      const sessB = `sess_pg_xfr_b_${ts}`;
      const sessC = `sess_pg_xfr_c_${ts}`;
      createdSessionIds.push(sessB, sessC);

      await provRepo.createProvisioningSession(
        sessB,
        `hash_${sessB}`,
        btn.buttonId,
        { sessionId: sessB },
        null,
        new Date(Date.now() + 600_000),
      );
      await provRepo.createProvisioningSession(
        sessC,
        `hash_${sessC}`,
        btn.buttonId,
        { sessionId: sessC },
        null,
        new Date(Date.now() + 600_000),
      );

      const [rB, rC] = await Promise.allSettled([
        provRepo.confirmPairingAtomicTx(sessB, custB.customerId, { productId: prodActive.productId }),
        provRepo.confirmPairingAtomicTx(sessC, custC.customerId, { productId: prodActive.productId }),
      ]);

      const fulfilled = [rB, rC].filter((r) => r.status === 'fulfilled');
      const rejected = [rB, rC].filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
      assert.strictEqual(fulfilled.length, 1, 'Exactly 1 customer must win concurrent transfer confirm');
      assert.strictEqual(rejected.length, 1, 'Second concurrent customer must fail cleanly');
      assert.ok(rejected[0].reason instanceof ConflictException, 'Loser must receive ConflictException');

      const winnerCustomerId = rB.status === 'fulfilled' ? custB.customerId : custC.customerId;
      const finalBtn = await prisma.ioTButton.findUnique({ where: { buttonId: btn.buttonId } });
      assert.strictEqual(finalBtn?.customerId, winnerCustomerId);
      assert.strictEqual(finalBtn?.status, 'ACTIVE');

      // Check #1 (Migration constraint): iot_button_status_check is active on DB and rejects invalid status
      const statusConstraints: any[] = await prisma.$queryRawUnsafe(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'iot_button'::regclass AND conname = 'iot_button_status_check'`,
      );
      assert.strictEqual(statusConstraints.length, 1, 'iot_button_status_check constraint must exist in DB');
      assert.ok(String(statusConstraints[0].def).includes('TRANSFER_PENDING'));
      await assert.rejects(
        () =>
          prisma.$executeRawUnsafe(
            `UPDATE iot_button SET status = 'BOGUS_UNSUPPORTED' WHERE button_id = $1`,
            btn.buttonId,
          ),
        (err: any) => String(err?.code) === '23514' || String(err?.message).includes('iot_button_status_check'),
      );
    });

    await check('#1c [PostgreSQL] Historical RECEIVED return permits re-pair & concurrent unclaim vs confirmPairing preserves winner ownership', async () => {
      const provRepo = new ProvisioningRepository(prisma);
      const pkg = await prisma.rentalPackage.create({
        data: {
          packageCode: `PKG_HIST_${ts}`,
          packageName: 'PG Historical Return Pkg',
          buttonQuantity: 1,
          monthlyPrice: 50000,
          depositFee: 100000,
          isActive: true,
        },
      });
      createdPackageIds.push(pkg.packageId);

      const oldRental = await prisma.buttonRental.create({
        data: {
          rentalCode: `RNT_HIST_${ts}`,
          customerId: custA.customerId,
          packageId: pkg.packageId,
          fulfillmentStoreId: storeActive.storeId,
          totalRentAmount: 50000,
          depositAmount: 0,
          startDate: new Date(Date.now() - 10 * 86400_000),
          endDate: new Date(Date.now() - 86400_000),
          status: 'RETURNED',
        },
      });
      createdRentalIds.push(oldRental.rentalId);

      const retDevId = `SOB-PG-HIST-${ts}`;
      createdDeviceIds.push(retDevId);
      const retBtn = await prisma.ioTButton.create({
        data: {
          deviceId: retDevId,
          buttonCode: `BTN_HIST_${ts}`,
          storeId: storeActive.storeId,
          custodyStoreId: storeActive.storeId,
          customerId: null,
          rentalId: null,
          hmacSecret: 'sec_0123456789abcdef0123456789abcdef',
          status: 'INACTIVE',
          inventoryState: 'ALLOCATED_TO_STORE',
          canOrder: false,
        },
      });
      createdButtonIds.push(retBtn.buttonId);

      await prisma.rentalReturn.create({
        data: {
          returnCode: `RET_HIST_${ts}`,
          rentalId: oldRental.rentalId,
          buttonId: retBtn.buttonId,
          status: 'RECEIVED',
          receivedAt: new Date(),
        },
      });

      const sessHist = `sess_pg_hist_${ts}`;
      createdSessionIds.push(sessHist);
      await provRepo.createProvisioningSession(
        sessHist,
        `hash_${sessHist}`,
        retBtn.buttonId,
        { sessionId: sessHist },
        null,
        new Date(Date.now() + 600_000),
      );
      const rePaired = await provRepo.confirmPairingAtomicTx(sessHist, custB.customerId, {
        productId: prodActive.productId,
      });
      assert.strictEqual(rePaired.customerId, custB.customerId.toString(), 'Clean warehouse device with historical RECEIVED return must re-pair');

      // Finding #4: Concurrent /transfer takeover (custB -> custC) vs stale /unclaim (custB)
      await provRepo.initiateTransferAtomicTx(retBtn.buttonId, `xfr_unclaim_${ts}`, new Date(Date.now() + 600_000), custB.customerId);
      const sessTakeover = `sess_pg_takeover_${ts}`;
      createdSessionIds.push(sessTakeover);
      await provRepo.createProvisioningSession(
        sessTakeover,
        `hash_${sessTakeover}`,
        retBtn.buttonId,
        { sessionId: sessTakeover },
        null,
        new Date(Date.now() + 600_000),
      );

      const [unclaimRes, takeoverRes] = await Promise.allSettled([
        provRepo.unclaimDeviceAtomicTx(retBtn.buttonId, custB.customerId),
        provRepo.confirmPairingAtomicTx(sessTakeover, custC.customerId, { productId: prodActive.productId }),
      ]);
      const btnFinal = await prisma.ioTButton.findUnique({ where: { buttonId: retBtn.buttonId } });
      if (takeoverRes.status === 'fulfilled' && unclaimRes.status === 'rejected') {
        assert.ok(unclaimRes.reason instanceof ConflictException);
        assert.strictEqual(btnFinal?.customerId, custC.customerId, 'New owner custC must remain intact');
      } else if (unclaimRes.status === 'fulfilled' && takeoverRes.status === 'fulfilled') {
        assert.strictEqual(btnFinal?.customerId, custC.customerId);
      } else {
        assert.fail(`Unexpected concurrent outcome: unclaim=${unclaimRes.status}, takeover=${takeoverRes.status}`);
      }
    });

    await check('#1d [PostgreSQL] Concurrent Provisioning vs Warranty (approveSwap & lockDevice) executes cleanly with zero deadlocks under unified lock order', async () => {
      const provRepo = new ProvisioningRepository(prisma);
      const warrantyRepo = new WarrantyRepository(prisma);
      const pkg = await prisma.rentalPackage.create({
        data: {
          packageCode: `PKG_WRT_${ts}`,
          packageName: 'PG Warranty Race Pkg',
          buttonQuantity: 2,
          monthlyPrice: 50000,
          depositFee: 100000,
          isActive: true,
        },
      });
      createdPackageIds.push(pkg.packageId);

      const rental = await prisma.buttonRental.create({
        data: {
          rentalCode: `RNT_WRT_${ts}`,
          customerId: custA.customerId,
          packageId: pkg.packageId,
          fulfillmentStoreId: storeActive.storeId,
          buttonQuantity: 2,
          depositPerButton: 100000,
          rentPerButton: 50000,
          totalRentAmount: 100000,
          depositAmount: 200000,
          startDate: new Date(),
          endDate: new Date(Date.now() + 30 * 86400_000),
          effectiveExpiresAt: new Date(Date.now() + 30 * 86400_000),
          status: 'ACTIVE',
        },
      });
      createdRentalIds.push(rental.rentalId);

      await prisma.rentalDeposit.create({
        data: {
          rentalId: rental.rentalId,
          collectedAmount: 200000,
          heldAmount: 200000,
          refundReservedAmount: 0,
          refundedAmount: 0,
        },
      });

      const oldSwapDevId = `SOB-PG-WSWAP1-${ts}`;
      const newSwapDevId = `SOB-PG-WSWAP2-${ts}`;
      const lockDevId = `SOB-PG-WLOCK-${ts}`;
      createdDeviceIds.push(oldSwapDevId, newSwapDevId, lockDevId);

      const oldSwapBtn = await prisma.ioTButton.create({
        data: {
          deviceId: oldSwapDevId,
          buttonCode: `BTN_WS1_${ts}`,
          storeId: storeActive.storeId,
          custodyStoreId: storeActive.storeId,
          customerId: custA.customerId,
          rentalId: rental.rentalId,
          hmacSecret: 'sec_0123456789abcdef0123456789abcdef',
          status: 'ACTIVE',
          inventoryState: 'IN_CUSTOMER_CUSTODY',
          canOrder: true,
        },
      });
      const newSwapBtn = await prisma.ioTButton.create({
        data: {
          deviceId: newSwapDevId,
          buttonCode: `BTN_WS2_${ts}`,
          storeId: storeActive.storeId,
          customerId: null,
          rentalId: null,
          hmacSecret: 'sec_0123456789abcdef0123456789abcdef',
          status: 'INACTIVE',
          inventoryState: 'IN_PLATFORM_WAREHOUSE',
          canOrder: false,
        },
      });
      const lockTargetBtn = await prisma.ioTButton.create({
        data: {
          deviceId: lockDevId,
          buttonCode: `BTN_WLK_${ts}`,
          storeId: storeActive.storeId,
          custodyStoreId: storeActive.storeId,
          customerId: custA.customerId,
          rentalId: rental.rentalId,
          hmacSecret: 'sec_0123456789abcdef0123456789abcdef',
          status: 'ACTIVE',
          inventoryState: 'IN_CUSTOMER_CUSTODY',
          canOrder: true,
        },
      });
      createdButtonIds.push(oldSwapBtn.buttonId, newSwapBtn.buttonId, lockTargetBtn.buttonId);

      const swapTicket = await prisma.warrantyTicket.create({
        data: {
          ticketCode: `WT_SWP_${ts}`,
          buttonId: oldSwapBtn.buttonId,
          storeId: storeActive.storeId,
          customerId: custA.customerId,
          rentalId: rental.rentalId,
          reportedByUserId: custUserA.userId,
          faultGroup: 'GROUP_A',
          faultCode: 'DEAD_SWITCH',
          status: 'PENDING',
        },
      });
      const lockTicket = await prisma.warrantyTicket.create({
        data: {
          ticketCode: `WT_LCK_${ts}`,
          buttonId: lockTargetBtn.buttonId,
          storeId: storeActive.storeId,
          customerId: custA.customerId,
          rentalId: rental.rentalId,
          reportedByUserId: custUserA.userId,
          faultGroup: 'GROUP_C',
          faultCode: 'CRACKED_CASING',
          depositAmount: 100000,
          deductionPercent: 40,
          deductionAmount: 40000,
          refundAmount: 60000,
          status: 'PENDING',
        },
      });

      const sessSwapRace = `sess_pg_swp_${ts}`;
      const sessLockRace = `sess_pg_lck_${ts}`;
      createdSessionIds.push(sessSwapRace, sessLockRace);
      await provRepo.createProvisioningSession(
        sessSwapRace,
        `hash_${sessSwapRace}`,
        oldSwapBtn.buttonId,
        { sessionId: sessSwapRace },
        null,
        new Date(Date.now() + 600_000),
      );
      await provRepo.createProvisioningSession(
        sessLockRace,
        `hash_${sessLockRace}`,
        lockTargetBtn.buttonId,
        { sessionId: sessLockRace },
        null,
        new Date(Date.now() + 600_000),
      );

      const [swapRaceRes, pairSwapRaceRes, lockRaceRes, unclaimLockRaceRes] = await Promise.allSettled([
        warrantyRepo.approveSwapAtomicTx(swapTicket.ticketId, newSwapBtn.buttonId, ownerA.userId, 'Concurrent swap test'),
        provRepo.confirmPairingAtomicTx(sessSwapRace, custA.customerId, { productId: prodActive.productId }),
        warrantyRepo.lockDeviceAtomicTx(lockTicket.ticketId, ownerA.userId, 'Concurrent lock test'),
        provRepo.unclaimDeviceAtomicTx(lockTargetBtn.buttonId, custA.customerId),
      ]);

      assert.strictEqual(swapRaceRes.status, 'fulfilled', 'approveSwap must complete without deadlock');
      assert.strictEqual(pairSwapRaceRes.status, 'rejected', 'confirmPairing must be blocked by open/swapped warranty');
      assert.ok(pairSwapRaceRes.reason instanceof ConflictException);
      assert.strictEqual(lockRaceRes.status, 'fulfilled', 'lockDevice must complete without deadlock');
      assert.strictEqual(unclaimLockRaceRes.status, 'rejected', 'unclaim must be blocked by open/locked warranty & rental');
      assert.ok(unclaimLockRaceRes.reason instanceof ConflictException);
    });

    // -------------------------------------------------------------------------
    // TEST 3 (#8): PostgreSQL concurrent subscription settlement with distinct refs
    // -------------------------------------------------------------------------
    await check('#8 [PostgreSQL] Concurrent distinct PayOS references on STORE_SUBSCRIPTION create 1 subscription + 1 SETTLEMENT + 1 OVERPAYMENT_RECEIPT + 1 obligation', async () => {
      const billingRepo = new BillingChargesRepository(prisma);
      const plan = await prisma.subscriptionPlan.create({
        data: {
          planCode: `PG_PLN_${ts}`,
          planName: `PG Test Plan ${ts}`,
          price: 50000,
          durationDays: 30,
          maxProducts: 50,
          isActive: true,
        },
      });
      createdPlanIds.push(plan.planId);

      const charge = await billingRepo.createChargeWithLines({
        storeId: storeActive.storeId,
        payerStoreId: storeActive.storeId,
        planId: plan.planId,
        planSnapshot: { planId: plan.planId.toString(), durationDays: 30, price: 50000 },
        purpose: 'STORE_SUBSCRIPTION',
        targetType: 'STORE',
        targetId: storeActive.storeId,
        totalAmount: 50000,
        paymentMethod: 'PAYOS',
        paymentLinkId: `plink_pg_sub_${ts}`,
        lines: [
          {
            lineType: 'STORE_SUBSCRIPTION',
            amount: 50000,
            description: 'PG Test Sub',
            durationUnit: 'DAY',
            durationCount: 30,
            quantity: 1,
            unitPrice: 50000,
          },
        ],
      });
      createdChargeIds.push(charge.chargeId);

      const txRefA = `PG_SUB_A_${ts}`;
      const txRefB = `PG_SUB_B_${ts}`;
      const [s1, s2] = await Promise.all([
        billingRepo.settleChargeAtomicTx(charge.chargeId, {
          provider: 'PAYOS',
          providerTransactionCode: txRefA,
          amount: 50000,
          currency: 'VND',
          verified: true,
          paymentLinkId: `plink_pg_sub_${ts}`,
          paidAt: new Date(),
        }),
        billingRepo.settleChargeAtomicTx(charge.chargeId, {
          provider: 'PAYOS',
          providerTransactionCode: txRefB,
          amount: 50000,
          currency: 'VND',
          verified: true,
          paymentLinkId: `plink_pg_sub_${ts}`,
          paidAt: new Date(),
        }),
      ]);

      assert.strictEqual([s1, s2].filter((r: any) => !r.overpayment).length, 1);
      assert.strictEqual([s1, s2].filter((r: any) => r.overpayment === true).length, 1);

      const subs = await prisma.storeSubscription.findMany({
        where: { storeId: storeActive.storeId, planId: plan.planId },
      });
      assert.strictEqual(subs.length, 1, 'Must never extend or create duplicate StoreSubscription');

      const receipts = await prisma.billingPaymentReceipt.findMany({
        where: { chargeId: charge.chargeId },
        orderBy: { id: 'asc' },
      });
      assert.strictEqual(receipts.length, 2);
      assert.strictEqual(receipts.filter((r) => r.classification === 'SETTLEMENT_RECEIPT').length, 1);
      assert.strictEqual(receipts.filter((r) => r.classification === 'OVERPAYMENT_RECEIPT').length, 1);
      assert.ok(receipts.every((r) => r.channel === BILLING_PAYOS_CHANNEL));

      const overpayReceipt = receipts.find((r) => r.classification === 'OVERPAYMENT_RECEIPT')!;
      const obligations = await prisma.billingOverpaymentObligation.findMany({
        where: { receiptId: overpayReceipt.id },
      });
      assert.strictEqual(obligations.length, 1);
      assert.strictEqual(obligations[0].status, 'PENDING_RECONCILIATION');

      // Idempotent replay of TX_A returns alreadySettled: true without adding rows
      const replay: any = await billingRepo.settleChargeAtomicTx(charge.chargeId, {
        provider: 'PAYOS',
        providerTransactionCode: txRefA,
        amount: 50000,
        currency: 'VND',
        verified: true,
        paymentLinkId: `plink_pg_sub_${ts}`,
      });
      assert.strictEqual(replay.alreadySettled, true);
      const receiptsAfterReplay = await prisma.billingPaymentReceipt.count({ where: { chargeId: charge.chargeId } });
      assert.strictEqual(receiptsAfterReplay, 2);
    });

    // -------------------------------------------------------------------------
    // TEST 4 (#10): PostgreSQL worker excludes COD/CASH_ON_DELIVERY from 15m expiry
    // -------------------------------------------------------------------------
    await check('#10 [PostgreSQL] OrdersLifecycleWorker excludes COD & CASH_ON_DELIVERY older than 15m while cancelling stale unpaid PAYOS order', async () => {
      const oldDate = new Date(Date.now() - 25 * 60 * 1000);

      const codOrder = await prisma.order.create({
        data: {
          orderCode: `ORD_PG_COD_${ts}`,
          storeId: storeActive.storeId,
          customerId: custA.customerId,
          buttonId: null,
          orderStatus: 'PENDING',
          paymentStatus: 'UNPAID',
          paymentMethod: 'COD',
          subtotalAmount: 45000,
          totalAmount: 45000,
          shippingRecipientName: 'PG Cod',
          shippingPhone: `091${phonePrefix}`,
          shippingAddress: '10 Active Street',
          createdAt: oldDate,
        },
      });
      const cashOnDeliveryOrder = await prisma.order.create({
        data: {
          orderCode: `ORD_PG_COD2_${ts}`,
          storeId: storeActive.storeId,
          customerId: custA.customerId,
          buttonId: null,
          orderStatus: 'PENDING',
          paymentStatus: 'UNPAID',
          paymentMethod: 'CASH_ON_DELIVERY',
          subtotalAmount: 45000,
          totalAmount: 45000,
          shippingRecipientName: 'PG Cod2',
          shippingPhone: `091${phonePrefix}`,
          shippingAddress: '10 Active Street',
          createdAt: oldDate,
        },
      });
      const payosOrder = await prisma.order.create({
        data: {
          orderCode: `ORD_PG_PAYOS_${ts}`,
          storeId: storeActive.storeId,
          customerId: custA.customerId,
          buttonId: null,
          orderStatus: 'PENDING',
          paymentStatus: 'UNPAID',
          paymentMethod: 'PAYOS',
          subtotalAmount: 90000,
          totalAmount: 90000,
          shippingRecipientName: 'PG Payos',
          shippingPhone: `091${phonePrefix}`,
          shippingAddress: '10 Active Street',
          createdAt: oldDate,
          items: {
            create: [
              {
                productId: prodActive.productId,
                productNameSnapshot: prodActive.productName,
                unitPriceSnapshot: 45000,
                finalUnitPrice: 45000,
                quantity: 2,
                itemSubtotal: 90000,
              },
            ],
          },
        },
      });
      createdOrderIds.push(codOrder.orderId, cashOnDeliveryOrder.orderId, payosOrder.orderId);

      // Force created_at to 25 minutes ago in SQL in case Prisma default/trigger touched it
      await prisma.$executeRawUnsafe(
        `UPDATE orders SET created_at = NOW() - INTERVAL '25 minutes' WHERE order_id IN ($1, $2, $3)`,
        codOrder.orderId,
        cashOnDeliveryOrder.orderId,
        payosOrder.orderId,
      );

      const worker = new OrdersLifecycleWorker(prisma, new OrdersRepository(prisma), {} as any);
      for (let i = 0; i < 3; i++) {
        await worker.processPendingOrdersLifecycle();
        const cur = await prisma.order.findUnique({ where: { orderId: payosOrder.orderId } });
        if (cur?.orderStatus === 'CANCELLED') break;
      }

      const [codAfter, cod2After, payosAfter] = await Promise.all([
        prisma.order.findUnique({ where: { orderId: codOrder.orderId } }),
        prisma.order.findUnique({ where: { orderId: cashOnDeliveryOrder.orderId } }),
        prisma.order.findUnique({ where: { orderId: payosOrder.orderId } }),
      ]);

      assert.strictEqual(codAfter?.orderStatus, 'PENDING', 'COD order must NEVER be auto-cancelled at 15m');
      assert.strictEqual(cod2After?.orderStatus, 'PENDING', 'CASH_ON_DELIVERY order must NEVER be auto-cancelled at 15m');
      assert.strictEqual(payosAfter?.orderStatus, 'CANCELLED', 'Stale unpaid PAYOS order must be auto-cancelled');

      // Finding #5: Concurrent changePaymentMethodTx (-> COD) vs cancelOrderAtomicTx (timeout)
      const raceOrder = await prisma.order.create({
        data: {
          orderCode: `ORD_PG_RACE_COD_${ts}`,
          storeId: storeActive.storeId,
          customerId: custA.customerId,
          buttonId: null,
          orderStatus: 'PENDING',
          paymentStatus: 'UNPAID',
          paymentMethod: 'PAYOS',
          subtotalAmount: 45000,
          totalAmount: 45000,
          shippingRecipientName: 'PG Race COD',
          shippingPhone: `091${phonePrefix}`,
          shippingAddress: '10 Active Street',
        },
      });
      createdOrderIds.push(raceOrder.orderId);

      const paymentsRepo = new PaymentsRepository(prisma);
      const ordersRepo = new OrdersRepository(prisma);

      const [switchRes, timeoutCancelRes] = await Promise.allSettled([
        paymentsRepo.changePaymentMethodTx(raceOrder.orderId, 'COD', {
          userId: custUserA.userId,
          role: 'CUSTOMER',
        }),
        ordersRepo.cancelOrderAtomicTx(
          raceOrder.orderId,
          'Hết hạn thời gian thanh toán đơn hàng (15 phút)',
          null,
          'CANCELLED',
          { mode: 'PAYMENT_TIMEOUT', excludePaymentMethods: ['COD', 'CASH_ON_DELIVERY'] },
        ),
      ]);

      assert.strictEqual(timeoutCancelRes.status, 'fulfilled', 'Timeout cancel should resolve idempotently or skip safely');
      const raceOrderAfter = await prisma.order.findUnique({ where: { orderId: raceOrder.orderId } });
      if (raceOrderAfter?.paymentMethod === 'COD') {
        assert.strictEqual(raceOrderAfter.orderStatus, 'PENDING', 'Order switched to COD must remain PENDING (never cancelled)');
        assert.strictEqual(switchRes.status, 'fulfilled');
      } else {
        assert.strictEqual(raceOrderAfter?.orderStatus, 'CANCELLED');
        assert.strictEqual(switchRes.status, 'rejected');
        assert.ok(switchRes.reason instanceof BadRequestException);
      }

      // Manual cancel of COD order with reason containing "timeout"/"EXPIRED"/"Hết hạn" must STILL cancel cleanly
      const manualCodOrder = await prisma.order.create({
        data: {
          orderCode: `ORD_PG_MAN_COD_${ts}`,
          storeId: storeActive.storeId,
          customerId: custA.customerId,
          buttonId: null,
          orderStatus: 'PENDING',
          paymentStatus: 'UNPAID',
          paymentMethod: 'COD',
          subtotalAmount: 45000,
          totalAmount: 45000,
          shippingRecipientName: 'PG Manual COD',
          shippingPhone: `091${phonePrefix}`,
          shippingAddress: '10 Active Street',
        },
      });
      createdOrderIds.push(manualCodOrder.orderId);

      const manualRes: any = await ordersRepo.cancelOrderAtomicTx(
        manualCodOrder.orderId,
        'App timeout, please cancel - Hết hạn EXPIRED',
        custUserA.userId,
        'CANCELLED',
        { mode: 'MANUAL' },
      );
      assert.ok(!manualRes?.skipped, 'Manual cancel on COD must not be skipped even with timeout/EXPIRED keywords');
      const manualCodAfter = await prisma.order.findUnique({ where: { orderId: manualCodOrder.orderId } });
      assert.strictEqual(manualCodAfter?.orderStatus, 'CANCELLED');
    });
  } finally {
    const cleanupErrors: string[] = [];
    const runCleanup = async (label: string, op: () => Promise<any>) => {
      try {
        await op();
      } catch (err: any) {
        cleanupErrors.push(`${label}: ${err?.message || err}`);
        console.error(`  ✖ [CLEANUP ERROR] ${label}:`, err?.message || err);
      }
    };

    try {
      if (createdSessionIds.length > 0) {
        await runCleanup('provisioningSession.deleteMany', () =>
          prisma.provisioningSession.deleteMany({ where: { sessionId: { in: createdSessionIds } } }),
        );
      }
      if (createdDeviceIds.length > 0) {
        await runCleanup('pairingToken.deleteMany', () =>
          prisma.pairingToken.deleteMany({ where: { deviceId: { in: createdDeviceIds.map((d) => d.toUpperCase()) } } }),
        );
      }
      if (createdRentalIds.length > 0) {
        await runCleanup('depositRefund.deleteMany', () =>
          prisma.depositRefund.deleteMany({ where: { rentalId: { in: createdRentalIds } } }),
        );
      }
      if (createdButtonIds.length > 0) {
        await runCleanup('buttonProduct.deleteMany', () =>
          prisma.buttonProduct.deleteMany({ where: { buttonId: { in: createdButtonIds } } }),
        );
        await runCleanup('warrantyTicket.deleteMany', () =>
          prisma.warrantyTicket.deleteMany({
            where: {
              OR: [
                { buttonId: { in: createdButtonIds } },
                { replacementButtonId: { in: createdButtonIds } },
              ],
            },
          }),
        );
        await runCleanup('deviceMovement.deleteMany', () =>
          prisma.deviceMovement.deleteMany({ where: { buttonId: { in: createdButtonIds } } }),
        );
        await runCleanup('rentalReturn.deleteMany', () =>
          prisma.rentalReturn.deleteMany({ where: { buttonId: { in: createdButtonIds } } }),
        );
      }
      if (createdOrderIds.length > 0) {
        await runCleanup('orderStatusHistory.deleteMany', () =>
          prisma.orderStatusHistory.deleteMany({ where: { orderId: { in: createdOrderIds } } }),
        );
        await runCleanup('orderItem.deleteMany', () =>
          prisma.orderItem.deleteMany({ where: { orderId: { in: createdOrderIds } } }),
        );
        await runCleanup('order.deleteMany', () =>
          prisma.order.deleteMany({ where: { orderId: { in: createdOrderIds } } }),
        );
      }
      if (createdChargeIds.length > 0) {
        const receipts = await prisma.billingPaymentReceipt.findMany({
          where: { chargeId: { in: createdChargeIds } },
          select: { id: true },
        });
        const receiptIds = receipts.map((r) => r.id);
        if (receiptIds.length > 0) {
          await runCleanup('billingOverpaymentObligation.deleteMany', () =>
            prisma.billingOverpaymentObligation.deleteMany({ where: { receiptId: { in: receiptIds } } }),
          );
        }
        await runCleanup('billingPaymentReceipt.deleteMany', () =>
          prisma.billingPaymentReceipt.deleteMany({ where: { chargeId: { in: createdChargeIds } } }),
        );
        await runCleanup('billingChargeLine.deleteMany', () =>
          prisma.billingChargeLine.deleteMany({ where: { chargeId: { in: createdChargeIds } } }),
        );
        await runCleanup('billingCharge.deleteMany', () =>
          prisma.billingCharge.deleteMany({ where: { chargeId: { in: createdChargeIds } } }),
        );
        await runCleanup('outboxEvent.deleteMany', () =>
          prisma.outboxEvent.deleteMany({
            where: {
              OR: createdChargeIds.map((id) => ({ payload: { path: ['chargeId'], equals: id.toString() } })),
            },
          }),
        );
      }
      if (createdStoreIds.length > 0) {
        await runCleanup('storeCustomer.deleteMany', () =>
          prisma.storeCustomer.deleteMany({ where: { storeId: { in: createdStoreIds } } }),
        );
        await runCleanup('storeSubscription.deleteMany', () =>
          prisma.storeSubscription.deleteMany({ where: { storeId: { in: createdStoreIds } } }),
        );
        await runCleanup('rentalAuditLog.deleteMany', () =>
          prisma.rentalAuditLog.deleteMany({
            where: { targetType: 'STORE', targetId: { in: createdStoreIds } },
          }),
        );
      }
      if (createdButtonIds.length > 0) {
        await runCleanup('ioTButton.deleteMany', () =>
          prisma.ioTButton.deleteMany({ where: { buttonId: { in: createdButtonIds } } }),
        );
      }
      if (createdRentalIds.length > 0) {
        await runCleanup('rentalDeposit.deleteMany', () =>
          prisma.rentalDeposit.deleteMany({ where: { rentalId: { in: createdRentalIds } } }),
        );
        await runCleanup('buttonRental.deleteMany', () =>
          prisma.buttonRental.deleteMany({ where: { rentalId: { in: createdRentalIds } } }),
        );
      }
      if (createdPackageIds.length > 0) {
        await runCleanup('rentalPackage.deleteMany', () =>
          prisma.rentalPackage.deleteMany({ where: { packageId: { in: createdPackageIds } } }),
        );
      }
      if (createdPlanIds.length > 0) {
        await runCleanup('subscriptionPlan.deleteMany', () =>
          prisma.subscriptionPlan.deleteMany({ where: { planId: { in: createdPlanIds } } }),
        );
      }
      if (createdProductIds.length > 0) {
        await runCleanup('inventory.deleteMany', () =>
          prisma.inventory.deleteMany({ where: { productId: { in: createdProductIds } } }),
        );
        await runCleanup('product.deleteMany', () =>
          prisma.product.deleteMany({ where: { productId: { in: createdProductIds } } }),
        );
      }
      if (createdStoreIds.length > 0) {
        await runCleanup('store.deleteMany', () =>
          prisma.store.deleteMany({ where: { storeId: { in: createdStoreIds } } }),
        );
      }
      if (createdCustomerIds.length > 0) {
        await runCleanup('customerProfile.deleteMany', () =>
          prisma.customerProfile.deleteMany({ where: { customerId: { in: createdCustomerIds } } }),
        );
      }
      if (createdUserIds.length > 0) {
        await runCleanup('user.deleteMany', () =>
          prisma.user.deleteMany({ where: { userId: { in: createdUserIds } } }),
        );
      }

      const leftovers: Record<string, number> = {
        sessions: createdSessionIds.length ? await prisma.provisioningSession.count({ where: { sessionId: { in: createdSessionIds } } }) : 0,
        orders: createdOrderIds.length ? await prisma.order.count({ where: { orderId: { in: createdOrderIds } } }) : 0,
        charges: createdChargeIds.length ? await prisma.billingCharge.count({ where: { chargeId: { in: createdChargeIds } } }) : 0,
        buttons: createdButtonIds.length ? await prisma.ioTButton.count({ where: { buttonId: { in: createdButtonIds } } }) : 0,
        rentals: createdRentalIds.length ? await prisma.buttonRental.count({ where: { rentalId: { in: createdRentalIds } } }) : 0,
        products: createdProductIds.length ? await prisma.product.count({ where: { productId: { in: createdProductIds } } }) : 0,
        stores: createdStoreIds.length ? await prisma.store.count({ where: { storeId: { in: createdStoreIds } } }) : 0,
        customers: createdCustomerIds.length ? await prisma.customerProfile.count({ where: { customerId: { in: createdCustomerIds } } }) : 0,
        users: createdUserIds.length ? await prisma.user.count({ where: { userId: { in: createdUserIds } } }) : 0,
      };
      const remaining = Object.entries(leftovers).filter(([, c]) => c > 0);
      if (cleanupErrors.length > 0 || remaining.length > 0) {
        throw new Error(
          `Cleanup verification failed (errors=${JSON.stringify(cleanupErrors)}, remaining=${JSON.stringify(Object.fromEntries(remaining))})`,
        );
      }
      console.log('  ✔ [CLEANUP] Verified zero leftover test fixtures across all tables');
    } finally {
      await prisma.$disconnect();
    }
  }

  console.log(`\n🎉 ALL ${passed}/${passed} REAL POSTGRESQL BATCH 2 & 3 CHECKS PASSED!\n`);
}

runPostgresTests().catch((err) => {
  console.error('❌ Batch 2 & 3 PostgreSQL test failed:', err);
  process.exit(1);
});
