const dotenv = require('dotenv');
dotenv.config();
const key1 = process.env.RENDER_API_KEY_1;
const { PrismaClient } = require('@prisma/client');
const crypto = require('crypto');

async function main() {
  if (!key1) {
    console.log('RENDER_API_KEY_1 not set in local .env; skipping remote Render/Supabase check.');
    return;
  }

  console.log('Fetching Render DATABASE_URL...');
  const res1 = await fetch('https://api.render.com/v1/services/srv-dbdom8gm7kps73ebg5fg/env-vars?limit=100', {
    headers: { Authorization: 'Bearer ' + key1 },
  });
  const data1 = await res1.json();
  const dbUrl = Array.isArray(data1) ? data1.find((e) => e.envVar?.key === 'DATABASE_URL')?.envVar?.value : null;
  if (!dbUrl) {
    console.log('Could not find DATABASE_URL in Render environment variables; skipping remote migration.');
    return;
  }

  const host = dbUrl.split('@')[1]?.split('?')[0];
  console.log(`Connecting to ${host}...`);

  const prisma = new PrismaClient({
    datasources: { db: { url: dbUrl } },
  });

  try {
    console.log('1. Adding latitude and longitude to store...');
    await prisma.$executeRawUnsafe(`
      ALTER TABLE "store"
        ADD COLUMN IF NOT EXISTS "latitude" DECIMAL(10, 7),
        ADD COLUMN IF NOT EXISTS "longitude" DECIMAL(10, 7);
    `);

    console.log('2. Backfilling coordinates for existing ACTIVE stores...');
    await prisma.$executeRawUnsafe(`
      UPDATE "store"
      SET
        "latitude" = 10.7768890,
        "longitude" = 106.7008060
      WHERE "status" = 'ACTIVE'
        AND ("latitude" IS NULL OR "longitude" IS NULL);
    `);

    console.log('3. Adding delivery_address_id, delivery_distance_meters, delivery_distance_source to orders...');
    await prisma.$executeRawUnsafe(`
      ALTER TABLE "orders"
        ADD COLUMN IF NOT EXISTS "delivery_address_id" BIGINT,
        ADD COLUMN IF NOT EXISTS "delivery_distance_meters" INTEGER,
        ADD COLUMN IF NOT EXISTS "delivery_distance_source" VARCHAR(50);
    `);

    console.log('4. Recording migration in _prisma_migrations...');
    const migrationName = '20261116160000_add_store_coords_and_order_delivery_distance';
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

    const cols = await prisma.$queryRawUnsafe(`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE (table_name = 'store' AND column_name IN ('latitude', 'longitude'))
         OR (table_name = 'orders' AND column_name IN ('delivery_address_id', 'delivery_distance_meters', 'delivery_distance_source'))
      ORDER BY table_name, column_name;
    `);
    console.log('Verified columns on target DB:', cols);
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
