const { execSync } = require('child_process');
const path = require('path');

console.log('🔄 Checking database environment...');
const dbUrl = process.env.DATABASE_URL || '';

if (!dbUrl) {
  console.warn('⚠️ [CRITICAL] DATABASE_URL is NOT SET in Environment Variables!');
  console.warn('⚠️ Please configure DATABASE_URL in your deployment environment.');
} else {
  console.log('🐘 PostgreSQL detected. Verifying database migrations...');
  try {
    execSync('npx prisma migrate deploy', {
      stdio: 'inherit',
      cwd: path.resolve(__dirname, '..'),
    });
    console.log('✅ Migrations applied successfully or already up to date.');
  } catch (err) {
    console.error('⚠️ Note on database migration check:', err.message);
  }
}

console.log('🚀 Launching NestJS Production Server...');
require(path.resolve(__dirname, '../dist/src/main.js'));
