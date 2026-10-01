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
}
