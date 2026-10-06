import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Inject,
  Optional,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateBankAccountDto } from './dto/wallet.dto';
import { RequestWithdrawalDto } from './dto/withdrawal.dto';
import { PayOSPayoutService } from '../payments/payos-payout.service';

@Injectable()
export class StoreWalletService {
  private readonly logger = new Logger(StoreWalletService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Optional() @Inject(PayOSPayoutService) private readonly payosPayoutService?: PayOSPayoutService,
  ) {}

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
    orderCode: string,
  ) {
    const rawStoreId = BigInt(storeId);
    const creditAmount = Number(amount);
    if (creditAmount <= 0) return await this.getOrCreateStoreWallet(rawStoreId);

    const wallet = await this.getOrCreateStoreWallet(rawStoreId);

    return this.prisma.$transaction(async (tx) => {
      const currentWallet = await tx.storeWallet.findUnique({
        where: { walletId: wallet.walletId },
      });
      if (!currentWallet) throw new NotFoundException('Ví c?a hàng không t?n t?i');

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
          description: `Doanh thu don hàng #${orderCode}`,
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

  /**
   * Yêu c?u rút ti?n Store (Section 15, 16, 17)
   * Phase 1: DB Transaction tr? s? du t?c thì, t?o Withdrawal PENDING, commit nhanh.
   * Phase 2: N?u c?u hình autoPayout ho?c dto.autoPayout = true, g?i PayOS Payout API sang PROCESSING.
   */
  async requestWithdrawal(
    storeId: string | number | bigint,
    dto: RequestWithdrawalDto & { autoPayout?: boolean },
    options?: { autoPayout?: boolean },
  ) {
    const rawStoreId = BigInt(storeId);
    const amount = Number(dto.amount);
    if (!amount || amount < 50000) {
      throw new BadRequestException('S? ti?n rút t?i thi?u là 50,000 VND');
    }

    const wallet = await this.getOrCreateStoreWallet(rawStoreId);
    const fee = Number(dto.fee || 0);
    const netAmount = amount - fee;
    const withdrawalCode = `WDR-${Date.now()}-${Math.floor(100 + Math.random() * 900)}`;

    // Phase 1: DB Transaction - Reserve balance & Snapshot bank info
    const withdrawal = await this.prisma.$transaction(async (tx) => {
      const current = await tx.storeWallet.findUnique({
        where: { walletId: wallet.walletId },
      });
      if (!current) throw new NotFoundException('Ví không t?n t?i');

      const currentBalance = Number(current.balance);
      if (currentBalance < amount) {
        throw new BadRequestException(
          `S? du không d?. S? du kh? d?ng hi?n t?i: ${currentBalance.toLocaleString()} VND`,
        );
      }

      const balanceAfter = currentBalance - amount;
      await tx.storeWallet.update({
        where: { walletId: wallet.walletId },
        data: { balance: balanceAfter },
      });

      const newWithdrawal = await tx.storeWithdrawal.create({
        data: {
          withdrawalCode,
          walletId: wallet.walletId,
          amount,
          fee,
          netAmount,
          bankCode: dto.bankCode || '970422', // default MBBank BIN n?u chua truy?n
          bankName: dto.bankName,
          bankAccountNumber: dto.bankAccountNumber,
          bankAccountHolder: dto.bankAccountHolder,
          status: 'PENDING',
          provider: 'PAYOS',
          providerReferenceId: withdrawalCode,
        },
      });

      await tx.walletTransaction.create({
        data: {
          walletId: wallet.walletId,
          amount: -amount,
          type: 'WITHDRAWAL_DEBIT',
          balanceBefore: currentBalance,
          balanceAfter,
          referenceId: withdrawalCode,
          description: `Yêu c?u rút ti?n v? ${dto.bankName} - ${dto.bankAccountNumber}`,
        },
      });

      return newWithdrawal;
    });

    const shouldAutoPayout = dto.autoPayout ?? options?.autoPayout ?? false;
    if (shouldAutoPayout && this.payosPayoutService) {
      return this.triggerPayosPayout(withdrawal.withdrawalId);
    }

    return withdrawal;
  }

  /**
   * G?i PayOS Payout API cho Withdrawal (Section 18, 21, 25)
   */
  async triggerPayosPayout(withdrawalId: string | number | bigint) {
    const rawId = BigInt(withdrawalId);
    const withdrawal = await this.prisma.storeWithdrawal.findUnique({
      where: { withdrawalId: rawId },
    });

    if (!withdrawal) {
      throw new NotFoundException('Không tìm th?y yêu c?u rút ti?n');
    }

    if (withdrawal.status !== 'PENDING') {
      throw new BadRequestException(`Yêu c?u dang ? tr?ng thái ${withdrawal.status}, không th? g?i Payout`);
    }

    if (!this.payosPayoutService) {
      throw new BadRequestException('D?ch v? PayOS Payout chua du?c kích ho?t trong h? th?ng');
    }

    try {
      const payoutResult = await this.payosPayoutService.createPayout({
        referenceId: withdrawal.withdrawalCode,
        amount: Number(withdrawal.netAmount || withdrawal.amount),
        description: `Rut tien ${withdrawal.withdrawalCode}`.slice(0, 25),
        toBin: withdrawal.bankCode || '970422',
        toAccountNumber: withdrawal.bankAccountNumber,
        category: ['withdrawal'],
      });

      const providerPayoutId = payoutResult.data?.id || `payout_${withdrawal.withdrawalCode}`;

      return await this.prisma.storeWithdrawal.update({
        where: { withdrawalId: rawId },
        data: {
          status: 'PROCESSING',
          providerPayoutId,
        },
      });
    } catch (err: any) {
      this.logger.error(`PayOS Payout failed for withdrawal #${withdrawal.withdrawalCode}: ${err.message}`);

      // Ghi nh?n FAILED
      await this.prisma.storeWithdrawal.update({
        where: { withdrawalId: rawId },
        data: {
          status: 'FAILED',
          failureReason: err.message || 'L?i g?i c?ng PayOS Payout',
          processedAt: new Date(),
        },
      });

      // DB Transaction 2: Auto-Refund s? du v? ví (Section 25)
      await this.refundFailedWithdrawal(rawId, err.message || 'PayOS Payout API Error');

      throw new BadRequestException(`T?o chi ti?n PayOS th?t b?i: ${err.message || 'L?i c?ng PayOS'}`);
    }
  }

  /**
   * Hoàn ti?n ví khi Payout th?t b?i (Section 25)
   */
  async refundFailedWithdrawal(withdrawalId: string | number | bigint, reason: string) {
    const rawId = BigInt(withdrawalId);
    return this.prisma.$transaction(async (tx) => {
      const withdrawal = await tx.storeWithdrawal.findUnique({
        where: { withdrawalId: rawId },
      });
      if (!withdrawal) throw new NotFoundException('Yêu c?u rút ti?n không t?n t?i');

      const wallet = await tx.storeWallet.findUnique({
        where: { walletId: withdrawal.walletId },
      });
      if (!wallet) throw new NotFoundException('Ví không t?n t?i');

      const refundAmount = Number(withdrawal.amount);
      const balanceBefore = Number(wallet.balance);
      const balanceAfter = balanceBefore + refundAmount;

      await tx.storeWallet.update({
        where: { walletId: wallet.walletId },
        data: { balance: balanceAfter },
      });

      await tx.walletTransaction.create({
        data: {
          walletId: wallet.walletId,
          amount: refundAmount,
          type: 'WITHDRAWAL_REFUND',
          balanceBefore,
          balanceAfter,
          referenceId: withdrawal.withdrawalCode,
          description: `Hoàn ti?n yêu c?u rút #${withdrawal.withdrawalCode}: ${reason}`,
        },
      });

      return tx.storeWithdrawal.update({
        where: { withdrawalId: rawId },
        data: {
          status: 'FAILED',
          failureReason: reason,
          processedAt: new Date(),
        },
      });
    });
  }

  /**
   * Ki?m tra & d?ng b? tr?ng thái Payout t? PayOS (Section 22, 23, 24)
   */
  async syncWithdrawalPayoutStatus(withdrawalId: string | number | bigint) {
    const rawId = BigInt(withdrawalId);
    const withdrawal = await this.prisma.storeWithdrawal.findUnique({
      where: { withdrawalId: rawId },
    });

    if (!withdrawal) {
      throw new NotFoundException('Không tìm th?y yêu c?u rút ti?n');
    }

    if (withdrawal.status !== 'PROCESSING') {
      return withdrawal;
    }

    if (!this.payosPayoutService) {
      return withdrawal;
    }

    const payoutInfo = await this.payosPayoutService.getPayout(
      withdrawal.providerPayoutId || withdrawal.withdrawalCode,
    );

    const approvalState = payoutInfo?.data?.approvalState;
    const txState = payoutInfo?.data?.transactions?.[0]?.state;

    if (approvalState === 'SUCCEEDED' || txState === 'SUCCEEDED' || approvalState === 'COMPLETED') {
      return this.prisma.storeWithdrawal.update({
        where: { withdrawalId: rawId },
        data: {
          status: 'SUCCEEDED',
          processedAt: new Date(),
        },
      });
    }

    if (approvalState === 'FAILED' || txState === 'FAILED' || approvalState === 'REJECTED') {
      return this.refundFailedWithdrawal(rawId, 'PayOS Payout xác nh?n th?t b?i');
    }

    // N?u v?n dang PROCESSING -> Gi? nguyên tr?ng thái, tuy?t d?i không refund (Section 24)
    return withdrawal;
  }

  async listWithdrawals(storeId: string | number | bigint) {
    const rawStoreId = BigInt(storeId);
    const wallet = await this.getOrCreateStoreWallet(rawStoreId);

    return this.prisma.storeWithdrawal.findMany({
      where: { walletId: wallet.walletId },
      orderBy: { requestedAt: 'desc' },
    });
  }

  async getWithdrawal(withdrawalId: string | number | bigint) {
    const rawId = BigInt(withdrawalId);
    const withdrawal = await this.prisma.storeWithdrawal.findUnique({
      where: { withdrawalId: rawId },
      include: { wallet: true },
    });

    if (!withdrawal) {
      throw new NotFoundException('Không tìm th?y thông tin rút ti?n');
    }

    return withdrawal;
  }
}
