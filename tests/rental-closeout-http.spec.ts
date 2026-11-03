/** Nest HTTP pipeline against compiled source, synthetic DB/auth fixtures only.
 * Run npm run build first. This is not JWT/provider/PostgreSQL acceptance.
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { Module, UnauthorizedException } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Prisma } from '@prisma/client';

async function main() {
  const { StoreCashReceiptsController } = require('../dist/src/store-cash/store-cash.controller');
  const { StoreCashService } = require('../dist/src/store-cash/store-cash.service');
  const { StoreCashRepository } = require('../dist/src/store-cash/store-cash.repository');
  const { JwtAuthGuard } = require('../dist/src/common/guards/jwt-auth.guard');
  const { IdempotencyService } = require('../dist/src/common/idempotency/idempotency.service');
  const { AllExceptionsFilter } = require('../dist/src/common/filters/http-exception.filter');
  const oldFlag = process.env.STORE_CASH_COLLECTION_ENABLED;
  const originalGuard = JwtAuthGuard.prototype.canActivate;
  JwtAuthGuard.prototype.canActivate = (ctx: any) => {
    const req = ctx.switchToHttp().getRequest();
    const actor = req.headers['x-fixture-actor'];
    if (!actor) throw new UnauthorizedException();
    req.user = actor === 'customer' ? { userId: '7', role: 'CUSTOMER' }
      : actor === 'other-store' ? { userId: '99', storeId: '99', role: 'STORE_OWNER' }
      : { userId: '10', storeId: '5', role: 'STORE_OWNER' };
    return true;
  };
  const fixtures = {
    $queryRawUnsafe: async (sql: string) => sql.includes('store_staff') ? [] : [{ owner_user_id: 10n }],
    buttonRental: { findUnique: async ({ where }: any) => ({ rentalId: where.rentalId, customerId: 7n,
      fulfillmentStoreId: where.rentalId === 43n ? 99n : 5n,
      buttonQuantity: 3, depositAmount: new Prisma.Decimal(600000), totalRentAmount: new Prisma.Decimal(690000),
      status: where.rentalId === 44n ? 'PENDING_PAYMENT' : 'PENDING_HANDOVER' }) },
    storeCashVoucher: { findFirst: async () => null },
    ioTButton: {
      findMany: async () => [{ buttonId: 1n, deviceId: 'fixture', buttonCode: 'fixture', inventoryState: 'ASSIGNED_TO_RENTAL' }],
      count: async ({ where }: any) => where.NOT ? 0 : 3,
    },
    storeCashReceipt: { findUnique: async () => ({ id: 1n, chargeId: 2n, voucherId: 3n,
      collectingStoreId: 5n, amount: new Prisma.Decimal(690000), createdAt: new Date(),
      bankAccountEncrypted: 'INTERNAL_CIPHERTEXT_SENTINEL', bankAccountHash: 'INTERNAL_HASH_SENTINEL' }) },
  };
  const service = new StoreCashService(new StoreCashRepository(fixtures));
  const idempotency = { acquire: async () => ({ state: 'ACQUIRED', recordId: 1n, lockToken: 'fixture' }),
    finalizeSuccess: async () => {}, finalizeFailure: async () => {} };
  class HttpFixtureModule {}
  Module({ controllers: [StoreCashReceiptsController], providers: [
    { provide: StoreCashService, useValue: service }, { provide: IdempotencyService, useValue: idempotency },
  ] })(HttpFixtureModule);
  const app = await NestFactory.create(HttpFixtureModule, { logger: false });
  app.setGlobalPrefix('api/v1');
  app.useGlobalFilters(new AllExceptionsFilter());
  try {
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    const call = (url: string, actor?: string, body?: unknown, key?: string) => fetch(base + '/api/v1' + url, {
      method: body === undefined ? 'GET' : 'POST', headers: {
        ...(actor ? { 'x-fixture-actor': actor } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(key ? { 'idempotency-key': key } : {}),
      }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    process.env.STORE_CASH_COLLECTION_ENABLED = 'true';
    assert.equal((await call('/stores/5/rentals/42/handover-preview')).status, 401);
    assert.equal((await call('/stores/5/rentals/42/handover-preview', 'customer')).status, 403);
    assert.equal((await call('/stores/5/rentals/42/handover-preview', 'other-store')).status, 403);
    assert.equal((await call('/stores/5/rentals/43/handover-preview', 'owner')).status, 404);
    assert.equal((await call('/stores/5/rentals/0/handover-preview', 'owner')).status, 400);
    assert.equal((await call('/stores/5/rentals/42/handover-preview?page=' + '9'.repeat(200), 'owner')).status, 400);
    const page = await call('/stores/5/rentals/42/handover-preview?pageSize=1', 'owner');
    assert.equal(page.status, 200);
    const data: any = await page.json();
    assert.equal(data.data.availableStoreButtons.length, 1);
    assert.equal(data.data.totalEligibleButtons, 3);
    assert.equal(data.data.canFulfillImmediately, true, 'Eligibility must not depend on page length');
    delete process.env.STORE_CASH_COLLECTION_ENABLED;
    assert.equal((await call('/stores/5/rentals/42/handover-preview', 'owner')).status, 200);
    assert.equal((await call('/stores/5/rentals/44/handover-preview', 'owner')).status, 503);
    const receipt = await call('/stores/5/cash-receipts/1', 'owner');
    assert.equal(receipt.status, 200, 'Disabling intake must not hide existing receipts');
    assert.doesNotMatch(await receipt.text(), /INTERNAL_|Encrypted|Hash/);
    const body = { rentalId: '42', chargeId: '2', voucherToken: 'a'.repeat(64), handover: 'DEFERRED' };
    assert.equal((await call('/stores/5/cash-receipts', 'owner', body)).status, 400, 'Idempotency header required');
    assert.equal((await call('/stores/5/cash-receipts', 'owner', { ...body, amount: 1 }, 'fixture')).status, 400);
    assert.equal((await call('/stores/5/cash-receipts', 'owner', body, 'fixture')).status, 503);
    console.log('PASS Nest HTTP: role/scope, 400/401/403/404/503, assigned-device preview, pagination, no intake coupling, receipt mapping and required idempotency header. Auth/DB are fixtures.');
  } finally {
    await app.close();
    JwtAuthGuard.prototype.canActivate = originalGuard;
    if (oldFlag === undefined) delete process.env.STORE_CASH_COLLECTION_ENABLED;
    else process.env.STORE_CASH_COLLECTION_ENABLED = oldFlag;
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
