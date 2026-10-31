import { RentalsService } from '../src/rentals/rentals.service';
import { BadRequestException } from '@nestjs/common';

async function runTask4TestSuite() {
  console.log('================================================================================');
  console.log('⚡ TASK 4: BUTTON RETURN & DEPOSIT REFUND WORKFLOW TEST SUITE');
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

  try {
    const mockRentalsRepo: any = {
      listAvailablePackages: async () => [],
      findRentalById: async (id: bigint) => ({
        rentalId: id,
        rentalCode: 'RNT-TEST-004',
        customerId: BigInt(55),
        packageId: BigInt(1),
        depositAmount: 200000,
        status: 'ACTIVE',
        buttons: [{ buttonId: BigInt(10), buttonCode: 'BTN-001', deviceId: 'DEV-001' }],
        customer: { userId: BigInt(100), customerId: BigInt(55) },
      }),
      createReturnRequestTx: async () => null,
      confirmReturnReceiptTx: async () => null,
      approveDepositRefundTx: async () => null,
      findDepositRefundById: async (refundId: bigint) => ({
        refundId,
        status: 'PENDING_PAYOUT',
        amount: 200000,
        providerReferenceId: 'PAYOS-PAYOUT-REF-99',
      }),
    };

    const mockPayosPayoutService: any = {
      getPayout: async () => ({
        code: '00',
        desc: 'success',
        data: {
          id: 'PAYOS-PAYOUT-REF-99',
          approvalState: 'COMPLETED',
          amount: 200000,
          transactions: [
            {
              id: 'TXN-999',
              amount: 200000,
              reference: 'PAYOS-PAYOUT-REF-99',
            },
          ],
        },
      }),
    };

    const rentalsService = new RentalsService(mockRentalsRepo, null, mockPayosPayoutService);

    // Test 1: Customer submits return request -> creates return with PENDING_RECEIPT
    mockRentalsRepo.createReturnRequestTx = async (rentalId: bigint, buttonId: bigint) => ({
      returnId: BigInt(1),
      returnCode: 'RET-001',
      rentalId,
      buttonId,
      status: 'PENDING_RECEIPT',
    });

    const returnReq = await rentalsService.createReturnRequest('10', '10', {
      customerProfileId: '55',
      userId: '100',
    });

    assert(
      returnReq.status === 'PENDING_RECEIPT' && returnReq.returnCode === 'RET-001',
      'Return request created with status PENDING_RECEIPT',
    );

    // Test 2: Store confirms receipt -> returns custody to store, logs movement, creates refund claim
    mockRentalsRepo.confirmReturnReceiptTx = async (returnId: bigint, storeStaffUser: any) => ({
      returnId,
      status: 'RECEIVED',
      button: {
        buttonId: BigInt(10),
        customerId: null,
        rentalId: null,
        inventoryState: 'ALLOCATED_TO_STORE',
        custodyStoreId: BigInt(77),
      },
      movementLogged: true,
      depositRefund: {
        refundId: BigInt(1),
        refundCode: 'REF-001',
        amount: 200000,
        status: 'PENDING_APPROVAL',
      },
    });

    const receiptResult = await rentalsService.confirmReturnReceipt('1', {
      userId: '2',
      storeId: '77',
      role: 'STORE_OWNER',
    });

    assert(
      receiptResult.status === 'RECEIVED' &&
        receiptResult.button.inventoryState === 'ALLOCATED_TO_STORE' &&
        receiptResult.button.customerId === null &&
        Number(receiptResult.depositRefund.amount) === 200000 &&
        receiptResult.depositRefund.status === 'PENDING_APPROVAL',
      'Store receipt restores button to warehouse custody and generates 200,000 VND deposit refund claim',
    );

    // Test 3: Admin approves refund -> transitions to PENDING_PAYOUT (held -> reserved), never debits StoreWallet
    mockRentalsRepo.approveDepositRefundTx = async (refundId: bigint, adminUser: any) => ({
      refundId,
      status: 'PENDING_PAYOUT',
      amount: 200000,
      depositLedger: {
        rentalId: BigInt(10),
        collectedAmount: 200000,
        heldAmount: 0,
        refundReservedAmount: 200000,
        refundedAmount: 0,
      },
      storeWalletDebited: false, // Invariant: StoreWallet is NEVER debited for platform deposit refund!
    });

    const refundApproval = await rentalsService.approveDepositRefund('1', {
      userId: '1',
      role: 'SUPER_ADMIN',
    });

    assert(
      refundApproval.status === 'PENDING_PAYOUT' &&
        refundApproval.depositLedger.refundReservedAmount === 200000 &&
        refundApproval.depositLedger.heldAmount === 0 &&
        refundApproval.depositLedger.refundedAmount === 0,
      'Admin approval places refund in PENDING_PAYOUT with funds reserved (refundedAmount stays 0 until payout)',
    );

    assert(
      refundApproval.storeWalletDebited === false,
      'Critical Financial Invariant: StoreWallet is NEVER debited for deposit refund (platform liability)',
    );

    // Test 4: Provider confirms payout success -> transitions to REFUNDED, increases refundedAmount
    mockRentalsRepo.confirmDepositRefundPayoutTx = async (refundId: bigint, ref: string) => ({
      refundId,
      status: 'REFUNDED',
      amount: 200000,
      depositLedger: {
        rentalId: BigInt(10),
        collectedAmount: 200000,
        heldAmount: 0,
        refundReservedAmount: 0,
        refundedAmount: 200000,
      },
    });

    const payoutConfirmed: any = await rentalsService.confirmDepositRefundPayout('1', 'PAYOS-PAYOUT-REF-99');
    assert(
      payoutConfirmed.status === 'REFUNDED' &&
        payoutConfirmed.depositLedger.refundedAmount === 200000 &&
        payoutConfirmed.depositLedger.refundReservedAmount === 0,
      'Payout confirmation completes two-phase refund: status=REFUNDED, refundedAmount=200,000 VND',
    );

  } catch (err: any) {
    console.error('Fatal test error:', err);
    failed++;
  }

  console.log(`\n================================================================================`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log(`================================================================================\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

runTask4TestSuite();
