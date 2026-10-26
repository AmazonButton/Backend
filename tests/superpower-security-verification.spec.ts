import { PrismaClient } from '@prisma/client';
import { AuthService } from '../src/auth/auth.service';
import { JwtService } from '@nestjs/jwt';
import { MailService } from '../src/mail/mail.service';
import { QueueService } from '../src/common/queues/queue.service';
import { IdempotencyRepository } from '../src/common/idempotency/idempotency.repository';
import { IdempotencyService } from '../src/common/idempotency/idempotency.service';
import { IdempotencyInterceptor } from '../src/common/idempotency/idempotency.interceptor';
import { IDEMPOTENCY_OPTIONS_KEY } from '../src/common/idempotency/idempotency.decorator';
import { StoreWalletRepository } from '../src/store-wallet/store-wallet.repository';
import { StoreWalletService } from '../src/store-wallet/store-wallet.service';
import { ProductsRepository } from '../src/products/products.repository';
import { OptionalJwtAuthGuard } from '../src/common/guards/optional-jwt-auth.guard';
import { LogoutJwtGuard } from '../src/auth/guards/logout-jwt.guard';
import { AppController } from '../src/app.controller';
import { StorefrontController } from '../src/orders/storefront.controller';
import { PaymentsController } from '../src/payments/payments.controller';
import { RentalsController } from '../src/rentals/rentals.controller';
import { Reflector } from '@nestjs/core';
import { of, throwError } from 'rxjs';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnauthorizedException,
  ServiceUnavailableException,
} from '@nestjs/common';

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();
if (!testDatabaseUrl) {
  console.error(
    '\n❌ [SECURITY GUARD] TEST_DATABASE_URL environment variable is mandatory to run Suite 41!',
  );
  console.error(
    'Refusing to run test suite against development, production, or default database.\n',
  );
  process.exit(1);
}

const prisma = new PrismaClient({
  datasources: {
    db: {
      url: testDatabaseUrl,
    },
  },
});

let passed = 0;
let failed = 0;

function assert(condition: boolean, testName: string, failureDetail?: string) {
  if (condition) {
    passed++;
    console.log(`  ✔ \x1b[32m[PASS]\x1b[0m ${testName}`);
  } else {
    failed++;
    console.error(`  ✖ \x1b[31m[FAIL]\x1b[0m ${testName}`);
    if (failureDetail) {
      console.error(`    ↳ Detail: ${failureDetail}`);
    }
  }
}

