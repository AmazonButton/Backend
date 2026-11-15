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
  console.log(`Connecting to ${host}...`);

  const prisma = new PrismaClient({
    datasources: { db: { url: dbUrl } },
  });

  try {
    console.log('1. Creating table warranty_tickets IF NOT EXISTS...');
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "warranty_tickets" (
        "ticket_id" BIGSERIAL NOT NULL,
        "ticket_code" VARCHAR(32) NOT NULL,
        "button_id" BIGINT NOT NULL,
        "replacement_button_id" BIGINT,
        "store_id" BIGINT,
        "customer_id" BIGINT,
        "reported_by_user_id" BIGINT NOT NULL,
        "fault_group" VARCHAR(20) NOT NULL,
        "fault_code" VARCHAR(50) NOT NULL,
        "deposit_amount" DECIMAL(15,2) NOT NULL DEFAULT 100000,
        "deduction_percent" INTEGER NOT NULL DEFAULT 0,
        "deduction_amount" DECIMAL(15,2) NOT NULL DEFAULT 0,
        "refund_amount" DECIMAL(15,2) NOT NULL DEFAULT 100000,
        "inspection_note" TEXT,
        "admin_note" TEXT,
        "status" VARCHAR(30) NOT NULL DEFAULT 'PENDING',
        "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "warranty_tickets_pkey" PRIMARY KEY ("ticket_id")
      );
    `);

    console.log('2. Creating indexes...');
    await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "warranty_tickets_ticket_code_key" ON "warranty_tickets"("ticket_code");`);
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "idx_warranty_tickets_store_status" ON "warranty_tickets"("store_id", "status");`);
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "idx_warranty_tickets_button" ON "warranty_tickets"("button_id", "created_at" DESC);`);
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "idx_warranty_tickets_reporter" ON "warranty_tickets"("reported_by_user_id");`);

    console.log('3. Adding foreign keys...');
    await prisma.$executeRawUnsafe(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'warranty_tickets_button_id_fkey') THEN
          ALTER TABLE "warranty_tickets" ADD CONSTRAINT "warranty_tickets_button_id_fkey" FOREIGN KEY ("button_id") REFERENCES "iot_button"("button_id") ON DELETE RESTRICT ON UPDATE CASCADE;
        END IF;
      END $$;
    `);

    await prisma.$executeRawUnsafe(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'warranty_tickets_replacement_button_id_fkey') THEN
          ALTER TABLE "warranty_tickets" ADD CONSTRAINT "warranty_tickets_replacement_button_id_fkey" FOREIGN KEY ("replacement_button_id") REFERENCES "iot_button"("button_id") ON DELETE SET NULL ON UPDATE CASCADE;
        END IF;
      END $$;
    `);

    await prisma.$executeRawUnsafe(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'warranty_tickets_store_id_fkey') THEN
          ALTER TABLE "warranty_tickets" ADD CONSTRAINT "warranty_tickets_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "store"("store_id") ON DELETE SET NULL ON UPDATE CASCADE;
        END IF;
      END $$;
    `);

    await prisma.$executeRawUnsafe(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'warranty_tickets_customer_id_fkey') THEN
          ALTER TABLE "warranty_tickets" ADD CONSTRAINT "warranty_tickets_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer_profile"("customer_id") ON DELETE SET NULL ON UPDATE CASCADE;
        END IF;
      END $$;
    `);

    await prisma.$executeRawUnsafe(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'warranty_tickets_reported_by_user_id_fkey') THEN
          ALTER TABLE "warranty_tickets" ADD CONSTRAINT "warranty_tickets_reported_by_user_id_fkey" FOREIGN KEY ("reported_by_user_id") REFERENCES "users"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;
        END IF;
      END $$;
    `);

    console.log('4. Recording migration in _prisma_migrations...');
    const migrationName = '20261115143000_add_warranty_tickets_table';
    const checksum = crypto.createHash('sha256').update(migrationName).digest('hex');

    const existing = await prisma.$queryRawUnsafe(
      `SELECT id FROM _prisma_migrations WHERE migration_name = $1`,
      migrationName,
    );

    if (existing.length === 0) {
      const id = crypto.randomUUID();
      await prisma.$executeRawUnsafe(
        `INSERT INTO _prisma_migrations (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
         VALUES ($1, $2, NOW(), $3, NULL, NULL, NOW(), 1)`,
        id,
        checksum,
        migrationName,
      );
      console.log(`Recorded migration ${migrationName} in _prisma_migrations with id ${id}`);
    } else {
      console.log(`Migration ${migrationName} was already recorded.`);
    }

    const checkTable = await prisma.$queryRawUnsafe(
      `SELECT table_name FROM information_schema.tables WHERE table_name = 'warranty_tickets'`,
    );
    console.log('Verified table on target DB:', checkTable);
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
