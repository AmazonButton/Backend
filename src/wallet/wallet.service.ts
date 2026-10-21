import { BadRequestException, Injectable, NotFoundException, ServiceUnavailableException, Inject } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { PayOS } from '@payos/node';
import { PrismaService } from '../prisma/prisma.service';

type BankAccountDto = { bankName: string; bankBin: string; accountNumber: string; accountHolderName: string };
type WithdrawalDto = { amount: number; bankName?: string; bankBin?: string; accountNumber?: string; accountHolderName?: string; note?: string };

@Injectable()
export class WalletService {
  private payOS: PayOS | null = null;

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  private getPayOS() {
    if (!this.payOS) {
      const clientId = process.env.PAYOS_PAYOUT_CLIENT_ID || process.env.PAYOS_CLIENT_ID;
      const apiKey = process.env.PAYOS_PAYOUT_API_KEY || process.env.PAYOS_API_KEY;
      const checksumKey = process.env.PAYOS_PAYOUT_CHECKSUM_KEY || process.env.PAYOS_CHECKSUM_KEY;
      if (!clientId || !apiKey || !checksumKey) {
        throw new ServiceUnavailableException('PayOS Payout chưa được cấu hình');
      }
      this.payOS = new PayOS({ clientId, apiKey, checksumKey });
    }
    return this.payOS;
  }

  private async wallet(storeId: string) {
    return this.prisma.storeWallet.upsert({ where: { storeId }, create: { storeId }, update: {} });
  }

  async getWallet(storeId: string) {
    const wallet = await this.wallet(storeId);
    let payosPayoutBalance: number | null = null;
    let payosPayoutConnected = false;
    try {
      const payoutAccount = await this.getPayOS().payoutsAccount.balance();
      payosPayoutBalance = Number(payoutAccount.balance);
      payosPayoutConnected = true;
    } catch {
      // Keep the store ledger visible while reporting the provider balance as unavailable.
    }
    return {
      id: wallet.id,
      storeId,
      balance: wallet.balance,
      availableBalance: wallet.balance,
      pendingBalance: wallet.pendingBalance,
      bankAccount: wallet.bankName && wallet.bankBin && wallet.accountNumber && wallet.accountHolderName
        ? { bankName: wallet.bankName, bankBin: wallet.bankBin, accountNumber: wallet.accountNumber, accountHolderName: wallet.accountHolderName }
        : undefined,
      payosPayoutBalance,
      payosPayoutConnected,
      updatedAt: wallet.updatedAt,
    };
  }

  async updateBankAccount(storeId: string, data: BankAccountDto) {
    if (!data.bankName?.trim() || !/^\d{6}$/.test(data.bankBin || '') || !data.accountNumber?.trim() || !data.accountHolderName?.trim()) {
      throw new BadRequestException('Vui lòng nhập ngân hàng, mã BIN 6 số, số tài khoản và tên chủ tài khoản');
    }
    return this.prisma.storeWallet.upsert({
      where: { storeId },
      create: { storeId, bankName: data.bankName.trim(), bankBin: data.bankBin, accountNumber: data.accountNumber.trim(), accountHolderName: data.accountHolderName.trim() },
      update: { bankName: data.bankName.trim(), bankBin: data.bankBin, accountNumber: data.accountNumber.trim(), accountHolderName: data.accountHolderName.trim() },
    });
  }

  async getTransactions(storeId: string) {
    const wallet = await this.wallet(storeId);
    return this.prisma.storeWalletTransaction.findMany({ where: { walletId: wallet.id }, orderBy: { createdAt: 'desc' }, take: 100 });
  }

  async getWithdrawals(storeId: string) {
    const wallet = await this.wallet(storeId);
    return this.prisma.storeWalletWithdrawal.findMany({ where: { walletId: wallet.id }, orderBy: { createdAt: 'desc' }, take: 100 });
  }

  async requestWithdrawal(storeId: string, data: WithdrawalDto, idempotencyKey?: string) {
    const amount = Math.round(Number(data.amount));
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw new BadRequestException('Số tiền rút phải là số nguyên lớn hơn 0 ₫');
    }

    const wallet = await this.wallet(storeId);

    // 1. Validate Store Wallet Balance FIRST before any network calls
    if (wallet.balance < amount) {
      throw new BadRequestException(
        `Số dư ví cửa hàng (${wallet.balance.toLocaleString('vi-VN')} ₫) không đủ để rút ${amount.toLocaleString('vi-VN')} ₫`
      );
    }

