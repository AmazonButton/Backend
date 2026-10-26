import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Decimal } from '@prisma/client/runtime/library';
import { CryptoVaultUtil } from '../common/utils/crypto-vault.util';

@Injectable()
export class StoreWalletRepository {
  constructor(private readonly prisma: PrismaService) {}

  async getOrCreateStoreWallet(storeId: bigint) {
    let wallet = await this.prisma.storeWallet.findUnique({
      where: { storeId },
    });

    if (!wallet) {
      wallet = await this.prisma.storeWallet.create({
        data: {
          storeId,
          balance: new Decimal(0),
          frozenBalance: new Decimal(0),
        },
      });
    }

    return wallet;
  }

  async findStoreWallet(storeId: bigint) {
    return this.prisma.storeWallet.findUnique({
      where: { storeId },
    });
  }

  async updateBankAccountAtomicTx(params: {
    storeId: bigint;
    bankName: string;
    bankAccountHolder: string;
    accountNumberHash: string;
    accountNumberEncrypted: string;
    cleanAcc?: string;
  }) {
    return this.prisma.$transaction(async (tx) => {
      // Lock store row with SELECT FOR UPDATE to serialize bank modifications for this store
      await tx.$queryRaw`
        SELECT store_id FROM store WHERE store_id = ${params.storeId} FOR UPDATE
      `;

      // Reset previous defaults
      await tx.storeBankAccount.updateMany({
        where: { storeId: params.storeId },
        data: { isDefault: false },
      });

      // Upsert new bank account record with isDefault: true
      await tx.storeBankAccount.upsert({
        where: {
          uq_store_bank_account_store_acc_hash: {
            storeId: params.storeId,
            accountNumberHash: params.accountNumberHash,
          },
        },
        create: {
          storeId: params.storeId,
          bankBin: '970422',
          bankName: params.bankName,
          accountNumberEncrypted: params.accountNumberEncrypted,
          accountNumberHash: params.accountNumberHash,
          accountName: params.bankAccountHolder,
          verificationStatus: 'PENDING',
          isDefault: true,
        },
        update: {
          bankName: params.bankName,
          accountName: params.bankAccountHolder,
          accountNumberEncrypted: params.accountNumberEncrypted,
          isDefault: true,
        },
      });

      // Update store wallet metadata
      return tx.storeWallet.update({
        where: { storeId: params.storeId },
        data: {
          bankName: params.bankName,
          bankAccountNumber: params.cleanAcc ? CryptoVaultUtil.maskAccountNumber(params.cleanAcc) : null,
          bankAccountHolder: params.bankAccountHolder,
          updatedAt: new Date(),
        },
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

  async finalizePayoutSuccessTx(withdrawalId: bigint) {
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

      if (!lockedWithdrawal || lockedWithdrawal.status === 'SUCCEEDED') return;

      const [lockedWallet] = await tx.$queryRaw<Array<{
        wallet_id: bigint;
        frozen_balance: any;
      }>>`
        SELECT wallet_id, frozen_balance
        FROM store_wallets
        WHERE wallet_id = ${lockedWithdrawal.wallet_id}
        FOR UPDATE
      `;

      if (lockedWallet) {
        const currentFrozen = Number(lockedWallet.frozen_balance || 0);
        const frozenAfter = Math.max(0, currentFrozen - Number(lockedWithdrawal.amount));

        await tx.storeWallet.update({
          where: { walletId: lockedWallet.wallet_id },
          data: { frozenBalance: new Decimal(frozenAfter) },
        });
      }

      await tx.storeWithdrawal.update({
        where: { withdrawalId },
        data: {
          status: 'SUCCEEDED',
          processedAt: new Date(),
        },
      });
    });
  }
}
