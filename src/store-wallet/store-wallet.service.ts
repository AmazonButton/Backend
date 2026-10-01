import { Injectable, NotFoundException, BadRequestException, Inject } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateBankAccountDto } from './dto/wallet.dto';

@Injectable()
export class StoreWalletService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async getOrCreateStoreWallet(storeId: string | number | bigint) {
    const rawStoreId = BigInt(storeId);
    let wallet = await this.prisma.storeWallet.findUnique({
      where: { storeId: rawStoreId },
    });

    if (!wallet) {
      wallet = await this.prisma.storeWallet.create({
        data: {
          storeId: rawStoreId,
          balance: 0,
          frozenBalance: 0,
        },
      });
    }

    return wallet;
  }

  async updateBankAccount(storeId: string | number | bigint, dto: UpdateBankAccountDto) {
    const rawStoreId = BigInt(storeId);
    await this.getOrCreateStoreWallet(rawStoreId);

    return this.prisma.storeWallet.update({
      where: { storeId: rawStoreId },
      data: {
        bankName: dto.bankName,
        bankAccountNumber: dto.bankAccountNumber,
        bankAccountHolder: dto.bankAccountHolder,
      },
    });
  }

  async creditOrderRevenue(
    storeId: string | number | bigint,
    amount: number | string,
    orderCode: string
  ) {
    const rawStoreId = BigInt(storeId);
    const creditAmount = Number(amount);
    if (creditAmount <= 0) return await this.getOrCreateStoreWallet(rawStoreId);

    const wallet = await this.getOrCreateStoreWallet(rawStoreId);

    return this.prisma.$transaction(async (tx) => {
      const currentWallet = await tx.storeWallet.findUnique({
        where: { walletId: wallet.walletId },
      });
      if (!currentWallet) throw new NotFoundException('Ví cửa hàng không tồn tại');

      const balanceBefore = Number(currentWallet.balance);
      const balanceAfter = balanceBefore + creditAmount;

      const updated = await tx.storeWallet.update({
        where: { walletId: wallet.walletId },
        data: { balance: balanceAfter },
      });

      await tx.walletTransaction.create({
        data: {
          walletId: wallet.walletId,
          amount: creditAmount,
          type: 'ORDER_REVENUE',
          balanceBefore,
          balanceAfter,
          referenceId: orderCode,
          description: `Doanh thu đơn hàng #${orderCode}`,
        },
      });

      return updated;
    });
  }

  async listTransactions(storeId: string | number | bigint) {
    const rawStoreId = BigInt(storeId);
    const wallet = await this.getOrCreateStoreWallet(rawStoreId);

    return this.prisma.walletTransaction.findMany({
      where: { walletId: wallet.walletId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async requestWithdrawal(storeId: string | number | bigint, dto: {
    amount: number;
    bankName: string;
    bankAccountNumber: string;
    bankAccountHolder: string;
  }) {
    const rawStoreId = BigInt(storeId);
    const amount = Number(dto.amount);
    if (!amount || amount < 50000) {
      throw new BadRequestException('Số tiền rút tối thiểu là 50,000 VND');
    }

    const wallet = await this.getOrCreateStoreWallet(rawStoreId);

    return this.prisma.$transaction(async (tx) => {
      const current = await tx.storeWallet.findUnique({
        where: { walletId: wallet.walletId },
      });
      if (!current) throw new NotFoundException('Ví không tồn tại');

      const currentBalance = Number(current.balance);
      if (currentBalance < amount) {
        throw new BadRequestException(
          `Số dư không đủ. Số dư khả dụng hiện tại: ${currentBalance.toLocaleString()} VND`
        );
      }

      const balanceAfter = currentBalance - amount;
      await tx.storeWallet.update({
        where: { walletId: wallet.walletId },
        data: { balance: balanceAfter },
      });

      const withdrawalCode = `WDR-${Date.now()}-${Math.floor(100 + Math.random() * 900)}`;

      const withdrawal = await tx.storeWithdrawal.create({
        data: {
          withdrawalCode,
          walletId: wallet.walletId,
          amount,
          bankName: dto.bankName,
          bankAccountNumber: dto.bankAccountNumber,
          bankAccountHolder: dto.bankAccountHolder,
          status: 'PENDING',
        },
      });

      await tx.walletTransaction.create({
        data: {
          walletId: wallet.walletId,
          amount: -amount,
          type: 'WITHDRAWAL',
          balanceBefore: currentBalance,
          balanceAfter,
          referenceId: withdrawalCode,
          description: `Yêu cầu rút tiền về ${dto.bankName} - ${dto.bankAccountNumber}`,
        },
      });

      return withdrawal;
    });
  }

  async listWithdrawals(storeId: string | number | bigint) {
    const rawStoreId = BigInt(storeId);
    const wallet = await this.getOrCreateStoreWallet(rawStoreId);

    return this.prisma.storeWithdrawal.findMany({
      where: { walletId: wallet.walletId },
      orderBy: { requestedAt: 'desc' },
    });
  }
}
