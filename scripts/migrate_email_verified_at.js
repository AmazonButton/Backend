const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  console.log('Adding email_verified_at column to users table if not exists...');
  await prisma.$executeRawUnsafe(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ(6);
  `);

  console.log('Backfilling email_verified_at for existing verified active users...');
  const updatedCount = await prisma.$executeRawUnsafe(`
    UPDATE users 
    SET email_verified_at = created_at 
    WHERE email_verified_at IS NULL 
      AND email_verification_token IS NULL 
      AND status = 'ACTIVE';
  `);
  console.log(`Backfilled ${updatedCount} rows.`);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('Migration error:', err);
  process.exit(1);
});
