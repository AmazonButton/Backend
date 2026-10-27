import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function runPhase4IndexOptimizationSuite() {
  console.log('\n================================================================');
  console.log('🚀 SUITE 39: Phase 4 Database Index & Query Optimization');
  console.log('================================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, label: string) {
    if (condition) {
      console.log(`  ✔ [PASS] ${label}`);
      passed++;
    } else {
      console.error(`  ✖ [FAIL] ${label}`);
      failed++;
    }
  }

  try {
    // Query PostgreSQL catalog for existing indexes in public schema
    const pgIndexes = await prisma.$queryRaw<Array<{ tablename: string; indexname: string; indexdef: string }>>`
      SELECT tablename, indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
    `;

    const indexMap = new Map<string, string>();
    for (const idx of pgIndexes) {
      indexMap.set(idx.indexname, idx.tablename);
    }

    console.log(`Discovered ${pgIndexes.length} active indexes in PostgreSQL schema.`);

    // 1. Orders table composite indexes
    console.log('\n--- 1. Orders Table Composite Filtering Indexes ---');
    assert(indexMap.has('idx_orders_store_status_created'), 'Composite index idx_orders_store_status_created exists on orders');
    assert(indexMap.has('idx_orders_customer_status_created'), 'Composite index idx_orders_customer_status_created exists on orders');
    assert(indexMap.has('idx_orders_driver_status'), 'Composite index idx_orders_driver_status exists on orders');
    assert(indexMap.has('idx_orders_order_date'), 'Index idx_orders_order_date exists on orders');

    // 2. Payment Transaction indexes
    console.log('\n--- 2. Payment Transactions Filtering Indexes ---');
    assert(indexMap.has('idx_payment_tx_order_status'), 'Composite index idx_payment_tx_order_status exists on payment_transaction');
    assert(indexMap.has('idx_payment_tx_rental_status'), 'Composite index idx_payment_tx_rental_status exists on payment_transaction');
    assert(indexMap.has('idx_payment_tx_created_at'), 'Index idx_payment_tx_created_at exists on payment_transaction');

    // 3. Store Withdrawals composite index
    console.log('\n--- 3. Store Withdrawals Pagination & Filter Indexes ---');
    assert(indexMap.has('idx_store_withdrawals_store_status_created'), 'Composite index idx_store_withdrawals_store_status_created exists on store_withdrawals');

    // 4. Button Rentals composite indexes
    console.log('\n--- 4. Button Rentals Filtering Indexes ---');
    assert(indexMap.has('idx_button_rentals_customer_status'), 'Composite index idx_button_rentals_customer_status exists on button_rentals');
    assert(indexMap.has('idx_button_rentals_package_status'), 'Composite index idx_button_rentals_package_status exists on button_rentals');

    // 5. Products composite indexes
    console.log('\n--- 5. Products Catalog & Price Filtering Indexes ---');
    assert(indexMap.has('idx_product_store_status_price'), 'Composite index idx_product_store_status_price exists on product');
    assert(indexMap.has('idx_product_store_cat_status'), 'Composite index idx_product_store_cat_status exists on product');

    // 6. Driver Shifts composite indexes
    console.log('\n--- 6. Driver Shifts Monitoring Indexes ---');
    assert(indexMap.has('idx_driver_shifts_store_status_started'), 'Composite index idx_driver_shifts_store_status_started exists on driver_shifts');
    assert(indexMap.has('idx_driver_shifts_driver_status'), 'Composite index idx_driver_shifts_driver_status exists on driver_shifts');

    // 7. Verify query plan execution on Orders table
    console.log('\n--- 7. Query Plan Execution Invariance Check ---');
    const explainResult = await prisma.$queryRaw<Array<{ 'QUERY PLAN': string }>>`
      EXPLAIN SELECT order_id, store_id, order_status, created_at
      FROM orders
      WHERE store_id = 1 AND order_status = 'PENDING'
      ORDER BY created_at DESC
      LIMIT 10
    `;
    assert(explainResult && explainResult.length > 0, 'EXPLAIN query on orders executed successfully without syntax error');

  } finally {
    await prisma.$disconnect();
  }

  console.log('\n================================================================');
  console.log(`SUMMARY: ${passed} passed, ${failed} failed`);
  console.log('================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
  process.exit(0);
}

runPhase4IndexOptimizationSuite().catch((err) => {
  console.error('Fatal Suite 39 error:', err);
  process.exit(1);
});
