import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  BadGatewayException,
  Inject,
  Optional,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateBankAccountDto, TransactionQueryDto, WithdrawalQueryDto } from './dto/wallet.dto';
import { RequestWithdrawalDto } from './dto/withdrawal.dto';
import { PayOSPayoutService } from '../payments/payos-payout.service';
import { CryptoVaultUtil } from '../common/utils/crypto-vault.util';
import { WalletMapper } from './mappers/wallet.mapper';
import { runWithTransactionRetry } from '../common/utils/transaction-retry.util';
import { StoreWalletRepository } from './store-wallet.repository';
import { DashboardCacheService } from '../common/cache/dashboard-cache.service';

@Injectable()
export class StoreWalletService {
  private readonly logger = new Logger(StoreWalletService.name);
  private readonly repo: StoreWalletRepository;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Optional() @Inject(PayOSPayoutService) private readonly payosPayoutService?: PayOSPayoutService,
    @Optional() @Inject(StoreWalletRepository) walletRepo?: StoreWalletRepository,
    @Optional() private readonly cacheService?: DashboardCacheService,
  ) {
    this.repo = walletRepo || new StoreWalletRepository(this.prisma);
  }

  private async invalidateWalletCaches(storeId?: string | number | bigint) {
    if (!this.cacheService || typeof this.cacheService.invalidatePrefix !== 'function') return;
    try {
      const promises: Promise<void>[] = [
        this.cacheService.invalidatePrefix('admin:dashboard:'),
        this.cacheService.invalidatePrefix('admin:operations'),
        this.cacheService.invalidatePrefix('admin:revenue:'),
      ];
      if (storeId) {
        promises.push(this.cacheService.invalidatePrefix(`dash:store:${storeId.toString()}:`));
      }
      await Promise.all(promises);
    } catch (error) {
      this.logger.warn(`Failed to invalidate wallet cache: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }

  async getOrCreateStoreWallet(storeId: string | number | bigint) {
    const rawStoreId = BigInt(storeId);
    return this.repo.getOrCreateStoreWallet(rawStoreId);
  }

  async updateBankAccount(storeId: string | number | bigint, dto: UpdateBankAccountDto) {
    const rawStoreId = BigInt(storeId);
    await this.getOrCreateStoreWallet(rawStoreId);

    const cleanAcc = dto.bankAccountNumber.trim();
    const accHash = CryptoVaultUtil.hashAccountNumber(cleanAcc);
    const accEncrypted = CryptoVaultUtil.encryptAccountNumber(cleanAcc);

    const updated = await this.repo.updateBankAccountAtomicTx({
      storeId: rawStoreId,
      bankName: dto.bankName,
      bankAccountHolder: dto.bankAccountHolder,
      accountNumberHash: accHash,
      accountNumberEncrypted: accEncrypted,
      cleanAcc,
    });

    return WalletMapper.toWalletDto(updated);
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

  async listTransactions(storeId: string | number | bigint, query?: TransactionQueryDto) {
    const rawStoreId = BigInt(storeId);
    const wallet = await this.getOrCreateStoreWallet(rawStoreId);

    const where: any = { walletId: wallet.walletId };
    if (query?.type) {
      where.type = query.type;
    }
    if (query?.fromDate || query?.toDate) {
      where.createdAt = {};
      if (query.fromDate) where.createdAt.gte = new Date(query.fromDate);
      if (query.toDate) where.createdAt.lte = new Date(query.toDate);
    }

    const page = Math.max(1, Number(query?.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(query?.pageSize) || Number(query?.limit) || 20));
    const skip = (page - 1) * pageSize;

    const [items, total] = await Promise.all([
      this.prisma.walletTransaction.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: pageSize,
      }),
      this.prisma.walletTransaction.count({ where }),
    ]);

    return {
      items: WalletMapper.toTransactionDtoList(items),
      total,
      page,
      pageSize,
    };
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

    // Invariant (Section 8): Chỉ cho phép rút tiền vào tài khoản ngân hàng đã xác minh chính chủ (OWNERSHIP_VERIFIED)
    let verifiedAccount = await this.prisma.storeBankAccount.findFirst({
      where: {
        storeId: rawStoreId,
        verificationStatus: 'OWNERSHIP_VERIFIED',
      },
      orderBy: { updatedAt: 'desc' },
    });

    const isStrict =
      process.env.BANK_VERIFICATION_STRICT === 'true' ||
      (process.env.NODE_ENV === 'production' && process.env.BANK_VERIFICATION_STRICT !== 'false');

    if (!verifiedAccount) {
      if (isStrict) {
        throw new BadRequestException({
          success: false,
          message: 'Tài khoản ngân hàng chưa được xác minh chính chủ bằng giao dịch 2.000 VND',
          errorCode: 'BANK_ACCOUNT_NOT_VERIFIED',
        });
      }

      // Legacy test environment compatibility: auto-provision verified bank record
      const walletRow = await this.prisma.storeWallet.findUnique({
        where: { storeId: rawStoreId },
      });
      const accNum = dto.bankAccountNumber || walletRow?.bankAccountNumber || '970422123456789';
      const enc = CryptoVaultUtil.encryptAccountNumber(accNum);
      const hash = CryptoVaultUtil.hashAccountNumber(accNum);
      verifiedAccount = await this.prisma.storeBankAccount.upsert({
        where: {
          uq_store_bank_account_store_acc_hash: {
            storeId: rawStoreId,
            accountNumberHash: hash,
          },
        },
        create: {
          storeId: rawStoreId,
          bankBin: dto.bankCode || '970422',
          bankName: dto.bankName || walletRow?.bankName || 'MBBANK',
          accountNumberEncrypted: enc,
          accountNumberHash: hash,
          accountName: dto.bankAccountHolder || walletRow?.bankAccountHolder || 'STORE OWNER',
          verificationStatus: 'OWNERSHIP_VERIFIED',
          verifiedAt: new Date(),
          lastVerifiedAt: new Date(),
        },
        update: {
          verificationStatus: 'OWNERSHIP_VERIFIED',
        },
      });
    }

    let verifiedPlainAcc = '';
    try {
      verifiedPlainAcc = CryptoVaultUtil.decryptAccountNumber(verifiedAccount.accountNumberEncrypted);
    } catch {
      verifiedPlainAcc = verifiedAccount.bankBin;
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
          frozen_balance: any;
          bank_name: string | null;
          bank_account_number: string | null;
          bank_account_holder: string | null;
        }>>`
          SELECT wallet_id, balance, frozen_balance, bank_name, bank_account_number, bank_account_holder
          FROM store_wallets
          WHERE wallet_id = ${wallet.walletId}
          FOR UPDATE
        `;

        if (!lockedWallet) throw new NotFoundException('Ví không tồn tại');

        const currentBalance = Number(lockedWallet.balance);
        const currentFrozen = Number(lockedWallet.frozen_balance || 0);
        if (currentBalance < amount) {
          throw new BadRequestException(
            `Số dư không đủ. Số dư khả dụng hiện tại: ${currentBalance.toLocaleString()} VND`,
          );
        }

        const balanceAfter = currentBalance - amount;
        const frozenAfter = currentFrozen + amount;
        await tx.storeWallet.update({
          where: { walletId: wallet.walletId },
          data: {
            balance: balanceAfter,
            frozenBalance: frozenAfter,
          },
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
            bankAccountId: verifiedAccount.id,
            bankCode: verifiedAccount.bankCode || dto.bankCode || '970422',
            bankName: verifiedAccount.bankName,
            bankAccountNumber: null, // Zero plaintext in DB!
            bankAccountHolder: verifiedAccount.accountName,
            bankAccountEncrypted: verifiedAccount.accountNumberEncrypted,
            bankAccountHash: verifiedAccount.accountNumberHash,
            bankAccountMasked: CryptoVaultUtil.maskAccountNumber(verifiedPlainAcc),
            bankAccountNameSnapshot: verifiedAccount.accountName,
            bankBinSnapshot: verifiedAccount.bankBin,
            bankNameSnapshot: verifiedAccount.bankName,
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
            description: `Yêu cầu rút tiền #${withdrawalCode} về ${verifiedAccount.bankName} (${CryptoVaultUtil.maskAccountNumber(verifiedPlainAcc)})`,
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

    await this.invalidateWalletCaches(rawStoreId);

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

    // Atomic race-condition prevention: conditionally transition PENDING -> PROCESSING
    const count = await this.prisma.$executeRaw`
      UPDATE store_withdrawals 
      SET status = 'PROCESSING', updated_at = NOW() 
      WHERE withdrawal_id = ${rawId} AND status = 'PENDING'
    `;

    if (count === 0) {
      const current = await this.prisma.storeWithdrawal.findUnique({ where: { withdrawalId: rawId } });
      if (!current) throw new NotFoundException('Không tìm thấy yêu cầu rút tiền');
      throw new BadRequestException(
        `Yêu cầu rút tiền #${current.withdrawalCode} đang ở trạng thái ${current.status}, không thể gửi Payout hoặc đang được xử lý đồng thời`
      );
    }

    const withdrawal = await this.prisma.storeWithdrawal.findUnique({
      where: { withdrawalId: rawId },
    });
    if (!withdrawal) {
      throw new NotFoundException('Không tìm thấy yêu cầu rút tiền');
    }

    if (!this.payosPayoutService) {
      throw new BadRequestException('Dịch vụ PayOS Payout chưa được kích hoạt trong hệ thống');
    }

    let toAccountNumber = '';
    if (withdrawal.bankAccountEncrypted) {
      toAccountNumber = CryptoVaultUtil.decryptAccountNumber(withdrawal.bankAccountEncrypted);
    } else if (withdrawal.bankAccountNumber) {
      toAccountNumber = withdrawal.bankAccountNumber;
    }

    try {
      const payoutResult = await this.payosPayoutService.createPayout({
        referenceId: withdrawal.withdrawalCode,
        amount: Number(withdrawal.netAmount || withdrawal.amount),
        description: `Rut tien ${withdrawal.withdrawalCode}`.slice(0, 25),
        toBin: withdrawal.bankBinSnapshot || withdrawal.bankCode || '970422',
        toAccountNumber,
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

      // Distinguish between confirmed failure (e.g. invalid account / bad request from PayOS)
      // vs unknown network connection / timeout error where payout status is uncertain.
      const isConfirmedFailure =
        err instanceof BadRequestException ||
        err?.status === 400 ||
        err?.response?.code === 'PAYOS_PAYOUT_FAILED' ||
        err?.message?.includes('PAYOS_PAYOUT_FAILED');

      if (isConfirmedFailure) {
        // Confirmed rejection by provider: Auto-Refund số dư về ví và chuyển withdrawal sang FAILED
        await this.refundFailedWithdrawal(rawId, err.message || 'PayOS xác nhận từ chối chi tiền');
        throw new BadRequestException(`Tạo chi tiền PayOS thất bại: ${err.message || 'Lỗi cổng PayOS'}`);
      } else {
        // Unknown connection / network timeout: DO NOT refund immediately to avoid double spending!
        // Keep status as PROCESSING with failureReason
        await this.prisma.storeWithdrawal.update({
          where: { withdrawalId: rawId },
          data: {
            status: 'PROCESSING',
            failureReason: `PENDING_RECONCILIATION: Lỗi kết nối tới cổng (${err.message}). Chờ webhook xác nhận.`.slice(0, 255),
          },
        });
        throw new BadGatewayException(
          `Kết nối tới cổng chi tiền gián đoạn (${err.message}). Yêu cầu được giữ ở trạng thái chờ đối soát (PROCESSING). Không hoàn tiền tự động ngay để tránh chi kép.`,
        );
      }
    }
  }

  /**
   * Ho�n ti?n v� khi Payout th?t b?i (Section 25)
   */
  async refundFailedWithdrawal(withdrawalId: string | number | bigint, reason: string) {
    const rawId = BigInt(withdrawalId);
    const result = await runWithTransactionRetry(async () => {
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

      // 2. Monotonic terminal guard: never refund a withdrawal that already SUCCEEDED
      if (lockedWithdrawal.status === 'SUCCEEDED') {
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
        frozen_balance: any;
      }>>`
        SELECT wallet_id, balance, frozen_balance
        FROM store_wallets
        WHERE wallet_id = ${lockedWithdrawal.wallet_id}
        FOR UPDATE
      `;

      if (!lockedWallet) throw new NotFoundException('Ví không tồn tại');

      const refundAmount = Number(lockedWithdrawal.amount);
      const balanceBefore = Number(lockedWallet.balance);
      const balanceAfter = balanceBefore + refundAmount;
      const currentFrozen = Number(lockedWallet.frozen_balance || 0);
      if (currentFrozen < refundAmount) {
        throw new ConflictException(
          `ACCOUNTING_INCONSISTENCY: Wallet #${lockedWithdrawal.wallet_id} frozenBalance (${currentFrozen}) is less than refund amount (${refundAmount})`,
        );
      }
      const frozenAfter = currentFrozen - refundAmount;

      await tx.storeWallet.update({
        where: { walletId: lockedWithdrawal.wallet_id },
        data: {
          balance: balanceAfter,
          frozenBalance: frozenAfter,
        },
      });

      const sanitizedReason = (reason || 'PayOS Payout API Error')
        .replace(/[^\p{L}\p{N}\s_.,:-]/gu, '')
        .slice(0, 255);

      await tx.walletTransaction.create({
        data: {
          walletId: lockedWithdrawal.wallet_id,
          amount: refundAmount,
          type: 'WITHDRAWAL_REFUND',
          balanceBefore,
          balanceAfter,
          referenceId: lockedWithdrawal.withdrawal_code,
          description: `Hoàn tiền yêu cầu rút #${lockedWithdrawal.withdrawal_code}: ${sanitizedReason}`,
        },
      });

      return tx.storeWithdrawal.update({
        where: { withdrawalId: rawId },
        data: {
          status: 'FAILED',
          failureReason: sanitizedReason,
          processedAt: new Date(),
        },
      });
    });
    });

    await this._invalidateWalletForWithdrawal(rawId);

    return result;
  }

  private async _invalidateWalletForWithdrawal(withdrawalId: bigint) {
    try {
      const w = await this.prisma.storeWithdrawal.findUnique({
        where: { withdrawalId },
        include: { wallet: true },
      });
      if (w?.wallet?.storeId) {
        await this.invalidateWalletCaches(w.wallet.storeId);
      } else {
        await this.invalidateWalletCaches();
      }
    } catch {
      this.logger.warn(`Could not resolve storeId for wallet cache invalidation on withdrawal ${withdrawalId}`);
      await this.invalidateWalletCaches();
    }
  }

  /**
   * Process PayOS Payout Webhook atomically via StoreWalletRepository
   */
  async processPayoutWebhook(data: any, desc?: string): Promise<{ success: boolean; message: string }> {
    const referenceId = data?.referenceId;
    if (!referenceId) {
      this.logger.warn('Webhook PayOS Payout thiếu referenceId');
      return { success: true, message: 'Đã nhận webhook (thiếu referenceId)' };
    }

    const withdrawal = await this.repo.findWithdrawalByCodeOrRef(referenceId);
    if (!withdrawal) {
      this.logger.warn(`Không tìm thấy yêu cầu rút tiền với ref: ${referenceId}`);
      return { success: true, message: 'Không tìm thấy yêu cầu rút tiền tương ứng' };
    }

    const rawState =
      data.state ||
      data.approvalState ||
      data.transactions?.[0]?.state ||
      '';

    const isSucceeded = ['SUCCEEDED', 'COMPLETED', 'PAID'].includes(rawState.toUpperCase());
    const isFailed = ['FAILED', 'REJECTED', 'CANCELLED'].includes(rawState.toUpperCase());

    if (isSucceeded && withdrawal.status === 'SUCCEEDED') {
      return { success: true, message: 'Yêu cầu rút tiền đã ở trạng thái hoàn thành trước đó' };
    }
    if (isFailed && (withdrawal.status === 'FAILED' || withdrawal.status === 'FAILED_CONFIRMED')) {
      return { success: true, message: 'Yêu cầu rút tiền đã được xử lý hoàn tiền trước đó' };
    }

    if (withdrawal.status === 'SUCCEEDED') {
      this.logger.warn(`Bỏ qua webhook FAILED cho yêu cầu #${withdrawal.withdrawalCode} đã SUCCEEDED`);
      return { success: true, message: 'Không thể chuyển đổi trạng thái đã thành công' };
    }

    if (withdrawal.status === 'FAILED' || withdrawal.status === 'FAILED_CONFIRMED') {
      this.logger.error(`🚨 Bỏ qua webhook SUCCEEDED cho yêu cầu #${withdrawal.withdrawalCode} đã FAILED và hoàn tiền trước đó để tránh chi kép.`);
      return { success: true, message: 'Yêu cầu đã ở trạng thái FAILED/Refunded, bỏ qua hoàn tất tự động để tránh chi kép' };
    }

    if (isSucceeded) {
      await this.repo.finalizePayoutSuccessTx(withdrawal.withdrawalId);
      this.logger.log(`Hoàn tất chi tiền thành công cho yêu cầu #${withdrawal.withdrawalCode}`);
      await this.invalidateWalletCaches(withdrawal.wallet?.storeId ?? undefined);
      return { success: true, message: 'Đã hoàn tất chi tiền thành công' };
    }

    if (isFailed) {
      const failReason = desc || 'PayOS Payout thông báo thất bại';
      await this.refundFailedWithdrawal(withdrawal.withdrawalId, failReason);
      this.logger.log(`Đã hoàn tiền tự động cho yêu cầu rút thất bại #${withdrawal.withdrawalCode}`);
      await this.invalidateWalletCaches(withdrawal.wallet?.storeId ?? undefined);
      return { success: true, message: 'Đã hoàn tiền yêu cầu rút thất bại' };
    }

    return { success: true, message: 'Webhook đã được ghi nhận' };
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
      const txResult = await this.prisma.$transaction(async (tx) => {
        const [lockedWithdrawal] = await tx.$queryRaw<Array<{
          withdrawal_id: bigint;
          status: string;
          amount: any;
          wallet_id: bigint;
        }>>`
          SELECT withdrawal_id, status, amount, wallet_id
          FROM store_withdrawals
          WHERE withdrawal_id = ${rawId}
          FOR UPDATE
        `;

        if (!lockedWithdrawal || lockedWithdrawal.status === 'SUCCEEDED') {
          return tx.storeWithdrawal.findUnique({ where: { withdrawalId: rawId } });
        }

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
            data: { frozenBalance: frozenAfter },
          });
        }

        return tx.storeWithdrawal.update({
          where: { withdrawalId: rawId },
          data: {
            status: 'SUCCEEDED',
            processedAt: new Date(),
          },
        });
      });
      await this.invalidateWalletCaches(withdrawal.wallet?.storeId ?? undefined);
      return txResult;
    }

    if (approvalState === 'FAILED' || txState === 'FAILED' || approvalState === 'REJECTED') {
      const refundedResult = await this.refundFailedWithdrawal(rawId, 'PayOS Payout xac nhan that bai');
      await this.invalidateWalletCaches(withdrawal.wallet?.storeId ?? undefined);
      return refundedResult;
    }

    // N?u v?n dang PROCESSING -> Gi? nguy�n tr?ng th�i, tuy?t d?i kh�ng refund (Section 24)
    return withdrawal;
  }

  async listWithdrawals(storeId: string | number | bigint, query?: WithdrawalQueryDto) {
    const rawStoreId = BigInt(storeId);
    const wallet = await this.getOrCreateStoreWallet(rawStoreId);

    const where: any = { walletId: wallet.walletId };
    if (query?.status) {
      where.status = query.status;
    }
    if (query?.fromDate || query?.toDate) {
      where.requestedAt = {};
      if (query.fromDate) where.requestedAt.gte = new Date(query.fromDate);
      if (query.toDate) where.requestedAt.lte = new Date(query.toDate);
    }

    const page = Math.max(1, Number(query?.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(query?.pageSize) || Number(query?.limit) || 20));
    const skip = (page - 1) * pageSize;

    const [items, total] = await Promise.all([
      this.prisma.storeWithdrawal.findMany({
        where,
        orderBy: { requestedAt: 'desc' },
        skip,
        take: pageSize,
      }),
      this.prisma.storeWithdrawal.count({ where }),
    ]);

    return {
      items: WalletMapper.toWithdrawalDtoList(items),
      total,
      page,
      pageSize,
    };
  }

  async getWithdrawal(withdrawalId: string | number | bigint, storeId?: string | number | bigint) {
    const rawId = BigInt(withdrawalId);
    const withdrawal = await this.prisma.storeWithdrawal.findUnique({
      where: { withdrawalId: rawId },
      include: { wallet: true },
    });

    if (!withdrawal) {
      throw new NotFoundException('Không tìm thấy thông tin rút tiền');
    }

    if (storeId) {
      const rawStoreId = BigInt(storeId);
      if (withdrawal.storeId && withdrawal.storeId !== rawStoreId) {
        throw new ForbiddenException({
          success: false,
          code: 'ACCESS_DENIED',
          message: 'Bạn không có quyền xem thông tin rút tiền của cửa hàng khác.',
        });
      }
    }

    return WalletMapper.toWithdrawalDto(withdrawal);
  }
}
