import { RentalsService } from '../src/rentals/rentals.service';
import { RentalsRepository } from '../src/rentals/rentals.repository';
import { assertTestDatabase } from './test-db-guard';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import * as crypto from 'crypto';
import { CryptoVaultUtil } from '../src/common/utils/crypto-vault.util';
import { verifyDepositRefundPayoutEvidence } from '../src/rentals/deposit-payout-verifier';
import { OutboxConsumerService } from '../src/rentals/outbox-consumer.service';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { AdminConfirmPayoutDto } from '../src/rentals/dto/admin-confirm-payout.dto';

async function runPhase5ReturnAndDepositPayoutSuite() {
  process.env.TEST_DATABASE_URL = 'postgresql://postgres:postgres@localhost:5432/platform_button_rental_test';
  assertTestDatabase('Phase 5: Return Flow & Payout Reconciliation');
  console.log('================================================================================');
  console.log('⚡ PHASE 5: RETURN FLOW & FAIL-CLOSED PAYOUT RECONCILIATION');
  console.log('================================================================================\n');

  let passed = 0;
  let failed = 0;

  const assert = (condition: boolean, testName: string, detail?: string) => {
    if (condition) {
      console.log(`  ✔ [PASS] ${testName}`);
      passed++;
    } else {
      console.error(`  ✖ [FAIL] ${testName}${detail ? ` -> ${detail}` : ''}`);
      failed++;
    }
  };

  const refundsMap = new Map<string, any>();
  const auditLogsList: any[] = [];

  const expectedPlainAccount = '1029381234';
  const expectedAccountHash = crypto.createHash('sha256').update(expectedPlainAccount).digest('hex');
  const expectedAccountEncrypted = CryptoVaultUtil.encryptAccountNumber(expectedPlainAccount);

  // Setup initial refund: PENDING_PAYOUT with recipient snapshot
  refundsMap.set('501', {
    refundId: BigInt(501),
    refundCode: 'REF-2026-001',
    rentalId: BigInt(10),
    customerId: BigInt(100),
    amount: 150000,
    status: 'PENDING_PAYOUT',
    providerReferenceId: 'PAYOUT-REF-999',
    recipientBin: '970422',
    recipientAccountNumberEncrypted: expectedAccountEncrypted,
    recipientAccountNumberHash: expectedAccountHash,
    recipientAccountHolderName: 'NGUYEN VAN A',
    recipientAccountNumberMasked: '******1234',
    bankAccountId: BigInt(77),
    bankAccount: {
      id: BigInt(77),
      bankBin: '970422',
      accountNumberHash: expectedAccountHash,
      accountNumberMasked: '******1234',
      accountName: 'NGUYEN VAN A',
    },
  });

  // Mock PayOS Payout Provider responses
  let mockPayoutResponse: any = null;
  let mockCreatePayoutResponse: any = null;

  const mockPayosPayoutService: any = {
    getPayout: async (ref: string) => {
      return mockPayoutResponse;
    },
    createPayout: async (payload: any) => {
      return mockCreatePayoutResponse;
    },
  };

  const mockRentalsRepo: any = {
    findDepositRefundById: async (id: bigint) => refundsMap.get(id.toString()) || null,
    confirmDepositRefundPayoutTx: async (refundId: bigint, providerRef: string, actor: any) => {
      const refund = refundsMap.get(refundId.toString());
      if (!refund) throw new NotFoundException('Refund not found');
      const oldProviderRef = refund.providerReferenceId;
      refund.status = 'REFUNDED';
      refund.providerReferenceId = providerRef;
      refund.refundedAt = new Date();
      auditLogsList.push({
        action: 'CONFIRM_DEPOSIT_REFUND_PAYOUT',
        targetId: refundId,
        actorUserId: actor?.userId,
        previousProviderReferenceId: oldProviderRef || null,
        isReferenceOverridden: Boolean(oldProviderRef && oldProviderRef !== providerRef),
      });
      return {
        refundId,
        status: 'REFUNDED',
        providerReferenceId: providerRef,
        amount: refund.amount,
      };
    },
  };

  const rentalsService = new RentalsService(mockRentalsRepo, undefined, mockPayosPayoutService);
  const adminActor = { role: 'SUPER_ADMIN', userId: '1' };

  try {
    // Test 1: Payout response without transactions array is REJECTED fail-closed
    mockPayoutResponse = {
      code: '00',
      desc: 'success',
      data: {
        id: 'PAYOUT-REF-999',
        referenceId: 'REF-2026-001',
        amount: 150000,
        approvalState: 'SUCCEEDED',
        transactions: [], // EMPTY transactions array -> Must reject
      },
    };

    try {
      await rentalsService.reconcileDepositRefundPayout('501', adminActor);
      assert(false, '5.1 [P0 Blocker] Từ chối fail-closed khi cổng thanh toán thiếu mảng chi tiết transactions');
    } catch (e: any) {
      assert(
        e instanceof BadRequestException && e.message.includes('thiếu danh sách giao dịch chi tiết'),
        '5.1 [P0 Blocker] Từ chối fail-closed khi cổng thanh toán thiếu mảng chi tiết transactions',
      );
    }

    // Test 2: Payout response with amount mismatch is REJECTED fail-closed
    mockPayoutResponse = {
      code: '00',
      desc: 'success',
      data: {
        id: 'PAYOUT-REF-999',
        referenceId: 'REF-2026-001',
        amount: 120000, // Mismatched (refund is 150,000)
        approvalState: 'SUCCEEDED',
        transactions: [
          {
            id: 'TXN-001',
            referenceId: 'REF-2026-001',
            amount: 120000,
            state: 'SUCCEEDED',
            toBin: '970422',
            toAccountNumber: '1029381234',
          },
        ],
      },
    };

    try {
      await rentalsService.reconcileDepositRefundPayout('501', adminActor);
      assert(false, '5.2 [P0 Blocker] Từ chối fail-closed khi số tiền giao dịch từ cổng lệch với số tiền hoàn cọc');
    } catch (e: any) {
      assert(
        e instanceof BadRequestException && e.message.includes('không khớp với số tiền hoàn cọc'),
        '5.2 [P0 Blocker] Từ chối fail-closed khi số tiền giao dịch từ cổng lệch với số tiền hoàn cọc',
      );
    }

    // Test 3: Payout response with reference mismatch is REJECTED fail-closed
    mockPayoutResponse = {
      code: '00',
      desc: 'success',
      data: {
        id: 'FOREIGN-REF-888',
        referenceId: 'REF-FOREIGN',
        amount: 150000,
        approvalState: 'SUCCEEDED',
        transactions: [
          {
            id: 'TXN-999',
            referenceId: 'REF-FOREIGN',
            amount: 150000,
            state: 'SUCCEEDED',
            toBin: '970422',
            toAccountNumber: '1029381234',
          },
        ],
      },
    };

    try {
      await rentalsService.reconcileDepositRefundPayout('501', adminActor);
      assert(false, '5.3 [P0 Blocker] Từ chối fail-closed khi mã tham chiếu không khớp với yêu cầu hoàn cọc');
    } catch (e: any) {
      assert(
        e instanceof BadRequestException &&
          (e.message.includes('không khớp với providerReferenceId') || e.message.includes('Không tìm thấy transaction chi tiết nào khớp')),
        '5.3 [P0 Blocker] Từ chối fail-closed khi mã tham chiếu không khớp với yêu cầu hoàn cọc',
      );
    }

    // Test 4: Payout response with recipient bank BIN mismatch is REJECTED fail-closed
    mockPayoutResponse = {
      code: '00',
      desc: 'success',
      data: {
        id: 'PAYOUT-REF-999',
        referenceId: 'REF-2026-001',
        amount: 150000,
        approvalState: 'SUCCEEDED',
        transactions: [
          {
            id: 'TXN-001',
            referenceId: 'REF-2026-001',
            amount: 150000,
            state: 'SUCCEEDED',
            toBin: '970415', // Mismatched BIN (expected 970422)
            toAccountNumber: '1029381234',
          },
        ],
      },
    };

    try {
      await rentalsService.reconcileDepositRefundPayout('501', adminActor);
      assert(false, '5.4 [P0 Blocker] Từ chối fail-closed khi mã BIN ngân hàng nhận không khớp với tài khoản snapshot');
    } catch (e: any) {
      assert(
        e instanceof BadRequestException && e.message.includes('Mã BIN ngân hàng nhận từ cổng'),
        '5.4 [P0 Blocker] Từ chối fail-closed khi mã BIN ngân hàng nhận không khớp với tài khoản snapshot',
      );
    }

    // Test 5: Payout response with recipient account number mismatch is REJECTED fail-closed
    mockPayoutResponse = {
      code: '00',
      desc: 'success',
      data: {
        id: 'PAYOUT-REF-999',
        referenceId: 'REF-2026-001',
        amount: 150000,
        approvalState: 'SUCCEEDED',
        transactions: [
          {
            id: 'TXN-001',
            referenceId: 'REF-2026-001',
            amount: 150000,
            state: 'SUCCEEDED',
            toBin: '970422',
            toAccountNumber: '1029389999', // Mismatched account
          },
        ],
      },
    };

    try {
      await rentalsService.reconcileDepositRefundPayout('501', adminActor);
      assert(false, '5.5 [P0 Blocker] Từ chối fail-closed khi số tài khoản nhận không khớp với tài khoản snapshot');
    } catch (e: any) {
      assert(
        e instanceof BadRequestException && e.message.includes('không khớp với tài khoản snapshot'),
        '5.5 [P0 Blocker] Từ chối fail-closed khi số tài khoản nhận không khớp với tài khoản snapshot',
      );
    }

    // Test 6: Fully verified payout evidence successfully settles and moves refund to REFUNDED
    mockPayoutResponse = {
      code: '00',
      desc: 'success',
      data: {
        id: 'PAYOUT-REF-999',
        referenceId: 'REF-2026-001',
        amount: 150000,
        approvalState: 'SUCCEEDED',
        transactions: [
          {
            id: 'TXN-001',
            referenceId: 'REF-2026-001',
            amount: 150000,
            state: 'SUCCEEDED',
            toBin: '970422',
            toAccountNumber: '1029381234',
          },
        ],
      },
    };

    const settleResult: any = await rentalsService.reconcileDepositRefundPayout('501', adminActor);

    assert(
      settleResult.status === 'REFUNDED' &&
        refundsMap.get('501').status === 'REFUNDED' &&
        auditLogsList.some((a) => a.action === 'CONFIRM_DEPOSIT_REFUND_PAYOUT'),
      '5.6 Đối soát Payout thành công với đầy đủ bằng chứng giao dịch chi tiết, chuyển trạng thái sang REFUNDED và ghi audit log',
    );

    // Test 7: Idempotent Replay on already REFUNDED deposit refund
    const replayResult: any = await rentalsService.reconcileDepositRefundPayout('501', adminActor);

    assert(
      replayResult.alreadyConfirmed === true && replayResult.refund.status === 'REFUNDED',
      '5.7 [Idempotency] Gọi lại đối soát trên refund đã REFUNDED trả về an toàn (alreadyConfirmed: true), không xử lý trùng',
    );

    // Test 8: Fail-closed when txn.amount is undefined even if payoutData.amount is valid (ZERO FALLBACK)
    refundsMap.set('502', {
      refundId: BigInt(502),
      refundCode: 'REF-2026-002',
      rentalId: BigInt(10),
      customerId: BigInt(100),
      amount: 150000,
      status: 'PENDING_PAYOUT',
      providerReferenceId: 'PAYOUT-REF-888',
      recipientBin: '970422',
      recipientAccountNumberEncrypted: expectedAccountEncrypted,
      recipientAccountNumberHash: expectedAccountHash,
      recipientAccountHolderName: 'NGUYEN VAN A',
      recipientAccountNumberMasked: '******1234',
      bankAccountId: BigInt(77),
      bankAccount: {
        id: BigInt(77),
        bankBin: '970422',
        accountNumberHash: expectedAccountHash,
        accountNumberMasked: '******1234',
        accountName: 'NGUYEN VAN A',
      },
    });

    mockPayoutResponse = {
      code: '00',
      desc: 'success',
      data: {
        id: 'PAYOUT-REF-888',
        referenceId: 'REF-2026-002',
        amount: 150000, // Summary amount exists
        approvalState: 'SUCCEEDED',
        transactions: [
          {
            id: 'TXN-888',
            referenceId: 'REF-2026-002',
            amount: undefined, // Missing transaction-level amount -> ZERO FALLBACK MUST REJECT!
            state: 'SUCCEEDED',
            toBin: '970422',
            toAccountNumber: '1029381234',
          },
        ],
      },
    };

    try {
      await rentalsService.reconcileDepositRefundPayout('502', adminActor);
      assert(false, '5.8 [Zero Fallback] Từ chối fail-closed khi txn.amount bị thiếu dù summary amount có giá trị');
    } catch (e: any) {
      assert(
        e instanceof BadRequestException && e.message.includes('thiếu thông tin số tiền giao dịch hợp lệ'),
        '5.8 [Zero Fallback] Từ chối fail-closed khi txn.amount bị thiếu dù summary amount có giá trị',
      );
    }

    // Test 9: Transaction lacks individual success status -> MUST REJECT (no fallback to summary approvalState)
    const test9PayoutData = {
      id: 'PAYOUT-REF-888',
      approvalState: 'SUCCEEDED',
      transactions: [
        {
          id: 'TXN-888',
          referenceId: 'REF-2026-002',
          amount: 150000,
          // Missing state/status!
          toBin: '970422',
          toAccountNumber: '1029381234',
        },
      ],
    };
    const test9Verification = verifyDepositRefundPayoutEvidence(test9PayoutData, refundsMap.get('502'));
    assert(
      test9Verification.isVerified === false &&
        test9Verification.reason?.includes('thiếu trạng thái thành công riêng'),
      '5.9 [Fail-Closed] Từ chối xác nhận khi transaction thiếu trạng thái thành công riêng (không fallback sang trạng thái tổng)',
    );

    // Test 10: Missing recipient verification evidence in transaction (missing BIN or account)
    const test10PayoutData = {
      id: 'PAYOUT-REF-888',
      approvalState: 'SUCCEEDED',
      transactions: [
        {
          id: 'TXN-888',
          referenceId: 'REF-2026-002',
          amount: 150000,
          state: 'SUCCEEDED',
          // Missing toBin and toAccountNumber!
        },
      ],
    };
    const test10Verification = verifyDepositRefundPayoutEvidence(test10PayoutData, refundsMap.get('502'));
    assert(
      test10Verification.isVerified === false &&
        (test10Verification.reason?.includes('thiếu mã BIN') || test10Verification.reason?.includes('thiếu thông tin số tài khoản')),
      '5.10 [Fail-Closed] Từ chối xác nhận khi transaction thiếu dữ liệu người nhận (BIN hoặc số tài khoản/hash)',
    );

    // Test 11: Exact decimal matching: 150000.4 vs 150000 must be REJECTED (no rounding)
    const test11PayoutData = {
      id: 'PAYOUT-REF-888',
      approvalState: 'SUCCEEDED',
      transactions: [
        {
          id: 'TXN-888',
          referenceId: 'REF-2026-002',
          amount: 150000.4, // Float deviation
          state: 'SUCCEEDED',
          toBin: '970422',
          toAccountNumber: '1029381234',
        },
      ],
    };
    const test11Verification = verifyDepositRefundPayoutEvidence(test11PayoutData, refundsMap.get('502'));
    assert(
      test11Verification.isVerified === false &&
        test11Verification.reason?.includes('không khớp với số tiền hoàn cọc'),
      '5.11 [Exact Amount] Từ chối số tiền lẻ float (150000.4 so với 150000) - không làm tròn hai vế',
    );

    // Test 12: Multiple transactions in array: search and find correct matching transaction, returning real PayOS payout ID
    const test12PayoutData = {
      id: 'PAYOUT-BATCH-002', // Real PayOS Payout ID!
      approvalState: 'SUCCEEDED',
      transactions: [
        {
          id: 'TXN-UNRELATED-1',
          referenceId: 'REF-OTHER-ORDER',
          amount: 500000,
          state: 'SUCCEEDED',
          toBin: '970415',
          toAccountNumber: '99998888',
        },
        {
          id: 'TXN-888',
          referenceId: 'REF-2026-002',
          amount: 150000,
          state: 'SUCCEEDED',
          toBin: '970422',
          toAccountNumber: '1029381234',
        },
      ],
    };
    const test12Verification = verifyDepositRefundPayoutEvidence(test12PayoutData, {
      ...refundsMap.get('502'),
      providerReferenceId: 'PAYOUT-BATCH-002',
    });
    assert(
      test12Verification.isVerified === true && test12Verification.providerRef === 'PAYOUT-BATCH-002',
      '5.12 [Txn Search & Payout ID] Tìm chính xác transaction khớp mã tham chiếu và trả về đúng payout ID của PayOS (PAYOUT-BATCH-002), không lưu nhầm transaction ID',
    );

    // Test 13: Worker invariant: missing/corrupted snapshot halts processing, leaves PENDING_PAYOUT and does NOT overwrite snapshot
    refundsMap.set('503', {
      refundId: BigInt(503),
      refundCode: 'REF-2026-003',
      rentalId: BigInt(10),
      customerId: BigInt(100),
      amount: 150000,
      status: 'PENDING_PAYOUT',
      providerReferenceId: null,
      recipientBin: null, // CORRUPTED / MISSING SNAPSHOT!
      recipientAccountNumberEncrypted: null,
      recipientAccountNumberHash: null,
      recipientAccountHolderName: null,
      recipientAccountNumberMasked: null,
      bankAccountId: BigInt(77),
    });

    let snapshotUpdated = false;
    const mockPrismaWorker: any = {
      depositRefund: {
        findUnique: async () => refundsMap.get('503'),
        update: async () => {
          snapshotUpdated = true;
        },
      },
    };

    const worker = new OutboxConsumerService(
      mockPrismaWorker,
      mockRentalsRepo,
      null as any,
      mockPayosPayoutService,
    );

    try {
      await (worker as any).handleSingleEvent({
        id: BigInt(99),
        event_type: 'DEPOSIT_REFUND_APPROVED',
        payload: { refundId: '503' },
      });
      assert(false, '5.13 [Snapshot Immutability] Worker phải dừng và từ chối xử lý khi thiếu snapshot tài khoản');
    } catch (err: any) {
      assert(
        err.message.includes('thiếu snapshot tài khoản nhận bất biến hợp lệ') &&
          snapshotUpdated === false &&
          refundsMap.get('503').status === 'PENDING_PAYOUT',
        '5.13 [Snapshot Immutability] Worker từ chối payout khi thiếu snapshot; không fallback sang CustomerBankAccount, giữ PENDING_PAYOUT và giữ cọc dự phòng',
      );
    }

    // Test 14: Admin approval invariant: approveDepositRefundTx with bank_account_id belonging to different customer
    // Captures exact SQL and parameters, verifying rollback and no UPDATE to deposit_refunds
    const capturedSqlQueries: { sql: string; params: any[] }[] = [];
    let updateDepositRefundCalled = false;

    const mockPrismaForApproval: any = {
      $transaction: async (cb: any) => cb(mockPrismaForApproval),
      $queryRawUnsafe: async (sql: string, ...params: any[]) => {
        capturedSqlQueries.push({ sql, params });
        if (sql.includes('FROM deposit_refunds')) {
          return [{
            refund_id: BigInt(601),
            rental_id: BigInt(10),
            customer_id: BigInt(100), // Owner customer ID is 100
            amount: 150000,
            status: 'PENDING_APPROVAL',
            bank_account_id: BigInt(999), // Requested bankAccountId
          }];
        }
        if (sql.includes('FROM rental_deposits')) {
          return [{
            deposit_id: BigInt(1),
            held_amount: 500000,
            refund_reserved_amount: 0,
          }];
        }
        if (sql.includes('FROM customer_bank_accounts')) {
          // In DB, account 999 belongs to customer 888. Querying with customer_id = 100 returns EMPTY!
          const [bankId, custId] = params;
          if (bankId === BigInt(999) && custId === BigInt(100)) {
            return [];
          }
          return [];
        }
        return [];
      },
      $executeRawUnsafe: async (sql: string, ...params: any[]) => {
        capturedSqlQueries.push({ sql, params });
        if (sql.includes('UPDATE deposit_refunds')) {
          updateDepositRefundCalled = true;
        }
        return 1;
      },
      outboxEvent: {
        create: async () => ({ id: BigInt(1) }),
      },
      rentalAuditLog: {
        create: async () => ({ id: BigInt(1) }),
      },
    };

    const realRepoForApproval = new RentalsRepository(mockPrismaForApproval);

    try {
      await realRepoForApproval.approveDepositRefundTx(BigInt(601), { userId: '1' });
      assert(false, '5.14 [IDOR Defense] Cho phép tài khoản ngân hàng của khách hàng khác');
    } catch (e: any) {
      const bankQuery = capturedSqlQueries.find((q) => q.sql.includes('FROM customer_bank_accounts'));
      assert(
        e instanceof BadRequestException &&
          e.message.includes('không thuộc quyền sở hữu của khách hàng') &&
          bankQuery !== undefined &&
          bankQuery.params[0] === BigInt(999) &&
          bankQuery.params[1] === BigInt(100) &&
          updateDepositRefundCalled === false,
        '5.14 [IDOR Defense] approveDepositRefundTx khóa bằng cả id và customer_id: từ chối tài khoản của khách hàng khác, rollback và không cập nhật deposit_refunds',
      );
    }

    // Test 15: Admin reconciliation rejects payout when refund snapshot is missing, even if bankAccount relation is populated
    refundsMap.set('505', {
      refundId: BigInt(505),
      refundCode: 'REF-2026-005',
      rentalId: BigInt(10),
      customerId: BigInt(100),
      amount: 150000,
      status: 'PENDING_PAYOUT',
      providerReferenceId: 'PAYOUT-BATCH-005',
      recipientBin: null, // EMPTY SNAPSHOT!
      recipientAccountNumberEncrypted: null,
      recipientAccountNumberHash: null,
      recipientAccountHolderName: null,
      recipientAccountNumberMasked: null,
      bankAccountId: BigInt(77),
      bankAccount: {
        id: BigInt(77),
        bankBin: '970422',
        accountNumberHash: expectedAccountHash,
        accountNumberMasked: '******1234',
        accountName: 'NGUYEN VAN A',
      },
    });

    mockPayoutResponse = {
      code: '00',
      desc: 'success',
      data: {
        id: 'PAYOUT-BATCH-005',
        approvalState: 'SUCCEEDED',
        transactions: [
          {
            id: 'TXN-005',
            referenceId: 'REF-2026-005',
            amount: 150000,
            state: 'SUCCEEDED',
            toBin: '970422',
            toAccountNumber: '1029381234',
          },
        ],
      },
    };

    try {
      await rentalsService.reconcileDepositRefundPayout('505', adminActor);
      assert(false, '5.15 [Admin Snapshot Invariant] Luồng đối soát admin cho phép xác nhận khi thiếu snapshot');
    } catch (e: any) {
      assert(
        e instanceof BadRequestException && e.message.includes('thiếu mã BIN người nhận trong snapshot bất biến đã duyệt'),
        '5.15 [Admin Snapshot Invariant] Luồng đối soát admin từ chối xác nhận payout khi thiếu snapshot, tuyệt đối không fallback sang quan hệ bankAccount',
      );
    }

    // Test 16: Worker invariant: when PayOS createPayout response lacks data.id, worker throws error so outbox event retries with refundCode idempotency or lands in DLQ
    refundsMap.set('506', {
      refundId: BigInt(506),
      refundCode: 'REF-2026-006',
      rentalId: BigInt(10),
      customerId: BigInt(100),
      amount: 150000,
      status: 'PENDING_PAYOUT',
      providerReferenceId: null,
      recipientBin: '970422',
      recipientAccountNumberEncrypted: expectedAccountEncrypted,
      recipientAccountNumberHash: expectedAccountHash,
      recipientAccountHolderName: 'NGUYEN VAN A',
      recipientAccountNumberMasked: '******1234',
      bankAccountId: BigInt(77),
    });

    let refund506UpdatedWithProviderRef = false;
    const mockPrismaWorkerForMissingId: any = {
      depositRefund: {
        findUnique: async () => refundsMap.get('506'),
        update: async (args: any) => {
          if (args.data?.providerReferenceId) {
            refund506UpdatedWithProviderRef = true;
          }
        },
      },
    };

    mockCreatePayoutResponse = {
      code: '00',
      desc: 'success',
      data: {
        // Missing id! E.g. { referenceId: 'REF-2026-006', amount: 150000 }
        referenceId: 'REF-2026-006',
        amount: 150000,
      },
    };

    const workerMissingId = new OutboxConsumerService(
      mockPrismaWorkerForMissingId,
      mockRentalsRepo,
      null as any,
      mockPayosPayoutService,
    );

    try {
      await (workerMissingId as any).handleSingleEvent({
        id: BigInt(101),
        event_type: 'DEPOSIT_REFUND_APPROVED',
        payload: { refundId: '506' },
      });
      assert(false, '5.16 [Missing Payout ID Recovery] Worker chấp nhận response thiếu data.id mà không ném lỗi retry');
    } catch (err: any) {
      assert(
        err.message.includes('PayOS không trả về mã payout ID thật (data.id)') &&
          refund506UpdatedWithProviderRef === false &&
          refundsMap.get('506').status === 'PENDING_PAYOUT',
        '5.16 [Missing Payout ID Recovery] Worker ném lỗi khi thiếu data.id để outbox retry với refundCode hoặc chuyển DLQ; không đánh dấu COMPLETED âm thầm',
      );
    }

    // Test 17: Admin manual reconciliation when providerReferenceId is initially null:
    // 1) Rejects when called without providerReferenceId
    try {
      await rentalsService.reconcileDepositRefundPayout('506', adminActor);
      assert(false, '5.17 [Admin Manual Payout ID] Cho phép đối soát khi không có providerReferenceId');
    } catch (e: any) {
      assert(
        e instanceof BadRequestException &&
          e.message.includes('Vui lòng cung cấp mã payout ID thật từ PayOS để đối soát'),
        '5.17a [Admin Manual Payout ID] Từ chối đối soát khi thiếu providerReferenceId và chưa cung cấp mã payout thủ công',
      );
    }

    // 2) Successfully confirms when admin supplies manualProviderReferenceId:
    mockPayoutResponse = {
      code: '00',
      desc: 'success',
      data: {
        id: 'PAYOUT-BATCH-MANUAL-777',
        referenceId: 'REF-2026-006',
        amount: 150000,
        approvalState: 'SUCCEEDED',
        transactions: [
          {
            id: 'TXN-006',
            referenceId: 'REF-2026-006',
            amount: 150000,
            state: 'SUCCEEDED',
            toBin: '970422',
            toAccountNumber: '1029381234',
          },
        ],
      },
    };

    const manualReconcileResult: any = await rentalsService.reconcileDepositRefundPayout(
      '506',
      adminActor,
      'PAYOUT-BATCH-MANUAL-777',
    );

    assert(
      manualReconcileResult.status === 'REFUNDED' &&
        manualReconcileResult.providerReferenceId === 'PAYOUT-BATCH-MANUAL-777' &&
        refundsMap.get('506').status === 'REFUNDED',
      '5.17b [Admin Manual Payout ID] Admin đối soát thành công khi nhập payout ID tra cứu từ PayOS, gắn ID thật và hoàn tất hoàn cọc an toàn',
    );

    // Test 18: Outbox processor lifecycle via processPendingEvents (Full 3-Step Retry & Backoff to DLQ Lifecycle)
    // When PayOS createPayout response lacks data.id:
    // Uses a simulated clock to test the natural 3-step lifecycle without manual attempt mutation:
    // - Step 1: attempts = 0 -> fails -> updates attempts = 1, nextAttemptAt = now + 10s (backoff: 5s * 2^1)
    // - Step 1b: polling prematurely at now + 5s -> blocked (nextAttemptAt > now), 0 events claimed
    // - Step 2: time advances past 10s -> claims again -> fails -> updates attempts = 2, nextAttemptAt = now + 20s (backoff: 5s * 2^2)
    // - Step 3: time advances past 20s -> claims again -> fails 3rd time (attemptsMade: 3 >= 3) -> moves to DeadLetterJob (DLQ) and status = FAILED
    const outboxEventsMap = new Map<string, any>();
    const deadLetterJobsList: any[] = [];
    const capturedOutboxSql: string[] = [];

    let simulatedNow = 1793400000000; // Fixed deterministic timestamp
    const originalDateNow = Date.now;
    Date.now = () => simulatedNow;

    try {
      outboxEventsMap.set('201', {
        id: BigInt(201),
        event_type: 'DEPOSIT_REFUND_APPROVED',
        payload: JSON.stringify({ refundId: '506' }),
        attempts: 0,
        status: 'PENDING',
        locked_until: new Date(simulatedNow - 10000),
        next_attempt_at: new Date(simulatedNow - 1000),
        claim_token: null,
      });

      const mockPrismaOutboxProcess: any = {
        $transaction: async (cb: any) => cb(mockPrismaOutboxProcess),
        $queryRawUnsafe: async (sql: string, ...params: any[]) => {
          capturedOutboxSql.push(sql);
          if (sql.includes('FROM outbox_events')) {
            const ev = outboxEventsMap.get('201');
            // Replicates: WHERE (status = 'PENDING' OR (status = 'PROCESSING' AND locked_until < NOW())) AND next_attempt_at <= NOW()
            if (
              ev &&
              (ev.status === 'PENDING' || ev.status === 'PROCESSING') &&
              ev.next_attempt_at.getTime() <= simulatedNow
            ) {
              return [ev];
            }
            return [];
          }
          return [];
        },
        $executeRawUnsafe: async (sql: string, ...params: any[]) => {
          if (sql.includes('UPDATE outbox_events')) {
            const ev = outboxEventsMap.get('201');
            if (ev) {
              ev.status = 'PROCESSING';
              ev.claimToken = params[0];
            }
          }
          return 1;
        },
        outboxEvent: {
          updateMany: async (args: any) => {
            const ev = outboxEventsMap.get('201');
            if (ev) {
              Object.assign(ev, args.data);
              if (args.data.nextAttemptAt) {
                ev.next_attempt_at = args.data.nextAttemptAt;
              }
            }
            return { count: 1 };
          },
        },
        deadLetterJob: {
          create: async (args: any) => {
            deadLetterJobsList.push(args.data);
            return { id: BigInt(deadLetterJobsList.length), ...args.data };
          },
        },
        depositRefund: {
          findUnique: async () => refundsMap.get('506'),
          update: async () => {},
        },
      };

      mockCreatePayoutResponse = {
        code: '00',
        desc: 'success',
        data: {
          // missing id!
          referenceId: 'REF-2026-006',
          amount: 150000,
        },
      };

      const outboxProcessor = new OutboxConsumerService(
        mockPrismaOutboxProcess,
        mockRentalsRepo,
        null as any,
        mockPayosPayoutService,
      );

      // Step 1: First attempt at T0
      const run1Results = await outboxProcessor.processPendingEvents(10);
      const evAfterRun1 = outboxEventsMap.get('201');

      assert(
        run1Results.failed === 1 &&
          run1Results.processed === 0 &&
          evAfterRun1.status === 'PENDING' &&
          evAfterRun1.attempts === 1 &&
          evAfterRun1.next_attempt_at.getTime() === simulatedNow + 10000 &&
          evAfterRun1.next_attempt_at.getTime() > simulatedNow,
        '5.18a [Outbox Processor Lifecycle] Lần 1: Event thiếu payout ID giữ PENDING với attempts = 1 và nextAttemptAt lùi 10s (5s * 2^1)',
      );

      // Step 1b: Polling prematurely at T0 + 5s (before 10s backoff expires) -> 0 events claimed!
      simulatedNow += 5000;
      const prematureResults = await outboxProcessor.processPendingEvents(10);
      assert(
        prematureResults.processed === 0 &&
          prematureResults.failed === 0 &&
          outboxEventsMap.get('201').status === 'PENDING',
        '5.18b [Outbox Backoff Guard] Quét sớm khi chưa hết backoff (T0 + 5s < nextAttemptAt) không bị claim và không xử lý trùng',
      );

      // Step 2: Time advances past 10s (T0 + 11s) -> Second attempt runs naturally
      simulatedNow += 6000; // Total 11s from T0
      const run2Results = await outboxProcessor.processPendingEvents(10);
      const evAfterRun2 = outboxEventsMap.get('201');

      assert(
        run2Results.failed === 1 &&
          evAfterRun2.status === 'PENDING' &&
          evAfterRun2.attempts === 2 &&
          evAfterRun2.next_attempt_at.getTime() === simulatedNow + 20000 &&
          evAfterRun2.next_attempt_at.getTime() > simulatedNow,
        '5.18c [Outbox Processor Lifecycle] Lần 2: Hết backoff 1, worker chạy lại tự nhiên, tăng attempts = 2 và lùi 20s (5s * 2^2)',
      );

      // Step 3: Time advances past 20s (T0 + 11s + 21s) -> Third attempt runs naturally and hits maxAttempts (3)
      simulatedNow += 21000;
      const run3Results = await outboxProcessor.processPendingEvents(10);
      const evAfterRun3 = outboxEventsMap.get('201');

      assert(
        run3Results.dlqMoved === 1 &&
          evAfterRun3.status === 'FAILED' &&
          deadLetterJobsList.length === 1 &&
          deadLetterJobsList[0].jobName === 'DEPOSIT_REFUND_APPROVED' &&
          deadLetterJobsList[0].attemptsMade === 3 &&
          deadLetterJobsList[0].failedReason.includes('PayOS không trả về mã payout ID thật'),
        '5.18d [Outbox Processor Lifecycle] Lần 3: Vượt quá số lần retry (3 lần), chuyển trọn vẹn vào DeadLetterJob (DLQ) với status = FAILED',
      );

      assert(
        capturedOutboxSql.some(
          (sql) =>
            sql.includes('FROM outbox_events') &&
            sql.includes('next_attempt_at <= NOW()') &&
            sql.includes('FOR UPDATE SKIP LOCKED'),
        ),
        '5.18e [SQL Predicate Invariant] Truy vấn claim sự kiện bắt buộc chứa điều kiện "next_attempt_at <= NOW()" và "FOR UPDATE SKIP LOCKED"',
      );
    } finally {
      Date.now = originalDateNow;
    }

    // Test 19: Admin Override Payout ID and Stored ID Invariants:
    // Refund 507 has a pre-existing incorrect/stale providerReferenceId
    refundsMap.set('507', {
      refundId: BigInt(507),
      refundCode: 'REF-2026-007',
      rentalId: BigInt(10),
      customerId: BigInt(100),
      amount: 150000,
      status: 'PENDING_PAYOUT',
      providerReferenceId: 'STALE-INCORRECT-ID',
      recipientBin: '970422',
      recipientAccountNumberEncrypted: expectedAccountEncrypted,
      recipientAccountNumberHash: expectedAccountHash,
      recipientAccountHolderName: 'NGUYEN VAN A',
      recipientAccountNumberMasked: '******1234',
      bankAccountId: BigInt(77),
    });

    // 19a: Admin inputs invalid code -> PayOS query fails or verification fails -> DB remains untouched
    mockPayoutResponse = {
      code: '01',
      desc: 'Payout not found or invalid',
      data: null,
    };

    try {
      await rentalsService.reconcileDepositRefundPayout('507', adminActor, 'INVALID-MANUAL-ID');
      assert(false, '5.19a [Admin Override Safety] Cho phép đối soát khi mã payout nhập tay không tồn tại trên PayOS');
    } catch (e: any) {
      assert(
        e instanceof BadRequestException &&
          refundsMap.get('507').status === 'PENDING_PAYOUT' &&
          refundsMap.get('507').providerReferenceId === 'STALE-INCORRECT-ID',
        '5.19a [Admin Override Safety] Mã admin nhập sai không làm thay đổi DB; giữ nguyên trạng thái PENDING_PAYOUT và mã cũ',
      );
    }

    // 19b: Admin inputs valid replacement code -> PayOS returns valid evidence matching refund details -> DB updates to new code and audit logs override
    mockPayoutResponse = {
      code: '00',
      desc: 'success',
      data: {
        id: 'PAYOUT-CORRECT-OVERRIDE-888',
        referenceId: 'REF-2026-007',
        amount: 150000,
        approvalState: 'SUCCEEDED',
        transactions: [
          {
            id: 'TXN-007',
            referenceId: 'REF-2026-007',
            amount: 150000,
            state: 'SUCCEEDED',
            toBin: '970422',
            toAccountNumber: '1029381234',
          },
        ],
      },
    };

    const overrideResult: any = await rentalsService.reconcileDepositRefundPayout(
      '507',
      adminActor,
      'PAYOUT-CORRECT-OVERRIDE-888',
    );

    const auditEntry = auditLogsList.find((a) => a.targetId === BigInt(507));

    assert(
      overrideResult.status === 'REFUNDED' &&
        overrideResult.providerReferenceId === 'PAYOUT-CORRECT-OVERRIDE-888' &&
        refundsMap.get('507').status === 'REFUNDED' &&
        refundsMap.get('507').providerReferenceId === 'PAYOUT-CORRECT-OVERRIDE-888' &&
        auditEntry !== undefined &&
        auditEntry.previousProviderReferenceId === 'STALE-INCORRECT-ID' &&
        auditEntry.isReferenceOverridden === true,
      '5.19b [Admin Override Safety] Admin đối soát thành công với mã hợp lệ mới, DB cập nhật mã mới và ghi audit log vết ghi đè',
    );

    // Test 20: AdminConfirmPayoutDto Validation Invariants
    // 20a: Empty string fails validation
    const dtoEmpty = plainToInstance(AdminConfirmPayoutDto, { providerReferenceId: '' });
    const errorsEmpty = await validate(dtoEmpty);
    assert(
      errorsEmpty.length > 0,
      '5.20a [DTO Validation] AdminConfirmPayoutDto từ chối chuỗi rỗng',
    );

    // 20b: All whitespace fails validation after trim
    const dtoWhitespace = plainToInstance(AdminConfirmPayoutDto, { providerReferenceId: '    ' });
    const errorsWhitespace = await validate(dtoWhitespace);
    assert(
      errorsWhitespace.length > 0,
      '5.20b [DTO Validation] AdminConfirmPayoutDto từ chối chuỗi chỉ gồm khoảng trắng',
    );

    // 20c: String exceeding 100 characters fails validation
    const dtoTooLong = plainToInstance(AdminConfirmPayoutDto, {
      providerReferenceId: 'P'.repeat(101),
    });
    const errorsTooLong = await validate(dtoTooLong);
    assert(
      errorsTooLong.length > 0,
      '5.20c [DTO Validation] AdminConfirmPayoutDto từ chối chuỗi vượt quá 100 ký tự',
    );

    // 20d: Non-string type fails validation
    const dtoNonString = plainToInstance(AdminConfirmPayoutDto, { providerReferenceId: 123456 as any });
    const errorsNonString = await validate(dtoNonString);
    assert(
      errorsNonString.length > 0,
      '5.20d [DTO Validation] AdminConfirmPayoutDto từ chối dữ liệu không phải chuỗi',
    );

    // 20e: Valid payout ID passes validation cleanly
    const dtoValid = plainToInstance(AdminConfirmPayoutDto, {
      providerReferenceId: 'PAYOUT-BATCH-VALID-999',
    });
    const errorsValid = await validate(dtoValid);
    assert(
      errorsValid.length === 0,
      '5.20e [DTO Validation] AdminConfirmPayoutDto chấp nhận mã payout ID hợp lệ (PAYOUT-BATCH-VALID-999)',
    );

  } catch (err: any) {
    console.error('Fatal test error in Phase 5 suite:', err);
    failed++;
  }

  console.log(`\n================================================================================`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log(`================================================================================\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

runPhase5ReturnAndDepositPayoutSuite().catch((err) => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
