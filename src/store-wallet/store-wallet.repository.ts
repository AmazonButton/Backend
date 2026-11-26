import { Injectable, ConflictException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { CryptoVaultUtil } from '../common/utils/crypto-vault.util';
import { runWithTransactionRetry } from '../common/utils/transaction-retry.util';
import { lockStoreWalletById } from './store-wallet.lock';

@Injectable()
export class StoreWalletRepository {
  constructor(private readonly prisma: PrismaService) {}

  async getOrCreateStoreWallet(storeId: bigint) {
    let wallet = await this.prisma.storeWallet.findUnique({
      where: { storeId },
    });

    if (!wallet) {
      await this.prisma.$executeRawUnsafe(
        `INSERT INTO store_wallets (store_id, balance, frozen_balance, created_at, updated_at)
         VALUES ($1, 0, 0, NOW(), NOW())
         ON CONFLICT (store_id) DO NOTHING`,
        storeId,
      );
      wallet = await this.prisma.storeWallet.findUnique({
        where: { storeId },
      });
    }

    return wallet!;
  }

  async findStoreWallet(storeId: bigint) {
    return this.prisma.storeWallet.findUnique({
      where: { storeId },
    });
  }

  async findDefaultBankAccount(storeId: bigint) {
    return this.prisma.storeBankAccount.findFirst({ where: { storeId, isDefault: true } });
  }

  async updateBankAccountAtomicTx(params: {
    storeId: bigint;
    bankBin: string;
    bankName: string;
    bankAccountHolder: string;
    accountNumberHash: string;
    accountNumberEncrypted: string;
    cleanAcc?: string;
  }) {
    return runWithTransactionRetry(async () => {
      return this.prisma.$transaction(async (tx) => {
      // Lock store row with SELECT FOR UPDATE to serialize bank modifications for this store
      await tx.$queryRaw`
        SELECT store_id FROM store WHERE store_id = ${params.storeId} FOR UPDATE
      `;

      const existingAccount = await tx.storeBankAccount.findUnique({
        where: { uq_store_bank_account_store_acc_hash: {
          storeId: params.storeId, accountNumberHash: params.accountNumberHash,
        } },
      });
      const changedBankOrHolder =
        existingAccount &&
        (existingAccount.bankBin !== params.bankBin ||
          (existingAccount.accountName || '').trim().toUpperCase() !==
            params.bankAccountHolder.trim().toUpperCase());

      const existingVerifiedDefault = await tx.storeBankAccount.findFirst({
        where: {
          storeId: params.storeId,
          isDefault: true,
          verificationStatus: 'OWNERSHIP_VERIFIED',
        },
      });
      const willStayVerified =
        existingAccount?.verificationStatus === 'OWNERSHIP_VERIFIED' && !changedBankOrHolder;
      const shouldMakeDefault =
        willStayVerified ||
        !existingVerifiedDefault ||
        existingVerifiedDefault.accountNumberHash === params.accountNumberHash;

      // Only demote existing defaults if this submission will become the active default
      if (shouldMakeDefault) {
        await tx.storeBankAccount.updateMany({
          where: { storeId: params.storeId },
          data: { isDefault: false },
        });
      }

      // Upsert the selected bank; a bank or holder change requires fresh ownership verification.
      const savedAccount = await tx.storeBankAccount.upsert({
        where: {
          uq_store_bank_account_store_acc_hash: {
            storeId: params.storeId,
            accountNumberHash: params.accountNumberHash,
          },
        },
        create: {
          storeId: params.storeId,
          bankBin: params.bankBin,
          bankName: params.bankName,
          accountNumberEncrypted: params.accountNumberEncrypted,
          accountNumberHash: params.accountNumberHash,
          accountName: params.bankAccountHolder,
          verificationStatus: 'PENDING',
          isDefault: shouldMakeDefault,
        },
        update: {
          bankBin: params.bankBin,
          ...(changedBankOrHolder ? { verificationStatus: 'PENDING', verifiedAt: null, lastVerifiedAt: null } : {}),
          bankName: params.bankName,
          accountName: params.bankAccountHolder,
          accountNumberEncrypted: params.accountNumberEncrypted,
          ...(shouldMakeDefault ? { isDefault: true } : {}),
        },
      });

      // Update store wallet metadata only when this account is the active default
      const wallet = shouldMakeDefault
        ? await tx.storeWallet.update({
            where: { storeId: params.storeId },
            data: {
              bankName: params.bankName,
              bankAccountNumber: params.cleanAcc ? CryptoVaultUtil.maskAccountNumber(params.cleanAcc) : null,
              bankAccountHolder: params.bankAccountHolder,
              updatedAt: new Date(),
            },
          })
        : await tx.storeWallet.findUniqueOrThrow({ where: { storeId: params.storeId } });
      return { ...wallet, defaultBankAccount: savedAccount };
    });
    });
  }

  async findVerifiedBankAccount(storeId: bigint) {
    return this.prisma.storeBankAccount.findFirst({
      where: {
        storeId,
        verificationStatus: 'OWNERSHIP_VERIFIED',
      },
      orderBy: [{ isDefault: 'desc' }, { lastVerifiedAt: 'desc' }],
    });
  }

  async findWithdrawalById(withdrawalId: bigint) {
    return this.prisma.storeWithdrawal.findUnique({
      where: { withdrawalId },
      include: { wallet: true },
    });
  }

  async findWithdrawalByCodeOrRef(referenceId: string) {
    return this.prisma.storeWithdrawal.findFirst({
      where: {
        OR: [
          { providerReferenceId: referenceId },
          { withdrawalCode: referenceId },
        ],
      },
      include: { wallet: true },
    });
  }

  async finalizePayoutSuccessTx(withdrawalId: bigint, providerPayoutId?: string) {
    return runWithTransactionRetry(async () => {
      return this.prisma.$transaction(async (tx) => {
      const [lockedWithdrawal] = await tx.$queryRaw<Array<{
        withdrawal_id: bigint;
        status: string;
        amount: any;
        wallet_id: bigint;
      }>>`
        SELECT withdrawal_id, status, amount, wallet_id
        FROM store_withdrawals
        WHERE withdrawal_id = ${withdrawalId}
        FOR UPDATE
      `;

      if (!lockedWithdrawal) return;
      if (lockedWithdrawal.status === 'SUCCEEDED') return;

      // CRITICAL TERMINAL GUARD: Never allow FAILED/refunded withdrawal to be marked SUCCEEDED
      if (lockedWithdrawal.status === 'FAILED' || lockedWithdrawal.status === 'FAILED_CONFIRMED') {
        throw new ConflictException(
          `CRITICAL_PAYOUT_CONFLICT: Cannot finalize payout #${lockedWithdrawal.withdrawal_id} as SUCCEEDED because it was already refunded as ${lockedWithdrawal.status}. Reconciliation required.`,
        );
      }

      const lockedWallet = await lockStoreWalletById(tx, lockedWithdrawal.wallet_id);

      const payoutAmount = new Prisma.Decimal(lockedWithdrawal.amount);
      const currentFrozen = new Prisma.Decimal(lockedWallet.frozen_balance || 0);
      if (currentFrozen.lt(payoutAmount)) {
        throw new ConflictException(
          `ACCOUNTING_INCONSISTENCY: Wallet #${lockedWallet.wallet_id} frozenBalance (${currentFrozen.toString()}) is less than payout amount (${payoutAmount.toString()})`,
        );
      }
      const frozenAfter = currentFrozen.minus(payoutAmount);

      await tx.storeWallet.update({
        where: { walletId: lockedWallet.wallet_id },
        data: { frozenBalance: frozenAfter },
      });

      await tx.storeWithdrawal.update({
        where: { withdrawalId },
        data: {
          status: 'SUCCEEDED',
          providerPayoutId: providerPayoutId || undefined,
          processedAt: new Date(),
        },
      });
    });
    });
  }
}
