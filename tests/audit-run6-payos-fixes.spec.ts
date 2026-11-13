import assert from 'assert';
import * as crypto from 'crypto';
import { BadRequestException } from '@nestjs/common';
import { PayOSPayoutService, PayOSPayoutIndeterminateException, PayOSPayoutPreDispatchException } from '../src/payments/payos-payout.service';
import { verifyDepositRefundPayoutEvidence } from '../src/rentals/deposit-payout-verifier';
import { CryptoVaultUtil } from '../src/common/utils/crypto-vault.util';

async function runAuditRun6Tests() {
  console.log('================================================================================');
  console.log('⚡ AUDIT RUN-6 REMEDIATION TEST SUITE (EXPANDED & COMPREHENSIVE)');
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
  // 1. Item H: Response Signature Enforcement & HTTP Status Checks
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

  await test('1.2 [Item H] estimateCredit enforces signature validation when ENFORCE=true', async () => {
    const origEnv = process.env.PAYOS_PAYOUT_ENFORCE_RESPONSE_SIGNATURE;
    const origFetch = global.fetch;
    process.env.PAYOS_PAYOUT_ENFORCE_RESPONSE_SIGNATURE = 'true';

    try {
      const service = new PayOSPayoutService();
      (service as any).getCredentials = () => ({
        clientId: 'real_client',
        apiKey: 'real_api',
        checksumKey: 'real_checksum',
      });
      (service as any).isMockMode = () => false;

      // Mock fetch returning HTTP 200 without x-signature header
      global.fetch = (async () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ code: '00', desc: 'success', data: { estimateCredit: 1000 } }),
      })) as any;

      let caught: any = null;
      try {
        await service.estimateCredit({
          referenceId: 'REF_EST_01',
          payouts: [{ referenceId: 'REF_P_01', amount: 50000, description: 'Test', toBin: '970422', toAccountNumber: '12345678' }],
        });
      } catch (err) {
        caught = err;
      }

      assert(caught instanceof PayOSPayoutIndeterminateException, 'Must throw PayOSPayoutIndeterminateException when signature missing on estimateCredit');
      assert(caught.payosCode === 'RESPONSE_SIGNATURE_MISSING', `Expected RESPONSE_SIGNATURE_MISSING, got ${caught.payosCode}`);
    } finally {
      process.env.PAYOS_PAYOUT_ENFORCE_RESPONSE_SIGNATURE = origEnv;
      global.fetch = origFetch;
    }
  });

  await test('1.3 [Item H] Payout methods reject when response.ok is false even if json has code 00 or non-00', async () => {
    const origFetch = global.fetch;
    try {
      const service = new PayOSPayoutService();
      (service as any).getCredentials = () => ({
        clientId: 'real_client',
        apiKey: 'real_api',
        checksumKey: 'real_checksum',
      });
      (service as any).isMockMode = () => false;

      // HTTP 400 Bad Request
      global.fetch = (async () => ({
        ok: false,
        status: 400,
        json: async () => ({ code: 'INVALID_PARAM', desc: 'Sai tham số' }),
      })) as any;

      let caught: any = null;
      try {
        await service.getPayout('payout_bad_req');
      } catch (e) {
        caught = e;
      }
      assert(caught instanceof PayOSPayoutPreDispatchException, 'HTTP 400 must classify as PreDispatchException');
      assert(caught.payosCode === 'INVALID_PARAM');
    } finally {
      global.fetch = origFetch;
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
  // 3. Item F: Strict Separation of Technical ID and Business Reference
  // ---------------------------------------------------------------------------
  await test('3.1 [Item F] verifyDepositRefundPayoutEvidence rejects cross-matching technical ID to business refundCode', () => {
    const hash = crypto.createHash('sha256').update('12345678').digest('hex');
    const refund = {
      providerReferenceId: null, // No tech ID stored yet
      refundCode: 'REF_DP_1001',
      recipientBin: '970422',
      recipientAccountNumberEncrypted: 'dummy_enc',
      recipientAccountNumberHash: hash,
      amount: 50000,
    };

    // Transaction where technical id equals refundCode, but referenceId is something else!
    const payoutData = {
      id: 'PAYOUT_ROOT_001',
      approvalState: 'SUCCEEDED',
      transactions: [
        {
          id: 'REF_DP_1001', // Technical ID happens to match refundCode string
          referenceId: 'DIFFERENT_BUSINESS_REF', // But business reference differs!
          state: 'SUCCEEDED',
          amount: 50000,
          toBin: '970422',
          toAccountNumber: '12345678',
        },
      ],
    };

    const result = verifyDepositRefundPayoutEvidence(payoutData, refund);
    assert(!result.isVerified, 'Must NOT match technical ID to business refundCode');
  });

  await test('3.2 [Item F] verifyDepositRefundPayoutEvidence rejects cross-matching business reference to technical providerReferenceId', () => {
    const hash = crypto.createHash('sha256').update('12345678').digest('hex');
    const refund = {
      providerReferenceId: 'PAYOUT_TECH_999',
      refundCode: 'REF_DP_2002',
      recipientBin: '970422',
      recipientAccountNumberEncrypted: 'dummy_enc',
      recipientAccountNumberHash: hash,
      amount: 50000,
    };

    // Transaction where business referenceId equals expected providerReferenceId, but tech id is different
    const payoutData = {
      id: 'PAYOUT_TECH_999',
      approvalState: 'SUCCEEDED',
      transactions: [
        {
          id: 'ACTUAL_TECH_ID_888', // Technical ID does NOT match
          referenceId: 'PAYOUT_TECH_999', // Business reference equals expectedProviderRef (cross-match!)
          state: 'SUCCEEDED',
          amount: 50000,
          toBin: '970422',
          toAccountNumber: '12345678',
        },
      ],
    };

    const result = verifyDepositRefundPayoutEvidence(payoutData, refund);
    assert(!result.isVerified, 'Must NOT match business reference to technical provider reference ID');
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

    const result = verifyDepositRefundPayoutEvidence(payoutData, refund);
    assert(result.isVerified, `Single authoritative matching transaction must be verified: ${result.reason}`);
    assert(result.providerRef === 'PAYOUT_ROOT_003');
    assert(result.reportedAmount === 50000);
  });

  // ---------------------------------------------------------------------------
  // 4. Item F: Outbox Consumer Retry Guard with Exact Outbox Shape
  // ---------------------------------------------------------------------------
  await test('4.1 [Item F] OutboxConsumer blocks createPayout when attempts > 0 or status is PROCESSING and lookup fails', async () => {
    const { OutboxConsumerService } = await import('../src/rentals/outbox-consumer.service');

    let createPayoutCalled = false;
    const mockPayosService = {
      getPayout: async () => {
        throw new Error('Lookup timeout');
      },
      getPayouts: async () => {
        throw new Error('Lookup 500 internal error');
      },
      createPayout: async () => {
        createPayoutCalled = true;
        return { data: { id: 'payout_new_123' } };
      },
    };

    const encValid = CryptoVaultUtil.encryptAccountNumber('12345678');
    const hashValid = CryptoVaultUtil.computeDeterministicAccountHash('12345678');
    const mockPrisma = {
      $transaction: async (cb: any) => {
        return cb({
          $queryRawUnsafe: async () => [
            {
              refund_id: BigInt(5001),
              status: 'PENDING_PAYOUT',
              provider_reference_id: null,
              refund_code: 'REF_DP_5001',
              amount: 50000,
              recipient_bin: '970422',
              recipient_account_number_encrypted: encValid,
              recipient_account_number_hash: hashValid,
              recipient_account_holder_name: 'NGUYEN VAN A',
              recipient_account_number_masked: '******78',
            },
          ],
        });
      },
      depositRefund: {
        findUnique: async () => ({
          refundId: BigInt(5001),
          status: 'PENDING_PAYOUT',
          refundCode: 'REF_DP_5001',
          amount: 50000,
          recipientBin: '970422',
          recipientAccountNumberEncrypted: encValid,
          recipientAccountNumberHash: hashValid,
          recipientAccountHolderName: 'NGUYEN VAN A',
          recipientAccountNumberMasked: '******78',
        }),
      },
    };

    const consumer = new OutboxConsumerService(mockPrisma as any, {} as any, {} as any, mockPayosService as any);

    // Exact outbox shape from SELECT id, event_type, payload, attempts, status
    const retriedEvent = {
      id: BigInt(9901),
      event_type: 'DEPOSIT_REFUND_APPROVED',
      payload: { refundId: '5001' },
      attempts: 1, // Has been attempted before!
      status: 'PROCESSING', // Crash recovery!
      claimToken: 'lease_token_123',
    };

    let caughtError: any = null;
    try {
      await (consumer as any).handleSingleEvent(retriedEvent);
    } catch (e) {
      caughtError = e;
    }

    assert(caughtError !== null, 'Must throw error when retrying event and lookup fails');
    assert(caughtError.message.includes('đang trong luồng retry/recovery'), `Expected retry/recovery guard error, got: ${caughtError.message}`);
    assert(!createPayoutCalled, 'createPayout must NEVER be called when prior attempt cannot be verified');
  });

  await test('4.2 [Item F] OutboxConsumer blocks createPayout on crash recovery when list is empty (danh sách rỗng)', async () => {
    const { OutboxConsumerService } = await import('../src/rentals/outbox-consumer.service');

    let createPayoutCalled = false;
    const mockPayosService = {
      getPayout: async () => ({ code: '00', data: null }),
      getPayouts: async () => ({
        code: '00',
        data: { payouts: [] }, // Danh sách rỗng trên PayOS!
      }),
      createPayout: async () => {
        createPayoutCalled = true;
        return { data: { id: 'payout_new_456' } };
      },
    };

    const encValid = CryptoVaultUtil.encryptAccountNumber('12345678');
    const hashValid = CryptoVaultUtil.computeDeterministicAccountHash('12345678');
    const mockPrisma = {
      $transaction: async (cb: any) => cb({
        $queryRawUnsafe: async () => [{
          refund_id: BigInt(5002),
          status: 'PENDING_PAYOUT',
          provider_reference_id: null,
          refund_code: 'REF_DP_5002',
          amount: 50000,
          recipient_bin: '970422',
          recipient_account_number_encrypted: encValid,
          recipient_account_number_hash: hashValid,
          recipient_account_holder_name: 'NGUYEN VAN A',
          recipient_account_number_masked: '******78',
        }],
      }),
      depositRefund: {
        findUnique: async () => ({
          refundId: BigInt(5002),
          status: 'PENDING_PAYOUT',
          refundCode: 'REF_DP_5002',
          amount: 50000,
          recipientBin: '970422',
          recipientAccountNumberEncrypted: encValid,
          recipientAccountNumberHash: hashValid,
          recipientAccountHolderName: 'NGUYEN VAN A',
          recipientAccountNumberMasked: '******78',
        }),
      },
    };

    const consumer = new OutboxConsumerService(mockPrisma as any, {} as any, {} as any, mockPayosService as any);
    const crashedEvent = {
      id: BigInt(9902),
      event_type: 'DEPOSIT_REFUND_APPROVED',
      payload: { refundId: '5002' },
      attempts: 0,
      status: 'PROCESSING', // Crash recovery fingerprint!
      claimToken: 'lease_token_crash',
    };

    let caughtError: any = null;
    try {
      await (consumer as any).handleSingleEvent(crashedEvent);
    } catch (e) {
      caughtError = e;
    }

    assert(caughtError !== null, 'Must throw error when recovering crashed event with empty payout list');
    assert(caughtError.message.includes('chưa có bằng chứng chi trả được xác nhận trên PayOS'), `Expected crash recovery guard error, got: ${caughtError.message}`);
    assert(!createPayoutCalled, 'createPayout must NEVER be called when crash recovery yields empty search list');
  });

  await test('4.3 [Item F] OutboxConsumer blocks createPayout on recovery when matched payout lacks technical ID (kết quả thiếu id)', async () => {
    const { OutboxConsumerService } = await import('../src/rentals/outbox-consumer.service');

    let createPayoutCalled = false;
    const mockPayosService = {
      getPayout: async () => ({ code: '00', data: null }),
      getPayouts: async () => ({
        code: '00',
        data: {
          payouts: [
            {
              referenceId: 'REF_DP_5003',
              id: null, // Thiếu id kỹ thuật!
            },
          ],
        },
      }),
      createPayout: async () => {
        createPayoutCalled = true;
        return { data: { id: 'payout_new_789' } };
      },
    };

    const encValid = CryptoVaultUtil.encryptAccountNumber('12345678');
    const hashValid = CryptoVaultUtil.computeDeterministicAccountHash('12345678');
    const mockPrisma = {
      $transaction: async (cb: any) => cb({
        $queryRawUnsafe: async () => [{
          refund_id: BigInt(5003),
          status: 'PENDING_PAYOUT',
          provider_reference_id: null,
          refund_code: 'REF_DP_5003',
          amount: 50000,
          recipient_bin: '970422',
          recipient_account_number_encrypted: encValid,
          recipient_account_number_hash: hashValid,
          recipient_account_holder_name: 'NGUYEN VAN A',
          recipient_account_number_masked: '******78',
        }],
      }),
      depositRefund: {
        findUnique: async () => ({
          refundId: BigInt(5003),
          status: 'PENDING_PAYOUT',
          refundCode: 'REF_DP_5003',
          amount: 50000,
          recipientBin: '970422',
          recipientAccountNumberEncrypted: encValid,
          recipientAccountNumberHash: hashValid,
          recipientAccountHolderName: 'NGUYEN VAN A',
          recipientAccountNumberMasked: '******78',
        }),
      },
    };

    const consumer = new OutboxConsumerService(mockPrisma as any, {} as any, {} as any, mockPayosService as any);
    const retriedEvent = {
      id: BigInt(9903),
      event_type: 'DEPOSIT_REFUND_APPROVED',
      payload: { refundId: '5003' },
      attempts: 1,
      status: 'PROCESSING',
      claimToken: 'lease_token_missing_id',
    };

    let caughtError: any = null;
    try {
      await (consumer as any).handleSingleEvent(retriedEvent);
    } catch (e) {
      caughtError = e;
    }

    assert(caughtError !== null, 'Must throw error when matched payout lacks technical ID');
    assert(caughtError.message.includes('thiếu id kỹ thuật từ cổng'), `Expected missing ID guard error, got: ${caughtError.message}`);
    assert(!createPayoutCalled, 'createPayout must NEVER be called when matched payout is missing technical id');
  });

  await test('4.4 [Item F] OutboxConsumer blocks createPayout on recovery when detail query returns empty/null data (detail thiếu data)', async () => {
    const { OutboxConsumerService } = await import('../src/rentals/outbox-consumer.service');

    let createPayoutCalled = false;
    const mockPayosService = {
      getPayout: async () => ({ code: '00', data: null }), // Detail query returns null data!
      getPayouts: async () => ({
        code: '00',
        data: {
          payouts: [
            {
              id: 'PAYOUT_TECH_999',
              referenceId: 'REF_DP_5004',
            },
          ],
        },
      }),
      createPayout: async () => {
        createPayoutCalled = true;
        return { data: { id: 'payout_new_000' } };
      },
    };

    const encValid = CryptoVaultUtil.encryptAccountNumber('12345678');
    const hashValid = CryptoVaultUtil.computeDeterministicAccountHash('12345678');
    const mockPrisma = {
      $transaction: async (cb: any) => cb({
        $queryRawUnsafe: async () => [{
          refund_id: BigInt(5004),
          status: 'PENDING_PAYOUT',
          provider_reference_id: null,
          refund_code: 'REF_DP_5004',
          amount: 50000,
          recipient_bin: '970422',
          recipient_account_number_encrypted: encValid,
          recipient_account_number_hash: hashValid,
          recipient_account_holder_name: 'NGUYEN VAN A',
          recipient_account_number_masked: '******78',
        }],
      }),
      depositRefund: {
        findUnique: async () => ({
          refundId: BigInt(5004),
          status: 'PENDING_PAYOUT',
          refundCode: 'REF_DP_5004',
          amount: 50000,
          recipientBin: '970422',
          recipientAccountNumberEncrypted: encValid,
          recipientAccountNumberHash: hashValid,
          recipientAccountHolderName: 'NGUYEN VAN A',
          recipientAccountNumberMasked: '******78',
        }),
      },
    };

    const consumer = new OutboxConsumerService(mockPrisma as any, {} as any, {} as any, mockPayosService as any);
    const retriedEvent = {
      id: BigInt(9904),
      event_type: 'DEPOSIT_REFUND_APPROVED',
      payload: { refundId: '5004' },
      attempts: 1,
      status: 'PROCESSING',
      claimToken: 'lease_token_missing_detail',
    };

    let caughtError: any = null;
    try {
      await (consumer as any).handleSingleEvent(retriedEvent);
    } catch (e) {
      caughtError = e;
    }

    assert(caughtError !== null, 'Must throw error when detail query returns empty data');
    assert(caughtError.message.includes('chi tiết thiếu dữ liệu hợp lệ'), `Expected missing detail data guard error, got: ${caughtError.message}`);
    assert(!createPayoutCalled, 'createPayout must NEVER be called when detail query returns empty data');
  });

  await test('4.5 [Item F] OutboxConsumer blocks createPayout on retry (status=PENDING, attempts=1) when lookup returns empty list (danh sách rỗng)', async () => {
    const { OutboxConsumerService } = await import('../src/rentals/outbox-consumer.service');

    let createPayoutCalled = false;
    const mockPayosService = {
      getPayout: async () => ({ code: '00', data: null }),
      getPayouts: async () => ({
        code: '00',
        data: { payouts: [] }, // Danh sách rỗng trên PayOS khi retry PENDING!
      }),
      createPayout: async () => {
        createPayoutCalled = true;
        return { data: { id: 'payout_new_should_not_happen' } };
      },
    };

    const encValid = CryptoVaultUtil.encryptAccountNumber('12345678');
    const hashValid = CryptoVaultUtil.computeDeterministicAccountHash('12345678');
    const mockPrisma = {
      $transaction: async (cb: any) => cb({
        $queryRawUnsafe: async () => [{
          refund_id: BigInt(5005),
          status: 'PENDING_PAYOUT',
          provider_reference_id: null,
          refund_code: 'REF_DP_5005',
          amount: 50000,
          recipient_bin: '970422',
          recipient_account_number_encrypted: encValid,
          recipient_account_number_hash: hashValid,
          recipient_account_holder_name: 'NGUYEN VAN A',
          recipient_account_number_masked: '******78',
        }],
      }),
      depositRefund: {
        findUnique: async () => ({
          refundId: BigInt(5005),
          status: 'PENDING_PAYOUT',
          refundCode: 'REF_DP_5005',
          amount: 50000,
          recipientBin: '970422',
          recipientAccountNumberEncrypted: encValid,
          recipientAccountNumberHash: hashValid,
          recipientAccountHolderName: 'NGUYEN VAN A',
          recipientAccountNumberMasked: '******78',
        }),
      },
    };

    const consumer = new OutboxConsumerService(mockPrisma as any, {} as any, {} as any, mockPayosService as any);
    // Nhánh retry thực tế theo dòng 168: status = 'PENDING', attempts = 1
    const pendingRetryEvent = {
      id: BigInt(9905),
      event_type: 'DEPOSIT_REFUND_APPROVED',
      payload: { refundId: '5005' },
      attempts: 1, // attempts > 0
      status: 'PENDING', // status is PENDING, NOT PROCESSING!
      claimToken: 'lease_token_retry_pending',
    };

    let caughtError: any = null;
    try {
      await (consumer as any).handleSingleEvent(pendingRetryEvent);
    } catch (e) {
      caughtError = e;
    }

    assert(caughtError !== null, 'Must throw error when retrying PENDING event with empty list');
    assert(caughtError.message.includes('đang trong luồng retry/recovery (attempts=1, status=PENDING)'), `Expected pending retry error, got: ${caughtError.message}`);
    assert(!createPayoutCalled, 'createPayout must NEVER be called when retry (status=PENDING, attempts>0) returns empty list');
  });

  await test('4.6 [Item F] OutboxConsumer blocks createPayout on first attempt when lookup fails or evidence is missing; dispatches when first attempt lookup is valid and empty', async () => {
    const { OutboxConsumerService } = await import('../src/rentals/outbox-consumer.service');

    const encValid = CryptoVaultUtil.encryptAccountNumber('12345678');
    const hashValid = CryptoVaultUtil.computeDeterministicAccountHash('12345678');
    const mockPrismaBuilder = (refundId: bigint, refundCode: string) => ({
      $transaction: async (cb: any) => cb({
        $queryRawUnsafe: async () => [{
          refund_id: refundId,
          status: 'PENDING_PAYOUT',
          provider_reference_id: null,
          refund_code: refundCode,
          amount: 50000,
          recipient_bin: '970422',
          recipient_account_number_encrypted: encValid,
          recipient_account_number_hash: hashValid,
          recipient_account_holder_name: 'NGUYEN VAN A',
          recipient_account_number_masked: '******78',
        }],
      }),
      depositRefund: {
        findUnique: async () => ({
          refundId,
          status: 'PENDING_PAYOUT',
          refundCode,
          amount: 50000,
          recipientBin: '970422',
          recipientAccountNumberEncrypted: encValid,
          recipientAccountNumberHash: hashValid,
          recipientAccountHolderName: 'NGUYEN VAN A',
          recipientAccountNumberMasked: '******78',
        }),
        update: async () => {},
      },
    });

    // Ca 1: Lượt đầu (attempts=0, status=PENDING) nhưng lookup bị lỗi -> Phải CHẶN createPayout!
    let createPayoutCalledFailCase = false;
    const mockPayosLookupFail = {
      getPayout: async () => ({ code: '00', data: null }),
      getPayouts: async () => {
        throw new Error('PayOS gateway timeout on pre-dispatch search');
      },
      createPayout: async () => {
        createPayoutCalledFailCase = true;
        return { data: { id: 'should_not_be_created' } };
      },
    };

    const consumerFail = new OutboxConsumerService(mockPrismaBuilder(BigInt(5006), 'REF_DP_5006') as any, {} as any, {} as any, mockPayosLookupFail as any);
    const firstAttemptEventFail = {
      id: BigInt(9906),
      event_type: 'DEPOSIT_REFUND_APPROVED',
      payload: { refundId: '5006' },
      attempts: 0,
      status: 'PENDING',
      claimToken: 'lease_token_first_fail',
    };

    let caughtErrorFail: any = null;
    try {
      await (consumerFail as any).handleSingleEvent(firstAttemptEventFail);
    } catch (e) {
      caughtErrorFail = e;
    }

    assert(caughtErrorFail !== null, 'Must throw error when first attempt lookup fails');
    assert(caughtErrorFail.message.includes('tra cứu trạng thái trên PayOS thất bại hoặc gặp lỗi kết nối'), `Expected fail error, got: ${caughtErrorFail.message}`);
    assert(!createPayoutCalledFailCase, 'createPayout must NEVER be called on first attempt if lookup failed');

    // Ca 2: Lượt đầu (attempts=0, status=PENDING) lookup thành công và danh sách rỗng -> ĐƯỢC PHÉP dispatch createPayout!
    let createPayoutCalledSuccessCase = false;
    const mockPayosLookupSuccess = {
      getPayout: async () => ({ code: '00', data: null }),
      getPayouts: async () => ({
        code: '00',
        data: { payouts: [] }, // Danh sách rỗng, tra cứu thành công!
      }),
      createPayout: async (payload: any) => {
        createPayoutCalledSuccessCase = true;
        return {
          data: {
            id: 'PAYOUT_CLEAN_FIRST_RUN_888',
            approvalState: 'COMPLETED',
            amount: 50000,
            transactions: [
              {
                id: 'TXN-888',
                referenceId: payload.referenceId,
                amount: 50000,
                state: 'COMPLETED',
                toBin: payload.toBin,
                toAccountNumber: payload.toAccountNumber,
              },
            ],
          },
        };
      },
    };

    const mockRentalsRepoClean: any = {
      confirmDepositRefundPayoutTx: async () => {},
    };

    const consumerSuccess = new OutboxConsumerService(mockPrismaBuilder(BigInt(5007), 'REF_DP_5007') as any, mockRentalsRepoClean, {} as any, mockPayosLookupSuccess as any);
    const firstAttemptEventSuccess = {
      id: BigInt(9907),
      event_type: 'DEPOSIT_REFUND_APPROVED',
      payload: { refundId: '5007' },
      attempts: 0,
      status: 'PENDING',
      claimToken: 'lease_token_first_success',
    };

    await (consumerSuccess as any).handleSingleEvent(firstAttemptEventSuccess);
    assert(createPayoutCalledSuccessCase, 'createPayout MUST be called when first attempt lookup is valid and clean empty list');
  });

  await test('4.7 [Item F] OutboxConsumer blocks createPayout when PayOS getPayouts returns invalid shape (e.g. data: null, data: {}, or code != 00) instead of treating it as empty list', async () => {
    const { OutboxConsumerService } = await import('../src/rentals/outbox-consumer.service');
    const encValid = CryptoVaultUtil.encryptAccountNumber('12345678');
    const hashValid = CryptoVaultUtil.computeDeterministicAccountHash('12345678');

    const mockPrismaBuilder = (refundId: bigint, refundCode: string) => ({
      $transaction: async (cb: any) => cb({
        $queryRawUnsafe: async () => [{
          refund_id: refundId,
          status: 'PENDING_PAYOUT',
          provider_reference_id: null,
          refund_code: refundCode,
          amount: 50000,
          recipient_bin: '970422',
          recipient_account_number_encrypted: encValid,
          recipient_account_number_hash: hashValid,
          recipient_account_holder_name: 'NGUYEN VAN A',
          recipient_account_number_masked: '******78',
        }],
      }),
      depositRefund: {
        findUnique: async () => ({
          refundId,
          status: 'PENDING_PAYOUT',
          refundCode,
          amount: 50000,
          recipientBin: '970422',
          recipientAccountNumberEncrypted: encValid,
          recipientAccountNumberHash: hashValid,
          recipientAccountHolderName: 'NGUYEN VAN A',
          recipientAccountNumberMasked: '******78',
        }),
        update: async () => {},
      },
    });

    // Ca 1: data: null -> không được chuẩn hóa thành [], phải trở thành lookup error và chặn dispatch
    let createPayoutCalledNullCase = false;
    const mockPayosLookupNull = {
      getPayout: async () => ({ code: '00', data: null }),
      getPayouts: async () => ({
        code: '00',
        data: null, // Response dị thường, thiếu mảng payouts
      }),
      createPayout: async () => {
        createPayoutCalledNullCase = true;
        return { data: { id: 'should_not_be_created' } };
      },
    };

    const consumerNull = new OutboxConsumerService(mockPrismaBuilder(BigInt(5008), 'REF_DP_5008') as any, {} as any, {} as any, mockPayosLookupNull as any);
    const firstAttemptEventNull = {
      id: BigInt(9908),
      event_type: 'DEPOSIT_REFUND_APPROVED',
      payload: { refundId: '5008' },
      attempts: 0,
      status: 'PENDING',
      claimToken: 'lease_token_first_null',
    };

    let caughtErrorNull: any = null;
    try {
      await (consumerNull as any).handleSingleEvent(firstAttemptEventNull);
    } catch (e) {
      caughtErrorNull = e;
    }

    assert(caughtErrorNull !== null, 'Must throw error when getPayouts returns data: null');
    assert(caughtErrorNull.message.includes('tra cứu trạng thái trên PayOS thất bại hoặc gặp lỗi kết nối'), `Expected fail error, got: ${caughtErrorNull.message}`);
    assert(!createPayoutCalledNullCase, 'createPayout must NEVER be called when getPayouts returns data: null');

    // Ca 2: data: {} -> không có mảng payouts
    let createPayoutCalledEmptyObjCase = false;
    const mockPayosLookupEmptyObj = {
      getPayout: async () => ({ code: '00', data: null }),
      getPayouts: async () => ({
        code: '00',
        data: {}, // Response không có payouts
      }),
      createPayout: async () => {
        createPayoutCalledEmptyObjCase = true;
        return { data: { id: 'should_not_be_created' } };
      },
    };

    const consumerEmptyObj = new OutboxConsumerService(mockPrismaBuilder(BigInt(5009), 'REF_DP_5009') as any, {} as any, {} as any, mockPayosLookupEmptyObj as any);
    const firstAttemptEventEmptyObj = {
      id: BigInt(9909),
      event_type: 'DEPOSIT_REFUND_APPROVED',
      payload: { refundId: '5009' },
      attempts: 0,
      status: 'PENDING',
      claimToken: 'lease_token_first_empty_obj',
    };

    let caughtErrorEmptyObj: any = null;
    try {
      await (consumerEmptyObj as any).handleSingleEvent(firstAttemptEventEmptyObj);
    } catch (e) {
      caughtErrorEmptyObj = e;
    }

    assert(caughtErrorEmptyObj !== null, 'Must throw error when getPayouts returns data: {}');
    assert(caughtErrorEmptyObj.message.includes('tra cứu trạng thái trên PayOS thất bại hoặc gặp lỗi kết nối'), `Expected fail error, got: ${caughtErrorEmptyObj.message}`);
    assert(!createPayoutCalledEmptyObjCase, 'createPayout must NEVER be called when getPayouts returns data: {}');

    // Ca 3: code != '00' (ví dụ code: '99') với data có shape payouts: [] hợp lệ để chứng minh độc lập việc từ chối business code lỗi
    let createPayoutCalledErrorCodeCase = false;
    const mockPayosLookupErrorCode = {
      getPayout: async () => ({ code: '00', data: null }),
      getPayouts: async () => ({
        code: '99',
        desc: 'Gateway internal timeout',
        data: { payouts: [] },
      }),
      createPayout: async () => {
        createPayoutCalledErrorCodeCase = true;
        return { data: { id: 'should_not_be_created' } };
      },
    };

    const consumerErrorCode = new OutboxConsumerService(mockPrismaBuilder(BigInt(5010), 'REF_DP_5010') as any, {} as any, {} as any, mockPayosLookupErrorCode as any);
    const firstAttemptEventErrorCode = {
      id: BigInt(9910),
      event_type: 'DEPOSIT_REFUND_APPROVED',
      payload: { refundId: '5010' },
      attempts: 0,
      status: 'PENDING',
      claimToken: 'lease_token_first_err_code',
    };

    let caughtErrorErrorCode: any = null;
    try {
      await (consumerErrorCode as any).handleSingleEvent(firstAttemptEventErrorCode);
    } catch (e) {
      caughtErrorErrorCode = e;
    }

    assert(caughtErrorErrorCode !== null, 'Must throw error when getPayouts returns code != 00');
    assert(caughtErrorErrorCode.message.includes('tra cứu trạng thái trên PayOS thất bại hoặc gặp lỗi kết nối'), `Expected fail error, got: ${caughtErrorErrorCode.message}`);
    assert(!createPayoutCalledErrorCodeCase, 'createPayout must NEVER be called when getPayouts returns code != 00');
  });

  // ---------------------------------------------------------------------------
  // 5. Item B: Store Inline Refund Dispatch from Claimed Obligation Snapshot
  // ---------------------------------------------------------------------------
  await test('5.1 [Item B] triggerAutomatedRefund dispatches using obligation snapshot (actual amount & sender account, not session defaults)', async () => {
    const { BankVerificationService } = await import('../src/bank-verification/bank-verification.service');

    let dispatchedBin = '';
    let dispatchedAccount = '';
    let dispatchedAmount = 0;
    let dispatchedRef = '';

    const mockProvider = {
      createRefund: async (params: any) => {
        dispatchedBin = params.bankBin;
        dispatchedAccount = params.accountNumber;
        dispatchedAmount = params.amount;
        dispatchedRef = params.referenceId;
        return {
          status: 'SUCCESS',
          refundTransactionId: 'PAYOS_REFUND_TXN_888',
        };
      },
    };

    const senderPlainAccount = '0987654321';
    const senderEncrypted = CryptoVaultUtil.encryptAccountNumber(senderPlainAccount);

    const mockObligation = {
      id: BigInt(123),
      refundReference: 'REF_ST_SUBSEQUENT_99',
      refundAmount: 5000, // Actual received: 5.000đ (session expected was 2.000đ)
      refundStatus: 'PENDING_REFUND',
      targetBankBin: '970415', // VietinBank sender
      targetAccountEncrypted: senderEncrypted,
      receipt: {
        senderBankBin: '970415',
        senderAccountNumberEncrypted: senderEncrypted,
      },
    };

    const mockPrisma = {
      storeBankRefundObligation: {
        findFirst: async () => mockObligation,
      },
    };

    const mockRepo = {
      claimRefundObligationForDispatch: async () => true,
      updateTransactionRefundStatus: async () => {},
      markObligationDispatchedByReference: async () => {},
      recordObligationReconciliationPending: async () => {},
      recordObligationTerminalFailure: async () => {},
    };

    const service = new BankVerificationService(mockPrisma as any, mockRepo as any, mockProvider as any, {} as any);

    // Call triggerAutomatedRefund with session transaction id and subsequent refund ref
    await service.triggerAutomatedRefund(BigInt(10), 'REF_ST_SUBSEQUENT_99');

    assert(dispatchedAmount === 5000, `Expected 5000 dispatched amount from obligation snapshot, got: ${dispatchedAmount}`);
    assert(dispatchedBin === '970415', `Expected 970415 from obligation snapshot, got: ${dispatchedBin}`);
    assert(dispatchedAccount === senderPlainAccount, `Expected ${senderPlainAccount} from obligation snapshot, got: ${dispatchedAccount}`);
    assert(dispatchedRef === 'REF_ST_SUBSEQUENT_99');
  });

  await test('5.2 [Item B] triggerAutomatedRefund aborts without dispatching when refundStatus is PENDING_MANUAL_REFUND', async () => {
    const { BankVerificationService } = await import('../src/bank-verification/bank-verification.service');

    let createRefundCalled = false;
    const mockProvider = {
      createRefund: async () => {
        createRefundCalled = true;
        return { status: 'SUCCESS' };
      },
    };

    const mockObligation = {
      id: BigInt(124),
      refundReference: 'REF_ST_MANUAL_01',
      refundAmount: 2000,
      refundStatus: 'PENDING_MANUAL_REFUND', // Manual review required!
      targetBankBin: null,
      targetAccountEncrypted: null,
    };

    const mockPrisma = {
      storeBankRefundObligation: {
        findFirst: async () => mockObligation,
      },
    };

    const service = new BankVerificationService(mockPrisma as any, {} as any, mockProvider as any, {} as any);
    await service.triggerAutomatedRefund(BigInt(11), 'REF_ST_MANUAL_01');

    assert(!createRefundCalled, 'Must NOT call createRefund when obligation is PENDING_MANUAL_REFUND');
  });

  // ---------------------------------------------------------------------------
  // 6. Item C: Preserving Session orderCode Invariant Across ALL Failure Branches
  // ---------------------------------------------------------------------------
  await test('6.1 [Item C] executeAtomicWebhookVerificationTx preserves orderCode in provider_transaction_id on failure branches', async () => {
    const { BankVerificationRepository } = await import('../src/bank-verification/bank-verification.repository');

    const originalOrderCode = '777888999';
    const bankTransferRef = 'FT_BANK_TRANSFER_001';

    let updatedTxProviderId = '';

    const mockLockedTx = {
      id: BigInt(501),
      bank_account_id: BigInt(10),
      reference_code: 'REF_STORE_VERIFY_01',
      expected_amount: 2000,
      received_amount: null,
      provider_transaction_id: originalOrderCode, // Original PayOS orderCode!
      status: 'PENDING',
      expires_at: new Date(Date.now() - 60000), // EXPIRED!
      refund_status: null,
    };

    const mockLockedAccount = {
      id: BigInt(10),
      bank_bin: '970422',
      account_number_encrypted: CryptoVaultUtil.encryptAccountNumber('12345678'),
      account_name: 'STORE TEST',
    };

    const mockTx = {
      $queryRaw: async (sql: any) => {
        const text = String(sql?.strings ? sql.strings.join(' ') : sql);
        if (text.includes('bank_account_verification_transactions')) {
          return [mockLockedTx];
        }
        if (text.includes('store_bank_accounts')) {
          return [mockLockedAccount];
        }
        if (text.includes('store_bank_inbound_receipts')) {
          return []; // No duplicate receipt
        }
        return [];
      },
      $executeRaw: async (sql: any, ...values: any[]) => {
        const text = String(sql?.strings ? sql.strings.join(' ') : sql);
        if (text.includes('UPDATE bank_account_verification_transactions')) {
          // SQL contains COALESCE(bank_account_verification_transactions.provider_transaction_id, ...)
          // Simulating DB behavior: lockedTx.provider_transaction_id is preserved!
          updatedTxProviderId = mockLockedTx.provider_transaction_id;
        }
      },
    };

    const mockPrisma = {
      $transaction: async (cb: any) => cb(mockTx),
    };

    const repo = new BankVerificationRepository(mockPrisma as any);

    const result = await repo.executeAtomicWebhookVerificationTx({
      referenceCode: 'REF_STORE_VERIFY_01',
      receivedAmount: 2000,
      providerTransactionId: bankTransferRef, // Bank transfer reference
      orderCode: Number(originalOrderCode),
      senderAccountNumber: '12345678',
      senderBankBin: '970422',
    });

    assert(result.success === false, 'Expired session must return success: false');
    assert(result.transaction.provider_transaction_id === originalOrderCode, `Expected original orderCode ${originalOrderCode}, got: ${result.transaction.provider_transaction_id}`);
    assert(updatedTxProviderId === originalOrderCode, 'Database update must preserve original orderCode in provider_transaction_id');
  });

  // ---------------------------------------------------------------------------
  // 7. Item K: Customer Link Recovery without checkoutUrl in GET response
  // ---------------------------------------------------------------------------
  await test('7.1 [Item K] recoverExistingPaymentLink recovers real provider id and fallback URL when checkoutUrl is absent in GET schema', async () => {
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

  // ---------------------------------------------------------------------------
  // 8. Item E: Late payment on cancelled order with active replacement sibling
  // ---------------------------------------------------------------------------
  await test('8.1 [Item E] confirmPaymentAtomicTx transitions cancelled transaction to REFUND_PENDING when active replacement sibling exists', async () => {
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
          if (where.orderId === BigInt(5001) && where.status?.in?.includes('PENDING')) {
            return {
              paymentTransactionId: BigInt(102),
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
    assert(result.status === 'REFUND_PENDING', `Expected REFUND_PENDING, got: ${result.status}`);
    assert(updatedOrderStatus === 'REFUND_PENDING', `Expected order paymentStatus REFUND_PENDING, got: ${updatedOrderStatus}`);
    assert(statusHistoryReason.includes('liên kết cũ đã hủy'), 'Must record audit trail for cancelled payment received');
  });

  // ---------------------------------------------------------------------------
  // 9. Item A: Store Webhook Signed Data Boundary
  // ---------------------------------------------------------------------------
  await test('9.1 [Item A] handleVerificationWebhook rejects contradictory top-level referenceCode', async () => {
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
        referenceCode: 'VERIFY_SPOOFED_SESSION',
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