    const bankName = data.bankName || wallet.bankName;
    const bankBin = data.bankBin || wallet.bankBin;
    const accountNumber = data.accountNumber || wallet.accountNumber;
    const accountHolderName = data.accountHolderName || wallet.accountHolderName;
    if (!bankName || !bankBin || !accountNumber || !accountHolderName) {
      throw new BadRequestException('Hãy lưu thông tin tài khoản ngân hàng trước khi rút tiền');
    }

    const safeKey = idempotencyKey?.slice(0, 100) || `store-withdrawal-${randomUUID()}`;
    const referenceId = `store_${createHash('sha256').update(`${storeId}:${safeKey}`).digest('hex').slice(0, 24)}`;
    const previous = await this.prisma.storeWalletWithdrawal.findUnique({ where: { referenceId } });
    if (previous) return previous;

    const payOS = this.getPayOS();

    // 2. Safely verify PayOS Payout liquidity with human-friendly error messages
    let payoutAccountBalance: number | null = null;
    try {
      const payoutAccount = await payOS.payoutsAccount.balance();
      payoutAccountBalance = Number(payoutAccount.balance);
    } catch (error: any) {
      const errorMsg = error?.desc || error?.message || '';
      if (error?.status === 403 || error?.code === '403') {
        throw new BadRequestException(
          `Cổng PayOS từ chối lệnh chi: Địa chỉ IP máy chủ của bạn chưa được cấp quyền (Whitelist IP) trên PayOS Merchant Dashboard. Chi tiết: ${errorMsg}`
        );
      }
      if (error?.status === 401 || error?.code === '401') {
        throw new BadRequestException('Thông tin xác thực PayOS Payout (Client ID / API Key) không hợp lệ');
      }
      // If balance check fails for another reason, log and proceed with cautious reserve
    }

    if (payoutAccountBalance !== null && payoutAccountBalance < amount) {
      throw new BadRequestException(
        `Số dư tài khoản chi PayOS dùng chung (${payoutAccountBalance.toLocaleString('vi-VN')} ₫) không đủ để thực hiện lệnh rút`
      );
    }

    const withdrawalId = randomUUID();
    const withdrawal = await this.prisma.$transaction(async (tx) => {
      const reserved = await tx.storeWallet.updateMany({
        where: { id: wallet.id, balance: { gte: amount } },
        data: { balance: { decrement: amount }, pendingBalance: { increment: amount } },
      });
      if (reserved.count !== 1) throw new BadRequestException('Số dư ví cửa hàng không đủ');
      const record = await tx.storeWalletWithdrawal.create({
        data: {
          id: withdrawalId,
          walletId: wallet.id,
          amount,
          status: 'PENDING',
          bankName,
          bankBin,
          accountNumber,
          accountHolderName,
          note: data.note,
          referenceId,
        },
      });
      await tx.storeWalletTransaction.create({
        data: {
          walletId: wallet.id,
          amount: -amount,
          type: 'WITHDRAWAL',
          status: 'PENDING',
          description: `Yêu cầu rút tiền ${referenceId}`,
          referenceId: `withdrawal:${withdrawalId}`,
        },
      });
      return record;
    });

