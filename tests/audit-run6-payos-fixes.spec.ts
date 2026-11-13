import assert from 'assert';
import * as crypto from 'crypto';
import { BadRequestException } from '@nestjs/common';
import { PayOSPayoutService, PayOSPayoutIndeterminateException, PayOSPayoutPreDispatchException } from '../src/payments/payos-payout.service';
import { verifyDepositRefundPayoutEvidence } from '../src/rentals/deposit-payout-verifier';

async function runAuditRun6Tests() {
  console.log('================================================================================');
  console.log('⚡ AUDIT RUN-6 REMEDIATION TEST SUITE');
  console.log('================================================================================\n');

  let passed = 0;
  let total = 0;

  const test = (name: string, fn: () => void | Promise<void>) => {
    total++;
    try {
      const res = fn();
      if (res && typeof (res as any).then === 'function') {
        return (res as any).then(() => {
          console.log(`  ✔ [PASS] ${name}`);
          passed++;
        }).catch((err: any) => {
          console.error(`  ✖ [FAIL] ${name}: ${err.message}`);
          throw err;
        });
      } else {
        console.log(`  ✔ [PASS] ${name}`);
        passed++;
      }
    } catch (err: any) {
      console.error(`  ✖ [FAIL] ${name}: ${err.message}`);
      throw err;
    }
  };

  // ---------------------------------------------------------------------------
  // 1. Item H: Response Signature Enforcement (Missing x-signature header)
  // ---------------------------------------------------------------------------
  await test('1.1 [Item H] checkResponseSignature throws PayOSPayoutIndeterminateException when signature is missing and ENFORCE=true', async () => {
    const origEnv = process.env.PAYOS_PAYOUT_ENFORCE_RESPONSE_SIGNATURE;
    process.env.PAYOS_PAYOUT_ENFORCE_RESPONSE_SIGNATURE = 'true';
    try {
      const service = new PayOSPayoutService();
      const mockResponse = {
        headers: {
          get: (name: string) => (name === 'x-signature' ? null : null),
        },
      } as any;
      const mockResult = { code: '00', data: { id: 'payout_123' } };

      let caught: any = null;
      try {
        (service as any).checkResponseSignature(mockResponse, mockResult, 'dummy_key');
      } catch (err) {
        caught = err;
      }

      assert(caught instanceof PayOSPayoutIndeterminateException, 'Must throw PayOSPayoutIndeterminateException');
      assert(caught.payosCode === 'RESPONSE_SIGNATURE_MISSING', `Expected RESPONSE_SIGNATURE_MISSING, got ${caught.payosCode}`);
    } finally {
      process.env.PAYOS_PAYOUT_ENFORCE_RESPONSE_SIGNATURE = origEnv;
    }
  });

  // ---------------------------------------------------------------------------
  // 2. Item G: Batch Payout Rejection Classification
  // ---------------------------------------------------------------------------
  await test('2.1 [Item G] classifyRejection classifies 401 or PRE_DISPATCH_REJECT_CODES as PreDispatchException', () => {
    const service = new PayOSPayoutService();
    const err401 = (service as any).classifyRejection(401, { code: 'UNAUTHORIZED', desc: 'Invalid API key' });
    assert(err401 instanceof PayOSPayoutPreDispatchException, 'Must be PreDispatchException on 401');

    const errBalance = (service as any).classifyRejection(200, { code: 'BALANCE_NOT_ENOUGH', desc: 'Số dư không đủ' });
    assert(errBalance instanceof PayOSPayoutPreDispatchException, 'Must be PreDispatchException on BALANCE_NOT_ENOUGH');

    const errUnknown = (service as any).classifyRejection(500, { code: 'INTERNAL_ERROR', desc: 'Gateway timeout' });
    assert(errUnknown instanceof PayOSPayoutIndeterminateException, 'Must be IndeterminateException on unknown 500 error');
  });

  // ---------------------------------------------------------------------------
  // 3. Item F: Rental Refund Verifier Rejects Ambiguous Transactions
  // ---------------------------------------------------------------------------
  await test('3.1 [Item F] verifyDepositRefundPayoutEvidence rejects multiple matching transactions as ambiguous', () => {
    const hash = crypto.createHash('sha256').update('12345678').digest('hex');
    const refund = {
      providerReferenceId: 'PAYOUT_ROOT_001',
      refundCode: 'REF_DP_1001',
      recipientBin: '970422',
      recipientAccountNumberEncrypted: 'dummy_enc',
      recipientAccountNumberHash: hash,
      amount: 50000,
    };

    const payoutData = {
      id: 'PAYOUT_ROOT_001',
      approvalState: 'SUCCEEDED',
      transactions: [
        {
          id: 'TXN_A',
          referenceId: 'REF_DP_1001',
          state: 'SUCCEEDED',
          amount: 50000,
          toBin: '970422',
          toAccountNumber: '12345678',
        },
        {
          id: 'TXN_B',
          referenceId: 'REF_DP_1001',
          state: 'SUCCEEDED',
          amount: 50000,
          toBin: '970422',
          toAccountNumber: '12345678',
        },
      ],
    };

    const result = verifyDepositRefundPayoutEvidence(payoutData, refund, {
      accountNumberPlain: '12345678',
      accountNumberHash: hash,
    });

    assert(!result.isVerified, 'Ambiguous transactions must NOT be verified');
    assert(result.reason?.includes('nhiều giao dịch chi tiết trùng khớp mâu thuẫn'), `Expected ambiguity reason, got: ${result.reason}`);
  });

  await test('3.2 [Item F] verifyDepositRefundPayoutEvidence rejects contradictory referenceId', () => {
    const hash = crypto.createHash('sha256').update('12345678').digest('hex');
    const refund = {
      providerReferenceId: 'PAYOUT_ROOT_002',
      refundCode: 'REF_DP_1002',
      recipientBin: '970422',
      recipientAccountNumberEncrypted: 'dummy_enc',
      recipientAccountNumberHash: hash,
      amount: 50000,
    };

    const payoutData = {
      id: 'PAYOUT_ROOT_002',
      approvalState: 'SUCCEEDED',
      transactions: [
        {
          id: 'PAYOUT_ROOT_002', // Matches tech id
          referenceId: 'REF_DP_OTHER_999', // Contradicts business refundCode
          state: 'SUCCEEDED',
          amount: 50000,
          toBin: '970422',
          toAccountNumber: '12345678',
        },
      ],
    };

    const result = verifyDepositRefundPayoutEvidence(payoutData, refund, {
      accountNumberPlain: '12345678',
      accountNumberHash: hash,
    });

    assert(!result.isVerified, 'Contradictory business reference must be rejected');
  });

  await test('3.3 [Item F] verifyDepositRefundPayoutEvidence verifies single authoritative matching transaction', () => {
    const hash = crypto.createHash('sha256').update('12345678').digest('hex');
    const refund = {
      providerReferenceId: 'PAYOUT_ROOT_003',
      refundCode: 'REF_DP_1003',
      recipientBin: '970422',
      recipientAccountNumberEncrypted: 'dummy_enc',
      recipientAccountNumberHash: hash,
      amount: 50000,
    };

    const payoutData = {
      id: 'PAYOUT_ROOT_003',
      approvalState: 'SUCCEEDED',
      transactions: [
        {
          id: 'TXN_AUTH_01',
          referenceId: 'REF_DP_1003',
          state: 'SUCCEEDED',
          amount: 50000,
          toBin: '970422',
          toAccountNumber: '12345678',
        },
      ],
    };

    const result = verifyDepositRefundPayoutEvidence(payoutData, refund, {
      accountNumberPlain: '12345678',
      accountNumberHash: hash,
    });

    assert(result.isVerified, `Single authoritative matching transaction must be verified: ${result.reason}`);
    assert(result.providerRef === 'PAYOUT_ROOT_003');
    assert(result.reportedAmount === 50000);
  });

  // ---------------------------------------------------------------------------
  // 4. Item K: Customer Link Recovery without checkoutUrl in GET response
  // ---------------------------------------------------------------------------
  await test('4.1 [Item K] recoverExistingPaymentLink recovers real provider id and fallback URL when checkoutUrl is absent in GET schema', async () => {
    const origFetch = global.fetch;
    try {
      global.fetch = (async () => ({
        json: async () => ({
          code: '00',
          desc: 'success',
          data: {
            id: 'c138_provider_link_id',
            orderCode: 987654321,
            amount: 2000,
            amountPaid: 0,
            status: 'PENDING',
            transactions: [],
          },
        }),
      })) as any;

      const { CustomerBankPennyVerificationService } = await import('../src/customers/customer-bank-penny-verification.service');
      const service = new (CustomerBankPennyVerificationService as any)({}, {}, {}, {});
      const recovered = await (service as any).recoverExistingPaymentLink(987654321, 'client_1', 'api_1');

      assert(recovered !== null, 'Must recover valid link');
      assert(recovered.paymentLinkId === 'c138_provider_link_id', `Expected c138_provider_link_id, got: ${recovered.paymentLinkId}`);
      assert(recovered.checkoutUrl === 'https://pay.payos.vn/web/c138_provider_link_id', `Expected canonical payos checkout url, got: ${recovered.checkoutUrl}`);
    } finally {
      global.fetch = origFetch;
    }
  });

  await test('4.2 [Item K] recoverExistingPaymentLink returns null when provider id is missing (never substitutes orderCode into paymentLinkId)', async () => {
    const origFetch = global.fetch;
    try {
      global.fetch = (async () => ({
        json: async () => ({
          code: '00',
          desc: 'success',
          data: {
            orderCode: 987654321,
            amount: 2000,
            // id is absent!
          },
        }),
      })) as any;

      const { CustomerBankPennyVerificationService } = await import('../src/customers/customer-bank-penny-verification.service');
      const service = new (CustomerBankPennyVerificationService as any)({}, {}, {}, {});
      const recovered = await (service as any).recoverExistingPaymentLink(987654321, 'client_1', 'api_1');

      assert(recovered === null, 'Must return null rather than substituting orderCode into paymentLinkId');
    } finally {
      global.fetch = origFetch;
    }
  });

  // ---------------------------------------------------------------------------
  // 5. Item E: Late payment on cancelled order with active replacement sibling
  // ---------------------------------------------------------------------------
  await test('5.1 [Item E] confirmPaymentAtomicTx transitions cancelled transaction to REFUND_PENDING when active replacement sibling exists', async () => {
    const { PaymentsRepository } = await import('../src/payments/payments.repository');
    let updatedTxStatus = '';
    let updatedOrderStatus = '';
    let statusHistoryReason = '';

    const mockTx = {
      $queryRawUnsafe: async (sql: string) => {
        if (sql.includes('payment_transaction')) {
          return [{
            payment_transaction_id: BigInt(101),
            order_id: BigInt(5001),
            amount: 100000,
            status: 'CANCELLED',
          }];
        }
        if (sql.includes('orders')) {
          return [{
            order_id: BigInt(5001),
            order_status: 'PENDING',
            payment_method: 'PAYOS',
          }];
        }
        return [];
      },
      paymentTransaction: {
        findFirst: async ({ where }: any) => {
          // Simulate an active sibling replacement payment in PENDING status
          if (where.orderId === BigInt(5001) && where.status?.in?.includes('PENDING')) {
            return {
              paymentTransactionId: BigInt(102), // replacement payment
              orderId: BigInt(5001),
              status: 'PENDING',
            };
          }
          return null;
        },
        update: async ({ data }: any) => {
          updatedTxStatus = data.status;
        },
      },
      order: {
        update: async ({ data }: any) => {
          updatedOrderStatus = data.paymentStatus;
        },
      },
      orderStatusHistory: {
        create: async ({ data }: any) => {
          statusHistoryReason = data.reason;
        },
      },
    };

    const mockPrisma = {
      $transaction: async (cb: any) => cb(mockTx),
    };
    const repo = new PaymentsRepository(mockPrisma as any);

    (repo as any).findTransactionByIdTx = async () => ({
      paymentTransactionId: BigInt(101),
      status: updatedTxStatus,
    });

    const result = await repo.confirmPaymentAtomicTx(BigInt(101));
    assert(result.status === 'REFUND_PENDING', `Expected REFUND_PENDING to prevent collision with uq_payment_active_per_order, got: ${result.status}`);
    assert(updatedOrderStatus === 'REFUND_PENDING', `Expected order paymentStatus REFUND_PENDING, got: ${updatedOrderStatus}`);
    assert(statusHistoryReason.includes('liên kết cũ đã hủy'), 'Must record audit trail for cancelled payment received');
  });

  // ---------------------------------------------------------------------------
  // 6. Item A: Store Webhook Signed Data Boundary
  // ---------------------------------------------------------------------------
  await test('6.1 [Item A] handleVerificationWebhook rejects contradictory top-level referenceCode', async () => {
    const { BankVerificationService } = await import('../src/bank-verification/bank-verification.service');
    const mockRepo = {
      findReferenceCodeByOrderCode: async (orderCode: number) => {
        if (orderCode === 123456) return 'VERIFY_REAL_SESSION';
        return null;
      },
    };

    const service = new BankVerificationService({} as any, mockRepo as any, {} as any, {} as any);

    let caught: any = null;
    try {
      await service.handleVerificationWebhook({
        referenceCode: 'VERIFY_SPOOFED_SESSION', // Unsigned envelope tampering!
        data: {
          orderCode: 123456,
          amount: 2000,
          reference: 'TXN_PAYOS_99',
          description: 'Payment for verification',
        },
      } as any);
    } catch (e) {
      caught = e;
    }

    assert(caught instanceof BadRequestException, 'Must reject conflicting top-level referenceCode');
    assert(caught.message.includes('top-level referenceCode không khớp'), `Expected mismatch message, got: ${caught?.message}`);
  });

  console.log(`\n================================================================================`);
  console.log(`Results: ${passed}/${total} passed`);
  console.log(`================================================================================`);
}

runAuditRun6Tests().catch((e) => {
  console.error('Test suite failed:', e);
  process.exit(1);
});
