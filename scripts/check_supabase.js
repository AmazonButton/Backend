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
  console.log('Connecting to Render DB host:', dbUrl?.split('@')[1]?.split('?')[0]);

  const prisma = new PrismaClient({
    datasources: {
      db: { url: dbUrl },
    },
  });

  const res = await prisma.$queryRawUnsafe(`
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_name = 'customer_bank_verification_proofs'
      AND column_name = 'payment_qr_code';
  `);
  console.log('Column payment_qr_code in Render DB:', res);

  const allCols = await prisma.$queryRawUnsafe(`
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_name = 'customer_bank_verification_proofs'
    ORDER BY ordinal_position;
  `);
  console.log('All columns in customer_bank_verification_proofs on Render DB:');
  console.table(allCols);

  await prisma.$disconnect();
}

check().catch(console.error);
