import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoVaultUtil } from '../common/utils/crypto-vault.util';

export interface AtomicWebhookVerificationResult {
  success: boolean;
  alreadyProcessed?: boolean;
  reason?: string;
  transaction?: any;
  bankAccount?: any;
}

@Injectable()
export class BankVerificationRepository {
  private readonly logger = new Logger(BankVerificationRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  async findBankAccountByHash(storeId: bigint, accountNumberHash: string) {
    return this.prisma.storeBankAccount.findUnique({
      where: {
        uq_store_bank_account_store_acc_hash: {
          storeId,
          accountNumberHash,
        },
      },
    });
  }

  async findBankAccountById(id: bigint) {
    return this.prisma.storeBankAccount.findUnique({
      where: { id },
    });
  }

  async findVerifiedBankAccount(storeId: bigint) {
    return this.prisma.storeBankAccount.findFirst({
      where: {
        storeId,
        verificationStatus: 'OWNERSHIP_VERIFIED',
      },
      orderBy: { updatedAt: 'desc' },
    });
  }

  async listStoreBankAccounts(storeId: bigint) {
    return this.prisma.storeBankAccount.findMany({
      where: { storeId },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    });
  }

  async upsertBankAccount(params: {
    storeId: bigint;
    bankBin: string;
    bankCode?: string;
    bankName: string;
    accountNumberEncrypted: string;
    accountNumberHash: string;
    accountName: string;
    verificationStatus?: string;
  }) {
    return this.prisma.storeBankAccount.upsert({
      where: {
        uq_store_bank_account_store_acc_hash: {
          storeId: params.storeId,
          accountNumberHash: params.accountNumberHash,
        },
      },
      create: {
        storeId: params.storeId,
        bankBin: params.bankBin,
        bankCode: params.bankCode,
        bankName: params.bankName,
        accountNumberEncrypted: params.accountNumberEncrypted,
        accountNumberHash: params.accountNumberHash,
        accountName: params.accountName,
        verificationStatus: params.verificationStatus || 'PENDING',
        isDefault: true,
      },
      update: {
        bankName: params.bankName,
        accountName: params.accountName,
        bankCode: params.bankCode || undefined,
        accountNumberEncrypted: params.accountNumberEncrypted,
        updatedAt: new Date(),
      },
    });
  }

  async createVerificationTransaction(params: {
    bankAccountId: bigint;
    referenceCode: string;
    expectedAmount: number;
    expiresAt: Date;
  }) {
    return this.prisma.bankAccountVerificationTransaction.create({
      data: {
        bankAccountId: params.bankAccountId,
        referenceCode: params.referenceCode,
        expectedAmount: params.expectedAmount,
        status: 'PENDING',
        expiresAt: params.expiresAt,
      },
    });
  }

  async findTransactionByReference(referenceCode: string) {
    return this.prisma.bankAccountVerificationTransaction.findFirst({
      where: { referenceCode },
      include: { bankAccount: true },
    });
  }

  async updateTransactionRefundStatus(params: {
    transactionId: bigint;
    status: string;
    refundStatus: string;
    refundTransactionId?: string;
    refundedAt?: Date;
  }) {
    return this.prisma.bankAccountVerificationTransaction.update({
      where: { id: params.transactionId },
      data: {
        status: params.status,
        refundStatus: params.refundStatus,
        refundTransactionId: params.refundTransactionId || undefined,
        refundedAt: params.refundedAt || undefined,
        updatedAt: new Date(),
      },
    });
  }

  async setDefaultBankAccount(storeId: bigint, bankAccountId: bigint) {
    return this.prisma.$transaction(async (tx) => {
      await tx.storeBankAccount.updateMany({
        where: { storeId },
        data: { isDefault: false },
      });

      return tx.storeBankAccount.update({
        where: { id: bankAccountId, storeId },
        data: { isDefault: true, updatedAt: new Date() },
      });
    });
  }

  async deleteBankAccount(storeId: bigint, bankAccountId: bigint) {
    return this.prisma.storeBankAccount.delete({
      where: { id: bankAccountId, storeId },
    });
  }

  async cancelVerificationTransaction(transactionId: bigint) {
    return this.prisma.bankAccountVerificationTransaction.updateMany({
      where: {
        id: transactionId,
        status: 'PENDING',
      },
      data: {
        status: 'EXPIRED',
        updatedAt: new Date(),
      },
    });
  }

  /**
   * Khóa dòng dữ liệu (SELECT FOR UPDATE) và xử lý xác minh giao dịch nguyên tử trong transaction
   * Kiểm tra nghiêm ngặt: số tiền, mã đối soát, tài khoản nhận, và tài khoản gửi
   */
  async executeAtomicWebhookVerificationTx(params: {
    referenceCode: string;
    receivedAmount: number;
    providerTransactionId: string;
    senderAccountNumber?: string;
    senderBankBin?: string;
    destinationAccountNumber?: string;
    destinationBankBin?: string;
  }): Promise<AtomicWebhookVerificationResult> {
    return this.prisma.$transaction(async (tx) => {
      // 1. Khóa hàng verification transaction bằng SELECT ... FOR UPDATE
      const lockedRows = await tx.$queryRaw<
        Array<{
          id: bigint;
          bank_account_id: bigint;
          reference_code: string;
          expected_amount: any;
          received_amount: any;
          provider_transaction_id: string | null;
          status: string;
          expires_at: Date;
          refund_status: string | null;
        }>
      >`
        SELECT id, bank_account_id, reference_code, expected_amount, received_amount, provider_transaction_id, status, expires_at, refund_status
        FROM bank_account_verification_transactions
        WHERE reference_code = ${params.referenceCode}
        FOR UPDATE
      `;

      if (!lockedRows || lockedRows.length === 0) {
        return {
          success: false,
          reason: 'TRANSACTION_NOT_FOUND',
        };
      }

      const lockedTx = lockedRows[0];

      // 2. Khóa tài khoản ngân hàng liên kết để kiểm tra
      const [lockedAccount] = await tx.$queryRaw<
        Array<{
          id: bigint;
          store_id: bigint;
          bank_bin: string;
          bank_name: string;
          account_number_encrypted: string;
          account_name: string;
        }>
      >`
        SELECT id, store_id, bank_bin, bank_name, account_number_encrypted, account_name
        FROM store_bank_accounts
        WHERE id = ${lockedTx.bank_account_id}
        FOR UPDATE
      `;

      if (!lockedAccount) {
        return {
          success: false,
          reason: 'BANK_ACCOUNT_NOT_FOUND',
        };
      }

      // 3. Kiểm tra Idempotency: nếu đã VERIFIED hoặc REFUNDED
      if (
        lockedTx.status === 'VERIFIED' ||
        lockedTx.status === 'REFUND_PENDING' ||
        lockedTx.status === 'REFUNDED'
      ) {
        return {
          success: true,
          alreadyProcessed: true,
          transaction: lockedTx,
          bankAccount: lockedAccount,
        };
      }

      // 4. Kiểm tra hết hạn (Expired check)
      const now = new Date();
      if (new Date(lockedTx.expires_at) < now) {
        await tx.$executeRaw`
          UPDATE bank_account_verification_transactions
          SET status = 'EXPIRED',
              failure_reason = 'EXPIRED',
              updated_at = NOW()
          WHERE id = ${lockedTx.id}
        `;
        return {
          success: false,
          reason: 'EXPIRED',
          transaction: { ...lockedTx, status: 'EXPIRED', failure_reason: 'EXPIRED' },
        };
      }

      const expectedAmount = Number(lockedTx.expected_amount);

      // 5. Kiểm tra đúng số tiền (tính theo expected_amount trong DB)
      if (params.receivedAmount !== expectedAmount) {
        this.logger.warn(
          `[AtomicWebhookVerification] Số tiền không khớp cho ref ${params.referenceCode}: nhận ${params.receivedAmount}, kỳ vọng ${expectedAmount}`,
        );
        await tx.$executeRaw`
          UPDATE bank_account_verification_transactions
          SET status = 'FAILED',
              failure_reason = 'AMOUNT_MISMATCH',
              received_amount = ${params.receivedAmount},
              provider_transaction_id = ${params.providerTransactionId},
              updated_at = NOW()
          WHERE id = ${lockedTx.id}
        `;
        return {
          success: false,
          reason: 'AMOUNT_MISMATCH',
          transaction: { ...lockedTx, status: 'FAILED', failure_reason: 'AMOUNT_MISMATCH' },
        };
      }

      // 6. Kiểm tra chéo tài khoản nhận (destination account & BIN)
      const platformAcc = process.env.PLATFORM_BANK_ACCOUNT_NUMBER?.trim();
      const platformBin = process.env.PLATFORM_BANK_BIN?.trim();
      const isStrict =
        process.env.NODE_ENV === 'production' ||
        process.env.BANK_VERIFICATION_STRICT === 'true';

      if (isStrict) {
        if (!platformAcc || !params.destinationAccountNumber) {
          this.logger.warn(
            `[AtomicWebhookVerification] Thieu thong tin tai khoan nhan (ref: ${params.referenceCode})`,
          );
          await tx.$executeRaw`
            UPDATE bank_account_verification_transactions
            SET status = 'FAILED',
                failure_reason = 'DESTINATION_ACCOUNT_UNVERIFIABLE',
                received_amount = ${params.receivedAmount},
                provider_transaction_id = ${params.providerTransactionId},
                updated_at = NOW()
            WHERE id = ${lockedTx.id}
          `;
          return {
            success: false,
            reason: 'DESTINATION_ACCOUNT_UNVERIFIABLE',
            transaction: { ...lockedTx, status: 'FAILED', failure_reason: 'DESTINATION_ACCOUNT_UNVERIFIABLE' },
          };
        }

        if (!platformBin || !params.destinationBankBin) {
          this.logger.warn(
            `[AtomicWebhookVerification] Thieu thong tin BIN ngan hang nhan (ref: ${params.referenceCode})`,
          );
          await tx.$executeRaw`
            UPDATE bank_account_verification_transactions
            SET status = 'FAILED',
                failure_reason = 'DESTINATION_BANK_UNVERIFIABLE',
                received_amount = ${params.receivedAmount},
                provider_transaction_id = ${params.providerTransactionId},
                updated_at = NOW()
            WHERE id = ${lockedTx.id}
          `;
          return {
            success: false,
            reason: 'DESTINATION_BANK_UNVERIFIABLE',
            transaction: { ...lockedTx, status: 'FAILED', failure_reason: 'DESTINATION_BANK_UNVERIFIABLE' },
          };
        }
      }

      if (params.destinationAccountNumber && platformAcc) {
        if (params.destinationAccountNumber.trim() !== platformAcc) {
          this.logger.warn(
            `[AtomicWebhookVerification] Tai khoan nhan khong khop nen tang (ref: ${params.referenceCode})`,
          );
          await tx.$executeRaw`
            UPDATE bank_account_verification_transactions
            SET status = 'FAILED',
                failure_reason = 'DESTINATION_ACCOUNT_MISMATCH',
                received_amount = ${params.receivedAmount},
                provider_transaction_id = ${params.providerTransactionId},
                updated_at = NOW()
            WHERE id = ${lockedTx.id}
          `;
          return {
            success: false,
            reason: 'DESTINATION_ACCOUNT_MISMATCH',
            transaction: { ...lockedTx, status: 'FAILED', failure_reason: 'DESTINATION_ACCOUNT_MISMATCH' },
          };
        }
      }

      if (params.destinationBankBin && platformBin) {
        if (params.destinationBankBin.trim() !== platformBin) {
          this.logger.warn(
            `[AtomicWebhookVerification] BIN ngan hang nhan khong khop nen tang (ref: ${params.referenceCode})`,
          );
          await tx.$executeRaw`
            UPDATE bank_account_verification_transactions
            SET status = 'FAILED',
                failure_reason = 'DESTINATION_BANK_MISMATCH',
                received_amount = ${params.receivedAmount},
                provider_transaction_id = ${params.providerTransactionId},
                updated_at = NOW()
            WHERE id = ${lockedTx.id}
          `;
          return {
            success: false,
            reason: 'DESTINATION_BANK_MISMATCH',
            transaction: { ...lockedTx, status: 'FAILED', failure_reason: 'DESTINATION_BANK_MISMATCH' },
          };
        }
      }

      // 7. Kiểm tra chéo tài khoản gửi (sender account & BIN)
      if (isStrict) {
        if (!params.senderAccountNumber) {
          this.logger.warn(
            `[AtomicWebhookVerification] Thieu thong tin tai khoan gui (ref: ${params.referenceCode})`,
          );
          await tx.$executeRaw`
            UPDATE bank_account_verification_transactions
            SET status = 'FAILED',
                failure_reason = 'SENDER_ACCOUNT_UNVERIFIABLE',
                received_amount = ${params.receivedAmount},
                provider_transaction_id = ${params.providerTransactionId},
                updated_at = NOW()
            WHERE id = ${lockedTx.id}
          `;
          return {
            success: false,
            reason: 'SENDER_ACCOUNT_UNVERIFIABLE',
            transaction: { ...lockedTx, status: 'FAILED', failure_reason: 'SENDER_ACCOUNT_UNVERIFIABLE' },
          };
        }

        if (!params.senderBankBin) {
          this.logger.warn(
            `[AtomicWebhookVerification] Thieu thong tin BIN ngan hang gui (ref: ${params.referenceCode})`,
          );
          await tx.$executeRaw`
            UPDATE bank_account_verification_transactions
            SET status = 'FAILED',
                failure_reason = 'SENDER_BANK_UNVERIFIABLE',
                received_amount = ${params.receivedAmount},
                provider_transaction_id = ${params.providerTransactionId},
                updated_at = NOW()
            WHERE id = ${lockedTx.id}
          `;
          return {
            success: false,
            reason: 'SENDER_BANK_UNVERIFIABLE',
            transaction: { ...lockedTx, status: 'FAILED', failure_reason: 'SENDER_BANK_UNVERIFIABLE' },
          };
        }
      }

      if (params.senderAccountNumber) {
        let plainRegisteredAcc: string;
        try {
          plainRegisteredAcc = CryptoVaultUtil.decryptAccountNumber(
            lockedAccount.account_number_encrypted,
          ).trim();
        } catch (decryptErr: any) {
          this.logger.error(
            `[AtomicWebhookVerification] Giai ma tai khoan dang ky that bai (ref: ${params.referenceCode})`,
          );
          await tx.$executeRaw`
            UPDATE bank_account_verification_transactions
            SET status = 'FAILED',
                failure_reason = 'SENDER_ACCOUNT_UNVERIFIABLE',
                received_amount = ${params.receivedAmount},
                provider_transaction_id = ${params.providerTransactionId},
                updated_at = NOW()
            WHERE id = ${lockedTx.id}
          `;
          return {
            success: false,
            reason: 'SENDER_ACCOUNT_UNVERIFIABLE',
            transaction: { ...lockedTx, status: 'FAILED', failure_reason: 'SENDER_ACCOUNT_UNVERIFIABLE' },
          };
        }

        if (!plainRegisteredAcc) {
          this.logger.warn(
            `[AtomicWebhookVerification] So tai khoan sau giai ma rong (ref: ${params.referenceCode})`,
          );
          await tx.$executeRaw`
            UPDATE bank_account_verification_transactions
            SET status = 'FAILED',
                failure_reason = 'SENDER_ACCOUNT_UNVERIFIABLE',
                received_amount = ${params.receivedAmount},
                provider_transaction_id = ${params.providerTransactionId},
                updated_at = NOW()
            WHERE id = ${lockedTx.id}
          `;
          return {
            success: false,
            reason: 'SENDER_ACCOUNT_UNVERIFIABLE',
            transaction: { ...lockedTx, status: 'FAILED', failure_reason: 'SENDER_ACCOUNT_UNVERIFIABLE' },
          };
        }

        if (params.senderAccountNumber.trim() !== plainRegisteredAcc) {
          this.logger.warn(
            `[AtomicWebhookVerification] Tai khoan gui khong khop tai khoan can xac minh (ref: ${params.referenceCode})`,
          );
          await tx.$executeRaw`
            UPDATE bank_account_verification_transactions
            SET status = 'FAILED',
                failure_reason = 'SENDER_ACCOUNT_MISMATCH',
                received_amount = ${params.receivedAmount},
                provider_transaction_id = ${params.providerTransactionId},
                updated_at = NOW()
            WHERE id = ${lockedTx.id}
          `;
          return {
            success: false,
            reason: 'SENDER_ACCOUNT_MISMATCH',
            transaction: { ...lockedTx, status: 'FAILED', failure_reason: 'SENDER_ACCOUNT_MISMATCH' },
          };
        }
      }

      if (params.senderBankBin && lockedAccount.bank_bin) {
        if (params.senderBankBin.trim() !== lockedAccount.bank_bin.trim()) {
          this.logger.warn(
            `[AtomicWebhookVerification] BIN ngan hang gui khong khop tai khoan can xac minh (ref: ${params.referenceCode})`,
          );
          await tx.$executeRaw`
            UPDATE bank_account_verification_transactions
            SET status = 'FAILED',
                failure_reason = 'SENDER_BANK_MISMATCH',
                received_amount = ${params.receivedAmount},
                provider_transaction_id = ${params.providerTransactionId},
                updated_at = NOW()
            WHERE id = ${lockedTx.id}
          `;
          return {
            success: false,
            reason: 'SENDER_BANK_MISMATCH',
            transaction: { ...lockedTx, status: 'FAILED', failure_reason: 'SENDER_BANK_MISMATCH' },
          };
        }
      }

      // 8. Kiểm tra provider_transaction_id chống replay giữa các transaction khác nhau
      const duplicateTx = await tx.$queryRaw<Array<{ id: bigint }>>`
        SELECT id FROM bank_account_verification_transactions
        WHERE provider_transaction_id = ${params.providerTransactionId}
          AND id <> ${lockedTx.id}
        LIMIT 1
      `;
      if (duplicateTx && duplicateTx.length > 0) {
        await tx.$executeRaw`
          UPDATE bank_account_verification_transactions
          SET status = 'FAILED',
              failure_reason = 'DUPLICATE_PROVIDER_TRANSACTION',
              updated_at = NOW()
          WHERE id = ${lockedTx.id}
        `;
        return {
          success: false,
          reason: 'DUPLICATE_PROVIDER_TRANSACTION',
        };
      }

      // 9. Cập nhật trạng thái transaction thành VERIFIED
      await tx.$executeRaw`
        UPDATE bank_account_verification_transactions
        SET status = 'VERIFIED',
            received_amount = ${params.receivedAmount},
            provider_transaction_id = ${params.providerTransactionId},
            verified_at = NOW(),
            updated_at = NOW()
        WHERE id = ${lockedTx.id}
      `;

      // 10. Cập nhật store_bank_accounts thành OWNERSHIP_VERIFIED
      await tx.$executeRaw`
        UPDATE store_bank_accounts
        SET verification_status = 'OWNERSHIP_VERIFIED',
            verified_at = NOW(),
            last_verified_at = NOW(),
            updated_at = NOW()
        WHERE id = ${lockedAccount.id}
      `;

      // Đồng bộ vào store_wallets nếu có
      await tx.$executeRaw`
        UPDATE store_wallets
        SET bank_name = ${lockedAccount.bank_name},
            bank_account_holder = ${lockedAccount.account_name},
            updated_at = NOW()
        WHERE store_id = ${lockedAccount.store_id}
      `;

      return {
        success: true,
        alreadyProcessed: false,
        transaction: {
          ...lockedTx,
          status: 'VERIFIED',
          received_amount: params.receivedAmount,
          provider_transaction_id: params.providerTransactionId,
        },
        bankAccount: lockedAccount,
      };
    });
  }
}
