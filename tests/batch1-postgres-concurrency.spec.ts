import 'dotenv/config';
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { BadRequestException } from '@nestjs/common';
import { PrismaService } from '../src/prisma/prisma.service';
import { IdentityVerificationsRepository } from '../src/identity-verifications/identity-verifications.repository';
import { IdentityVerificationsService } from '../src/identity-verifications/identity-verifications.service';
import { CategoriesRepository } from '../src/categories/categories.repository';
import { CategoriesService } from '../src/categories/categories.service';
import { OrdersRepository } from '../src/orders/orders.repository';

function assertSafeTestDatabaseUrl(): void {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    throw new Error('DATABASE_URL is required for PostgreSQL concurrency tests');
  }
  const parsed = new URL(dbUrl);
  const host = parsed.hostname.toLowerCase();
  const dbName = parsed.pathname.replace(/^\/+/, '').toLowerCase();
  if (host.includes('supabase.co') || host.includes('supabase.com')) {
    throw new Error(`Refusing to run PostgreSQL test against Supabase host: ${host}`);
  }
  if (!dbName.endsWith('_test')) {
    throw new Error(`Refusing to run PostgreSQL test against non-_test database: ${dbName}`);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function runPostgresConcurrencyTests() {
  assertSafeTestDatabaseUrl();

  const prisma = new PrismaService();
  await prisma.$connect();

  const ts = Date.now();
  const createdUserIds: bigint[] = [];
  const createdStoreIds: bigint[] = [];
  const createdButtonIds: bigint[] = [];
  const createdProductIds: bigint[] = [];
  const createdCustomerIds: bigint[] = [];
  const createdCategoryIds: bigint[] = [];
  const createdSessionIds: bigint[] = [];
  const createdDiditSessionIds: string[] = [];

  let passed = 0;
  const check = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
      passed++;
      console.log(`  ✔ [PASS] ${name}`);
    } catch (err: any) {
      console.error(`  ✖ [FAIL] ${name}: ${err?.stack || err?.message || err}`);
      throw err;
    }
  };

  console.log('\n========================================================================');
  console.log('🐘 REAL POSTGRESQL CONCURRENCY, ROW-LOCK & ROLLBACK VERIFICATION');
  console.log('========================================================================\n');

  try {
    // -------------------------------------------------------------------------
    // TEST 1 (#12): Real PostgreSQL FOR UPDATE Lock Serialization & Concurrent
    // Polling (getDecision) vs Conflicting Webhook (handleWebhook)
    // -------------------------------------------------------------------------
    await check('#12a [PostgreSQL] getDecision blocks on FOR UPDATE lock and wins race cleanly against concurrent Declined webhook', async () => {
      const user1 = await prisma.user.create({
        data: {
          username: `pg_kyc_lock_${ts}`,
          email: `pg_kyc_lock_${ts}@test.local`,
          fullName: 'PG KYC Lock Test 1',
          kycStatus: 'PENDING',
          status: 'ACTIVE',
        },
      });
      createdUserIds.push(user1.userId);

      const diditId1 = `pg_didit_lock_${ts}`;
      createdDiditSessionIds.push(diditId1);
      const sess1 = await prisma.identityVerificationSession.create({
        data: {
          userId: user1.userId,
          diditSessionId: diditId1,
          workflowId: 'wf_pg_test',
          vendorData: `user-${user1.userId}`,
          status: 'PENDING',
          verificationUrl: 'https://verify.didit.me/pg-lock-test',
        },
      });
      createdSessionIds.push(sess1.id);

      const repo = new IdentityVerificationsRepository(prisma);
      const service = new IdentityVerificationsService(repo, {
        getDecision: async (diditId: string) => ({
          status: 'Approved',
          source: 'mock_didit_poll',
          id_verifications: [
            {
              status: 'Approved',
              full_name: diditId === diditId1 ? 'PG KYC Lock Test 1' : 'PG KYC Race Test 2',
              document_number: diditId === diditId1 ? `079091${String(ts).slice(-6)}` : `079092${String(ts).slice(-6)}`,
            },
          ],
        }),
      } as any);

      // Hold a genuine PostgreSQL row-level FOR UPDATE lock for 300ms while updating session
      let lockAcquiredResolve!: () => void;
      const lockAcquired = new Promise<void>((res) => {
        lockAcquiredResolve = res;
      });

      const lockHolderTx = prisma.$transaction(async (tx) => {
        await tx.$queryRaw`
          SELECT "id", "status"
          FROM "identity_verification_sessions"
          WHERE "id" = ${sess1.id}
          FOR UPDATE;
        `;
        lockAcquiredResolve();
        await sleep(300);
        await tx.identityVerificationSession.update({
          where: { id: sess1.id },
          data: { status: 'IN_REVIEW' },
        });
      });

      await lockAcquired;
      const pollStartedAt = Date.now();
      const pollPromise = service.getDecision(sess1.id, { id: user1.userId.toString(), role: 'CUSTOMER' });

      const [, pollResult] = await Promise.all([lockHolderTx, pollPromise]);
      const pollElapsedMs = Date.now() - pollStartedAt;

      assert.ok(
        pollElapsedMs >= 200,
        `Expected getDecision to block on PostgreSQL FOR UPDATE lock >= 200ms, elapsed=${pollElapsedMs}ms`,
      );
      assert.strictEqual(pollResult.status, 'APPROVED');

      const freshSess1 = await prisma.identityVerificationSession.findUnique({ where: { id: sess1.id } });
      const freshUser1 = await prisma.user.findUnique({ where: { userId: user1.userId } });
      assert.strictEqual(freshSess1?.status, 'APPROVED');
      assert.strictEqual(freshUser1?.kycStatus, 'APPROVED');

      // Now race concurrent getDecision('Approved') vs handleWebhook('Declined') on fresh PENDING row
      const user2 = await prisma.user.create({
        data: {
          username: `pg_kyc_race_${ts}`,
          email: `pg_kyc_race_${ts}@test.local`,
          fullName: 'PG KYC Race Test 2',
          kycStatus: 'PENDING',
          status: 'ACTIVE',
        },
      });
      createdUserIds.push(user2.userId);

      const diditId2 = `pg_didit_race_${ts}`;
      createdDiditSessionIds.push(diditId2);
      const sess2 = await prisma.identityVerificationSession.create({
        data: {
          userId: user2.userId,
          diditSessionId: diditId2,
          workflowId: 'wf_pg_test',
          vendorData: `user-${user2.userId}`,
          status: 'PENDING',
          verificationUrl: 'https://verify.didit.me/pg-race-test',
        },
      });
      createdSessionIds.push(sess2.id);

      const declinedPayload = {
        event_id: `pg_evt_decl_${ts}`,
        event_type: 'status.updated',
        session_id: diditId2,
        status: 'Declined',
      };
      const [decisionRes, webhookRes] = await Promise.all([
        service.getDecision(sess2.id, { id: user2.userId.toString(), role: 'CUSTOMER' }),
        service.handleWebhook(Buffer.from(JSON.stringify(declinedPayload)), declinedPayload),
      ]);

      assert.strictEqual(webhookRes.success, true);
      assert.strictEqual(decisionRes.status, 'APPROVED');

      const freshSess2 = await prisma.identityVerificationSession.findUnique({ where: { id: sess2.id } });
      const freshUser2 = await prisma.user.findUnique({ where: { userId: user2.userId } });
      assert.strictEqual(freshSess2?.status, 'APPROVED');
      assert.strictEqual(freshUser2?.kycStatus, 'APPROVED');
    });

    // -------------------------------------------------------------------------
    // TEST 2 (#12b): Real PostgreSQL Rollback between Session update and User update
    // -------------------------------------------------------------------------
    await check('#12b [PostgreSQL] reconcileDecisionAtomicTx rolls back session APPROVED update if user update fails mid-transaction', async () => {
      const userRb = await prisma.user.create({
        data: {
          username: `pg_kyc_rb_${ts}`,
          email: `pg_kyc_rb_${ts}@test.local`,
          fullName: 'PG KYC Rollback Test',
          kycStatus: 'PENDING',
          status: 'ACTIVE',
        },
      });
      createdUserIds.push(userRb.userId);

      const diditIdRb = `pg_didit_rb_${ts}`;
      createdDiditSessionIds.push(diditIdRb);
      const sessRb = await prisma.identityVerificationSession.create({
        data: {
          userId: userRb.userId,
          diditSessionId: diditIdRb,
          workflowId: 'wf_pg_test',
          vendorData: `user-${userRb.userId}`,
          status: 'PENDING',
          verificationUrl: 'https://verify.didit.me/pg-rollback-test',
        },
      });
      createdSessionIds.push(sessRb.id);

      let stagedUserKycStatusInsideTx: string | undefined;
      const origTx = prisma.$transaction.bind(prisma);
      const proxyPrisma = {
        $transaction: (fn: (tx: any) => Promise<any>) =>
          origTx(async (realTx: any) => {
            const wrappedTx = new Proxy(realTx, {
              get(target, prop, receiver) {
                if (prop === 'identityVerificationSession') {
                  return {
                    update: async () => {
                      const midUser = await realTx.user.findUnique({
                        where: { userId: userRb.userId },
                      });
                      stagedUserKycStatusInsideTx = midUser?.kycStatus;
                      throw new Error('SIMULATED_MID_TX_SESSION_UPDATE_FAILURE');
                    },
                  };
                }
                const val = Reflect.get(target, prop, receiver);
                return typeof val === 'function' ? val.bind(target) : val;
              },
            });
            return fn(wrappedTx);
          }),
      };

      const rbRepo = new IdentityVerificationsRepository(proxyPrisma as unknown as PrismaService);
      const rbDoc = `079093${String(ts).slice(-6)}`;
      const rbHash = require('crypto').createHash('sha256').update(rbDoc).digest('hex');

      await assert.rejects(
        () =>
          rbRepo.reconcileDecisionAtomicTx({
            sessionId: sessRb.id,
            newStatus: 'APPROVED',
            extractedOcr: {
              fullName: 'PG KYC Rollback Test',
              documentNumberNormalized: rbDoc,
              documentNumberMasked: `********${rbDoc.slice(-4)}`,
              documentHash: rbHash,
              dateOfBirth: null,
              nationality: 'VNM',
              expiryDate: null,
              hasCompleteIdentity: true,
              warnings: [],
            },
          }),
        /SIMULATED_MID_TX_SESSION_UPDATE_FAILURE/,
      );

      assert.strictEqual(
        stagedUserKycStatusInsideTx,
        'APPROVED',
        'User row update must have run inside PostgreSQL transaction before session update failed',
      );

      const committedSession = await prisma.identityVerificationSession.findUnique({ where: { id: sessRb.id } });
      const committedUser = await prisma.user.findUnique({ where: { userId: userRb.userId } });
      assert.strictEqual(committedSession?.status, 'PENDING', 'PostgreSQL ROLLBACK must restore session status to PENDING');
      assert.strictEqual(committedUser?.kycStatus, 'PENDING', 'PostgreSQL ROLLBACK must preserve user kycStatus PENDING');
    });

    // -------------------------------------------------------------------------
    // TEST 3 (#13): Real PostgreSQL Concurrent Category Hierarchy Cycle Prevention
    // -------------------------------------------------------------------------
    await check('#13 [PostgreSQL] Concurrent category parent updates (A<->B) serialize via FOR UPDATE and reject cycle without deadlocks', async () => {
      const catOwner = await prisma.user.create({
        data: {
          username: `pg_cat_owner_${ts}`,
          email: `pg_cat_owner_${ts}@test.local`,
          fullName: 'PG Category Owner',
          status: 'ACTIVE',
        },
      });
      createdUserIds.push(catOwner.userId);

      const store = await prisma.store.create({
        data: {
          name: `PG Category Store ${ts}`,
          code: `PGCAT-${ts}`,
          phone: '0909998887',
          address: '100 PG Street',
          ownerUserId: catOwner.userId,
          status: 'ACTIVE',
        },
      });
      createdStoreIds.push(store.storeId);

      // 3a: Deterministic SQL lock-overlap proof: Tx1 holds FOR UPDATE while updating A.parent = B;
      // Tx2 (B.parent = A) blocks in PostgreSQL until Tx1 commits, then sees committed A.parent = B and rejects cycle
      const cat1 = await prisma.category.create({
        data: { storeId: store.storeId, categoryName: 'Cat Lock 1', status: 'ACTIVE' },
      });
      const cat2 = await prisma.category.create({
        data: { storeId: store.storeId, categoryName: 'Cat Lock 2', status: 'ACTIVE' },
      });
      createdCategoryIds.push(cat1.categoryId, cat2.categoryId);

      let tx1AcquiredLockResolve!: () => void;
      const tx1AcquiredLock = new Promise<void>((res) => {
        tx1AcquiredLockResolve = res;
      });

      const origCatTx = prisma.$transaction.bind(prisma);
      const heldPrisma = {
        category: prisma.category,
        store: prisma.store,
        storeStaff: prisma.storeStaff,
        $transaction: (fn: (tx: any) => Promise<any>) =>
          origCatTx(async (realTx: any) => {
            const result = await fn(realTx);
            tx1AcquiredLockResolve();
            await sleep(300);
            return result;
          }),
      };

      const heldService = new CategoriesService(new CategoriesRepository(heldPrisma as unknown as PrismaService));
      const directService = new CategoriesService(new CategoriesRepository(prisma));
      const ownerActor = { userId: catOwner.userId.toString(), role: 'STORE_OWNER' };

      const tx1Promise = heldService.updateCategory(ownerActor, cat1.categoryId.toString(), {
        parentCategoryId: cat2.categoryId.toString(),
      });

      await tx1AcquiredLock;
      const tx2StartedAt = Date.now();
      const tx2Promise = directService.updateCategory(ownerActor, cat2.categoryId.toString(), {
        parentCategoryId: cat1.categoryId.toString(),
      });

      const [r1, r2] = await Promise.allSettled([tx1Promise, tx2Promise]);
      const tx2ElapsedMs = Date.now() - tx2StartedAt;

      assert.strictEqual(r1.status, 'fulfilled', 'First locked category update should commit');
      assert.strictEqual(r2.status, 'rejected', 'Overlapping second update forming A<->B cycle must be rejected');
      assert.ok(
        (r2 as PromiseRejectedResult).reason instanceof BadRequestException,
        'Second concurrent update should fail with BadRequestException after unblocking on Postgres FOR UPDATE',
      );
      assert.ok(
        tx2ElapsedMs >= 200,
        `Expected Tx2 to wait on PostgreSQL FOR UPDATE lock >= 200ms, elapsed=${tx2ElapsedMs}ms`,
      );

      const committed1 = await prisma.category.findUnique({ where: { categoryId: cat1.categoryId } });
      const committed2 = await prisma.category.findUnique({ where: { categoryId: cat2.categoryId } });
      assert.strictEqual(committed1?.parentCategoryId, cat2.categoryId);
      assert.strictEqual(committed2?.parentCategoryId, null);

      // 3b: Pure uninstrumented parallel Promise.allSettled races on PostgreSQL
      for (let round = 1; round <= 3; round++) {
        const cA = await prisma.category.create({
          data: { storeId: store.storeId, categoryName: `Cat Race A-${round}`, status: 'ACTIVE' },
        });
        const cB = await prisma.category.create({
          data: { storeId: store.storeId, categoryName: `Cat Race B-${round}`, status: 'ACTIVE' },
        });
        createdCategoryIds.push(cA.categoryId, cB.categoryId);

        const [ra, rb] = await Promise.allSettled([
          directService.updateCategory(ownerActor, cA.categoryId.toString(), {
            parentCategoryId: cB.categoryId.toString(),
          }),
          directService.updateCategory(ownerActor, cB.categoryId.toString(), {
            parentCategoryId: cA.categoryId.toString(),
          }),
        ]);

        const okCount = [ra, rb].filter((r) => r.status === 'fulfilled').length;
        const failList = [ra, rb].filter((r): r is PromiseRejectedResult => r.status === 'rejected');
        assert.strictEqual(okCount, 1, `Round ${round}: expected 1 fulfilled update`);
        assert.strictEqual(failList.length, 1, `Round ${round}: expected 1 rejected cycle update`);
        assert.ok(
          failList[0].reason instanceof BadRequestException,
          `Round ${round}: rejection must be BadRequestException (got ${failList[0].reason})`,
        );

        const freshA = await prisma.category.findUnique({ where: { categoryId: cA.categoryId } });
        const freshB = await prisma.category.findUnique({ where: { categoryId: cB.categoryId } });
        assert.ok(
          !(freshA?.parentCategoryId === cB.categoryId && freshB?.parentCategoryId === cA.categoryId),
          `Round ${round}: PostgreSQL must never contain A <-> B cycle`,
        );
      }
    });

    // -------------------------------------------------------------------------
    // TEST 4 (#2): Real PostgreSQL createOrderFallbackTx rejects SUSPENDED store
    // -------------------------------------------------------------------------
    await check('#2 [PostgreSQL] OrdersRepository.createOrderFallbackTx rejects SUSPENDED store on real DB', async () => {
      const storeOwner = await prisma.user.create({
        data: {
          username: `pg_ord_owner_${ts}`,
          email: `pg_ord_owner_${ts}@test.local`,
          fullName: 'PG Store Owner',
          status: 'ACTIVE',
        },
      });
      createdUserIds.push(storeOwner.userId);

      const custUser = await prisma.user.create({
        data: {
          username: `pg_ord_cust_${ts}`,
          email: `pg_ord_cust_${ts}@test.local`,
          fullName: 'PG Customer',
          status: 'ACTIVE',
        },
      });
      createdUserIds.push(custUser.userId);

      const customer = await prisma.customerProfile.create({
        data: { userId: custUser.userId },
      });
      createdCustomerIds.push(customer.customerId);

      const suspendedStore = await prisma.store.create({
        data: {
          name: `PG Suspended Store ${ts}`,
          code: `PGSUSP-${ts}`,
          phone: '0908887776',
          address: '200 Suspended St',
          ownerUserId: storeOwner.userId,
          status: 'SUSPENDED',
        },
      });
      createdStoreIds.push(suspendedStore.storeId);

      const prod = await prisma.product.create({
        data: {
          storeId: suspendedStore.storeId,
          productCode: `P-SUSP-${ts}`,
          productName: 'Suspended Water',
          basePrice: 25000,
          status: 'ACTIVE',
        },
      });
      createdProductIds.push(prod.productId);

      await prisma.inventory.create({
        data: {
          storeId: suspendedStore.storeId,
          productId: prod.productId,
          quantityOnHand: 20,
          reservedQuantity: 0,
        },
      });

      const btn = await prisma.ioTButton.create({
        data: {
          deviceId: `PG-DEV-SUSP-${ts}`,
          buttonCode: `PG-BTN-SUSP-${ts}`,
          buttonName: 'PG Suspended Button',
          hmacSecret: `pg-test-hmac-${ts}`,
          storeId: suspendedStore.storeId,
          customerId: customer.customerId,
          status: 'ACTIVE',
          inventoryState: 'IN_CUSTOMER_CUSTODY',
          canOrder: true,
        },
      });
      createdButtonIds.push(btn.buttonId);

      const ordersRepo = new OrdersRepository(prisma);
      await assert.rejects(
        () =>
          ordersRepo.createOrderFallbackTx(
            {
              buttonId: btn.buttonId,
              storeId: suspendedStore.storeId,
              customerId: customer.customerId,
              addressId: null,
              buttonProducts: [{ productId: prod.productId, quantity: 1 }],
            },
            'COD',
            0,
            `PG-REQ-${ts}`,
            'PG suspended store test',
            {
              shippingRecipientName: 'PG Customer',
              shippingPhone: '0908887776',
              shippingAddress: '200 Suspended St',
            },
          ),
        (err: any) => err instanceof BadRequestException && err.message.includes('không hoạt động'),
      );

      const createdOrders = await prisma.order.count({ where: { buttonId: btn.buttonId } });
      assert.strictEqual(createdOrders, 0, 'No order row may exist after SUSPENDED store rejection');
    });
  } finally {
    const cleanupErrors: string[] = [];
    const runCleanupStep = async (label: string, op: () => Promise<any>) => {
      try {
        await op();
      } catch (err: any) {
        const msg = `${label}: ${err?.message || err}`;
        cleanupErrors.push(msg);
        console.error(`  ✖ [CLEANUP ERROR] ${msg}`);
      }
    };

    try {
      // Cleanup in reverse dependency order and verify zero DB residue
      if (createdButtonIds.length > 0) {
        await runCleanupStep('order.deleteMany', () =>
          prisma.order.deleteMany({ where: { buttonId: { in: createdButtonIds } } }),
        );
        await runCleanupStep('ioTButton.deleteMany', () =>
          prisma.ioTButton.deleteMany({ where: { buttonId: { in: createdButtonIds } } }),
        );
      }
      if (createdProductIds.length > 0) {
        await runCleanupStep('inventory.deleteMany', () =>
          prisma.inventory.deleteMany({ where: { productId: { in: createdProductIds } } }),
        );
        await runCleanupStep('product.deleteMany', () =>
          prisma.product.deleteMany({ where: { productId: { in: createdProductIds } } }),
        );
      }
      if (createdCategoryIds.length > 0) {
        await runCleanupStep('category.clearParents', () =>
          prisma.category.updateMany({
            where: { categoryId: { in: createdCategoryIds } },
            data: { parentCategoryId: null },
          }),
        );
        await runCleanupStep('category.deleteMany', () =>
          prisma.category.deleteMany({ where: { categoryId: { in: createdCategoryIds } } }),
        );
      }
      if (createdStoreIds.length > 0) {
        await runCleanupStep('store.deleteMany', () =>
          prisma.store.deleteMany({ where: { storeId: { in: createdStoreIds } } }),
        );
      }
      if (createdCustomerIds.length > 0) {
        await runCleanupStep('customerProfile.deleteMany', () =>
          prisma.customerProfile.deleteMany({ where: { customerId: { in: createdCustomerIds } } }),
        );
      }
      if (createdDiditSessionIds.length > 0) {
        await runCleanupStep('diditWebhookEvent.deleteMany', () =>
          prisma.diditWebhookEvent.deleteMany({ where: { diditSessionId: { in: createdDiditSessionIds } } }),
        );
      }
      if (createdSessionIds.length > 0) {
        await runCleanupStep('identityVerificationSession.deleteMany', () =>
          prisma.identityVerificationSession.deleteMany({ where: { id: { in: createdSessionIds } } }),
        );
      }
      if (createdUserIds.length > 0) {
        await runCleanupStep('user.deleteMany', () =>
          prisma.user.deleteMany({ where: { userId: { in: createdUserIds } } }),
        );
      }

      const leftovers: Record<string, number> = {
        orders: createdButtonIds.length
          ? await prisma.order.count({ where: { buttonId: { in: createdButtonIds } } })
          : 0,
        buttons: createdButtonIds.length
          ? await prisma.ioTButton.count({ where: { buttonId: { in: createdButtonIds } } })
          : 0,
        inventories: createdProductIds.length
          ? await prisma.inventory.count({ where: { productId: { in: createdProductIds } } })
          : 0,
        products: createdProductIds.length
          ? await prisma.product.count({ where: { productId: { in: createdProductIds } } })
          : 0,
        categories: createdCategoryIds.length
          ? await prisma.category.count({ where: { categoryId: { in: createdCategoryIds } } })
          : 0,
        stores: createdStoreIds.length
          ? await prisma.store.count({ where: { storeId: { in: createdStoreIds } } })
          : 0,
        customers: createdCustomerIds.length
          ? await prisma.customerProfile.count({ where: { customerId: { in: createdCustomerIds } } })
          : 0,
        diditWebhookEvents: createdDiditSessionIds.length
          ? await prisma.diditWebhookEvent.count({ where: { diditSessionId: { in: createdDiditSessionIds } } })
          : 0,
        identityVerificationSessions: createdSessionIds.length
          ? await prisma.identityVerificationSession.count({ where: { id: { in: createdSessionIds } } })
          : 0,
        users: createdUserIds.length
          ? await prisma.user.count({ where: { userId: { in: createdUserIds } } })
          : 0,
      };
      const nonZeroLeftovers = Object.entries(leftovers).filter(([, count]) => count > 0);
      if (cleanupErrors.length > 0 || nonZeroLeftovers.length > 0) {
        throw new Error(
          `Cleanup verification failed (errors=${JSON.stringify(cleanupErrors)}, leftovers=${JSON.stringify(Object.fromEntries(nonZeroLeftovers))})`,
        );
      }
      console.log('  ✔ [CLEANUP] Verified zero leftover test fixtures across all tables');
    } finally {
      await prisma.$disconnect();
    }
  }

  console.log(`\n🎉 ALL ${passed}/${passed} REAL POSTGRESQL CONCURRENCY & ROLLBACK CHECKS PASSED!\n`);
}

runPostgresConcurrencyTests().catch((err) => {
  console.error('❌ PostgreSQL concurrency test failed:', err);
  process.exit(1);
});
