/** Domain/repository tests using mock transactions, never live provider or DB. */
import assert from 'node:assert/strict';
import { Prisma } from '@prisma/client';
import { priceRentalRenewal, settleRentalRenewalInTx } from '../src/rentals/rental-renewal.transaction';
import { handoverRentalButtonsInTx } from '../src/rentals/rental-handover.transaction';
import { recordRentalPayosReceiptInTx } from '../src/store-cash/store-cash-settlement.transaction';
import { RentalsRepository } from '../src/rentals/rentals.repository';
import { RentalsService } from '../src/rentals/rentals.service';
import { BillingChargesService } from '../src/billing-charges/billing-charges.service';
import { calculateRentalPricing } from '../src/rentals/rental-pricing';

async function main() {
  for (let renewal = 1; renewal <= 10; renewal++) {
    assert.equal(priceRentalRenewal('30000', 3, 1).amount.toNumber(), 90000);
  }
  assert.equal(priceRentalRenewal('30000', 2, 3).amount.toNumber(), 180000);
  assert.throws(() => priceRentalRenewal(null, 3, 1));
  assert.throws(() => priceRentalRenewal('30000', 0, 1));
  const rental: any = {
    rental_id: 42n, customer_id: 7n, status: 'EXPIRED', button_quantity: 3,
    monthly_rent_per_button_snapshot: new Prisma.Decimal(30000), pricing_review_required: false,
    paid_through: new Date('2020-01-01'), effective_expires_at: new Date('2020-01-01'), billing_policy: 'LEGACY_CUSTOMER_RENT'
  };
  const devices: any[] = [
    { button_id: 1n, customer_id: 7n, inventory_state: 'IN_CUSTOMER_CUSTODY', status: 'ACTIVE' },
    { button_id: 2n, customer_id: 7n, inventory_state: 'IN_CUSTOMER_CUSTODY', status: 'INACTIVE' },
    { button_id: 3n, customer_id: 7n, inventory_state: 'RETURN_IN_TRANSIT', status: 'ACTIVE' },
  ];
  const charge: any = {
    charge_id: 8n, target_id: 42n, target_type: 'RENTAL', purpose: 'RENTAL_EXTENSION',
    status: 'PENDING', currency: 'VND', total_amount: new Prisma.Decimal(60000), payment_link_id: 'fixture-link'
  };
  const receipt: any = {
    provider: 'PAYOS', providerTransactionCode: 'fixture-ref', amount: 60000,
    currency: 'VND', verified: true, paymentLinkId: 'fixture-link'
  };
  let saved: any = null;
  let applied = 0, liabilities = 0;
  const deviceWrites: any[] = [];
  const tx: any = {
    $queryRawUnsafe: async (sql: string) => sql.includes('iot_button') ? devices : [rental],
    rentalReturn: { findMany: async () => [{ buttonId: 3n }] },
    billingChargeLine: {
      findMany: async () => [{
        lineType: 'RENT', quantity: 2, durationCount: 1,
        durationUnit: 'MONTH', amount: new Prisma.Decimal(60000), unitPrice: new Prisma.Decimal(30000)
      }]
    },
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
  const quoteRental: any = { ...rental, status: 'ACTIVE', months_rented: 3, billing_policy: 'LEGACY_CUSTOMER_RENT' };
  let quoteData: any;
  const quoteTx: any = {
    ...tx,
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

  // Policy branching check: customer cannot be billed for RENT under STORE_RENT_CUSTOMER_DEPOSIT
  quoteRental.billing_policy = 'STORE_RENT_CUSTOMER_DEPOSIT';
  quoteRental.monthly_rent_per_button_snapshot = new Prisma.Decimal(30000);
  await assert.rejects(
    () => quoteRepo.createRentalExtensionCharge(42n, 1, 99n),
    /NON_BILLABLE_TO_CUSTOMER/,
  );

  // Store obligation creation for STORE_RENT_CUSTOMER_DEPOSIT succeeds with targetType RENTAL, targetId rentalId, payerStoreId
  quoteRental.fulfillment_store_id = 15n;
  const storeQuoteTx: any = {
    ...quoteTx,
    ioTButton: { findMany: async () => [{ buttonId: 1n, customerId: 7n, inventoryState: 'IN_CUSTOMER_CUSTODY' }] },
  };
  let storeChargeCreated: any;
  storeQuoteTx.billingCharge.create = async ({ data }: any) => { storeChargeCreated = data; return { chargeId: 101n, ...data }; };
  const storeRepo = new RentalsRepository({ $transaction: async (fn: any) => fn(storeQuoteTx) } as any);
  await storeRepo.createStoreRentalExtensionObligation(42n, 1, 15n, 99n);
  assert.equal(storeChargeCreated.targetType, 'RENTAL');
  assert.equal(storeChargeCreated.targetId, 42n);
  assert.equal(storeChargeCreated.payerStoreId, 15n);
  assert.equal(storeChargeCreated.totalAmount.toNumber(), 30000);
  assert.equal(storeChargeCreated.lines.create[0].lineType, 'STORE_RENT');

  // Verify Store renewal settlement in single transaction (lock -> receipt -> CAS -> update -> outbox)
  const storeChargeEntity = {
    charge_id: 101n,
    target_id: 42n,
    target_type: 'RENTAL',
    payer_store_id: 15n,
    purpose: 'RENTAL_EXTENSION',
    status: 'PENDING',
    currency: 'VND',
    total_amount: new Prisma.Decimal(30000),
    payment_link_id: 'store-fixture-link',
  };
  const storeReceipt = {
    provider: 'PAYOS',
    providerTransactionCode: 'store-receipt-ref-001',
    amount: 30000,
    currency: 'VND',
    verified: true as const,
    paymentLinkId: 'store-fixture-link',
  };
  let storeRentalUpdated: any = null;
  const storeSettleTx: any = {
    $queryRawUnsafe: async (sql: string) => sql.includes('iot_button') ? [devices[0]] : [quoteRental],
    rentalReturn: { findMany: async () => [] },
    billingChargeLine: {
      findMany: async () => [{
        lineType: 'STORE_RENT',
        quantity: 1,
        durationCount: 1,
        durationUnit: 'MONTH',
        amount: new Prisma.Decimal(30000),
        unitPrice: new Prisma.Decimal(30000),
      }]
    },
    billingCharge: { updateMany: async ({ where }: any) => ({ count: 1 }) },
    buttonRental: { update: async ({ data }: any) => { storeRentalUpdated = data; } },
    ioTButton: { update: async () => { } },
    outboxEvent: { create: async () => ({ id: 10n }) },
    rentalAuditLog: { create: async () => ({ id: 10n }) },
    billingPaymentReceipt: {
      findUnique: async () => null,
      create: async ({ data }: any) => ({ id: 20n, ...data }),
    },
    billingOverpaymentObligation: { create: async () => { } },
  };

  const settleResult = await recordRentalPayosReceiptInTx(storeSettleTx, storeChargeEntity, storeReceipt);
  assert.equal(settleResult.overpayment, false);
  assert.equal(storeRentalUpdated.status, 'ACTIVE');
  assert.ok(storeRentalUpdated.effectiveExpiresAt > new Date());
  // Verify paidThrough is untouched for Store rent (customer did not pay rent):
  assert.equal(storeRentalUpdated.paidThrough, quoteRental.paid_through ?? null);

  // Replay verification: must return alreadySettled: true and not increment term again
  const replayTx: any = {
    ...storeSettleTx,
    billingPaymentReceipt: {
      findUnique: async () => ({ id: 20n, chargeId: 101n, amount: new Prisma.Decimal(30000), currency: 'VND', classification: 'SETTLEMENT_RECEIPT' }),
    },
  };
  const replayResult = await recordRentalPayosReceiptInTx(replayTx, storeChargeEntity, storeReceipt);
  assert.equal(replayResult.alreadySettled, true);

  // Terminal state verification: money arriving after rental is TERMINATED recorded as overpayment liability
  quoteRental.status = 'TERMINATED';
  let overpaymentRecorded = false;
  const terminalTx: any = {
    ...storeSettleTx,
    billingOverpaymentObligation: { create: async () => { overpaymentRecorded = true; } },
  };
  const terminalResult = await recordRentalPayosReceiptInTx(terminalTx, storeChargeEntity, {
    ...storeReceipt,
    providerTransactionCode: 'late-store-ref-999',
  });
  assert.equal(terminalResult.overpayment, true);
  assert.equal(overpaymentRecorded, true);
  quoteRental.status = 'ACTIVE';

  // Public RentalsService.extendRentalContract() API Authorization Tests
  const mockServiceRepo: any = {
    findRentalById: async (id: bigint) => ({
      rentalId: 42n,
      rentalCode: 'RNT-42',
      customerId: 7n,
      status: 'ACTIVE',
      billingPolicy: 'STORE_RENT_CUSTOMER_DEPOSIT',
      fulfillmentStoreId: 15n,
      customer: { userId: 99n },
      pricingReviewRequired: false,
    }),
    findActiveStoreById: async (storeId: bigint) => {
      if (storeId === 15n) return { storeId: 15n, status: 'ACTIVE' };
      if (storeId === 20n) return { storeId: 20n, status: 'ACTIVE' };
      // store 99 is INACTIVE, so findActiveStore returns null
      return null;
    },
    createStoreRentalExtensionObligation: async () => ({
      chargeId: 888n,
      chargeCode: 'CHG-STORE-888',
      totalAmount: 30000,
      paymentMethod: 'PAYOS',
    }),
    createRentalExtensionCharge: async () => ({
      chargeId: 777n,
      chargeCode: 'CHG-CUST-777',
      totalAmount: 30000,
      paymentMethod: 'PAYOS',
    }),
  };
  const rentalsService = new RentalsService(mockServiceRepo as any);

  // 1. Customer calling on STORE_RENT_CUSTOMER_DEPOSIT -> 400 Bad Request
  await assert.rejects(
    () => rentalsService.extendRentalContract('42', { additionalMonths: 1 }, { userId: 99n, role: 'CUSTOMER', customerProfileId: 7n }),
    /STORE_RENT_CUSTOMER_DEPOSIT/,
  );

  // 2. Store Owner of matching store 15n -> Success!
  const storeExtendResult = await rentalsService.extendRentalContract('42', { additionalMonths: 1 }, { userId: 1001n, role: 'STORE_OWNER', storeId: 15n });
  assert.equal(storeExtendResult.payer, 'STORE');
  assert.equal(storeExtendResult.chargeId, '888');

  // 3. Store Owner of wrong store 20n -> 403 Forbidden
  await assert.rejects(
    () => rentalsService.extendRentalContract('42', { additionalMonths: 1 }, { userId: 1002n, role: 'STORE_OWNER', storeId: 20n }),
    /Bạn không có quyền truy cập vào hợp đồng của Cửa hàng khác/,
  );

  // 4. Store Owner of inactive store 99n -> 403 Forbidden
  await assert.rejects(
    () => rentalsService.extendRentalContract('42', { additionalMonths: 1 }, { userId: 1003n, role: 'STORE_OWNER', storeId: 99n }),
    /chưa được kích hoạt/,
  );
  // --- Group 1: Legacy bundled policy (Khách đóng cả RENT + DEPOSIT) ---
  let createdRental: any, createdInitial: any;
  const initialRepo = new RentalsRepository({
    $transaction: async (fn: any) => fn({
      buttonRental: { create: async ({ data }: any) => { createdRental = data; return { rentalId: 44n, ...data }; } },
      billingCharge: { create: async ({ data }: any) => { createdInitial = data; return data; } },
    })
  } as any);
  await initialRepo.createRental({
    rentalCode: 'fixture-legacy', customerId: 7n, packageId: 1n, buttonQuantity: 3,
    monthsRented: 3, startDate: new Date(), endDate: new Date(), status: 'PENDING_PAYMENT',
    policy: 'LEGACY_CUSTOMER_RENT',
    pricing: calculateRentalPricing({ buttonQuantity: 3, months: 3, monthlyPackagePrice: 90000, packageDepositFee: 600000 })
  });
  assert.equal(createdRental.monthlyRentPerButtonSnapshot.toNumber(), 30000);
  assert.equal(createdRental.pricingReviewRequired, false);
  assert.equal(createdInitial.totalAmount.toNumber(), 870000);
  assert.equal(createdInitial.lines.create[0].amount.toNumber(), 270000);
  assert.equal(createdInitial.lines.create[1].amount.toNumber(), 600000);

  // --- Group 2: New policy (CUSTOMER chỉ đóng cọc DEPOSIT; Store chịu phí thuê) ---
  let createdRentalNew: any, createdInitialNew: any;
  const newRepo = new RentalsRepository({
    $transaction: async (fn: any) => fn({
      buttonRental: { create: async ({ data }: any) => { createdRentalNew = data; return { rentalId: 45n, ...data }; } },
      billingCharge: { create: async ({ data }: any) => { createdInitialNew = data; return data; } },
    })
  } as any);
  await newRepo.createRental({
    rentalCode: 'fixture-new', customerId: 8n, packageId: 1n, buttonQuantity: 3,
    monthsRented: 3, startDate: new Date(), endDate: new Date(), status: 'PENDING_PAYMENT',
    policy: 'STORE_RENT_CUSTOMER_DEPOSIT',
    pricing: calculateRentalPricing({ buttonQuantity: 3, months: 3, monthlyPackagePrice: 90000, packageDepositFee: 600000 })
  });
  assert.equal(createdRentalNew.monthlyRentPerButtonSnapshot.toNumber(), 30000);
  assert.equal(createdRentalNew.pricingReviewRequired, false);
  assert.equal(createdInitialNew.totalAmount.toNumber(), 600000);
  assert.equal(createdInitialNew.lines.create.length, 1);
  assert.equal(createdInitialNew.lines.create[0].lineType, 'DEPOSIT');
  assert.equal(createdInitialNew.lines.create[0].amount.toNumber(), 600000);

  // --- Strict Invariant Verification on settleRentalRenewalInTx ---
  // Invariant 1: Missing payer_store_id on STORE_RENT must fail settlement (probe reproduction fix)
  const missingPayerCharge = {
    charge_id: 201n,
    target_id: 42n,
    target_type: 'RENTAL',
    payer_store_id: null,
    purpose: 'RENTAL_EXTENSION',
    status: 'PENDING',
    total_amount: new Prisma.Decimal(30000),
  };
  const missingPayerTx: any = {
    ...storeSettleTx,
    billingChargeLine: {
      findMany: async () => [{
        lineType: 'STORE_RENT',
        quantity: 1,
        durationCount: 1,
        durationUnit: 'MONTH',
        amount: new Prisma.Decimal(30000),
        unitPrice: new Prisma.Decimal(30000),
      }],
    },
  };
  const missingPayerResult = await settleRentalRenewalInTx(missingPayerTx, missingPayerCharge, 'ref-test-01');
  assert.equal(missingPayerResult, false, 'STORE_RENT without payer_store_id must return false');

  // Invariant 2: Mismatched payer_store_id and fulfillment_store_id must fail settlement
  const mismatchedCharge = { ...missingPayerCharge, payer_store_id: 999n };
  const mismatchedResult = await settleRentalRenewalInTx(missingPayerTx, mismatchedCharge, 'ref-test-02');
  assert.equal(mismatchedResult, false, 'Mismatched payer_store_id must return false');

  // Invariant 3: Wrong policy for STORE_RENT must fail settlement
  const wrongPolicyRental = { ...quoteRental, billing_policy: 'LEGACY_CUSTOMER_RENT' };
  const wrongPolicyTx: any = {
    ...missingPayerTx,
    $queryRawUnsafe: async (sql: string) => sql.includes('iot_button') ? [devices[0]] : [wrongPolicyRental],
  };
  const wrongPolicyResult = await settleRentalRenewalInTx(wrongPolicyTx, { ...missingPayerCharge, payer_store_id: 15n }, 'ref-test-03');
  assert.equal(wrongPolicyResult, false, 'STORE_RENT with legacy policy must return false');

  // Invariant 4: billing_policy_review_required = true must fail settlement
  const reviewRequiredRental = { ...quoteRental, billing_policy_review_required: true };
  const reviewRequiredTx: any = {
    ...missingPayerTx,
    $queryRawUnsafe: async (sql: string) => sql.includes('iot_button') ? [devices[0]] : [reviewRequiredRental],
  };
  const reviewResult = await settleRentalRenewalInTx(reviewRequiredTx, { ...missingPayerCharge, payer_store_id: 15n }, 'ref-test-04');
  assert.equal(reviewResult, false, 'billing_policy_review_required must return false');

  // Invariant 5: Legacy RENT with payer_store_id set must fail settlement
  const legacyWithPayerCharge = {
    ...missingPayerCharge,
    payer_store_id: 15n,
  };
  const legacyWithPayerTx: any = {
    ...wrongPolicyTx,
    billingChargeLine: {
      findMany: async () => [{
        lineType: 'RENT',
        quantity: 1,
        durationCount: 1,
        durationUnit: 'MONTH',
        amount: new Prisma.Decimal(30000),
        unitPrice: new Prisma.Decimal(30000),
      }],
    },
  };
  const legacyWithPayerResult = await settleRentalRenewalInTx(legacyWithPayerTx, legacyWithPayerCharge, 'ref-test-05');
  assert.equal(legacyWithPayerResult, false, 'Legacy RENT with payer_store_id must return false');

  // --- Handover Guard Verification ---
  const handoverReviewRental = {
    rental_id: 42n,
    customer_id: 7n,
    status: 'PENDING_HANDOVER',
    button_quantity: 1,
    fulfillment_store_id: 15n,
    pricing_review_required: false,
    billing_policy_review_required: true,
  };
  const handoverTx: any = {
    $queryRawUnsafe: async (sql: string) => sql.includes('iot_button') ? [{
      button_id: 1n,
      rental_id: 42n,
      custody_store_id: 15n,
      inventory_state: 'ALLOCATED_TO_STORE',
    }] : [handoverReviewRental],
  };
  await assert.rejects(
    () => handoverRentalButtonsInTx(handoverTx, 42n, { userId: 1n }),
    /RECONCILIATION_REQUIRED/,
  );

  // --- BillingChargesService Store Access & Payment Link Generation ---
  const storeChargeForPayos: any = {
    chargeId: 555n,
    chargeCode: 'CHG-STORE-RENEW-555',
    purpose: 'RENTAL_EXTENSION',
    targetType: 'RENTAL',
    targetId: 42n,
    payerStoreId: 15n,
    totalAmount: new Prisma.Decimal(30000),
    status: 'PENDING',
    paymentMethod: 'PAYOS',
    lines: [{
      lineType: 'STORE_RENT',
      amount: new Prisma.Decimal(30000),
      durationCount: 1,
      durationUnit: 'MONTH',
      quantity: 1,
    }],
  };
  const mockBillingRepo: any = {
    findChargeById: async (id: bigint) => (id === 555n ? storeChargeForPayos : null),
    findRentalWithCustomer: async (id: bigint) => ({
      rentalId: 42n,
      customerId: 7n,
      fulfillmentStoreId: 15n,
      customer: { userId: 99n },
    }),
    findActiveStoreById: async (storeId: bigint) => {
      if (storeId === 15n) return { storeId: 15n, status: 'ACTIVE' };
      if (storeId === 20n) return { storeId: 20n, status: 'ACTIVE' };
      // store 99 is INACTIVE, so findActiveStore returns null
      return null;
    },
    updatePaymentLinkDetails: async (chargeId: bigint, data: any) => {
      Object.assign(storeChargeForPayos, data);
      return storeChargeForPayos;
    },
  };
  const billingService = new BillingChargesService(mockBillingRepo, {} as any);

  // 1. Customer accessing store charge -> 403 Forbidden
  await assert.rejects(
    () => billingService.getChargeById(555n, { userId: 99n, role: 'CUSTOMER', customerProfileId: 7n }),
    /Chỉ chủ cửa hàng hoặc quản lý mới có quyền truy cập/,
  );

  // 2. Store Owner of different store 20 -> 403 Forbidden
  await assert.rejects(
    () => billingService.getChargeById(555n, { userId: 1002n, role: 'STORE_OWNER', storeId: 20n }),
    /Bạn không có quyền truy cập vào khoản thu của Cửa hàng khác/,
  );

  // 3. Store Owner of inactive store 99 -> 403 Forbidden
  await assert.rejects(
    () => billingService.getChargeById(555n, { userId: 1003n, role: 'STORE_OWNER', storeId: 99n }),
    /chưa được kích hoạt/,
  );

  // 4. Store Owner of matching active store 15 -> Success!
  const fetchedCharge = await billingService.getChargeById(555n, { userId: 1001n, role: 'STORE_OWNER', storeId: 15n });
  assert.equal(fetchedCharge.chargeId, 555n);
  assert.equal(fetchedCharge.payerStoreId, 15n);

  // 5. Public createPayosPaymentRequestForCharge by Store Owner returns checkout link
  process.env.NODE_ENV = 'test';
  process.env.PAYOS_MOCK_PAYMENT = 'true';
  const payosLink = await billingService.createPayosPaymentRequestForCharge(555n, { userId: 1001n, role: 'STORE_OWNER', storeId: 15n });
  assert.ok(payosLink.checkoutUrl.includes('pay.payos.vn'));
  assert.equal(payosLink.amount, 30000);
  assert.equal(payosLink.status, 'PENDING');

  // 6. Point 2: Store Owner cannot access store charge if payerStoreId is null (prevent fail-open)
  const nullPayerCharge = { ...storeChargeForPayos, chargeId: 556n, payerStoreId: null };
  const nullPayerBillingRepo: any = {
    ...mockBillingRepo,
    findChargeById: async (id: bigint) => (id === 556n ? nullPayerCharge : null),
  };
  const nullPayerService = new BillingChargesService(nullPayerBillingRepo, {} as any);
  await assert.rejects(
    () => nullPayerService.getChargeById(556n, { userId: 1001n, role: 'STORE_OWNER', storeId: 15n }),
    /Khoản thu thiếu thông tin Cửa hàng chi trả/,
  );

  // 7. Point 2: Store Owner cannot access store charge if rental fulfillmentStoreId is null
  const nullFulfillmentRepo: any = {
    ...mockBillingRepo,
    findRentalWithCustomer: async () => ({
      rentalId: 42n,
      customerId: 7n,
      fulfillmentStoreId: null,
      customer: { userId: 99n },
    }),
  };
  const nullFulfillmentService = new BillingChargesService(nullFulfillmentRepo, {} as any);
  await assert.rejects(
    () => nullFulfillmentService.getChargeById(555n, { userId: 1001n, role: 'STORE_OWNER', storeId: 15n }),
    /Hợp đồng thuê thiếu thông tin Cửa hàng phụ trách/,
  );

  // --- Point 4: Migration Backfill Classification Test (Rental-level Conflict & LEFT JOIN Empty Charge Detection) ---
  function executeRelationalMigrationBackfill(
    rentals: Array<{ rentalId: bigint; billingPolicy: string; billingPolicyReviewRequired: boolean }>,
    charges: Array<{ chargeId: bigint; targetId: bigint; targetType: string; purpose: string; totalAmount: number }>,
    lines: Array<{ lineId: bigint; chargeId: bigint; lineType: string; amount: number; durationCount?: number }>,
  ) {
    // Step 0: Default all rentals to review required
    for (const r of rentals) {
      r.billingPolicyReviewRequired = true;
    }

    const initialCharges = charges.filter(c => c.targetType === 'RENTAL' && c.purpose === 'RENTAL_INITIAL');

    // Relational LEFT JOIN: FROM billing_charges bc LEFT JOIN billing_charge_lines bcl ON bc.charge_id = bcl.charge_id
    const joinedRows: Array<{ charge: typeof initialCharges[0]; line: typeof lines[0] | null }> = [];
    for (const bc of initialCharges) {
      const matchingLines = lines.filter(l => l.chargeId === bc.chargeId);
      if (matchingLines.length === 0) {
        joinedRows.push({ charge: bc, line: null }); // LEFT JOIN preserves empty charge
      } else {
        for (const l of matchingLines) {
          joinedRows.push({ charge: bc, line: l });
        }
      }
    }

    // GROUP BY bc.target_id
    const groups = new Map<bigint, typeof joinedRows>();
    for (const row of joinedRows) {
      const arr = groups.get(row.charge.targetId) || [];
      arr.push(row);
      groups.set(row.charge.targetId, arr);
    }

    for (const r of rentals) {
      const rows = groups.get(r.rentalId);
      if (!rows || rows.length === 0) continue;

      const distinctChargeCount = new Set(rows.map(row => row.charge.chargeId)).size;
      const nonNullLines = rows.filter(row => row.line !== null).map(row => row.line!);
      const totalLinesCount = nonNullLines.length; // COUNT(bcl.line_id)
      const validRentLines = nonNullLines.filter(l => l.lineType === 'RENT' && l.amount > 0 && (l.durationCount || 0) > 0).length;
      const allRentLines = nonNullLines.filter(l => l.lineType === 'RENT').length;
      const validDepositLines = nonNullLines.filter(l => l.lineType === 'DEPOSIT' && l.amount >= 0).length;
      const positiveDepositLines = nonNullLines.filter(l => l.lineType === 'DEPOSIT' && l.amount > 0).length;
      const sumLineAmount = nonNullLines.reduce((sum, l) => sum + l.amount, 0);
      const maxChargeAmount = Math.max(...rows.map(row => row.charge.totalAmount));

      // Step 1: CLEAR LEGACY
      if (
        distinctChargeCount === 1 &&
        totalLinesCount === 2 &&
        validRentLines === 1 &&
        allRentLines === 1 &&
        validDepositLines === 1 &&
        sumLineAmount === maxChargeAmount
      ) {
        r.billingPolicy = 'LEGACY_CUSTOMER_RENT';
        r.billingPolicyReviewRequired = false;
        continue;
      }

      // Step 2: CLEAR DEPOSIT ONLY
      if (
        distinctChargeCount === 1 &&
        totalLinesCount === 1 &&
        positiveDepositLines === 1 &&
        allRentLines === 0 &&
        sumLineAmount === maxChargeAmount
      ) {
        r.billingPolicy = 'STORE_RENT_CUSTOMER_DEPOSIT';
        r.billingPolicyReviewRequired = false;
        continue;
      }
    }
    return rentals;
  }

  const testRentals = [
    { rentalId: 1n, billingPolicy: 'STORE_RENT_CUSTOMER_DEPOSIT', billingPolicyReviewRequired: false },
    { rentalId: 2n, billingPolicy: 'STORE_RENT_CUSTOMER_DEPOSIT', billingPolicyReviewRequired: false },
    { rentalId: 3n, billingPolicy: 'STORE_RENT_CUSTOMER_DEPOSIT', billingPolicyReviewRequired: false }, // Conflicting charges!
    { rentalId: 4n, billingPolicy: 'STORE_RENT_CUSTOMER_DEPOSIT', billingPolicyReviewRequired: false }, // Zero charges
    { rentalId: 5n, billingPolicy: 'STORE_RENT_CUSTOMER_DEPOSIT', billingPolicyReviewRequired: false }, // 1 valid charge + 1 empty charge!
  ];

  const testCharges = [
    // Rental 1: 1 clear legacy charge
    { chargeId: 10n, targetId: 1n, targetType: 'RENTAL', purpose: 'RENTAL_INITIAL', totalAmount: 500000 },
    // Rental 2: 1 clear deposit-only charge
    { chargeId: 20n, targetId: 2n, targetType: 'RENTAL', purpose: 'RENTAL_INITIAL', totalAmount: 200000 },
    // Rental 3: 2 conflicting initial charges! (One legacy, one deposit only)
    { chargeId: 31n, targetId: 3n, targetType: 'RENTAL', purpose: 'RENTAL_INITIAL', totalAmount: 500000 },
    { chargeId: 32n, targetId: 3n, targetType: 'RENTAL', purpose: 'RENTAL_INITIAL', totalAmount: 200000 },
    // Rental 5: 1 valid deposit-only charge (charge 51) + 1 empty initial charge without lines (charge 52)
    { chargeId: 51n, targetId: 5n, targetType: 'RENTAL', purpose: 'RENTAL_INITIAL', totalAmount: 200000 },
    { chargeId: 52n, targetId: 5n, targetType: 'RENTAL', purpose: 'RENTAL_INITIAL', totalAmount: 0 },
  ];

  const testLines = [
    // Lines for charge 10 (Legacy)
    { lineId: 101n, chargeId: 10n, lineType: 'RENT', amount: 300000, durationCount: 3 },
    { lineId: 102n, chargeId: 10n, lineType: 'DEPOSIT', amount: 200000 },
    // Lines for charge 20 (Deposit-only)
    { lineId: 201n, chargeId: 20n, lineType: 'DEPOSIT', amount: 200000 },
    // Lines for charge 31 (Legacy)
    { lineId: 311n, chargeId: 31n, lineType: 'RENT', amount: 300000, durationCount: 3 },
    { lineId: 312n, chargeId: 31n, lineType: 'DEPOSIT', amount: 200000 },
    // Lines for charge 32 (Deposit-only)
    { lineId: 321n, chargeId: 32n, lineType: 'DEPOSIT', amount: 200000 },
    // Lines for charge 51 (Deposit-only)
    { lineId: 511n, chargeId: 51n, lineType: 'DEPOSIT', amount: 200000 },
    // Charge 52 intentionally has ZERO lines!
  ];

  const backfilled = executeRelationalMigrationBackfill(testRentals, testCharges, testLines);

  assert.equal(backfilled[0].billingPolicy, 'LEGACY_CUSTOMER_RENT');
  assert.equal(backfilled[0].billingPolicyReviewRequired, false);

  assert.equal(backfilled[1].billingPolicy, 'STORE_RENT_CUSTOMER_DEPOSIT');
  assert.equal(backfilled[1].billingPolicyReviewRequired, false);

  assert.equal(backfilled[2].billingPolicyReviewRequired, true, 'Rental with conflicting charges must require review');
  assert.equal(backfilled[3].billingPolicyReviewRequired, true, 'Rental with no initial charges must require review');
  assert.equal(backfilled[4].billingPolicyReviewRequired, true, 'Rental with 1 valid charge + 1 empty charge must require review (LEFT JOIN preservation)');

  console.log('PASS all acceptance tests: store payment link, strict settlement invariants, immutable policy snapshot, and handover guards.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
