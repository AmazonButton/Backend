/** Real PostgreSQL acceptance, never a provider call.
 * Requires an explicitly configured, migrated, disposable *_test database.
 * Synthetic financial fixtures are retained for audit; dispose the isolated DB
 * separately, never delete shared financial history or disable its triggers.
 */
import 'dotenv/config';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { randomBytes, createHash } from 'node:crypto';
import { validateTestDatabaseUrl } from './test-db-guard';
import { RentalsRepository } from '../src/rentals/rentals.repository';
import { StoreCashRepository } from '../src/store-cash/store-cash.repository';
import { BillingChargesRepository } from '../src/billing-charges/billing-charges.repository';
import { calculateRentalPricing } from '../src/rentals/rental-pricing';
import { verifyDepositRefundPayoutEvidence } from '../src/rentals/deposit-payout-verifier';
import { CryptoVaultUtil } from '../src/common/utils/crypto-vault.util';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

function timeoutPromise(ms: number, message: string): Promise<never> {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
}

async function waitForBarrier(barrier: { promise: Promise<void> }, failurePromise: Promise<any>, timeoutMs = 10000, context = 'barrier') {
  const earlyFailure = failurePromise.then(res => {
    if (res && 'e' in res) throw res.e;
  });
  await Promise.race([
    barrier.promise,
    earlyFailure,
    timeoutPromise(timeoutMs, `Timeout waiting for ${context} after ${timeoutMs}ms`),
  ]);
}

