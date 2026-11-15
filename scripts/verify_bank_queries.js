const dotenv = require('dotenv');
dotenv.config();
const key1 = process.env.RENDER_API_KEY_1;
const { PrismaClient } = require('@prisma/client');

async function testBankQueries() {
  console.log('Connecting to Render Supabase Database...');
  const res1 = await fetch('https://api.render.com/v1/services/srv-dbdom8gm7kps73ebg5fg/env-vars?limit=100', {
    headers: { Authorization: 'Bearer ' + key1 },
  });
  const data1 = await res1.json();
  const dbUrl = data1.find((e) => e.envVar.key === 'DATABASE_URL')?.envVar.value;

  const prisma = new PrismaClient({
    datasources: { db: { url: dbUrl } },
  });

  console.log('\n--- 1. Testing findFirst() (used by findLatestVerificationSessionByAccount) ---');
  const latestSession = await prisma.customerBankVerificationProof.findFirst({
    where: {
      customerId: 1n,
    },
    orderBy: { createdAt: 'desc' },
  });
  console.log('findFirst() result:', latestSession ? {
    id: latestSession.id.toString(),
    customerId: latestSession.customerId.toString(),
    accountId: latestSession.accountId.toString(),
    status: latestSession.status,
    paymentQrCode: latestSession.paymentQrCode,
  } : 'No records (clean)');

  console.log('\n--- 2. Testing findMany() (used by findVerificationSessionHistory) ---');
  const history = await prisma.customerBankVerificationProof.findMany({
    where: {
      customerId: 1n,
    },
    orderBy: { createdAt: 'desc' },
    take: 10,
    skip: 0,
  });
  console.log(`findMany() returned ${history.length} records without any error!`);
  history.forEach((h, i) => {
    console.log(`  [${i}] ID: ${h.id}, status: ${h.status}, paymentQrCode: ${h.paymentQrCode}`);
  });

  console.log('\n--- 3. Verifying column definition in PostgreSQL ---');
  const colDef = await prisma.$queryRawUnsafe(`
    SELECT table_schema, table_name, column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_name = 'customer_bank_verification_proofs'
      AND column_name = 'payment_qr_code';
  `);
  console.table(colDef);

  await prisma.$disconnect();
  console.log('\n✅ All database queries that previously crashed with "column does not exist" now execute with 100% SUCCESS!');
}

testBankQueries().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
