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

  console.log('✅ Task 3 Payout invariant tests PASSED!');
}

run().catch((err) => {
  console.error('❌ Test failed with error:', err.message);
  process.exit(1);
});
