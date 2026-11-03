/** Domain/repository tests using mock transactions, never live provider or DB. */
import assert from 'node:assert/strict';
import { Prisma } from '@prisma/client';
import { priceRentalRenewal } from '../src/rentals/rental-renewal.transaction';
import { recordRentalPayosReceiptInTx } from '../src/store-cash/store-cash-settlement.transaction';
import { RentalsRepository } from '../src/rentals/rentals.repository';
import { calculateRentalPricing } from '../src/rentals/rental-pricing';

async function main() {
  for (let renewal = 1; renewal <= 10; renewal++) {
    assert.equal(priceRentalRenewal('30000', 3, 1).amount.toNumber(), 90000);
  }
  assert.equal(priceRentalRenewal('30000', 2, 3).amount.toNumber(), 180000);
  assert.throws(() => priceRentalRenewal(null, 3, 1));
  assert.throws(() => priceRentalRenewal('30000', 0, 1));
  const rental: any = { rental_id: 42n, customer_id: 7n, status: 'EXPIRED', button_quantity: 3,
    monthly_rent_per_button_snapshot: new Prisma.Decimal(30000), pricing_review_required: false,
    paid_through: new Date('2020-01-01'), effective_expires_at: new Date('2020-01-01') };
  const devices: any[] = [
    { button_id: 1n, customer_id: 7n, inventory_state: 'IN_CUSTOMER_CUSTODY', status: 'ACTIVE' },
    { button_id: 2n, customer_id: 7n, inventory_state: 'IN_CUSTOMER_CUSTODY', status: 'INACTIVE' },
    { button_id: 3n, customer_id: 7n, inventory_state: 'RETURN_IN_TRANSIT', status: 'ACTIVE' },
  ];
  const charge: any = { charge_id: 8n, target_id: 42n, target_type: 'RENTAL', purpose: 'RENTAL_EXTENSION',
    status: 'PENDING', currency: 'VND', total_amount: new Prisma.Decimal(60000), payment_link_id: 'fixture-link' };
  const receipt: any = { provider: 'PAYOS', providerTransactionCode: 'fixture-ref', amount: 60000,
    currency: 'VND', verified: true, paymentLinkId: 'fixture-link' };
  let saved: any = null;
  let applied = 0, liabilities = 0;
  const deviceWrites: any[] = [];
  const tx: any = {
    $queryRawUnsafe: async (sql: string) => sql.includes('iot_button') ? devices : [rental],
    rentalReturn: { findMany: async () => [{ buttonId: 3n }] },
    billingChargeLine: { findMany: async () => [{ lineType: 'RENT', quantity: 2, durationCount: 1,
      durationUnit: 'MONTH', amount: new Prisma.Decimal(60000), unitPrice: new Prisma.Decimal(30000) }] },
    billingCharge: { updateMany: async ({ where }: any) => { assert.equal(where.status, 'PENDING'); return { count: 1 }; } },
    buttonRental: { update: async ({ data }: any) => { applied++; assert.equal(data.status, 'ACTIVE'); assert.ok(data.paidThrough > new Date()); } },
    ioTButton: { update: async (data: any) => { deviceWrites.push(data); } },
    outboxEvent: { create: async () => ({ id: 1n }) }, rentalAuditLog: { create: async () => ({ id: 1n }) },
    billingPaymentReceipt: {
      findUnique: async () => saved,
      create: async ({ data }: any) => { saved = { id: 12n, ...data }; return saved; },
    },
    billingOverpaymentObligation: { create: async () => { liabilities++; } },
  };
  const result = await recordRentalPayosReceiptInTx(tx, charge, receipt);
  assert.equal(result.overpayment, false);
  assert.equal(applied, 1);
  assert.equal(deviceWrites.length, 2);
  assert.deepEqual(deviceWrites.map(w => [w.where.buttonId, w.data.canOrder]), [[1n, true], [2n, false]]);
  await recordRentalPayosReceiptInTx(tx, charge, receipt);
  assert.equal(applied, 1, 'Replay must not apply another term');
  saved = null;
  rental.status = 'RETURNED';
  const cancelled = await recordRentalPayosReceiptInTx(tx, charge, { ...receipt, providerTransactionCode: 'fixture-late-ref' });
  assert.equal(cancelled.overpayment, true);
  assert.equal(liabilities, 1);
  assert.equal(applied, 1, 'No resurrection of a returned rental');
  await recordRentalPayosReceiptInTx(tx, charge, { ...receipt, providerTransactionCode: 'fixture-late-ref' });
  assert.equal(liabilities, 1, 'Unapplied receipt replay must not duplicate liability');
  const quoteRental: any = { ...rental, status: 'ACTIVE', months_rented: 3 };
  let quoteData: any;
  const quoteTx: any = { ...tx,
    $queryRawUnsafe: async (sql: string) => sql.includes('iot_button') ? devices.slice(0, 2) : [quoteRental],
    rentalReturn: { findMany: async () => [] },
    customerProfile: { findUnique: async () => ({ userId: 99n }) },
    billingCharge: { create: async ({ data }: any) => { quoteData = data; return { chargeId: 99n, ...data }; } },
  };
  const quoteRepo = new RentalsRepository({ $transaction: async (fn: any) => fn(quoteTx) } as any);
  for (let i = 0; i < 10; i++) {
    await quoteRepo.createRentalExtensionCharge(42n, 1, 99n);
    assert.equal(quoteData.totalAmount.toNumber(), 60000);
    assert.equal(quoteData.lines.create[0].quantity, 2);
    quoteRental.months_rented++;
  }
  quoteRental.status = 'RETURNED';
  await assert.rejects(() => quoteRepo.createRentalExtensionCharge(42n, 1, 99n));
  quoteRental.status = 'ACTIVE'; quoteRental.monthly_rent_per_button_snapshot = null;
  await assert.rejects(() => quoteRepo.createRentalExtensionCharge(42n, 1, 99n), /RECONCILIATION_REQUIRED/);
  let createdRental: any, createdInitial: any;
  const initialRepo = new RentalsRepository({ $transaction: async (fn: any) => fn({
    buttonRental: { create: async ({ data }: any) => { createdRental = data; return { rentalId: 44n, ...data }; } },
    billingCharge: { create: async ({ data }: any) => { createdInitial = data; return data; } },
  }) } as any);
  await initialRepo.createRental({ rentalCode: 'fixture', customerId: 7n, packageId: 1n, buttonQuantity: 3,
    monthsRented: 3, startDate: new Date(), endDate: new Date(), status: 'PENDING_PAYMENT',
    pricing: calculateRentalPricing({ buttonQuantity: 3, months: 3, monthlyPackagePrice: 90000, packageDepositFee: 600000 }) });
  assert.equal(createdRental.monthlyRentPerButtonSnapshot.toNumber(), 30000);
  assert.equal(createdRental.pricingReviewRequired, false);
  assert.equal(createdInitial.totalAmount.toNumber(), 870000);
  assert.equal(createdInitial.lines.create[0].amount.toNumber(), 270000);
  assert.equal(createdInitial.lines.create[1].amount.toNumber(), 600000);
  console.log('PASS renewal snapshot stability, partial quantity, manual lock preservation, terminal-state money and replay (offline).');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
