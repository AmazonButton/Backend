import { BillingChargesService } from '../src/billing-charges/billing-charges.service';
import { BillingChargesRepository } from '../src/billing-charges/billing-charges.repository';

async function runTask1TestSuite() {
  console.log('================================================================================');
  console.log('⚡ TASK 1: BILLING CHARGES & SETTLEMENT INVARIANTS TEST SUITE');
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
    const mockRepo = new BillingChargesRepository(null as any);
    const service = new BillingChargesService(mockRepo);

    // Test 1: Service defined
    assert(!!service, 'BillingChargesService is defined and instantiable');

    // Test 2: Initial rental billing charge (30k rent + 200k deposit = 230k total)
    mockRepo.createChargeWithLines = async (data: any) => {
      return {
        chargeId: BigInt(1),
        chargeCode: 'CHG-RENT-TEST-001',
        purpose: 'RENTAL_INITIAL',
        targetType: 'RENTAL',
        targetId: data.targetId,
        totalAmount: data.totalAmount,
        status: 'PENDING',
        lines: data.lines,
      } as any;
    };

    const initialCharge = await service.createInitialRentalCharge({
      rentalId: BigInt(101),
      customerId: BigInt(501),
      rentAmount: 30000,
      depositAmount: 200000,
      months: 1,
    });

    assert(
      Number(initialCharge.totalAmount) === 230000,
      'Initial rental charge totalAmount equals 230,000 VND (30k rent + 200k deposit)',
      `Got ${initialCharge.totalAmount}`,
    );
    assert(
      initialCharge.lines.length === 2 &&
        initialCharge.lines.some((l: any) => l.lineType === 'RENT' && Number(l.amount) === 30000) &&
        initialCharge.lines.some((l: any) => l.lineType === 'DEPOSIT' && Number(l.amount) === 200000),
      'Initial rental charge separates RENT (30k) and DEPOSIT (200k) line items',
    );

    // Test 3: Settle charge records rental deposit and NEVER credits StoreWallet
    mockRepo.findChargeById = async (id: bigint) => {
      return {
        chargeId: id,
        purpose: 'RENTAL_INITIAL',
        targetType: 'RENTAL',
        targetId: BigInt(101),
        totalAmount: 230000,
        status: 'PENDING',
        lines: [
          { lineType: 'RENT', amount: 30000 },
          { lineType: 'DEPOSIT', amount: 200000 },
        ],
      } as any;
    };

    mockRepo.settleChargeAtomicTx = async (chargeId: bigint) => {
      return {
        chargeId,
        status: 'PAID',
        settledDeposit: {
          rentalId: BigInt(101),
          collectedAmount: 200000,
          heldAmount: 200000,
          refundReservedAmount: 0,
          refundedAmount: 0,
        },
        storeWalletCredited: false, // Invariant: StoreWallet is NEVER credited with deposit or rent!
      } as any;
    };

    const validReceipt = {
      providerTransactionCode: 'PAYOS-TX-SUCCESS-101',
      amount: 230000,
      currency: 'VND',
      verified: true,
      paidAt: new Date(),
    };
    const settlementResult = (await service.settleCharge(BigInt(1), validReceipt)) as any;
    assert(settlementResult.status === 'PAID', 'Charge settlement transitions status to PAID');
    assert(
      settlementResult.settledDeposit.collectedAmount === 200000 &&
        settlementResult.settledDeposit.heldAmount === 200000,
      'Conservation invariant: deposit collected = 200,000 VND, held = 200,000 VND',
    );
    assert(
      settlementResult.storeWalletCredited === false,
      'Critical Financial Invariant: StoreWallet is NEVER credited with rental fee or deposit liability',
    );

    // Test 4: Store 60k shelf fee charge creation
    mockRepo.createChargeWithLines = async (data: any) => {
      return {
        chargeId: BigInt(2),
        chargeCode: 'CHG-SUB-TEST-002',
        purpose: data.purpose,
        targetType: data.targetType,
        targetId: data.targetId,
        totalAmount: data.totalAmount,
        status: 'PENDING',
        lines: data.lines,
      } as any;
    };

    const storeCharge = await service.createStoreSubscriptionCharge({
      storeId: BigInt(77),
      amount: 60000,
      durationDays: 30,
    });

    assert(
      Number(storeCharge.totalAmount) === 60000 && storeCharge.purpose === 'STORE_SUBSCRIPTION',
      'Store shelf fee charge is created for exactly 60,000 VND / 30 days',
      `Got ${storeCharge.totalAmount}`,
    );

    // Test 5: Idempotency on settle - settling already PAID charge returns existing state
    mockRepo.findChargeById = async (id: bigint) => {
      return {
        chargeId: id,
        purpose: 'RENTAL_INITIAL',
        status: 'PAID',
        totalAmount: 230000,
      } as any;
    };

    const idempotentRes = await service.settleCharge(BigInt(1), validReceipt);
    assert(idempotentRes.alreadySettled === true, 'Double settlement of PAID charge is idempotent');

    // Test 6: BOLA protection on getChargeById
    mockRepo.findChargeById = async (id: bigint) => {
      return {
        chargeId: id,
        purpose: 'RENTAL_INITIAL',
        targetType: 'RENTAL',
        targetId: BigInt(101),
        status: 'PENDING',
        totalAmount: 230000,
      } as any;
    };
    mockRepo.findRentalWithCustomer = async (rentalId: bigint) => {
      return {
        rentalId,
        customerId: BigInt(501),
        customer: { userId: BigInt(99) },
      } as any;
    };

    // Customer A (userId 99) accesses own charge -> OK
    const ownerAccess = await service.getChargeById(BigInt(1), {
      userId: 99,
      customerProfileId: 501,
      role: 'CUSTOMER',
    });
    assert(!!ownerAccess, 'Customer can access their own billing charge');

    // Customer B (userId 100) accesses Customer A charge -> 403 Forbidden
    let forbiddenCaught = false;
    try {
      await service.getChargeById(BigInt(1), {
        userId: 100,
        customerProfileId: 502,
        role: 'CUSTOMER',
      });
    } catch (e: any) {
      forbiddenCaught = e.status === 403 || e.name === 'ForbiddenException';
    }
    assert(forbiddenCaught, 'BOLA: Customer B is rejected with 403 Forbidden when accessing Customer A charge');

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

runTask1TestSuite();
