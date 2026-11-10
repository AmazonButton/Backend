const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function run() {
  try {
    const cols = await prisma.$queryRawUnsafe(
      "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'button_rentals' ORDER BY ordinal_position"
    );
    console.log('--- COLUMNS IN button_rentals ---');
    console.log(cols.map((c) => c.column_name).join(', '));

    const billingChargesCols = await prisma.$queryRawUnsafe(
      "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'billing_charges' ORDER BY ordinal_position"
    );
    console.log('--- COLUMNS IN billing_charges ---');
    console.log(billingChargesCols.map((c) => c.column_name).join(', '));
  } catch (err) {
    console.error('Error querying schema:', err);
  } finally {
    await prisma.$disconnect();
  }
}

run();
