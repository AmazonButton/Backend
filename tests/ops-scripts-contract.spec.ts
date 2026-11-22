import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  maskDatabaseUrl,
  resolveDirectMigrationUrl,
} from '../scripts/prisma-migrate-deploy';
import {
  maskIdentifier,
  parseGrantRoleArgs,
  runGrantPlatformRole,
} from '../scripts/grant-platform-role';
import { resolveCommitSha } from '../scripts/resolve-commit-sha';
import { isAllowedPaymentRedirectUrl } from '../src/payments/dto/payment.dto';
import { BankLookupRateLimitGuard } from '../src/bank-verification/guards/bank-lookup-rate-limit.guard';

function testResolveDirectMigrationUrl() {
  const explicitDirect = resolveDirectMigrationUrl({
    DIRECT_URL: 'postgresql://user:secret@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres?sslmode=require',
    DATABASE_URL: 'postgresql://user:secret@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres?sslmode=require&pgbouncer=true',
  });
  assert.equal(explicitDirect.source, 'DIRECT_URL');
  assert.equal(explicitDirect.rewrittenFromPooler, false);

  const rewritten = resolveDirectMigrationUrl({
    DATABASE_URL: 'postgresql://postgres.proj:secret@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres?sslmode=require&pgbouncer=true',
  });
  assert.equal(rewritten.source, 'DATABASE_URL_SESSION_5432');
  assert.equal(rewritten.rewrittenFromPooler, true);
  assert.equal(
    rewritten.url,
    'postgresql://postgres.proj:secret@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres?sslmode=require',
  );
  assert.equal(
    maskDatabaseUrl(rewritten.url),
    'postgresql://aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres?sslmode=require',
  );
  assert.ok(!maskDatabaseUrl(rewritten.url).includes('secret'));

  const localPg = resolveDirectMigrationUrl({
    DATABASE_URL: 'postgresql://postgres:secret@localhost:5432/smart_order_test?schema=public',
  });
  assert.equal(localPg.source, 'DATABASE_URL');
  assert.equal(localPg.rewrittenFromPooler, false);
}

async function testGrantPlatformRoleValidationAndDryRun() {
  assert.throws(
    () => parseGrantRoleArgs(['--role', 'SUPER_ADMIN']),
    /Must provide either --user-id/,
  );
  assert.throws(
    () => parseGrantRoleArgs(['--user-id', '1', '--role', 'STAFF_DELIVERY']),
    /Invalid --role/,
  );
  assert.throws(
    () => parseGrantRoleArgs(['--user-id', '1', '--role', 'SUPER_ADMIN', '--execute']),
    /Missing --confirm-db/,
  );

  const parsed = parseGrantRoleArgs([
    '--user-id',
    '160',
    '--role',
    'SYSTEM_STAFF',
    '--actor-user-id',
    '1',
    '--reason',
    'Grant platform tech operator',
  ]);
  assert.equal(parsed.userId, '160');
  assert.equal(parsed.roleCode, 'SYSTEM_STAFF');
  assert.equal(parsed.execute, false);
  assert.equal(maskIdentifier('alice@example.com'), 'a***@example.com');

  const fakePrisma: any = {
    user: {
      findFirst: async () => ({
        userId: BigInt(160),
        username: 'ops_user',
        email: 'ops@example.com',
        status: 'ACTIVE',
        ownedStores: [],
        storeStaffs: [],
        platformMemberships: [],
      }),
    },
    role: {
      findUnique: async () => ({ roleId: BigInt(24), roleCode: 'SYSTEM_STAFF' }),
    },
    $queryRaw: async () => [{ db_name: 'smart_order_test' }],
  };

  const dryRunResult = await runGrantPlatformRole(fakePrisma, parsed);
  assert.equal(dryRunResult.dryRun, true);
  assert.equal(dryRunResult.databaseName, 'smart_order_test');
  assert.equal(dryRunResult.action, 'WOULD_GRANT_MEMBERSHIP');
  assert.equal(dryRunResult.maskedEmail, 'o***@example.com');
}

function testResolveCommitSha() {
  assert.equal(
    resolveCommitSha({ RENDER_GIT_COMMIT: ' render123 ', GITHUB_SHA: 'gh456', COMMIT_SHA: 'local789' }),
    'render123',
  );
  assert.equal(
    resolveCommitSha({ RENDER_GIT_COMMIT: '   ', GITHUB_SHA: 'gh456', COMMIT_SHA: 'local789' }),
    'gh456',
  );
  assert.equal(
    resolveCommitSha({ COMMIT_SHA: 'local789' }),
    'local789',
  );

  const repoRoot = path.resolve(__dirname, '..');
  const gitSha = resolveCommitSha({}, repoRoot);
  assert.match(gitSha, /^[0-9a-f]{40}$/i);

  const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-git-sha-'));
  try {
    assert.equal(resolveCommitSha({}, nonGitDir), 'unknown');
  } finally {
    fs.rmSync(nonGitDir, { recursive: true, force: true });
  }
}

