require('dotenv/config');
const { execSync } = require('child_process');
const path = require('path');

console.log('🔄 Checking database environment...');
const dbUrl = process.env.DATABASE_URL || '';

if (!dbUrl) {
  console.error('❌ [FATAL] DATABASE_URL is NOT SET in Environment Variables!');
  process.exit(1);
}

console.log('🐘 PostgreSQL detected. Deploying database migrations...');
try {
  execSync('npx prisma migrate deploy', {
    stdio: 'inherit',
    cwd: path.resolve(__dirname, '..'),
  });
  console.log('✅ Migrations applied successfully or already up to date.');

  console.log('🔒 Verifying and backfilling encrypted bank snapshots...');
  execSync('node scripts/backfill_and_verify_withdrawal_snapshots.js', {
    stdio: 'inherit',
    cwd: path.resolve(__dirname, '..'),
  });
  console.log('✅ Encrypted snapshots verified.');
} catch (err) {
  console.error('❌ [FATAL] Database migration or snapshot backfill failed:', err.message);
  process.exit(1);
}

console.log('🚀 Launching NestJS Production Server...');
require(path.resolve(__dirname, '../dist/src/main.js'));