    try {
      const payout = await payOS.payouts.create(
        {
          referenceId,
          amount,
          description: `Rut tien cua hang ${storeId.slice(0, 12)}`.slice(0, 25),
          toBin: bankBin,
          toAccountNumber: accountNumber,
        },
        referenceId
      );
      const status = this.mapPayoutStatus(payout.approvalState, payout.transactions?.[0]?.state);
      if (status === 'COMPLETED' || status === 'FAILED') {
        await this.settleWithdrawal(withdrawal.id, status, payout.id);
        return this.prisma.storeWalletWithdrawal.findUnique({ where: { id: withdrawal.id } });
      }
      return this.prisma.storeWalletWithdrawal.update({ where: { id: withdrawal.id }, data: { payoutId: payout.id, status } });
    } catch (error: any) {
      const providerMsg = error?.desc || error?.message || 'PayOS từ chối lệnh chi';
      const providerStatus = Number(error?.status || error?.code);
      if (providerStatus >= 400 && providerStatus < 500 && providerStatus !== 409) {
        await this.settleWithdrawal(withdrawal.id, 'FAILED');
        throw new BadRequestException(
          providerStatus === 403
            ? `Cổng PayOS từ chối lệnh rút tiền (403): Địa chỉ IP chưa được cấp quyền (Whitelist IP) trên PayOS Merchant. ${providerMsg}`
            : `PayOS từ chối lệnh chi: ${providerMsg}`
        );
      }
      const pending = await this.prisma.storeWalletWithdrawal.update({ where: { id: withdrawal.id }, data: { status: 'PENDING' } });
      return { ...pending, providerMessage: 'Chưa nhận được trạng thái cuối từ PayOS; số tiền vẫn được giữ và có thể đồng bộ lại.' };
    }
  }

  async syncWithdrawalStatus(storeId: string, withdrawalId: string) {
    const wallet = await this.wallet(storeId);
    const withdrawal = await this.prisma.storeWalletWithdrawal.findFirst({ where: { id: withdrawalId, walletId: wallet.id } });
    if (!withdrawal) throw new NotFoundException('Không tìm thấy lệnh rút tiền');
    const payOS = this.getPayOS();

    try {
      let payout = withdrawal.payoutId ? await payOS.payouts.get(withdrawal.payoutId) : null;
      if (!payout) {
        const existingPage = await payOS.payouts.list({ referenceId: withdrawal.referenceId, limit: 10, offset: 0 });
        payout = existingPage.data.find((item) => item.referenceId === withdrawal.referenceId) || null;
      }
      if (!payout) {
        payout = await payOS.payouts.create({
            referenceId: withdrawal.referenceId,
            amount: withdrawal.amount,
            description: `Rut tien cua hang ${storeId.slice(0, 12)}`.slice(0, 25),
            toBin: withdrawal.bankBin,
            toAccountNumber: withdrawal.accountNumber,
          }, withdrawal.referenceId);
      }
      const status = this.mapPayoutStatus(payout.approvalState, payout.transactions?.[0]?.state);
      if (status === 'COMPLETED' || status === 'FAILED') {
        await this.settleWithdrawal(withdrawal.id, status, withdrawal.payoutId);
        return this.prisma.storeWalletWithdrawal.findUnique({ where: { id: withdrawal.id } });
      }
      return this.prisma.storeWalletWithdrawal.update({ where: { id: withdrawal.id }, data: { status } });
    } catch (err: any) {
      const msg = err?.desc || err?.message || 'Không thể đồng bộ trạng thái từ PayOS';
      throw new BadRequestException(`Đồng bộ PayOS thất bại: ${msg}`);
    }
  }

  private mapPayoutStatus(approvalState?: string, transactionState?: string): string {
    if (['COMPLETED', 'SUCCEEDED'].includes(approvalState || '') || transactionState === 'SUCCEEDED') return 'COMPLETED';
    if (['FAILED', 'REJECTED', 'CANCELLED'].includes(approvalState || '') || ['FAILED', 'REVERSED', 'CANCELLED'].includes(transactionState || '')) return 'FAILED';
    if (['PROCESSING', 'APPROVED', 'SUBMITTED', 'SCHEDULED', 'PARTIAL_COMPLETED'].includes(approvalState || '') || ['PROCESSING', 'RECEIVED', 'ON_HOLD'].includes(transactionState || '')) return 'PROCESSING';
    return 'PENDING';
  }

  private async settleWithdrawal(withdrawalId: string, status: 'COMPLETED' | 'FAILED', payoutId?: string) {
    await this.prisma.$transaction(async (tx) => {
      const withdrawal = await tx.storeWalletWithdrawal.findUnique({ where: { id: withdrawalId } });
      if (!withdrawal || !['PENDING', 'PROCESSING'].includes(withdrawal.status)) return;
      await tx.storeWallet.update({ where: { id: withdrawal.walletId }, data: {
        pendingBalance: { decrement: withdrawal.amount },
        ...(status === 'FAILED' ? { balance: { increment: withdrawal.amount } } : {}),
      } });
      await tx.storeWalletWithdrawal.update({ where: { id: withdrawalId }, data: { status, payoutId: payoutId || withdrawal.payoutId, processedAt: new Date() } });
      await tx.storeWalletTransaction.updateMany({ where: { referenceId: `withdrawal:${withdrawalId}` }, data: { status } });
    });
  }
}