function testRedirectUrlAndWorkerCorsContract() {
  const prodEnv: NodeJS.ProcessEnv = {
    NODE_ENV: 'production',
    FRONTEND_URL: 'https://smart-order-button.vercel.app',
    CORS_ORIGIN: 'https://smart-order-button.vercel.app,https://buttontdash.vercel.app,http://localhost:5173',
  };
  assert.equal(isAllowedPaymentRedirectUrl('https://smartorder.vn/payment/success', prodEnv), true);
  assert.equal(isAllowedPaymentRedirectUrl('https://pay.smartorder.vn/payment/success', prodEnv), true);
  assert.equal(
    isAllowedPaymentRedirectUrl('https://smart-order-button.vercel.app/shop?payos_status=success&orderId=1', prodEnv),
    true,
  );
  assert.equal(
    isAllowedPaymentRedirectUrl('https://buttontdash.vercel.app/payment/success', prodEnv),
    true,
  );
  assert.equal(isAllowedPaymentRedirectUrl('http://localhost:5173/shop', prodEnv), false);
  assert.equal(isAllowedPaymentRedirectUrl('https://evil.test/shop', prodEnv), false);
  assert.equal(isAllowedPaymentRedirectUrl('https://smartorder.vn.evil.test/shop', prodEnv), false);
  assert.equal(isAllowedPaymentRedirectUrl('https://user:pass@smartorder.vn/shop', prodEnv), false);

  const devEnv: NodeJS.ProcessEnv = { NODE_ENV: 'development' };
  assert.equal(isAllowedPaymentRedirectUrl('http://localhost:5173/shop', devEnv), true);

  const workerSource = fs.readFileSync(
    path.resolve(__dirname, '../cloudflare-worker/worker.js'),
    'utf8',
  );
  for (const header of ['x-idempotency-key', 'X-Idempotency-Key', 'x-request-id']) {
    assert.ok(
      workerSource.includes(header),
      `Cloudflare worker CORS preflight must whitelist ${header}`,
    );
  }
}

async function testRedisBudgetAndBankLookupLazyConnect() {
  const queueSrc = fs.readFileSync(
    path.resolve(__dirname, '../src/common/queues/queue.service.ts'),
    'utf8',
  );
  assert.ok(queueSrc.includes('drainDelay: 30'), 'BullWorker should bound idle drain polling');
  assert.ok(queueSrc.includes('stalledInterval: 120000'), 'BullWorker should bound stalled scan interval');
  assert.ok(queueSrc.includes('removeOnFail: { count: 20, age: 86400 }'), 'QueueService must cap retained failed jobs');
  assert.ok(queueSrc.includes('removeOnComplete: { count: 10, age: 3600 }'), 'QueueService must cap completed jobs');

  const guardClass = BankLookupRateLimitGuard as any;
  const prevClient = guardClass.redisClient;
  const prevInit = guardClass.redisInitialized;
  const prevEnv = process.env.NODE_ENV;

  try {
    let connectCalls = 0;
    const mockRedis: any = {
      status: 'wait',
      connect: async () => {
        connectCalls++;
        mockRedis.status = 'ready';
      },
      incr: async () => 1,
      expire: async () => 1,
    };
    guardClass.redisClient = mockRedis;
    guardClass.redisInitialized = true;
    process.env.NODE_ENV = 'production';

    const guard = new BankLookupRateLimitGuard();
    const ctx: any = {
      switchToHttp: () => ({
        getRequest: () => ({ user: { userId: '42' }, ip: '127.0.0.1' }),
      }),
    };
    const allowed = await guard.canActivate(ctx);
    assert.equal(allowed, true);
    assert.equal(connectCalls, 1);

    mockRedis.status = 'wait';
    mockRedis.connect = async () => {
      throw new Error('Redis unreachable');
    };
    let rejectedProd503 = false;
    try {
      await guard.canActivate(ctx);
    } catch (err: any) {
      rejectedProd503 = err?.getStatus?.() === 503;
    }
    assert.equal(rejectedProd503, true);
  } finally {
    guardClass.redisClient = prevClient;
    guardClass.redisInitialized = prevInit;
    process.env.NODE_ENV = prevEnv;
  }
}

async function main() {
  testResolveDirectMigrationUrl();
  await testGrantPlatformRoleValidationAndDryRun();
  testResolveCommitSha();
  testRedirectUrlAndWorkerCorsContract();
  await testRedisBudgetAndBankLookupLazyConnect();
  console.log('ALL OPS SCRIPTS CONTRACT TESTS PASSED');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
