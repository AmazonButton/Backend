import assert from 'node:assert';
import { AdminService } from '../src/admin/admin.service';
import { CryptoVaultUtil } from '../src/common/utils/crypto-vault.util';

async function run() {
  console.log('🧪 Testing Task 3: Admin Payout & Race-condition invariants...');

  let refundCalled = false;
  let markedPendingReconciliation = false;
  let updatedStatus: string | null = null;

  const mockAdminRepo = {
    claimPendingWithdrawal: async (_id: bigint) => true,
    findWithdrawalById: async (_id: bigint) => ({
      withdrawalId: BigInt(123),
      withdrawalCode: 'WTH123',
      storeId: BigInt(1),
      amount: 500000,
      walletId: BigInt(10),
      status: 'PROCESSING',
      providerReferenceId: 'WTH123',
    }),
    updateWithdrawal: async (_id: bigint, data: any) => {
      updatedStatus = data.status;
      return { withdrawalId: _id, ...data };
    },
    markWithdrawalPendingReconciliation: async (_id: bigint, _reason: string) => {
      markedPendingReconciliation = true;
      updatedStatus = 'PENDING_RECONCILIATION';
      return { withdrawalId: _id, status: 'PENDING_RECONCILIATION' };
    },
    refundFailedWithdrawalTransaction: async () => {
      refundCalled = true;
    },
  };

  const mockPayosPayoutService = {
    createPayout: async () => {
      const timeoutErr = new Error('ETIMEDOUT connection to api-merchant.payos.vn timed out');
      (timeoutErr as any).code = 'ETIMEDOUT';
      throw timeoutErr;
    },
  };

  const adminService = new AdminService(
    mockAdminRepo as any,
    mockPayosPayoutService as any,
    {} as any,
  );
  // Stub cache invalidation
  (adminService as any).invalidateAdminAndStoreCaches = async () => {};

  // Test 1: Payout timeout must NOT auto-refund wallet, must mark PENDING_RECONCILIATION
  try {
    await adminService.payoutViaPayOS(BigInt(123), { userId: BigInt(1) });
    assert.fail('Should have thrown an exception on payout timeout');
  } catch (err: any) {
    assert.strictEqual(
      refundCalled,
      false,
      'CRITICAL SECURITY FLAW: Wallet was auto-refunded during PayOS timeout! Must NOT refund.',
    );
    assert.strictEqual(
      markedPendingReconciliation || updatedStatus === 'PENDING_RECONCILIATION',
      true,
      `Expected status PENDING_RECONCILIATION but got ${updatedStatus}`,
    );
  }

  // Test 2: Reject must be rejected if withdrawal is not PENDING
  try {
    await adminService.rejectWithdrawal(BigInt(123), 'Từ chối thử', { userId: BigInt(1) });
    assert.fail('Should have thrown an exception when rejecting non-PENDING withdrawal');
  } catch (err: any) {
    assert.strictEqual(
      err.message.includes('không thể từ chối'),
      true,
      `Expected error about non-PENDING state but got: ${err.message}`,
    );
  }

  // Test 3: Recovery via reference with list response shape and strict recipient & transaction evidence
  let finalizedId: bigint | null = null;
  const standardAccount = '19034567891234';
  const standardAccountHash = CryptoVaultUtil.computeDeterministicAccountHash(standardAccount);

  const baseWithdrawalSnapshot = {
    withdrawalId: BigInt(456),
    withdrawalCode: 'WTH456',
    storeId: BigInt(2),
    amount: 100000,
    walletId: BigInt(20),
    status: 'PENDING_RECONCILIATION',
    providerReferenceId: 'REF_WTH456',
    bankBinSnapshot: '970422',
    bankAccountNameSnapshot: 'STORE OWNER A',
    bankAccountHash: standardAccountHash,
  };

  const createMockRepo = (customWithdrawal: any = {}) => ({
    findWithdrawalById: async (_id: bigint) => ({
      ...baseWithdrawalSnapshot,
      ...customWithdrawal,
    }),
    finalizeSucceededWithdrawalTransaction: async (id: bigint) => {
      finalizedId = id;
    },
    refundFailedWithdrawalTransaction: async () => {},
  });

  const validPayosService = {
    getPayouts: async () => ({
      code: '00',
      desc: 'success',
      data: {
        payouts: [
          {
            id: 'pay_matched_1',
            referenceId: 'REF_WTH456',
            amount: 100000,
            approvalState: 'SUCCEEDED',
          },
          {
            id: 'pay_unrelated_2',
            referenceId: 'REF_OTHER',
            amount: 500000,
            approvalState: 'SUCCEEDED',
          },
        ],
      },
    }),
    getPayout: async (id: string) => ({
      code: '00',
      data: {
        id,
        referenceId: 'REF_WTH456',
        approvalState: 'SUCCEEDED',
        transactions: [
          {
            id: 'tx_matched_1',
            referenceId: 'REF_WTH456',
            amount: 100000,
            state: 'SUCCEEDED',
            toBin: '970422',
            toAccountNumber: standardAccount,
            toAccountName: 'STORE OWNER A',
          },
        ],
      },
    }),
  };

  const adminServiceSync = new AdminService(
    createMockRepo() as any,
    validPayosService as any,
    {} as any,
  );
  (adminServiceSync as any).invalidateAdminAndStoreCaches = async () => {};

  const syncSuccessRes = await adminServiceSync.syncPayoutStatus(BigInt(456));
  assert.strictEqual(
    finalizedId,
    BigInt(456),
    'Expected syncPayoutStatus to correctly resolve reference and finalize withdrawal when all evidence matches',
  );
  assert.strictEqual(syncSuccessRes.reconciliation?.outcome, 'SUCCESS');
  assert.strictEqual(syncSuccessRes.reconciliation?.reasonCode, 'PAYOUT_VERIFIED_SUCCESS');
  assert.strictEqual((syncSuccessRes as any).statusData, undefined, 'Must NOT return raw statusData');

  // Verify data leakage prevention across full serialized JSON response
  const jsonStr = JSON.stringify(syncSuccessRes);
  assert.strictEqual(jsonStr.includes(standardAccount), false, 'JSON must NOT contain plaintext account number');
  assert.strictEqual(jsonStr.includes(standardAccountHash), false, 'JSON must NOT contain internal bankAccountHash');
  assert.strictEqual(syncSuccessRes.withdrawal.bankAccountMasked.startsWith('******'), true, 'Withdrawal must be mapped with masked account');

  // 3.1. Missing amount or 0 or NaN must NOT finalize
  finalizedId = null;
  const mockPayosMissingAmount = {
    getPayouts: validPayosService.getPayouts,
    getPayout: async (id: string) => ({
      code: '00',
      data: {
        id,
        referenceId: 'REF_WTH456',
        transactions: [
          {
            id: 'tx_1',
            referenceId: 'REF_WTH456',
            amount: 0,
            state: 'SUCCEEDED',
            toBin: '970422',
            toAccountNumber: standardAccount,
          },
        ],
      },
    }),
  };
  const adminServiceZeroAmount = new AdminService(createMockRepo() as any, mockPayosMissingAmount as any, {} as any);
  (adminServiceZeroAmount as any).invalidateAdminAndStoreCaches = async () => {};
  const resZero = await adminServiceZeroAmount.syncPayoutStatus(BigInt(456));
  assert.strictEqual(finalizedId, null, 'Must NOT finalize when amount is 0 or missing');
  assert.strictEqual(resZero.message?.includes('không hợp lệ'), true);

  // 3.2. Detail lookup error must NOT fall back to summary and finalize
  finalizedId = null;
  const mockPayosDetailFails = {
    getPayouts: validPayosService.getPayouts,
    getPayout: async () => {
      throw new Error('PayOS internal 500 error');
    },
  };
  const adminServiceDetailFails = new AdminService(createMockRepo() as any, mockPayosDetailFails as any, {} as any);
  (adminServiceDetailFails as any).invalidateAdminAndStoreCaches = async () => {};
  const resDetailFail = await adminServiceDetailFails.syncPayoutStatus(BigInt(456));
  assert.strictEqual(finalizedId, null, 'Must NOT finalize with summary when detail lookup fails');
  assert.strictEqual(resDetailFail.message?.includes('Lỗi khi lấy chi tiết payout'), true);

  // 3.3. Recipient BIN mismatch must NOT finalize
  finalizedId = null;
  const mockPayosMismatchBin = {
    getPayouts: validPayosService.getPayouts,
    getPayout: async (id: string) => ({
      code: '00',
      data: {
        id,
        referenceId: 'REF_WTH456',
        transactions: [
          {
            id: 'tx_1',
            referenceId: 'REF_WTH456',
            amount: 100000,
            state: 'SUCCEEDED',
            toBin: '970415', // Vietinbank instead of MB 970422
            toAccountNumber: standardAccount,
          },
        ],
      },
    }),
  };
  const adminServiceMismatchBin = new AdminService(createMockRepo() as any, mockPayosMismatchBin as any, {} as any);
  (adminServiceMismatchBin as any).invalidateAdminAndStoreCaches = async () => {};
  const resMismatchBin = await adminServiceMismatchBin.syncPayoutStatus(BigInt(456));
  assert.strictEqual(finalizedId, null, 'Must NOT finalize when recipient BIN mismatches');
  assert.strictEqual(resMismatchBin.message?.includes('Mã ngân hàng (BIN)'), true);

  // 3.4. Same name, same bank BIN, but DIFFERENT account number must NOT finalize (Finding 3)
  finalizedId = null;
  const mockPayosMismatchAcc = {
    getPayouts: validPayosService.getPayouts,
    getPayout: async (id: string) => ({
      code: '00',
      data: {
        id,
        referenceId: 'REF_WTH456',
        transactions: [
          {
            id: 'tx_1',
            referenceId: 'REF_WTH456',
            amount: 100000,
            state: 'SUCCEEDED',
            toBin: '970422',
            toAccountNumber: '999999999999', // Different account number!
            toAccountName: 'STORE OWNER A',
          },
        ],
      },
    }),
  };
  const adminServiceMismatchAcc = new AdminService(createMockRepo() as any, mockPayosMismatchAcc as any, {} as any);
  (adminServiceMismatchAcc as any).invalidateAdminAndStoreCaches = async () => {};
  const resMismatchAcc = await adminServiceMismatchAcc.syncPayoutStatus(BigInt(456));
  assert.strictEqual(finalizedId, null, 'Must NOT finalize when account number mismatches even if name and BIN match');
  assert.strictEqual(resMismatchAcc.message?.includes('Định danh số tài khoản'), true);

  // 3.5. Missing or inconsistent snapshot in withdrawal record (Finding 2 & 3)
  // 3.5a: Only plaintext bankAccountNumber without hash or ciphertext -> MUST NOT finalize/refund
  finalizedId = null;
  const adminServicePlaintextOnly = new AdminService(
    createMockRepo({ bankBinSnapshot: '970422', bankAccountHash: null, bankAccountEncrypted: null, bankAccountNumber: standardAccount }) as any,
    validPayosService as any,
    {} as any,
  );
  (adminServicePlaintextOnly as any).invalidateAdminAndStoreCaches = async () => {};
  const resPlaintextOnly = await adminServicePlaintextOnly.syncPayoutStatus(BigInt(456));
  assert.strictEqual(finalizedId, null, 'Must NOT finalize when withdrawal only has plaintext and lacks snapshot');
  assert.strictEqual(resPlaintextOnly.reconciliation?.reasonCode, 'MISSING_SNAPSHOT');

  // 3.5b: Hash wrong but ciphertext right -> MUST detect inconsistent snapshot and halt
  finalizedId = null;
  const adminServiceTamperedHash = new AdminService(
    createMockRepo({
      bankBinSnapshot: '970422',
      bankAccountHash: 'tampered_or_wrong_hash_value_123',
      bankAccountEncrypted: CryptoVaultUtil.encryptAccountNumber(standardAccount),
    }) as any,
    validPayosService as any,
    {} as any,
  );
  (adminServiceTamperedHash as any).invalidateAdminAndStoreCaches = async () => {};
  const resTamperedHash = await adminServiceTamperedHash.syncPayoutStatus(BigInt(456));
  assert.strictEqual(finalizedId, null, 'Must NOT finalize when hash and ciphertext contradict each other');
  assert.strictEqual(resTamperedHash.reconciliation?.reasonCode, 'INCONSISTENT_SNAPSHOT');

  // 3.5c: Hash right but ciphertext represents a DIFFERENT account -> MUST detect inconsistent snapshot and halt
  finalizedId = null;
  const adminServiceContradictoryCiphertext = new AdminService(
    createMockRepo({
      bankBinSnapshot: '970422',
      bankAccountHash: standardAccountHash,
      bankAccountEncrypted: CryptoVaultUtil.encryptAccountNumber('98765432109876'), // Different account encrypted!
    }) as any,
    validPayosService as any,
    {} as any,
  );
  (adminServiceContradictoryCiphertext as any).invalidateAdminAndStoreCaches = async () => {};
  const resContradictoryCipher = await adminServiceContradictoryCiphertext.syncPayoutStatus(BigInt(456));
  assert.strictEqual(finalizedId, null, 'Must NOT finalize when ciphertext represents different account than hash');
  assert.strictEqual(resContradictoryCipher.reconciliation?.reasonCode, 'INCONSISTENT_SNAPSHOT');

  // 3.5d: Consistent snapshot (both hash and encrypted match same account) -> allows reconciliation
  finalizedId = null;
  const adminServiceConsistentSnapshot = new AdminService(
    createMockRepo({
      bankBinSnapshot: '970422',
      bankAccountHash: standardAccountHash,
      bankAccountEncrypted: CryptoVaultUtil.encryptAccountNumber(standardAccount),
    }) as any,
    validPayosService as any,
    {} as any,
  );
  (adminServiceConsistentSnapshot as any).invalidateAdminAndStoreCaches = async () => {};
  const resConsistent = await adminServiceConsistentSnapshot.syncPayoutStatus(BigInt(456));
  assert.strictEqual(finalizedId, BigInt(456), 'Consistent snapshot must successfully finalize');
  assert.strictEqual(resConsistent.reconciliation?.outcome, 'SUCCESS');

  // 3.6. Missing provider recipient evidence (toAccountNumber missing) must NOT finalize (Finding 3)
  finalizedId = null;
  const mockPayosMissingAcc = {
    getPayouts: validPayosService.getPayouts,
    getPayout: async (id: string) => ({
      code: '00',
      data: {
        id,
        referenceId: 'REF_WTH456',
        transactions: [
          {
            id: 'tx_1',
            referenceId: 'REF_WTH456',
            amount: 100000,
            state: 'SUCCEEDED',
            toBin: '970422',
            toAccountNumber: '', // Missing account number!
          },
        ],
      },
    }),
  };
  const adminServiceMissingAcc = new AdminService(createMockRepo() as any, mockPayosMissingAcc as any, {} as any);
  (adminServiceMissingAcc as any).invalidateAdminAndStoreCaches = async () => {};
  const resMissingAcc = await adminServiceMissingAcc.syncPayoutStatus(BigInt(456));
  assert.strictEqual(finalizedId, null, 'Must NOT finalize when provider omits recipient account');
  assert.strictEqual(resMissingAcc.message?.includes('Thiếu định danh số tài khoản'), true);

  // 3.7. Missing or empty transactions array in detail must NOT finalize (Finding 4)
  finalizedId = null;
  const mockPayosEmptyTxs = {
    getPayouts: validPayosService.getPayouts,
    getPayout: async (id: string) => ({
      code: '00',
      data: {
        id,
        referenceId: 'REF_WTH456',
        transactions: [], // Empty transactions array!
      },
    }),
  };
  const adminServiceEmptyTxs = new AdminService(createMockRepo() as any, mockPayosEmptyTxs as any, {} as any);
  (adminServiceEmptyTxs as any).invalidateAdminAndStoreCaches = async () => {};
  const resEmptyTxs = await adminServiceEmptyTxs.syncPayoutStatus(BigInt(456));
  assert.strictEqual(finalizedId, null, 'Must NOT finalize when transactions array is empty');
  assert.strictEqual(resEmptyTxs.message?.includes('thiếu danh sách giao dịch'), true);

  // 3.8. Detail with wrong payout ID (detail.id !== expectedId) must NOT finalize (Finding 4)
  finalizedId = null;
  const mockPayosWrongId = {
    getPayouts: validPayosService.getPayouts,
    getPayout: async () => ({
      code: '00',
      data: {
        id: 'pay_WRONG_ID_999', // Detail has completely different ID!
        referenceId: 'REF_WTH456',
        transactions: [
          {
            id: 'tx_1',
            referenceId: 'REF_WTH456',
            amount: 100000,
            state: 'SUCCEEDED',
            toBin: '970422',
            toAccountNumber: standardAccount,
          },
        ],
      },
    }),
  };
  const adminServiceWrongId = new AdminService(createMockRepo() as any, mockPayosWrongId as any, {} as any);
  (adminServiceWrongId as any).invalidateAdminAndStoreCaches = async () => {};
  const resWrongId = await adminServiceWrongId.syncPayoutStatus(BigInt(456));
  assert.strictEqual(finalizedId, null, 'Must NOT finalize when detail payout ID mismatches expected lookup ID');
  assert.strictEqual(resWrongId.message?.includes('không khớp với ID đã yêu cầu'), true);

  // 3.9. Transaction missing state must NOT finalize (Finding 4)
  finalizedId = null;
  const mockPayosMissingState = {
    getPayouts: validPayosService.getPayouts,
    getPayout: async (id: string) => ({
      code: '00',
      data: {
        id,
        referenceId: 'REF_WTH456',
        transactions: [
          {
            id: 'tx_1',
            referenceId: 'REF_WTH456',
            amount: 100000,
            state: '', // Missing state!
            toBin: '970422',
            toAccountNumber: standardAccount,
          },
        ],
      },
    }),
  };
  const adminServiceMissingState = new AdminService(createMockRepo() as any, mockPayosMissingState as any, {} as any);
  (adminServiceMissingState as any).invalidateAdminAndStoreCaches = async () => {};
  const resMissingState = await adminServiceMissingState.syncPayoutStatus(BigInt(456));
  assert.strictEqual(finalizedId, null, 'Must NOT finalize when transaction has no state');
  assert.strictEqual(resMissingState.message?.includes('thiếu trạng thái (state)'), true);

  // 3.10. Multiple transactions matching reference must NOT finalize (Finding 4)
  finalizedId = null;
  const mockPayosDuplicateRef = {
    getPayouts: validPayosService.getPayouts,
    getPayout: async (id: string) => ({
      code: '00',
      data: {
        id,
        referenceId: 'REF_WTH456',
        transactions: [
          {
            id: 'tx_1',
            referenceId: 'REF_WTH456',
            amount: 100000,
            state: 'SUCCEEDED',
            toBin: '970422',
            toAccountNumber: standardAccount,
          },
          {
            id: 'tx_2',
            referenceId: 'REF_WTH456',
            amount: 100000,
            state: 'SUCCEEDED',
            toBin: '970422',
            toAccountNumber: standardAccount,
          },
        ],
      },
    }),
  };
  const adminServiceDuplicateRef = new AdminService(createMockRepo() as any, mockPayosDuplicateRef as any, {} as any);
  (adminServiceDuplicateRef as any).invalidateAdminAndStoreCaches = async () => {};
  const resDuplicateRef = await adminServiceDuplicateRef.syncPayoutStatus(BigInt(456));
  assert.strictEqual(finalizedId, null, 'Must NOT finalize when multiple transactions match reference');
  assert.strictEqual(resDuplicateRef.message?.includes('nhiều hơn một giao dịch'), true);

  // 3.11. Transaction with wrong referenceId (none match) must NOT finalize (Finding 4)
  finalizedId = null;
  const mockPayosWrongRef = {
    getPayouts: validPayosService.getPayouts,
    getPayout: async (id: string) => ({
      code: '00',
      data: {
        id,
        referenceId: 'REF_WTH456',
        transactions: [
          {
            id: 'tx_other',
            referenceId: 'REF_COMPLETELY_DIFFERENT',
            amount: 100000,
            state: 'SUCCEEDED',
            toBin: '970422',
            toAccountNumber: standardAccount,
          },
        ],
      },
    }),
  };
  const adminServiceWrongRef = new AdminService(createMockRepo() as any, mockPayosWrongRef as any, {} as any);
  (adminServiceWrongRef as any).invalidateAdminAndStoreCaches = async () => {};
  const resWrongRef = await adminServiceWrongRef.syncPayoutStatus(BigInt(456));
  assert.strictEqual(finalizedId, null, 'Must NOT finalize when no transactions match reference');
  assert.strictEqual(resWrongRef.message?.includes('Không tìm thấy giao dịch nào khớp'), true);

  // Test 4: Financial Underflow Protection (No Clamping)
  // Ensure that if currentFrozen < amount, finalize / refund / reject throw ConflictException instead of clamping to 0
  const underflowWallet = {
    wallet_id: BigInt(99),
    balance: 50000,
    frozen_balance: 30000, // Frozen is only 30k, but withdrawal is 100k!
  };

  const mockTxContext = {
    $queryRaw: async (query: any) => {
      const qStr = query.strings ? query.strings.join('') : String(query);
      if (qStr.includes('store_withdrawals')) {
        return [
          {
            withdrawal_id: BigInt(789),
            status: 'PROCESSING',
            amount: 100000,
            wallet_id: BigInt(99),
            withdrawal_code: 'WTH_UNDERFLOW',
          },
        ];
      }
      if (qStr.includes('store_wallets')) {
        return [underflowWallet];
      }
      return [];
    },
    storeWallet: {
      update: async () => {
        assert.fail('CRITICAL FLAW: storeWallet.update should not be called when frozen balance is insufficient!');
      },
    },
    storeWithdrawal: {
      update: async () => {},
      findUnique: async () => ({ status: 'PROCESSING' }),
    },
    walletTransaction: {
      findFirst: async () => null,
      create: async () => {},
    },
  };

  const mockPrismaForUnderflow = {
    $transaction: async (cb: any) => cb(mockTxContext),
  };

  const realAdminRepo = new (await import('../src/admin/admin.repository')).AdminRepository(
    mockPrismaForUnderflow as any,
  );

  await assert.rejects(
    async () => {
      await realAdminRepo.finalizeSucceededWithdrawalTransaction(BigInt(789));
    },
    (err: any) => {
      assert.strictEqual(
        err.message.includes('Sai lệch kế toán') || err.status === 409,
        true,
        `Expected ConflictException on frozen balance underflow, got: ${err.message}`,
      );
      return true;
    },
    'Expected finalizeSucceededWithdrawalTransaction to reject on insufficient frozen balance without clamping',
  );

  console.log('✅ Task 3 Payout invariant tests PASSED!');
}

run().catch((err) => {
  console.error('❌ Test failed with error:', err.message);
  process.exit(1);
});
