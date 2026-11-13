import assert from 'node:assert/strict';
import { normalizeBankBin, bankBinsMatch, bankEvidenceKey } from '../src/common/utils/bank-identifier.util';
import { CustomersRepository } from '../src/customers/customers.repository';
import { BankVerificationService } from '../src/bank-verification/bank-verification.service';
import { CryptoVaultUtil } from '../src/common/utils/crypto-vault.util';
import { BANK_CITAD_CATALOG } from '../src/common/utils/bank-citad-catalog';
import { BankVerificationRepository } from '../src/bank-verification/bank-verification.repository';

async function run() {
  process.env.NODE_ENV = 'test';
  assert.equal(normalizeBankBin(' 01358001 '), '970423');
  assert.equal(normalizeBankBin('970423'), '970423');
  for (const value of [null, undefined, '', '99358001', '99999999', '970999', '__proto__', 'TPB', '97042x']) {
    assert.equal(normalizeBankBin(value), null);
  }
  assert(bankBinsMatch('01358001', '970423'));
  assert(!bankBinsMatch('01358001', '970422'));
  assert(!bankBinsMatch('99999999', '99999999'));
  assert.equal(bankEvidenceKey('01358001'), bankEvidenceKey('970423'));
  assert.notEqual(bankEvidenceKey('99999999'), bankEvidenceKey('88888888'));
  // All exact branch entries resolve; an unlisted code sharing the institution digits does not.
  for (const bank of BANK_CITAD_CATALOG) {
    for (const citad of bank.citadCodes) assert.equal(normalizeBankBin(citad), bank.bin);
  }
  const bankCases = [
    ['01201001', '970415'], ['01202001', '970418'], ['01203001', '970436'],
    ['01204001', '970405'], ['01307001', '970416'], ['01309001', '970432'],
    ['01310001', '970407'], ['01311033', '970422'], ['01358002', '970423'],
  ];
  for (const [citad, bin] of bankCases) {
    assert(bankBinsMatch(citad, bin));
    assert(!bankBinsMatch(citad, bin === '970423' ? '970422' : '970423'));
  }

  // Exercise the real locked repository decision, without a database or provider.
  async function receive(bank: string, hash: string, sufficient = true, late = false) {
    let inbound: any;
    let obligation: any;
    let activationWrites = 0;
    const account = { id: 1n, customer_id: 1n, verification_status: 'PENDING' };
    const session = { id: 2n, bank_bin: '970423', account_number_hash: 'dummy-account-hash',
      session_status: 'ACTIVE', used_at: null, expires_at: new Date(Date.now() + (late ? -600000 : 600000)) };
    const tx: any = {
      $queryRaw: async (sql: TemplateStringsArray) => sql.join('').includes('FROM customer_bank_accounts') ? [account] : [session],
      $executeRaw: async () => { activationWrites++; return 1; },
      customerBankVerificationProof: { findUnique: async () => ({ accountId: 1n, customerId: 1n }), updateMany: async () => ({ count: 1 }) },
      customerBankInboundTransaction: { create: async ({ data }: any) => (inbound = { id: 3n, ...data }) },
      customerBankRefundObligation: { create: async ({ data }: any) => (obligation = { id: 4n, ...data }) },
    };
    const repo = new CustomersRepository({ $transaction: async (fn: any) => fn(tx) } as any);
    await repo.recordInboundTransactionAndObligationAtomicTx({ proofId: 2n, provider: 'PAYOS', channel: 'PAYOS_WEBHOOK',
      providerTransactionRef: 'DUMMY-REFERENCE', amount: 2000, receivedAt: new Date(), sourceBankBin: bank,
      sourceAccountHash: hash, sourceAccountMasked: '******1234', sourceAccountEncrypted: 'dummy-encrypted-account',
      hasSufficientEvidence: sufficient, refundPayoutReference: 'DUMMY-REFUND' });
    return { inbound, obligation, activationWrites };
  }
  const same = await receive('01358001', 'dummy-account-hash');
  assert.equal(same.inbound.matchDecision, 'MATCHED');
  assert.equal(same.inbound.sourceBankBin, '01358001'); // Preserve provider evidence.
  assert.equal(same.obligation.targetBankBin, '970423');
  assert.equal(same.activationWrites, 2);
  const wrongBank = await receive('970422', 'dummy-account-hash');
  assert.equal(wrongBank.inbound.matchDecision, 'MISMATCH_BIN');
  assert.equal(wrongBank.activationWrites, 0);
  assert.equal((await receive('01358001', 'different-hash')).activationWrites, 0);
  const unknown = await receive('99999999', 'dummy-account-hash', true);
  assert.equal(unknown.inbound.matchDecision, 'INSUFFICIENT_DATA');
  assert.equal(unknown.activationWrites, 0);
  assert.equal(unknown.obligation.refundStatus, 'PENDING_MANUAL_REFUND');
  assert.equal(unknown.obligation.targetBankBin, null);
  assert.equal((await receive('01358001', 'dummy-account-hash', false)).activationWrites, 0);
  assert.equal((await receive('01358001', 'dummy-account-hash', true, true)).activationWrites, 0);

  // Store uses the same source normalization and keeps an unknown bank pending.
  async function storeReceive(senderBin: string) {
    const accountNumber = '123456789';
    const account = { id: 10n, store_id: 1n, bank_bin: '970422',
      account_number_encrypted: CryptoVaultUtil.encryptAccountNumber(accountNumber),
      account_number_hash: CryptoVaultUtil.computeDeterministicAccountHash(accountNumber) };
    const verification = { id: 20n, bank_account_id: 10n, status: 'PENDING',
      provider_transaction_id: '123', expected_amount: 2000, expires_at: new Date(Date.now() + 600000) };
    const tx: any = {
      $queryRaw: async (sql: TemplateStringsArray) => {
        const text = sql.join('');
        if (text.includes('FROM bank_account_verification_transactions') && text.includes('WHERE reference_code')) return [verification];
        if (text.includes('FROM store_bank_accounts')) return [account];
        if (text.includes('INSERT INTO store_bank_inbound_receipts')) return [{ id: 30n }];
        return [];
      },
      $executeRaw: async () => 1,
    };
    const repo = new BankVerificationRepository({ $transaction: async (fn: any) => fn(tx) } as any);
    return repo.executeAtomicWebhookVerificationTx({ referenceCode: 'DUMMY-STORE-SESSION', receivedAmount: 2000,
      providerTransactionId: 'DUMMY-STORE-TRANSACTION', orderCode: 123, senderAccountNumber: accountNumber,
      senderBankBin: senderBin });
  }
  assert.equal((await storeReceive('01311033')).success, true);
  const pendingStore = await storeReceive('99999999');
  assert.equal(pendingStore.reason, 'SENDER_BANK_UNVERIFIABLE');
  assert.equal(pendingStore.transaction.status, 'PENDING');
  assert.equal(pendingStore.needsRefund, false);
  assert.equal((await storeReceive('01358001')).reason, 'SENDER_BANK_MISMATCH');

  // Legacy store refund snapshots containing CITAD must dispatch with a BIN.
  let dispatched: any;
  const encrypted = CryptoVaultUtil.encryptAccountNumber('123456789');
  const obligation: any = { id: 1n, refundStatus: 'PENDING_REFUND', refundAmount: 2000,
    targetBankBin: '01358001', targetAccountEncrypted: encrypted };
  const store = new BankVerificationService(
    { storeBankRefundObligation: { findFirst: async () => obligation } } as any,
    { claimRefundObligationForDispatch: async () => true, updateTransactionRefundStatus: async () => {},
      markObligationDispatchedByReference: async () => {} } as any,
    { createRefund: async (params: any) => { dispatched = params; return { status: 'PENDING' }; } } as any,
    {} as any,
  );
  await store.triggerAutomatedRefund(1n, 'DUMMY-STORE-REF');
  assert.equal(dispatched.bankBin, '970423');
  assert.equal(dispatched.amount, 2000);
  dispatched = undefined;
  obligation.targetBankBin = '99999999';
  await store.triggerAutomatedRefund(1n, 'DUMMY-STORE-REF');
  assert.equal(dispatched, undefined);
  console.log('PASS: bank aliases, customer receipt/activation/refund and store refund normalization (mocked IO).');
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
