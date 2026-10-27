import { Reflector } from '@nestjs/core';
import { IDEMPOTENCY_OPTIONS_KEY } from '../src/common/idempotency/idempotency.decorator';
import { StorefrontController } from '../src/orders/storefront.controller';
import { PaymentsController } from '../src/payments/payments.controller';
import { RentalsController } from '../src/rentals/rentals.controller';
import { StoreWalletController } from '../src/store-wallet/store-wallet.controller';
import { validateTestDatabaseUrl } from './test-db-guard';
import { AuthService } from '../src/auth/auth.service';
import { UnauthorizedException, ConflictException } from '@nestjs/common';
import { QueueService } from '../src/common/queues/queue.service';

async function runSuperpowersSecurityUnitSuite() {
  console.log('\n================================================================');
  console.log('🛡️ RUNNING SUPERPOWERS SECURITY UNIT & ISOLATION VERIFICATION');
  console.log('================================================================\n');

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

  // ========================================================================
  // 1. P0 MANDATORY IDEMPOTENCY METADATA ON ALL FINANCIAL ENDPOINTS
  // ========================================================================
  console.log('--- 1. Mandatory Idempotency Metadata Reflection ---');

  const reflector = new Reflector();

  const checkoutMeta = reflector.get(IDEMPOTENCY_OPTIONS_KEY, StorefrontController.prototype.checkout);
  assert(
    checkoutMeta?.required === true && checkoutMeta?.ttlSeconds === 86400,
    'StorefrontController.checkout mandates @Idempotent({ required: true, ttlSeconds: 86400 })',
  );

  const paymentLinkMeta = reflector.get(IDEMPOTENCY_OPTIONS_KEY, PaymentsController.prototype.createLink);
  assert(
    paymentLinkMeta?.required === true && paymentLinkMeta?.ttlSeconds === 86400,
    'PaymentsController.createLink mandates @Idempotent({ required: true, ttlSeconds: 86400 })',
  );

  const rentalOrderMeta = reflector.get(IDEMPOTENCY_OPTIONS_KEY, RentalsController.prototype.createRentalOrder);
  assert(
    rentalOrderMeta?.required === true && rentalOrderMeta?.ttlSeconds === 86400,
    'RentalsController.createRentalOrder mandates @Idempotent({ required: true, ttlSeconds: 86400 })',
  );

  const rentalPaymentReqMeta = reflector.get(IDEMPOTENCY_OPTIONS_KEY, RentalsController.prototype.createPaymentRequest);
  assert(
    rentalPaymentReqMeta?.required === true && rentalPaymentReqMeta?.ttlSeconds === 86400,
    'RentalsController.createPaymentRequest mandates @Idempotent({ required: true, ttlSeconds: 86400 })',
  );

  const rentalExtMeta = reflector.get(IDEMPOTENCY_OPTIONS_KEY, RentalsController.prototype.extendRental);
  assert(
    rentalExtMeta?.required === true && rentalExtMeta?.ttlSeconds === 86400,
    'RentalsController.extendRental mandates @Idempotent({ required: true, ttlSeconds: 86400 })',
  );

  const walletWithdrawalMeta = reflector.get(IDEMPOTENCY_OPTIONS_KEY, StoreWalletController.prototype.requestWithdrawal);
  assert(
    walletWithdrawalMeta?.required === true && walletWithdrawalMeta?.ttlSeconds === 86400,
    'StoreWalletController.requestWithdrawal mandates @Idempotent({ required: true, ttlSeconds: 86400 })',
  );

  // ========================================================================
  // 2. P0 TEST DATABASE SECURITY GUARD INVARIANTS
  // ========================================================================
  console.log('\n--- 2. Test Database Guard Invariants ---');

  // Empty or missing URL
  const emptyRes = validateTestDatabaseUrl('');
  assert(emptyRes.isValid === false, 'Test DB Guard blocks empty URL');

  // Non-test database suffix
  const prodRes = validateTestDatabaseUrl('postgresql://postgres:pass@localhost:5432/amazonbutton_prod');
  assert(
    prodRes.isValid === false && prodRes.error?.includes('_test'),
    'Test DB Guard blocks non-test database name without _test suffix',
  );

  // Supabase domain blocked
  const supabaseRes = validateTestDatabaseUrl('postgresql://postgres:pass@aws-0-ap-southeast-1.pooler.supabase.co:5432/db_test');
  assert(
    supabaseRes.isValid === false && supabaseRes.error?.includes('Supabase'),
    'Test DB Guard strictly blocks Supabase cloud pooler hosts',
  );

  // Subdomain attack blocked (e.g. localhost.attacker.com)
  const attackRes = validateTestDatabaseUrl('postgresql://postgres:pass@localhost.attacker.com:5432/db_test');
  assert(
    attackRes.isValid === false && attackRes.error?.includes('not in the allowed test database hosts'),
    'Test DB Guard strictly blocks subdomains like localhost.attacker.com',
  );

  // Valid localhost test database accepted
  const validRes = validateTestDatabaseUrl('postgresql://postgres:pass@localhost:5432/smart_order_test');
  assert(
    validRes.isValid === true && validRes.parsedDbName === 'smart_order_test',
    'Test DB Guard accepts valid localhost postgresql test URL with _test suffix',
  );

  // Loopback alias comparison (localhost vs 127.0.0.1 pointing to same database)
  const aliasRes = validateTestDatabaseUrl(
    'postgresql://postgres:pass@127.0.0.1:5432/smart_order_test',
    'postgresql://postgres:pass@localhost:5432/smart_order_test',
  );
  assert(
    aliasRes.isValid === false && aliasRes.error?.includes('exact same database target'),
    'Test DB Guard blocks loopback alias bypass (localhost vs 127.0.0.1 pointing to same DB)',
  );

  // ========================================================================
  // 3. P1 GOOGLE OAUTH SECURITY & DETERMINISTIC AUDIENCE VERIFICATION
  // ========================================================================
  console.log('\n--- 3. Google OAuth Security & Audience Hardening ---');

  const authRepoMock: any = {
    findByProviderSubject: async (p: string, sub: string) => null,
    findIdentityForUserAndProvider: async () => null,
    findUserWithAuthRelations: async (email: string) => {
      if (email === 'existing@amazonbutton.vn') {
        return {
          userId: BigInt(100),
          email,
          authProvider: 'LOCAL',
          providerSubject: null,
          status: 'ACTIVE',
        };
      }
      return null;
    },
    linkProviderSubject: async (userId: bigint, p: string, sub: string) => ({
      userId,
      email: 'newuser@amazonbutton.vn',
      authProvider: p,
      providerSubject: sub,
      status: 'ACTIVE',
    }),
    createGoogleUserTx: async (userData: any, profileData: any) => ({
      newUser: { userId: BigInt(200), ...userData, status: 'ACTIVE' },
      customerProfile: { customerId: BigInt(200), ...profileData },
    }),
    createRefreshToken: async () => ({ id: 'rt_mock_123' }),
  };

  const jwtServiceMock: any = {
    sign: () => 'mock_jwt_token',
  };

  const authService = new AuthService({} as any, authRepoMock, jwtServiceMock, {} as any);

  // Test production unverified takeover blocked
  const origNodeEnv = process.env.NODE_ENV;
  const origGoogleClientId = process.env.GOOGLE_CLIENT_ID;
  process.env.NODE_ENV = 'production';
  process.env.GOOGLE_CLIENT_ID = 'expected-production-client-id.apps.googleusercontent.com';

  let unverifiedTakeoverCaught = false;
  try {
    await authService.googleLogin({ email: 'victim@amazonbutton.vn', googleId: 'attacker_123' });
  } catch (err) {
    if (err instanceof UnauthorizedException) unverifiedTakeoverCaught = true;
  }
  assert(unverifiedTakeoverCaught === true, 'Production blocks unverified email/googleId takeover without token (401)');

  // Test OAuth2Client.verifyIdToken audience check
  const origFetch = global.fetch;
  global.fetch = (async () => {
    throw new Error('Offline test guard: external HTTP fetch is disabled');
  }) as any;

  const origVerifyIdToken = (authService as any).googleOAuthClient.verifyIdToken;
  try {
    (authService as any).googleOAuthClient.verifyIdToken = async (opts: any) => {
      if (opts.audience !== 'expected-production-client-id.apps.googleusercontent.com') {
        throw new Error('Wrong recipient, payload audience != requiredAudience');
      }
      if (opts.idToken === 'wrong_audience_token') {
        throw new Error('Token used with wrong audience');
      }
      if (opts.idToken === 'unverified_email_token') {
        return {
          getPayload: () => ({ email: 'unverified@test.com', email_verified: false, sub: '123' }),
        };
      }
      if (opts.idToken === 'third_party_link_token') {
        return {
          getPayload: () => ({ email: 'existing@amazonbutton.vn', email_verified: true, sub: 'attacker_999' }),
        };
      }
      if (opts.idToken === 'valid_token') {
        return {
          getPayload: () => ({
            email: 'newuser@amazonbutton.vn',
            email_verified: true,
            sub: '109283746592837465109',
            name: 'New Google User',
          }),
        };
      }
      throw new Error('Invalid token');
    };

    let wrongAudCaught = false;
    try {
      await authService.googleLogin({ token: 'wrong_audience_token' });
    } catch (err) {
      if (err instanceof UnauthorizedException) wrongAudCaught = true;
    }
    assert(wrongAudCaught === true, 'Google OAuth rejects token with mismatched audience with 401 Unauthorized');

    let unverifiedEmailCaught = false;
    try {
      await authService.googleLogin({ token: 'unverified_email_token' });
    } catch (err) {
      if (err instanceof UnauthorizedException) unverifiedEmailCaught = true;
    }
    assert(unverifiedEmailCaught === true, 'Google OAuth rejects token with email_verified=false with 401 Unauthorized');

    let thirdPartyCaught = false;
    try {
      await authService.googleLogin({ token: 'third_party_link_token' });
    } catch (err) {
      if (err instanceof ConflictException) thirdPartyCaught = true;
    }
    assert(thirdPartyCaught === true, 'Google OAuth blocks linking existing account without hd claim with 409 Conflict');

    const validLoginRes = await authService.googleLogin({ token: 'valid_token' });
    assert(
      validLoginRes?.data?.user?.email === 'newuser@amazonbutton.vn' &&
        validLoginRes?.data?.user?.providerSubject === '109283746592837465109',
      'Google OAuth creates new user with authoritative numeric sub from ID token payload',
    );
  } finally {
    global.fetch = origFetch;
    (authService as any).googleOAuthClient.verifyIdToken = origVerifyIdToken;
    process.env.NODE_ENV = origNodeEnv;
    process.env.GOOGLE_CLIENT_ID = origGoogleClientId;
  }

  // ========================================================================
  // 4. P1 DLQ ATOMICITY & RESILIENCE
  // ========================================================================
  console.log('\n--- 4. DLQ PostgreSQL & Memory Resilience ---');

  const inMemoryQueue = new QueueService();
  await inMemoryQueue.onModuleInit();

  // Test safe replay ID has no colons
  const dlqTestState = { replayIdVerified: false };
  inMemoryQueue.registerProcessor('dlq-test-queue', async (job) => {
    const rawId = String(job.id || job.opts?.jobId || '');
    if (rawId.includes('dlq-replay__') && !rawId.includes(':')) {
      dlqTestState.replayIdVerified = true;
      return;
    }
    throw new Error('Simulated worker crash');
  });

  // Exhaust job to DLQ
  await inMemoryQueue.enqueueJob('dlq-test-queue', 'crash-job', { data: 1 }, { attempts: 1 });
  // Wait for worker processing and DLQ move
  let dlqJobs = await inMemoryQueue.getDeadLetterJobs('dlq-test-queue');
  for (let i = 0; i < 20 && dlqJobs.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 100));
    dlqJobs = await inMemoryQueue.getDeadLetterJobs('dlq-test-queue');
  }
  assert(dlqJobs.length >= 1, 'Job moved to DLQ after exhaustion');

  if (dlqJobs.length >= 1) {
    const replaySuccess = await inMemoryQueue.retryDeadLetterJob(dlqJobs[0].id);
    assert(replaySuccess === true, 'retryDeadLetterJob enqueues job with colon-free ID');
    for (let i = 0; i < 20 && !dlqTestState.replayIdVerified; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert(dlqTestState.replayIdVerified === true, 'Replayed job ID uses BullMQ-safe colon-free format dlq-replay__*');
  }

  await inMemoryQueue.onModuleDestroy();

  // Test replay failure regression: replayed job fails again
  // Must update original DLQ record back to DEAD and MUST NOT create an orphan record!
  const failingQueue = new QueueService();
  await failingQueue.onModuleInit();

  failingQueue.registerProcessor('dlq-fail-again-queue', async (job) => {
    throw new Error('Permanent worker crash on replay');
  });

  // Exhaust job to DLQ
  await failingQueue.enqueueJob('dlq-fail-again-queue', 'always-fail-job', { data: 2 }, { attempts: 1 });
  await new Promise((r) => setTimeout(r, 100));

  const initialDlq = await failingQueue.getDeadLetterJobs('dlq-fail-again-queue');
  assert(initialDlq.length === 1, 'Initial job reached DLQ');
  const originalDlqId = initialDlq[0].id;

  // Replay job
  const replayed = await failingQueue.retryDeadLetterJob(originalDlqId);
  assert(replayed === true, 'Replay successfully enqueued');
  // Wait for worker to fail again and process DLQ move
  await new Promise((r) => setTimeout(r, 150));

  const afterFailureDlq = await failingQueue.getDeadLetterJobs('dlq-fail-again-queue');
  assert(
    afterFailureDlq.length === 1,
    'Replay failure does NOT create orphan DLQ record (count remains 1)',
  );
  assert(
    afterFailureDlq[0].id === originalDlqId && afterFailureDlq[0].status === 'DEAD',
    'Original DLQ record restored to DEAD status on replay failure',
  );
  assert(
    afterFailureDlq[0].failedReason.includes('REPLAY_FAILED'),
    'Original DLQ record updated with REPLAY_FAILED reason',
  );

  await failingQueue.onModuleDestroy();

  // 1. DLQ ID contains __ (e.g. dlq_origin__part)
  const qsDoubleUnderscore = new QueueService();
  const testDoubleUnderscoreId = 'dlq_origin__part';
  const replayIdDoubleUnderscore = `dlq-replay__${testDoubleUnderscoreId}__1793077482516`;
  const parsedDlqId = (qsDoubleUnderscore as any).extractReplayDlqId(replayIdDoubleUnderscore);
  assert(parsedDlqId === testDoubleUnderscoreId, 'extractReplayDlqId parses ID containing double underscores accurately');

  (qsDoubleUnderscore as any).deadLetterStore.set(testDoubleUnderscoreId, {
    id: testDoubleUnderscoreId,
    queueName: 'test-q',
    jobName: 'test-job',
    data: {},
    attemptsMade: 1,
    maxAttempts: 3,
    failedReason: '',
    status: 'RETRY_QUEUED',
    replayJobId: replayIdDoubleUnderscore,
    failedAt: new Date(),
  });

  await (qsDoubleUnderscore as any).moveToDeadLetterQueue(
    {
      id: replayIdDoubleUnderscore,
      queueName: 'test-q',
      jobName: 'test-job',
      data: {},
      attemptsMade: 1,
    },
    new Error('Replay crash'),
  );

  const dlqJobAfterFail = (qsDoubleUnderscore as any).deadLetterStore.get(testDoubleUnderscoreId);
  assert(
    dlqJobAfterFail?.status === 'DEAD' && dlqJobAfterFail?.failedReason.includes('REPLAY_FAILED'),
    'DLQ ID containing __ returns to DEAD status on replay failure without orphan',
  );

  // 2. Replay A expired/superseded by Replay B, then A fails -> B remains RETRY_QUEUED
  const dlqConcurrentId = 'dlq_concurrent_origin';
  const replayJobA = `dlq-replay__${dlqConcurrentId}__1000000000000`;
  const replayJobB = `dlq-replay__${dlqConcurrentId}__2000000000000`;

  let capturedWhere: any;
  const prismaCasMock: any = {
    deadLetterJob: {
      updateMany: async ({ where }: any) => {
        capturedWhere = where;
        return { count: 0 };
      },
    },
  };

  const qsConcurrentReplay = new QueueService(prismaCasMock);

  (qsConcurrentReplay as any).deadLetterStore.set(dlqConcurrentId, {
    id: dlqConcurrentId,
    queueName: 'test-q',
    jobName: 'test-job',
    data: {},
    attemptsMade: 1,
    maxAttempts: 3,
    failedReason: '',
    status: 'RETRY_QUEUED',
    replayJobId: replayJobB, // Replay B is the active one!
    failedAt: new Date(),
  });

  // Stale Replay A reports failure
  await (qsConcurrentReplay as any).moveToDeadLetterQueue(
    {
      id: replayJobA,
      queueName: 'test-q',
      jobName: 'test-job',
      data: {},
      opts: { attempts: 1 },
      attemptsMade: 1,
      createdAt: new Date(),
    },
    new Error('Stale Replay A failure'),
  );

  assert(
    capturedWhere?.id === dlqConcurrentId &&
      capturedWhere?.status === 'RETRY_QUEUED' &&
      capturedWhere?.replayJobId === replayJobA,
    'DB failure transition uses id + status + replayJobId CAS',
  );

  const concurrentJobState = (qsConcurrentReplay as any).deadLetterStore.get(dlqConcurrentId);
  assert(
    concurrentJobState?.status === 'RETRY_QUEUED' && concurrentJobState?.replayJobId === replayJobB,
    'Stale Replay A failure does NOT overwrite active Replay B in memory (remains RETRY_QUEUED when DB count is 0)',
  );

  // 3. Stale Replay A completes late -> does NOT delete active Replay B state
  await (qsConcurrentReplay as any).handleJobCompletion({
    id: replayJobA,
    queueName: 'test-q',
    jobName: 'test-job',
    data: {},
  });

  const concurrentJobAfterLateComplete = (qsConcurrentReplay as any).deadLetterStore.get(dlqConcurrentId);
  assert(
    concurrentJobAfterLateComplete !== undefined &&
    concurrentJobAfterLateComplete?.status === 'RETRY_QUEUED' &&
    concurrentJobAfterLateComplete?.replayJobId === replayJobB,
    'Stale Replay A late completion does NOT delete or alter active Replay B',
  );

  // 4. Flush does NOT overwrite state of existing records (uses create + P2002 check)
  const flushState = {
    createCalled: false,
    updateCalled: false,
    findUniqueCalled: false,
  };
  const mockPrismaFlush: any = {
    deadLetterJob: {
      create: async () => {
        flushState.createCalled = true;
        const err: any = new Error('Unique constraint failed');
        err.code = 'P2002';
        throw err;
      },
      findUnique: async () => {
        flushState.findUniqueCalled = true;
        return { id: 'dlq_unpersisted_1' };
      },
      update: async () => {
        flushState.updateCalled = true;
      },
      upsert: async () => {
        flushState.updateCalled = true;
      },
    },
  };
  const qsFlush = new QueueService(mockPrismaFlush);
  (qsFlush as any).unpersistedDeadLetterJobs.set('dlq_unpersisted_1', {
    id: 'dlq_unpersisted_1',
    queueName: 'test-q',
    jobName: 'test-job',
    data: {},
    attemptsMade: 1,
    maxAttempts: 3,
    failedReason: 'transient',
    status: 'DEAD',
    failedAt: new Date(),
  });

  await (qsFlush as any).flushUnpersistedDeadLetterJobs();
  assert(flushState.createCalled === true, 'flushUnpersistedDeadLetterJobs attempts create');
  assert(flushState.findUniqueCalled === true, 'P2002 collision triggers findUnique verification');
  assert(flushState.updateCalled === false, 'flush never calls update/upsert, preserving existing RESOLVED or active states');
  assert((qsFlush as any).unpersistedDeadLetterJobs.size === 0, 'Collision record cleanly evicted from unpersisted buffer');

  // 5. Redis Production Unified Matrix
  const envBackup = { ...process.env };

  // 5a. production without REDIS_URL -> Startup fail
  process.env.NODE_ENV = 'production';
  delete process.env.REDIS_URL;
  delete process.env.REDIS_HOST;
  delete process.env.DISABLE_REDIS;
  const qsProdNoRedis = new QueueService();
  let startupFailNoRedis = false;
  try {
    await (qsProdNoRedis as any).initRedisAndBullMQ();
  } catch (err: any) {
    if (err?.message?.includes('REDIS_URL is required')) {
      startupFailNoRedis = true;
    }
  }
  assert(startupFailNoRedis === true, 'Production without REDIS_URL fails startup immediately');

  // 5b. production + DISABLE_REDIS=true -> Startup fail
  process.env.NODE_ENV = 'production';
  process.env.DISABLE_REDIS = 'true';
  process.env.REDIS_URL = 'redis://localhost:6379';
  const qsProdDisableRedis = new QueueService();
  let startupFailDisableRedis = false;
  try {
    await (qsProdDisableRedis as any).initRedisAndBullMQ();
  } catch (err: any) {
    if (err?.message?.includes('DISABLE_REDIS=true is not permitted')) {
      startupFailDisableRedis = true;
    }
  }
  assert(startupFailDisableRedis === true, 'Production with DISABLE_REDIS=true fails startup immediately');

  // 5c. production connection failure -> Startup fail
  process.env.NODE_ENV = 'production';
  process.env.DISABLE_REDIS = 'false';
  process.env.REDIS_URL = 'redis://127.0.0.1:59999'; // unreachable port
  const qsProdConnFail = new QueueService();
  let startupFailConn = false;
  try {
    await (qsProdConnFail as any).initRedisAndBullMQ();
  } catch (err: any) {
    if (err?.message?.includes('Redis initialization failed')) {
      startupFailConn = true;
    }
  }
  assert(startupFailConn === true, 'Production with unreachable Redis throws Redis initialization failed');
  assert(
    (qsProdConnFail as any).redisClient === null,
    'Failed production Redis client is disconnected and released',
  );

  // 5d. production disconnected -> Enqueue fail (QUEUE_UNAVAILABLE)
  process.env.NODE_ENV = 'production';
  const qsProdEnq = new QueueService();
  let prodEnqueueUnavailable = false;
  try {
    await qsProdEnq.enqueueJob('prod-test-q', 'job', { test: true });
  } catch (err: any) {
    if (err?.message === 'QUEUE_UNAVAILABLE') {
      prodEnqueueUnavailable = true;
    }
  }
  assert(prodEnqueueUnavailable === true, 'Production enqueue throws QUEUE_UNAVAILABLE when BullMQ/Redis inactive');

  // 5e. test/development without Redis -> Memory fallback success
  process.env.NODE_ENV = 'test';
  delete process.env.REDIS_URL;
  delete process.env.REDIS_HOST;
  process.env.DISABLE_REDIS = 'true';
  const qsDev = new QueueService();
  await qsDev.onModuleInit();
  const devJobId = await qsDev.enqueueJob('dev-q', 'dev-job', { data: 123 });
  assert(typeof devJobId === 'string' && devJobId.startsWith('job_'), 'Development mode falls back cleanly to memory queue');
  await qsDev.onModuleDestroy();

  // Restore env
  process.env = envBackup;

  // Test Degraded Mode in getDeadLetterJobs when DB fails
  const mockPrismaFailing: any = {
    deadLetterJob: {
      findMany: async () => {
        throw new Error('Database connection lost');
      },
    },
  };
  const degradedQueue = new QueueService(mockPrismaFailing);
  (degradedQueue as any).unpersistedDeadLetterJobs.set('dlq_fallback_1', {
    id: 'dlq_fallback_1',
    queueName: 'degraded-queue',
    jobName: 'fallback-job',
    data: {},
    attemptsMade: 3,
    maxAttempts: 3,
    failedReason: 'DB_DOWN_FALLBACK',
    status: 'DEAD',
    failedAt: new Date(),
  });
  const degradedJobs = await degradedQueue.getDeadLetterJobs();
  assert(
    degradedJobs.length === 1 && degradedJobs[0].id === 'dlq_fallback_1',
    'getDeadLetterJobs serves unpersisted jobs in degraded mode when PostgreSQL query fails',
  );

  console.log('\n================================================================');
  console.log(`UNIT VERIFICATION SUMMARY: ${passed} passed, ${failed} failed`);
  console.log('================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
  process.exit(0);
}

runSuperpowersSecurityUnitSuite().catch((err) => {
  console.error('Fatal unit verification error:', err);
  process.exit(1);
});
