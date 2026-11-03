/** Offline contract tests only; NOT evidence of PostgreSQL locking/atomicity. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

async function main() {
  const schema = readFileSync(path.join(__dirname, '../prisma/schema.prisma'), 'utf8');
  for (const model of ['StoreCashVoucher', 'StoreCashReceipt', 'BillingPaymentReceipt', 'BillingOverpaymentObligation']) {
    assert.ok(schema.includes(`model ${model} {`), `Missing model: ${model}`);
  }
  const migration = readFileSync(path.join(__dirname, '../prisma/migrations/20261103100000_store_cash_collection_foundations/migration.sql'), 'utf8');
  assert.match(migration, /UNIQUE INDEX "uq_cash_receipt_charge"[^;]+\("charge_id"\)/);
  assert.match(migration, /UNIQUE INDEX "uq_billing_receipt_provider_channel_ref"[^;]+\("provider", "channel", "provider_transaction_ref"\)/);
  assert.match(migration, /UNIQUE INDEX "uq_billing_overpayment_receipt"[^;]+\("receipt_id"\)/);
  assert.match(migration, /UNIQUE INDEX "uq_cash_voucher_active_rental"[^;]+WHERE "status" = 'ACTIVE'/);
  assert.doesNotMatch(migration, /ON DELETE CASCADE|DROP TABLE|DELETE FROM/);
  assert.match(migration, /"receipt_classification" = 'OVERPAYMENT_RECEIPT'/);
  assert.match(migration, /REFERENCES "billing_payment_receipts" \("id", "amount", "classification"\)/);
  const { issueCashVoucherSchema, collectCashSchema, cashResourceIdSchema } = await import('../src/store-cash/dto/store-cash.dto');
  const { createCashVoucherToken, hashCashVoucherToken } = await import('../src/store-cash/cash-voucher-token');
  const issued = createCashVoucherToken();
  assert.match(issued.token, /^[a-f0-9]{64}$/);
  assert.match(issued.tokenHash, /^[a-f0-9]{64}$/);
  assert.notEqual(issued.token, issued.tokenHash);
  assert.equal(hashCashVoucherToken(issued.token), issued.tokenHash);
  assert.notEqual(createCashVoucherToken().token, issued.token);
  for (const invalid of ['', '123456', 'f'.repeat(63), 'f'.repeat(65), 'F'.repeat(64), null, 123]) {
    assert.throws(() => hashCashVoucherToken(invalid as string));
  }
  assert.deepEqual(issueCashVoucherSchema.parse({ chargeId: '1', collectingStoreId: '2' }), { chargeId: '1', collectingStoreId: '2' });
  for (const field of ['amount', 'customerId', 'expiresAt', 'status', 'tokenHash']) {
    assert.equal(issueCashVoucherSchema.safeParse({ chargeId: '1', collectingStoreId: '2', [field]: '1' }).success, false);
  }
  for (const invalid of ['0', '-1', '01', '1e3', '1.0', ' 1 ', '9223372036854775808', 1, null]) {
    assert.equal(cashResourceIdSchema.safeParse(invalid).success, false);
  }
  assert.equal(cashResourceIdSchema.parse('9223372036854775807'), '9223372036854775807');
  assert.equal(collectCashSchema.safeParse({ chargeId: '1', voucherToken: issued.token, handover: 'DEFERRED' }).success, true);
  assert.equal(collectCashSchema.safeParse({ chargeId: '1', voucherToken: issued.token, handover: 'IMMEDIATE', buttonIds: ['2', '3'] }).success, true);
  for (const extra of [
    { handover: 'IMMEDIATE', buttonIds: [] },
    { handover: 'IMMEDIATE', buttonIds: ['2', '2'] },
    { handover: 'IMMEDIATE', buttonIds: ['0'] },
    { handover: 'DEFERRED', buttonIds: ['2'] },
    { handover: 'IMMEDIATE', buttonIds: Array.from({ length: 101 }, (_, i) => String(i + 1)) },
    { handover: 'DEFERRED', amount: 1 },
    { handover: 'DEFERRED', customerId: '999' },
  ]) {
    assert.equal(collectCashSchema.safeParse({ chargeId: '1', voucherToken: issued.token, ...extra }).success, false);
  }
  console.log('PASS: cash schema presence, strict DTO boundaries and QR-token unit contracts (offline only).');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
