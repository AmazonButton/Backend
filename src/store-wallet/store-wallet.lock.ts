import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

export interface LockedStoreWalletRow {
  wallet_id: bigint;
  store_id: bigint;
  balance: any;
  frozen_balance: any;
  bank_name: string | null;
  bank_account_number: string | null;
  bank_account_holder: string | null;
}

/**
 * Ensures a store_wallets row exists for storeId without insert-race (ON CONFLICT DO NOTHING)
 * and acquires an exclusive FOR UPDATE lock within the active transaction.
 */
export async function ensureAndLockStoreWalletByStoreId(
  tx: Prisma.TransactionClient,
  storeId: bigint,
): Promise<LockedStoreWalletRow> {
  await tx.$executeRawUnsafe(
    `INSERT INTO store_wallets (store_id, balance, frozen_balance, created_at, updated_at)
     VALUES ($1, 0, 0, NOW(), NOW())
     ON CONFLICT (store_id) DO NOTHING`,
    storeId,
  );
  const rows = await tx.$queryRawUnsafe<LockedStoreWalletRow[]>(
    `SELECT wallet_id, store_id, balance, frozen_balance, bank_name, bank_account_number, bank_account_holder
     FROM store_wallets
     WHERE store_id = $1
     FOR UPDATE`,
    storeId,
  );
  if (!rows || rows.length === 0) {
    throw new NotFoundException('Ví cửa hàng không tồn tại');
  }
  return rows[0];
}

/**
 * Acquires an exclusive FOR UPDATE lock on store_wallets by walletId.
 */
export async function lockStoreWalletById(
  tx: Prisma.TransactionClient,
  walletId: bigint,
): Promise<LockedStoreWalletRow> {
  const rows = await tx.$queryRawUnsafe<LockedStoreWalletRow[]>(
    `SELECT wallet_id, store_id, balance, frozen_balance, bank_name, bank_account_number, bank_account_holder
     FROM store_wallets
     WHERE wallet_id = $1
     FOR UPDATE`,
    walletId,
  );
  if (!rows || rows.length === 0) {
    throw new NotFoundException('Ví không tồn tại');
  }
  return rows[0];
}
