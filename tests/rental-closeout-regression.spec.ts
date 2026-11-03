/** Offline regressions; PostgreSQL acceptance is a separate suite. */
import assert from 'node:assert/strict';
import { RentalResponseDto } from '../src/rentals/dto/rental-response.dto';
import { StoreCashService } from '../src/store-cash/store-cash.service';
import { DashboardCacheService } from '../src/common/cache/dashboard-cache.service';
import { BillingChargesService } from '../src/billing-charges/billing-charges.service';
import { RentalsService } from '../src/rentals/rentals.service';
import { RentalExpiryCronService } from '../src/rentals/rental-expiry-cron.service';
import { toRentalRefundOperationDto } from '../src/rentals/dto/rental-refund-response.dto';
import { DevicesRepository } from '../src/devices/devices.repository';

async function main() {
  let failed = 0;
  async function check(name: string, fn: () => Promise<void> | void) {
    try { await fn(); console.log(`PASS ${name}`); }
    catch (error) { failed++; console.error(`FAIL ${name}:`, (error as Error).message); }
  }
  await check('unpaid DTO has no entitlement or paid-through fallback', () => {
    const result = RentalResponseDto.fromEntity({ rentalId: 42n, rentalCode: 'fixture', customerId: 7n,
      packageId: 1n, status: 'PENDING_PAYMENT', effectiveExpiresAt: null, paidThrough: null,
      endDate: new Date(Date.now() + 86400000) });
    assert.equal(result.canOrder, false);
    assert.equal(result.paidThrough, null);
    assert.equal(result.effectiveExpiresAt, null);
  });
  await check('customer 7 mutation preserves customer 77 cache', async () => {
    const cache = new DashboardCacheService();
    await cache.set('customer:dashboard:7', 'old', 60);
    await cache.set('customer:dashboard:77', 'unrelated', 60);
    const service = new StoreCashService({ collect: async () => ({ idempotent: false,
      receipt: { id: 1n, chargeId: 2n, voucherId: 3n, collectingStoreId: 5n, amount: 230000 },
      context: { customerUserId: '7', collectingStoreId: '5' } }) } as any, cache);
    await service.collectCash('5', '42', { chargeId: '2', voucherToken: 'a'.repeat(64), handover: 'DEFERRED' }, { userId: '10' });
    assert.equal(await cache.get('customer:dashboard:7'), null);
    assert.equal(await cache.get('customer:dashboard:77'), 'unrelated');
    await cache.onModuleDestroy();
  });
  await check('cash intake disabled does not swallow a verified late receipt', async () => {
    const before = process.env.STORE_CASH_COLLECTION_ENABLED;
    delete process.env.STORE_CASH_COLLECTION_ENABLED;
    try {
      let writes = 0;
      const service = new BillingChargesService({ findChargeById: async () => ({ chargeId: 2n,
        status: 'PAID', purpose: 'RENTAL_INITIAL', paymentMethod: 'STORE_CASH_OFFSET' }),
        settleChargeAtomicTx: async () => { writes++; return { alreadySettled: true }; },
      } as any);
      await service.settleCharge(2n, { verified: true });
      assert.equal(writes, 1);
    } finally {
      if (before === undefined) delete process.env.STORE_CASH_COLLECTION_ENABLED;
      else process.env.STORE_CASH_COLLECTION_ENABLED = before;
    }
  });
  await check('returned rental cannot create a renewal charge', async () => {
    let writes = 0;
    const service = new RentalsService({ findRentalById: async () => ({ rentalId: 42n, customerId: 7n,
      customer: { userId: 99n }, status: 'RETURNED', package: { monthlyPrice: 240000 } }),
      createRentalExtensionCharge: async () => { writes++; return { chargeId: 3n }; },
    } as any);
    await assert.rejects(() => service.extendRentalContract('42', { additionalMonths: 1 }, { userId: '99', customerProfileId: '7' }));
    assert.equal(writes, 0);
  });
  await check('expiry does not overwrite operational/manual device status', async () => {
    const sqlWrites: string[] = [];
    const tx: any = { $queryRawUnsafe: async () => [{ rental_id: 42n, rental_code: 'fixture', customer_id: 7n,
      effective_expires_at: new Date(), status: 'ACTIVE' }],
      $executeRawUnsafe: async (sql: string) => { sqlWrites.push(sql); return 1; },
      outboxEvent: { create: async () => ({ id: 1n }) },
    };
    await new RentalExpiryCronService({ $transaction: async (fn: any) => fn(tx) } as any).processExpiredRentals(1);
    const buttonUpdate = sqlWrites.find(sql => sql.includes('UPDATE iot_button'));
    assert.ok(buttonUpdate);
    assert.doesNotMatch(buttonUpdate, /status\s*=\s*'INACTIVE'/);
    assert.match(buttonUpdate, /can_order\s*=\s*false/);
  });
  await check('refund replay mapping never leaks financial snapshots', () => {
    const mapped = toRentalRefundOperationDto({ alreadyConfirmed: true, refund: {
      refund_id: 1n, status: 'REFUNDED', amount: 200000,
      recipient_account_number_encrypted: 'CIPHERTEXT_SENTINEL', recipient_account_number_hash: 'HASH_SENTINEL',
      recipient_account_number_masked: '******0000', bankAccount: { accountNumberEncrypted: 'CIPHERTEXT_SENTINEL' },
    } });
    assert.doesNotMatch(JSON.stringify(mapped), /SENTINEL|encrypted|bankAccount|account_number_hash/);
    assert.equal(mapped.refund?.recipientAccountMasked, '******0000');
  });
  await check('explicit manual enable cannot bypass expired rental entitlement', async () => {
    let status = 'EXPIRED';
    let written: any;
    const tx: any = { $queryRawUnsafe: async (sql: string) => sql.includes('iot_button')
      ? [{ rental_id: 42n, customer_id: 7n, inventory_state: 'IN_CUSTOMER_CUSTODY' }]
      : [{ status, customer_id: 7n, effective_expires_at: new Date(Date.now() + 86400000) }],
      rentalReturn: { count: async () => 0 },
      ioTButton: { update: async ({ data }: any) => { written = data; return data; } } };
    const repo = new DevicesRepository({ $transaction: async (fn: any) => fn(tx) } as any);
    await repo.update(1n, { status: 'ACTIVE' }); assert.equal(written.canOrder, false);
    status = 'ACTIVE'; await repo.update(1n, { status: 'ACTIVE' }); assert.equal(written.canOrder, true);
  });
  if (failed) throw new Error(`${failed} closeout regressions failed`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
