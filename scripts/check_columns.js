require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function check() {
  const cols = await prisma.$queryRawUnsafe(`
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_name = 'customer_bank_verification_proofs'
    ORDER BY ordinal_position;
  `);
  console.log('Columns in customer_bank_verification_proofs:');
  console.table(cols);
}

check().catch(console.error).finally(() => prisma.$disconnect());
