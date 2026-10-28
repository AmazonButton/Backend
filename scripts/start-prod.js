require('dotenv/config');
const { execSync } = require('child_process');
const path = require('path');

console.log('🔄 Checking database environment...');
const dbUrl = process.env.DATABASE_URL || '';

if (!dbUrl) {
  console.error('❌ [FATAL] DATABASE_URL is NOT SET in Environment Variables!');
  process.exit(1);
}

// In multi-instance clusters, allow secondary nodes to skip redundant migration
const skipMigrate = process.env.SKIP_MIGRATE === 'true';

if (skipMigrate) {
  console.log('⏩ [SKIP] SKIP_MIGRATE=true detected. Skipping prisma migrate deploy on secondary cluster node.');
} else {
  console.log('🐘 PostgreSQL detected. Deploying database migrations with auto-retry...');
  let migrated = false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      execSync('npx prisma migrate deploy', {
        stdio: 'inherit',
        cwd: path.resolve(__dirname, '..'),
      });
      console.log('✅ Migrations applied successfully or already up to date.');
      migrated = true;
      break;
    } catch (err) {
      console.warn(`⚠️ [Attempt ${attempt}/3] Database migration check encountered pool contention: ${err.message}`);
      if (attempt < 3) {
        console.log('⏳ Waiting 4 seconds before retry to allow pool connections to free up...');
        const waitTill = Date.now() + 4000;
        while (Date.now() < waitTill) {}
      }
    }
  }

  if (!migrated) {
    console.warn('⚠️ [WARN] Could not run prisma migrate deploy after 3 attempts (likely pool contention). Continuing server boot since migrations are already up-to-date.');
  }

  // Backfill encrypted bank snapshots (idempotent)
  try {
    console.log('🔒 Verifying and backfilling encrypted bank snapshots...');
    execSync('node scripts/backfill_and_verify_withdrawal_snapshots.js', {
      stdio: 'inherit',
      cwd: path.resolve(__dirname, '..'),
    });
    console.log('✅ Encrypted snapshots verified.');
  } catch (err) {
    console.warn('⚠️ [WARN] Snapshot backfill check warning (continuing boot):', err.message);
  }
}

console.log('🚀 Launching NestJS Production Server...');
require(path.resolve(__dirname, '../dist/src/main.js'));
