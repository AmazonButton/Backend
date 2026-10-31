import { RentalsService } from '../src/rentals/rentals.service';
import { OrdersService } from '../src/orders/orders.service';
import { BadRequestException } from '@nestjs/common';

async function runTask3TestSuite() {
  console.log('================================================================================');
  console.log('⚡ TASK 3: RENTAL LIFECYCLE (30K + 200K), COUNTDOWN & EXPIRY LOCK TEST SUITE');
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
    // -------------------------------------------------------------
    // Part A: Rental Contract Creation & Price Structure (30k + 200k)
    // -------------------------------------------------------------
    const mockRentalsRepo: any = {
      listAvailablePackages: async () => [],
      findPackageById: async () => ({
        packageId: BigInt(1),
        monthlyPrice: 30000,
        depositFee: 200000,
        isActive: true,
      }),
      createRental: async (data: any) => ({
        rentalId: BigInt(10),
        rentalCode: data.rentalCode,
        customerId: data.customerId,
        packageId: data.packageId,
        monthsRented: data.monthsRented,
        totalRentAmount: data.totalRentAmount,
        depositAmount: data.depositAmount,
        startDate: data.startDate,
        endDate: data.endDate,
        status: data.status,
        customer: { userId: BigInt(100) },
      }),
      findRentalById: async (id: bigint) => null,
    };

    const rentalsService = new RentalsService(mockRentalsRepo);

    // Test 1: Rental contract creation enforces 30k rent + 200k deposit = 230k total
    const rentalContract = await rentalsService.createRentalContract('55', {
      packageId: '1',
      monthsRented: 1,
    } as any);

    assert(
      Number(rentalContract.totalRentAmount) === 230000 &&
        Number(rentalContract.depositAmount) === 200000,
      'Rental contract enforces 30,000 VND rent + 200,000 VND deposit = 230,000 VND total',
      `Got total=${rentalContract.totalRentAmount}, deposit=${rentalContract.depositAmount}`,
    );

    // Test 2: Countdown calculation on rental detail
    const now = new Date();
    const tenDaysLater = new Date(now.getTime() + 10 * 24 * 60 * 60 * 1000);
    mockRentalsRepo.findRentalById = async (id: bigint) => ({
      rentalId: id,
      rentalCode: 'RNT-TEST-001',
      customerId: BigInt(55),
      packageId: BigInt(1),
      totalRentAmount: 230000,
      depositAmount: 200000,
      status: 'ACTIVE',
      startDate: now,
      endDate: tenDaysLater,
      effectiveExpiresAt: tenDaysLater,
      paidThrough: tenDaysLater,
      customer: { userId: BigInt(100) },
    });

    const activeRentalDetail: any = await rentalsService.getRentalDetail('10', {
      customerProfileId: '55',
      userId: '100',
    });

    assert(
      activeRentalDetail.canOrder === true && activeRentalDetail.remainingSeconds > 0,
      'Active rental exposes canOrder=true and positive remainingSeconds',
      `Got canOrder=${activeRentalDetail.canOrder}, remainingSeconds=${activeRentalDetail.remainingSeconds}`,
    );

    // Test 3: Expired rental calculation
    const pastDate = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000); // expired 2 days ago
    mockRentalsRepo.findRentalById = async (id: bigint) => ({
      rentalId: id,
      rentalCode: 'RNT-EXPIRED-001',
      customerId: BigInt(55),
      packageId: BigInt(1),
      totalRentAmount: 230000,
      depositAmount: 200000,
      status: 'EXPIRED',
      startDate: new Date(now.getTime() - 32 * 24 * 60 * 60 * 1000),
      endDate: pastDate,
      effectiveExpiresAt: pastDate,
      paidThrough: pastDate,
      customer: { userId: BigInt(100) },
    });

    const expiredRentalDetail: any = await rentalsService.getRentalDetail('11', {
      customerProfileId: '55',
      userId: '100',
    });

    assert(
      expiredRentalDetail.canOrder === false && expiredRentalDetail.remainingSeconds === 0,
      'Expired rental exposes canOrder=false and remainingSeconds=0',
      `Got canOrder=${expiredRentalDetail.canOrder}, remainingSeconds=${expiredRentalDetail.remainingSeconds}`,
    );

    // -------------------------------------------------------------
    // Part B: OrdersService Runtime Expiry Lock
    // -------------------------------------------------------------
    const mockOrdersRepo: any = {
      findButtonByIdentifier: async (id: string) => {
        if (id === 'EXPIRED-BUTTON') {
          return {
            buttonId: BigInt(99),
            deviceId: 'EXPIRED-BUTTON',
            customerId: BigInt(55),
            status: 'ACTIVE',
            rentalId: BigInt(11),
            rental: {
              rentalId: BigInt(11),
              effectiveExpiresAt: pastDate,
              status: 'EXPIRED',
            },
          };
        }
        return null;
      },
    };

    const ordersService = new OrdersService(
      mockOrdersRepo,
      null as any,
      null as any,
      null as any,
      null as any,
      null as any,
    );

    let expiredButtonRejected = false;
    try {
      await ordersService.simulateButtonPress(
        { deviceId: 'EXPIRED-BUTTON' },
        { role: 'CUSTOMER', customerProfileId: '55' },
      );
    } catch (err: any) {
      if (err instanceof BadRequestException && err.message.includes('hết hạn thuê')) {
        expiredButtonRejected = true;
      }
    }

    assert(
      expiredButtonRejected === true,
      'OrdersService strictly blocks order creation for expired rental button with descriptive message',
    );

    // Test 5: Fail-closed when button has rentalId but rental relation is missing
    mockOrdersRepo.findButtonByIdentifier = async (id: string) => {
      if (id === 'MISSING-RENTAL-BUTTON') {
        return {
          buttonId: BigInt(98),
          deviceId: 'MISSING-RENTAL-BUTTON',
          customerId: BigInt(55),
          status: 'ACTIVE',
          rentalId: BigInt(12),
          rental: null, // missing relation
        };
      }
      return null;
    };

    let missingRentalRejected = false;
    try {
      await ordersService.simulateButtonPress(
        { deviceId: 'MISSING-RENTAL-BUTTON' },
        { role: 'CUSTOMER', customerProfileId: '55' },
      );
    } catch (err: any) {
      if (err instanceof BadRequestException) {
        missingRentalRejected = true;
      }
    }

    assert(
      missingRentalRejected === true,
      'Fail-Closed: Button with rentalId but missing rental record is rejected before order creation',
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

runTask3TestSuite();
