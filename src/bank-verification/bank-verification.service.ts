import {
  Injectable,
  Logger,
  Inject,
  Optional,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  HttpException,
  OnModuleInit,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { BankVerificationRepository } from './bank-verification.repository';
import {
  BANK_VERIFICATION_PROVIDER_TOKEN,
  BankVerificationProvider,
} from './providers/bank-verification.provider.interface';
import { LookupBankAccountDto } from './dto/lookup-bank-account.dto';
import { CreateVerificationRequestDto } from './dto/create-verification-request.dto';
import { BankVerificationWebhookDto } from './dto/bank-verification-webhook.dto';
import { VIETNAM_BANKS } from './constants/vietnam-banks.constant';
import { CryptoVaultUtil } from '../common/utils/crypto-vault.util';
import { PayOSPayoutService } from '../payments/payos-payout.service';
import {
  verifyPayosPayoutEvidence,
  verifyPayosPayoutRejectionEvidence,
  PayosPayoutExpectedCriteria,
} from '../payments/payos-payout-verifier';

@Injectable()
export class BankVerificationService implements OnModuleInit {
  private readonly logger = new Logger(BankVerificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: BankVerificationRepository,
    @Inject(BANK_VERIFICATION_PROVIDER_TOKEN)
    private readonly provider: BankVerificationProvider,
    @Optional()
    @Inject(PayOSPayoutService)
    private readonly payosPayoutService?: PayOSPayoutService,
  ) {}

  onModuleInit() {
    if (process.env.NODE_ENV === 'production') {
      const requiredSecrets = [
        'PLATFORM_BANK_ACCOUNT_NUMBER',
        'PLATFORM_BANK_BIN',
        'PAYOS_CLIENT_ID',
        'PAYOS_API_KEY',
        'PAYOS_CHECKSUM_KEY',
        'BANK_VERIFICATION_WEBHOOK_SECRET',
      ];

      for (const key of requiredSecrets) {
        if (!process.env[key]?.trim()) {
          throw new Error(`FATAL: ${key} must be configured in production`);
        }
      }

      if (process.env.BANK_VERIFICATION_MOCK === 'true') {
        throw new Error(
          'FATAL: BANK_VERIFICATION_MOCK must be disabled in production',
        );
      }

      const hasRedis =
        Boolean(process.env.REDIS_URL?.trim()) ||
        Boolean(process.env.REDIS_CACHE_URL?.trim()) ||
        Boolean(process.env.REDIS_HOST?.trim());

      if (!hasRedis) {
        throw new Error(
          'FATAL: REDIS_URL or REDIS_HOST must be configured in production for distributed rate limiting',
        );
      }
    }
  }

  /**
   * Lấy danh sách ngân hàng Việt Nam chính thức từ NAPAS / VietQR
   */
  getVietnamBanks() {
    return VIETNAM_BANKS;
  }

  /**
   * Tra cứu tên chủ tài khoản ngân hàng (Lookup Account Name)
   */
  async lookupBankAccount(dto: LookupBankAccountDto) {
    const bank = VIETNAM_BANKS.find((b) => b.bin === dto.bankBin);
    if (!bank) {
      throw new BadRequestException('Mã BIN ngân hàng không hợp lệ hoặc không được hỗ trợ');
    }

    const cleanAcc = dto.accountNumber.trim();
    if (!/^[0-9a-zA-Z]{5,30}$/.test(cleanAcc)) {
      throw new BadRequestException('Số tài khoản ngân hàng không hợp lệ');
    }

    try {
      const result = await this.provider.lookupAccount(dto.bankBin, cleanAcc);
      return {
        bankBin: dto.bankBin,
        bankName: result.bankName || bank.shortName,
        accountNumberMasked: CryptoVaultUtil.maskAccountNumber(cleanAcc),
        accountName: result.accountName,
      };
    } catch (error: any) {
      this.logger.error(`Lookup account failed [bankBin: ${dto.bankBin}] [operation: lookupAccount]: ${error.message}`);
      if (error instanceof HttpException) {
        throw error;
      }
      throw new BadRequestException('Không thể xác minh tài khoản ngân hàng lúc này');
    }
  }

  /**
   * Tạo yêu cầu xác minh tài khoản ngân hàng chính chủ bằng 2.000 VND
   */
  async createVerificationRequest(userId: bigint, dto: CreateVerificationRequestDto, userRole?: string) {
    const rawStoreId = BigInt(dto.storeId);

    // 1. Kiểm tra quyền sở hữu Store (chỉ OWNER hoặc ADMIN)
    await this.verifyStoreOwnership(userId, rawStoreId, userRole);

    const bank = VIETNAM_BANKS.find((b) => b.bin === dto.bankBin);
    if (!bank) {
      throw new BadRequestException('Mã BIN ngân hàng không hợp lệ');
    }

    const cleanAcc = dto.accountNumber.trim();
    const accHash = CryptoVaultUtil.hashAccountNumber(cleanAcc);

    // 2. Kiểm tra xem tài khoản có bị khóa không
    const existing = await this.repository.findBankAccountByHash(rawStoreId, accHash);
    if (existing && (existing.verificationStatus === 'SUSPENDED' || existing.verificationStatus === 'REVOKED')) {
      throw new ForbiddenException('Tài khoản ngân hàng này đã bị khóa hoặc thu hồi');
    }

    // 3. Luôn gọi lookup từ provider để lấy accountName chính chủ, lấy bankName và bankCode từ danh sách server
    const lookup = await this.provider.lookupAccount(dto.bankBin, cleanAcc);
    const accountName = lookup.accountName;
    const bankCode = bank.code;
    const bankName = bank.shortName || bank.name;

    const accEncrypted = CryptoVaultUtil.encryptAccountNumber(cleanAcc);

    // 4. Lưu / cập nhật bản ghi tài khoản ngân hàng của Store
    const bankAccount = await this.repository.upsertBankAccount({
      storeId: rawStoreId,
      bankBin: dto.bankBin,
      bankCode,
      bankName,
      accountNumberEncrypted: accEncrypted,
      accountNumberHash: accHash,
      accountName,
      verificationStatus: existing?.verificationStatus === 'OWNERSHIP_VERIFIED' ? 'OWNERSHIP_VERIFIED' : 'PENDING',
    });

    // 5. Cố định số tiền xác minh từ cấu hình (không nhận từ client)
    const expectedAmount = Number(process.env.BANK_VERIFICATION_AMOUNT_VND || 2000);
    const expiryMinutes = Number(process.env.BANK_VERIFICATION_EXPIRY_MINUTES || 30);
    const expiresAt = new Date(Date.now() + expiryMinutes * 60 * 1000);
    const referenceCode = CryptoVaultUtil.generateReferenceCode('VERIFY_');

    // 6. Tạo giao dịch xác minh
    const transaction = await this.repository.createVerificationTransaction({
      bankAccountId: bankAccount.id,
      referenceCode,
      expectedAmount,
      expiresAt,
    });

    // Platform receiving bank info (destination for the penny deposit)
    const recipientBankBin = process.env.PLATFORM_BANK_BIN || '970422';
    const recipientBankName = process.env.PLATFORM_BANK_NAME || 'MBBank';
    const recipientAccountNumber = process.env.PLATFORM_BANK_ACCOUNT_NUMBER || '0339898989';
    const recipientAccountHolder = process.env.PLATFORM_BANK_ACCOUNT_HOLDER || 'CONG TY CP SMART ORDER';

    const qrCodeUrl = `https://img.vietqr.io/image/${recipientBankBin}-${recipientAccountNumber}-compact2.png?amount=${expectedAmount}&addInfo=${encodeURIComponent(referenceCode)}&accountName=${encodeURIComponent(recipientAccountHolder)}`;

    return {
      verificationId: transaction.id.toString(),
      bankAccountId: bankAccount.id.toString(),
      bankName: bankAccount.bankName,
      accountNumberMasked: CryptoVaultUtil.maskAccountNumber(cleanAcc),
      accountName: bankAccount.accountName,
      amount: expectedAmount,
      referenceCode,
      expiresAt: expiresAt.toISOString(),
      recipientBankBin,
      recipientBankName,
      recipientAccountNumber,
      recipientAccountHolder,
      qrCodeUrl,
      instructions: `Vui lòng chuyển chính xác ${expectedAmount.toLocaleString()} VND đến số tài khoản ${recipientAccountNumber} (${recipientBankName}) với nội dung "${referenceCode}" để xác minh chính chủ. Số tiền sẽ được hoàn trả tự động sau khi xác minh thành công.`,
    };
  }

  /**
   * Danh sách tài khoản ngân hàng của Store
   */
  async listStoreBankAccounts(userId: bigint, storeId: bigint | string, userRole?: string) {
    const rawStoreId = BigInt(storeId);
    await this.verifyStoreOwnership(userId, rawStoreId, userRole);

    const accounts = await this.repository.listStoreBankAccounts(rawStoreId);
    return accounts.map((acc) => {
      let masked = '******';
      try {
        const plain = CryptoVaultUtil.decryptAccountNumber(acc.accountNumberEncrypted);
        masked = CryptoVaultUtil.maskAccountNumber(plain);
      } catch {
        masked = '******';
      }

      return {
        id: acc.id.toString(),
        storeId: acc.storeId.toString(),
        bankBin: acc.bankBin,
        bankCode: acc.bankCode,
        bankName: acc.bankName,
        accountNumberMasked: masked,
        accountName: acc.accountName,
        verificationStatus: acc.verificationStatus,
        isDefault: acc.isDefault,
        verifiedAt: acc.verifiedAt,
        createdAt: acc.createdAt,
      };
    });
  }

  /**
   * Đặt tài khoản ngân hàng làm mặc định cho Store
   */
  async setDefaultBankAccount(
    userId: bigint,
    storeId: bigint | string,
    bankAccountId: bigint | string,
    userRole?: string,
  ) {
    const rawStoreId = BigInt(storeId);
    await this.verifyStoreOwnership(userId, rawStoreId, userRole);

    const account = await this.repository.findBankAccountById(BigInt(bankAccountId));
    if (!account || account.storeId !== rawStoreId) {
      throw new NotFoundException('Tài khoản ngân hàng không tồn tại');
    }

    if (account.verificationStatus !== 'OWNERSHIP_VERIFIED') {
      throw new BadRequestException('Chỉ tài khoản đã xác minh chính chủ mới có thể đặt làm mặc định');
    }

    await this.repository.setDefaultBankAccount(rawStoreId, BigInt(bankAccountId));
    return {
      success: true,
      message: 'Đặt tài khoản ngân hàng mặc định thành công',
    };
  }

  /**
   * Xóa / Hủy liên kết tài khoản ngân hàng của Store
   */
  async deleteBankAccount(
    userId: bigint,
    storeId: bigint | string,
    bankAccountId: bigint | string,
    userRole?: string,
  ) {
    const rawStoreId = BigInt(storeId);
    await this.verifyStoreOwnership(userId, rawStoreId, userRole);

    const account = await this.repository.findBankAccountById(BigInt(bankAccountId));
    if (!account || account.storeId !== rawStoreId) {
      throw new NotFoundException('Tài khoản ngân hàng không tồn tại');
    }

    const pendingTx = await this.prisma.bankAccountVerificationTransaction.findFirst({
      where: {
        bankAccountId: BigInt(bankAccountId),
        status: 'PENDING',
      },
    });
    if (pendingTx) {
      throw new BadRequestException('Không thể xóa tài khoản đang có yêu cầu xác minh chưa hoàn tất');
    }

    await this.repository.deleteBankAccount(rawStoreId, BigInt(bankAccountId));
    return {
      success: true,
      message: 'Xóa tài khoản ngân hàng thành công',
    };
  }

  /**
   * Hủy yêu cầu xác minh tài khoản đang PENDING
   */
  async cancelVerificationRequest(userId: bigint, verificationId: bigint | string, userRole?: string) {
    const rawTxId = BigInt(verificationId);
    const tx = await this.prisma.bankAccountVerificationTransaction.findUnique({
      where: { id: rawTxId },
      include: { bankAccount: true },
    });

    if (!tx) {
      throw new NotFoundException('Giao dịch xác minh không tồn tại');
    }

    await this.verifyStoreOwnership(userId, tx.bankAccount.storeId, userRole);

    if (tx.status !== 'PENDING') {
      throw new BadRequestException('Chỉ có thể hủy yêu cầu xác minh đang ở trạng thái PENDING');
    }

    await this.repository.cancelVerificationTransaction(rawTxId);
    return {
      success: true,
      message: 'Hủy yêu cầu xác minh thành công',
    };
  }

  /**
   * Xử lý Webhook giao dịch xác minh 2.000 VND
   */
  async handleVerificationWebhook(dto: BankVerificationWebhookDto) {
    let referenceCode = dto.referenceCode;
    let amount = dto.amount;
    let providerTransactionId = dto.providerTransactionId;
    let description = dto.description || '';

    // Handle PayOS nested webhook payload structure (Signed-Data Precedence)
    if (dto.data) {
      // P1 Fix: Reject tampered payloads where unsigned top-level fields conflict with signed data
      if (dto.amount !== undefined && dto.data.amount !== undefined && Number(dto.amount) !== Number(dto.data.amount)) {
        throw new BadRequestException('Dữ liệu webhook không nhất quán: top-level amount khác với signed data.amount');
      }
      if (dto.providerTransactionId && dto.data.reference && dto.providerTransactionId !== dto.data.reference) {
        throw new BadRequestException('Dữ liệu webhook không nhất quán: top-level providerTransactionId khác với signed data.reference');
      }

      // Signed inner fields strictly take precedence over unsigned top-level fields
      amount = dto.data.amount !== undefined ? dto.data.amount : amount;
      description = dto.data.description || dto.description || '';
      providerTransactionId = dto.data.reference || dto.providerTransactionId;
    }

    // Trích xuất referenceCode từ description nếu chưa có
    if (!referenceCode && description) {
      const match = description.match(/VERIFY_[A-Z0-9]{4,10}/i);
      if (match) {
        referenceCode = match[0].toUpperCase();
      }
    }

    if (!referenceCode) {
      this.logger.warn('Webhook ignored: missing reference code in transaction [operation: webhook]');
      return {
        success: false,
        message: 'Nội dung giao dịch không chứa mã xác minh hợp lệ',
      };
    }

    // Fail-closed nếu thiếu providerTransactionId
    if (!providerTransactionId) {
      throw new BadRequestException('Missing provider transaction ID');
    }

    const receivedAmount = Number(amount || 0);

    // Trích xuất thông tin tài khoản và BIN gửi / nhận để kiểm tra chéo (Signed data strictness, no unsigned fallback)
    let destinationAccountNumber: string | undefined;
    let destinationBankBin: string | undefined;
    let senderAccountNumber: string | undefined;
    let senderBankBin: string | undefined;

    if (dto.data) {
      destinationAccountNumber =
        dto.data.destinationAccountNumber ||
        dto.data.accountNumber ||
        dto.data.virtualAccountNumber;

      destinationBankBin =
        dto.data.destinationBankBin ||
        dto.data.bin;

      senderAccountNumber =
        dto.data.counterAccountNumber ||
        dto.data.senderAccountNumber;

      senderBankBin =
        dto.data.counterAccountBankId ||
        dto.data.counterBankBin ||
        dto.data.senderBankBin;
    } else {
      // Direct raw-body signed webhook where the entire top-level body is authenticated
      destinationAccountNumber = dto.destinationAccountNumber;
      destinationBankBin = dto.destinationBankBin;
      senderAccountNumber = dto.senderAccountNumber || dto.counterAccountNumber;
      senderBankBin = dto.senderBankBin || dto.counterBankBin;
    }

    // Thực thi transaction nguyên tử với SELECT ... FOR UPDATE
    const txResult = await this.repository.executeAtomicWebhookVerificationTx({
      referenceCode,
      receivedAmount,
      providerTransactionId,
      senderAccountNumber,
      senderBankBin,
      destinationAccountNumber,
      destinationBankBin,
    });

    if (!txResult.success) {
      this.logger.warn(`Verification failed for ref ${referenceCode}: ${txResult.reason}`);
      return {
        success: false,
        reason: txResult.reason,
        message:
          txResult.reason === 'AMOUNT_MISMATCH'
            ? 'Số tiền giao dịch không đúng 2.000 VND'
            : txResult.reason === 'SENDER_ACCOUNT_MISMATCH'
            ? 'Tài khoản người gửi không khớp với tài khoản đăng ký'
            : txResult.reason === 'SENDER_BANK_MISMATCH'
            ? 'Ngân hàng người gửi không khớp với ngân hàng đã đăng ký'
            : txResult.reason === 'DESTINATION_ACCOUNT_MISMATCH'
            ? 'Tài khoản người nhận không khớp với tài khoản nền tảng'
            : txResult.reason === 'DESTINATION_BANK_MISMATCH'
            ? 'Ngân hàng người nhận không khớp với ngân hàng nền tảng'
            : txResult.reason === 'DESTINATION_ACCOUNT_UNVERIFIABLE'
            ? 'Không thể xác thực tài khoản nhận của nền tảng'
            : txResult.reason === 'DESTINATION_BANK_UNVERIFIABLE'
            ? 'Không thể xác thực ngân hàng nhận của nền tảng'
            : txResult.reason === 'SENDER_ACCOUNT_UNVERIFIABLE'
            ? 'Không thể xác thực tài khoản ngân hàng của người chuyển'
            : txResult.reason === 'SENDER_BANK_UNVERIFIABLE'
            ? 'Không thể xác thực ngân hàng của người chuyển'
            : txResult.reason === 'EXPIRED'
            ? 'Yêu cầu xác minh đã hết hạn'
            : 'Xác minh giao dịch thất bại',
      };
    }

    if (txResult.alreadyProcessed && !txResult.needsRefund) {
      return {
        success: true,
        message: 'Giao dịch đã được xác minh trước đó (Idempotent)',
      };
    }

    // Hoàn tiền tự động ngay sau khi VERIFIED, hoặc khi retry mà nghĩa vụ chưa hoàn tất
    if (txResult.bankAccount && (txResult.needsRefund || !txResult.alreadyProcessed)) {
      const refundAmount = Number(
        (txResult.transaction as any)?.expected_amount ||
        (txResult.transaction as any)?.expectedAmount ||
        2000,
      );
      await this.triggerAutomatedRefund(
        txResult.transaction.id,
        txResult.bankAccount,
        refundAmount,
        txResult.refundReference,
      );
    }

    return {
      success: true,
      message: 'Xác minh tài khoản chính chủ thành công và đã kích hoạt hoàn tiền',
    };
  }

  /**
   * Kích hoạt lệnh hoàn tiền tự động theo số tiền đã xác minh (Không ghi nhận REFUNDED sớm)
   */
  async triggerAutomatedRefund(
    transactionId: bigint,
    bankAccount: any,
    refundAmount?: number,
    customRefundReference?: string,
  ) {
    const amountToRefund = refundAmount || Number(process.env.BANK_VERIFICATION_AMOUNT_VND || 2000);
    const refundRef = customRefundReference || `REF_ST_${transactionId}`;

    try {
      await this.repository.updateTransactionRefundStatus({
        transactionId,
        status: 'REFUND_PENDING',
        refundStatus: 'PROCESSING',
      });

      const plainAccountNumber = CryptoVaultUtil.decryptAccountNumber(
        bankAccount.account_number_encrypted,
      ).trim();

      const refundResult = await this.provider.createRefund({
        bankBin: bankAccount.bank_bin,
        accountNumber: plainAccountNumber,
        accountName: bankAccount.account_name,
        amount: amountToRefund,
        referenceId: refundRef,
        description: `Hoan tien xac minh tai khoan ${amountToRefund} VND`,
      });

      if (refundResult.status === 'SUCCESS' || refundResult.status === 'PENDING_RECONCILIATION') {
        await this.repository.updateTransactionRefundStatus({
          transactionId,
          status: 'REFUND_PENDING',
          refundStatus: 'PROCESSING',
          refundTransactionId: refundResult.refundTransactionId,
        });
        this.logger.log(`Lệnh hoàn tiền ${amountToRefund} VND đã gửi cho verificationId #${transactionId}, trạng thái PROCESSING/PENDING_RECONCILIATION`);
      } else {
        await this.repository.updateTransactionRefundStatus({
          transactionId,
          status: 'REFUND_PENDING',
          refundStatus: 'FAILED',
        });
        this.logger.error(`Hoàn tiền không thành công [verificationId: #${transactionId}]`);
      }
    } catch (error: any) {
      this.logger.error(`Hoàn tiền thất bại [verificationId: #${transactionId}]: ${error?.message}`);
      await this.repository.updateTransactionRefundStatus({
        transactionId,
        status: 'REFUND_PENDING',
        refundStatus: 'FAILED',
      });
    }
  }

  /**
   * Worker xử lý các nghĩa vụ hoàn tiền xác minh Store đang chờ (Outbox Processor)
   */
  async processStoreRefundWorkerBatch(limit = 10): Promise<{ processed: number; succeeded: number; failed: number }> {
    const obligations = await this.repository.findPendingStoreRefundObligations(limit);
    let processed = 0;
    let succeeded = 0;
    let failed = 0;

    for (const obligation of obligations) {
      processed++;
      const leaseToken = crypto.randomUUID();
      const claimed = await this.repository.claimRefundObligationForDispatch(obligation.id, leaseToken, 60000);
      if (!claimed) continue;

      try {
        let plainAcc = '';
        if (obligation.target_account_encrypted) {
          plainAcc = CryptoVaultUtil.decryptAccountNumber(obligation.target_account_encrypted).trim();
        }

        if (!plainAcc || !obligation.target_bank_bin) {
          await this.repository.recordObligationTerminalFailure(
            obligation.id,
            leaseToken,
            null,
            'Thiếu số tài khoản hoặc BIN nhận tiền',
          );
          failed++;
          continue;
        }

        // Invariant: Nếu obligation đã có attempt trước hoặc có payout_id/reference cũ,
        // BẮT BUỘC tra cứu trước trên PayOS, không được tạo mới để chống chi kép (Double Payout)
        if (Number(obligation.attempt_count) > 0 || obligation.provider_payout_id) {
          let existingPayout: any = null;
          let concretePayoutId = obligation.provider_payout_id ? String(obligation.provider_payout_id).trim() : null;
          if (this.payosPayoutService) {
            try {
              if (concretePayoutId) {
                const pRes = await this.payosPayoutService.getPayout(concretePayoutId);
                if (pRes?.data) existingPayout = pRes.data;
              } else if (obligation.refund_reference) {
                const listRes = await this.payosPayoutService.getPayouts({ referenceId: obligation.refund_reference });
                const rawList = listRes?.data?.payouts || listRes?.data || [];
                const matched = Array.isArray(rawList)
                  ? rawList.filter((p: any) => p?.referenceId === obligation.refund_reference || p?.id === obligation.refund_reference)
                  : [];
                if (matched.length === 1 && matched[0]?.id) {
                  concretePayoutId = String(matched[0].id).trim();
                  const pRes = await this.payosPayoutService.getPayout(concretePayoutId);
                  if (pRes?.data) existingPayout = pRes.data;
                }
              }
            } catch (e: any) {
              this.logger.warn(`Lỗi tra cứu attempt trước cho obligation #${obligation.id}: ${e.message}`);
            }
          }

          if (existingPayout) {
            const targetAccountHash =
              obligation.target_account_hash ||
              CryptoVaultUtil.computeDeterministicAccountHash(plainAcc);
            const criteria: PayosPayoutExpectedCriteria = {
              amount: Number(obligation.refund_amount),
              payoutReference: obligation.refund_reference,
              targetBankBin: obligation.target_bank_bin,
              targetAccountHash,
              expectedPayoutId: concretePayoutId || undefined,
            };

            const successVerif = verifyPayosPayoutEvidence(existingPayout, criteria);
            if (successVerif.isVerified) {
              await this.repository.finalizeObligationSuccessTx(obligation.id, leaseToken, successVerif.providerPayoutId);
              succeeded++;
              continue;
            }

            const rejectionVerif = verifyPayosPayoutRejectionEvidence(existingPayout, criteria);
            if (rejectionVerif.isVerified) {
              await this.repository.recordObligationTerminalFailure(
                obligation.id,
                leaseToken,
                rejectionVerif.providerPayoutId,
                rejectionVerif.reason || 'PayOS xác nhận chi hoàn tiền thất bại',
              );
              failed++;
              continue;
            }

            // Đang xử lý hoặc chưa rõ kết quả -> Chuyển chờ đối soát kèm backoff
            await this.repository.recordObligationReconciliationPending(
              obligation.id,
              leaseToken,
              concretePayoutId,
              'Cổng đang xử lý lệnh hoàn tiền (PROCESSING)',
              60000,
            );
            failed++;
            continue;
          }
        }

        const refundResult = await this.provider.createRefund({
          bankBin: obligation.target_bank_bin,
          accountNumber: plainAcc,
          amount: Number(obligation.refund_amount),
          referenceId: obligation.refund_reference,
          description: `Hoan tien xac minh ${obligation.id}`.slice(0, 50),
        });

        // Bất kể code=00 hay nhận lệnh thành công, KHÔNG ghi nhận REFUNDED ngay
        // Ghi nhận PENDING_RECONCILIATION để reconciler kiểm tra terminal evidence ngay lập tức
        await this.repository.recordObligationReconciliationPending(
          obligation.id,
          leaseToken,
          refundResult.refundTransactionId || null,
          'PENDING_TERMINAL_RECONCILIATION',
          0,
        );
        succeeded++;
      } catch (err: any) {
        this.logger.error(`Lỗi xử lý store refund obligation #${obligation.id}: ${err.message}`);
        await this.repository.recordObligationReconciliationPending(
          obligation.id,
          leaseToken,
          null,
          err.message || 'Lỗi gửi lệnh hoàn tiền',
        );
        failed++;
      }
    }

    return { processed, succeeded, failed };
  }

  /**
   * Worker đối soát các nghĩa vụ hoàn tiền xác minh Store đang dở dang (Reconciler)
   */
  async reconcilePendingStoreRefunds(limit = 10): Promise<{ reconciled: number }> {
    if (!this.payosPayoutService) return { reconciled: 0 };
    const obligations = await this.repository.findPendingStoreReconciliations(limit);
    let reconciled = 0;

    for (const obligation of obligations) {
      try {
        let detailData: any = null;
        let concretePayoutId = obligation.provider_payout_id ? String(obligation.provider_payout_id).trim() : null;

        if (concretePayoutId) {
          try {
            const detailRes = await this.payosPayoutService.getPayout(concretePayoutId);
            if (detailRes?.data) detailData = detailRes.data;
          } catch (e: any) {
            continue;
          }
        } else if (obligation.refund_reference) {
          try {
            const listRes = await this.payosPayoutService.getPayouts({ referenceId: obligation.refund_reference });
            const rawList = listRes?.data?.payouts || listRes?.data || [];
            const matched = Array.isArray(rawList)
              ? rawList.filter((p: any) => p?.referenceId === obligation.refund_reference || p?.id === obligation.refund_reference)
              : [];
            if (matched.length === 1 && matched[0]?.id) {
              concretePayoutId = String(matched[0].id).trim();
              const detailRes = await this.payosPayoutService.getPayout(concretePayoutId);
              if (detailRes?.data) detailData = detailRes.data;
            } else {
              continue;
            }
          } catch (e: any) {
            continue;
          }
        }

        if (!detailData) continue;

        let plainAcc = '';
        if (obligation.target_account_encrypted) {
          try {
            plainAcc = CryptoVaultUtil.decryptAccountNumber(obligation.target_account_encrypted).trim();
          } catch {}
        }

        const targetAccountHash =
          obligation.target_account_hash ||
          (plainAcc ? CryptoVaultUtil.computeDeterministicAccountHash(plainAcc) : null);

        const criteria: PayosPayoutExpectedCriteria = {
          amount: Number(obligation.refund_amount),
          payoutReference: obligation.refund_reference,
          targetBankBin: obligation.target_bank_bin,
          targetAccountHash,
          expectedPayoutId: concretePayoutId || undefined,
        };

        const successVerif = verifyPayosPayoutEvidence(detailData, criteria);
        if (successVerif.isVerified) {
          await this.prisma.$transaction(async (tx) => {
            await tx.$executeRaw`
              UPDATE store_bank_refund_obligations
              SET refund_status = 'REFUNDED',
                  provider_payout_id = ${successVerif.providerPayoutId},
                  refunded_at = NOW(),
                  updated_at = NOW()
              WHERE id = ${obligation.id}
            `;
            await tx.$executeRaw`
              UPDATE bank_account_verification_transactions
              SET status = 'REFUNDED',
                  refund_status = 'SUCCESS',
                  refund_transaction_id = ${successVerif.providerPayoutId},
                  refunded_at = NOW(),
                  updated_at = NOW()
              WHERE id = (
                SELECT r.verification_tx_id 
                FROM store_bank_inbound_receipts r 
                WHERE r.id = ${obligation.receipt_id}
              )
            `;
          });
          reconciled++;
          continue;
        }

        const rejectionVerif = verifyPayosPayoutRejectionEvidence(detailData, criteria);
        if (rejectionVerif.isVerified) {
          await this.prisma.$executeRaw`
            UPDATE store_bank_refund_obligations
            SET refund_status = 'FAILED',
                failure_reason = ${rejectionVerif.reason || 'REJECTED'},
                updated_at = NOW()
            WHERE id = ${obligation.id}
          `;
          reconciled++;
          continue;
        }

        // Chưa terminal (đang PROCESSING tại cổng) -> Cập nhật next_reconcile_at chống nghẽn hàng đợi (Anti-HoL)
        const backoffMs = [60000, 120000, 300000, 900000, 1800000, 3600000][
          Math.min(Number(obligation.attempt_count || 0), 5)
        ];
        await this.prisma.$executeRaw`
          UPDATE store_bank_refund_obligations
          SET next_reconcile_at = NOW() + (${backoffMs}::int * interval '1 millisecond'),
              updated_at = NOW()
          WHERE id = ${obligation.id}
        `;
      } catch (err: any) {
        this.logger.warn(`Lỗi đối soát store refund obligation #${obligation.id}: ${err.message}`);
        const backoffMs = 60000;
        await this.prisma.$executeRaw`
          UPDATE store_bank_refund_obligations
          SET next_reconcile_at = NOW() + (${backoffMs}::int * interval '1 millisecond'),
              updated_at = NOW()
          WHERE id = ${obligation.id}
        `.catch(() => {});
      }
    }

    return { reconciled };
  }

  private async verifyStoreOwnership(userId: bigint, storeId: bigint, userRole?: string) {
    const store = await this.prisma.store.findUnique({
      where: { storeId },
    });

    if (!store) {
      throw new NotFoundException('Cửa hàng không tồn tại');
    }

    const isAdmin = ['ADMIN', 'SUPER_ADMIN', 'SYSTEM_ADMIN'].includes(userRole || '');
    if (isAdmin) {
      return store;
    }

    const isDirectOwner = store.ownerUserId === userId;
    if (isDirectOwner) {
      return store;
    }

    // Check if user is an active STORE_OWNER staff of this store
    const staffOwner = await this.prisma.storeStaff.findFirst({
      where: {
        storeId,
        userId,
        status: 'ACTIVE',
        leftAt: null,
        role: {
          roleCode: {
            in: ['STORE_OWNER', 'OWNER'],
          },
        },
      },
    });

    if (staffOwner) {
      return store;
    }

    throw new ForbiddenException(
      'Chỉ chủ cửa hàng (STORE_OWNER) hoặc Quản trị viên (ADMIN) mới có quyền quản lý tài khoản ngân hàng',
    );
  }

  formatVerificationTransaction(tx: any) {
    let masked = '******';
    if (tx.bankAccount?.accountNumberEncrypted) {
      try {
        const plain = CryptoVaultUtil.decryptAccountNumber(tx.bankAccount.accountNumberEncrypted);
        masked = CryptoVaultUtil.maskAccountNumber(plain);
      } catch {
        masked = '******';
      }
    }

    const recipientBankBin = process.env.PLATFORM_BANK_BIN || '970422';
    const recipientBankName = process.env.PLATFORM_BANK_NAME || 'MBBank';
    const recipientAccountNumber = process.env.PLATFORM_BANK_ACCOUNT_NUMBER || '0339898989';
    const recipientAccountHolder = process.env.PLATFORM_BANK_ACCOUNT_HOLDER || 'CONG TY CP SMART ORDER';
    const expectedAmount = Number(tx.expectedAmount);
    const referenceCode = tx.referenceCode;
    const qrCodeUrl = `https://img.vietqr.io/image/${recipientBankBin}-${recipientAccountNumber}-compact2.png?amount=${expectedAmount}&addInfo=${encodeURIComponent(referenceCode)}&accountName=${encodeURIComponent(recipientAccountHolder)}`;
    const instructions = `Vui lòng chuyển chính xác ${expectedAmount.toLocaleString()} VND đến số tài khoản ${recipientAccountNumber} (${recipientBankName}) với nội dung "${referenceCode}" để xác minh chính chủ. Số tiền sẽ được hoàn trả tự động sau khi xác minh thành công.`;
    const actualAmount = tx.receivedAmount ? Number(tx.receivedAmount) : (tx.actualAmount ? Number(tx.actualAmount) : null);

    return {
      id: tx.id.toString(),
      verificationId: tx.id.toString(),
      bankAccountId: tx.bankAccountId.toString(),
      storeId: tx.bankAccount?.storeId?.toString() || '',
      bankBin: tx.bankAccount?.bankBin || '',
      bankCode: tx.bankAccount?.bankCode || null,
      bankName: tx.bankAccount?.bankName || '',
      accountNumberMasked: masked,
      accountName: tx.bankAccount?.accountName || '',
      referenceCode,
      expectedAmount,
      actualAmount,
      receivedAmount: actualAmount,
      status: tx.status,
      refundStatus: tx.refundStatus,
      failureReason: tx.failureReason || null,
      recipientBankBin,
      recipientBankName,
      recipientAccountNumber,
      recipientAccountHolder,
      qrCodeUrl,
      instructions,
      expiresAt: tx.expiresAt,
      verifiedAt: tx.verifiedAt || null,
      createdAt: tx.createdAt,
      updatedAt: tx.updatedAt,
    };
  }

  async getVerificationTransactionById(id: bigint | string, userId: bigint, userRole?: string) {
    const rawId = BigInt(id);
    const tx = await this.repository.findVerificationTransactionById(rawId);
    if (!tx) {
      throw new NotFoundException('Giao dịch xác minh không tồn tại');
    }

    if (tx.bankAccount?.storeId) {
      await this.verifyStoreOwnership(userId, tx.bankAccount.storeId, userRole);
    }

    return this.formatVerificationTransaction(tx);
  }

  async listStoreVerificationTransactions(
    storeId: bigint | string,
    query: { page?: number; pageSize?: number; status?: string },
    userId: bigint,
    userRole?: string,
  ) {
    const rawStoreId = BigInt(storeId);
    await this.verifyStoreOwnership(userId, rawStoreId, userRole);

    const page = Math.max(1, Number(query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 20));
    const skip = (page - 1) * pageSize;

    const { total, items } = await this.repository.listVerificationTransactionsByStore(rawStoreId, {
      skip,
      take: pageSize,
      status: query.status,
    });

    return {
      items: items.map((tx) => this.formatVerificationTransaction(tx)),
      total,
      page,
      pageSize,
    };
  }
}