async function main() {
  if (!process.env.TEST_DATABASE_URL) throw new Error('NOT RUN: explicit TEST_DATABASE_URL is required; production DATABASE_URL is never used');
  const safe = validateTestDatabaseUrl(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL);
  if (!safe.isValid) throw new Error('NOT RUN: TEST_DATABASE_URL did not pass the existing isolation guard');
  if (process.env.RENTAL_ACCEPTANCE_DISPOSABLE_DB !== 'true') {
    throw new Error('NOT RUN: set RENTAL_ACCEPTANCE_DISPOSABLE_DB=true only for an isolated disposable test database');
  }
  const run = 'rc_' + randomBytes(6).toString('hex');
  const url1 = new URL(process.env.TEST_DATABASE_URL);
  const url2 = new URL(process.env.TEST_DATABASE_URL);
  url1.searchParams.set('connection_limit', '5'); url2.searchParams.set('connection_limit', '3');
  url1.searchParams.set('application_name', run + '_a'); url2.searchParams.set('application_name', run + '_b');
  const a = new PrismaClient({ datasources: { db: { url: url1.toString() } } });
  const b = new PrismaClient({ datasources: { db: { url: url2.toString() } } });
  const oldFlag = process.env.STORE_CASH_COLLECTION_ENABLED;
  process.env.STORE_CASH_COLLECTION_ENABLED = 'true';
  try {
    await a.$connect(); await b.$connect();
    const migrated = await a.$queryRawUnsafe<any[]>(
      `SELECT migration_name FROM _prisma_migrations WHERE migration_name = $1 AND finished_at IS NOT NULL`,
      '20261103120000_rental_monthly_price_snapshot',
    );
    assert.equal(migrated.length, 1, 'Apply current migrations to the isolated test DB before this suite');
    const owner = await a.user.create({ data: { username: run + '_owner', fullName: 'Synthetic rental acceptance owner' } });
    const user = await a.user.create({ data: { username: run + '_customer', fullName: 'Synthetic rental acceptance customer' } });
    const customer = await a.customerProfile.create({ data: { userId: user.userId } });
    const store = await a.store.create({ data: { ownerUserId: owner.userId, name: 'Synthetic acceptance store',
      code: run, phone: '0000000000', address: 'Synthetic test fixture' } });
    const wallet = await a.storeWallet.create({ data: { storeId: store.storeId, balance: 1000000, frozenBalance: 100000 } });
    const pkg = await a.rentalPackage.create({ data: { packageCode: run, packageName: 'Synthetic kit 3',
      monthlyPrice: 90000, depositFee: 600000, buttonQuantity: 3 } });
    let index = 0;
    const fixture = async (handoverMode: 'DEFERRED' | 'IMMEDIATE' = 'DEFERRED', buttonIds: bigint[] = []) => {
      const code = run + '_' + ++index;
      await a.storeWallet.update({ where: { walletId: wallet.walletId }, data: { balance: 1000000 } });
      const pricing = calculateRentalPricing({ buttonQuantity: 3, months: 1, monthlyPackagePrice: 90000, packageDepositFee: 600000 });
      const rental = await new RentalsRepository(a as any).createRental({ rentalCode: code,
        customerId: customer.customerId, packageId: pkg.packageId, monthsRented: 1, buttonQuantity: 3,
        startDate: new Date(), endDate: new Date(Date.now() + 30 * 86400000), status: 'PENDING_PAYMENT', pricing });
      const charge = await a.billingCharge.findFirstOrThrow({ where: { targetType: 'RENTAL', targetId: rental.rentalId, purpose: 'RENTAL_INITIAL' } });
      await a.billingCharge.update({ where: { chargeId: charge.chargeId }, data: { paymentLinkId: code } });
      const voucher = await new StoreCashRepository(a as any).issueVoucher(user.userId, rental.rentalId, charge.chargeId, store.storeId);
      return {
        rental, charge, voucher, code,
        input: {
          chargeId: String(charge.chargeId),
          voucherToken: voucher.rawToken,
          handover: handoverMode,
          ...(buttonIds.length ? { buttonIds: buttonIds.map(String) } : {}),
        },
      };
    };
    const waitUntilBlocked = async (appName = run + '_b') => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const state = await a.$queryRawUnsafe<any[]>(
          `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock') AS blocked`, appName,
        );
        if (state[0]?.blocked) return;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      throw new Error(`Did not observe a real PostgreSQL row-lock wait for ${appName}; concurrency proof is inconclusive`);
    };

    // 1. Both cash calls overlap behind a real wallet lock; require observed DB wait.
    const first = await fixture();
    const held1 = deferred(), release1 = deferred();
    const holder1 = a.$transaction(async tx => {
      await tx.$queryRawUnsafe('SELECT wallet_id FROM store_wallets WHERE wallet_id = $1 FOR UPDATE', wallet.walletId);
      held1.resolve(); await release1.promise;
    }, { timeout: 15000 });
    await held1.promise;
    const concurrentCash = Promise.all([
      new StoreCashRepository(a as any).collect(store.storeId, first.rental.rentalId, owner.userId, first.input),
      new StoreCashRepository(b as any).collect(store.storeId, first.rental.rentalId, owner.userId, first.input),
    ]);
    const observedCash = concurrentCash.then(value => ({ value }), error => ({ error }));
    try { await waitUntilBlocked(run + '_b'); } finally { release1.resolve(); }
    await holder1;
    const outcomeCash = await observedCash;
    if ('error' in outcomeCash) throw outcomeCash.error;
    assert.deepEqual(outcomeCash.value.map(r => r.idempotent).sort(), [false, true]);
    const after = await a.storeWallet.findUniqueOrThrow({ where: { walletId: wallet.walletId } });
    assert.equal(after.balance.toNumber(), 310000); assert.equal(after.frozenBalance.toNumber(), 100000);
    assert.equal(await a.storeCashReceipt.count({ where: { chargeId: first.charge.chargeId } }), 1);
    assert.equal(await a.walletTransaction.count({ where: { walletId: wallet.walletId, type: 'RENTAL_CASH_COLLECTION_OFFSET', referenceId: String(first.charge.chargeId) } }), 1);
    const deposit = await a.rentalDeposit.findUniqueOrThrow({ where: { rentalId: first.rental.rentalId } });
    assert.equal(deposit.heldAmount.toNumber(), 600000);
    console.log('PASS real PostgreSQL cash/cash overlap: observed lock wait, one debit, one ledger/receipt, frozen unchanged');

    // 2. Late money still recorded with intake disabled; replay across connections.
    delete process.env.STORE_CASH_COLLECTION_ENABLED;
    const paidReceipt = { provider: 'PAYOS', providerTransactionCode: first.code + '_bank_ref', amount: 690000,
      currency: 'VND', verified: true as const, paymentLinkId: first.code };
    await new BillingChargesRepository(a as any).settleChargeAtomicTx(first.charge.chargeId, paidReceipt);
    await new BillingChargesRepository(b as any).settleChargeAtomicTx(first.charge.chargeId, paidReceipt);
    const inbound = await a.billingPaymentReceipt.findFirstOrThrow({ where: { chargeId: first.charge.chargeId } });
    assert.equal(inbound.classification, 'OVERPAYMENT_RECEIPT');
    assert.equal(await a.billingOverpaymentObligation.count({ where: { receiptId: inbound.id } }), 1);
    assert.equal((await a.rentalDeposit.findUniqueOrThrow({ where: { rentalId: first.rental.rentalId } })).heldAmount.toNumber(), 600000);
    console.log('PASS late PayOS + intake disabled + replay: one liability, no second deposit');

    // 3A. True concurrency race: Cash in-transaction barrier vs queuing PayOS.
    process.env.STORE_CASH_COLLECTION_ENABLED = 'true';
    const cashFirst = await fixture();
    const cashLocked = deferred(), allowCashCommit = deferred();
    const cashBarrierPrisma: any = {
      $transaction: (fn: any, options: any) => a.$transaction(async tx => {
        return fn(new Proxy(tx, {
          get(target: any, key: string) {
            if (key === '$queryRawUnsafe') {
              return async (query: string, ...args: any[]) => {
                const res = await target.$queryRawUnsafe(query, ...args);
                if (typeof query === 'string' && query.includes('billing_charges') && query.includes('FOR UPDATE')) {
                  cashLocked.resolve();
                  await allowCashCommit.promise;
                }
                return res;
              };
            }
            return typeof target[key] === 'function' ? target[key].bind(target) : target[key];
          },
        }));
      }, options),
    };

    const cashRun = new StoreCashRepository(cashBarrierPrisma).collect(store.storeId, cashFirst.rental.rentalId, owner.userId, cashFirst.input);
    const observedCashRun = cashRun.then(v => ({ v }), e => ({ e }));
    await cashLocked.promise;

    const queuedPayos = new BillingChargesRepository(b as any).settleChargeAtomicTx(cashFirst.charge.chargeId, {
      provider: 'PAYOS', providerTransactionCode: cashFirst.code + '_race_late', amount: 690000,
      currency: 'VND', verified: true as const, paymentLinkId: cashFirst.code,
    });
    const observedPayos = queuedPayos.then(v => ({ v }), e => ({ e }));
    try {
      await waitUntilBlocked(run + '_b');
    } finally {
      allowCashCommit.resolve();
    }
    const [resCash, resPayos] = await Promise.all([observedCashRun, observedPayos]);
    if ('e' in resCash) throw resCash.e;
    if ('e' in resPayos) throw resPayos.e;

    assert.equal(await a.storeCashReceipt.count({ where: { chargeId: cashFirst.charge.chargeId } }), 1);
    assert.equal((await a.storeWallet.findUniqueOrThrow({ where: { walletId: wallet.walletId } })).balance.toNumber(), 310000);
    const lateReceipt = await a.billingPaymentReceipt.findFirstOrThrow({ where: { chargeId: cashFirst.charge.chargeId } });
    assert.equal(lateReceipt.classification, 'OVERPAYMENT_RECEIPT');
    assert.equal(await a.billingOverpaymentObligation.count({ where: { receiptId: lateReceipt.id } }), 1);
    assert.equal((await a.rentalDeposit.findUniqueOrThrow({ where: { rentalId: cashFirst.rental.rentalId } })).heldAmount.toNumber(), 600000);
    console.log('PASS Cash in-tx barrier vs queuing PayOS: observed lock wait, Cash collected, PayOS classified as OVERPAYMENT_RECEIPT obligation, zero duplicate deposit');

    // 3B. True concurrency race: PayOS in-transaction barrier vs queuing Cash.
    const payosFirst = await fixture();
    const payosLocked = deferred(), allowPayosCommit = deferred();
    const payosBarrierPrisma: any = {
      $transaction: (fn: any, options: any) => a.$transaction(async tx => {
        return fn(new Proxy(tx, {
          get(target: any, key: string) {
            if (key === '$queryRawUnsafe') {
              return async (query: string, ...args: any[]) => {
                const res = await target.$queryRawUnsafe(query, ...args);
                if (typeof query === 'string' && query.includes('billing_charges') && query.includes('FOR UPDATE')) {
                  payosLocked.resolve();
                  await allowPayosCommit.promise;
                }
                return res;
              };
            }
            return typeof target[key] === 'function' ? target[key].bind(target) : target[key];
          },
        }));
      }, options),
    };

    const payosRun = new BillingChargesRepository(payosBarrierPrisma).settleChargeAtomicTx(payosFirst.charge.chargeId, {
      provider: 'PAYOS', providerTransactionCode: payosFirst.code + '_race_early', amount: 690000,
      currency: 'VND', verified: true as const, paymentLinkId: payosFirst.code,
    });
    const observedPayosRun = payosRun.then(v => ({ v }), e => ({ e }));
    await payosLocked.promise;

    const queuedCash = new StoreCashRepository(b as any).collect(store.storeId, payosFirst.rental.rentalId, owner.userId, payosFirst.input);
    const observedCashQueued = queuedCash.then(v => ({ v }), e => ({ e }));
    try {
      await waitUntilBlocked(run + '_b');
    } finally {
      allowPayosCommit.resolve();
    }
    const [resPayosEarly, resCashQueued] = await Promise.all([observedPayosRun, observedCashQueued]);
    if ('e' in resPayosEarly) throw resPayosEarly.e;
    assert.ok('e' in resCashQueued, 'Queued Cash collection must reject when charge was settled by PayOS');
    assert.match(resCashQueued.e.message, /CHARGE_ALREADY_PAID|Khoản thu đã thanh toán online|ConflictException/i);

    assert.equal((await a.storeWallet.findUniqueOrThrow({ where: { walletId: wallet.walletId } })).balance.toNumber(), 1000000);
    assert.equal(await a.storeCashReceipt.count({ where: { chargeId: payosFirst.charge.chargeId } }), 0);
    const payosSettledReceipt = await a.billingPaymentReceipt.findFirstOrThrow({ where: { chargeId: payosFirst.charge.chargeId } });
    assert.equal(payosSettledReceipt.classification, 'SETTLEMENT_RECEIPT');
    assert.equal(await a.billingOverpaymentObligation.count({ where: { receiptId: payosSettledReceipt.id } }), 0);
    assert.equal((await a.rentalDeposit.findUniqueOrThrow({ where: { rentalId: payosFirst.rental.rentalId } })).heldAmount.toNumber(), 600000);
    console.log('PASS PayOS in-tx barrier vs queuing Cash: observed lock wait, PayOS settled, Cash rejected with ConflictException, zero wallet debit, zero duplicate deposit');

    // 4. Repository lifecycle + verifier integration: Handover 3 buttons -> Customer return 1 button -> Store confirm ->
    // Concurrent approval with observed lock wait -> Provider verification -> Payout confirm.
    const btn1 = await a.ioTButton.create({ data: { storeId: store.storeId, hmacSecret: randomBytes(32).toString('hex'), deviceId: 'dev_' + run + '_1', buttonCode: 'btn_' + run + '_1',
      custodyStoreId: store.storeId, inventoryState: 'ALLOCATED_TO_STORE', status: 'INACTIVE', canOrder: false } });
    const btn2 = await a.ioTButton.create({ data: { storeId: store.storeId, hmacSecret: randomBytes(32).toString('hex'), deviceId: 'dev_' + run + '_2', buttonCode: 'btn_' + run + '_2',
      custodyStoreId: store.storeId, inventoryState: 'ALLOCATED_TO_STORE', status: 'INACTIVE', canOrder: false } });
    const btn3 = await a.ioTButton.create({ data: { storeId: store.storeId, hmacSecret: randomBytes(32).toString('hex'), deviceId: 'dev_' + run + '_3', buttonCode: 'btn_' + run + '_3',
      custodyStoreId: store.storeId, inventoryState: 'ALLOCATED_TO_STORE', status: 'INACTIVE', canOrder: false } });

    const fullCycle = await fixture('IMMEDIATE', [btn1.buttonId, btn2.buttonId, btn3.buttonId]);
    await new StoreCashRepository(a as any).collect(store.storeId, fullCycle.rental.rentalId, owner.userId, fullCycle.input);

    const activeBtns = await a.ioTButton.findMany({ where: { buttonId: { in: [btn1.buttonId, btn2.buttonId, btn3.buttonId] } } });
    assert.equal(activeBtns.length, 3);
    for (const b of activeBtns) {
      assert.equal(b.inventoryState, 'IN_CUSTOMER_CUSTODY');
      assert.equal(b.canOrder, true);
      assert.equal(b.status, 'ACTIVE');
      assert.equal(b.rentalId, fullCycle.rental.rentalId);
    }
    const contractAfterHandover = await a.buttonRental.findUniqueOrThrow({ where: { rentalId: fullCycle.rental.rentalId } });
    assert.equal(contractAfterHandover.status, 'ACTIVE');
    assert.equal(await a.deviceMovement.count({ where: { rentalId: fullCycle.rental.rentalId, destType: 'CUSTOMER' } }), 3);
    assert.equal((await a.rentalDeposit.findUniqueOrThrow({ where: { rentalId: fullCycle.rental.rentalId } })).heldAmount.toNumber(), 600000);

    // Customer requests return of 1 button (btn1)
    const returnReq = await new RentalsRepository(a as any).createReturnRequestTx(fullCycle.rental.rentalId, btn1.buttonId);
    const btn1Transit = await a.ioTButton.findUniqueOrThrow({ where: { buttonId: btn1.buttonId } });
    assert.equal(btn1Transit.inventoryState, 'RETURN_IN_TRANSIT');
    assert.equal(btn1Transit.canOrder, false);
    // Other two buttons remain fully operational
    const btn2Keep = await a.ioTButton.findUniqueOrThrow({ where: { buttonId: btn2.buttonId } });
    const btn3Keep = await a.ioTButton.findUniqueOrThrow({ where: { buttonId: btn3.buttonId } });
    assert.equal(btn2Keep.inventoryState, 'IN_CUSTOMER_CUSTODY'); assert.equal(btn2Keep.canOrder, true);
    assert.equal(btn3Keep.inventoryState, 'IN_CUSTOMER_CUSTODY'); assert.equal(btn3Keep.canOrder, true);

    // Anti-duplicate return request test
    await assert.rejects(
      () => new RentalsRepository(a as any).createReturnRequestTx(fullCycle.rental.rentalId, btn1.buttonId),
      /đang trong quá trình yêu cầu trả hàng/i,
    );

    // Store confirms receipt of btn1
    await new RentalsRepository(a as any).confirmReturnReceiptTx(
      returnReq.returnId,
      { userId: owner.userId, storeId: store.storeId, role: 'STORE_OWNER' },
      'Synthetic return inspection OK',
    );
    const btn1Store = await a.ioTButton.findUniqueOrThrow({ where: { buttonId: btn1.buttonId } });
    assert.equal(btn1Store.custodyStoreId, store.storeId);
    assert.equal(btn1Store.inventoryState, 'ALLOCATED_TO_STORE');
    assert.equal(btn1Store.canOrder, false);
    assert.equal(btn1Store.rentalId, null);
    assert.equal(await a.deviceMovement.count({ where: { buttonId: btn1.buttonId, sourceType: 'CUSTOMER', destType: 'STORE' } }), 1);

    // Deposit refund claim was created automatically with PENDING_APPROVAL and exactly 200k allocated
    const refundRecord = await a.depositRefund.findUniqueOrThrow({ where: { returnId: returnReq.returnId } });
    assert.equal(refundRecord.status, 'PENDING_APPROVAL');
    assert.equal(refundRecord.amount.toNumber(), 200000);
    const ledgerPreApproval = await a.rentalDeposit.findUniqueOrThrow({ where: { rentalId: fullCycle.rental.rentalId } });
    assert.equal(ledgerPreApproval.heldAmount.toNumber(), 600000);
    assert.equal(ledgerPreApproval.refundReservedAmount.toNumber(), 0);

    // Customer verified bank account fixture with real AES-256-GCM ciphertext
    const rawAccNum = '0123456789';
    const accHash = createHash('sha256').update(rawAccNum).digest('hex');
    process.env.BANK_ACCOUNT_ENCRYPTION_KEY = process.env.BANK_ACCOUNT_ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const encryptedAcc = CryptoVaultUtil.encryptAccountNumber(rawAccNum);
    assert.equal(CryptoVaultUtil.decryptAccountNumber(encryptedAcc), rawAccNum, 'Round-trip AES-256-GCM encryption/decryption must match raw account number');

    const bankAcc = await a.customerBankAccount.create({
      data: {
        customerId: customer.customerId,
        bankBin: '970422',
        bankName: 'MBBank',
        accountNumberEncrypted: encryptedAcc,
        accountNumberHash: accHash,
        accountNumberMasked: '******6789',
        accountName: 'SYNTHETIC CUSTOMER',
        verificationStatus: 'VERIFIED',
        isDefault: true,
      },
    });
    await a.depositRefund.update({ where: { refundId: refundRecord.refundId }, data: { bankAccountId: bankAcc.id } });

    // Concurrent approval with observed lock wait
    const held4 = deferred(), release4 = deferred();
    const holder4 = a.$transaction(async tx => {
      await tx.$queryRawUnsafe('SELECT refund_id FROM deposit_refunds WHERE refund_id = $1 FOR UPDATE', refundRecord.refundId);
      held4.resolve(); await release4.promise;
    }, { timeout: 15000 });
    await held4.promise;
    const queuedApproveB = new RentalsRepository(b as any).approveDepositRefundTx(refundRecord.refundId, { userId: owner.userId });
    const observedB = queuedApproveB.then(value => ({ value }), error => ({ error }));
    try {
      await waitUntilBlocked(run + '_b');
    } finally {
      release4.resolve();
    }
    await holder4;
    const resA = await new RentalsRepository(a as any).approveDepositRefundTx(refundRecord.refundId, { userId: owner.userId });
    const resB = await observedB;
    if ('error' in resB) throw resB.error;
    const oneProcessed = [resA.alreadyProcessed, resB.value.alreadyProcessed].filter(Boolean).length === 1;
    assert.ok(oneProcessed, 'Exactly one concurrent approval succeeds; second reports already processed');

    const refundApproved = await a.depositRefund.findUniqueOrThrow({ where: { refundId: refundRecord.refundId } });
    assert.equal(refundApproved.status, 'PENDING_PAYOUT');
    assert.equal(refundApproved.recipientBin, '970422');
    assert.equal(refundApproved.recipientAccountNumberHash, accHash);
    const ledgerPostApproval = await a.rentalDeposit.findUniqueOrThrow({ where: { rentalId: fullCycle.rental.rentalId } });
    assert.equal(ledgerPostApproval.heldAmount.toNumber(), 400000);
    assert.equal(ledgerPostApproval.refundReservedAmount.toNumber(), 200000);
    assert.equal(ledgerPostApproval.refundedAmount.toNumber(), 0);

    // Provider evidence verification via deposit-payout-verifier
    const invalidAmountEvidence = {
      id: 'payos_payout_' + run,
      approvalState: 'COMPLETED',
      transactions: [{ reference: refundApproved.refundCode, state: 'SUCCEEDED', amount: 150000, toBin: '970422', toAccountNumber: rawAccNum }],
    };
    const invalidAmountCheck = verifyDepositRefundPayoutEvidence(invalidAmountEvidence, refundApproved);
    assert.equal(invalidAmountCheck.isVerified, false, 'Tampered/mismatched amount must fail provider verification');

    const invalidAccountEvidence = {
      id: 'payos_payout_' + run,
      approvalState: 'COMPLETED',
      transactions: [{ reference: refundApproved.refundCode, state: 'SUCCEEDED', amount: 200000, toBin: '970422', toAccountNumber: '9999999999' }],
    };
    const invalidAccountCheck = verifyDepositRefundPayoutEvidence(invalidAccountEvidence, refundApproved);
    assert.equal(invalidAccountCheck.isVerified, false, 'Tampered/mismatched recipient account must fail provider verification');

    const validEvidence = {
      id: 'payos_payout_' + run,
      approvalState: 'COMPLETED',
      transactions: [{ reference: refundApproved.refundCode, state: 'SUCCEEDED', amount: 200000, toBin: '970422', toAccountNumber: rawAccNum }],
    };
    const validCheck = verifyDepositRefundPayoutEvidence(validEvidence, refundApproved);
    assert.equal(validCheck.isVerified, true, 'Matching evidence must pass verification');

    // Confirm payout execution
    const payoutConfirmed = await new RentalsRepository(a as any).confirmDepositRefundPayoutTx(refundRecord.refundId, validCheck.providerRef);
    assert.equal(payoutConfirmed.status || payoutConfirmed.refund?.status, 'REFUNDED');
    const ledgerFinal = await a.rentalDeposit.findUniqueOrThrow({ where: { rentalId: fullCycle.rental.rentalId } });
    assert.equal(ledgerFinal.heldAmount.toNumber(), 400000);
    assert.equal(ledgerFinal.refundReservedAmount.toNumber(), 0);
    assert.equal(ledgerFinal.refundedAmount.toNumber(), 200000);
    assert.equal(ledgerFinal.heldAmount.toNumber() + ledgerFinal.refundReservedAmount.toNumber() + ledgerFinal.refundedAmount.toNumber(), 600000);

    // Buttons 2 and 3 remain customer-custody and enabled
    const btn2Final = await a.ioTButton.findUniqueOrThrow({ where: { buttonId: btn2.buttonId } });
    const btn3Final = await a.ioTButton.findUniqueOrThrow({ where: { buttonId: btn3.buttonId } });
    assert.equal(btn2Final.inventoryState, 'IN_CUSTOMER_CUSTODY'); assert.equal(btn2Final.canOrder, true);
    assert.equal(btn3Final.inventoryState, 'IN_CUSTOMER_CUSTODY'); assert.equal(btn3Final.canOrder, true);
    console.log('PASS repository return/refund lifecycle + verifier integration: 3-button handover -> 1 return -> store receipt -> locked approve -> verifier check -> payout REFUNDED, ledger strictly conserved (400k held, 200k refunded)');

    // 5. JS exception after a real SQL receipt INSERT rolls back the real transaction.
    const fault = await fixture();
    const faultPrisma: any = { $transaction: (fn: any, options: any) => a.$transaction(tx => fn(new Proxy(tx, {
      get(target: any, key: string) {
        if (key === 'storeCashReceipt') return new Proxy(target.storeCashReceipt, {
          get(delegate: any, method: string) {
            if (method === 'create') return async (args: any) => { await delegate.create(args); throw new Error('SCOPED_TEST_FAULT_AFTER_RECEIPT_INSERT'); };
            return typeof delegate[method] === 'function' ? delegate[method].bind(delegate) : delegate[method];
          },
        });
        return typeof target[key] === 'function' ? target[key].bind(target) : target[key];
      },
    })), options) };
    await assert.rejects(() => new StoreCashRepository(faultPrisma).collect(store.storeId, fault.rental.rentalId, owner.userId, fault.input), /SCOPED_TEST_FAULT_AFTER_RECEIPT_INSERT/);
    assert.equal((await a.storeWallet.findUniqueOrThrow({ where: { walletId: wallet.walletId } })).balance.toNumber(), 1000000);
    assert.equal((await a.billingCharge.findUniqueOrThrow({ where: { chargeId: fault.charge.chargeId } })).status, 'PENDING');
    assert.equal((await a.storeCashVoucher.findUniqueOrThrow({ where: { id: fault.voucher.voucherId } })).status, 'ACTIVE');
    assert.equal(await a.storeCashReceipt.count({ where: { chargeId: fault.charge.chargeId } }), 0);
    assert.equal(await a.rentalDeposit.count({ where: { rentalId: fault.rental.rentalId } }), 0);
    assert.equal(await a.walletTransaction.count({ where: { walletId: wallet.walletId, type: 'RENTAL_CASH_COLLECTION_OFFSET', referenceId: String(fault.charge.chargeId) } }), 0);
    console.log('PASS actual PostgreSQL rollback after receipt INSERT: wallet, voucher, charge, ledger and deposit reverted');

    // 6. SQL Snapshot Immutability: Specific trigger error check and re-read proof.
    await assert.rejects(
      () => a.buttonRental.update({ where: { rentalId: first.rental.rentalId }, data: { monthlyRentPerButtonSnapshot: 1 } }),
      (err: any) => {
        const fullErrText = String(err?.message || '') + ' ' + JSON.stringify(err?.meta || {});
        return fullErrText.includes('Rental monthly price snapshot is immutable');
      },
    );
    const recheckSnapshot = await a.buttonRental.findUniqueOrThrow({ where: { rentalId: first.rental.rentalId } });
    assert.equal(recheckSnapshot.monthlyRentPerButtonSnapshot?.toNumber(), 30000);
    console.log(`PASS immutable snapshot constraint: verified trigger rejection message 'Rental monthly price snapshot is immutable' and snapshot unchanged at 30,000 VND. Run ${run} retained for audit.`);
  } finally {
    await Promise.all([a.$disconnect(), b.$disconnect()]);
    if (oldFlag === undefined) delete process.env.STORE_CASH_COLLECTION_ENABLED;
    else process.env.STORE_CASH_COLLECTION_ENABLED = oldFlag;
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