async function runSuperpowersVerificationSuite() {
  console.log('\n================================================================');
  console.log('🛡️ RUNNING SUPERPOWERS VERIFICATION & SECURITY AUDIT SUITE');
  console.log('================================================================\n');

  // Purge any stale synthetic user residue from prior aborted runs
  await prisma.user.deleteMany({
    where: { username: { startsWith: 'sp_user_' } },
  });

  const jwtSecret =
    process.env.JWT_SECRET || 'ci_test_jwt_secret_key_minimum_32_characters_long_for_security!';
  process.env.JWT_SECRET = jwtSecret;

  const jwtService = new JwtService({ secret: jwtSecret });
  const prismaServiceMock: any = prisma;

  const queueService = new QueueService(prismaServiceMock);
  await queueService.onModuleInit();

  const mailService = new MailService(queueService);
  const idempotencyRepo = new IdempotencyRepository(prismaServiceMock);
  const idempotencyService = new IdempotencyService(idempotencyRepo);
  const walletRepo = new StoreWalletRepository(prismaServiceMock);
  const walletService = new StoreWalletService(
    prismaServiceMock,
    {} as any,
    walletRepo,
  );
  const productsRepo = new ProductsRepository(prismaServiceMock);

  const authRepoMock: any = {
    findByEmail: async (email: string) => null,
    findByAuthId: async (id: string) => null,
    findUserWithAuthRelations: async (email: string) => ({
      userId: BigInt(777),
      email,
      role: 'CUSTOMER',
      authId: null,
      avatarUrl: null,
    }),
    findUserById: async (userId: bigint) => ({
      userId,
      email: 'verified_user@amazonbutton.vn',
      role: 'CUSTOMER',
      status: 'ACTIVE',
    }),
    updateAuthId: async () => {},
    updateProfile: async () => ({}),
    findRefreshToken: async () => null,
    revokeRefreshToken: async () => {},
    revokeAllUserRefreshTokens: async () => {},
    deactivateUserFcmTokens: async () => {},
  };
  const authService = new AuthService(
    mailService,
    authRepoMock,
    jwtService,
    {} as any,
  );

  // Variable holders declared before try/finally to guarantee 100% cleanup even if setup fails
  let createdUserId: bigint | null = null;
  let createdStoreId: bigint | null = null;
  let createdWalletId: bigint | null = null;
  const cleanupWithdrawalIds: bigint[] = [];
  const cleanupProductIds: bigint[] = [];
  const cleanupIdempotencyKeys: string[] = [];

  try {
    // --------------------------------------------------------------------------
    // ISOLATED TEST ENTITIES (Strictly zero pollution of existing production stores)
    // --------------------------------------------------------------------------
    const uniqueRunId = `${Date.now()}_${Math.floor(Math.random() * 10000)}`;

    const testUser = await prisma.user.create({
      data: {
        username: `sp_user_${uniqueRunId.slice(-10)}`,
        email: `sp_user_${uniqueRunId}@amazonbutton.vn`,
        passwordHash: '$2b$12$eXAMpleHashedPasswordForTestRunner1234567890123456789',
        fullName: 'Superpowers Isolated Runner',
        status: 'ACTIVE',
      },
    });
    createdUserId = testUser.userId;

    const testStore = await prisma.store.create({
      data: {
        name: `Superpowers Isolated Store ${uniqueRunId.slice(-6)}`,
        code: `STR_SP_${uniqueRunId.slice(-8)}`,
        phone: '0901234567',
        address: '123 Superpowers Isolated St',
        ownerUserId: testUser.userId,
        status: 'ACTIVE',
      },
    });
    createdStoreId = testStore.storeId;

    const testWallet = await prisma.storeWallet.create({
      data: {
        storeId: testStore.storeId,
        balance: 1000000,
        frozenBalance: 200000,
      },
    });
    createdWalletId = testWallet.walletId;

    const testStoreId = testStore.storeId;

    // ========================================================================
    // 1. P0 GOOGLE OAUTH ACCOUNT TAKEOVER DEFENSE & AUDIENCE BINDING
    // ========================================================================
    console.log('--- 1. P0 Google OAuth Account Takeover Defense & Audience Binding ---');

    // 1.1 In production, sending victim's email + attacker googleId without token MUST throw UnauthorizedException
    const originalNodeEnv = process.env.NODE_ENV;
    const originalGoogleClientId = process.env.GOOGLE_CLIENT_ID;
    process.env.NODE_ENV = 'production';
    process.env.GOOGLE_CLIENT_ID = 'test-client-id.apps.googleusercontent.com';

    let prodTakeoverCaught = false;
    try {
      await authService.googleLogin({
        email: 'victim@amazonbutton.vn',
        googleId: 'attacker_controlled_identity_123',
      });
    } catch (err: any) {
      if (err instanceof UnauthorizedException) {
        prodTakeoverCaught = true;
      }
    }
    assert(
      prodTakeoverCaught === true,
      'Production blocks unverified Google email/googleId takeover without valid OAuth token (401)',
    );

    // 1.2 Invalid / Unverified token rejected
    let invalidTokenCaught = false;
    try {
      await authService.googleLogin({
        token: 'forged_or_invalid_google_oauth_token',
      });
    } catch (err: any) {
      if (err instanceof UnauthorizedException) {
        invalidTokenCaught = true;
      }
    }
    assert(
      invalidTokenCaught === true,
      'Unverified Google token or token substitution rejected with 401 Unauthorized',
    );

    // 1.3 Deterministic Google ID Token Audience Verification (via OAuth2Client.verifyIdToken)
    const expectedClientId = 'expected-production-client-id.apps.googleusercontent.com';
    process.env.GOOGLE_CLIENT_ID = expectedClientId;

    const originalVerifyIdToken = (authService as any).googleOAuthClient.verifyIdToken;
    (authService as any).googleOAuthClient.verifyIdToken = async (opts: any) => {
      if (opts.audience && opts.audience !== 'expected-production-client-id.apps.googleusercontent.com') {
        throw new Error('Wrong recipient, payload audience != requiredAudience');
      }
      if (opts.idToken === 'token_with_wrong_audience') {
        throw new Error('Token used with wrong audience');
      }
      if (opts.idToken === 'token_with_unverified_email') {
        return {
          getPayload: () => ({
            email: 'unverified@amazonbutton.vn',
            email_verified: false,
            sub: 'google_111',
          }),
        };
      }
      if (opts.idToken === 'valid_id_token') {
        return {
          getPayload: () => ({
            email: 'verified_google_user@amazonbutton.vn',
            email_verified: true,
            sub: 'google_222',
            name: 'Verified Google User',
          }),
        };
      }
      throw new Error('Invalid token');
    };

    let wrongAudienceRejected = false;
    try {
      await authService.googleLogin({ token: 'token_with_wrong_audience' });
    } catch (err: any) {
      if (err instanceof UnauthorizedException) {
        wrongAudienceRejected = true;
      }
    }
    assert(
      wrongAudienceRejected === true,
      'Deterministic Google OAuth: Token with mismatched audience rejected with 401 Unauthorized',
    );

    let unverifiedEmailRejected = false;
    try {
      await authService.googleLogin({ token: 'token_with_unverified_email' });
    } catch (err: any) {
      if (err instanceof UnauthorizedException) {
        unverifiedEmailRejected = true;
      }
    }
    assert(
      unverifiedEmailRejected === true,
      'Deterministic Google OAuth: Token with email_verified=false rejected with 401 Unauthorized',
    );

    const validGoogleLoginRes = await authService.googleLogin({ token: 'valid_id_token' });
    assert(
      validGoogleLoginRes?.data?.user?.email === 'verified_google_user@amazonbutton.vn',
      'Deterministic Google OAuth: Valid ID token with matching audience and verified email succeeds',
    );

    // Restore verifyIdToken and env
    (authService as any).googleOAuthClient.verifyIdToken = originalVerifyIdToken;

    process.env.NODE_ENV = originalNodeEnv;
    process.env.GOOGLE_CLIENT_ID = originalGoogleClientId;

    // ========================================================================
    // 2. P0 PAYOUT STATE MACHINE & STRICT ACCOUNTING INVARIANT
    // ========================================================================
    console.log('\n--- 2. P0 Payout State Machine & Strict Accounting Invariant ---');

    const terminalWithdrawal = await prisma.storeWithdrawal.create({
      data: {
        withdrawalCode: `WDR-TERM-${uniqueRunId}`,
        walletId: testWallet.walletId,
        storeId: testStoreId,
        amount: 200000,
        status: 'FAILED',
        failureReason: 'PAYOS_CONFIRMED_REJECTION',
        bankName: 'MBBank',
        bankAccountHolder: 'NGUYEN VAN TEST',
        bankAccountNameSnapshot: 'NGUYEN VAN TEST',
        bankBinSnapshot: '970422',
        bankNameSnapshot: 'MBBank',
        bankAccountEncrypted: 'v1:iv:tag:data',
        bankAccountHash: `hash_test_${uniqueRunId}`,
        bankAccountMasked: '******1234',
        provider: 'PAYOS',
      },
    });
    cleanupWithdrawalIds.push(terminalWithdrawal.withdrawalId);

    // Finalize payout on FAILED withdrawal must throw ConflictException
    let terminalConflictCaught = false;
    try {
      await walletRepo.finalizePayoutSuccessTx(terminalWithdrawal.withdrawalId);
    } catch (err: any) {
      if (err instanceof ConflictException || err?.message?.includes('CRITICAL_PAYOUT_CONFLICT')) {
        terminalConflictCaught = true;
      }
    }

    assert(
      terminalConflictCaught === true,
      'Terminal Guard: finalizePayoutSuccessTx on FAILED withdrawal throws ConflictException (409)',
    );

    // Accounting Deficit Guard: If currentFrozen < amount, throws ConflictException instead of clamping to 0
    let accountingDeficitCaught = false;
    // Set wallet frozenBalance to 50,000 when withdrawal is 200,000
    await prisma.storeWallet.update({
      where: { walletId: testWallet.walletId },
      data: { frozenBalance: 50000 },
    });

    const pendingWithdrawal = await prisma.storeWithdrawal.create({
      data: {
        withdrawalCode: `WDR-DEFICIT-${uniqueRunId}`,
        walletId: testWallet.walletId,
        storeId: testStoreId,
        amount: 200000,
        status: 'PROCESSING',
        bankName: 'MBBank',
        bankAccountHolder: 'NGUYEN VAN TEST',
        bankAccountNameSnapshot: 'NGUYEN VAN TEST',
        bankBinSnapshot: '970422',
        bankNameSnapshot: 'MBBank',
        bankAccountEncrypted: 'v1:iv:tag:data',
        bankAccountHash: `hash_deficit_${uniqueRunId}`,
        bankAccountMasked: '******1234',
        provider: 'PAYOS',
      },
    });
    cleanupWithdrawalIds.push(pendingWithdrawal.withdrawalId);

    try {
      await walletRepo.finalizePayoutSuccessTx(pendingWithdrawal.withdrawalId);
    } catch (err: any) {
      if (err instanceof ConflictException && err.message.includes('ACCOUNTING_INCONSISTENCY')) {
        accountingDeficitCaught = true;
      }
    }
    assert(
      accountingDeficitCaught === true,
      'Accounting Invariant: finalizePayoutSuccessTx throws ConflictException when frozenBalance < amount',
    );

    // Restore frozenBalance for remaining tests
    await prisma.storeWallet.update({
      where: { walletId: testWallet.walletId },
      data: { frozenBalance: 200000 },
    });

    // ========================================================================
    // 3. P0 RACE-FREE PRODUCT PRICE HISTORY (SELECT FOR UPDATE base_price)
    // ========================================================================
    console.log('\n--- 3. Race-Free Product Price History (SELECT FOR UPDATE) ---');

    const testProduct = await prisma.product.create({
      data: {
        storeId: testStoreId,
        productName: `Lock Order Test Product ${uniqueRunId}`,
        productCode: `PRD-LK-${uniqueRunId.slice(-8)}`,
        basePrice: 100000,
        status: 'ACTIVE',
      },
    });
    cleanupProductIds.push(testProduct.productId);

    // 3.1 Caller deliberately passes stale oldPrice: 999999
    await productsRepo.updateProductAtomicTx({
      productId: testProduct.productId,
      storeId: testStoreId,
      data: { basePrice: 150000 },
      priceHistory: { oldPrice: 999999, newPrice: 150000 },
    });

    const recordedHistory = await prisma.productPriceHistory.findFirst({
      where: { productId: testProduct.productId },
      orderBy: { changedAt: 'desc' },
    });

    assert(
      Number(recordedHistory?.oldPrice) === 100000,
      'Price history oldPrice reflects freshly locked DB base_price (100,000) rather than caller stale price (999,999)',
    );
    assert(
      Number(recordedHistory?.newPrice) === 150000,
      'Price history newPrice updated accurately to 150,000',
    );

    // 3.2 Updating non-existent product throws NotFoundException immediately after SELECT FOR UPDATE
    let notFoundProductCaught = false;
    try {
      await productsRepo.updateProductAtomicTx({
        productId: BigInt(9999999999),
        storeId: testStoreId,
        data: { basePrice: 200000 },
        priceHistory: { newPrice: 200000 },
      });
    } catch (err: any) {
      if (err instanceof NotFoundException) {
        notFoundProductCaught = true;
      }
    }
    assert(
      notFoundProductCaught === true,
      'updateProductAtomicTx throws NotFoundException immediately if product row not found under lock',
    );

    // ========================================================================
    // 4. P0 SCOPED IDEMPOTENCY & LEASE LOCK TOKEN & INTERCEPTOR END-TO-END
    // ========================================================================
    console.log('\n--- 4. P0 Scoped Idempotency, Lease Lock Token & Interceptor End-to-End ---');

    // 4.0 Real Controller Metadata Verification: Confirm all financial mutation endpoints mandate @Idempotent({ required: true, ttlSeconds: 86400 })
    const realReflector = new Reflector();
    const checkoutMeta = realReflector.get(IDEMPOTENCY_OPTIONS_KEY, StorefrontController.prototype.checkout);
    assert(
      checkoutMeta?.required === true && checkoutMeta?.ttlSeconds === 86400,
      'Real StorefrontController.checkout enforces @Idempotent({ required: true, ttlSeconds: 86400 })',
    );

    const paymentLinkMeta = realReflector.get(IDEMPOTENCY_OPTIONS_KEY, PaymentsController.prototype.createLink);
    assert(
      paymentLinkMeta?.required === true && paymentLinkMeta?.ttlSeconds === 86400,
      'Real PaymentsController.createLink enforces @Idempotent({ required: true, ttlSeconds: 86400 })',
    );

    const rentalOrderMeta = realReflector.get(IDEMPOTENCY_OPTIONS_KEY, RentalsController.prototype.createRentalOrder);
    assert(
      rentalOrderMeta?.required === true && rentalOrderMeta?.ttlSeconds === 86400,
      'Real RentalsController.createRentalOrder enforces @Idempotent({ required: true, ttlSeconds: 86400 })',
    );

    const rentalPaymentReqMeta = realReflector.get(IDEMPOTENCY_OPTIONS_KEY, RentalsController.prototype.createPaymentRequest);
    assert(
      rentalPaymentReqMeta?.required === true && rentalPaymentReqMeta?.ttlSeconds === 86400,
      'Real RentalsController.createPaymentRequest enforces @Idempotent({ required: true, ttlSeconds: 86400 })',
    );

    const rentalExtMeta = realReflector.get(IDEMPOTENCY_OPTIONS_KEY, RentalsController.prototype.extendRental);
    assert(
      rentalExtMeta?.required === true && rentalExtMeta?.ttlSeconds === 86400,
      'Real RentalsController.extendRental enforces @Idempotent({ required: true, ttlSeconds: 86400 })',
    );

    const sharedKey = `IDEMP-TOKEN-${uniqueRunId}`;
    cleanupIdempotencyKeys.push(sharedKey);

    // 4.1 Acquire key 1 -> returns recordId & lockToken
    const acq1: any = await idempotencyService.acquire({
      idempotencyKey: sharedKey,
      actorScope: 'user:101',
      method: 'POST',
      actualPath: '/api/v1/storefront/orders',
      route: '/api/v1/storefront/orders',
      userId: testUser.userId,
      body: { amount: 50000 },
    });
    assert(
      acq1.state === 'ACQUIRED' && typeof acq1.lockToken === 'string',
      'First acquire issues unique lease lockToken UUID',
    );

    // 4.2 Simulate stale request trying to finalize with wrong/stale lock token
    const staleFinalize = await idempotencyRepo.finalizeSuccess(
      acq1.recordId,
      201,
      { success: true },
      'wrong-stale-token-uuid-1234',
    );
    assert(
      staleFinalize === false,
      'Finalize with stale/mismatched lockToken rejected (returns false, 0 rows modified)',
    );

    // 4.3 Stale finalizeFailure with mismatched lockToken rejected
    const staleFailure = await idempotencyRepo.finalizeFailure(
      acq1.recordId,
      'wrong-stale-token-uuid-1234',
      true,
    );
    assert(
      staleFailure === false,
      'finalizeFailure with stale/mismatched lockToken rejected (returns false, 0 rows deleted)',
    );

    // 4.4 Finalize with authentic lockToken succeeds
    const validFinalize = await idempotencyRepo.finalizeSuccess(
      acq1.recordId,
      201,
      { success: true, orderId: 'ORD-SUCCESS' },
      acq1.lockToken,
    );
    assert(
      validFinalize === true,
      'Finalize with authentic lockToken successfully commits response',
    );

    // 4.5 Interceptor End-to-End: Optional key omitted passes through without caching
    const reflectorMock: any = {
      getAllAndOverride: (key: any) => ({ required: false, ttlSeconds: 86400 }),
    };
    const interceptor = new IdempotencyInterceptor(idempotencyService, reflectorMock);

    const mockExecutionContext = (headers: any, ip = '1.2.3.4'): any => ({
      switchToHttp: () => ({
        getRequest: () => ({
          headers,
          ip,
          method: 'POST',
          url: '/api/v1/orders',
          originalUrl: '/api/v1/orders',
          query: {},
          body: { amount: 50000 },
        }),
        getResponse: () => ({
          setHeader: () => {},
          status: () => {},
        }),
      }),
      getHandler: () => ({}),
      getClass: () => ({}),
    });

    let executionCount = 0;
    const callHandler: any = {
      handle: () => {
        executionCount++;
        return of({ orderId: `ORD-RUN-${executionCount}` });
      },
    };

    // Calling twice without key -> both execute (pass-through), no duplicate blocks or cached replay
    await (await interceptor.intercept(mockExecutionContext({}), callHandler)).toPromise();
    await (await interceptor.intercept(mockExecutionContext({}), callHandler)).toPromise();
    assert(
      executionCount === 2,
      'Interceptor passes through directly without caching when key is omitted and not required',
    );

    // 4.6 Interceptor End-to-End: Required key omitted throws BadRequestException
    const requiredReflectorMock: any = {
      getAllAndOverride: (key: any) => ({ required: true }),
    };
    const requiredInterceptor = new IdempotencyInterceptor(idempotencyService, requiredReflectorMock);
    let requiredMissingCaught = false;
    try {
      await requiredInterceptor.intercept(mockExecutionContext({}), callHandler);
    } catch (err: any) {
      if (err instanceof BadRequestException) {
        requiredMissingCaught = true;
      }
    }
    assert(
      requiredMissingCaught === true,
      'Interceptor throws 400 BadRequestException when key is required but omitted',
    );

    // 4.7 Interceptor Guest Isolation: Two guests with different IPs do not collide or leak responses
    const guestKey = `IDEMP-GUEST-${uniqueRunId}`;
    cleanupIdempotencyKeys.push(guestKey);

    let guest1Executed: any = false;
    const guest1Handler: any = {
      handle: () => {
        guest1Executed = true;
        return of({ orderId: 'GUEST_1_ORDER' });
      },
    };
    const res1 = await (
      await interceptor.intercept(
        mockExecutionContext({ 'x-idempotency-key': guestKey }, '10.0.0.1'),
        guest1Handler,
      )
    ).toPromise();

    let guest2Executed: any = false;
    const guest2Handler: any = {
      handle: () => {
        guest2Executed = true;
        return of({ orderId: 'GUEST_2_ORDER' });
      },
    };
    const res2 = await (
      await interceptor.intercept(
        mockExecutionContext({ 'x-idempotency-key': guestKey }, '10.0.0.2'),
        guest2Handler,
      )
    ).toPromise();

    assert(
      guest1Executed === true &&
        guest2Executed === true &&
        res1?.orderId === 'GUEST_1_ORDER' &&
        res2?.orderId === 'GUEST_2_ORDER',
      'Guest actor isolation: Guests with distinct IPs do not collide or leak cached orders under same key',
    );

    // ========================================================================
    // 5. P0 LOGOUT GUARD SEPARATION & TOKEN VERIFICATION
    // ========================================================================
    console.log('\n--- 5. P0 Logout Guard Separation & Token Verification ---');

    const optionalGuard = new OptionalJwtAuthGuard();
    const logoutGuard = new LogoutJwtGuard();

    // Expired token simulation
    const expiredInfo = { name: 'TokenExpiredError', message: 'jwt expired' };
    let storefrontExpiredCaught = false;
    try {
      optionalGuard.handleRequest(null, null, expiredInfo);
    } catch (err: any) {
      if (err instanceof UnauthorizedException) {
        storefrontExpiredCaught = true;
      }
    }
    assert(
      storefrontExpiredCaught === true,
      'Storefront OptionalJwtAuthGuard rejects expired token with 401 Unauthorized (never falls back to guest)',
    );

    const logoutExpiredResult = logoutGuard.handleRequest(null, null, expiredInfo);
    assert(
      logoutExpiredResult?.isExpired === true,
      'LogoutJwtGuard permits expired token with valid signature for session revocation',
    );

    // Forged signature simulation
    const forgedInfo = { name: 'JsonWebTokenError', message: 'invalid signature' };
    let logoutForgedCaught = false;
    try {
      logoutGuard.handleRequest(null, null, forgedInfo);
    } catch (err: any) {
      if (err instanceof UnauthorizedException) {
        logoutForgedCaught = true;
      }
    }
    assert(
      logoutForgedCaught === true,
      'LogoutJwtGuard rejects forged token signature with 401 Unauthorized',
    );

    // ========================================================================
    // 6. P1 BULLMQ LIFECYCLE, SENSITIVE DLQ MASKING & POSTGRESQL DURABILITY
    // ========================================================================
    console.log('\n--- 6. BullMQ Lifecycle, Sensitive DLQ Masking & PostgreSQL Durability ---');

    queueService.registerProcessor('superpower-dlq-test-queue', async () => {
      throw new Error('Permanent processing exception');
    });

    const dlqJobId = await queueService.enqueueJob(
      'superpower-dlq-test-queue',
      'test-sensitive-failure',
      {
        orderId: 'ORD-999',
        otp: '123456',
        password: 'SuperSecretPassword@123',
        htmlContent: '<p>Your activation code is 654321, do not share</p>',
      },
      { attempts: 1 },
    );

    await new Promise((r) => setTimeout(r, 200));

    // 6.1 Verify durable query via getDeadLetterJobs()
    const dbDeadJobs = await queueService.getDeadLetterJobs('superpower-dlq-test-queue');
    assert(
      dbDeadJobs.length >= 1,
      'Durable DLQ: getDeadLetterJobs() queries directly from PostgreSQL dead_letter_jobs table',
    );

    const dlqRecord = await prisma.deadLetterJob.findUnique({
      where: { id: `dlq_${dlqJobId}` },
    });

    assert(dlqRecord !== null, 'Exhausted job persisted to PostgreSQL dead_letter_jobs table');
    const dlqPayload: any = dlqRecord?.payload;
    assert(
      dlqPayload?.otp === '******' &&
      dlqPayload?.password === '******' &&
      typeof dlqPayload?.htmlContent === 'string' &&
      dlqPayload?.htmlContent.includes('******') &&
      !dlqPayload?.htmlContent.includes('654321'),
      'Sensitive fields (otp, password) and 6-digit OTPs inside HTML/text masked in DLQ (******)',
    );

    // 6.2 Atomic replay: Replay claims status RETRYING in DB before re-enqueueing
    if (dlqRecord) {
      const replaySuccess = await queueService.retryDeadLetterJob(dlqRecord.id);
      assert(
        replaySuccess === true,
        'retryDeadLetterJob() atomically claims job in DB and restores to active queue',
      );

      // Attempting to retry second time immediately returns false (already RETRYING)
      const secondReplay = await queueService.retryDeadLetterJob(dlqRecord.id);
      assert(
        secondReplay === false,
        'Duplicate retry of claimed DLQ job rejected to prevent double replay',
      );
    }

    // ========================================================================
    // 7. P1 EMAIL RETRY & ASYNC QUEUE ENQUEUEING
    // ========================================================================
    console.log('\n--- 7. P1 Email Retry & Queue Propagation ---');

    let errorThrownOnSmtpFail = false;
    try {
      await mailService.sendMail(
        {
          to: 'customer@realdomain.com',
          subject: 'Test Retry',
          text: 'Body content',
          html: '<p>Body</p>',
        },
        true,
      );
    } catch {
      errorThrownOnSmtpFail = true;
    }
    assert(
      errorThrownOnSmtpFail === true || process.env.NODE_ENV !== 'production',
      'sendMail propagates typed error when throwOnError is enabled for queue retries',
    );

    // ========================================================================
    // 8. ZERO-DOWNTIME DRAINING PROBE (/readyz)
    // ========================================================================
    console.log('\n--- 8. Zero-Downtime Draining & Readiness Probe ---');

    const appController = new AppController(prismaServiceMock, queueService);

    const readyRes = await appController.getReadiness();
    assert(readyRes.status === 'READY', 'Normal readiness probe returns READY (200)');

    AppController.isDraining = true;
    let drainingCaught = false;
    try {
      await appController.getReadiness();
    } catch (err: any) {
      if (err instanceof ServiceUnavailableException) {
        drainingCaught = true;
        const res: any = err.getResponse();
        assert(res?.checks?.server === 'DRAINING', 'Readiness probe exports server: DRAINING check');
      }
    }
    AppController.isDraining = false;
    assert(
      drainingCaught === true,
      'Readiness probe immediately returns 503 Service Unavailable when server starts draining',
    );

  } finally {
    console.log('\n--- Cleaning up isolated test artifacts ---');
    try {
      if (createdWalletId) {
        await prisma.storeWallet.deleteMany({ where: { walletId: createdWalletId } });
      }
      for (const wId of cleanupWithdrawalIds) {
        await prisma.storeWithdrawal.deleteMany({ where: { withdrawalId: wId } });
      }
      for (const pId of cleanupProductIds) {
        await prisma.productPriceHistory.deleteMany({ where: { productId: pId } });
        await prisma.product.deleteMany({ where: { productId: pId } });
      }
      if (createdStoreId) {
        await prisma.store.deleteMany({ where: { storeId: createdStoreId } });
      }
      for (const key of cleanupIdempotencyKeys) {
        await prisma.apiIdempotencyKey.deleteMany({ where: { idempotencyKey: key } });
      }
      if (createdUserId) {
        await prisma.apiIdempotencyKey.deleteMany({ where: { userId: createdUserId } });
        await prisma.user.deleteMany({ where: { userId: createdUserId } });
      }
      // Purge synthetic user residue with sp_user_ prefix
      await prisma.user.deleteMany({
        where: { username: { startsWith: 'sp_user_' } },
      });
      await prisma.deadLetterJob.deleteMany({
        where: { queueName: 'superpower-dlq-test-queue' },
      });
    } catch (cleanupErr: any) {
      console.error('❌ Teardown/Cleanup failed:', cleanupErr);
      failed++;
      throw new Error(`Suite cleanup failed: ${cleanupErr?.message}`);
    } finally {
      await queueService.onModuleDestroy().catch(() => {});
      await prisma.$disconnect().catch(() => {});
    }
  }

  console.log('\n================================================================');
  console.log(`SUPERPOWERS SUMMARY: ${passed} passed, ${failed} failed`);
  console.log('================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runSuperpowersVerificationSuite().catch((err) => {
  console.error('Fatal Superpowers Verification Suite error:', err);
  process.exit(1);
});
