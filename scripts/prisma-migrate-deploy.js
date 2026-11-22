'use strict';

require('dotenv/config');
const { spawnSync } = require('child_process');

/**
 * Rewrites a Supabase transaction-pooler URL (`:6543?pgbouncer=true`) to the
 * session-pooler port (`:5432`) so Prisma migration advisory locks succeed.
 */
function resolveDirectMigrationUrl(env = process.env) {
  const direct = typeof env.DIRECT_URL === 'string' ? env.DIRECT_URL.trim() : '';
  if (direct) {
    return { url: direct, source: 'DIRECT_URL', rewrittenFromPooler: false };
  }

  const rawDbUrl = typeof env.DATABASE_URL === 'string' ? env.DATABASE_URL.trim() : '';
  if (!rawDbUrl) {
    throw new Error('Missing DATABASE_URL (and DIRECT_URL) in environment.');
  }

  const parsed = new URL(rawDbUrl);
  const isSupabasePooler = parsed.hostname.endsWith('.pooler.supabase.com');
  const isPgBouncer =
    parsed.port === '6543' || parsed.searchParams.get('pgbouncer') === 'true';

  if (isSupabasePooler && isPgBouncer) {
    if (parsed.port === '6543' || !parsed.port) {
      parsed.port = '5432';
    }
    parsed.searchParams.delete('pgbouncer');
    return {
      url: parsed.toString(),
      source: 'DATABASE_URL_SESSION_5432',
      rewrittenFromPooler: true,
    };
  }

  return { url: rawDbUrl, source: 'DATABASE_URL', rewrittenFromPooler: false };
}

/**
 * Redacts user credentials from a PostgreSQL connection URL for safe logging.
 */
function maskDatabaseUrl(rawUrl) {
  const parsed = new URL(rawUrl);
  const query = parsed.search || '';
  const port = parsed.port ? `:${parsed.port}` : '';
  return `${parsed.protocol}//${parsed.hostname}${port}${parsed.pathname}${query}`;
}

function main() {
  const args = process.argv.slice(2);
  const isStatus = args.includes('--status');
  const isDryRun = args.includes('--dry-run');

  const resolved = resolveDirectMigrationUrl(process.env);
  const masked = maskDatabaseUrl(resolved.url);
  const prismaSubcommand = isStatus ? ['migrate', 'status'] : ['migrate', 'deploy'];

  console.log(
    `[prisma-migrate] mode=${isStatus ? 'status' : 'deploy'} source=${resolved.source} target=${masked}`,
  );

  if (isDryRun) {
    console.log(`[prisma-migrate] dry-run: would execute npx prisma ${prismaSubcommand.join(' ')}`);
    return;
  }

  const command = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const result = spawnSync(command, ['prisma', ...prismaSubcommand], {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: resolved.url },
    shell: process.platform === 'win32',
  });

  if (result.error) {
    console.error('[prisma-migrate] Failed to invoke Prisma CLI:', result.error.message);
    process.exit(1);
  }
  process.exit(result.status === null ? 1 : result.status);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error('[prisma-migrate] Error:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

module.exports = {
  resolveDirectMigrationUrl,
  maskDatabaseUrl,
};
