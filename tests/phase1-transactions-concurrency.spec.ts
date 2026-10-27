import { PrismaService } from '../src/prisma/prisma.service';
import { ProductsRepository } from '../src/products/products.repository';
import { RentalsRepository } from '../src/rentals/rentals.repository';
import { BankVerificationRepository } from '../src/bank-verification/bank-verification.repository';
import { runWithTransactionRetry, isTransientConcurrencyError } from '../src/common/utils/transaction-retry.util';
import { Decimal } from '@prisma/client/runtime/library';

async function runPhase1TransactionsConcurrencyTests() {
  console.log('================================================================');
  console.log('🚀 SUITE 36: Phase 1 Database Transactions & Concurrency Invariants');
  console.log('================================================================\n');

  process.env.NODE_ENV = 'test';
  const prisma = new PrismaService();
  await prisma.$connect();

  const productsRepo = new ProductsRepository(prisma);
  const rentalsRepo = new RentalsRepository(prisma);
  const bankVerificationRepo = new BankVerificationRepository(prisma);

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, testName: string, detail?: string) {
    if (condition) {
      console.log(`  ✔ [PASS] ${testName}`);
      passed++;
    } else {
      console.error(`  ✘ [FAIL] ${testName}${detail ? ` -> ${detail}` : ''}`);
      failed++;
    }
  }

  // Cleanup tracking lists
  const cleanupProductIds: bigint[] = [];
  const cleanupRentalIds: bigint[] = [];
  const cleanupBankAccIds: bigint[] = [];
  const cleanupStoreIds: bigint[] = [];
  const cleanupUserIds: bigint[] = [];
  const cleanupPackageIds: bigint[] = [];

  try {
    const timestamp = Date.now();

    // ------------------------------------------------------------------------
    // SETUP: Isolated User, Store, and Rental Package
    // ------------------------------------------------------------------------
    const testUser = await prisma.user.create({
      data: {
        username: `phase1_test_user_${timestamp}`,
        fullName: 'Phase 1 Concurrency Tester',
        status: 'ACTIVE',
      },
    });
    cleanupUserIds.push(testUser.userId);

    const testStore = await prisma.store.create({
      data: {
        name: `Phase 1 Test Store ${timestamp}`,
        code: `STR_P1_${timestamp}`,
        phone: '0901112233',
        address: '456 Transaction Way',
        ownerUserId: testUser.userId,
        status: 'ACTIVE',
      },
    });
    cleanupStoreIds.push(testStore.storeId);

    // ========================================================================
    // TEST 1: TX-02 Atomic Product Update & Price History Rollback
    // ========================================================================
    console.log('\n--- 1. TX-02: Atomic Product Update, Inventory Stock & Price History ---');
    const testProduct = await prisma.product.create({
      data: {
        storeId: testStore.storeId,
        productCode: `PRD_P1_${timestamp}`,
        productName: 'Original Phase 1 Product',
        basePrice: new Decimal(100000),
        status: 'ACTIVE',
      },
    });
    cleanupProductIds.push(testProduct.productId);

    // Initial inventory setup via upsert to safely cooperate with DB auto-create trigger
    await prisma.inventory.upsert({
      where: { productId: testProduct.productId },
      update: { quantityOnHand: 50 },
      create: {
        storeId: testStore.storeId,
        productId: testProduct.productId,
        quantityOnHand: 50,
        reservedQuantity: 0,
        minStockAlert: 5,
      },
    });

    // Successful atomic update: price from 100k to 150k, stock from 50 to 75
    const updatedProduct = await productsRepo.updateProductAtomicTx({
      productId: testProduct.productId,
      storeId: testStore.storeId,
      data: {
        productName: 'Updated Phase 1 Product',
        basePrice: new Decimal(150000),
      },
      stock: 75,
      priceHistory: {
        oldPrice: 100000,
        newPrice: 150000,
        changedByUserId: testUser.userId,
      },
    });

    const refreshedInventory = await prisma.inventory.findUnique({
      where: { productId: testProduct.productId },
    });
    const priceHistoryRecords = await prisma.productPriceHistory.findMany({
      where: { productId: testProduct.productId },
    });

    assert(
      Number(updatedProduct.basePrice) === 150000 && updatedProduct.productName === 'Updated Phase 1 Product',
      'Product basePrice and details updated atomically',
    );
    assert(
      refreshedInventory?.quantityOnHand === 75,
      'Inventory stock updated atomically in same transaction',
    );
    assert(
      priceHistoryRecords.length >= 1 && priceHistoryRecords.some((r) => Number(r.newPrice) === 150000),
      `Price history record inserted atomically within transaction (found ${priceHistoryRecords.length} records)`,
      `records: ${JSON.stringify(priceHistoryRecords)}`,
    );

    // Rollback verification: Trigger failure (e.g. foreign key violation on invalid categoryId)
    let rollbackThrew = false;
    try {
      await productsRepo.updateProductAtomicTx({
        productId: testProduct.productId,
        storeId: testStore.storeId,
        data: {
          categoryId: BigInt(999999999), // non-existent category triggers FK error
          basePrice: new Decimal(200000),
        },
        stock: 999, // Should NOT be persisted due to rollback
        priceHistory: {
          oldPrice: 150000,
          newPrice: 200000,
        },
      });
    } catch (_) {
      rollbackThrew = true;
    }

    const postRollbackProduct = await prisma.product.findUnique({
      where: { productId: testProduct.productId },
    });
    const postRollbackInventory = await prisma.inventory.findUnique({
      where: { productId: testProduct.productId },
    });
    const postRollbackHistory = await prisma.productPriceHistory.findMany({
      where: { productId: testProduct.productId },
    });

    assert(rollbackThrew, 'Transaction correctly aborted on inner step failure');
    assert(
      Number(postRollbackProduct?.basePrice) === 150000,
      'Product price rolled back to 150k without partial update',
    );
    assert(
      postRollbackInventory?.quantityOnHand === 75,
      'Inventory stock rolled back to 75 without partial overwrite (999 rejected)',
    );
    assert(
      postRollbackHistory.length === priceHistoryRecords.length,
      'Price history count remained unchanged (failed second record rolled back)',
    );

    // ========================================================================
    // TEST 2: TX-03 Atomic Rental Extension & Concurrency Serialization
    // ========================================================================
    console.log('\n--- 2. TX-03: Atomic Rental Extension & Concurrency Race Elimination ---');
    const testPackage = await prisma.rentalPackage.create({
      data: {
        packageCode: `PKG_P1_${timestamp}`,
        packageName: `Phase 1 Rental Package ${timestamp}`,
        monthlyPrice: new Decimal(100000),
        depositFee: new Decimal(50000),
        isActive: true,
      },
    });
    cleanupPackageIds.push(testPackage.packageId);

    const testCustomer = await prisma.customerProfile.findFirst() || await prisma.customerProfile.create({
      data: {
        userId: testUser.userId,
        phone: '0908889999',
      },
    });

    const startDate = new Date();
    const endDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const testRental = await prisma.buttonRental.create({
      data: {
        rentalCode: `RNT-P1-${timestamp}`,
        customerId: testCustomer.customerId,
        packageId: testPackage.packageId,
        monthsRented: 1,
        totalRentAmount: new Decimal(100000),
        depositAmount: new Decimal(50000),
        startDate,
        endDate,
        status: 'ACTIVE',
      },
    });
    cleanupRentalIds.push(testRental.rentalId);

    // Run 2 concurrent rental extensions (2 months each) simultaneously
    // Each extension adds 2 months and 200k VND
    const concurrentResults = await Promise.allSettled([
      rentalsRepo.extendRentalAtomicTx({
        rentalId: testRental.rentalId,
        additionalMonths: 2,
        additionalAmount: 200000,
        createPaymentTx: false,
      }),
      rentalsRepo.extendRentalAtomicTx({
        rentalId: testRental.rentalId,
        additionalMonths: 2,
        additionalAmount: 200000,
        createPaymentTx: false,
      }),
    ]);

    const bothSucceeded = concurrentResults.every((r) => r.status === 'fulfilled');
    const finalRental = await prisma.buttonRental.findUnique({
      where: { rentalId: testRental.rentalId },
    });

    assert(
      bothSucceeded,
      'Concurrent rental extensions both fulfilled under row-level locking serialization',
    );
    assert(
      finalRental?.monthsRented === 5,
      `Months rented correctly accumulated: expected 5 (1 + 2 + 2), got ${finalRental?.monthsRented}`,
    );
    assert(
      Number(finalRental?.totalRentAmount) === 500000,
      `Total rent amount correctly accumulated: expected 500,000, got ${finalRental?.totalRentAmount}`,
    );

    // Test extending terminated rental -> Must fail
    await prisma.buttonRental.update({
      where: { rentalId: testRental.rentalId },
      data: { status: 'TERMINATED' },
    });

    let terminatedRejected = false;
    try {
      await rentalsRepo.extendRentalAtomicTx({
        rentalId: testRental.rentalId,
        additionalMonths: 1,
        additionalAmount: 100000,
      });
    } catch (termErr: any) {
      terminatedRejected = true;
    }
    assert(
      terminatedRejected,
      'Extension correctly blocked on TERMINATED rental status',
    );

    // ========================================================================
    // TEST 3: TX-04 Default Bank Account Atomic Switch
    // ========================================================================
    console.log('\n--- 3. TX-04: Default Bank Account Atomic Switch Invariant ---');
    const bank1 = await prisma.storeBankAccount.create({
      data: {
        storeId: testStore.storeId,
        bankBin: '970422',
        bankCode: 'MB',
        bankName: 'MBBank',
        accountName: 'TEST OWNER PRIMARY',
        accountNumberHash: `hash_p1_bank1_${timestamp}`,
        accountNumberEncrypted: 'v1:iv:tag:data1',
        isDefault: true,
      },
    });
    cleanupBankAccIds.push(bank1.id);

    const bank2 = await prisma.storeBankAccount.create({
      data: {
        storeId: testStore.storeId,
        bankBin: '970407',
        bankCode: 'TCB',
        bankName: 'Techcombank',
        accountName: 'TEST OWNER SECONDARY',
        accountNumberHash: `hash_p1_bank2_${timestamp}`,
        accountNumberEncrypted: 'v1:iv:tag:data2',
        isDefault: false,
      },
    });
    cleanupBankAccIds.push(bank2.id);

    // Switch default to bank2
    await bankVerificationRepo.setDefaultBankAccount(testStore.storeId, bank2.id);

    const refreshedBank1 = await prisma.storeBankAccount.findUnique({ where: { id: bank1.id } });
    const refreshedBank2 = await prisma.storeBankAccount.findUnique({ where: { id: bank2.id } });
    const defaultAccountsCount = await prisma.storeBankAccount.count({
      where: { storeId: testStore.storeId, isDefault: true },
    });

    assert(
      refreshedBank2?.isDefault === true && refreshedBank1?.isDefault === false,
      'Default bank account switched atomically (bank2 is now true, bank1 is false)',
    );
    assert(
      defaultAccountsCount === 1,
      'Exactly 1 default bank account exists for store (uq_default_bank_account_per_store respected)',
    );

    // ========================================================================
    // TEST 4: CC-03 Transient Concurrency Retry Helper
    // ========================================================================
    console.log('\n--- 4. CC-03: Transaction Retry Helper for Transient Conflicts ---');
    assert(
      isTransientConcurrencyError({ code: 'P2034' }) &&
      isTransientConcurrencyError({ code: '40P01' }) &&
      isTransientConcurrencyError({ code: '40001' }) &&
      isTransientConcurrencyError(new Error('deadlock detected')),
      'isTransientConcurrencyError recognizes all standard PostgreSQL & Prisma deadlock codes',
    );
    assert(
      !isTransientConcurrencyError(new Error('Validation error')) &&
      !isTransientConcurrencyError({ code: 'P2002' }),
      'isTransientConcurrencyError ignores non-transient business/validation errors',
    );

    // Test retry recovery: fails 2 times with P2034 then succeeds on 3rd attempt
    let attemptCounter = 0;
    const retryResult = await runWithTransactionRetry(
      async () => {
        attemptCounter++;
        if (attemptCounter < 3) {
          const err: any = new Error('Transaction failed due to a write conflict');
          err.code = 'P2034';
          throw err;
        }
        return 'RETRY_SUCCESS';
      },
      { maxRetries: 3, baseDelayMs: 20 },
    );

    assert(
      retryResult === 'RETRY_SUCCESS' && attemptCounter === 3,
      `runWithTransactionRetry recovered from transient write conflicts after 3 attempts (attemptCounter: ${attemptCounter})`,
    );

  } catch (err: any) {
    console.error('Unexpected test error in Phase 1 suite:', err);
    failed++;
  } finally {
    // Teardown
    console.log('\n--- Cleaning up Phase 1 test artifacts ---');
    try {
      if (cleanupRentalIds.length > 0) {
        await prisma.buttonRental.deleteMany({ where: { rentalId: { in: cleanupRentalIds } } });
      }
      if (cleanupPackageIds.length > 0) {
        await prisma.rentalPackage.deleteMany({ where: { packageId: { in: cleanupPackageIds } } });
      }
      if (cleanupProductIds.length > 0) {
        await prisma.productPriceHistory.deleteMany({ where: { productId: { in: cleanupProductIds } } });
        await prisma.inventory.deleteMany({ where: { productId: { in: cleanupProductIds } } });
        await prisma.product.deleteMany({ where: { productId: { in: cleanupProductIds } } });
      }
      if (cleanupBankAccIds.length > 0) {
        await prisma.storeBankAccount.deleteMany({ where: { id: { in: cleanupBankAccIds } } });
      }
      if (cleanupStoreIds.length > 0) {
        await prisma.storeWallet.deleteMany({ where: { storeId: { in: cleanupStoreIds } } });
        await prisma.store.deleteMany({ where: { storeId: { in: cleanupStoreIds } } });
      }
      if (cleanupUserIds.length > 0) {
        await prisma.user.deleteMany({ where: { userId: { in: cleanupUserIds } } });
      }
    } catch (cleanupErr) {
      console.warn('Cleanup warning:', cleanupErr);
    }
    await prisma.$disconnect();
  }

  console.log('\n================================================================');
  console.log(`SUMMARY: ${passed} passed, ${failed} failed`);
  console.log('================================================================');
  if (failed > 0) {
    process.exit(1);
  }
  process.exit(0);
}

runPhase1TransactionsConcurrencyTests();
