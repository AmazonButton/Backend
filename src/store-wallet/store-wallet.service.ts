import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  BadGatewayException,
  InternalServerErrorException,
  Inject,
  Optional,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateBankAccountDto, TransactionQueryDto, WithdrawalQueryDto } from './dto/wallet.dto';
import { RequestWithdrawalDto } from './dto/withdrawal.dto';
import { PayOSPayoutService } from '../payments/payos-payout.service';
import { CryptoVaultUtil } from '../common/utils/crypto-vault.util';
import {
  verifyPayosPayoutEvidence,
  verifyPayosPayoutRejectionEvidence,
  PayosPayoutExpectedCriteria,
} from '../payments/payos-payout-verifier';
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

  async getWalletResponse(storeId: bigint) {
    const wallet = await this.getOrCreateStoreWallet(storeId);
    const defaultBankAccount = await this.repo.findDefaultBankAccount(storeId);
    return WalletMapper.toWalletDto({ ...wallet, defaultBankAccount });
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
      bankBin: dto.bankBin,
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
    let verifiedAccount = null;
    if (dto.bankAccountId) {
      verifiedAccount = await this.prisma.storeBankAccount.findFirst({
        where: {
          id: BigInt(dto.bankAccountId),
          storeId: rawStoreId,
          verificationStatus: 'OWNERSHIP_VERIFIED',
        },
      });
      if (!verifiedAccount) {
        throw new BadRequestException({
          success: false,
          message: 'Tài khoản ngân hàng chỉ định không hợp lệ hoặc chưa được xác minh chính chủ',
          errorCode: 'INVALID_BANK_ACCOUNT',
        });
      }
    } else {
      verifiedAccount = await this.prisma.storeBankAccount.findFirst({
        where: {
          storeId: rawStoreId,
          verificationStatus: 'OWNERSHIP_VERIFIED',
        },
        orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }],
      });
    }

    if (!verifiedAccount) {
      throw new BadRequestException({
        success: false,
        message: 'Tài khoản ngân hàng chưa được xác minh chính chủ bằng giao dịch 2.000 VND',
        errorCode: 'BANK_ACCOUNT_NOT_VERIFIED',
      });
    }

    // Fail-closed verification & decryption of target account
    if (!verifiedAccount.accountNumberEncrypted || !verifiedAccount.accountNumberHash || !verifiedAccount.bankBin) {
      throw new InternalServerErrorException('Tài khoản ngân hàng thiếu dữ liệu mã hóa hoặc mã BIN (Fail-Closed)');
    }

    let verifiedPlainAcc = '';
    try {
      verifiedPlainAcc = CryptoVaultUtil.decryptAccountNumber(verifiedAccount.accountNumberEncrypted).trim();
    } catch (err: any) {
      this.logger.error(`Lỗi giải mã tài khoản ngân hàng store ${rawStoreId}: ${err?.message}`);
      throw new InternalServerErrorException('Lỗi giải mã thông tin tài khoản ngân hàng (Fail-Closed)');
    }

    if (!verifiedPlainAcc) {
      throw new InternalServerErrorException('Số tài khoản ngân hàng sau giải mã rỗng (Fail-Closed)');
    }

    // Đối chiếu hash để bảo đảm tính toàn vẹn tuyệt đối
    const computedHash = CryptoVaultUtil.hashAccountNumber(verifiedPlainAcc);
    if (computedHash !== verifiedAccount.accountNumberHash) {
      this.logger.error(`Hash số tài khoản không khớp cho store ${rawStoreId}`);
      throw new InternalServerErrorException('Tính toàn vẹn của tài khoản ngân hàng bị vi phạm (Hash Mismatch)');
    }

    const wallet = await this.getOrCreateStoreWallet(rawStoreId);
    // Phí rút tiền do Server quyết định 100% (server-controlled, 0 <= fee < amount, integer VND)
    const fee = 0;
    const netAmount = amount - fee;
    if (!Number.isInteger(amount) || amount <= 0 || !Number.isInteger(fee) || fee < 0 || fee >= amount) {
      throw new BadRequestException('Số tiền hoặc phí rút tiền không hợp lệ');
    }
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

        const descPrefix = `Yêu cầu rút tiền #${withdrawalCode} về ${verifiedAccount.bankName} (${CryptoVaultUtil.maskAccountNumber(verifiedPlainAcc)})`;
        await tx.walletTransaction.create({
          data: {
            walletId: wallet.walletId,
            amount: -amount,
            type: 'WITHDRAWAL_DEBIT',
            balanceBefore: currentBalance,
            balanceAfter,
            referenceId: withdrawalCode,
            description: dto.note?.trim() ? `${descPrefix}: ${dto.note.trim()}` : descPrefix,
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

    const shouldAutoPayout = dto.autoPayout ?? options?.autoPayout ?? true;
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

    if (!withdrawal.bankAccountEncrypted || !withdrawal.bankAccountHash || !withdrawal.bankBinSnapshot) {
      throw new BadRequestException('Thiếu snapshot tài khoản ngân hàng đã mã hóa hoặc mã BIN (Fail-Closed)');
    }

    let toAccountNumber = '';
    try {
      toAccountNumber = CryptoVaultUtil.decryptAccountNumber(withdrawal.bankAccountEncrypted).trim();
    } catch (err: any) {
      this.logger.error(`Lỗi giải mã tài khoản cho withdrawal #${rawId}: ${err?.message}`);
      throw new BadRequestException('Lỗi giải mã tài khoản nhận tiền (Fail-Closed)');
    }

    if (!toAccountNumber) {
      throw new BadRequestException('Số tài khoản nhận tiền sau giải mã rỗng (Fail-Closed)');
    }

    const computedHash = CryptoVaultUtil.hashAccountNumber(toAccountNumber);
    const deterministicHash = CryptoVaultUtil.computeDeterministicAccountHash(toAccountNumber);
    if (computedHash !== withdrawal.bankAccountHash && deterministicHash !== withdrawal.bankAccountHash) {
      throw new BadRequestException('Tính toàn vẹn của tài khoản nhận tiền bị vi phạm (Hash Mismatch)');
    }

    const payoutAmount = withdrawal.netAmount !== null && withdrawal.netAmount !== undefined
      ? Math.round(Number(withdrawal.netAmount))
      : Math.round(Number(withdrawal.amount) - Number(withdrawal.fee || 0));
    if (!Number.isInteger(payoutAmount) || payoutAmount <= 0) {
      throw new BadRequestException('Số tiền chi hộ thực chuyển (netAmount) không hợp lệ');
    }

    const providerReferenceId = withdrawal.providerReferenceId || withdrawal.withdrawalCode;

    try {
      const payoutResult = await this.payosPayoutService.createPayout({
        referenceId: providerReferenceId,
        amount: payoutAmount,
        description: `Rut tien ${withdrawal.withdrawalCode}`.slice(0, 25),
        toBin: withdrawal.bankBinSnapshot.trim(),
        toAccountNumber,
        category: ['withdrawal'],
      });

      const providerPayoutId = payoutResult?.data?.id ? String(payoutResult.data.id).trim() : null;

      await this.prisma.$executeRaw`
        UPDATE store_withdrawals
        SET provider_payout_id = COALESCE(${providerPayoutId}, provider_payout_id),
            provider_reference_id = ${providerReferenceId},
            processed_at = COALESCE(processed_at, NOW()),
            updated_at = NOW()
        WHERE withdrawal_id = ${rawId}
          AND (provider_reference_id = ${providerReferenceId} OR provider_reference_id IS NULL)
          AND status IN ('PENDING', 'PROCESSING')
      `;

      await this.invalidateWalletCaches(withdrawal.storeId ?? undefined);
      return await this.prisma.storeWithdrawal.findUnique({ where: { withdrawalId: rawId } });
    } catch (err: any) {
      this.logger.error(`PayOS Payout failed for withdrawal #${withdrawal.withdrawalCode}: ${err.message}`);

      // Invariant PAY-01: Sau timeout/lỗi mạng, ưu tiên đối soát. Giữ PENDING_RECONCILIATION, không tự ý hoàn tiền.
      await this.prisma.$executeRaw`
        UPDATE store_withdrawals
        SET status = 'PENDING_RECONCILIATION',
            failure_reason = ${`PENDING_RECONCILIATION: Lỗi kết nối tới cổng (${err.message}). Chờ đối soát.`.slice(0, 255)},
            updated_at = NOW()
        WHERE withdrawal_id = ${rawId} AND status IN ('PENDING', 'PROCESSING')
      `;
      await this.invalidateWalletCaches(withdrawal.storeId ?? undefined);
      throw new BadGatewayException(
        `Kết nối tới cổng chi tiền gián đoạn (${err.message}). Yêu cầu được giữ ở trạng thái chờ đối soát (PENDING_RECONCILIATION). Không hoàn tiền tự động ngay để tránh chi kép.`,
      );
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

    if (withdrawal.status === 'SUCCEEDED') {
      return { success: true, message: 'Yêu cầu rút tiền đã ở trạng thái hoàn thành trước đó' };
    }
    if (withdrawal.status === 'FAILED' || withdrawal.status === 'FAILED_CONFIRMED' || withdrawal.status === 'CANCELLED') {
      return { success: true, message: 'Yêu cầu rút tiền đã được xử lý hoàn tiền hoặc hủy trước đó' };
    }

    let detailPayout: any = data;
    const dataHasDirectTx =
      (data?.referenceId || data?.reference) &&
      (data?.toBin || data?.bin) &&
      data?.amount !== undefined;

    if (!dataHasDirectTx && (!Array.isArray(detailPayout?.transactions) || detailPayout.transactions.length === 0)) {
      if (this.payosPayoutService && data.id) {
        try {
          const detailRes = await this.payosPayoutService.getPayout(data.id);
          if (detailRes?.data) {
            detailPayout = detailRes.data;
          }
        } catch (err: any) {
          this.logger.warn(`Webhook: không thể lấy chi tiết payout ${data.id}: ${err.message}`);
        }
      }
    }

    const netAmount = withdrawal.netAmount !== null && withdrawal.netAmount !== undefined
      ? Math.round(Number(withdrawal.netAmount))
      : Math.round(Number(withdrawal.amount) - Number(withdrawal.fee || 0));

    const criteria: PayosPayoutExpectedCriteria = {
      amount: netAmount,
      payoutReference: withdrawal.providerReferenceId || withdrawal.withdrawalCode,
      targetBankBin: withdrawal.bankBinSnapshot || withdrawal.bankCode,
      targetAccountHash: withdrawal.bankAccountHash,
      expectedPayoutId: data.id ? String(data.id) : (withdrawal.providerPayoutId || undefined),
    };

    const successVerif = verifyPayosPayoutEvidence(detailPayout, criteria);
    if (successVerif.isVerified) {
      await this.repo.finalizePayoutSuccessTx(withdrawal.withdrawalId, successVerif.providerPayoutId);
      this.logger.log(`Hoàn tất chi tiền thành công cho yêu cầu #${withdrawal.withdrawalCode}`);
      await this.invalidateWalletCaches(withdrawal.wallet?.storeId ?? undefined);
      return { success: true, message: 'Đã hoàn tất chi tiền thành công' };
    }

    const rejectionVerif = verifyPayosPayoutRejectionEvidence(detailPayout, criteria);
    if (rejectionVerif.isVerified) {
      const failReason = desc || rejectionVerif.reason || 'PayOS Payout thông báo thất bại';
      await this.refundFailedWithdrawal(withdrawal.withdrawalId, failReason);
      this.logger.log(`Đã hoàn tiền tự động cho yêu cầu rút thất bại #${withdrawal.withdrawalCode}`);
      await this.invalidateWalletCaches(withdrawal.wallet?.storeId ?? undefined);
      return { success: true, message: 'Đã hoàn tiền yêu cầu rút thất bại' };
    }

    this.logger.warn(
      `Webhook payout chưa đủ bằng chứng terminal cho #${withdrawal.withdrawalCode}, lý do: ${successVerif.reason || rejectionVerif.reason}, giữ chờ đối soát`,
    );
    return { success: true, message: 'Webhook đã được ghi nhận, chờ đối soát' };
  }

    /**
   * Kiểm tra & đồng bộ trạng thái Payout từ PayOS (Unified with Admin & Fail-Closed)
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
      throw new NotFoundException('Không tìm thấy yêu cầu rút tiền');
    }

    if (requestStoreId && withdrawal.wallet.storeId !== BigInt(requestStoreId)) {
      throw new ForbiddenException({
        success: false,
        code: 'ACCESS_DENIED',
        message: 'Bạn không có quyền thao tác trên yêu cầu rút tiền của cửa hàng khác.',
      });
    }

    if (withdrawal.status === 'PENDING') {
      if (!withdrawal.providerPayoutId && this.payosPayoutService) {
        this.logger.log(`Yêu cầu rút tiền #${withdrawal.withdrawalCode} đang ở PENDING, kích hoạt gửi PayOS Payout...`);
        return await this.triggerPayosPayout(withdrawal.withdrawalId);
      }
      return withdrawal;
    }

    if (withdrawal.status !== 'PROCESSING' && withdrawal.status !== 'PENDING_RECONCILIATION') {
      return withdrawal;
    }

    if (!this.payosPayoutService) {
      return withdrawal;
    }

    let targetPayout: any = null;
    let expectedPayoutId: string | null = withdrawal.providerPayoutId ? String(withdrawal.providerPayoutId).trim() : null;

    if (withdrawal.providerPayoutId) {
      try {
        const statusData = await this.payosPayoutService.getPayout(withdrawal.providerPayoutId);
        targetPayout = statusData?.data;
      } catch (err: any) {
        this.logger.warn(`Lỗi khi lấy chi tiết payout ${withdrawal.providerPayoutId}: ${err.message}`);
        return withdrawal;
      }
    } else if (withdrawal.providerReferenceId || withdrawal.withdrawalCode) {
      const searchRef = withdrawal.providerReferenceId || withdrawal.withdrawalCode;
      try {
        const listData = await this.payosPayoutService.getPayouts({ referenceId: searchRef });
        const rawList = listData?.data?.payouts || listData?.data || [];
        const payoutsList = Array.isArray(rawList) ? rawList : [];
        const matched = payoutsList.filter(
          (p: any) => p.referenceId === searchRef || p.referenceId === withdrawal.withdrawalCode || p.id === searchRef,
        );
        if (matched.length === 1 && matched[0].id) {
          expectedPayoutId = String(matched[0].id).trim();
          const detailRes = await this.payosPayoutService.getPayout(matched[0].id);
          targetPayout = detailRes?.data;
        } else {
          return withdrawal;
        }
      } catch (err: any) {
        this.logger.warn(`Lỗi khi tra cứu danh sách payouts cho ref ${searchRef}: ${err.message}`);
        return withdrawal;
      }
    }

    if (!targetPayout) {
      return withdrawal;
    }

    const netAmount = withdrawal.netAmount !== null && withdrawal.netAmount !== undefined
      ? Math.round(Number(withdrawal.netAmount))
      : Math.round(Number(withdrawal.amount) - Number(withdrawal.fee || 0));

    const criteria: PayosPayoutExpectedCriteria = {
      amount: netAmount,
      payoutReference: withdrawal.providerReferenceId || withdrawal.withdrawalCode,
      targetBankBin: withdrawal.bankBinSnapshot || withdrawal.bankCode,
      targetAccountHash: withdrawal.bankAccountHash,
      expectedPayoutId: expectedPayoutId || undefined,
    };

    const successVerif = verifyPayosPayoutEvidence(targetPayout, criteria);
    if (successVerif.isVerified) {
      await this.repo.finalizePayoutSuccessTx(rawId, successVerif.providerPayoutId);
      await this.invalidateWalletCaches(withdrawal.wallet?.storeId ?? undefined);
      return await this.prisma.storeWithdrawal.findUnique({ where: { withdrawalId: rawId } });
    }

    const rejectionVerif = verifyPayosPayoutRejectionEvidence(targetPayout, criteria);
    if (rejectionVerif.isVerified) {
      const refundedResult = await this.refundFailedWithdrawal(rawId, `PayOS Payout xác nhận thất bại: ${rejectionVerif.reason || 'REJECTED'}`);
      await this.invalidateWalletCaches(withdrawal.wallet?.storeId ?? undefined);
      return refundedResult;
    }

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
      const effectiveStoreId = withdrawal.storeId ?? withdrawal.wallet?.storeId;
      if (effectiveStoreId && effectiveStoreId !== rawStoreId) {
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
