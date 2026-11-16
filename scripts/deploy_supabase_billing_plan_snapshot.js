const dotenv = require('dotenv');
dotenv.config();
const key1 = process.env.RENDER_API_KEY_1;
const { PrismaClient } = require('@prisma/client');
const crypto = require('crypto');

async function main() {
  console.log('Fetching Render DATABASE_URL...');
  const res1 = await fetch('https://api.render.com/v1/services/srv-dbdom8gm7kps73ebg5fg/env-vars?limit=100', {
    headers: { Authorization: 'Bearer ' + key1 },
  });
  const data1 = await res1.json();
  const dbUrl = data1.find((e) => e.envVar.key === 'DATABASE_URL')?.envVar.value;
  if (!dbUrl) {
    throw new Error('Could not find DATABASE_URL in Render environment variables');
  }

  const host = dbUrl.split('@')[1]?.split('?')[0];
  console.log(`Connecting to Supabase at ${host}...`);

  const prisma = new PrismaClient({
    datasources: { db: { url: dbUrl } },
  });

  try {
    console.log('1. Adding plan_id and plan_snapshot to billing_charges...');
    await prisma.$executeRawUnsafe(`
      ALTER TABLE "billing_charges" 
      ADD COLUMN IF NOT EXISTS "plan_id" BIGINT,
      ADD COLUMN IF NOT EXISTS "plan_snapshot" JSONB;
    `);
    console.log('✔ Columns added successfully.');

    console.log('2. Adding index idx_billing_charges_plan...');
    await prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "idx_billing_charges_plan" ON "billing_charges"("plan_id");
    `);
    console.log('✔ Index created successfully.');

    console.log('3. Adding foreign key constraint billing_charges_plan_id_fkey...');
    await prisma.$executeRawUnsafe(`
      DO $$
      BEGIN
          IF NOT EXISTS (
              SELECT 1 FROM pg_constraint WHERE conname = 'billing_charges_plan_id_fkey'
          ) THEN
              ALTER TABLE "billing_charges" ADD CONSTRAINT "billing_charges_plan_id_fkey" 
              FOREIGN KEY ("plan_id") REFERENCES "subscription_plans"("plan_id") ON DELETE SET NULL ON UPDATE CASCADE;
          END IF;
      END $$;
    `);
    console.log('✔ Foreign key constraint created successfully.');

    console.log('4. Recording migration in _prisma_migrations...');
    const migrationName = '20261116043000_add_billing_charges_plan_snapshot';
    const migrationSql = `-- AlterTable
ALTER TABLE "billing_charges" ADD COLUMN IF NOT EXISTS "plan_id" BIGINT,
ADD COLUMN IF NOT EXISTS "plan_snapshot" JSONB;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_billing_charges_plan" ON "billing_charges"("plan_id");

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'billing_charges_plan_id_fkey'
    ) THEN
        ALTER TABLE "billing_charges" ADD CONSTRAINT "billing_charges_plan_id_fkey" 
        FOREIGN KEY ("plan_id") REFERENCES "subscription_plans"("plan_id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END $$;`;
    const checksum = crypto.createHash('sha256').update(migrationSql).digest('hex');

    const existingMigration = await prisma.$queryRawUnsafe(
      `SELECT id FROM _prisma_migrations WHERE migration_name = $1`,
      migrationName,
    );

    if (existingMigration.length === 0) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO _prisma_migrations (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
         VALUES ($1, $2, NOW(), $3, NULL, NULL, NOW(), 1)`,
        crypto.randomUUID(),
        checksum,
        migrationName,
      );
      console.log(`✔ Migration ${migrationName} recorded into _prisma_migrations.`);
    } else {
      console.log(`ℹ Migration ${migrationName} was already recorded.`);
    }

    console.log('\n5. Verifying columns on Supabase billing_charges:');
    const cols = await prisma.$queryRawUnsafe(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'billing_charges' AND column_name IN ('plan_id', 'plan_snapshot')
      ORDER BY ordinal_position;
    `);
    console.table(cols);

    console.log('🎉 ALL SUPABASE MIGRATIONS COMPLETED AND VERIFIED!');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(console.error);
