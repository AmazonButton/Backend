import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function migrate() {
  console.log('--- EXECUTING MARKETPLACE & WALLET TABLES MIGRATION ---');

  const ddlStatements = [
    // 1. Subscription Plans
    `CREATE TABLE IF NOT EXISTS public.subscription_plans (
      plan_id BIGSERIAL PRIMARY KEY,
      plan_code VARCHAR(50) UNIQUE NOT NULL,
      plan_name VARCHAR(150) NOT NULL,
      description TEXT,
      price DECIMAL(15, 2) NOT NULL,
      duration_days INT NOT NULL,
      max_products INT NOT NULL DEFAULT 50,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );`,

    // 2. Store Subscriptions
    `CREATE TABLE IF NOT EXISTS public.store_subscriptions (
      subscription_id BIGSERIAL PRIMARY KEY,
      store_id BIGINT NOT NULL REFERENCES public.store(store_id) ON DELETE RESTRICT,
      plan_id BIGINT NOT NULL REFERENCES public.subscription_plans(plan_id) ON DELETE RESTRICT,
      start_date TIMESTAMPTZ NOT NULL,
      end_date TIMESTAMPTZ NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
      payment_method VARCHAR(20) NOT NULL DEFAULT 'PAYOS',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );`,
    `CREATE INDEX IF NOT EXISTS idx_store_subscriptions_store_id ON public.store_subscriptions(store_id);`,

    // 3. Rental Packages
    `CREATE TABLE IF NOT EXISTS public.rental_packages (
      package_id BIGSERIAL PRIMARY KEY,
      package_code VARCHAR(50) UNIQUE NOT NULL,
      package_name VARCHAR(150) NOT NULL,
      description TEXT,
      button_quantity INT NOT NULL DEFAULT 1,
      monthly_price DECIMAL(15, 2) NOT NULL,
      deposit_fee DECIMAL(15, 2) NOT NULL DEFAULT 0,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );`,

    // 4. Button Rentals
    `CREATE TABLE IF NOT EXISTS public.button_rentals (
      rental_id BIGSERIAL PRIMARY KEY,
      rental_code VARCHAR(50) UNIQUE NOT NULL,
      customer_id BIGINT NOT NULL REFERENCES public.customer_profile(customer_id) ON DELETE RESTRICT,
      package_id BIGINT NOT NULL REFERENCES public.rental_packages(package_id) ON DELETE RESTRICT,
      months_rented INT NOT NULL DEFAULT 1,
      total_rent_amount DECIMAL(15, 2) NOT NULL,
      deposit_amount DECIMAL(15, 2) NOT NULL DEFAULT 0,
      start_date TIMESTAMPTZ NOT NULL,
      end_date TIMESTAMPTZ NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'PENDING_PAYMENT',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );`,
    `CREATE INDEX IF NOT EXISTS idx_button_rentals_customer_id ON public.button_rentals(customer_id);`,
    `ALTER TABLE public.iot_button ADD COLUMN IF NOT EXISTS rental_id BIGINT REFERENCES public.button_rentals(rental_id) ON DELETE SET NULL;`,
    `CREATE INDEX IF NOT EXISTS idx_iot_button_rental_id ON public.iot_button(rental_id);`,

    // 5. Store Wallets
    `CREATE TABLE IF NOT EXISTS public.store_wallets (
      wallet_id BIGSERIAL PRIMARY KEY,
      store_id BIGINT UNIQUE NOT NULL REFERENCES public.store(store_id) ON DELETE CASCADE,
      balance DECIMAL(15, 2) NOT NULL DEFAULT 0,
      frozen_balance DECIMAL(15, 2) NOT NULL DEFAULT 0,
      bank_name VARCHAR(100),
      bank_account_number VARCHAR(50),
      bank_account_holder VARCHAR(150),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );`,

    // 6. Wallet Transactions
    `CREATE TABLE IF NOT EXISTS public.wallet_transactions (
      transaction_id BIGSERIAL PRIMARY KEY,
      wallet_id BIGINT NOT NULL REFERENCES public.store_wallets(wallet_id) ON DELETE CASCADE,
      amount DECIMAL(15, 2) NOT NULL,
      type VARCHAR(30) NOT NULL,
      balance_before DECIMAL(15, 2) NOT NULL,
      balance_after DECIMAL(15, 2) NOT NULL,
      reference_id VARCHAR(100),
      description TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );`,
    `CREATE INDEX IF NOT EXISTS idx_wallet_transactions_wallet_id ON public.wallet_transactions(wallet_id);`,

    // 7. Store Withdrawals
    `CREATE TABLE IF NOT EXISTS public.store_withdrawals (
      withdrawal_id BIGSERIAL PRIMARY KEY,
      withdrawal_code VARCHAR(50) UNIQUE NOT NULL,
      wallet_id BIGINT NOT NULL REFERENCES public.store_wallets(wallet_id) ON DELETE CASCADE,
      amount DECIMAL(15, 2) NOT NULL,
      bank_name VARCHAR(100) NOT NULL,
      bank_account_number VARCHAR(50) NOT NULL,
      bank_account_holder VARCHAR(150) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
      approved_by_user_id BIGINT REFERENCES public.users(user_id) ON DELETE SET NULL,
      rejection_reason TEXT,
      transfer_evidence_url TEXT,
      requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      processed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );`,
    `CREATE INDEX IF NOT EXISTS idx_store_withdrawals_wallet_id ON public.store_withdrawals(wallet_id);`,

    // Restore Category Policy if not exists
    `DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE tablename = 'category' AND policyname = 'Public read categories'
      ) THEN
        CREATE POLICY "Public read categories" ON public.category FOR SELECT USING (status = 'ACTIVE');
      END IF;
    END
    $$;`
  ];

  for (const sql of ddlStatements) {
    await prisma.$executeRawUnsafe(sql);
  }

  console.log('✅ ALL 7 MARKETPLACE TABLES AND CONSTRAINTS CREATED IN POSTGRESQL SUCCESSFULLY!');
  await prisma.$disconnect();
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
