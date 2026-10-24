-- Migration: Nullify plaintext bank account columns to ensure zero plaintext storage
-- All accounts are stored as encrypted (AES-256-GCM), hashed (SHA-256), and masked snapshots

-- 1. Nullify plaintext bank_account_number in store_withdrawals
UPDATE "store_withdrawals"
SET "bank_account_number" = NULL
WHERE "bank_account_number" IS NOT NULL;

-- 2. Nullify plaintext bank_account_number in store_wallets
UPDATE "store_wallets"
SET "bank_account_number" = NULL
WHERE "bank_account_number" IS NOT NULL;
