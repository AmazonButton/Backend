import 'dotenv/config';
import { PrismaService } from '../src/prisma/prisma.service';
import { BankVerificationRepository } from '../src/bank-verification/bank-verification.repository';
import { PayOSBankVerificationProvider } from '../src/bank-verification/providers/payos-bank-verification.provider';
import { BankVerificationService } from '../src/bank-verification/bank-verification.service';
import { StoreSubscriptionsRepository } from '../src/store-subscriptions/store-subscriptions.repository';
import { StoreSubscriptionsService } from '../src/store-subscriptions/store-subscriptions.service';
import { StoreSubscriptionsController } from '../src/store-subscriptions/store-subscriptions.controller';
import { StoreWalletService } from '../src/store-wallet/store-wallet.service';
import { ForbiddenException } from '@nestjs/common';

async function runHandoffFixesTest() {
  console.log('========================================================================');
  console.log('🚀 SUITE: Store Bank Verification & Subscription Handoff Fixes');
  console.log('========================================================================\n');

  process.env.BANK_VERIFICATION_AMOUNT_VND = '2000';
  process.env.BANK_VERIFICATION_EXPIRY_MINUTES = '30';
  process.env.BANK_VERIFICATION_WEBHOOK_SECRET = 'test_secret_123';
  process.env.PLATFORM_BANK_ACCOUNT_NUMBER = '0339898989';
  process.env.PLATFORM_BANK_BIN = '970422';
  process.env.PLATFORM_BANK_NAME = 'MBBank';
  process.env.PLATFORM_BANK_ACCOUNT_HOLDER = 'CONG TY CP SMART ORDER';
  process.env.BANK_VERIFICATION_STRICT = 'false';
  process.env.BANK_VERIFICATION_MOCK = 'true';
  process.env.NODE_ENV = 'test';

  const prisma = new PrismaService();
  await prisma.$connect();

  const bankRepo = new BankVerificationRepository(prisma);
  const bankProvider = new PayOSBankVerificationProvider();
  const bankService = new BankVerificationService(prisma, bankRepo, bankProvider);

  const walletService = new StoreWalletService(prisma);
  const subRepo = new StoreSubscriptionsRepository(prisma);
  const subService = new StoreSubscriptionsService(subRepo, walletService);
  const subController = new StoreSubscriptionsController(subService);

  let passed = 0;
  let failed = 0;

  const runId = Date.now();
  let directOwnerUser: any = null;
  let staffOwnerUser: any = null;
  let regularStaffUser: any = null;
  let unrelatedUser: any = null;
  let storeOwnerRole: any = null;
  let regularStaffRole: any = null;
  let testStore: any = null;
  let testWallet: any = null;
  let planCurrent: any = null;
  let planUpcoming: any = null;

  const cleanupIds = {
    userIds: [] as bigint[],
    storeIds: [] as bigint[],
    roleIds: [] as bigint[],
    planIds: [] as bigint[],
    bankAccountIds: [] as bigint[],
    transactionIds: [] as bigint[],
    subscriptionIds: [] as bigint[],
  };

  try {
    // 0. Setup Roles & Users
    storeOwnerRole = await prisma.role.findFirst({ where: { roleCode: 'STORE_OWNER' } });
    if (!storeOwnerRole) {
      storeOwnerRole = await prisma.role.create({
        data: { roleCode: 'STORE_OWNER', roleName: 'Store Owner' },
      });
      cleanupIds.roleIds.push(storeOwnerRole.roleId);
    }

    regularStaffRole = await prisma.role.findFirst({ where: { roleCode: 'STORE_STAFF' } });
    if (!regularStaffRole) {
      regularStaffRole = await prisma.role.create({
        data: { roleCode: 'STORE_STAFF', roleName: 'Store Staff' },
      });
      cleanupIds.roleIds.push(regularStaffRole.roleId);
    }

    directOwnerUser = await prisma.user.create({
      data: {
        username: `dir_owner_${runId}`,
        email: `dir_owner_${runId}@example.com`,
        passwordHash: '$2b$12$' + 'a'.repeat(53),
        fullName: `Direct Owner ${runId}`,
        phone: `091${String(runId).slice(-7)}`,
        status: 'ACTIVE',
      },
    });
    cleanupIds.userIds.push(directOwnerUser.userId);

    staffOwnerUser = await prisma.user.create({
      data: {
        username: `staff_owner_${runId}`,
        email: `staff_owner_${runId}@example.com`,
        passwordHash: '$2b$12$' + 'b'.repeat(53),
        fullName: `Staff Owner ${runId}`,
        phone: `092${String(runId).slice(-7)}`,
        status: 'ACTIVE',
      },
    });
    cleanupIds.userIds.push(staffOwnerUser.userId);

    regularStaffUser = await prisma.user.create({
      data: {
        username: `staff_reg_${runId}`,
        email: `staff_reg_${runId}@example.com`,
        passwordHash: '$2b$12$' + 'c'.repeat(53),
        fullName: `Regular Staff ${runId}`,
        phone: `093${String(runId).slice(-7)}`,
        status: 'ACTIVE',
      },
    });
    cleanupIds.userIds.push(regularStaffUser.userId);

    unrelatedUser = await prisma.user.create({
      data: {
        username: `unrelated_${runId}`,
        email: `unrelated_${runId}@example.com`,
        passwordHash: '$2b$12$' + 'd'.repeat(53),
        fullName: `Unrelated User ${runId}`,
        phone: `094${String(runId).slice(-7)}`,
        status: 'ACTIVE',
      },
    });
    cleanupIds.userIds.push(unrelatedUser.userId);

    testStore = await prisma.store.create({
      data: {
        ownerUserId: directOwnerUser.userId,
        name: `Handoff Test Store ${runId}`,
        code: `STR_FIX_${runId}`,
        phone: directOwnerUser.phone,
        address: '456 Test Blvd, District 7, HCMC',
        status: 'ACTIVE',
      },
    });
    cleanupIds.storeIds.push(testStore.storeId);

    // Link staffOwnerUser as STORE_OWNER staff in store_staff
    await prisma.storeStaff.create({
      data: {
        storeId: testStore.storeId,
        userId: staffOwnerUser.userId,
        roleId: storeOwnerRole.roleId,
        status: 'ACTIVE',
      },
    });

    // Link regularStaffUser as regular STORE_STAFF in store_staff
    await prisma.storeStaff.create({
      data: {
        storeId: testStore.storeId,
        userId: regularStaffUser.userId,
        roleId: regularStaffRole.roleId,
        status: 'ACTIVE',
      },
    });

    // -------------------------------------------------------------------------
    // TEST 1: Bank verification ownership allows Direct Owner, Staff STORE_OWNER, and Admins
    // -------------------------------------------------------------------------
    console.log('--- TEST 1: Bank Verification Authorization (Staff STORE_OWNER & Admins) ---');
    try {
      // 1a. Direct owner can list accounts
      const dirOwnerRes = await bankService.listStoreBankAccounts(
        directOwnerUser.userId,
        testStore.storeId,
        'STORE_OWNER',
      );
      if (Array.isArray(dirOwnerRes)) {
        console.log('  ✅ 1a. Direct store owner authorized');
        passed++;
      } else {
        throw new Error('Direct store owner list failed');
      }

      // 1b. Staff assigned as STORE_OWNER can list accounts
      const staffOwnerRes = await bankService.listStoreBankAccounts(
        staffOwnerUser.userId,
        testStore.storeId,
        'STORE_OWNER',
      );
      if (Array.isArray(staffOwnerRes)) {
        console.log('  ✅ 1b. Staff assigned as STORE_OWNER authorized without 403');
        passed++;
      } else {
        throw new Error('Staff store owner list failed');
      }

      // 1c. SUPER_ADMIN authorized
      const superAdminRes = await bankService.listStoreBankAccounts(
        unrelatedUser.userId,
        testStore.storeId,
        'SUPER_ADMIN',
      );
      if (Array.isArray(superAdminRes)) {
        console.log('  ✅ 1c. SUPER_ADMIN authorized without 403');
        passed++;
      } else {
        throw new Error('SUPER_ADMIN list failed');
      }

      // 1d. SYSTEM_ADMIN authorized
      const systemAdminRes = await bankService.listStoreBankAccounts(
        unrelatedUser.userId,
        testStore.storeId,
        'SYSTEM_ADMIN',
      );
      if (Array.isArray(systemAdminRes)) {
        console.log('  ✅ 1d. SYSTEM_ADMIN authorized without 403');
        passed++;
      } else {
        throw new Error('SYSTEM_ADMIN list failed');
      }

      // 1e. ADMIN authorized
      const adminRes = await bankService.listStoreBankAccounts(
        unrelatedUser.userId,
        testStore.storeId,
        'ADMIN',
      );
      if (Array.isArray(adminRes)) {
        console.log('  ✅ 1e. ADMIN authorized without 403');
        passed++;
      } else {
        throw new Error('ADMIN list failed');
      }

      // 1f. Regular staff rejected with 403
      let regStaffBlocked = false;
      try {
        await bankService.listStoreBankAccounts(
          regularStaffUser.userId,
          testStore.storeId,
          'STORE_STAFF',
        );
      } catch (err: any) {
        if (err instanceof ForbiddenException || err.status === 403) {
          regStaffBlocked = true;
        }
      }
      if (regStaffBlocked) {
        console.log('  ✅ 1f. Regular staff correctly rejected with 403 Forbidden');
        passed++;
      } else {
        console.error('  ❌ 1f. Regular staff should have been rejected with 403!');
        failed++;
      }

      // 1g. Unrelated user rejected with 403
      let unrelatedBlocked = false;
      try {
        await bankService.listStoreBankAccounts(
          unrelatedUser.userId,
          testStore.storeId,
          'CUSTOMER',
        );
      } catch (err: any) {
        if (err instanceof ForbiddenException || err.status === 403) {
          unrelatedBlocked = true;
        }
      }
      if (unrelatedBlocked) {
        console.log('  ✅ 1g. Unrelated user correctly rejected with 403 Forbidden');
        passed++;
      } else {
        console.error('  ❌ 1g. Unrelated user should have been rejected with 403!');
        failed++;
      }
    } catch (err: any) {
      console.error('  ❌ TEST 1 Failed:', err.message);
      failed++;
    }

    // -------------------------------------------------------------------------
    // TEST 2: Bank verification request returns platform receiving bank info + QR
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 2: Penny Verification Response Details & VietQR ---');
    try {
      const verifyReq = await bankService.createVerificationRequest(
        directOwnerUser.userId,
        {
          storeId: testStore.storeId.toString(),
          bankBin: '970436', // Vietcombank
          accountNumber: '0123456789',
        },
        'STORE_OWNER',
      );

      cleanupIds.bankAccountIds.push(BigInt(verifyReq.bankAccountId));
      cleanupIds.transactionIds.push(BigInt(verifyReq.verificationId));

      if (
        verifyReq.verificationId &&
        verifyReq.recipientBankBin === '970422' &&
        verifyReq.recipientAccountNumber === '0339898989' &&
        verifyReq.recipientAccountHolder &&
        verifyReq.qrCodeUrl &&
        verifyReq.qrCodeUrl.includes('img.vietqr.io') &&
        verifyReq.qrCodeUrl.includes(verifyReq.referenceCode)
      ) {
        console.log('  ✅ 2a. Verification request includes platform receiving bank details and VietQR link');
        passed++;
      } else {
        console.error('  ❌ 2a. Verification response missing required platform receiving details:', verifyReq);
        failed++;
      }
    } catch (err: any) {
      console.error('  ❌ TEST 2 Failed:', err.message);
      failed++;
    }

    // -------------------------------------------------------------------------
    // TEST 3: Subscription Period Resolution (Prepaid future does not overwrite current)
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 3: Subscription Period Priority (Running vs Upcoming Prepaid) ---');
    try {
      const now = new Date();
      // Setup Plan 1: Basic (active current)
      planCurrent = await prisma.subscriptionPlan.create({
        data: {
          planCode: `BASIC_${runId}`,
          planName: `Basic Plan ${runId}`,
          price: 50000,
          durationDays: 30,
          maxProducts: 100,
          isActive: true,
        },
      });
      cleanupIds.planIds.push(planCurrent.planId);

      // Setup Plan 2: Pro (upcoming prepaid)
      planUpcoming = await prisma.subscriptionPlan.create({
        data: {
          planCode: `PRO_${runId}`,
          planName: `Pro Plan ${runId}`,
          price: 150000,
          durationDays: 30,
          maxProducts: 500,
          isActive: true,
        },
      });
      cleanupIds.planIds.push(planUpcoming.planId);

      // Sub 1: Currently running (started 5 days ago, ends in 25 days)
      const currentSub = await prisma.storeSubscription.create({
        data: {
          storeId: testStore.storeId,
          planId: planCurrent.planId,
          startDate: new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000),
          endDate: new Date(now.getTime() + 25 * 24 * 60 * 60 * 1000),
          status: 'ACTIVE',
          paymentMethod: 'WALLET',
        },
        include: { plan: true },
      });
      cleanupIds.subscriptionIds.push(currentSub.subscriptionId);

      // Sub 2: Upcoming prepaid renewal (starts in 25 days, ends in 55 days)
      const upcomingSub = await prisma.storeSubscription.create({
        data: {
          storeId: testStore.storeId,
          planId: planUpcoming.planId,
          startDate: new Date(now.getTime() + 25 * 24 * 60 * 60 * 1000),
          endDate: new Date(now.getTime() + 55 * 24 * 60 * 60 * 1000),
          status: 'ACTIVE',
          paymentMethod: 'WALLET',
        },
        include: { plan: true },
      });
      cleanupIds.subscriptionIds.push(upcomingSub.subscriptionId);

      // Query current subscription via repository
      const resolvedSub = await subRepo.getCurrentSubscription(testStore.storeId);
      if (!resolvedSub) {
        throw new Error('getCurrentSubscription returned null');
      }

      // Assert that resolvedSub is Sub 1 (Current), NOT Sub 2 (Upcoming prepaid)!
      if (resolvedSub.subscriptionId === currentSub.subscriptionId) {
        console.log('  ✅ 3a. getCurrentSubscription correctly returned the currently active subscription (not upcoming prepaid)');
        passed++;
      } else if (resolvedSub.subscriptionId === upcomingSub.subscriptionId) {
        console.error('  ❌ 3a. BUG CONFIRMED: getCurrentSubscription returned upcoming future subscription instead of running subscription!');
        failed++;
      } else {
        console.error('  ❌ 3a. Returned unexpected subscription ID:', resolvedSub.subscriptionId);
        failed++;
      }

      // Test Service level enrichment
      const serviceCurrent = await subService.getCurrentSubscription(testStore.storeId);
      if (
        serviceCurrent &&
        serviceCurrent.subscriptionId === currentSub.subscriptionId &&
        serviceCurrent.daysRemaining > 0 &&
        serviceCurrent.isUpcoming === false &&
        serviceCurrent.upcomingSubscription &&
        serviceCurrent.upcomingSubscription.subscriptionId === upcomingSub.subscriptionId
      ) {
        console.log('  ✅ 3b. StoreSubscriptionsService.getCurrentSubscription enriched with upcomingSubscription info');
        passed++;
      } else {
        console.error('  ❌ 3b. Service enrichment failed or missing upcomingSubscription:', serviceCurrent);
        failed++;
      }
    } catch (err: any) {
      console.error('  ❌ TEST 3 Failed:', err.message);
      failed++;
    }

    // -------------------------------------------------------------------------
    // TEST 4: Route alias GET /store/subscriptions/plans
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 4: Controller Plans Alias Endpoint ---');
    try {
      const plansResult = await subController.getActivePlansCatalog();
      if (plansResult.success && Array.isArray(plansResult.data) && plansResult.data.length > 0) {
        console.log('  ✅ 4a. getActivePlansCatalog() returns active plans successfully');
        passed++;
      } else {
        console.error('  ❌ 4a. getActivePlansCatalog() returned invalid data:', plansResult);
        failed++;
      }
    } catch (err: any) {
      console.error('  ❌ TEST 4 Failed:', err.message);
      failed++;
    }

  } finally {
    // Zero-residue cleanup
    console.log('\n--- Cleaning up test artifacts... ---');
    for (const txId of cleanupIds.transactionIds) {
      await prisma.bankAccountVerificationTransaction.deleteMany({ where: { id: txId } }).catch(() => {});
    }
    for (const bId of cleanupIds.bankAccountIds) {
      await prisma.storeBankAccount.deleteMany({ where: { id: bId } }).catch(() => {});
    }
    for (const sId of cleanupIds.subscriptionIds) {
      await prisma.storeSubscription.deleteMany({ where: { subscriptionId: sId } }).catch(() => {});
    }
    for (const pId of cleanupIds.planIds) {
      await prisma.subscriptionPlan.deleteMany({ where: { planId: pId } }).catch(() => {});
    }
    for (const sId of cleanupIds.storeIds) {
      await prisma.storeStaff.deleteMany({ where: { storeId: sId } }).catch(() => {});
      await prisma.store.deleteMany({ where: { storeId: sId } }).catch(() => {});
    }
    for (const uId of cleanupIds.userIds) {
      await prisma.user.deleteMany({ where: { userId: uId } }).catch(() => {});
    }
    for (const rId of cleanupIds.roleIds) {
      await prisma.role.deleteMany({ where: { roleId: rId } }).catch(() => {});
    }
    await prisma.$disconnect();
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
}

runHandoffFixesTest().catch((e) => {
  console.error('Suite crashed:', e);
  process.exit(1);
});
