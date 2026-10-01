import { PrismaService } from '../src/prisma/prisma.service';
import { RentalsService } from '../src/rentals/rentals.service';

async function testCustomerRentals() {
  console.log('Testing Customer IoT Button Rental System...');
  const prisma = new PrismaService();
  await prisma.$connect();

  const rentalsService = new RentalsService(prisma);
  let failed = 0;

  try {
    // Setup test package and customer
    const packageCode = `RNT_TEST_${Date.now()}`;
    const testPackage = await prisma.rentalPackage.create({
      data: {
        packageCode,
        packageName: 'Gói Thuê 1 Nút Test',
        buttonQuantity: 1,
        monthlyPrice: 50000,
        depositFee: 100000,
        isActive: true,
      },
    });

    let customer = await prisma.customerProfile.findFirst();
    if (!customer) {
      const user = await prisma.user.create({
        data: {
          username: `cust_rnt_${Date.now()}`,
          email: `cust_rnt_${Date.now()}@example.com`,
          passwordHash: 'dummyhash',
          fullName: 'Customer Rental Tester',
        },
      });
      customer = await prisma.customerProfile.create({
        data: {
          userId: user.userId,
        },
      });
    }

    // 1. List Available Packages
    const packages = await rentalsService.listAvailablePackages();
    if (Array.isArray(packages) && packages.some((p: any) => p.packageCode === packageCode)) {
      console.log('  [PASS] listAvailablePackages returns active packages');
    } else {
      console.log('  [FAIL] listAvailablePackages failed');
      failed++;
    }

    // 2. Create Rental Contract
    const months = 3;
    const rental = await rentalsService.createRentalContract(customer.customerId, {
      packageId: testPackage.packageId.toString(),
      monthsRented: months,
    });

    const expectedTotal = 50000 * months;
    if (
      rental &&
      rental.rentalCode &&
      Number(rental.totalRentAmount) === expectedTotal &&
      rental.status === 'PENDING_PAYMENT'
    ) {
      console.log('  [PASS] createRentalContract calculated total and pending status correctly');
    } else {
      console.log('  [FAIL] createRentalContract calculation or status invalid');
      failed++;
    }

    // 3. List Customer Rentals
    const myRentals = await rentalsService.listCustomerRentals(customer.customerId);
    if (Array.isArray(myRentals) && myRentals.some((r: any) => r.rentalCode === rental.rentalCode)) {
      console.log('  [PASS] listCustomerRentals returns customer rental contract');
    } else {
      console.log('  [FAIL] listCustomerRentals failed to list rental');
      failed++;
    }

    // 4. Activate Rental
    const activated = await rentalsService.activateRental(rental.rentalId);
    if (activated && activated.status === 'ACTIVE') {
      console.log('  [PASS] activateRental transitioned status to ACTIVE');
    } else {
      console.log('  [FAIL] activateRental failed');
      failed++;
    }
  } catch (error: any) {
    console.log('  [FAIL] Exception during test execution:', error.message);
    failed++;
  } finally {
    await prisma.$disconnect();
  }

  if (failed > 0) {
    console.error(`Customer rentals test failed with ${failed} failures.`);
    process.exit(1);
  } else {
    console.log('All Customer Rentals tests passed successfully!');
  }
}

testCustomerRentals().catch((err) => {
  console.error('Test run error:', err);
  process.exit(1);
});
