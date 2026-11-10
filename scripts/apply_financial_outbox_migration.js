const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function run() {
  console.log('--- Applying Migration: 20261111000000_financial_verification_and_outbox_hardening ---');

  const statements = [
    `CREATE TABLE IF NOT EXISTS store_bank_inbound_receipts (
      id BIGSERIAL PRIMARY KEY,
      verification_tx_id BIGINT REFERENCES bank_account_verification_transactions(id) ON DELETE SET NULL,
      provider_transaction_id VARCHAR(128) NOT NULL,
      amount DECIMAL(15, 2) NOT NULL,
      sender_account_number_encrypted TEXT,
      sender_account_hash VARCHAR(64),
      sender_bank_bin VARCHAR(10),
      match_status VARCHAR(32) NOT NULL DEFAULT 'MATCHED',
      received_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
    );`,
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_store_bank_receipt_provider_tx_id 
     ON store_bank_inbound_receipts(provider_transaction_id);`,
    `CREATE INDEX IF NOT EXISTS idx_store_bank_receipt_verification_tx_id 
     ON store_bank_inbound_receipts(verification_tx_id);`,

    `CREATE TABLE IF NOT EXISTS store_bank_refund_obligations (
      id BIGSERIAL PRIMARY KEY,
      receipt_id BIGINT NOT NULL REFERENCES store_bank_inbound_receipts(id) ON DELETE RESTRICT,
      refund_amount DECIMAL(15, 2) NOT NULL,
      refund_status VARCHAR(32) NOT NULL DEFAULT 'PENDING_REFUND',
      refund_reference VARCHAR(128) NOT NULL,
      provider_payout_id VARCHAR(128),
      target_bank_bin VARCHAR(10),
      target_account_encrypted TEXT,
      target_account_hash VARCHAR(64),
      lease_token VARCHAR(64),
      lease_expires_at TIMESTAMPTZ(6),
      next_reconcile_at TIMESTAMPTZ(6),
      attempt_count INT NOT NULL DEFAULT 0,
      failure_reason VARCHAR(255),
      refunded_at TIMESTAMPTZ(6),
      created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
    );`,
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_store_bank_refund_receipt_id 
     ON store_bank_refund_obligations(receipt_id);`,
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_store_bank_refund_reference 
     ON store_bank_refund_obligations(refund_reference);`,
    `CREATE INDEX IF NOT EXISTS idx_store_bank_refund_status 
     ON store_bank_refund_obligations(refund_status);`,
    `ALTER TABLE store_bank_refund_obligations 
     ADD COLUMN IF NOT EXISTS next_reconcile_at TIMESTAMPTZ(6);`,
    `CREATE INDEX IF NOT EXISTS idx_store_bank_refund_next_reconcile 
     ON store_bank_refund_obligations(next_reconcile_at) 
     WHERE refund_status = 'PENDING_RECONCILIATION';`,

    `ALTER TABLE customer_bank_refund_payout_attempts 
     ADD COLUMN IF NOT EXISTS next_reconcile_at TIMESTAMPTZ(6),
     ADD COLUMN IF NOT EXISTS reconcile_attempts INT NOT NULL DEFAULT 0;`,
    `CREATE INDEX IF NOT EXISTS idx_cust_bank_attempt_next_reconcile 
     ON customer_bank_refund_payout_attempts(next_reconcile_at) 
     WHERE status IN ('PREPARING', 'SUBMITTED', 'PENDING_RECONCILIATION');`,
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

  console.log('--- Migration successfully applied! ---');
  await prisma.$disconnect();
}

run().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
