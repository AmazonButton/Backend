import assert from 'node:assert/strict';
import {
  maskDatabaseUrl,
  resolveDirectMigrationUrl,
} from '../scripts/prisma-migrate-deploy';
import {
  maskIdentifier,
  parseGrantRoleArgs,
  runGrantPlatformRole,
} from '../scripts/grant-platform-role';

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

async function main() {
  testResolveDirectMigrationUrl();
  await testGrantPlatformRoleValidationAndDryRun();
  console.log('ALL OPS SCRIPTS CONTRACT TESTS PASSED');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
