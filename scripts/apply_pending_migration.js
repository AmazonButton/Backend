const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function run() {
  console.log('--- Applying Missing Migration: 20261106213000_rental_billing_policy_snapshot ---');

  const statements = [
    // 1. AlterTable: Add payer_store_id column to billing_charges
    `ALTER TABLE "billing_charges" ADD COLUMN IF NOT EXISTS "payer_store_id" BIGINT;`,
    `ALTER TABLE "billing_charges" DROP CONSTRAINT IF EXISTS "fk_billing_charges_payer_store";`,
    `ALTER TABLE "billing_charges" ADD CONSTRAINT "fk_billing_charges_payer_store" FOREIGN KEY ("payer_store_id") REFERENCES "store"("store_id") ON DELETE RESTRICT;`,
    `CREATE INDEX IF NOT EXISTS "idx_billing_charges_payer_store" ON "billing_charges"("payer_store_id");`,

    // 2. AlterTable: Add billing_policy column with default to button_rentals
    `ALTER TABLE "button_rentals" ADD COLUMN IF NOT EXISTS "billing_policy" VARCHAR(50) NOT NULL DEFAULT 'STORE_RENT_CUSTOMER_DEPOSIT';`,
    `ALTER TABLE "button_rentals" DROP CONSTRAINT IF EXISTS "chk_button_rentals_billing_policy";`,
    `ALTER TABLE "button_rentals" ADD CONSTRAINT "chk_button_rentals_billing_policy" CHECK ("billing_policy" IN ('LEGACY_CUSTOMER_RENT', 'STORE_RENT_CUSTOMER_DEPOSIT'));`,
    `CREATE INDEX IF NOT EXISTS "idx_button_rentals_billing_policy" ON "button_rentals"("billing_policy");`,

    // 3. AlterTable: Add billing_policy_review_required column
    `ALTER TABLE "button_rentals" ADD COLUMN IF NOT EXISTS "billing_policy_review_required" BOOLEAN NOT NULL DEFAULT false;`,
    `CREATE INDEX IF NOT EXISTS "idx_button_rentals_policy_review" ON "button_rentals"("billing_policy_review_required");`,

    // 4. Trigger to guarantee immutability of billing_policy after insertion
    `CREATE OR REPLACE FUNCTION check_button_rental_policy_immutable()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.billing_policy IS NOT NULL AND NEW.billing_policy <> OLD.billing_policy THEN
        RAISE EXCEPTION 'CANNOT_MUTATE_RENTAL_BILLING_POLICY: billing_policy is an immutable contract snapshot';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;`,
    `DROP TRIGGER IF EXISTS trg_button_rental_policy_immutable ON "button_rentals";`,
    `CREATE TRIGGER trg_button_rental_policy_immutable
BEFORE UPDATE OF billing_policy ON "button_rentals"
FOR EACH ROW
EXECUTE FUNCTION check_button_rental_policy_immutable();`,
  ];

  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i];
    const preview = stmt.replace(/\s+/g, ' ').slice(0, 70);
    try {
      await prisma.$executeRawUnsafe(stmt);
      console.log(`[${i + 1}/${statements.length}] ✔ ${preview}...`);
    } catch (err) {
      console.error(`[${i + 1}/${statements.length}] ✖ ${preview}... ERROR:`, err.message);
      throw err;
    }
  }

  // Also check if _prisma_migrations table exists, and record the migration if needed
  try {
    const migrationName = '20261106213000_rental_billing_policy_snapshot';
    const existing = await prisma.$queryRawUnsafe(
      `SELECT id FROM "_prisma_migrations" WHERE migration_name = $1`,
      migrationName
    );
    if (!existing || existing.length === 0) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO "_prisma_migrations" (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
         VALUES (gen_random_uuid(), 'manual_cluster_migration_snapshot', NOW(), $1, NULL, NULL, NOW(), 1)`,
        migrationName
      );
      console.log(`✔ Recorded ${migrationName} in _prisma_migrations`);
    }
  } catch (mErr) {
    console.log('Note: _prisma_migrations tracking:', mErr.message);
  }

  console.log('\n✅ All DDL statements applied successfully!');
  await prisma.$disconnect();
}

run().catch((err) => {
  console.error('Fatal migration failure:', err);
  process.exit(1);
});
