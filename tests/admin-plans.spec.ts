import { PrismaService } from '../src/prisma/prisma.service';
import { AdminService } from '../src/admin/admin.service';

async function testAdminPlans() {
  console.log('Testing Admin Subscription Plans & Rental Packages Management...');
  const prisma = new PrismaService();
  await prisma.$connect();

  const adminService = new AdminService(prisma);
  let failed = 0;

  try {
    // 1. Create Subscription Plan
    const uniquePlanCode = `PLAN_${Date.now()}`;
    const plan = await (adminService as any).createSubscriptionPlan({
      planCode: uniquePlanCode,
      planName: 'Gói Dùng Thử 30 Ngày',
      description: 'Gói cho phép bán tối đa 50 sản phẩm',
      price: 199000,
      durationDays: 30,
      maxProducts: 50,
    });

    if (plan && plan.planCode === uniquePlanCode && Number(plan.price) === 199000) {
      console.log('  [PASS] createSubscriptionPlan created plan successfully');
    } else {
      console.log('  [FAIL] createSubscriptionPlan failed to create plan');
      failed++;
    }

    // 2. List Subscription Plans
    const plans = await (adminService as any).listSubscriptionPlans();
    if (Array.isArray(plans) && plans.some((p: any) => p.planCode === uniquePlanCode)) {
      console.log('  [PASS] listSubscriptionPlans contains created plan');
    } else {
      console.log('  [FAIL] listSubscriptionPlans does not contain created plan');
      failed++;
    }

    // 3. Create Rental Package (Kit 3 buttons)
    const uniquePackageCode = `KIT3_${Date.now()}`;
    const pkg = await (adminService as any).createRentalPackage({
      packageCode: uniquePackageCode,
      packageName: 'Bộ Kit 3 Nút Bấm Siêu Tốc',
      description: 'Bao gồm 3 nút vật lý cấu hình sẵn',
      buttonQuantity: 3,
      monthlyPrice: 120000,
      depositFee: 300000,
    });

    if (pkg && pkg.packageCode === uniquePackageCode && pkg.buttonQuantity === 3) {
      console.log('  [PASS] createRentalPackage created kit package successfully');
    } else {
      console.log('  [FAIL] createRentalPackage failed to create kit package');
      failed++;
    }

    // 4. List Rental Packages
    const packages = await (adminService as any).listRentalPackages();
    if (Array.isArray(packages) && packages.some((p: any) => p.packageCode === uniquePackageCode)) {
      console.log('  [PASS] listRentalPackages contains created package');
    } else {
      console.log('  [FAIL] listRentalPackages does not contain created package');
      failed++;
    }
  } catch (error: any) {
    console.log('  [FAIL] Exception during test execution:', error.message);
    failed++;
  } finally {
    await prisma.$disconnect();
  }

  if (failed > 0) {
    console.error(`Admin plans test failed with ${failed} failures.`);
    process.exit(1);
  } else {
    console.log('All Admin Plans & Packages tests passed successfully!');
  }
}

testAdminPlans().catch((err) => {
  console.error('Test run error:', err);
  process.exit(1);
});
