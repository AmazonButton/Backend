const dotenv = require('dotenv');
dotenv.config();
const key1 = process.env.RENDER_API_KEY_1;
const { PrismaClient } = require('@prisma/client');
const crypto = require('crypto');

async function applyMigration() {
  console.log('Fetching Render Supabase DATABASE_URL...');
  const res1 = await fetch('https://api.render.com/v1/services/srv-dbdom8gm7kps73ebg5fg/env-vars?limit=100', {
    headers: { Authorization: 'Bearer ' + key1 },
  });
  const data1 = await res1.json();
  const dbUrl = data1.find((e) => e.envVar.key === 'DATABASE_URL')?.envVar.value;
  if (!dbUrl) {
    throw new Error('Could not find DATABASE_URL in Render environment variables');
  }

  const host = dbUrl.split('@')[1]?.split('?')[0];
  console.log(`Connecting to ${host}...`);

  const prisma = new PrismaClient({
    datasources: { db: { url: dbUrl } },
  });

  console.log('1. Adding column payment_qr_code IF NOT EXISTS...');
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "customer_bank_verification_proofs" ADD COLUMN IF NOT EXISTS "payment_qr_code" TEXT;
  `);

  console.log('2. Recording migration in _prisma_migrations...');
  const migrationName = '20261115000000_add_customer_bank_verification_payment_qr_code';
  const existing = await prisma.$queryRawUnsafe(`
    SELECT id FROM _prisma_migrations WHERE migration_name = $1 LIMIT 1;
  `, migrationName);

  if (!existing || existing.length === 0) {
    const id = crypto.randomUUID();
    const checksum = crypto.createHash('sha256').update('ALTER TABLE "customer_bank_verification_proofs" ADD COLUMN IF NOT EXISTS "payment_qr_code" TEXT;').digest('hex');
    await prisma.$executeRawUnsafe(`
      INSERT INTO _prisma_migrations (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
      VALUES ($1, $2, NOW(), $3, NULL, NULL, NOW(), 1);
    `, id, checksum, migrationName);
    console.log(`Recorded migration "${migrationName}" (ID: ${id})`);
  } else {
    console.log(`Migration "${migrationName}" already recorded.`);
  }

  console.log('3. Verifying column existence in information_schema...');
  const cols = await prisma.$queryRawUnsafe(`
    SELECT table_schema, table_name, column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_name = 'customer_bank_verification_proofs'
      AND column_name = 'payment_qr_code';
  `);
  console.log('Verification result:');
  console.table(cols);

  console.log('4. Testing sample query from customerBankVerificationProof model...');
  const sample = await prisma.customerBankVerificationProof.findFirst({
    select: {
      id: true,
      customerId: true,
      accountId: true,
      status: true,
      paymentQrCode: true,
    },
  });
  console.log('Sample query succeeded! Sample record:', sample ? { ...sample, id: sample.id.toString(), customerId: sample.customerId.toString() } : 'No records (clean table)');

  await prisma.$disconnect();
  console.log('✅ Migration applied and verified on Supabase successfully!');
}

applyMigration().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
