import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

// No real credentials are inherited and every URL below must fail before connect.
const base: NodeJS.ProcessEnv = { NODE_ENV: 'test' };
for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'TEMP', 'TMP']) {
  if (process.env[key]) base[key] = process.env[key];
}
const cases = [
  { name: 'missing explicit test URL', env: {}, reason: /environment variable is mandatory/ },
  { name: 'non-test database', env: { TEST_DATABASE_URL: 'postgresql://u:p@localhost:5432/app' }, reason: /must strictly end with suffix/ },
  { name: 'Supabase database', env: { TEST_DATABASE_URL: 'postgresql://u:p@db.supabase.co:5432/app_test' }, reason: /cannot point to Supabase/ },
  { name: 'primary database loopback alias', env: {
    TEST_DATABASE_URL: 'postgresql://u:p@localhost:5432/app_test',
    DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/app_test',
  }, reason: /exact same database target/ },
];
for (const test of cases) {
  const result = spawnSync(process.execPath, [
    resolve('node_modules/tsx/dist/cli.mjs'),
    resolve('tests/customers_repository_postgres_concurrency_spec.ts'),
  ], { env: { ...base, ...test.env }, encoding: 'utf8', timeout: 15_000 });
  assert.equal(result.error, undefined, `${test.name}: subprocess failed`);
  assert.equal(result.status, 1, `${test.name}: expected fail-closed exit code`);
  assert.match(result.stderr, test.reason, `${test.name}: failed for wrong reason`);
  assert.doesNotMatch(result.stdout, /TEST 1:|Dọn dẹp/, `${test.name}: reached database test body`);
  console.log(`PASS: ${test.name}`);
}
