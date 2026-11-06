import assert from 'node:assert/strict';
import { Prisma } from '@prisma/client';
import { StoreCashRepository } from '../src/store-cash/store-cash.repository';
import { StoreCashService } from '../src/store-cash/store-cash.service';
import {
  CustomerRentalsCashVoucherController,
  StoreCashReceiptsController,
} from '../src/store-cash/store-cash.controller';
import {
  hashCashVoucherToken,
  createCashVoucherToken,
} from '../src/store-cash/cash-voucher-token';
import {
  issueCashVoucherSchema,
  collectCashSchema,
  collectCashBodySchema,
  validatePathId,
  validateZod,
  cashPaginationQuerySchema,
} from '../src/store-cash/dto/store-cash.dto';
import { recordInitialPayosReceiptInTx } from '../src/store-cash/store-cash-settlement.transaction';
import { calculateRentalPricing } from '../src/rentals/rental-pricing';

async function runStoreCashTestSuite() {
  console.log('--- Starting Store Cash Collection & Wallet Offset Comprehensive Suite ---');

  // =========================================================================
  // Test 1: Feature Flag disabled -> ServiceUnavailableException
  // =========================================================================
  console.log('Testing Test 1: Feature Flag disabled guard...');
  const oldFlag = process.env.STORE_CASH_COLLECTION_ENABLED;
  try {
    delete process.env.STORE_CASH_COLLECTION_ENABLED;
    const dummyPrisma: any = {};
    const repo = new StoreCashRepository(dummyPrisma);

    await assert.rejects(
      async () => repo.issueVoucher(1n, 2n, 3n, 4n),
      (err: any) => err.status === 503 || err.message?.includes('disabled'),
      'Should throw 503 when flag is unset',
    );

    await assert.rejects(
      async () => repo.collect(1n, 2n, 3n, { chargeId: '3', voucherToken: 'a'.repeat(64), handover: 'DEFERRED' }),
      (err: any) => err.status === 503 || err.message?.includes('disabled'),
      'Should throw 503 when flag is unset for collect',
    );
  } finally {
    process.env.STORE_CASH_COLLECTION_ENABLED = 'true';
  }
  console.log('✔ Test 1 PASS: Feature flag guard properly rejects with 503');

  // =========================================================================
  // Test 2: Input validation & DTO schema enforcement (HTTP 400 Bad Request)
  // =========================================================================
  console.log('Testing Test 2: DTO schema and input validation...');
  // Valid voucher issue
  const validVoucherInput = { chargeId: '100', collectingStoreId: '5' };
  assert.deepEqual(validateZod(issueCashVoucherSchema, validVoucherInput), validVoucherInput);

  // Invalid voucher issue - extra field
  assert.throws(
    () => validateZod(issueCashVoucherSchema, { ...validVoucherInput, hack: true }),
    (err: any) => err.status === 400 && err.response?.errorCode === 'VALIDATION_ERROR',
  );

  // Invalid path ID checks
  assert.throws(
    () => validatePathId('-1', 'storeId'),
    (err: any) => err.status === 400 && err.response?.errorCode === 'INVALID_ID_FORMAT',
  );
  assert.throws(
    () => validatePathId('abc', 'storeId'),
    (err: any) => err.status === 400 && err.response?.errorCode === 'INVALID_ID_FORMAT',
  );
  assert.equal(validatePathId('12345', 'storeId'), 12345n);

  // Pagination query validation: pageSize <= 100, page >= 1
  assert.throws(
    () => validateZod(cashPaginationQuerySchema, { page: '1', pageSize: '500' }),
    (err: any) => err.status === 400 && err.response?.errorCode === 'VALIDATION_ERROR',
  );
  const parsedPagination = validateZod(cashPaginationQuerySchema, { page: '2', pageSize: '50' });
  assert.equal(parsedPagination.page, 2);
  assert.equal(parsedPagination.pageSize, 50);

  // Valid collect cash - DEFERRED
  const validDeferred = { chargeId: '100', voucherToken: 'a'.repeat(64), handover: 'DEFERRED' as const };
  assert.deepEqual(validateZod(collectCashSchema, validDeferred), validDeferred);

  // Valid collect cash - IMMEDIATE with unique buttons
  const validImmediate = {
    chargeId: '100',
    voucherToken: 'b'.repeat(64),
    handover: 'IMMEDIATE' as const,
    buttonIds: ['10', '20', '30'],
  };
  assert.deepEqual(validateZod(collectCashSchema, validImmediate), validImmediate);

  // Invalid collect cash - IMMEDIATE with duplicate buttons
  assert.throws(() =>
    validateZod(collectCashSchema, {
      ...validImmediate,
      buttonIds: ['10', '20', '10'],
    }),
  );

  // Valid collectCashBodySchema
  const validBody = { rentalId: '42', ...validDeferred };
  assert.deepEqual(validateZod(collectCashBodySchema, validBody), validBody);
  console.log('✔ Test 2 PASS: DTO schema & path ID validation return standardized HTTP 400');

  // =========================================================================
  // Test 3: Real Schema & CustomerProfile resolution (userId = 99 -> customerId = 7)
  // and Lock Order Verification (billing_charges FOR UPDATE before button_rentals)
  // =========================================================================
  console.log('Testing Test 3: Real schema resolution & lock order verification...');
  const { token, tokenHash } = createCashVoucherToken();
  assert.equal(token.length, 64, 'Token must be 32 bytes hex (64 chars)');
  assert.equal(hashCashVoucherToken(token), tokenHash, 'Hash must match SHA-256');

  let revokedCount = 0;
  let createdVoucher: any = null;
  const lockedOrder: string[] = [];

  const mockTxIssue: any = {
    $queryRawUnsafe: async (sql: string, ...args: any[]) => {
      // 1. Customer profile query from userId (99)
      if (sql.includes('FROM customer_profile cp')) {
        assert.equal(args[0], 99n, 'Must query by actorUserId 99');
        return [{ customer_id: 7n }]; // Real customer_profile.customer_id is 7
      }
      if (sql.includes('FROM store WHERE store_id = $1')) return [{ store_id: 5n }];
      // 2. Lock billing_charges FIRST
      if (sql.includes('FROM billing_charges WHERE charge_id = $1 FOR UPDATE')) {
        lockedOrder.push('billing_charges');
        return [{
          charge_id: 88n,
          target_id: 42n,
          target_type: 'RENTAL',
          purpose: 'RENTAL_INITIAL',
          currency: 'VND',
          status: 'PENDING',
          // NO customer_id column in real billing_charges table!
          total_amount: new Prisma.Decimal(230000),
        }];
      }
      // 3. Lock button_rentals SECOND
      if (sql.includes('FROM button_rentals WHERE rental_id = $1 AND customer_id = $2 FOR UPDATE')) {
        lockedOrder.push('button_rentals');
        assert.equal(args[1], 7n, 'Must query button_rentals using CustomerProfile.customerId (7), NOT userId (99)');
        return [{ rental_id: 42n, customer_id: 7n, status: 'PENDING_PAYMENT' }];
      }
      // 4. Lock prior active vouchers
      if (sql.includes('FROM store_cash_vouchers WHERE rental_id = $1 AND status = \'ACTIVE\' FOR UPDATE')) {
        lockedOrder.push('store_cash_vouchers');
        return [{ id: 111n }];
      }
      if (sql.includes('clock_timestamp()')) return [{ now: new Date('2026-11-03T00:00:00Z') }];
      return [];
    },
    storeCashVoucher: {
      updateMany: async ({ where, data }: any) => {
        if (where.rentalId === 42n && where.status === 'ACTIVE') revokedCount++;
        return { count: 1 };
      },
      create: async ({ data }: any) => {
        createdVoucher = { id: 777n, ...data };
        return createdVoucher;
      },
    },
  };
  const mockPrismaIssue: any = {
    $transaction: async (fn: any) => fn(mockTxIssue),
  };

  const repoIssue = new StoreCashRepository(mockPrismaIssue);
  // actorUserId = 99n, rentalId = 42n, chargeId = 88n, collectingStoreId = 5n
  const voucherRes = await repoIssue.issueVoucher(99n, 42n, 88n, 5n, 120);

  // Check lock order
  assert.deepEqual(lockedOrder, ['billing_charges', 'button_rentals', 'store_cash_vouchers'],
    'Lock order must be billing_charges FOR UPDATE -> button_rentals FOR UPDATE -> store_cash_vouchers FOR UPDATE');
  assert.equal(revokedCount, 1, 'Must revoke prior ACTIVE vouchers for rental');
  assert.equal(createdVoucher.status, 'ACTIVE');
  assert.equal(createdVoucher.customerId, 7n, 'Voucher customerId must be CustomerProfile.customerId (7), not userId');
  assert.equal(createdVoucher.amount.toNumber(), 230000);
  assert.equal(voucherRes.voucherId, 777n);
  console.log('✔ Test 3 PASS: Resolved userId 99 -> customerId 7; billing_charges locked before button_rentals');

  // =========================================================================
  // Test 4: Controller collectCashWithBody destructuring (No Zod unrecognized_keys error)
  // =========================================================================
  console.log('Testing Test 4: Controller collectCashWithBody flow...');
  let repoCollectCalledWith: any = null;
  const mockRepoForController: any = {
    collect: async (storeId: bigint, rentalId: bigint, actorUserId: bigint, input: any) => {
      repoCollectCalledWith = { storeId, rentalId, actorUserId, input };
      // Verify collectCashSchema can parse input without unrecognized_keys error
      const parsed = validateZod(collectCashSchema, input);
      return {
        receipt: {
          id: 999n,
          chargeId: BigInt(parsed.chargeId),
          voucherId: 777n,
          collectingStoreId: storeId,
          amount: new Prisma.Decimal(230000),
          createdAt: new Date(),
        },
        idempotent: false,
      };
    },
  };
  const serviceForController = new StoreCashService(mockRepoForController);
  const controller = new StoreCashReceiptsController(serviceForController);

  const controllerBody = {
    rentalId: '42',
    chargeId: '88',
    voucherToken: token,
    handover: 'DEFERRED' as const,
  };
  const controllerResult = await controller.collectCashWithBody('5', controllerBody, {
    user: { userId: '201' },
  });

  assert.equal(controllerResult.success, true);
  assert.equal(repoCollectCalledWith.rentalId, 42n);
  assert.equal(repoCollectCalledWith.storeId, 5n);
  assert.equal(repoCollectCalledWith.input.rentalId, undefined, 'rentalId must be stripped before collectCashSchema');
  assert.equal(repoCollectCalledWith.input.chargeId, '88');
  console.log('✔ Test 4 PASS: Controller cleanly destructures rentalId; zero Zod unrecognized_keys error');

  // =========================================================================
  // Test 5: Cash Collection atomic transaction & Wallet Offset
  // =========================================================================
  console.log('Testing Test 5: Cash collection atomic transaction & wallet offset...');
  let walletDebitCount = 0;
  let ledgerCount = 0;
  let chargeSettled = false;
  let depositCredited = false;
  let voucherConsumed = false;
  let receiptCreated: any = null;

  const mockTxCollect: any = {
    $queryRawUnsafe: async (sql: string, ...args: any[]) => {
      if (sql.includes('FROM users')) return [{ user_id: 201n }];
      if (sql.includes('FROM store WHERE')) return [{ owner_user_id: 201n }];
      if (sql.includes('FROM store_wallets')) return [{ wallet_id: 10n, store_id: 5n, balance: new Prisma.Decimal(500000), frozen_balance: new Prisma.Decimal(100000) }];
      if (sql.includes('FROM billing_charges')) {
        return [{
          charge_id: 88n,
          charge_code: 'CHG-88',
          target_id: 42n,
          target_type: 'RENTAL',
          purpose: 'RENTAL_INITIAL',
          currency: 'VND',
          status: 'PENDING',
          total_amount: new Prisma.Decimal(230000),
        }];
      }
      if (sql.includes('FROM store_cash_vouchers')) {
        return [{
          id: 777n,
          rental_id: 42n,
          charge_id: 88n,
          customer_id: 7n,
          collecting_store_id: 5n,
          amount: new Prisma.Decimal(230000),
          status: 'ACTIVE',
          expires_at: new Date(Date.now() + 3600000),
        }];
      }
      if (sql.includes('FROM button_rentals')) {
        return [{
          rental_id: 42n,
          customer_id: 7n,
          status: 'PENDING_PAYMENT',
          button_quantity: 1,
          deposit_amount: new Prisma.Decimal(200000),
          fulfillment_store_id: null,
        }];
      }
      if (sql.includes('clock_timestamp()')) return [{ now: new Date() }];
      return [];
    },
    $executeRawUnsafe: async (sql: string, ...args: any[]) => {
      if (sql.includes("UPDATE store_cash_vouchers SET status = 'CONSUMED'")) {
        voucherConsumed = true;
        return 1;
      }
      return 1;
    },
    storeCashReceipt: {
      findUnique: async () => null,
      create: async ({ data }: any) => {
        receiptCreated = { id: 999n, ...data };
        return receiptCreated;
      },
    },
    storeWallet: {
      updateMany: async ({ where, data }: any) => {
        walletDebitCount++;
        return { count: 1 };
      },
    },
    walletTransaction: {
      create: async ({ data }: any) => {
        ledgerCount++;
        assert.equal(data.type, 'RENTAL_CASH_COLLECTION_OFFSET');
        assert.equal(data.amount.toNumber(), -230000);
        return { transactionId: 555n, ...data };
      },
    },
    billingChargeLine: {
      findMany: async () => [
        { lineType: 'RENT', amount: new Prisma.Decimal(30000), durationUnit: 'MONTH', durationCount: 1 },
        { lineType: 'DEPOSIT', amount: new Prisma.Decimal(200000) },
      ],
    },
    billingCharge: {
      updateMany: async ({ where, data }: any) => {
        if (data.status === 'PAID') chargeSettled = true;
        return { count: 1 };
      },
    },
    rentalDeposit: {
      findUnique: async () => null,
      create: async ({ data }: any) => {
        depositCredited = true;
        assert.equal(data.collectedAmount.toNumber(), 200000);
        assert.equal(data.heldAmount.toNumber(), 200000);
        return { id: 1n, ...data };
      },
    },
    buttonRental: {
      update: async ({ data }: any) => ({ rentalId: 42n, ...data }),
    },
    outboxEvent: {
      create: async () => ({ id: 1n }),
    },
    rentalAuditLog: {
      create: async () => ({ id: 1n }),
    },
  };

  const mockPrismaCollect: any = {
    $transaction: async (fn: any) => fn(mockTxCollect),
  };

  const repoCollect = new StoreCashRepository(mockPrismaCollect);
  const collectResult = await repoCollect.collect(5n, 42n, 201n, {
    chargeId: '88',
    voucherToken: token,
    handover: 'DEFERRED',
  });

  assert.equal(collectResult.idempotent, false);
  assert.equal(walletDebitCount, 1, 'Wallet balance must be debited exactly once');
  assert.equal(ledgerCount, 1, 'WalletTransaction ledger record must be written');
  assert.equal(chargeSettled, true, 'BillingCharge status must be set to PAID');
  assert.equal(depositCredited, true, 'RentalDeposit must be created with heldAmount');
  assert.equal(voucherConsumed, true, 'Voucher must be consumed');
  assert.equal(receiptCreated.collectingStoreId, 5n);
  assert.equal(receiptCreated.amount.toNumber(), 230000);
  console.log('✔ Test 5 PASS: Cash collected, wallet offset, deposit ledger credited, voucher consumed');

  // =========================================================================
  // Test 6: Cache Invalidation with matching system keys
  // =========================================================================
  console.log('Testing Test 6: Cache invalidation with matching system keys...');
  const cacheMap = new Map<string, string>();
  cacheMap.set('dash:store:5:summary', 'cached_data');
  cacheMap.set('staff:dashboard:store:5:metrics', 'cached_data');
  cacheMap.set('wallet:5:balance', 'cached_data');
  cacheMap.set('store:wallet:5:transactions', 'cached_data');
  cacheMap.set('admin:dashboard:overview', 'cached_data');
  cacheMap.set('dash:store:99:unrelated', 'keep_data');

  const mockCacheService: any = {
    invalidatePrefix: async (prefix: string) => {
      for (const key of Array.from(cacheMap.keys())) {
        if (key.startsWith(prefix)) {
          cacheMap.delete(key);
        }
      }
    },
  };

  const serviceWithCache = new StoreCashService(repoCollect, mockCacheService);
  await serviceWithCache.collectCash('5', '42', {
    chargeId: '88',
    voucherToken: token,
    handover: 'DEFERRED',
  }, { userId: '201' });

  assert.equal(cacheMap.has('dash:store:5:summary'), false, 'dash:store:5:summary must be evicted');
  assert.equal(cacheMap.has('staff:dashboard:store:5:metrics'), false, 'staff:dashboard:store:5:metrics must be evicted');
  assert.equal(cacheMap.has('wallet:5:balance'), false, 'wallet:5:balance must be evicted');
  assert.equal(cacheMap.has('store:wallet:5:transactions'), false, 'store:wallet:5:transactions must be evicted');
  assert.equal(cacheMap.has('admin:dashboard:overview'), false, 'admin:dashboard:overview must be evicted');
  assert.equal(cacheMap.has('dash:store:99:unrelated'), true, 'Unrelated store cache must be preserved');
  console.log('✔ Test 6 PASS: Cache invalidation successfully evicts dash:store:5:, wallet:5:, staff:, admin: keys');

  // =========================================================================
  // Test 7: Double Payment Race Matrix
  // =========================================================================
  console.log('Testing Test 7: Double Payment Race Matrix...');
  // Scenario A: Cash first, PayOS later -> OVERPAYMENT_RECEIPT & PENDING_RECONCILIATION
  let overpaymentReceiptCreated: any = null;
  let overpaymentObligationCreated: any = null;
  const mockTxPayosLate: any = {
    billingPaymentReceipt: {
      findUnique: async () => null,
      create: async ({ data }: any) => {
        overpaymentReceiptCreated = data;
        return { id: 333n, ...data };
      },
    },
    billingOverpaymentObligation: {
      create: async ({ data }: any) => {
        overpaymentObligationCreated = data;
        return { id: 444n, ...data };
      },
    },
    rentalDeposit: {
      create: async () => { assert.fail('Late PayOS must NEVER create extra rental deposit!'); },
      update: async () => { assert.fail('Late PayOS must NEVER update rental deposit!'); },
    },
  };

  const chargePaidByCash = {
    currency: 'VND',
    charge_id: 88n,
    target_id: 42n,
    target_type: 'RENTAL',
    purpose: 'RENTAL_INITIAL',
    status: 'PAID',
    payment_method: 'STORE_CASH_OFFSET',
    total_amount: new Prisma.Decimal(230000),
    payment_link_id: 'link-88',
    provider_transaction_code: null,
  };

  const latePayosReceipt = {
    provider: 'PAYOS',
    providerTransactionCode: 'PAYOS-TX-999',
    amount: 230000,
    currency: 'VND',
    verified: true as const,
    paymentLinkId: 'link-88',
    paidAt: new Date(),
  };

  const payosRaceResult = await recordInitialPayosReceiptInTx(mockTxPayosLate, chargePaidByCash, latePayosReceipt);
  assert.equal(payosRaceResult.overpayment, true, 'Late payment must be classified as overpayment');
  assert.equal(payosRaceResult.alreadySettled, true);
  assert.equal(overpaymentReceiptCreated.classification, 'OVERPAYMENT_RECEIPT');
  assert.equal(overpaymentObligationCreated.status, 'PENDING_RECONCILIATION');
  assert.equal(overpaymentObligationCreated.receiptId, 333n);
  console.log('✔ Test 7A PASS: Late PayOS creates OVERPAYMENT_RECEIPT and PENDING_RECONCILIATION obligation');

  // Scenario B: PayOS first, Cash collection arrives later
  const mockTxCashLate: any = {
    ...mockTxCollect,
    $queryRawUnsafe: async (sql: string, ...args: any[]) => {
      if (sql.includes('FROM billing_charges')) {
        return [{
          charge_id: 88n,
          charge_code: 'CHG-88',
          target_id: 42n,
          target_type: 'RENTAL',
          purpose: 'RENTAL_INITIAL',
          currency: 'VND',
          status: 'PAID', // Already PAID online via PayOS
          payment_method: 'PAYOS',
          total_amount: new Prisma.Decimal(230000),
        }];
      }
      return mockTxCollect.$queryRawUnsafe(sql, ...args);
    },
    storeWallet: {
      updateMany: async () => { assert.fail('Wallet must NEVER be debited when charge is already paid!'); },
    },
  };
  const mockPrismaCashLate: any = {
    $transaction: async (fn: any) => fn(mockTxCashLate),
  };
  const repoCashLate = new StoreCashRepository(mockPrismaCashLate);

  await assert.rejects(
    async () => repoCashLate.collect(5n, 42n, 201n, {
      chargeId: '88',
      voucherToken: token,
      handover: 'DEFERRED',
    }),
    (err: any) =>
      err.response?.errorCode === 'CHARGE_ALREADY_PAID_ONLINE' &&
      err.response?.message?.includes('trả lại tiền mặt nếu đã nhận tại quầy'),
    'Should reject with CHARGE_ALREADY_PAID_ONLINE instructing POS staff to return cash',
  );
  console.log('✔ Test 7B PASS: Cash collection rejected with CHARGE_ALREADY_PAID_ONLINE and POS return cash notice');

  // =========================================================================
  // Test 8: P0 BOLA Tenant Isolation Enforcement
  // Store 99 actor calling URL /stores/5/cash-receipts/999 must get HTTP 403!
  // =========================================================================
  console.log('Testing Test 8: P0 BOLA Tenant Isolation Enforcement...');
  const mockPrismaBola: any = {
    $queryRawUnsafe: async (sql: string, ...args: any[]) => {
      if (sql.includes('FROM store WHERE store_id = $1')) {
        // Store 5 owner is user 201
        return [{ owner_user_id: 201n }];
      }
      if (sql.includes('FROM store_staff ss')) {
        // User 9999 has NO staff role at Store 5
        return [];
      }
      return [];
    },
    storeCashReceipt: {
      findUnique: async ({ where }: any) => ({
        id: 999n,
        chargeId: 88n,
        voucherId: 777n,
        collectingStoreId: 5n, // Store 5
        amount: new Prisma.Decimal(230000),
        createdAt: new Date(),
        collectedBy: { userId: 201n, fullName: 'Staff A', email: 'staff@store5.com' },
      }),
    },
  };
  const repoBola = new StoreCashRepository(mockPrismaBola);
  const serviceBola = new StoreCashService(repoBola);

  // 1. Authorized Store 5 owner (userId = 201) accessing Store 5 receipt via URL /stores/5/cash-receipts/999 -> 200 OK
  const authorizedReceipt = await serviceBola.getReceipt('5', '999', { userId: '201', role: 'STORE_OWNER' });
  assert.equal(authorizedReceipt.data.receiptId, '999');

  // 2. Malicious user from Store 99 (userId = 9999) attempting to access Store 5 receipt via URL /stores/5/cash-receipts/999 -> 403 Forbidden!
  await assert.rejects(
    async () => serviceBola.getReceipt('5', '999', { userId: '9999', role: 'STORE_OWNER' }),
    (err: any) => err.status === 403 && err.message?.includes('không có quyền truy cập dữ liệu của cửa hàng này'),
    'Should throw 403 when user belongs to Store 99 attempting to probe Store 5',
  );
  console.log('✔ Test 8 PASS: P0 BOLA strictly denies Store 99 actor probing Store 5 URL');


  // =========================================================================
  // Test 9: Multi-Button Kit (3-Button Kit) Verification
  // button_quantity = 3, deposit = 600,000 VND (200k x 3), rent = 90,000 VND (30k x 3), total = 690,000 VND
  // =========================================================================
  console.log('Testing Test 9: 3-Button Kit Handover & Deposit Lifecycle...');
  const { token: token3 } = createCashVoucherToken();
  let debitedWalletAmount = 0;
  let depositLedgerCredited = 0;
  let buttonsHandedOver: any[] = [];
  let rentalActivated = false;

  const mockTxKit3: any = {
    $queryRawUnsafe: async (sql: string, ...args: any[]) => {
      if (sql.includes('FROM users')) return [{ user_id: 201n }];
      if (sql.includes('FROM store WHERE')) return [{ owner_user_id: 201n }];
      if (sql.includes('FROM store_wallets')) return [{ wallet_id: 10n, store_id: 5n, balance: new Prisma.Decimal(1000000), frozen_balance: new Prisma.Decimal(0) }];
      if (sql.includes('FROM billing_charges WHERE charge_id = $1 FOR UPDATE')) {
        return [{
          charge_id: 300n,
          charge_code: 'CHG-KIT3',
          target_id: 42n,
          target_type: 'RENTAL',
          purpose: 'RENTAL_INITIAL',
          currency: 'VND',
          status: 'PENDING',
          total_amount: new Prisma.Decimal(690000), // 90k rent + 600k deposit
        }];
      }
      if (sql.includes('FROM store_cash_vouchers')) {
        return [{
          id: 333n,
          rental_id: 42n,
          charge_id: 300n,
          customer_id: 7n,
          collecting_store_id: 5n,
          amount: new Prisma.Decimal(690000),
          status: 'ACTIVE',
          expires_at: new Date(Date.now() + 3600000),
        }];
      }
      if (sql.includes('FROM button_rentals WHERE rental_id = $1 FOR UPDATE')) {
        return [{
          rental_id: 42n,
          rental_code: 'RNT-KIT3',
          customer_id: 7n,
          button_quantity: 3, // Kit 3 nút!
          deposit_amount: new Prisma.Decimal(600000),
          deposit_per_button: new Prisma.Decimal(200000),
          rent_per_button: new Prisma.Decimal(30000),
          total_rent_amount: new Prisma.Decimal(690000),
          status: 'PENDING_PAYMENT',
          fulfillment_store_id: null,
        }];
      }
      if (sql.includes('FROM iot_button WHERE button_id = ANY')) {
        const queryIds = args[0] as bigint[];
        // Return 3 buttons in Store 5 warehouse
        return queryIds.map((bid) => ({
          button_id: bid,
          device_serial_number: `BTN-${bid}`,
          custody_store_id: 5n,
          rental_id: null,
          customer_id: null,
          inventory_state: 'ALLOCATED_TO_STORE',
        }));
      }
      if (sql.includes('extension_months')) {
        return [{ extension_months: 0 }];
      }
      if (sql.includes('initial_rent_months')) {
        return [{ initial_rent_months: 1 }];
      }
      if (sql.includes("bcl.line_type = 'DEPOSIT'")) {
        return [{ count: 1 }];
      }
      if (sql.includes('SELECT COALESCE(SUM(bcl.duration_count)')) {
        return [{ paid_months: 1, initial_rent_months: 1, extension_months: 0, count: 1 }];
      }
      if (sql.includes('clock_timestamp()')) return [{ now: new Date() }];
      return [];
    },
    $executeRawUnsafe: async () => 1,
    storeCashReceipt: {
      findUnique: async () => null,
      create: async ({ data }: any) => ({ id: 888n, ...data }),
    },
    storeWallet: {
      updateMany: async ({ data }: any) => {
        debitedWalletAmount = Number(data.balance.decrement);
        return { count: 1 };
      },
    },
    walletTransaction: {
      create: async ({ data }: any) => ({ transactionId: 101n, ...data }),
    },
    billingChargeLine: {
      findMany: async () => [
        { lineType: 'RENT', amount: new Prisma.Decimal(90000), durationUnit: 'MONTH', durationCount: 1, quantity: 3 },
        { lineType: 'DEPOSIT', amount: new Prisma.Decimal(600000), quantity: 3 },
      ],
    },
    billingCharge: {
      updateMany: async () => ({ count: 1 }),
    },
    rentalDeposit: {
      findUnique: async () => null,
      create: async ({ data }: any) => {
        depositLedgerCredited = Number(data.heldAmount);
        return { id: 1n, ...data };
      },
    },
    ioTButton: {
      findMany: async () => [],
      update: async ({ where, data }: any) => {
        buttonsHandedOver.push({ buttonId: where.buttonId, ...data });
        return { buttonId: where.buttonId, ...data };
      },
    },
    buttonRental: {
      update: async ({ data }: any) => {
        if (data.status === 'ACTIVE') rentalActivated = true;
        return { rentalId: 42n, ...data };
      },
    },
    deviceMovement: {
      create: async () => ({ id: 1n }),
    },
    outboxEvent: {
      create: async () => ({ id: 1n }),
    },
    rentalAuditLog: {
      create: async () => ({ id: 1n }),
    },
  };

  const mockPrismaKit3: any = {
    $transaction: async (fn: any) => fn(mockTxKit3),
  };
  const repoKit3 = new StoreCashRepository(mockPrismaKit3);

  // 9A: Thu tiền và bàn giao đủ 3 nút ['101', '102', '103'] thành công
  const kit3Result = await repoKit3.collect(5n, 42n, 201n, {
    chargeId: '300',
    voucherToken: token3,
    handover: 'IMMEDIATE',
    buttonIds: ['101', '102', '103'],
  });

  assert.equal(kit3Result.idempotent, false);
  assert.equal(debitedWalletAmount, 690000, 'Ví Store phải bị cấn trừ đúng 690.000đ (90k rent + 600k deposit)');
  assert.equal(depositLedgerCredited, 600000, 'Sổ cái tiền cọc Platform phải bảo lưu đủ 600.000đ (200k x 3 nút)');
  assert.equal(rentalActivated, true, 'Hợp đồng 3 nút phải kích hoạt sang ACTIVE');
  // Both intermediate ASSIGNED_TO_RENTAL and final IN_CUSTOMER_CUSTODY updates are recorded
  const customerCustodyButtons = buttonsHandedOver.filter((b) => b.inventoryState === 'IN_CUSTOMER_CUSTODY');
  assert.equal(customerCustodyButtons.length, 3, 'Cả 3 nút đều phải được bàn giao cho khách');
  assert.ok(customerCustodyButtons.every((b) => b.canOrder === true), 'Cả 3 nút đều phải được bật canOrder = true');
  console.log('✔ Test 9A PASS: 3-Button kit collected 690k, deposit ledger 600k, all 3 buttons activated');

  // 9B: Bàn giao thiếu nút (hợp đồng 3 nút nhưng chỉ quét 2 nút ['101', '102']) -> Bị từ chối ngay lập tức
  await assert.rejects(
    async () => repoKit3.collect(5n, 42n, 201n, {
      chargeId: '300',
      voucherToken: token3,
      handover: 'IMMEDIATE',
      buttonIds: ['101', '102'], // Thiếu 1 nút!
    }),
    (err: any) => err.response?.errorCode === 'HANDOVER_ASSIGNMENT_MISMATCH',
    'Should reject when buttonIds count (2) does not match rental.button_quantity (3)',
  );
  console.log('✔ Test 9B PASS: Rejects immediate handover if buttonIds count does not match 3 buttons');

  // =========================================================================
  // Test 10: R1 Pure Domain Pricing & Multi-Button Kit Invariants
  // =========================================================================
  console.log('Testing Test 10: R1 Pure Domain Pricing & Multi-Button Kit Invariants...');
  // 10A: Single button 1 month: 30k rent + 200k deposit = 230k
  const p1 = calculateRentalPricing({
    buttonQuantity: 1,
    months: 1,
    monthlyPackagePrice: 30000,
    packageDepositFee: 200000,
  });
  assert.equal(p1.totalAmount.toNumber(), 230000);
  assert.equal(p1.rentTotal.toNumber(), 30000);
  assert.equal(p1.depositTotal.toNumber(), 200000);
  assert.equal(p1.rentPerButton.toNumber(), 30000);
  assert.equal(p1.depositPerButton.toNumber(), 200000);
  assert.equal(p1.lines.rent.quantity, 1);
  assert.equal(p1.lines.deposit.quantity, 1);

  // 10B: 3-button kit 1 month: 90k rent (30k/btn) + 600k deposit (200k/btn) = 690k
  const p3_1m = calculateRentalPricing({
    buttonQuantity: 3,
    months: 1,
    monthlyPackagePrice: 90000,
    packageDepositFee: 600000,
  });
  assert.equal(p3_1m.totalAmount.toNumber(), 690000);
  assert.equal(p3_1m.rentTotal.toNumber(), 90000);
  assert.equal(p3_1m.depositTotal.toNumber(), 600000);
  assert.equal(p3_1m.rentPerButton.toNumber(), 30000);
  assert.equal(p3_1m.depositPerButton.toNumber(), 200000);
  assert.equal(p3_1m.lines.rent.quantity, 3);
  assert.equal(p3_1m.lines.deposit.quantity, 3);

  // 10C: 3-button kit 3 months: 270k rent (90k/btn) + 600k deposit (200k/btn) = 870k
  const p3_3m = calculateRentalPricing({
    buttonQuantity: 3,
    months: 3,
    monthlyPackagePrice: 90000,
    packageDepositFee: 600000,
  });
  assert.equal(p3_3m.totalAmount.toNumber(), 870000);
  assert.equal(p3_3m.rentTotal.toNumber(), 270000);
  assert.equal(p3_3m.depositTotal.toNumber(), 600000);
  assert.equal(p3_3m.rentPerButton.toNumber(), 90000);
  assert.equal(p3_3m.depositPerButton.toNumber(), 200000);

  // 10D: Indivisible amount throws domain error (prevents Math.floor precision leaks)
  assert.throws(
    () => calculateRentalPricing({
      buttonQuantity: 3,
      months: 1,
      monthlyPackagePrice: 100000, // 100000 / 3 has remainder!
      packageDepositFee: 600000,
    }),
    (err: any) => err.message.includes('không thể chia đều cho'),
    'Should throw error when monthly rent is not evenly divisible by button quantity',
  );
  console.log('✔ Test 10 PASS: Pure domain pricing accurately computes kit pricing with exact division');

  // =========================================================================
  // Test 11: R2 Handover Preview BOLA & Scope Verification
  // =========================================================================
  console.log('Testing Test 11: R2 Handover Preview BOLA & Scope Verification...');
  const mockButtonsAvailable = [
    { buttonId: 101n, deviceId: 'DEV-101', buttonCode: 'BTN-101', inventoryState: 'ALLOCATED_TO_STORE' },
    { buttonId: 102n, deviceId: 'DEV-102', buttonCode: 'BTN-102', inventoryState: 'ALLOCATED_TO_STORE' },
    { buttonId: 103n, deviceId: 'DEV-103', buttonCode: 'BTN-103', inventoryState: 'ALLOCATED_TO_STORE' },
  ];

  let queriedRental: any = {
    rentalId: 999n,
    fulfillmentStoreId: 99n, // Belongs to Store 99
    buttonQuantity: 3,
    depositAmount: new Prisma.Decimal(600000),
    totalRentAmount: new Prisma.Decimal(690000),
    status: 'PENDING_PAYMENT',
  };

  let mockVoucherFound: any = null;

  const mockPrismaPreview: any = {
    $queryRawUnsafe: async (sql: string, ...params: any[]) => {
      if (sql.includes('FROM store WHERE store_id')) {
        return [{ owner_user_id: 200n }]; // Store 5 belongs to owner 200
      }
      return [];
    },
    buttonRental: {
      findUnique: async () => queriedRental,
    },
    storeCashVoucher: {
      findFirst: async () => mockVoucherFound,
    },
    ioTButton: {
      findMany: async () => mockButtonsAvailable,
      count: async ({ where }: any) => where.NOT ? 0 : mockButtonsAvailable.length,
    },
  };

  const repoPreview = new StoreCashRepository(mockPrismaPreview);

  // 11A: Store 5 queries Store 99 rental WITHOUT voucher -> Throws 404 (zero leakage)
  mockVoucherFound = null;
  await assert.rejects(
    async () => repoPreview.getHandoverPreview(5n, 999n, 200n, ['STORE_OWNER']),
    (err: any) => err.status === 404 && err.message.includes('Hợp đồng thuê không tồn tại'),
    'Store 5 querying Store 99 rental without voucher must return 404',
  );

  // 11B: Store 5 queries Store 99 rental WITH valid voucher designating Store 5 -> 200 Preview
  mockVoucherFound = {
    id: 1n,
    rentalId: 999n,
    collectingStoreId: 5n,
    status: 'ACTIVE',
    expiresAt: new Date(Date.now() + 3600000),
  };
  const previewResult = await repoPreview.getHandoverPreview(5n, 999n, 200n, ['STORE_OWNER']);
  assert.equal(previewResult.rentalId, '999');
  assert.equal(previewResult.buttonQuantity, 3);
  assert.equal(previewResult.availableStoreButtons.length, 3);
  // Store 5 is not the fulfillment store (fulfillmentStoreId is 99), so cannot fulfill immediately unless fulfillment store matches
  assert.equal(previewResult.canFulfillImmediately, false, 'Store 5 is collecting cash, but fulfillmentStoreId is 99 so cannot immediately hand over at Store 5');

  // 11C: When Store 5 is fulfillmentStoreId and rental is CANCELLED -> canFulfillImmediately is false
  queriedRental = {
    ...queriedRental,
    fulfillmentStoreId: 5n,
    status: 'CANCELLED',
  };
  const previewCancelled = await repoPreview.getHandoverPreview(5n, 999n, 200n, ['STORE_OWNER']);
  assert.equal(previewCancelled.canFulfillImmediately, false, 'Cancelled rental must never allow immediate handover');

  // 11D: When Store 5 is fulfillmentStoreId, rental is PENDING_HANDOVER, enough buttons -> canFulfillImmediately is true
  queriedRental = {
    ...queriedRental,
    fulfillmentStoreId: 5n,
    status: 'PENDING_HANDOVER',
  };
  const previewReady = await repoPreview.getHandoverPreview(5n, 999n, 200n, ['STORE_OWNER']);
  assert.equal(previewReady.canFulfillImmediately, true, 'Pending handover with enough buttons at fulfillment store must be true');
  console.log('✔ Test 11 PASS: Preview enforces two-layer BOLA, returns 404 on unlinked stores, respects CANCELLED status');

  // =========================================================================
  // Test 12: R2 Safe Pagination & MAX_OFFSET Protection
  // =========================================================================
  console.log('Testing Test 12: R2 Safe Pagination & MAX_OFFSET Protection...');
  // Normal pagination
  const pValid = validateZod(cashPaginationQuerySchema, { page: '10', pageSize: '20' });
  assert.equal(pValid.page, 10);
  assert.equal(pValid.pageSize, 20);

  // Exceeding MAX_OFFSET (1_000_000)
  assert.throws(
    () => validateZod(cashPaginationQuerySchema, { page: '100000', pageSize: '100' }),
    (err: any) => err.status === 400 && err.response?.errorCode === 'VALIDATION_ERROR',
    'Should throw 400 when pagination offset exceeds MAX_OFFSET',
  );

  // Exact boundary: (10001 - 1) * 100 = 1_000_000 <= 1_000_000 -> passes
  const pBoundary = validateZod(cashPaginationQuerySchema, { page: '10001', pageSize: '100' });
  assert.equal(pBoundary.page, 10001);
  assert.equal(pBoundary.pageSize, 100);

  // Just beyond boundary: (10002 - 1) * 100 = 1_000_100 > 1_000_000 -> fails
  assert.throws(
    () => validateZod(cashPaginationQuerySchema, { page: '10002', pageSize: '100' }),
    (err: any) => err.status === 400 && err.response?.errorCode === 'VALIDATION_ERROR',
  );
  console.log('✔ Test 12 PASS: Safe pagination limits pageSize <= 100 and offset <= 1,000,000');

  // =========================================================================
  // Test 13: R6 Context-Aware Post-Commit Cache Invalidation
  // =========================================================================
  console.log('Testing Test 13: R6 Context-Aware Post-Commit Cache Invalidation...');
  const evictedPrefixes: string[] = [];
  const evictedKeys: string[] = [];
  const mockCache: any = {
    invalidateKey: async (key: string) => { evictedKeys.push(key); },
    invalidatePrefix: async (p: string) => {
      evictedPrefixes.push(p);
    },
  };

  const dummyRepo: any = {
    collect: async () => ({
      receipt: { id: 10n, chargeId: 20n, voucherId: 30n, collectingStoreId: 5n, amount: 690000, createdAt: new Date() },
      idempotent: false,
      context: {
        customerUserId: '42',
        collectingStoreId: '5',
        fulfillmentStoreId: '8', // Different store fulfilled
        affectedButtonIds: ['101', '102', '103'],
      },
    }),
  };

  const serviceWithCacheContext = new StoreCashService(dummyRepo, mockCache);
  await serviceWithCacheContext.collectCash('5', '1', { chargeId: '20', voucherToken: 'a'.repeat(64), handover: 'DEFERRED' }, { userId: '200' });

  // Verify all required cache prefixes were invalidated
  assert.ok(evictedPrefixes.includes('dash:store:5:'));
  assert.ok(evictedPrefixes.includes('wallet:5:'));
  assert.ok(evictedPrefixes.includes('dash:store:8:'), 'Fulfillment store cache must be invalidated');
  assert.ok(evictedKeys.includes('customer:dashboard:42'), 'Customer dashboard exact key must be invalidated');
  assert.ok(evictedKeys.includes('customer:rentals:42'), 'Customer rentals exact key must be invalidated');
  assert.ok(evictedKeys.includes('customer:devices:42'), 'Customer devices exact key must be invalidated');
  assert.ok(!evictedPrefixes.some(key => key.startsWith('customer:')), 'Customer keys must not use prefix eviction');
  assert.ok(evictedPrefixes.includes('admin:dashboard:'), 'Admin dashboard must be invalidated');
  console.log('✔ Test 13 PASS: Cache invalidation successfully targets store, fulfillment store, customer, and admin keys');

  console.log('\n========================================================================');
  console.log('🎉 ALL STORE CASH COLLECTION & WALLET OFFSET TESTS PASSED SUCCESSFULLY!');
  console.log('========================================================================\n');
}

runStoreCashTestSuite().catch((err) => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
