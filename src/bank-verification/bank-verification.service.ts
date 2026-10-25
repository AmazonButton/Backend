import {
  Injectable,
  Logger,
  Inject,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
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

@Injectable()
export class BankVerificationService implements OnModuleInit {
  private readonly logger = new Logger(BankVerificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: BankVerificationRepository,
    @Inject(BANK_VERIFICATION_PROVIDER_TOKEN)
    private readonly provider: BankVerificationProvider,
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
      this.logger.error(`Lookup account failed [bankBin: ${dto.bankBin}] [operation: lookupAccount]`);
      throw new BadRequestException({
        success: false,
        errorCode: 'BANK_LOOKUP_UNAVAILABLE',
        message: 'Không thể xác minh tài khoản ngân hàng lúc này',
      });
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

    return {
      verificationId: transaction.id.toString(),
      bankAccountId: bankAccount.id.toString(),
      bankName: bankAccount.bankName,
      accountNumberMasked: CryptoVaultUtil.maskAccountNumber(cleanAcc),
      accountName: bankAccount.accountName,
      amount: expectedAmount,
      referenceCode,
      expiresAt: expiresAt.toISOString(),
      instructions: `Vui lòng chuyển chính xác ${expectedAmount.toLocaleString()} VND với nội dung "${referenceCode}" để xác minh chính chủ. Số tiền sẽ được hoàn trả tự động sau khi xác minh thành công.`,
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

    // Handle PayOS nested webhook payload structure
    if (dto.data) {
      amount = amount || dto.data.amount;
      description = description || dto.data.description || '';
      providerTransactionId = providerTransactionId || dto.data.reference;
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

    // Trích xuất thông tin tài khoản và BIN gửi / nhận để kiểm tra chéo
    const destinationAccountNumber =
      dto.destinationAccountNumber ||
      dto.data?.destinationAccountNumber ||
      dto.data?.accountNumber ||
      dto.data?.virtualAccountNumber;

    const destinationBankBin =
      dto.destinationBankBin ||
      dto.data?.destinationBankBin ||
      dto.data?.bin;

    const senderAccountNumber =
      dto.senderAccountNumber ||
      dto.counterAccountNumber ||
      dto.data?.counterAccountNumber ||
      dto.data?.senderAccountNumber;

    const senderBankBin =
      dto.senderBankBin ||
      dto.counterBankBin ||
      dto.data?.counterAccountBankId ||
      dto.data?.counterBankBin ||
      dto.data?.senderBankBin;

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

    if (txResult.alreadyProcessed) {
      return {
        success: true,
        message: 'Giao dịch đã được xác minh trước đó (Idempotent)',
      };
    }

    // Hoàn tiền tự động ngay sau khi VERIFIED, lấy đúng số tiền từ transaction
    if (txResult.bankAccount) {
      const refundAmount = Number(
        (txResult.transaction as any)?.expected_amount ||
        (txResult.transaction as any)?.expectedAmount ||
        2000,
      );
      await this.triggerAutomatedRefund(txResult.transaction.id, txResult.bankAccount, refundAmount);
    }

    return {
      success: true,
      message: 'Xác minh tài khoản chính chủ thành công và đã kích hoạt hoàn tiền',
    };
  }

  /**
   * Kích hoạt lệnh hoàn tiền tự động theo số tiền đã xác minh
   */
  async triggerAutomatedRefund(transactionId: bigint, bankAccount: any, refundAmount?: number) {
    const amountToRefund = refundAmount || Number(process.env.BANK_VERIFICATION_AMOUNT_VND || 2000);
    try {
      await this.repository.updateTransactionRefundStatus({
        transactionId,
        status: 'REFUND_PENDING',
        refundStatus: 'PENDING',
      });

      const plainAccountNumber = CryptoVaultUtil.decryptAccountNumber(
        bankAccount.account_number_encrypted,
      );

      const refundResult = await this.provider.createRefund({
        bankBin: bankAccount.bank_bin,
        accountNumber: plainAccountNumber,
        accountName: bankAccount.account_name,
        amount: amountToRefund,
        referenceId: `REFUND_${transactionId}`,
        description: `Hoan tien xac minh tai khoan ${amountToRefund} VND`,
      });

      if (refundResult.status === 'SUCCESS') {
        await this.repository.updateTransactionRefundStatus({
          transactionId,
          status: 'REFUNDED',
          refundStatus: 'SUCCESS',
          refundTransactionId: refundResult.refundTransactionId,
          refundedAt: new Date(),
        });
        this.logger.log(`Hoàn tiền ${amountToRefund} VND thành công cho verificationId #${transactionId}`);
      } else {
        await this.repository.updateTransactionRefundStatus({
          transactionId,
          status: 'REFUND_PENDING',
          refundStatus: 'FAILED',
        });
        this.logger.error(`Hoan tien khong thanh cong [verificationId: #${transactionId}] [operation: createRefund]`);
      }
    } catch (error: any) {
      this.logger.error(`Hoan tien that bai [verificationId: #${transactionId}] [operation: createRefund]`);
      await this.repository.updateTransactionRefundStatus({
        transactionId,
        status: 'REFUND_PENDING',
        refundStatus: 'FAILED',
      });
    }
  }

  private async verifyStoreOwnership(userId: bigint, storeId: bigint, userRole?: string) {
    const store = await this.prisma.store.findUnique({
      where: { storeId },
    });

    if (!store) {
      throw new NotFoundException('Cửa hàng không tồn tại');
    }

    const isOwner = store.ownerUserId === userId;
    const isAdmin = userRole === 'ADMIN';

    if (!isOwner && !isAdmin) {
      throw new ForbiddenException(
        'Chỉ chủ cửa hàng (STORE_OWNER) hoặc Quản trị viên (ADMIN) mới có quyền quản lý tài khoản ngân hàng',
      );
    }

    return store;
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
      referenceCode: tx.referenceCode,
      expectedAmount: Number(tx.expectedAmount),
      actualAmount: tx.actualAmount ? Number(tx.actualAmount) : null,
      status: tx.status,
      refundStatus: tx.refundStatus,
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
