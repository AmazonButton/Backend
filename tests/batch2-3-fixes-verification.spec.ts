import 'reflect-metadata';
import assert from 'node:assert/strict';
import * as crypto from 'crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotImplementedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from '../src/common/guards/roles.guard';
import { ProductsController } from '../src/products/products.controller';
import { ProductsService } from '../src/products/products.service';
import { ProductsRepository } from '../src/products/products.repository';
import { ProvisioningRepository } from '../src/devices/provisioning.repository';
import { ProvisioningService } from '../src/devices/provisioning.service';
import { BillingChargesRepository } from '../src/billing-charges/billing-charges.repository';
import { BillingChargesService } from '../src/billing-charges/billing-charges.service';
import { PaymentsService } from '../src/payments/payments.service';
import { OrdersLifecycleWorker } from '../src/orders/orders-lifecycle.worker';
import { OrdersRepository } from '../src/orders/orders.repository';
import { OrdersService } from '../src/orders/orders.service';

async function runTests() {
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
  console.log('🧪 BATCH 2 & 3 BACKEND REMEDIATION VERIFICATION (#7, #14, #1, #8, #10)');
  console.log('========================================================================\n');

  // ---------------------------------------------------------------------------
  // #7: GET /products role permissions, BOLA protection, & public projection
  // ---------------------------------------------------------------------------
  await check('#7a ProductsController GET /products blocks SYSTEM_STAFF via RolesGuard and allows CUSTOMER / STORE_OWNER / ADMIN', async () => {
    const reflector = new Reflector();
    const guard = new RolesGuard(reflector);
    const makeCtx = (role: string) =>
      ({
        getHandler: () => ProductsController.prototype.list,
        getClass: () => ProductsController,
        switchToHttp: () => ({
          getRequest: () => ({ user: { role } }),
        }),
      }) as any;

    assert.throws(
      () => guard.canActivate(makeCtx('SYSTEM_STAFF')),
      (err: any) => err instanceof ForbiddenException,
      'SYSTEM_STAFF must be rejected with 403 Forbidden',
    );
    assert.strictEqual(guard.canActivate(makeCtx('CUSTOMER')), true);
    assert.strictEqual(guard.canActivate(makeCtx('STORE_OWNER')), true);
    assert.strictEqual(guard.canActivate(makeCtx('STAFF_INVENTORY')), true);
    assert.strictEqual(guard.canActivate(makeCtx('ADMIN')), true);
  });

  await check('#7b GET /products CUSTOMER gets ACTIVE-only public projection (availableStock = onHand - reserved, internal fields stripped)', async () => {
    let capturedWhere: any = null;
    let capturedInclude: any = null;
    const mockPrisma: any = {
      product: {
        findMany: async (args: any) => {
          capturedWhere = args.where;
          capturedInclude = args.include;
          return [
            {
              productId: BigInt(101),
              storeId: BigInt(10),
              categoryId: BigInt(3),
              productName: 'Binh Nuoc 19L',
              productCode: 'SP-101',
              brand: 'Lavie',
              description: 'Chinh hang',
              basePrice: 55000,
              status: 'ACTIVE',
              secretCostPrice: 12000,
              inventory: {
                inventoryId: BigInt(8),
                quantityOnHand: 10,
                reservedQuantity: 3,
                minStockAlert: 5,
              },
              category: { categoryId: BigInt(3), categoryName: 'Nuoc uong' },
              images: [
                {
                  imageId: BigInt(77),
                  productId: BigInt(101),
                  imageUrl: 'https://cdn.example.com/101.png',
                  isThumbnail: true,
                  displayOrder: 0,
                },
              ],
              store: { storeId: BigInt(10), name: 'Store Active', code: 'ST10' },
            },
          ];
        },
        count: async () => 1,
      },
    };

    const repo = new ProductsRepository(mockPrisma);
    const service = new ProductsService(repo, {} as any, {} as any);
    const controller = new ProductsController(service);

    const res: any = await controller.list(
      { user: { role: 'CUSTOMER', userId: '55' } },
      { page: 1, pageSize: 20 } as any,
    );

    assert.strictEqual(capturedWhere.status, 'ACTIVE');
    assert.deepEqual(capturedWhere.store, { status: 'ACTIVE' });
    assert.ok(capturedInclude.store, 'Public query should selectively include store summary');
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.data.length, 1);

    const item = res.data[0];
    assert.strictEqual(item.id, '101');
    assert.strictEqual(item.productId, '101');
    assert.strictEqual(item.storeId, '10');
    assert.strictEqual(item.availableStock, 7);
    assert.strictEqual(item.stock, 7);
    assert.strictEqual(item.store?.name, 'Store Active');
    assert.strictEqual('reservedQuantity' in item, false, 'Must not leak reservedQuantity');
    assert.strictEqual('reservedStock' in item, false, 'Must not leak reservedStock');
    assert.strictEqual('minStockAlert' in item, false, 'Must not leak minStockAlert');
    assert.strictEqual('inventory' in item, false, 'Must not leak raw inventory entity');
    assert.strictEqual('secretCostPrice' in item, false, 'Must not spread raw product fields');

    await assert.rejects(
      () => controller.list({ user: { role: 'CUSTOMER' } }, { storeId: '9223372036854775808' } as any),
      (err: any) => err instanceof BadRequestException,
    );
  });

  await check('#7c GET /products STORE_OWNER is strictly bound to req.user.storeId and rejects cross-store or missing storeId', async () => {
    let queriedStoreId: bigint | undefined;
    let onlyActiveWhere: any;
    const mockRepo: any = {
      findMany: async (storeId: bigint | undefined, opts: any) => {
        queriedStoreId = storeId;
        onlyActiveWhere = opts?.onlyActivePublic;
        return { items: [], total: 0, page: 1, pageSize: 20 };
      },
    };
    const service = new ProductsService(mockRepo, {} as any, {} as any);
    const controller = new ProductsController(service);

    await controller.list(
      { user: { role: 'STORE_OWNER', storeId: '42', userId: '7' } },
      { page: 1, pageSize: 20 } as any,
    );
    assert.strictEqual(queriedStoreId, BigInt(42));
    assert.strictEqual(onlyActiveWhere, false);

    await assert.rejects(
      () =>
        controller.list(
          { user: { role: 'STORE_OWNER', storeId: '42', userId: '7' } },
          { storeId: '99', page: 1, pageSize: 20 } as any,
        ),
      (err: any) => err instanceof ForbiddenException,
      'STORE_OWNER querying another storeId must get 403',
    );

    await assert.rejects(
      () =>
        controller.list(
          { user: { role: 'STORE_OWNER', userId: '7' } },
          { storeId: '99', page: 1, pageSize: 20 } as any,
        ),
      (err: any) => err instanceof ForbiddenException,
      'STORE_OWNER without backend storeId must fail closed with 403',
    );

    await assert.rejects(
      () => service.list(undefined, { page: 1, pageSize: 10 }, { role: 'SYSTEM_STAFF' }),
      (err: any) => err instanceof ForbiddenException,
    );

    await assert.rejects(
      () => service.list(undefined, { page: 1, pageSize: 10 }),
      (err: any) => err instanceof ForbiddenException,
    );
  });

  // ---------------------------------------------------------------------------
  // #14: Cloud change-wifi endpoint retired with 501 Not Implemented (BLE/USB)
  // ---------------------------------------------------------------------------
  await check('#14 ProvisioningService.changeWifi returns 501 WIFI_CLOUD_PROVISIONING_UNSUPPORTED directing to BLE/USB', async () => {
    let touchedRepo = false;
    const service = new ProvisioningService(
      {
        findButtonByIdentifier: async () => {
          touchedRepo = true;
          return null;
        },
      } as any,
      {} as any,
      { emitToStore: () => {} } as any,
    );

    let thrown: any = null;
    try {
      await service.changeWifi('SOB-TEST-WIFI', { role: 'CUSTOMER', customerProfileId: '1' }, { ssid: 'Home' });
    } catch (err) {
      thrown = err;
    }

    assert.ok(thrown instanceof NotImplementedException, 'Must throw NotImplementedException (501)');
    assert.strictEqual(thrown.getStatus(), 501);
    const body = thrown.getResponse() as any;
    assert.strictEqual(body.errorCode, 'WIFI_CLOUD_PROVISIONING_UNSUPPORTED');
    assert.deepEqual(body.data?.supportedChannels, ['BLE', 'USB']);
    assert.strictEqual(touchedRepo, false, 'Decommissioned endpoint must not mutate or query device state');
  });

  // ---------------------------------------------------------------------------
  // #1: Provisioning ownership overwrite, rental/deposit, return & warranty lock
  // ---------------------------------------------------------------------------
  function buildProvisioningTxMock(state: {
    device: any;
    rental?: any;
    deposit?: any;
    pendingRefunds?: number;
    openReturns?: any[];
    openWarranties?: any[];
  }) {
    let updatedDeviceCustomer: any = state.device.customer_id;
    let updatedDeviceStatus: string = state.device.status;
    let tokenCreated = false;
    let unclaimed = false;

    const repo = new ProvisioningRepository({
      $transaction: async (cb: any) =>
        cb({
          $queryRawUnsafe: async (sql: string) => {
            if (sql.includes('FROM provisioning_sessions')) {
              return [
                {
                  session_id: 'sess_mock_1',
                  status: 'ACTIVE',
                  expires_at: new Date(Date.now() + 600_000),
                  claimed_by: null,
                  device_id: state.device.button_id,
                },
              ];
            }
            if (sql.includes('FROM iot_button')) {
              return [state.device];
            }
            if (sql.includes('FROM rental_returns')) {
              return state.openReturns || [];
            }
            if (sql.includes('FROM warranty_tickets')) {
              return state.openWarranties || [];
            }
            if (sql.includes('FROM button_rentals')) {
              return state.rental ? [state.rental] : [];
            }
            if (sql.includes('FROM rental_deposits')) {
              return state.deposit ? [state.deposit] : [];
            }
            if (sql.includes('FROM deposit_refunds')) {
              return [{ cnt: state.pendingRefunds || 0 }];
            }
            if (sql.includes('FROM product')) {
              return [{ product_id: BigInt(5), store_id: BigInt(10), status: 'ACTIVE' }];
            }
            if (sql.includes('FROM customer_address')) {
              return [{ address_id: BigInt(7) }];
            }
            return [];
          },
          $executeRawUnsafe: async (sql: string, ...args: any[]) => {
            if (sql.includes('UPDATE iot_button') && sql.includes('customer_id = $1')) {
              updatedDeviceCustomer = args[0];
              updatedDeviceStatus = 'ACTIVE';
            } else if (sql.includes("SET status = 'TRANSFER_PENDING'")) {
              updatedDeviceStatus = 'TRANSFER_PENDING';
            } else if (sql.includes('INSERT INTO public.pairing_tokens')) {
              tokenCreated = true;
            }
            return 1;
          },
          ioTButton: {
            update: async ({ data }: any) => {
              updatedDeviceCustomer = data.customerId;
              updatedDeviceStatus = data.status;
              unclaimed = true;
            },
          },
          buttonProduct: {
            deleteMany: async () => ({ count: 0 }),
          },
        }),
    } as any);

    return {
      repo,
      getState: () => ({ updatedDeviceCustomer, updatedDeviceStatus, tokenCreated, unclaimed }),
    };
  }

  await check('#1a confirmPairingAtomicTx blocks LOCKED, DISABLED, RETURN_IN_TRANSIT, DEFECTIVE_RETURN, open RentalReturn & open WarrantyTicket', async () => {
    const scenarios = [
      {
        label: 'LOCKED status',
        state: { device: { button_id: BigInt(1), device_id: 'DEV-1', store_id: BigInt(10), status: 'LOCKED', inventory_state: 'IN_CUSTOMER_CUSTODY', customer_id: null, rental_id: null } },
      },
      {
        label: 'DISABLED status',
        state: { device: { button_id: BigInt(1), device_id: 'DEV-1', store_id: BigInt(10), status: 'DISABLED', inventory_state: 'IN_PLATFORM_WAREHOUSE', customer_id: null, rental_id: null } },
      },
      {
        label: 'RETURN_IN_TRANSIT inventoryState',
        state: { device: { button_id: BigInt(1), device_id: 'DEV-1', store_id: BigInt(10), status: 'ACTIVE', inventory_state: 'RETURN_IN_TRANSIT', customer_id: BigInt(100), rental_id: BigInt(50) } },
      },
      {
        label: 'DEFECTIVE_RETURN inventoryState',
        state: { device: { button_id: BigInt(1), device_id: 'DEV-1', store_id: BigInt(10), status: 'INACTIVE', inventory_state: 'DEFECTIVE_RETURN', customer_id: null, rental_id: null } },
      },
      {
        label: 'Open RentalReturn PENDING_RECEIPT',
        state: {
          device: { button_id: BigInt(1), device_id: 'DEV-1', store_id: BigInt(10), status: 'ACTIVE', inventory_state: 'IN_CUSTOMER_CUSTODY', customer_id: BigInt(100), rental_id: null },
          openReturns: [{ return_id: BigInt(9), status: 'PENDING_RECEIPT' }],
        },
      },
      {
        label: 'Open WarrantyTicket PENDING',
        state: {
          device: { button_id: BigInt(1), device_id: 'DEV-1', store_id: BigInt(10), status: 'ACTIVE', inventory_state: 'IN_CUSTOMER_CUSTODY', customer_id: BigInt(100), rental_id: null },
          openWarranties: [{ ticket_id: BigInt(4), ticket_code: 'WT-4', status: 'PENDING' }],
        },
      },
    ];

    for (const sc of scenarios) {
      const { repo } = buildProvisioningTxMock(sc.state);
      await assert.rejects(
        () => repo.confirmPairingAtomicTx('sess_mock_1', BigInt(100), { productId: '5' }),
        (err: any) => err instanceof ConflictException,
        `${sc.label} must throw ConflictException`,
      );
    }
  });

  await check('#1b Blocks ownership overwrite and /transfer or /unclaim when rental/deposit obligation exists, distinguishes first-time & authorized transfer', async () => {
    // 1. Existing Customer A device (not TRANSFER_PENDING) cannot be overwritten by Customer B
    {
      const { repo } = buildProvisioningTxMock({
        device: {
          button_id: BigInt(1),
          device_id: 'DEV-1',
          store_id: BigInt(10),
          status: 'ACTIVE',
          inventory_state: 'IN_CUSTOMER_CUSTODY',
          customer_id: BigInt(100),
          rental_id: null,
        },
      });
      await assert.rejects(
        () => repo.confirmPairingAtomicTx('sess_mock_1', BigInt(200), { productId: '5' }),
        (err: any) => err instanceof ConflictException,
      );
    }

    // 2. Even with status = TRANSFER_PENDING, active rental / held deposit blocks Customer B takeover
    {
      const { repo } = buildProvisioningTxMock({
        device: {
          button_id: BigInt(1),
          device_id: 'DEV-1',
          store_id: BigInt(10),
          status: 'TRANSFER_PENDING',
          inventory_state: 'IN_CUSTOMER_CUSTODY',
          customer_id: BigInt(100),
          rental_id: BigInt(77),
        },
        rental: {
          rental_id: BigInt(77),
          customer_id: BigInt(100),
          status: 'ACTIVE',
          end_date: new Date(Date.now() + 86400_000),
        },
        deposit: { held_amount: 100000, refund_reserved_amount: 0 },
      });
      await assert.rejects(
        () => repo.confirmPairingAtomicTx('sess_mock_1', BigInt(200), { productId: '5' }),
        (err: any) => err instanceof ConflictException,
      );
      await assert.rejects(
        () => repo.initiateTransferAtomicTx(BigInt(1), 'hash', new Date(Date.now() + 60_000), BigInt(100)),
        (err: any) => err instanceof ConflictException,
      );
      await assert.rejects(
        () => repo.unclaimDeviceAtomicTx(BigInt(1)),
        (err: any) => err instanceof ConflictException,
      );
    }

    // 3. Terminated rental BUT unsettled deposit (held_amount > 0) still blocks /transfer & /unclaim & confirm takeover
    {
      const { repo } = buildProvisioningTxMock({
        device: {
          button_id: BigInt(1),
          device_id: 'DEV-1',
          store_id: BigInt(10),
          status: 'TRANSFER_PENDING',
          inventory_state: 'IN_CUSTOMER_CUSTODY',
          customer_id: BigInt(100),
          rental_id: BigInt(78),
        },
        rental: { rental_id: BigInt(78), customer_id: BigInt(100), status: 'TERMINATED' },
        deposit: { held_amount: 50000, refund_reserved_amount: 0 },
      });
      await assert.rejects(
        () => repo.confirmPairingAtomicTx('sess_mock_1', BigInt(200), { productId: '5' }),
        (err: any) => err instanceof ConflictException,
      );
      await assert.rejects(
        () => repo.unclaimDeviceAtomicTx(BigInt(1)),
        (err: any) => err instanceof ConflictException,
      );
    }

    // 4. Same customer re-pairing with EXPIRED rental is blocked (ACT06 requires ACTIVE)
    {
      const { repo } = buildProvisioningTxMock({
        device: {
          button_id: BigInt(1),
          device_id: 'DEV-1',
          store_id: BigInt(10),
          status: 'ACTIVE',
          inventory_state: 'IN_CUSTOMER_CUSTODY',
          customer_id: BigInt(100),
          rental_id: BigInt(79),
        },
        rental: {
          rental_id: BigInt(79),
          customer_id: BigInt(100),
          status: 'EXPIRED',
          end_date: new Date(Date.now() - 86400_000),
        },
      });
      await assert.rejects(
        () => repo.confirmPairingAtomicTx('sess_mock_1', BigInt(100), { productId: '5' }),
        (err: any) => err instanceof ConflictException,
      );
    }

    // 5. Same customer re-pairing own ACTIVE rental succeeds
    {
      const { repo, getState } = buildProvisioningTxMock({
        device: {
          button_id: BigInt(1),
          device_id: 'DEV-1',
          store_id: BigInt(10),
          status: 'ACTIVE',
          inventory_state: 'IN_CUSTOMER_CUSTODY',
          customer_id: BigInt(100),
          rental_id: BigInt(80),
        },
        rental: {
          rental_id: BigInt(80),
          customer_id: BigInt(100),
          status: 'ACTIVE',
          effective_expires_at: new Date(Date.now() + 86400_000),
        },
        deposit: { held_amount: 100000, refund_reserved_amount: 0 },
      });
      const res = await repo.confirmPairingAtomicTx('sess_mock_1', BigInt(100), { productId: '5' });
      assert.strictEqual(res.customerId, '100');
      assert.strictEqual(getState().updatedDeviceStatus, 'ACTIVE');
    }

    // 6. Clean unencumbered device supports transfer -> TRANSFER_PENDING -> Customer B confirmPairing + unclaim
    {
      const { repo, getState } = buildProvisioningTxMock({
        device: {
          button_id: BigInt(1),
          device_id: 'DEV-1',
          store_id: BigInt(10),
          status: 'ACTIVE',
          inventory_state: 'IN_CUSTOMER_CUSTODY',
          customer_id: BigInt(100),
          rental_id: null,
        },
      });
      const txRes = await repo.initiateTransferAtomicTx(BigInt(1), 'tok_hash', new Date(Date.now() + 60_000), BigInt(100));
      assert.strictEqual(txRes.status, 'TRANSFER_PENDING');
      assert.strictEqual(getState().tokenCreated, true);
    }
    {
      const { repo, getState } = buildProvisioningTxMock({
        device: {
          button_id: BigInt(1),
          device_id: 'DEV-1',
          store_id: BigInt(10),
          status: 'TRANSFER_PENDING',
          inventory_state: 'IN_CUSTOMER_CUSTODY',
          customer_id: BigInt(100),
          rental_id: null,
        },
      });
      const confRes = await repo.confirmPairingAtomicTx('sess_mock_1', BigInt(200), { productId: '5' });
      assert.strictEqual(confRes.customerId, '200');
      assert.strictEqual(getState().updatedDeviceCustomer, BigInt(200));
    }
  });

  await check('#1c Fixes #2,#3,#4: Historical RECEIVED return allows warehouse re-pair, factoryReset enforces rental/deposit/lock guards, and /unclaim re-verifies owner under lock', async () => {
    // Finding #2: Clean warehouse button (customer_id=null, rental_id=null, ALLOCATED_TO_STORE) with historical RECEIVED return
    let executedReturnQueries: string[] = [];
    const historicalOnlyPrisma: any = {
      $transaction: async (cb: any) =>
        cb({
          $queryRawUnsafe: async (sql: string) => {
            if (sql.includes('FROM provisioning_sessions')) {
              return [{ session_id: 'sess_mock_hist', status: 'ACTIVE', expires_at: new Date(Date.now() + 600_000), claimed_by: null, device_id: BigInt(1) }];
            }
            if (sql.includes('FROM iot_button')) {
              return [{ button_id: BigInt(1), device_id: 'DEV-HIST', store_id: BigInt(10), status: 'INACTIVE', inventory_state: 'ALLOCATED_TO_STORE', customer_id: null, rental_id: null }];
            }
            if (sql.includes('FROM rental_returns')) {
              executedReturnQueries.push(sql);
              // Simulate DB returning [] for PENDING_RECEIPT query, while historical RECEIVED rows exist for other rentals
              if (sql.includes("status = 'PENDING_RECEIPT'")) return [];
              if (sql.includes("status = 'RECEIVED'") && sql.includes('rental_id =')) return [];
              return [{ return_id: BigInt(999), status: 'RECEIVED' }];
            }
            if (sql.includes('FROM warranty_tickets')) return [];
            if (sql.includes('FROM product')) return [{ product_id: BigInt(5), store_id: BigInt(10), status: 'ACTIVE' }];
            if (sql.includes('FROM customer_address')) return [{ address_id: BigInt(7) }];
            return [];
          },
          $executeRawUnsafe: async () => 1,
        }),
    };
    const histRepo = new ProvisioningRepository(historicalOnlyPrisma);
    const rePaired = await histRepo.confirmPairingAtomicTx('sess_mock_hist', BigInt(300), { productId: '5' });
    assert.strictEqual(rePaired.customerId, '300', 'Returned device with historical RECEIVED record must allow clean re-pair');
    assert.ok(executedReturnQueries.every((q) => !q.includes("status IN ('PENDING_RECEIPT', 'RECEIVED')")));

    // Finding #2 (negative): Device STILL bound to rental_id with RECEIVED return OR PENDING_RECEIPT is blocked
    {
      const { repo } = buildProvisioningTxMock({
        device: { button_id: BigInt(1), device_id: 'DEV-1', store_id: BigInt(10), status: 'ACTIVE', inventory_state: 'IN_CUSTOMER_CUSTODY', customer_id: BigInt(100), rental_id: BigInt(88) },
        rental: { rental_id: BigInt(88), customer_id: BigInt(100), status: 'ACTIVE', end_date: new Date(Date.now() + 86400_000) },
        openReturns: [{ return_id: BigInt(77), status: 'RECEIVED' }],
      });
      await assert.rejects(
        () => repo.confirmPairingAtomicTx('sess_mock_1', BigInt(100), { productId: '5' }),
        (err: any) => err instanceof ConflictException,
      );
    }

    // Finding #3: factoryResetAtomicTx + ProvisioningService.factoryReset block active rental, unsettled deposit, LOCKED, warranty & succeed when unencumbered
    {
      const { repo } = buildProvisioningTxMock({
        device: { button_id: BigInt(1), device_id: 'DEV-1', store_id: BigInt(10), status: 'ACTIVE', inventory_state: 'IN_CUSTOMER_CUSTODY', customer_id: BigInt(100), rental_id: BigInt(77) },
        rental: { rental_id: BigInt(77), customer_id: BigInt(100), status: 'ACTIVE', end_date: new Date(Date.now() + 86400_000) },
        deposit: { held_amount: 100000, refund_reserved_amount: 0 },
      });
      await assert.rejects(
        () => repo.factoryResetAtomicTx(BigInt(1)),
        (err: any) => err instanceof ConflictException,
        'factoryResetAtomicTx must reject devices with active rental / unsettled deposit',
      );

      const svc = new ProvisioningService(
        {
          findButtonByIdentifier: async () => ({ buttonId: BigInt(1), deviceId: 'DEV-1', storeId: BigInt(10), customerId: BigInt(100) }),
          factoryResetAtomicTx: (id: bigint) => repo.factoryResetAtomicTx(id),
        } as any,
        {} as any,
        { emitToStore: () => {} } as any,
      );
      await assert.rejects(
        () => svc.factoryReset('DEV-1', { role: 'STORE_OWNER', storeId: '10' }),
        (err: any) => err instanceof ConflictException,
        'ProvisioningService.factoryReset must surface ConflictException (409), not 500',
      );
    }
    {
      const { repo, getState } = buildProvisioningTxMock({
        device: { button_id: BigInt(1), device_id: 'DEV-1', store_id: BigInt(10), status: 'ACTIVE', inventory_state: 'IN_CUSTOMER_CUSTODY', customer_id: BigInt(100), rental_id: null },
      });
      await repo.factoryResetAtomicTx(BigInt(1));
      assert.strictEqual(getState().updatedDeviceStatus, 'INACTIVE');
    }

    // Finding #4: Concurrent race where A passes pre-check but B takes ownership before unclaim locks row -> must fail with ConflictException
    {
      const { repo, getState } = buildProvisioningTxMock({
        device: { button_id: BigInt(1), device_id: 'DEV-1', store_id: BigInt(10), status: 'ACTIVE', inventory_state: 'IN_CUSTOMER_CUSTODY', customer_id: BigInt(200), rental_id: null },
      });
      const svc = new ProvisioningService(
        {
          findButtonByIdentifier: async () => ({ buttonId: BigInt(1), deviceId: 'DEV-1', storeId: BigInt(10), customerId: BigInt(100) }),
          unclaimDeviceAtomicTx: (id: bigint, expectedOwner?: bigint | null) => repo.unclaimDeviceAtomicTx(id, expectedOwner),
        } as any,
        {} as any,
        { emitToStore: () => {} } as any,
      );
      await assert.rejects(
        () => svc.unclaim('DEV-1', { role: 'CUSTOMER', customerProfileId: '100' }),
        (err: any) => err instanceof ConflictException,
        'Stale unclaim by Customer A must reject once locked row belongs to Customer B',
      );
      assert.strictEqual(getState().unclaimed, false);
    }
  });

  // ---------------------------------------------------------------------------
  // #8: Subscription receipts ledger (billing_payment_receipts) & overpayments
  // ---------------------------------------------------------------------------
  await check('#8 Store Subscription extra/distinct receipts record OVERPAYMENT_RECEIPT + PENDING_RECONCILIATION without double extension, auto-refund, or order ledger pollution', async () => {
    const receiptStore = new Map<string, any>();
    const obligations: any[] = [];
    const subscriptions: any[] = [];
    let orderReceiptCalls = 0;
    let nextReceiptId = BigInt(1);

    const rawChargeRow: any = {
      charge_id: BigInt(901),
      charge_code: 'CHG-SUB-901',
      purpose: 'STORE_SUBSCRIPTION',
      target_type: 'STORE',
      target_id: BigInt(10),
      payer_store_id: BigInt(10),
      plan_id: BigInt(2),
      plan_snapshot: { planId: '2', durationDays: 30, price: 60000 },
      currency: 'VND',
      total_amount: 60000,
      status: 'PENDING',
      payment_method: 'PAYOS',
      payment_link_id: 'plink_sub_901',
      provider_transaction_code: '888901',
    };

    const mockPrisma: any = {
      billingCharge: {
        findUnique: async () => ({
          chargeId: rawChargeRow.charge_id,
          chargeCode: rawChargeRow.charge_code,
          purpose: rawChargeRow.purpose,
          targetType: rawChargeRow.target_type,
          targetId: rawChargeRow.target_id,
          currency: rawChargeRow.currency,
          totalAmount: rawChargeRow.total_amount,
          status: rawChargeRow.status,
          paymentMethod: rawChargeRow.payment_method,
          paymentLinkId: rawChargeRow.payment_link_id,
          providerTransactionCode: rawChargeRow.provider_transaction_code,
          lines: [],
        }),
        findFirst: async () => ({
          chargeId: rawChargeRow.charge_id,
          chargeCode: rawChargeRow.charge_code,
          purpose: rawChargeRow.purpose,
          targetType: rawChargeRow.target_type,
          targetId: rawChargeRow.target_id,
          currency: rawChargeRow.currency,
          totalAmount: rawChargeRow.total_amount,
          status: rawChargeRow.status,
          paymentMethod: rawChargeRow.payment_method,
          paymentLinkId: rawChargeRow.payment_link_id,
          providerTransactionCode: rawChargeRow.provider_transaction_code,
          lines: [],
        }),
      },
      $transaction: async (cb: any) =>
        cb({
          $queryRawUnsafe: async (sql: string) => {
            if (sql.includes('FROM billing_charges WHERE charge_id')) return [{ ...rawChargeRow }];
            if (sql.includes('FROM billing_charges WHERE provider_transaction_code')) return [];
            if (sql.includes('FROM store WHERE')) return [{ store_id: BigInt(10) }];
            if (sql.includes('FROM store_subscriptions')) return [];
            return [];
          },
          billingCharge: {
            findUnique: async () => ({
              chargeId: rawChargeRow.charge_id,
              chargeCode: rawChargeRow.charge_code,
              purpose: rawChargeRow.purpose,
              status: rawChargeRow.status,
              totalAmount: rawChargeRow.total_amount,
              paymentLinkId: rawChargeRow.payment_link_id,
              providerTransactionCode: rawChargeRow.provider_transaction_code,
              lines: [],
            }),
            updateMany: async ({ data }: any) => {
              rawChargeRow.status = data.status;
              rawChargeRow.provider_transaction_code = data.providerTransactionCode;
              return { count: 1 };
            },
          },
          billingPaymentReceipt: {
            findUnique: async ({ where }: any) => {
              const k = where.provider_channel_providerTransactionRef;
              return receiptStore.get(`${k.provider}|${k.channel}|${k.providerTransactionRef}`) || null;
            },
            create: async ({ data }: any) => {
              const row = { id: nextReceiptId++, ...data };
              receiptStore.set(`${data.provider}|${data.channel}|${data.providerTransactionRef}`, row);
              return row;
            },
          },
          billingOverpaymentObligation: {
            create: async ({ data }: any) => {
              const ob = { id: BigInt(obligations.length + 1), ...data };
              obligations.push(ob);
              return ob;
            },
          },
          paymentOrderReceipt: {
            create: async () => {
              orderReceiptCalls++;
              return {};
            },
          },
          storeSubscription: {
            create: async ({ data }: any) => {
              const s = { subscriptionId: BigInt(subscriptions.length + 1), ...data };
              subscriptions.push(s);
              return s;
            },
          },
          outboxEvent: { create: async () => ({}) },
          rentalAuditLog: { create: async () => ({}) },
        }),
    };

    const billingRepo = new BillingChargesRepository(mockPrisma);
    const billingService = new BillingChargesService(billingRepo);

    const oldChecksum = process.env.PAYOS_CHECKSUM_KEY;
    const testChecksum = '6e91f59952acc8918c49c4a8e380136d66d1fbbf3375926840a8a7e434d4b325';
    process.env.PAYOS_CHECKSUM_KEY = testChecksum;
    const signPayos = (data: Record<string, any>) => {
      const sorted = Object.keys(data).sort();
      const q = sorted.filter((k) => data[k] !== undefined && data[k] !== null).map((k) => `${k}=${data[k]}`).join('&');
      return crypto.createHmac('sha256', testChecksum).update(q).digest('hex');
    };

    const paymentsService = new PaymentsService(
      { findTransactionByCode: async () => null } as any,
      undefined,
      undefined,
      billingService,
    );

    try {
      // 1. First webhook settles subscription & creates SETTLEMENT_RECEIPT
      const firstData = {
        orderCode: 888901,
        amount: 60000,
        currency: 'VND',
        paymentLinkId: 'plink_sub_901',
        reference: 'FT_SUB_1',
        code: '00',
        transactionDateTime: '2026-11-24 12:00:00',
      };
      const r1: any = await paymentsService.handlePayosWebhook({
        code: '00',
        desc: 'success',
        success: true,
        data: firstData,
        signature: signPayos(firstData),
      } as any);
      assert.strictEqual(r1.success, true);
      assert.strictEqual(subscriptions.length, 1, 'First payment grants exactly 1 StoreSubscription');
      assert.strictEqual(obligations.length, 0, 'First exact payment must not create overpayment obligation');
      assert.strictEqual(receiptStore.size, 1);

      // 2. Exact replay of FT_SUB_1 -> idempotent, zero extra receipts/subscriptions
      const r2: any = await paymentsService.handlePayosWebhook({
        code: '00',
        desc: 'success',
        success: true,
        data: firstData,
        signature: signPayos(firstData),
      } as any);
      assert.strictEqual(r2.success, true);
      assert.strictEqual(subscriptions.length, 1);
      assert.strictEqual(receiptStore.size, 1);
      assert.strictEqual(obligations.length, 0);

      // 3. Conflicting replay (same reference FT_SUB_1, wrong amount) -> ConflictException
      await assert.rejects(
        () =>
          billingService.settleCharge(rawChargeRow.charge_id, {
            provider: 'PAYOS',
            providerTransactionCode: 'FT_SUB_1',
            amount: 90000,
            currency: 'VND',
            paymentLinkId: 'plink_sub_901',
            verified: true,
          }),
        (err: any) => err instanceof ConflictException,
      );

      // 4. Second webhook with DISTINCT reference FT_SUB_2_EXTRA (even same or larger amount)
      const secondData = {
        orderCode: 888901,
        amount: 60000,
        currency: 'VND',
        paymentLinkId: 'plink_sub_901',
        reference: 'FT_SUB_2_EXTRA',
        code: '00',
        transactionDateTime: '2026-11-24 12:02:00',
      };
      const r3: any = await paymentsService.handlePayosWebhook({
        code: '00',
        desc: 'success',
        success: true,
        data: secondData,
        signature: signPayos(secondData),
      } as any);
      assert.strictEqual(r3.success, true);
      assert.strictEqual(subscriptions.length, 1, 'Extra receipt must NEVER extend subscription twice');
      assert.strictEqual(receiptStore.size, 2, 'Distinct receipt must be recorded in billing_payment_receipts');
      assert.strictEqual(obligations.length, 1, 'Extra receipt must create PENDING_RECONCILIATION obligation');
      assert.strictEqual(obligations[0].status, 'PENDING_RECONCILIATION');
      assert.strictEqual(obligations[0].receiptClassification, 'OVERPAYMENT_RECEIPT');
      assert.strictEqual(orderReceiptCalls, 0, 'Subscriptions must NEVER write to payment_order_receipts');

      // 5. Distinct reference FT_SUB_3_HIGHER with different amount (120000) also recorded cleanly
      const r4: any = await billingService.settleCharge(rawChargeRow.charge_id, {
        provider: 'PAYOS',
        providerTransactionCode: 'FT_SUB_3_HIGHER',
        amount: 120000,
        currency: 'VND',
        paymentLinkId: 'plink_sub_901',
        verified: true,
      });
      assert.strictEqual(r4.overpayment, true);
      assert.strictEqual(r4.overpaymentRecorded, true);
      assert.strictEqual(subscriptions.length, 1);
      assert.strictEqual(obligations.length, 2);
      assert.strictEqual(obligations[1].amount, 120000);
    } finally {
      if (oldChecksum === undefined) delete process.env.PAYOS_CHECKSUM_KEY;
      else process.env.PAYOS_CHECKSUM_KEY = oldChecksum;
    }
  });

  // ---------------------------------------------------------------------------
  // #10: OrdersLifecycleWorker excludes COD from 15-minute unpaid auto-cancel
  // ---------------------------------------------------------------------------
  await check('#10 OrdersLifecycleWorker excludes COD & CASH_ON_DELIVERY from 15-minute unpaid expiration query', async () => {
    const executedQueries: string[] = [];
    const cancelledOrders: bigint[] = [];

    const worker = new OrdersLifecycleWorker(
      {
        $queryRawUnsafe: async (sql: string) => {
          executedQueries.push(sql);
          if (sql.includes("payment_status = 'UNPAID'")) {
            return [{ order_id: BigInt(501), order_code: 'ORD-PAYOS-501' }];
          }
          return [];
        },
      } as any,
      {
        cancelOrderAtomicTx: async (id: bigint) => {
          cancelledOrders.push(id);
        },
      } as any,
      {} as any,
    );

    await worker.processPendingOrdersLifecycle();

    const unpaidSql = executedQueries.find((s) => s.includes("payment_status = 'UNPAID'")) || '';
    assert.ok(
      unpaidSql.includes("UPPER(COALESCE(o.payment_method, '')) NOT IN ('COD', 'CASH_ON_DELIVERY')"),
      `Expected COD exclusion predicate in SQL query, got:\n${unpaidSql}`,
    );
    assert.deepEqual(cancelledOrders, [BigInt(501)]);
  });

  await check('#10b OrdersRepository.cancelOrderAtomicTx re-checks payment_method under FOR UPDATE (blocks timeout on switched COD, allows manual COD cancel)', async () => {
    let orderUpdatedCount = 0;
    let invUpdatedCount = 0;
    let currentOrder: any = {
      order_id: BigInt(888),
      order_code: 'ORD-COD-RACE-888',
      order_status: 'PENDING',
      payment_status: 'UNPAID',
      payment_method: 'COD',
      button_id: null,
    };

    const mockPrisma: any = {
      $transaction: async (cb: any) =>
        cb({
          $queryRawUnsafe: async (sql: string) => {
            if (sql.includes('FROM orders WHERE order_id')) return [{ ...currentOrder }];
            if (sql.includes('FROM inventory')) return [{ reserved_quantity: 2 }];
            return [];
          },
          $executeRawUnsafe: async (sql: string) => {
            if (sql.includes('UPDATE inventory')) invUpdatedCount++;
            return 1;
          },
          order: {
            findUnique: async () => ({
              orderId: currentOrder.order_id,
              orderCode: currentOrder.order_code,
              orderStatus: currentOrder.order_status,
              paymentStatus: currentOrder.payment_status,
              paymentMethod: currentOrder.payment_method,
            }),
            update: async ({ data }: any) => {
              orderUpdatedCount++;
              currentOrder.order_status = data.orderStatus;
              return currentOrder;
            },
          },
          orderItem: {
            findMany: async () => [{ productId: BigInt(10), quantity: 2 }],
          },
        }),
    };

    const ordersRepo = new OrdersRepository(mockPrisma);

    // 1. Explicit PAYMENT_TIMEOUT mode on COD order -> must skip without mutating order or inventory
    const res1: any = await ordersRepo.cancelOrderAtomicTx(
      BigInt(888),
      'Hết hạn thời gian thanh toán đơn hàng (15 phút)',
      null,
      'CANCELLED',
      { mode: 'PAYMENT_TIMEOUT' },
    );
    assert.strictEqual(res1.skipped, true);
    assert.strictEqual(res1.orderStatus, 'PENDING');
    assert.strictEqual(orderUpdatedCount, 0);
    assert.strictEqual(invUpdatedCount, 0);

    // 2. Explicit excludePaymentMethods call -> also skips cleanly
    const res2: any = await ordersRepo.cancelOrderAtomicTx(
      BigInt(888),
      'Manual worker cleanup',
      null,
      'CANCELLED',
      { mode: 'PAYMENT_TIMEOUT', excludePaymentMethods: ['COD', 'CASH_ON_DELIVERY'] },
    );
    assert.strictEqual(res2.skipped, true);
    assert.strictEqual(orderUpdatedCount, 0);

    // 3. Manual COD cancellation MUST NOT inspect reason string keywords (timeout / EXPIRED / Hết hạn)
    const keywordReasons = ['App timeout, please cancel', 'Customer said EXPIRED promo', 'Hết hạn chờ giao'];
    for (let idx = 0; idx < keywordReasons.length; idx++) {
      currentOrder.order_status = 'PENDING';
      const canceled = await ordersRepo.cancelOrderAtomicTx(
        BigInt(888),
        keywordReasons[idx],
        BigInt(55),
        'CANCELLED',
        { mode: 'MANUAL' },
      );
      assert.ok(!canceled?.skipped, `Manual COD cancel must succeed for reason: "${keywordReasons[idx]}"`);
      assert.strictEqual(currentOrder.order_status, 'CANCELLED');
    }
    assert.strictEqual(orderUpdatedCount, 3);
    assert.strictEqual(invUpdatedCount, 3);
  });

  await check('#10c OrdersService.cancelOrder cancels COD cleanly even with timeout keywords and blocks false events if repo returns skipped', async () => {
    const emittedEvents: string[] = [];
    const mockOrderRow: any = {
      orderId: BigInt(999),
      orderCode: 'ORD-SVC-COD-999',
      storeId: BigInt(10),
      customerId: BigInt(20),
      buttonId: null,
      orderStatus: 'PENDING',
      paymentStatus: 'UNPAID',
      paymentMethod: 'COD',
      createdAt: new Date(),
      customer: { customerId: BigInt(20), userId: BigInt(30) },
      items: [],
    };

    let currentStatus = 'PENDING';
    let lastPassedMode: string | undefined;

    const fakeRepo: any = {
      findOrderById: async () => ({ ...mockOrderRow, orderStatus: currentStatus }),
      cancelOrderAtomicTx: async (_id: bigint, _reason: string, _uid: any, _target: any, opts?: any) => {
        lastPassedMode = opts?.mode;
        currentStatus = 'CANCELLED';
        return { ...mockOrderRow, orderStatus: 'CANCELLED' };
      },
    };
    const fakeEvents: any = {
      emitToStore: (_id: string, event: string) => emittedEvents.push(`store:${event}`),
      emitToCustomer: (_id: string, event: string) => emittedEvents.push(`customer:${event}`),
    };

    const ordersService = new OrdersService(fakeRepo, {} as any, fakeEvents);
    const canceled: any = await ordersService.cancelOrder(
      '999',
      'App timeout, please cancel',
      { userId: '30', role: 'CUSTOMER', customerProfileId: '20' },
    );
    assert.strictEqual(lastPassedMode, 'MANUAL');
    assert.strictEqual(canceled.orderStatus, 'CANCELLED');
    assert.deepEqual(emittedEvents, ['store:ORDER_CANCELLED', 'customer:ORDER_CANCELLED']);

    // If repository returns skipped (e.g. concurrent state protection), service must throw ConflictException and emit ZERO events
    emittedEvents.length = 0;
    currentStatus = 'PENDING';
    fakeRepo.cancelOrderAtomicTx = async () => ({
      ...mockOrderRow,
      orderStatus: 'PENDING',
      skipped: true,
      skippedReason: 'EXCLUDED_PAYMENT_METHOD',
    });

    await assert.rejects(
      () =>
        ordersService.cancelOrder(
          '999',
          'App timeout, please cancel',
          { userId: '30', role: 'CUSTOMER', customerProfileId: '20' },
        ),
      (err: any) => err?.status === 409 || err?.name === 'ConflictException',
    );
    assert.strictEqual(emittedEvents.length, 0, 'Skipped cancellation must NEVER emit ORDER_CANCELLED');
  });

  console.log(`\n🎉 ALL ${passed}/${passed} BATCH 2 & 3 UNIT/CONTRACT VERIFICATION CHECKS PASSED!\n`);
}

runTests().catch((err) => {
  console.error('❌ Verification failed:', err);
  process.exit(1);
});
