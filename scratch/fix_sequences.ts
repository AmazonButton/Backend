import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Synchronizing PostgreSQL serial sequences...');
  const tables = [
    { table: 'button_product', col: 'button_product_id' },
    { table: 'iot_button', col: 'button_id' },
    { table: 'orders', col: 'order_id' },
    { table: 'order_item', col: 'order_item_id' },
    { table: 'customer_address', col: 'address_id' },
    { table: 'store_staff', col: 'store_staff_id' },
    { table: 'pairing_tokens', col: 'id' },
    { table: 'provisioning_sessions', col: 'id' },
  ];

  for (const { table, col } of tables) {
    try {
      await prisma.$executeRawUnsafe(`
        SELECT setval(
          pg_get_serial_sequence('${table}', '${col}'),
          COALESCE((SELECT MAX(${col}) FROM "${table}"), 1) + 1,
          false
        );
      `);
      console.log(`✔ Synchronized sequence for ${table}.${col}`);
    } catch (err: any) {
      console.warn(`Could not sync ${table}.${col}:`, err.message);
    }
  }

  await prisma.$disconnect();
}

main().catch(console.error);
