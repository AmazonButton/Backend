import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
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
      if (!currentWallet) throw new NotFoundException('Ví cửa hàng không tồn tại');

      // Idempotency guard: không cộng tiền trùng lặp cho cùng một đơn hàng
      const cleanRef = orderCode.replace(/^ORDER:/, '');
      const existingTx = await tx.walletTransaction.findFirst({
        where: {
          walletId: wallet.walletId,
          referenceId: { in: [orderCode, `ORDER:${cleanRef}`, cleanRef] },
          type: { in: ['ORDER_REVENUE', 'PAYMENT_CREDIT'] },
        },
      });
      if (existingTx) {
        return currentWallet;
      }

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
          description: `Doanh thu don h�ng #${orderCode}`,
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
   * Y�u c?u r�t ti?n Store (Section 15, 16, 17)
   * Phase 1: DB Transaction tr? s? du t?c th�, t?o Withdrawal PENDING, commit nhanh.
   * Phase 2: N?u c?u h�nh autoPayout ho?c dto.autoPayout = true, g?i PayOS Payout API sang PROCESSING.
   */
  async requestWithdrawal(
    storeId: string | number | bigint,
    dto: RequestWithdrawalDto & { autoPayout?: boolean },
    idempotencyKeyOrOptions?: string | { autoPayout?: boolean },
  ) {
    const rawStoreId = BigInt(storeId);
    const idempotencyKey = typeof idempotencyKeyOrOptions === 'string' ? idempotencyKeyOrOptions : undefined;
    const options = typeof idempotencyKeyOrOptions === 'object' ? idempotencyKeyOrOptions : undefined;
    const amount = Number(dto.amount);
    if (!amount || amount < 50000) {
      throw new BadRequestException('Số tiền rút tối thiểu là 50,000 VND');
    }

    // Check if idempotencyKey was already processed for this store
    if (idempotencyKey) {
      const existing = await this.prisma.storeWithdrawal.findFirst({
        where: { storeId: rawStoreId, idempotencyKey },
      });
      if (existing) {
        return existing;
      }
    }

    const wallet = await this.getOrCreateStoreWallet(rawStoreId);
    const fee = Number(dto.fee || 0);
    const netAmount = amount - fee;
    const withdrawalCode = `WDR-${Date.now()}-${Math.floor(100 + Math.random() * 900)}`;

    // Phase 1: DB Transaction - Lock balance with FOR UPDATE & snapshot bank info
    let withdrawal;
    try {
      withdrawal = await this.prisma.$transaction(async (tx) => {
        // Double check idempotency in tx
        if (idempotencyKey) {
          const existingInTx = await tx.storeWithdrawal.findFirst({
            where: { storeId: rawStoreId, idempotencyKey },
          });
          if (existingInTx) return existingInTx;
        }

        // Lock wallet row exclusively with SELECT ... FOR UPDATE (Anti-Race Condition)
        const [lockedWallet] = await tx.$queryRaw<Array<{
          wallet_id: bigint;
          balance: any;
          bank_name: string | null;
          bank_account_number: string | null;
          bank_account_holder: string | null;
        }>>`
          SELECT wallet_id, balance, bank_name, bank_account_number, bank_account_holder
          FROM store_wallets
          WHERE wallet_id = ${wallet.walletId}
          FOR UPDATE
        `;

        if (!lockedWallet) throw new NotFoundException('Ví không tồn tại');

        const currentBalance = Number(lockedWallet.balance);
        if (currentBalance < amount) {
          throw new BadRequestException(
            `Số dư không đủ. Số dư khả dụng hiện tại: ${currentBalance.toLocaleString()} VND`,
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
            storeId: rawStoreId,
            idempotencyKey: idempotencyKey || null,
            amount,
            fee,
            netAmount,
            bankCode: dto.bankCode || '970422',
            bankName: dto.bankName || lockedWallet.bank_name || 'MBBANK',
            bankAccountNumber: dto.bankAccountNumber || lockedWallet.bank_account_number || '970422123456789',
            bankAccountHolder: dto.bankAccountHolder || lockedWallet.bank_account_holder || 'STORE OWNER',
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
            description: `Yêu cầu rút tiền về ${dto.bankName || lockedWallet.bank_name || 'Ngân hàng'} - ${dto.bankAccountNumber || lockedWallet.bank_account_number || ''}`,
          },
        });

        return newWithdrawal;
      });
    } catch (err: any) {
      if (err?.code === 'P2002' && idempotencyKey) {
        const existing = await this.prisma.storeWithdrawal.findFirst({
          where: { storeId: rawStoreId, idempotencyKey },
        });
        if (existing) return existing;
      }
      throw err;
    }

    const shouldAutoPayout = dto.autoPayout ?? options?.autoPayout ?? false;
    if (shouldAutoPayout && this.payosPayoutService) {
      return this.triggerPayosPayout(withdrawal.withdrawalId);
    }

    return withdrawal;
  }

  /**
   * Gọi PayOS Payout API cho Withdrawal (Section 18, 21, 25)
   */
  async triggerPayosPayout(withdrawalId: string | number | bigint) {
    const rawId = BigInt(withdrawalId);
    const withdrawal = await this.prisma.storeWithdrawal.findUnique({
      where: { withdrawalId: rawId },
    });

    if (!withdrawal) {
      throw new NotFoundException('Kh�ng t�m th?y y�u c?u r�t ti?n');
    }

    if (withdrawal.status !== 'PENDING') {
      throw new BadRequestException(`Y�u c?u dang ? tr?ng th�i ${withdrawal.status}, kh�ng th? g?i Payout`);
    }

    if (!this.payosPayoutService) {
      throw new BadRequestException('D?ch v? PayOS Payout chua du?c k�ch ho?t trong h? th?ng');
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

      // DB Transaction 2: Auto-Refund s? du v? v� (Section 25)
      await this.refundFailedWithdrawal(rawId, err.message || 'PayOS Payout API Error');

      throw new BadRequestException(`T?o chi ti?n PayOS th?t b?i: ${err.message || 'L?i c?ng PayOS'}`);
    }
  }

  /**
   * Ho�n ti?n v� khi Payout th?t b?i (Section 25)
   */
  async refundFailedWithdrawal(withdrawalId: string | number | bigint, reason: string) {
    const rawId = BigInt(withdrawalId);
    return this.prisma.$transaction(async (tx) => {
      // 1. Lock withdrawal row exclusively with SELECT ... FOR UPDATE (Anti-Double Refund)
      const [lockedWithdrawal] = await tx.$queryRaw<Array<{
        withdrawal_id: bigint;
        status: string;
        amount: any;
        wallet_id: bigint;
        withdrawal_code: string;
      }>>`
        SELECT withdrawal_id, status, amount, wallet_id, withdrawal_code
        FROM store_withdrawals
        WHERE withdrawal_id = ${rawId}
        FOR UPDATE
      `;

      if (!lockedWithdrawal) throw new NotFoundException('Yêu cầu rút tiền không tồn tại');

      // 2. Only refund if status is PENDING or PROCESSING (Prevent double-refund if already FAILED/SUCCEEDED)
      if (!['PENDING', 'PROCESSING'].includes(lockedWithdrawal.status)) {
        return tx.storeWithdrawal.findUnique({
          where: { withdrawalId: rawId },
        });
      }

      // 3. Unique ledger check: verify WITHDRAWAL_REFUND has not already been created for this withdrawal code
      const existingRefundTx = await tx.walletTransaction.findFirst({
        where: {
          walletId: lockedWithdrawal.wallet_id,
          type: 'WITHDRAWAL_REFUND',
          referenceId: lockedWithdrawal.withdrawal_code,
        },
      });
      if (existingRefundTx) {
        return tx.storeWithdrawal.findUnique({
          where: { withdrawalId: rawId },
        });
      }

      // 4. Lock wallet row with FOR UPDATE
      const [lockedWallet] = await tx.$queryRaw<Array<{
        wallet_id: bigint;
        balance: any;
      }>>`
        SELECT wallet_id, balance
        FROM store_wallets
        WHERE wallet_id = ${lockedWithdrawal.wallet_id}
        FOR UPDATE
      `;

      if (!lockedWallet) throw new NotFoundException('Ví không tồn tại');

      const refundAmount = Number(lockedWithdrawal.amount);
      const balanceBefore = Number(lockedWallet.balance);
      const balanceAfter = balanceBefore + refundAmount;

      await tx.storeWallet.update({
        where: { walletId: lockedWithdrawal.wallet_id },
        data: { balance: balanceAfter },
      });

      await tx.walletTransaction.create({
        data: {
          walletId: lockedWithdrawal.wallet_id,
          amount: refundAmount,
          type: 'WITHDRAWAL_REFUND',
          balanceBefore,
          balanceAfter,
          referenceId: lockedWithdrawal.withdrawal_code,
          description: `Hoàn tiền yêu cầu rút #${lockedWithdrawal.withdrawal_code}: ${reason}`,
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
   * Ki?m tra & d?ng b? tr?ng th�i Payout t? PayOS (Section 22, 23, 24)
   */
  async syncWithdrawalPayoutStatus(
    withdrawalId: string | number | bigint,
    requestStoreId?: string | number | bigint,
  ) {
    const rawId = BigInt(withdrawalId);
    const withdrawal = await this.prisma.storeWithdrawal.findUnique({
      where: { withdrawalId: rawId },
      include: { wallet: true },
    });

    if (!withdrawal) {
      throw new NotFoundException('Kh�ng t�m th?y y�u c?u r�t ti?n');
    }

    if (requestStoreId && withdrawal.wallet.storeId !== BigInt(requestStoreId)) {
      throw new ForbiddenException({
        success: false,
        code: 'ACCESS_DENIED',
        message: 'B?n kh�ng c� quy?n thao t�c tr�n y�u c?u r�t ti?n c?a c?a h�ng kh�c.',
      });
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
      return this.refundFailedWithdrawal(rawId, 'PayOS Payout x�c nh?n th?t b?i');
    }

    // N?u v?n dang PROCESSING -> Gi? nguy�n tr?ng th�i, tuy?t d?i kh�ng refund (Section 24)
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
      throw new NotFoundException('Kh�ng t�m th?y th�ng tin r�t ti?n');
    }

    return withdrawal;
  }
}
