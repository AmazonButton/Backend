import assert from 'node:assert';
import 'reflect-metadata';
import { Reflector } from '@nestjs/core';
import { ForbiddenException, BadRequestException, ConflictException } from '@nestjs/common';
import { ROLES_KEY } from '../src/common/decorators/roles.decorator';
import { DevicesController } from '../src/devices/devices.controller';
import { ProvisioningController } from '../src/devices/provisioning.controller';
import { WarrantyController } from '../src/warranty/warranty.controller';
import { RentalsController } from '../src/rentals/rentals.controller';
import { AdminRentalsController } from '../src/rentals/admin-rentals.controller';
import { DevicesService } from '../src/devices/devices.service';
import { DeviceTemplatesService } from '../src/devices/device-templates.service';
import { WarrantyService } from '../src/warranty/warranty.service';
import { WarrantyRepository } from '../src/warranty/warranty.repository';
import { RentalsRepository } from '../src/rentals/rentals.repository';
import { RentalsService } from '../src/rentals/rentals.service';

async function run() {
  console.log('🧪 Running Step 4 Verification Suite: SYSTEM_STAFF Devices & Warranty Invariants...');
  const reflector = new Reflector();
  let passed = 0;

  // 1. Controller @Roles Metadata: SYSTEM_STAFF allowed on device & warranty ops, blocked from financial refund approval/payout, legacy store roles removed
  {
    const deviceOpsMethods = [
      'register',
      'bulkImport',
      'batchGenerate',
      'getUnassigned',
      'allocateToStore',
      'update',
      'remove',
      'disable',
      'enable',
      'updateBattery',
      'extendWarranty',
      'toggleActive',
      'updateBehavior',
      'getStoreDeviceInventory',
    ];
    for (const m of deviceOpsMethods) {
      const roles: string[] = reflector.get(ROLES_KEY, (DevicesController.prototype as any)[m]) || [];
      assert.ok(roles.includes('SYSTEM_STAFF'), `DevicesController.${m} must allow SYSTEM_STAFF`);
      for (const deprecated of ['STORE_MANAGER', 'STORE_STAFF', 'STAFF_BUTTON', 'STAFF_DELIVERY']) {
        assert.ok(!roles.includes(deprecated), `DevicesController.${m} must NOT contain deprecated role ${deprecated}`);
      }
    }

    const warrantyOpsMethods = ['getTickets', 'getTicketById', 'createTicket', 'approveSwap', 'lockDevice', 'resolveTicket', 'rejectTicket'];
    for (const m of warrantyOpsMethods) {
      const roles: string[] = reflector.get(ROLES_KEY, (WarrantyController.prototype as any)[m]) || [];
      assert.ok(roles.includes('SYSTEM_STAFF'), `WarrantyController.${m} must allow SYSTEM_STAFF`);
      for (const deprecated of ['STORE_MANAGER', 'STORE_STAFF', 'STAFF_BUTTON', 'STAFF_DELIVERY']) {
        assert.ok(!roles.includes(deprecated), `WarrantyController.${m} must NOT contain deprecated role ${deprecated}`);
      }
    }

    const resetRoles: string[] = reflector.get(ROLES_KEY, ProvisioningController.prototype.factoryReset) || [];
    assert.ok(resetRoles.includes('SYSTEM_STAFF'));
    assert.ok(!resetRoles.includes('STORE_MANAGER'));

    const listReturnRoles: string[] = reflector.get(ROLES_KEY, RentalsController.prototype.listReturnRequests) || [];
    assert.ok(listReturnRoles.includes('SYSTEM_STAFF'), 'RentalsController.listReturnRequests must allow SYSTEM_STAFF');
    assert.ok(listReturnRoles.includes('STORE_OWNER'), 'RentalsController.listReturnRequests must allow STORE_OWNER');
    for (const deprecated of ['STORE_MANAGER', 'STORE_STAFF', 'STAFF_BUTTON', 'STAFF_DELIVERY']) {
      assert.ok(!listReturnRoles.includes(deprecated), `RentalsController.listReturnRequests must NOT contain deprecated role ${deprecated}`);
    }

    const returnReceiptRoles: string[] = reflector.get(ROLES_KEY, RentalsController.prototype.confirmReturnReceipt) || [];
    assert.ok(returnReceiptRoles.includes('SYSTEM_STAFF'));
    assert.ok(!returnReceiptRoles.includes('STAFF_BUTTON'));

    // Financial isolation: SYSTEM_STAFF MUST NEVER approve deposit refunds or confirm payouts
    const approveRefundRoles: string[] = reflector.get(ROLES_KEY, RentalsController.prototype.approveDepositRefund) || [];
    assert.ok(!approveRefundRoles.includes('SYSTEM_STAFF'), 'SYSTEM_STAFF must NOT approve deposit refunds');
    assert.deepStrictEqual(approveRefundRoles.sort(), ['ADMIN', 'SUPER_ADMIN', 'SYSTEM_ADMIN'].sort());

    const confirmPayoutRoles: string[] =
      reflector.get(ROLES_KEY, AdminRentalsController.prototype.confirmPayout) ||
      reflector.get(ROLES_KEY, AdminRentalsController) ||
      [];
    assert.ok(!confirmPayoutRoles.includes('SYSTEM_STAFF'), 'SYSTEM_STAFF must NOT confirm payout');

    passed++;
    console.log('  ✔ [PASS] Controller RBAC grants SYSTEM_STAFF hardware/warranty ops & strictly isolates financial refunds/payouts');
  }

  // 2. DevicesService: SYSTEM_STAFF global scope vs STORE_OWNER tenant isolation
  {
    const sampleButton = {
      buttonId: BigInt(10),
      deviceId: 'SOB-000010',
      buttonCode: 'BTN-000010',
      storeId: BigInt(2),
      customerId: BigInt(5),
      status: 'ACTIVE',
      inventoryState: 'IN_CUSTOMER_CUSTODY',
      canOrder: true,
      buttonProducts: [],
      rental: null,
      store: { storeId: BigInt(2), name: 'Store 2' },
      customer: null,
    };
    const mockRepo: any = {
      findByIdentifier: async () => sampleButton,
      findMany: async () => ({ items: [sampleButton], total: 1, page: 1, pageSize: 20 }),
      update: async (_id: bigint, data: any) => ({ ...sampleButton, ...data }),
      getStoreDeviceInventory: async (storeId: bigint) => ({ storeId: storeId.toString(), inStockInStore: 3 }),
    };
    const devService = new DevicesService(mockRepo, {} as any);

    const staffUser = { userId: '100', role: 'SYSTEM_STAFF', storeId: null };
    const sysView = await devService.getById('SOB-000010', staffUser);
    assert.strictEqual(sysView.deviceId, 'SOB-000010');

    const staffInv = await devService.getStoreDeviceInventory('2', staffUser);
    assert.strictEqual(staffInv.storeId, '2');

    // Cross-store STORE_OWNER blocked
    await assert.rejects(
      () => devService.getById('SOB-000010', { userId: '20', role: 'STORE_OWNER', storeId: '1' }),
      (err: any) => err instanceof ForbiddenException,
    );
    await assert.rejects(
      () => devService.getStoreDeviceInventory('2', { userId: '20', role: 'STORE_OWNER', storeId: '1' }),
      (err: any) => err instanceof ForbiddenException,
    );

    passed++;
    console.log('  ✔ [PASS] DevicesService allows SYSTEM_STAFF hardware ops while enforcing STORE_OWNER tenant isolation');
  }

  // 3. WarrantyRepository.approveSwapAtomicTx: full transfer of rental, customer, config & expiry + expired rental stays canOrder=false
  {
    const warrantyExpires = new Date('2027-06-01T00:00:00Z');
    const futureRentalExpiry = new Date(Date.now() + 15 * 86400 * 1000);
    const pastRentalExpiry = new Date(Date.now() - 86400 * 1000);

    let activeRentalExpiry = futureRentalExpiry;
    let updatedOld: any = null;
    let updatedNew: any = null;
    let transferredProductsCount = 0;
    const lockOrder: bigint[] = [];
    const movements: any[] = [];

    const oldButtonState: any = {
      buttonId: BigInt(11),
      deviceId: 'SOB-OLD-11',
      storeId: BigInt(3),
      custodyStoreId: BigInt(3),
      customerId: BigInt(77),
      rentalId: BigInt(501),
      addressId: BigInt(88),
      warrantyUntil: warrantyExpires,
      clickBehavior: 'DOUBLE',
      doubleClickWindowMs: 420,
      holdDurationMs: 1800,
      singlePressAction: 'CREATE_ORDER',
      doublePressAction: 'CANCEL_ORDER',
      longPressAction: 'WIFI_CONFIGURATION',
      cancelWindowSeconds: 45,
      deployedTemplateId: BigInt(9),
      installedAt: new Date('2026-10-01T00:00:00Z'),
      status: 'ACTIVE',
      inventoryState: 'IN_CUSTOMER_CUSTODY',
      canOrder: true,
    };
    const newButtonState: any = {
      buttonId: BigInt(22),
      deviceId: 'SOB-NEW-22',
      storeId: BigInt(1),
      custodyStoreId: null,
      customerId: null,
      rentalId: null,
      addressId: null,
      status: 'INACTIVE',
      inventoryState: 'IN_PLATFORM_WAREHOUSE',
      canOrder: false,
    };

    const mockPrisma: any = {
      $transaction: async (cb: any) =>
        cb({
          $queryRaw: async (strings: any, ...vals: any[]) => {
            const sql = strings.join('?');
            if (sql.includes('FROM iot_button')) {
              for (const v of vals) if (typeof v === 'bigint') lockOrder.push(v);
            }
            return [{ ok: 1 }];
          },
          warrantyTicket: {
            findUnique: async () => ({
              ticketId: BigInt(300),
              ticketCode: 'WRT-TEST-300',
              buttonId: BigInt(11),
              storeId: BigInt(3),
              customerId: BigInt(77),
              rentalId: BigInt(501),
              faultGroup: 'GROUP_A',
              faultCode: 'DEAD_SWITCH',
              status: 'PENDING',
              button: { ...oldButtonState },
            }),
            findFirst: async () => null,
            update: async ({ data }: any) => ({
              ticketId: BigInt(300),
              ticketCode: 'WRT-TEST-300',
              buttonId: BigInt(11),
              replacementButtonId: data.replacementButtonId,
              storeId: BigInt(3),
              customerId: BigInt(77),
              reportedByUserId: BigInt(200),
              faultGroup: 'GROUP_A',
              faultCode: 'DEAD_SWITCH',
              status: data.status,
              button: { deviceId: 'SOB-OLD-11' },
              replacementButton: { deviceId: 'SOB-NEW-22' },
            }),
          },
          ioTButton: {
            findUnique: async ({ where }: any) => {
              if (where.buttonId === BigInt(11)) return { ...oldButtonState };
              if (where.buttonId === BigInt(22)) return { ...newButtonState };
              return null;
            },
            update: async ({ where, data }: any) => {
              if (where.buttonId === BigInt(11)) updatedOld = data;
              if (where.buttonId === BigInt(22)) updatedNew = data;
              return data;
            },
          },
          buttonRental: {
            findUnique: async () => ({
              rentalId: BigInt(501),
              status: 'ACTIVE',
              effectiveExpiresAt: activeRentalExpiry,
            }),
          },
          buttonProduct: {
            deleteMany: async () => ({ count: 0 }),
            updateMany: async () => {
              transferredProductsCount++;
              return { count: 1 };
            },
          },
          deviceMovement: {
            create: async ({ data }: any) => {
              movements.push(data);
              return data;
            },
          },
        }),
    };

    const repo = new WarrantyRepository(mockPrisma);
    const swapped = await repo.approveSwapAtomicTx(BigInt(300), BigInt(22), BigInt(200), 'Swap approved');
    assert.strictEqual(swapped.status, 'APPROVED_SWAP');
    assert.deepStrictEqual(lockOrder, [BigInt(11), BigInt(22)], 'Buttons must lock in ascending ID order');
    assert.strictEqual(updatedOld.status, 'INACTIVE');
    assert.strictEqual(updatedOld.rentalId, null);
    assert.strictEqual(updatedOld.customerId, null);
    assert.strictEqual(updatedOld.inventoryState, 'DEFECTIVE_RETURN');

    // New button MUST inherit customer, rental, address, store, expiry & full hardware config
    assert.strictEqual(updatedNew.storeId, BigInt(3));
    assert.strictEqual(updatedNew.customerId, BigInt(77));
    assert.strictEqual(updatedNew.rentalId, BigInt(501));
    assert.strictEqual(updatedNew.addressId, BigInt(88));
    assert.strictEqual(updatedNew.warrantyUntil.getTime(), warrantyExpires.getTime());
    assert.strictEqual(updatedNew.clickBehavior, 'DOUBLE');
    assert.strictEqual(updatedNew.doubleClickWindowMs, 420);
    assert.strictEqual(updatedNew.holdDurationMs, 1800);
    assert.strictEqual(updatedNew.singlePressAction, 'CREATE_ORDER');
    assert.strictEqual(updatedNew.doublePressAction, 'CANCEL_ORDER');
    assert.strictEqual(updatedNew.longPressAction, 'WIFI_CONFIGURATION');
    assert.strictEqual(updatedNew.cancelWindowSeconds, 45);
    assert.strictEqual(updatedNew.deployedTemplateId, BigInt(9));
    assert.strictEqual(updatedNew.canOrder, true);
    assert.strictEqual(transferredProductsCount, 1);
    assert.strictEqual(movements.length, 2);
    assert.strictEqual(movements[1].rentalId, BigInt(501));

    // Swap when underlying rental contract already expired -> inherits rentalId but canOrder stays false!
    activeRentalExpiry = pastRentalExpiry;
    await repo.approveSwapAtomicTx(BigInt(300), BigInt(22), BigInt(200), 'Expired rental swap');
    assert.strictEqual(updatedNew.rentalId, BigInt(501));
    assert.strictEqual(updatedNew.canOrder, false, 'Expired rental contract must keep canOrder = false after swap');

    passed++;
    console.log('  ✔ [PASS] approveSwapAtomicTx transfers customer, rental, config, expiry & respects expired rental boundaries');
  }

  // 4. Duplicate & self-swap blocking + WarrantyService SYSTEM_STAFF WS broadcast
  {
    const repoDupPrisma: any = {
      $transaction: async (cb: any) =>
        cb({
          $queryRaw: async () => [{ ok: 1 }],
          warrantyTicket: {
            findUnique: async () => ({
              ticketId: BigInt(400),
              ticketCode: 'WRT-400',
              buttonId: BigInt(11),
              faultGroup: 'GROUP_A',
              status: 'PENDING',
              button: { buttonId: BigInt(11), deviceId: 'SOB-11' },
            }),
            findFirst: async () => ({ ticketId: BigInt(399), ticketCode: 'WRT-399' }),
          },
          ioTButton: {
            findUnique: async ({ where }: any) =>
              where.buttonId === BigInt(11)
                ? { buttonId: BigInt(11), deviceId: 'SOB-11', status: 'ACTIVE', inventoryState: 'IN_CUSTOMER_CUSTODY' }
                : { buttonId: BigInt(22), deviceId: 'SOB-22', status: 'ACTIVE', inventoryState: 'IN_PLATFORM_WAREHOUSE', customerId: null, rentalId: null },
          },
        }),
    };
    const repoDup = new WarrantyRepository(repoDupPrisma);

    // Self-swap blocked
    await assert.rejects(
      () => repoDup.approveSwapAtomicTx(BigInt(400), BigInt(11), BigInt(200)),
      (err: any) => err instanceof BadRequestException && err.message.includes('DUPLICATE_DEVICE_SWAP'),
    );

    // Replacement already assigned to another active/resolved warranty ticket blocked
    await assert.rejects(
      () => repoDup.approveSwapAtomicTx(BigInt(400), BigInt(22), BigInt(200)),
      (err: any) => err instanceof ConflictException && err.message.includes('DUPLICATE_REPLACEMENT_DEVICE'),
    );

    // Already customer-owned button blocked
    const repoInUsePrisma: any = {
      $transaction: async (cb: any) =>
        cb({
          $queryRaw: async () => [{ ok: 1 }],
          warrantyTicket: {
            findUnique: async () => ({
              ticketId: BigInt(401),
              ticketCode: 'WRT-401',
              buttonId: BigInt(11),
              faultGroup: 'GROUP_A',
              status: 'PENDING',
              button: { buttonId: BigInt(11) },
            }),
          },
          ioTButton: {
            findUnique: async ({ where }: any) =>
              where.buttonId === BigInt(11)
                ? { buttonId: BigInt(11), status: 'ACTIVE', inventoryState: 'IN_CUSTOMER_CUSTODY' }
                : { buttonId: BigInt(23), status: 'ACTIVE', inventoryState: 'IN_CUSTOMER_CUSTODY', customerId: BigInt(99), rentalId: BigInt(88) },
          },
        }),
    };
    await assert.rejects(
      () => new WarrantyRepository(repoInUsePrisma).approveSwapAtomicTx(BigInt(401), BigInt(23), BigInt(200)),
      (err: any) => err instanceof ConflictException && err.message.includes('DEVICE_ALREADY_IN_USE'),
    );

    // Early service self-swap guard & SYSTEM_STAFF WS broadcast
    const sysStaffEvents: string[] = [];
    const wService = new WarrantyService(
      {
        findTicketById: async () => ({
          ticketId: BigInt(500),
          ticketCode: 'WRT-500',
          status: 'PENDING',
          faultGroup: 'GROUP_A',
          buttonId: BigInt(11),
          button: { deviceId: 'SOB-SAME' },
        }),
      } as any,
      { emitToAdmin: () => { }, emitToSystemStaff: (e: string) => sysStaffEvents.push(e), emitToStore: () => { } } as any,
    );
    await assert.rejects(
      () => wService.approveSwap('500', { replacementDeviceId: 'SOB-SAME' }, { userId: '200', role: 'SYSTEM_STAFF' }),
      (err: any) => err instanceof BadRequestException,
    );
    assert.strictEqual(sysStaffEvents.length, 0);

    passed++;
    console.log('  ✔ [PASS] Duplicate replacement, active-custody device & self-swap attempts are rejected atomically');
  }

  // 5. Warranty lockDeviceAtomicTx never auto-confirms refund & blocks double lock
  {
    let ticketStatus = 'PENDING';
    let createdRefund: any = null;
    const mockLockPrisma: any = {
      $transaction: async (cb: any) =>
        cb({
          $queryRaw: async () => [{ ok: 1 }],
          $queryRawUnsafe: async (sql: string) => {
            if (sql.includes('FROM deposit_refunds')) {
              return [{ reserved_pending: 0 }];
            }
            return [{ rental_id: BigInt(700), held_amount: 200000 }];
          },
          $executeRawUnsafe: async () => 1,
          warrantyTicket: {
            findUnique: async () => ({
              ticketId: BigInt(600),
              ticketCode: 'WRT-600',
              buttonId: BigInt(30),
              storeId: BigInt(3),
              customerId: BigInt(77),
              rentalId: BigInt(700),
              reportedByUserId: BigInt(200),
              faultGroup: 'GROUP_D',
              faultCode: 'WATER_DAMAGE',
              deductionAmount: 140000,
              refundAmount: 60000,
              status: ticketStatus,
              button: { buttonId: BigInt(30), storeId: BigInt(3), rentalId: BigInt(700), customerId: BigInt(77) },
            }),
            update: async ({ data }: any) => {
              ticketStatus = data.status;
              return {
                ticketId: BigInt(600),
                ticketCode: 'WRT-600',
                buttonId: BigInt(30),
                storeId: BigInt(3),
                reportedByUserId: BigInt(200),
                faultGroup: 'GROUP_D',
                faultCode: 'WATER_DAMAGE',
                status: data.status,
              };
            },
            updateMany: async () => ({ count: 0 }),
          },
          ioTButton: {
            findUnique: async () => ({
              buttonId: BigInt(30),
              storeId: BigInt(3),
              rentalId: BigInt(700),
              customerId: BigInt(77),
              status: ticketStatus === 'PENDING' ? 'ACTIVE' : 'DISABLED',
              inventoryState: ticketStatus === 'PENDING' ? 'IN_CUSTOMER_CUSTODY' : 'DEFECTIVE_RETURN',
            }),
            update: async () => ({}),
            count: async () => 0,
          },
          buttonRental: { update: async () => ({}) },
          depositRefund: {
            create: async ({ data }: any) => {
              createdRefund = data;
              return data;
            },
          },
          deviceMovement: { create: async ({ data }: any) => data },
        }),
    };

    const lockRepo = new WarrantyRepository(mockLockPrisma);
    const locked = await lockRepo.lockDeviceAtomicTx(BigInt(600), BigInt(200), 'Hardware damaged');
    assert.strictEqual(locked.status, 'RESOLVED');
    assert.ok(createdRefund, 'DepositRefund request should be queued for finance review when partial balance remains');
    assert.strictEqual(createdRefund.status, 'PENDING_APPROVAL', 'Warranty MUST NEVER auto-confirm refund payout');
    assert.strictEqual(createdRefund.warrantyTicketId, BigInt(600));
    assert.strictEqual(createdRefund.deductionAmount, 140000);
    assert.strictEqual(createdRefund.amount, 60000);
    assert.strictEqual(createdRefund.approvedByUserId, null);
    assert.strictEqual(createdRefund.refundedAt, null);

    // Double-lock blocked
    await assert.rejects(
      () => lockRepo.lockDeviceAtomicTx(BigInt(600), BigInt(200), 'Retry'),
      (err: any) => err instanceof BadRequestException,
    );

    passed++;
    console.log('  ✔ [PASS] lockDeviceAtomicTx queues PENDING_APPROVAL refund without payout confirmation & blocks double lock');
  }

  // 6. Warranty Lock -> Admin Approve Refund -> Confirm Payout updates rental_deposits ONCE ONLY (no double-hold)
  {
    const ledger = {
      rentalId: BigInt(801),
      collectedAmount: 200000,
      heldAmount: 200000,
      refundReservedAmount: 0,
      refundedAmount: 0,
    };
    let ticketState: any = {
      ticketId: BigInt(601),
      ticketCode: 'WRT-601',
      buttonId: BigInt(31),
      storeId: BigInt(3),
      customerId: BigInt(77),
      rentalId: BigInt(801),
      reportedByUserId: BigInt(200),
      faultGroup: 'GROUP_C',
      faultCode: 'CRACKED_CASING',
      deductionAmount: 60000,
      refundAmount: 140000,
      status: 'PENDING',
      button: { buttonId: BigInt(31), storeId: BigInt(3), rentalId: BigInt(801), customerId: BigInt(77), status: 'ACTIVE', inventoryState: 'IN_CUSTOMER_CUSTODY' },
    };
    const refunds: any[] = [];

    const sharedFinancePrisma: any = {
      $transaction: async (cb: any) =>
        cb({
          $queryRaw: async () => [{ ok: 1 }],
          $queryRawUnsafe: async (sql: string, ...args: any[]) => {
            if (sql.includes('FROM deposit_refunds WHERE rental_id')) {
              const sum = refunds
                .filter((r) => r.rentalId === args[0] && r.status === 'PENDING_APPROVAL')
                .reduce((acc, r) => acc + Number(r.amount) + Number(r.deductionAmount || 0), 0);
              return [{ reserved_pending: sum }];
            }
            if (sql.includes('FROM deposit_refunds WHERE refund_id')) {
              const r = refunds.find((x) => x.refundId === args[0]);
              return r
                ? [
                  {
                    refund_id: r.refundId,
                    refund_code: r.refundCode,
                    rental_id: r.rentalId,
                    customer_id: r.customerId,
                    warranty_ticket_id: r.warrantyTicketId,
                    amount: r.amount,
                    deduction_amount: r.deductionAmount,
                    status: r.status,
                    bank_account_id: r.bankAccountId ?? null,
                  },
                ]
                : [];
            }
            if (sql.includes('FROM rental_deposits WHERE rental_id')) {
              return [
                {
                  rental_id: ledger.rentalId,
                  collected_amount: ledger.collectedAmount,
                  held_amount: ledger.heldAmount,
                  refund_reserved_amount: ledger.refundReservedAmount,
                  refunded_amount: ledger.refundedAmount,
                },
              ];
            }
            if (sql.includes('FROM customer_bank_accounts')) {
              return [
                {
                  id: BigInt(9),
                  bank_bin: '970436',
                  account_number_encrypted: 'enc',
                  account_number_hash: 'hash',
                  account_name: 'NGUYEN VAN TEST',
                  account_number_masked: '******1234',
                  verification_status: 'VERIFIED',
                },
              ];
            }
            return [];
          },
          $executeRawUnsafe: async (sql: string, ...args: any[]) => {
            if (sql.includes('UPDATE rental_deposits') && sql.includes('held_amount = held_amount - $1')) {
              const [subHeld, addReserved] = args;
              if (ledger.heldAmount < Number(subHeld)) return 0;
              ledger.heldAmount -= Number(subHeld);
              ledger.refundReservedAmount += Number(addReserved);
              return 1;
            }
            if (sql.includes('UPDATE rental_deposits') && sql.includes('refund_reserved_amount = refund_reserved_amount - $1')) {
              const [amt] = args;
              if (ledger.refundReservedAmount < Number(amt)) return 0;
              ledger.refundReservedAmount -= Number(amt);
              ledger.refundedAmount += Number(amt);
              return 1;
            }
            if (sql.includes("UPDATE deposit_refunds") && sql.includes("SET status = 'PENDING_PAYOUT'")) {
              const target = refunds.find((r) => r.refundId === args[7] && r.status === 'PENDING_APPROVAL');
              if (!target) return 0;
              target.status = 'PENDING_PAYOUT';
              target.approvedByUserId = args[0];
              return 1;
            }
            if (sql.includes("UPDATE deposit_refunds") && sql.includes("SET status = 'REFUNDED'")) {
              const target = refunds.find((r) => r.refundId === args[1] && r.status === 'PENDING_PAYOUT');
              if (!target) return 0;
              target.status = 'REFUNDED';
              target.providerReferenceId = args[0];
              return 1;
            }
            return 1;
          },
          warrantyTicket: {
            findUnique: async () => ({ ...ticketState }),
            update: async ({ data }: any) => {
              ticketState = { ...ticketState, ...data };
              return ticketState;
            },
            updateMany: async () => ({ count: 0 }),
          },
          ioTButton: {
            findUnique: async () => ({ ...ticketState.button }),
            update: async ({ data }: any) => {
              ticketState.button = { ...ticketState.button, ...data };
              return ticketState.button;
            },
            count: async () => 0,
          },
          buttonRental: { update: async () => ({}) },
          depositRefund: {
            create: async ({ data }: any) => {
              const row = { ...data, refundId: BigInt(refunds.length + 501) };
              refunds.push(row);
              return row;
            },
          },
          rentalDeposit: {
            findUnique: async () => ({ ...ledger }),
          },
          deviceMovement: { create: async ({ data }: any) => data },
          outboxEvent: { create: async ({ data }: any) => data },
          rentalAuditLog: { create: async ({ data }: any) => data },
        }),
    };

    const wRepo = new WarrantyRepository(sharedFinancePrisma);
    const rRepo = new RentalsRepository(sharedFinancePrisma);

    // Step 1: SYSTEM_STAFF locks device (200k deposit: 60k deduction, 140k refund) -> ledger NOT mutated yet!
    await wRepo.lockDeviceAtomicTx(BigInt(601), BigInt(200), 'Lock Group C');
    assert.strictEqual(ledger.heldAmount, 200000, 'Warranty lock MUST NOT prematurely deduct held_amount');
    assert.strictEqual(ledger.refundReservedAmount, 0, 'Warranty lock MUST NOT prematurely add refund_reserved_amount');
    assert.strictEqual(refunds.length, 1);
    assert.strictEqual(refunds[0].amount, 140000);
    assert.strictEqual(refunds[0].deductionAmount, 60000);

    // Step 2: Admin approves refund -> single CAS deducts 200k collateral (140k refund + 60k forfeit) & reserves 140k
    const approved = await rRepo.approveDepositRefundTx(refunds[0].refundId, { userId: '1', role: 'ADMIN' });
    assert.strictEqual(approved.status, 'PENDING_PAYOUT');
    assert.strictEqual(ledger.heldAmount, 0, 'All 200k held settled once on approval');
    assert.strictEqual(ledger.refundReservedAmount, 140000, 'Only 140k reserved once for payout');

    // Step 3: Payout confirmation moves 140k -> refundedAmount = 140k (conservation: 200k = 0 + 0 + 140k + 60k forfeit)
    const paid = await rRepo.confirmDepositRefundPayoutTx(refunds[0].refundId, 'PAYOS-REF-601');
    assert.strictEqual(paid.status, 'REFUNDED');
    assert.strictEqual(ledger.refundReservedAmount, 0);
    assert.strictEqual(ledger.refundedAmount, 140000);

    passed++;
    console.log('  ✔ [PASS] Warranty lock + Admin refund approval settles deposit ledger ONCE ONLY (zero double-hold)');
  }

  // 7. Point 2 Regression: Duplicate PENDING tickets on same buttonId blocked & second swap cannot swap A -> C after A -> B
  {
    const buttonsMap = new Map<string, any>([
      [
        '11',
        {
          buttonId: BigInt(11),
          deviceId: 'SOB-A',
          storeId: BigInt(3),
          custodyStoreId: BigInt(3),
          customerId: BigInt(77),
          rentalId: BigInt(501),
          addressId: BigInt(88),
          inventoryState: 'IN_CUSTOMER_CUSTODY',
          status: 'ACTIVE',
          canOrder: true,
        },
      ],
      [
        '22',
        {
          buttonId: BigInt(22),
          deviceId: 'SOB-B',
          storeId: BigInt(1),
          customerId: null,
          rentalId: null,
          inventoryState: 'IN_PLATFORM_WAREHOUSE',
          status: 'INACTIVE',
          canOrder: false,
        },
      ],
      [
        '23',
        {
          buttonId: BigInt(23),
          deviceId: 'SOB-C',
          storeId: BigInt(1),
          customerId: null,
          rentalId: null,
          inventoryState: 'IN_PLATFORM_WAREHOUSE',
          status: 'INACTIVE',
          canOrder: false,
        },
      ],
    ]);
    const ticketsMap = new Map<string, any>([
      [
        '701',
        {
          ticketId: BigInt(701),
          ticketCode: 'WRT-701',
          buttonId: BigInt(11),
          replacementButtonId: null,
          storeId: BigInt(3),
          customerId: BigInt(77),
          rentalId: BigInt(501),
          reportedByUserId: BigInt(200),
          faultGroup: 'GROUP_A',
          faultCode: 'DEAD_SWITCH',
          status: 'PENDING',
        },
      ],
      [
        '702',
        {
          ticketId: BigInt(702),
          ticketCode: 'WRT-702',
          buttonId: BigInt(11),
          replacementButtonId: null,
          storeId: BigInt(3),
          customerId: BigInt(77),
          rentalId: BigInt(501),
          reportedByUserId: BigInt(200),
          faultGroup: 'GROUP_A',
          faultCode: 'DEAD_SWITCH',
          status: 'PENDING',
        },
      ],
    ]);

    const raceSwapPrisma: any = {
      warrantyTicket: {
        findFirst: async ({ where }: any) => {
          for (const t of ticketsMap.values()) {
            if (t.buttonId === where.buttonId && t.status === where.status) return t;
          }
          return null;
        },
      },
      $transaction: async (cb: any) =>
        cb({
          $queryRaw: async () => [{ ok: 1 }],
          warrantyTicket: {
            findUnique: async ({ where }: any) => {
              const t = ticketsMap.get(where.ticketId.toString());
              return t ? { ...t, button: buttonsMap.get(t.buttonId.toString()) } : null;
            },
            findFirst: async ({ where }: any) => {
              for (const t of ticketsMap.values()) {
                if (
                  t.replacementButtonId === where.replacementButtonId &&
                  t.ticketId !== where.ticketId?.not &&
                  where.status?.in?.includes(t.status)
                ) {
                  return t;
                }
              }
              return null;
            },
            update: async ({ where, data }: any) => {
              const cur = ticketsMap.get(where.ticketId.toString());
              const next = { ...cur, ...data };
              ticketsMap.set(where.ticketId.toString(), next);
              return { ...next, button: buttonsMap.get(next.buttonId.toString()), replacementButton: buttonsMap.get(next.replacementButtonId?.toString()) };
            },
            updateMany: async () => ({ count: 0 }), // intentionally simulate race before stale tickets close!
          },
          ioTButton: {
            findUnique: async ({ where }: any) => buttonsMap.get(where.buttonId.toString()) || null,
            update: async ({ where, data }: any) => {
              const cur = buttonsMap.get(where.buttonId.toString());
              const next = { ...cur, ...data };
              buttonsMap.set(where.buttonId.toString(), next);
              return next;
            },
          },
          buttonRental: {
            findUnique: async () => ({
              rentalId: BigInt(501),
              status: 'ACTIVE',
              effectiveExpiresAt: new Date(Date.now() + 86400_000),
            }),
          },
          buttonProduct: { deleteMany: async () => ({ count: 0 }), updateMany: async () => ({ count: 1 }) },
          deviceMovement: { create: async ({ data }: any) => data },
        }),
    };

    const dupGuardRepo = new WarrantyRepository(raceSwapPrisma);

    // Creating another PENDING ticket on same buttonId is blocked
    await assert.rejects(
      () =>
        dupGuardRepo.createTicket({
          ticketCode: 'WRT-703',
          buttonId: BigInt(11),
          reportedByUserId: BigInt(200),
          faultGroup: 'GROUP_A',
          faultCode: 'DEAD_SWITCH',
          depositAmount: 200000,
          deductionPercent: 0,
          deductionAmount: 0,
          refundAmount: 200000,
        }),
      (err: any) => err instanceof ConflictException && err.message.includes('DUPLICATE_PENDING_WARRANTY_TICKET'),
    );

    // Ticket 701 swaps A -> B cleanly
    const firstSwap = await dupGuardRepo.approveSwapAtomicTx(BigInt(701), BigInt(22), BigInt(200));
    assert.strictEqual(firstSwap.status, 'APPROVED_SWAP');
    assert.strictEqual(buttonsMap.get('22').rentalId, BigInt(501));

    // Even if Ticket 702 was still PENDING from earlier, swapping A -> C MUST be rejected & C stays untouched!
    await assert.rejects(
      () => dupGuardRepo.approveSwapAtomicTx(BigInt(702), BigInt(23), BigInt(200)),
      (err: any) => err instanceof ConflictException && err.message.includes('SOURCE_DEVICE_ALREADY_SWAPPED_OR_LOCKED'),
    );
    assert.strictEqual(buttonsMap.get('23').customerId, null, 'Button C must NEVER be assigned to customer');
    assert.strictEqual(buttonsMap.get('23').rentalId, null, 'Button C must NEVER be linked to rental');
    assert.strictEqual(buttonsMap.get('23').inventoryState, 'IN_PLATFORM_WAREHOUSE');

    passed++;
    console.log('  ✔ [PASS] Duplicate PENDING tickets blocked & second swap on same source button (A -> C) rejected after A -> B');
  }

  // 8. Rental Snapshot Integrity: reject stale tickets across rentals (501 -> 601) & legacy null snapshots on active rentals
  {
    const buttonsMap = new Map<string, any>([
      [
        '41',
        {
          buttonId: BigInt(41),
          deviceId: 'SOB-RNT-41',
          storeId: BigInt(3),
          custodyStoreId: BigInt(3),
          customerId: BigInt(77),
          rentalId: BigInt(501),
          inventoryState: 'IN_CUSTOMER_CUSTODY',
          status: 'ACTIVE',
          canOrder: true,
          rental: { rentalId: BigInt(501), depositPerButton: 200000 },
        },
      ],
      [
        '42',
        {
          buttonId: BigInt(42),
          deviceId: 'SOB-REP-42',
          storeId: BigInt(1),
          customerId: null,
          rentalId: null,
          inventoryState: 'IN_PLATFORM_WAREHOUSE',
          status: 'INACTIVE',
          canOrder: false,
        },
      ],
    ]);
    const createdRefunds: any[] = [];
    const savedTickets = new Map<string, any>();
    let nextTicketSeq = 801;

    const rentalSnapshotPrisma: any = {
      ioTButton: {
        findUnique: async ({ where }: any) => {
          for (const btn of buttonsMap.values()) {
            if ((where.deviceId && btn.deviceId === where.deviceId) || (where.buttonId && btn.buttonId === where.buttonId)) {
              return { ...btn };
            }
          }
          return null;
        },
      },
      warrantyTicket: {
        findFirst: async ({ where }: any) => {
          for (const t of savedTickets.values()) {
            if (t.buttonId === where.buttonId && t.status === where.status) return t;
          }
          return null;
        },
        create: async ({ data }: any) => {
          const row = {
            ...data,
            ticketId: BigInt(nextTicketSeq++),
            button: buttonsMap.get(data.buttonId.toString()),
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          savedTickets.set(row.ticketId.toString(), row);
          return row;
        },
      },
      $transaction: async (cb: any) =>
        cb({
          $queryRaw: async () => [{ ok: 1 }],
          $queryRawUnsafe: async () => [],
          warrantyTicket: {
            findUnique: async ({ where }: any) => {
              const t = savedTickets.get(where.ticketId.toString());
              return t ? { ...t, button: buttonsMap.get(t.buttonId.toString()) } : null;
            },
            findFirst: async () => null,
            update: async () => {
              throw new Error('Must NOT update ticket when rental snapshot mismatches');
            },
            updateMany: async () => ({ count: 0 }),
          },
          ioTButton: {
            findUnique: async ({ where }: any) => buttonsMap.get(where.buttonId.toString()) || null,
            update: async () => {
              throw new Error('Must NOT mutate button when rental snapshot mismatches');
            },
          },
          depositRefund: {
            create: async ({ data }: any) => {
              createdRefunds.push(data);
              return data;
            },
          },
        }),
    };

    const snapRepo = new WarrantyRepository(rentalSnapshotPrisma);
    const snapService = new WarrantyService(snapRepo);

    // 8a. Create Group C ticket while button belongs to rental 501 (200k deposit) -> snapshot rentalId = 501
    const createdDto = await snapService.createTicket(
      {
        deviceId: 'SOB-RNT-41',
        faultGroup: 'GROUP_C' as any,
        faultCode: 'CRACKED_CASING',
      },
      { userId: '200', role: 'SYSTEM_STAFF' },
    );
    assert.strictEqual(createdDto.rentalId, '501', 'createTicket MUST snapshot rentalId alongside depositAmount');
    assert.strictEqual(createdDto.depositAmount, 200000);
    assert.strictEqual(createdDto.deductionAmount, 60000);
    assert.strictEqual(createdDto.refundAmount, 140000);

    // Simulate button moving to newer rental 601 (SAME customer 77 & store 3, 500k deposit)
    buttonsMap.set('41', {
      ...buttonsMap.get('41'),
      rentalId: BigInt(601),
      rental: { rentalId: BigInt(601), depositPerButton: 500000 },
    });

    // 8b. Old ticket (snapshot 501) MUST be rejected with 409 Conflict when attempting lockDeviceAtomicTx on rental 601
    await assert.rejects(
      () => snapRepo.lockDeviceAtomicTx(BigInt(createdDto.ticketId), BigInt(200), 'Stale lock'),
      (err: any) => err instanceof ConflictException && err.message.includes('SOURCE_DEVICE_RENTAL_MISMATCH'),
    );
    assert.strictEqual(createdRefunds.length, 0, 'Rental 601 must NEVER receive DepositRefund from rental 501 ticket');
    assert.strictEqual(buttonsMap.get('41').rentalId, BigInt(601));

    // 8c. Old GROUP_A ticket (snapshot 501) MUST also be rejected with 409 Conflict on approveSwapAtomicTx when button is now on 601
    savedTickets.set('890', {
      ticketId: BigInt(890),
      ticketCode: 'WRT-890',
      buttonId: BigInt(41),
      storeId: BigInt(3),
      customerId: BigInt(77),
      rentalId: BigInt(501),
      reportedByUserId: BigInt(200),
      faultGroup: 'GROUP_A',
      faultCode: 'DEAD_SWITCH',
      status: 'PENDING',
    });
    await assert.rejects(
      () => snapRepo.approveSwapAtomicTx(BigInt(890), BigInt(42), BigInt(200), 'Stale swap'),
      (err: any) => err instanceof ConflictException && err.message.includes('SOURCE_DEVICE_RENTAL_MISMATCH'),
    );
    assert.strictEqual(buttonsMap.get('42').customerId, null);

    // 8d. Legacy un-snapshotted ticket (rentalId: null) while button is on active rental 601 -> MUST return 409 Conflict (never auto-backfill 601)
    savedTickets.set('891', {
      ticketId: BigInt(891),
      ticketCode: 'WRT-891-LEGACY',
      buttonId: BigInt(41),
      storeId: BigInt(3),
      customerId: BigInt(77),
      rentalId: null,
      reportedByUserId: BigInt(200),
      faultGroup: 'GROUP_C',
      faultCode: 'CRACKED_CASING',
      deductionAmount: 60000,
      refundAmount: 140000,
      status: 'PENDING',
    });
    await assert.rejects(
      () => snapRepo.lockDeviceAtomicTx(BigInt(891), BigInt(200), 'Legacy without snapshot'),
      (err: any) => err instanceof ConflictException && err.message.includes('SOURCE_DEVICE_RENTAL_MISMATCH'),
    );
    savedTickets.set('892', {
      ticketId: BigInt(892),
      ticketCode: 'WRT-892-LEGACY',
      buttonId: BigInt(41),
      storeId: BigInt(3),
      customerId: BigInt(77),
      rentalId: null,
      reportedByUserId: BigInt(200),
      faultGroup: 'GROUP_A',
      faultCode: 'DEAD_SWITCH',
      status: 'PENDING',
    });
    await assert.rejects(
      () => snapRepo.approveSwapAtomicTx(BigInt(892), BigInt(42), BigInt(200), 'Legacy swap without snapshot'),
      (err: any) => err instanceof ConflictException && err.message.includes('SOURCE_DEVICE_RENTAL_MISMATCH'),
    );
    assert.strictEqual(createdRefunds.length, 0);

    passed++;
    console.log('  ✔ [PASS] Ticket rentalId snapshot enforced on create, lock & swap (rejects 501->601 drift & legacy null snapshots with 409)');
  }

  // 9. DeviceTemplatesService: SYSTEM_STAFF CRUD + deploy validates defaultProduct against routing storeId (not custodyStoreId)
  {
    const templates = new Map<string, any>();
    let seq = 900n;
    const deployedCalls: any[] = [];
    const mockRepo: any = {
      createTemplate: async (data: any) => {
        const id = ++seq;
        const row = { templateId: id, ...data };
        templates.set(id.toString(), row);
        return row;
      },
      findTemplateByIdOrCode: async (id: string) => templates.get(String(id)) || null,
      updateTemplate: async (id: bigint, data: any) => {
        const prev = templates.get(id.toString());
        const next = { ...prev, ...Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)) };
        templates.set(id.toString(), next);
        return next;
      },
      deleteTemplate: async (id: bigint) => {
        templates.delete(id.toString());
      },
      findByIdentifier: async (deviceId: string) => {
        if (deviceId === 'SOB-CUSTODY-B') {
          return {
            buttonId: 7001n,
            deviceId: 'SOB-CUSTODY-B',
            storeId: 10n, // Routing store A
            custodyStoreId: 20n, // Physical custody store B
          };
        }
        return null;
      },
      deployTemplateAtomicTx: async (buttonId: bigint, payload: any) => {
        deployedCalls.push({ buttonId, payload });
      },
    };
    const mockPrisma: any = {
      product: {
        findUnique: async ({ where }: any) =>
          where.productId === 200n
            ? { productId: 200n, storeId: 20n, status: 'ACTIVE' }
            : where.productId === 100n
              ? { productId: 100n, storeId: 10n, status: 'ACTIVE' }
              : null,
      },
    };
    const tmplService = new DeviceTemplatesService(mockRepo, {} as any, mockPrisma);
    const sysStaffUser = { userId: '99', role: 'SYSTEM_STAFF', storeId: null };

    // 9a. SYSTEM_STAFF can create, update, and delete a global template (storeId: null)
    const created = await tmplService.create({ name: 'SysStaff Template', category: 'Gas' } as any, sysStaffUser);
    assert.strictEqual(created.storeId, null);
    const updated = await tmplService.update(created.id, { name: 'SysStaff Template v2' } as any, sysStaffUser);
    assert.strictEqual(updated.name, 'SysStaff Template v2');

    // 9b. Global template cannot bind a store-specific SKU
    await assert.rejects(
      () => tmplService.create({ name: 'Invalid SKU', defaultProductId: '200' } as any, sysStaffUser),
      (err: any) => err instanceof BadRequestException,
    );

    // 9c. Button with routing storeId=10 (A) & custodyStoreId=20 (B) REJECTS deploying Store B SKU (200)
    const storeBTemplate = await tmplService.create(
      { name: 'Store B SKU', storeId: '20', defaultProductId: '200' } as any,
      sysStaffUser,
    );
    templates.set(storeBTemplate.id, {
      ...templates.get(storeBTemplate.id),
      defaultProduct: { productId: 200n, storeId: 20n },
    });
    const mismatchDeploy = await tmplService.deploy(
      storeBTemplate.id,
      { deviceId: 'SOB-CUSTODY-B' } as any,
      { userId: '22', role: 'STORE_OWNER', storeId: '20' },
    );
    assert.strictEqual(mismatchDeploy.success, false);
    assert.strictEqual(mismatchDeploy.failed, 1);
    assert.strictEqual(deployedCalls.length, 0);

    // 9d. Button with routing storeId=10 (A) ACCEPTS deploying Store A SKU (100)
    const storeATemplate = await tmplService.create(
      { name: 'Store A SKU', storeId: '10', defaultProductId: '100' } as any,
      sysStaffUser,
    );
    templates.set(storeATemplate.id, {
      ...templates.get(storeATemplate.id),
      defaultProduct: { productId: 100n, storeId: 10n },
    });
    const matchedDeploy = await tmplService.deploy(
      storeATemplate.id,
      { deviceId: 'SOB-CUSTODY-B' } as any,
      sysStaffUser,
    );
    assert.strictEqual(matchedDeploy.success, true);
    assert.strictEqual(deployedCalls.length, 1);

    await tmplService.delete(created.id, sysStaffUser);
    assert.strictEqual(templates.has(created.id), false);

    passed++;
    console.log('  ✔ [PASS] DeviceTemplatesService allows SYSTEM_STAFF CRUD and checks SKU against routing storeId (not custodyStoreId)');
  }

  // 10. RentalsService.listReturnRequests supports global SYSTEM_STAFF listing, strict STORE_OWNER tenant isolation, and rejects CUSTOMER
  {
    const capturedQueries: any[] = [];
    const sampleReturn = {
      returnId: BigInt(501),
      returnCode: 'RET-2026-0501',
      rentalId: BigInt(88),
      buttonId: BigInt(42),
      status: 'PENDING_RECEIPT',
      inspectionNote: null,
      receivedAt: null,
      inspectedAt: null,
      createdAt: new Date('2026-11-20T01:00:00Z'),
      rental: {
        rentalCode: 'RNT-2026-0088',
        status: 'ACTIVE',
        fulfillmentStoreId: BigInt(10),
        depositPerButton: 150000,
        fulfillmentStore: { storeId: BigInt(10), name: 'Cua hang A', code: 'STORE-A' },
        customer: {
          user: { fullName: 'Nguyen Van Khach', phone: '0909123456' },
        },
      },
      button: {
        deviceId: 'SOB-000042',
        buttonCode: 'BTN-000042',
        buttonName: 'Nut Nuoc 20L',
        inventoryState: 'RETURN_IN_TRANSIT',
        custodyStoreId: BigInt(10),
        storeId: BigInt(10),
        custodyStore: { storeId: BigInt(10), name: 'Cua hang A', code: 'STORE-A' },
        store: { storeId: BigInt(10), name: 'Cua hang A', code: 'STORE-A' },
      },
      refunds: [
        {
          refundId: BigInt(77),
          refundCode: 'DEP-2026-0077',
          status: 'PENDING_APPROVAL',
          amount: 150000,
        },
      ],
    };

    const mockRentalRepo: any = {
      findRentalById: async () => null,
      listReturnRequestsPaginated: async (params: any) => {
        capturedQueries.push(params);
        return { items: [sampleReturn], total: 1 };
      },
    };
    const rentalsSvc = new RentalsService(mockRentalRepo);

    // 10a. SYSTEM_STAFF lists globally (storeId undefined) and receives clean DTO
    const staffResult = await rentalsSvc.listReturnRequests(
      { userId: '99', role: 'SYSTEM_STAFF', storeId: null },
      { status: 'PENDING_RECEIPT', search: 'RET', page: 1, pageSize: 12 },
    );
    assert.strictEqual(capturedQueries[0].storeId, undefined);
    assert.strictEqual(capturedQueries[0].status, 'PENDING_RECEIPT');
    assert.strictEqual(staffResult.items.length, 1);
    assert.strictEqual(staffResult.items[0].returnCode, 'RET-2026-0501');
    assert.strictEqual(staffResult.items[0].customName, 'Nut Nuoc 20L');
    assert.strictEqual(staffResult.items[0].depositRefund?.refundAmount, 150000);
    assert.strictEqual(staffResult.items[0].store?.code, 'STORE-A');
    assert.strictEqual(staffResult.pagination.totalItems, 1);

    // 10b. STORE_OWNER is strictly scoped to their own storeId
    await rentalsSvc.listReturnRequests(
      { userId: '22', role: 'STORE_OWNER', storeId: '10' },
      { status: 'ALL', page: 2, pageSize: 20 },
    );
    assert.strictEqual(capturedQueries[1].storeId, BigInt(10));
    assert.strictEqual(capturedQueries[1].skip, 20);
    assert.strictEqual(capturedQueries[1].take, 20);

    // 10c. CUSTOMER is blocked from inspection queue listing
    await assert.rejects(
      () => rentalsSvc.listReturnRequests({ userId: '7', role: 'CUSTOMER', customerProfileId: '5' }, {}),
      (err: any) => err instanceof ForbiddenException,
    );

    passed++;
    console.log('  ✔ [PASS] RentalsService.listReturnRequests enforces global SYSTEM_STAFF access, STORE_OWNER tenant isolation, and clean DTO mapping');
  }

  console.log(`\n🎉 ALL ${passed}/10 STEP-4 VERIFICATION GROUPS PASSED!\n`);
}

run().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
