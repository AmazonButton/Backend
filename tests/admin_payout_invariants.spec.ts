import assert from 'node:assert';
import { AdminService } from '../src/admin/admin.service';

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

  // Test 3: Recovery via reference with list response shape (data.payouts)
  let finalizedId: bigint | null = null;
  const mockAdminRepoForSync = {
    findWithdrawalById: async (_id: bigint) => ({
      withdrawalId: BigInt(456),
      withdrawalCode: 'WTH456',
      storeId: BigInt(2),
      amount: 100000,
      walletId: BigInt(20),
      status: 'PENDING_RECONCILIATION',
      providerReferenceId: 'REF_WTH456',
    }),
    finalizeSucceededWithdrawalTransaction: async (id: bigint) => {
      finalizedId = id;
    },
    refundFailedWithdrawalTransaction: async () => {},
  };

  const mockPayosWithList = {
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
        amount: 100000,
        approvalState: 'SUCCEEDED',
      },
    }),
  };

  const adminServiceSync = new AdminService(
    mockAdminRepoForSync as any,
    mockPayosWithList as any,
    {} as any,
  );
  (adminServiceSync as any).invalidateAdminAndStoreCaches = async () => {};

  await adminServiceSync.syncPayoutStatus(BigInt(456));
  assert.strictEqual(
    finalizedId,
    BigInt(456),
    'Expected syncPayoutStatus to correctly resolve reference from payouts list and finalize withdrawal',
  );

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
