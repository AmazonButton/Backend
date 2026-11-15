const dotenv = require('dotenv');
dotenv.config();
const key1 = process.env.RENDER_API_KEY_1;
const { PrismaClient } = require('@prisma/client');

async function check() {
  const res1 = await fetch('https://api.render.com/v1/services/srv-dbdom8gm7kps73ebg5fg/env-vars?limit=100', {
    headers: { Authorization: 'Bearer ' + key1 },
  });
  const data1 = await res1.json();
  const dbUrl = data1.find((e) => e.envVar.key === 'DATABASE_URL')?.envVar.value;

  const prisma = new PrismaClient({
    datasources: { db: { url: dbUrl } },
  });

  const migrations = await prisma.$queryRawUnsafe(`
    SELECT id, migration_name, finished_at, rolled_back_at
    FROM _prisma_migrations
    ORDER BY finished_at DESC
    LIMIT 10;
  `);

  console.log('Latest 10 migrations on Supabase:');
  console.table(migrations);

  await prisma.$disconnect();
}

check().catch(console.error);
