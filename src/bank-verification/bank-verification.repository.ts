import { normalizeBankBin, bankBinsMatch } from '../common/utils/bank-identifier.util';
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoVaultUtil } from '../common/utils/crypto-vault.util';
import { runWithTransactionRetry } from '../common/utils/transaction-retry.util';

export interface AtomicWebhookVerificationResult {
  success: boolean;
  alreadyProcessed?: boolean;
  needsRefund?: boolean;
  reason?: string;
  transaction?: any;
  bankAccount?: any;
  refundReference?: string;
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
    const existingDefault = await this.prisma.storeBankAccount.findFirst({
      where: { storeId: params.storeId, isDefault: true },
      select: { id: true, accountNumberHash: true },
    });
    const shouldBeDefault = !existingDefault || existingDefault.accountNumberHash === params.accountNumberHash;

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
        isDefault: shouldBeDefault,
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
    providerTransactionId?: string;
  }) {
    return this.prisma.bankAccountVerificationTransaction.create({
      data: {
        bankAccountId: params.bankAccountId,
        referenceCode: params.referenceCode,
        expectedAmount: params.expectedAmount,
        status: 'PENDING',
        expiresAt: params.expiresAt,
        providerTransactionId: params.providerTransactionId,
      },
    });
  }

  async findTransactionByReference(referenceCode: string) {
    return this.prisma.bankAccountVerificationTransaction.findFirst({
      where: { referenceCode },
      include: { bankAccount: true },
    });
  }

  /**
   * Issue 3 Fix: Look up a Store verification transaction by its PayOS orderCode or paymentLinkId.
   * Returns the referenceCode from DB without relying on description parsing.
   */
  async findReferenceCodeByOrderCode(orderCode: string | number): Promise<string | null> {
    const codeStr = String(orderCode);
    const tx = await this.prisma.bankAccountVerificationTransaction.findFirst({
      where: { providerTransactionId: codeStr },
      select: { referenceCode: true },
    });
    if (tx?.referenceCode) return tx.referenceCode;

    const receipt = await (this.prisma as any).storeBankInboundReceipt.findFirst({
      where: { providerTransactionId: codeStr },
      select: { verificationTx: { select: { referenceCode: true } } },
    });
    return receipt?.verificationTx?.referenceCode ?? null;
  }

  async updateTransactionRefundStatus(params: {
    transactionId: bigint;
    status: string;
    refundStatus: string;
    refundTransactionId?: string;
    refundedAt?: Date;
  }) {
    // NV-02: Prevent regressing transaction status if already terminal (REFUNDED)
    return this.prisma.bankAccountVerificationTransaction.updateMany({
      where: {
        id: params.transactionId,
        status: { not: 'REFUNDED' },
      },
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
    return runWithTransactionRetry(async () => {
      return this.prisma.$transaction(async (tx) => {
      // Lock store row with SELECT FOR UPDATE to prevent race conditions during default switch
      await tx.$queryRaw`
        SELECT store_id FROM store WHERE store_id = ${storeId} FOR UPDATE
      `;

      await tx.storeBankAccount.updateMany({
        where: { storeId },
        data: { isDefault: false },
      });

      const updated = await tx.storeBankAccount.update({
        where: { id: bankAccountId, storeId },
        data: { isDefault: true, updatedAt: new Date() },
      });

      // Sync store_wallets bankName and bankAccountHolder (Rule 13: Zero Plaintext Financial Storage)
      await tx.storeWallet.updateMany({
        where: { storeId },
        data: {
          bankName: updated.bankName,
          bankAccountHolder: updated.accountName,
          updatedAt: new Date(),
        },
      });

      return updated;
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
        failureReason: 'USER_CANCELLED',
        updatedAt: new Date(),
      },
    });
  }

  async findVerificationTransactionById(id: bigint) {
    return this.prisma.bankAccountVerificationTransaction.findUnique({
      where: { id },
      include: {
        bankAccount: {
          include: { store: true },
        },
      },
    });
  }

  async listVerificationTransactionsByStore(
    storeId: bigint,
    options: { skip: number; take: number; status?: string },
  ) {
    const where: any = {
      bankAccount: { storeId },
    };
    if (options.status) {
      where.status = options.status;
    }

    const [total, items] = await Promise.all([
      this.prisma.bankAccountVerificationTransaction.count({ where }),
      this.prisma.bankAccountVerificationTransaction.findMany({
        where,
        skip: options.skip,
        take: options.take,
        include: {
          bankAccount: true,
        },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    return { total, items };
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
    orderCode?: number | string;
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
          account_number_hash: string | null;
        }>
      >`
        SELECT id, store_id, bank_bin, bank_name, account_number_encrypted, account_name, account_number_hash
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

      // Evaluate sender evidence upfront
      const isMaskedSender = Boolean(
        params.senderAccountNumber && params.senderAccountNumber.includes('*'),
      );
      let senderEncrypted: string | null = null;
      let senderHash: string | null = null;
      const cleanSenderAcc = params.senderAccountNumber ? params.senderAccountNumber.trim() : null;
      const cleanSenderBin = normalizeBankBin(params.senderBankBin);

      if (cleanSenderAcc && !isMaskedSender) {
        try {
          senderEncrypted = CryptoVaultUtil.encryptAccountNumber(cleanSenderAcc);
          senderHash = CryptoVaultUtil.computeDeterministicAccountHash(cleanSenderAcc);
        } catch {
          senderEncrypted = null;
          senderHash = null;
        }
      }

      // Reliable sender evidence requires unmasked account, bank BIN, and successful encryption/hashing
      const hasReliableSenderEvidence = Boolean(
        cleanSenderAcc && !isMaskedSender && cleanSenderBin && senderEncrypted && senderHash,
      );

      // NV-01: Helper ensuring confirmed inbound bank credit is always recorded with a refund obligation
      const recordReceiptAndObligation = async (
        matchStatus: string,
        forcedRefundStatus?: string,
      ): Promise<string> => {
        let refundRef = `REF_ST_${lockedTx.id}`;
        try {
          const existingReceipts = await tx.$queryRaw<Array<{ id: bigint }>>`
            SELECT id FROM store_bank_inbound_receipts
            WHERE provider_transaction_id = ${params.providerTransactionId}
            LIMIT 1
          `;
          if (existingReceipts && existingReceipts.length > 0) {
            return `REF_ST_${existingReceipts[0].id}`;
          }

          // Rule (Issue 3): Receipt must ONLY store verifiable sender evidence.
          // Never substitute the store's registered account for unknown or masked sender.
          const receiptSenderEncrypted = hasReliableSenderEvidence ? senderEncrypted : null;
          const receiptSenderHash = hasReliableSenderEvidence ? senderHash : null;
          const receiptSenderBin = hasReliableSenderEvidence ? cleanSenderBin : null;

          const [receipt] = await tx.$queryRaw<Array<{ id: bigint }>>`
            INSERT INTO store_bank_inbound_receipts (
              verification_tx_id, provider_transaction_id, amount,
              sender_account_number_encrypted, sender_account_hash, sender_bank_bin,
              match_status, received_at, created_at
            ) VALUES (
              ${lockedTx.id}, ${params.providerTransactionId}, ${params.receivedAmount},
              ${receiptSenderEncrypted},
              ${receiptSenderHash},
              ${receiptSenderBin},
              ${matchStatus}, NOW(), NOW()
            ) RETURNING id
          `;

          if (receipt?.id) {
            refundRef = `REF_ST_${receipt.id}`;
            // Rule (Issue 2 & 3): If reliable sender evidence is missing/masked, refund MUST BE PENDING_MANUAL_REFUND
            // and target bank details MUST BE NULL (do NOT assign registered account).
            const effectiveRefundStatus = forcedRefundStatus
              ? forcedRefundStatus
              : hasReliableSenderEvidence
                ? 'PENDING_REFUND'
                : 'PENDING_MANUAL_REFUND';

            const targetBin = (hasReliableSenderEvidence && effectiveRefundStatus !== 'PENDING_MANUAL_REFUND')
              ? cleanSenderBin
              : null;
            const targetEncrypted = (hasReliableSenderEvidence && effectiveRefundStatus !== 'PENDING_MANUAL_REFUND')
              ? receiptSenderEncrypted
              : null;
            const targetHash = (hasReliableSenderEvidence && effectiveRefundStatus !== 'PENDING_MANUAL_REFUND')
              ? receiptSenderHash
              : null;

            await tx.$executeRaw`
              INSERT INTO store_bank_refund_obligations (
                receipt_id, refund_amount, refund_status, refund_reference,
                target_bank_bin, target_account_encrypted, target_account_hash,
                created_at, updated_at
              ) VALUES (
                ${receipt.id}, ${params.receivedAmount}, ${effectiveRefundStatus}, ${refundRef},
                ${targetBin}, ${targetEncrypted}, ${targetHash},
                NOW(), NOW()
              )
            `;
          }
        } catch (receiptErr: any) {
          this.logger.warn(`Could not insert store bank receipt: ${receiptErr.message}`);
        }
        return refundRef;
      };

      // Item B Fix: Inspect per-transfer receipt identity BEFORE checking verification session completion.
      const existingReceipts = await tx.$queryRaw<Array<{ id: bigint; match_status: string }>>`
        SELECT id, match_status FROM store_bank_inbound_receipts
        WHERE provider_transaction_id = ${params.providerTransactionId}
        LIMIT 1
      `;
      const isReplayReceipt = Boolean(existingReceipts && existingReceipts.length > 0);

      // 3. Kiểm tra Idempotency: nếu đã VERIFIED hoặc REFUNDED
      if (
        lockedTx.status === 'VERIFIED' ||
        lockedTx.status === 'REFUND_PENDING' ||
        lockedTx.status === 'REFUNDED'
      ) {
        if (isReplayReceipt) {
          return {
            success: true,
            alreadyProcessed: true,
            needsRefund: false,
            transaction: lockedTx,
            bankAccount: lockedAccount,
          };
        }

        // Distinct subsequent transfer reaching a completed session: record receipt and create refund obligation
        const refundRef = await recordReceiptAndObligation(
          'SUBSEQUENT_TRANSFER',
          hasReliableSenderEvidence ? 'PENDING_REFUND' : 'PENDING_MANUAL_REFUND',
        );

        return {
          success: true,
          alreadyProcessed: true,
          needsRefund: hasReliableSenderEvidence,
          refundReference: refundRef,
          transaction: lockedTx,
          bankAccount: lockedAccount,
        };
      }

      // 4. Kiểm tra hết hạn (Expired check)
      const now = new Date();
      if (new Date(lockedTx.expires_at) < now) {
        const refundStatus = hasReliableSenderEvidence ? 'PENDING_REFUND' : 'PENDING_MANUAL_REFUND';
        const needsRefund = hasReliableSenderEvidence;
        const refundRef = await recordReceiptAndObligation('EXPIRED', refundStatus);
        await tx.$executeRaw`
          UPDATE bank_account_verification_transactions
          SET status = 'EXPIRED',
              failure_reason = 'EXPIRED',
              received_amount = ${params.receivedAmount},
              provider_transaction_id = COALESCE(bank_account_verification_transactions.provider_transaction_id, ${params.orderCode ? String(params.orderCode) : null}, ${params.providerTransactionId}),
              refund_status = ${refundStatus},
              refund_transaction_id = ${refundRef},
              updated_at = NOW()
          WHERE id = ${lockedTx.id}
        `;
        return {
          success: false,
          reason: 'EXPIRED',
          needsRefund,
          refundReference: refundRef,
          transaction: {
            ...lockedTx,
            status: 'EXPIRED',
            failure_reason: 'EXPIRED',
            refund_status: refundStatus,
            provider_transaction_id: lockedTx.provider_transaction_id || (params.orderCode ? String(params.orderCode) : params.providerTransactionId),
          },
          bankAccount: lockedAccount,
        };
      }

      const expectedAmount = Number(lockedTx.expected_amount);

      // 5. Kiểm tra đúng số tiền (tính theo expected_amount trong DB)
      if (params.receivedAmount !== expectedAmount) {
        this.logger.warn(
          `[AtomicWebhookVerification] Số tiền không khớp cho ref ${params.referenceCode}: nhận ${params.receivedAmount}, kỳ vọng ${expectedAmount}`,
        );
        const refundStatus = hasReliableSenderEvidence ? 'PENDING_REFUND' : 'PENDING_MANUAL_REFUND';
        const needsRefund = hasReliableSenderEvidence;
        const refundRef = await recordReceiptAndObligation('AMOUNT_MISMATCH', refundStatus);
        await tx.$executeRaw`
          UPDATE bank_account_verification_transactions
          SET status = 'FAILED',
              failure_reason = 'AMOUNT_MISMATCH',
              received_amount = ${params.receivedAmount},
              provider_transaction_id = COALESCE(bank_account_verification_transactions.provider_transaction_id, ${params.orderCode ? String(params.orderCode) : null}, ${params.providerTransactionId}),
              refund_status = ${refundStatus},
              refund_transaction_id = ${refundRef},
              updated_at = NOW()
          WHERE id = ${lockedTx.id}
        `;
        return {
          success: false,
          reason: 'AMOUNT_MISMATCH',
          needsRefund,
          refundReference: refundRef,
          transaction: {
            ...lockedTx,
            status: 'FAILED',
            failure_reason: 'AMOUNT_MISMATCH',
            refund_status: refundStatus,
            provider_transaction_id: lockedTx.provider_transaction_id || (params.orderCode ? String(params.orderCode) : params.providerTransactionId),
          },
          bankAccount: lockedAccount,
        };
      }

      // 6. Kiểm tra chéo tài khoản nhận (destination account & BIN)
      const platformAcc = process.env.PLATFORM_BANK_ACCOUNT_NUMBER?.trim();
      const platformBin = process.env.PLATFORM_BANK_BIN?.trim();
      const isStrict =
        process.env.NODE_ENV === 'production' ||
        process.env.BANK_VERIFICATION_STRICT === 'true';

      const isPayosIntegratedTx = Boolean(
        lockedTx.provider_transaction_id &&
        ((params.providerTransactionId && lockedTx.provider_transaction_id === params.providerTransactionId) ||
         (params.orderCode && lockedTx.provider_transaction_id === String(params.orderCode)))
      );

      if (isStrict && !isPayosIntegratedTx) {
        if (!platformAcc || !params.destinationAccountNumber) {
          this.logger.warn(
            `[AtomicWebhookVerification] Thieu thong tin tai khoan nhan (ref: ${params.referenceCode})`,
          );
          const refundRef = await recordReceiptAndObligation('DESTINATION_ACCOUNT_UNVERIFIABLE', 'PENDING_MANUAL_REFUND');
          await tx.$executeRaw`
            UPDATE bank_account_verification_transactions
            SET status = 'FAILED',
                failure_reason = 'DESTINATION_ACCOUNT_UNVERIFIABLE',
                received_amount = ${params.receivedAmount},
                provider_transaction_id = COALESCE(bank_account_verification_transactions.provider_transaction_id, ${params.orderCode ? String(params.orderCode) : null}, ${params.providerTransactionId}),
                refund_status = 'PENDING_MANUAL_REFUND',
                refund_transaction_id = ${refundRef},
                updated_at = NOW()
            WHERE id = ${lockedTx.id}
          `;
          return {
            success: false,
            reason: 'DESTINATION_ACCOUNT_UNVERIFIABLE',
            needsRefund: false,
            refundReference: refundRef,
            transaction: {
              ...lockedTx,
              status: 'FAILED',
              failure_reason: 'DESTINATION_ACCOUNT_UNVERIFIABLE',
              refund_status: 'PENDING_MANUAL_REFUND',
              provider_transaction_id: lockedTx.provider_transaction_id || (params.orderCode ? String(params.orderCode) : params.providerTransactionId),
            },
            bankAccount: lockedAccount,
          };
        }

        if (!platformBin || !params.destinationBankBin) {
          this.logger.warn(
            `[AtomicWebhookVerification] Thieu thong tin BIN ngan hang nhan (ref: ${params.referenceCode})`,
          );
          const refundRef = await recordReceiptAndObligation('DESTINATION_BANK_UNVERIFIABLE', 'PENDING_MANUAL_REFUND');
          await tx.$executeRaw`
            UPDATE bank_account_verification_transactions
            SET status = 'FAILED',
                failure_reason = 'DESTINATION_BANK_UNVERIFIABLE',
                received_amount = ${params.receivedAmount},
                provider_transaction_id = COALESCE(bank_account_verification_transactions.provider_transaction_id, ${params.orderCode ? String(params.orderCode) : null}, ${params.providerTransactionId}),
                refund_status = 'PENDING_MANUAL_REFUND',
                refund_transaction_id = ${refundRef},
                updated_at = NOW()
            WHERE id = ${lockedTx.id}
          `;
          return {
            success: false,
            reason: 'DESTINATION_BANK_UNVERIFIABLE',
            needsRefund: false,
            refundReference: refundRef,
            transaction: {
              ...lockedTx,
              status: 'FAILED',
              failure_reason: 'DESTINATION_BANK_UNVERIFIABLE',
              refund_status: 'PENDING_MANUAL_REFUND',
              provider_transaction_id: lockedTx.provider_transaction_id || (params.orderCode ? String(params.orderCode) : params.providerTransactionId),
            },
            bankAccount: lockedAccount,
          };
        }
      }

      if (params.destinationAccountNumber && platformAcc) {
        if (params.destinationAccountNumber.trim() !== platformAcc && !isPayosIntegratedTx) {
          this.logger.warn(
            `[AtomicWebhookVerification] Tai khoan nhan khong khop nen tang (ref: ${params.referenceCode})`,
          );
          const refundRef = await recordReceiptAndObligation('DESTINATION_ACCOUNT_MISMATCH', 'PENDING_MANUAL_REFUND');
          await tx.$executeRaw`
            UPDATE bank_account_verification_transactions
            SET status = 'FAILED',
                failure_reason = 'DESTINATION_ACCOUNT_MISMATCH',
                received_amount = ${params.receivedAmount},
                provider_transaction_id = COALESCE(bank_account_verification_transactions.provider_transaction_id, ${params.orderCode ? String(params.orderCode) : null}, ${params.providerTransactionId}),
                refund_status = 'PENDING_MANUAL_REFUND',
                refund_transaction_id = ${refundRef},
                updated_at = NOW()
            WHERE id = ${lockedTx.id}
          `;
          return {
            success: false,
            reason: 'DESTINATION_ACCOUNT_MISMATCH',
            needsRefund: false,
            refundReference: refundRef,
            transaction: {
              ...lockedTx,
              status: 'FAILED',
              failure_reason: 'DESTINATION_ACCOUNT_MISMATCH',
              refund_status: 'PENDING_MANUAL_REFUND',
              provider_transaction_id: lockedTx.provider_transaction_id || (params.orderCode ? String(params.orderCode) : params.providerTransactionId),
            },
            bankAccount: lockedAccount,
          };
        }
      }

      if (params.destinationBankBin && platformBin) {
        if (!bankBinsMatch(params.destinationBankBin, platformBin) && !isPayosIntegratedTx) {
          this.logger.warn(
            `[AtomicWebhookVerification] BIN ngan hang nhan khong khop nen tang (ref: ${params.referenceCode})`,
          );
          const refundRef = await recordReceiptAndObligation('DESTINATION_BANK_MISMATCH', 'PENDING_MANUAL_REFUND');
          await tx.$executeRaw`
            UPDATE bank_account_verification_transactions
            SET status = 'FAILED',
                failure_reason = 'DESTINATION_BANK_MISMATCH',
                received_amount = ${params.receivedAmount},
                provider_transaction_id = COALESCE(bank_account_verification_transactions.provider_transaction_id, ${params.orderCode ? String(params.orderCode) : null}, ${params.providerTransactionId}),
                refund_status = 'PENDING_MANUAL_REFUND',
                refund_transaction_id = ${refundRef},
                updated_at = NOW()
            WHERE id = ${lockedTx.id}
          `;
          return {
            success: false,
            reason: 'DESTINATION_BANK_MISMATCH',
            needsRefund: false,
            refundReference: refundRef,
            transaction: {
              ...lockedTx,
              status: 'FAILED',
              failure_reason: 'DESTINATION_BANK_MISMATCH',
              refund_status: 'PENDING_MANUAL_REFUND',
              provider_transaction_id: lockedTx.provider_transaction_id || (params.orderCode ? String(params.orderCode) : params.providerTransactionId),
            },
            bankAccount: lockedAccount,
          };
        }
      }

      // 7. Kiểm tra chéo tài khoản gửi (sender account & BIN)
      // Point 2 Fix: Apply strict sender verification across ALL channels including PayOS!
      // PayOS transactions are NO LONGER exempted from sender checks.
      if (!params.senderAccountNumber) {
        this.logger.warn(
          `[AtomicWebhookVerification] Thieu thong tin tai khoan gui (ref: ${params.referenceCode})`,
        );
        const refundRef = await recordReceiptAndObligation('SENDER_ACCOUNT_UNVERIFIABLE', 'PENDING_MANUAL_REFUND');
        await tx.$executeRaw`
          UPDATE bank_account_verification_transactions
          SET status = 'FAILED',
              failure_reason = 'SENDER_ACCOUNT_UNVERIFIABLE',
              received_amount = ${params.receivedAmount},
              provider_transaction_id = COALESCE(bank_account_verification_transactions.provider_transaction_id, ${params.orderCode ? String(params.orderCode) : null}, ${params.providerTransactionId}),
              refund_status = 'PENDING_MANUAL_REFUND',
              refund_transaction_id = ${refundRef},
              updated_at = NOW()
          WHERE id = ${lockedTx.id}
        `;
        return {
          success: false,
          reason: 'SENDER_ACCOUNT_UNVERIFIABLE',
          needsRefund: false,
          refundReference: refundRef,
          transaction: {
            ...lockedTx,
            status: 'FAILED',
            failure_reason: 'SENDER_ACCOUNT_UNVERIFIABLE',
            refund_status: 'PENDING_MANUAL_REFUND',
            provider_transaction_id: lockedTx.provider_transaction_id || (params.orderCode ? String(params.orderCode) : params.providerTransactionId),
          },
          bankAccount: lockedAccount,
        };
      }

      if (!params.senderBankBin) {
        this.logger.warn(
          `[AtomicWebhookVerification] Thieu thong tin BIN ngan hang gui (ref: ${params.referenceCode})`,
        );
        const refundRef = await recordReceiptAndObligation('SENDER_BANK_UNVERIFIABLE', 'PENDING_MANUAL_REFUND');
        await tx.$executeRaw`
          UPDATE bank_account_verification_transactions
          SET status = 'FAILED',
              failure_reason = 'SENDER_BANK_UNVERIFIABLE',
              received_amount = ${params.receivedAmount},
              provider_transaction_id = COALESCE(bank_account_verification_transactions.provider_transaction_id, ${params.orderCode ? String(params.orderCode) : null}, ${params.providerTransactionId}),
              refund_status = 'PENDING_MANUAL_REFUND',
              refund_transaction_id = ${refundRef},
              updated_at = NOW()
          WHERE id = ${lockedTx.id}
        `;
        return {
          success: false,
          reason: 'SENDER_BANK_UNVERIFIABLE',
          needsRefund: false,
          refundReference: refundRef,
          transaction: {
            ...lockedTx,
            status: 'FAILED',
            failure_reason: 'SENDER_BANK_UNVERIFIABLE',
            refund_status: 'PENDING_MANUAL_REFUND',
            provider_transaction_id: lockedTx.provider_transaction_id || (params.orderCode ? String(params.orderCode) : params.providerTransactionId),
          },
          bankAccount: lockedAccount,
        };
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
          const refundRef = await recordReceiptAndObligation('SENDER_ACCOUNT_UNVERIFIABLE', 'PENDING_MANUAL_REFUND');
          await tx.$executeRaw`
            UPDATE bank_account_verification_transactions
            SET status = 'FAILED',
                failure_reason = 'SENDER_ACCOUNT_UNVERIFIABLE',
                received_amount = ${params.receivedAmount},
                provider_transaction_id = COALESCE(bank_account_verification_transactions.provider_transaction_id, ${params.orderCode ? String(params.orderCode) : null}, ${params.providerTransactionId}),
                refund_status = 'PENDING_MANUAL_REFUND',
                refund_transaction_id = ${refundRef},
                updated_at = NOW()
            WHERE id = ${lockedTx.id}
          `;
          return {
            success: false,
            reason: 'SENDER_ACCOUNT_UNVERIFIABLE',
            needsRefund: false,
            refundReference: refundRef,
            transaction: {
              ...lockedTx,
              status: 'FAILED',
              failure_reason: 'SENDER_ACCOUNT_UNVERIFIABLE',
              refund_status: 'PENDING_MANUAL_REFUND',
              provider_transaction_id: lockedTx.provider_transaction_id || (params.orderCode ? String(params.orderCode) : params.providerTransactionId),
            },
            bankAccount: lockedAccount,
          };
        }

        if (!plainRegisteredAcc) {
          this.logger.warn(
            `[AtomicWebhookVerification] So tai khoan sau giai ma rong (ref: ${params.referenceCode})`,
          );
          const refundRef = await recordReceiptAndObligation('SENDER_ACCOUNT_UNVERIFIABLE', 'PENDING_MANUAL_REFUND');
          await tx.$executeRaw`
            UPDATE bank_account_verification_transactions
            SET status = 'FAILED',
                failure_reason = 'SENDER_ACCOUNT_UNVERIFIABLE',
                received_amount = ${params.receivedAmount},
                provider_transaction_id = COALESCE(bank_account_verification_transactions.provider_transaction_id, ${params.orderCode ? String(params.orderCode) : null}, ${params.providerTransactionId}),
                refund_status = 'PENDING_MANUAL_REFUND',
                refund_transaction_id = ${refundRef},
                updated_at = NOW()
            WHERE id = ${lockedTx.id}
          `;
          return {
            success: false,
            reason: 'SENDER_ACCOUNT_UNVERIFIABLE',
            needsRefund: false,
            refundReference: refundRef,
            transaction: {
              ...lockedTx,
              status: 'FAILED',
              failure_reason: 'SENDER_ACCOUNT_UNVERIFIABLE',
              refund_status: 'PENDING_MANUAL_REFUND',
              provider_transaction_id: lockedTx.provider_transaction_id || (params.orderCode ? String(params.orderCode) : params.providerTransactionId),
            },
            bankAccount: lockedAccount,
          };
        }

        const cleanSender = params.senderAccountNumber.trim();
        // Point 4 Fix: Masked 4-digit suffix is strictly forbidden as proof of ownership.
        // Full account number must match exactly.
        if (cleanSender.includes('*')) {
          this.logger.warn(
            `[AtomicWebhookVerification] Tai khoan gui bi che (masked), khong du bang chung so huu (ref: ${params.referenceCode})`,
          );
          const refundRef = await recordReceiptAndObligation('SENDER_ACCOUNT_MASKED', 'PENDING_MANUAL_REFUND');
          await tx.$executeRaw`
            UPDATE bank_account_verification_transactions
            SET status = 'FAILED',
                failure_reason = 'SENDER_ACCOUNT_MASKED',
                received_amount = ${params.receivedAmount},
                provider_transaction_id = COALESCE(bank_account_verification_transactions.provider_transaction_id, ${params.orderCode ? String(params.orderCode) : null}, ${params.providerTransactionId}),
                refund_status = 'PENDING_MANUAL_REFUND',
                refund_transaction_id = ${refundRef},
                updated_at = NOW()
            WHERE id = ${lockedTx.id}
          `;
          return {
            success: false,
            reason: 'SENDER_ACCOUNT_MASKED',
            needsRefund: false,
            refundReference: refundRef,
            transaction: {
              ...lockedTx,
              status: 'FAILED',
              failure_reason: 'SENDER_ACCOUNT_MASKED',
              refund_status: 'PENDING_MANUAL_REFUND',
              provider_transaction_id: lockedTx.provider_transaction_id || (params.orderCode ? String(params.orderCode) : params.providerTransactionId),
            },
            bankAccount: lockedAccount,
          };
        }

        const isSenderAccountMatched = cleanSender === plainRegisteredAcc;

        if (!isSenderAccountMatched) {
          this.logger.warn(
            `[AtomicWebhookVerification] Tai khoan gui khong khop tai khoan can xac minh (ref: ${params.referenceCode})`,
          );
          const refundRef = await recordReceiptAndObligation('SENDER_ACCOUNT_MISMATCH', 'PENDING_MANUAL_REFUND');
          await tx.$executeRaw`
            UPDATE bank_account_verification_transactions
            SET status = 'FAILED',
                failure_reason = 'SENDER_ACCOUNT_MISMATCH',
                received_amount = ${params.receivedAmount},
                provider_transaction_id = COALESCE(bank_account_verification_transactions.provider_transaction_id, ${params.orderCode ? String(params.orderCode) : null}, ${params.providerTransactionId}),
                refund_status = 'PENDING_MANUAL_REFUND',
                refund_transaction_id = ${refundRef},
                updated_at = NOW()
            WHERE id = ${lockedTx.id}
          `;
          return {
            success: false,
            reason: 'SENDER_ACCOUNT_MISMATCH',
            needsRefund: false,
            refundReference: refundRef,
            transaction: {
              ...lockedTx,
              status: 'FAILED',
              failure_reason: 'SENDER_ACCOUNT_MISMATCH',
              refund_status: 'PENDING_MANUAL_REFUND',
              provider_transaction_id: lockedTx.provider_transaction_id || (params.orderCode ? String(params.orderCode) : params.providerTransactionId),
            },
            bankAccount: lockedAccount,
          };
        }
      }

      // An unresolved identifier is insufficient evidence, not proof of a different bank.
      if (params.senderBankBin && !normalizeBankBin(params.senderBankBin)) {
        const refundRef = await recordReceiptAndObligation('SENDER_BANK_UNVERIFIABLE', 'PENDING_MANUAL_REFUND');
        await tx.$executeRaw`
          UPDATE bank_account_verification_transactions
          SET status = 'PENDING', failure_reason = 'SENDER_BANK_UNVERIFIABLE',
              received_amount = ${params.receivedAmount},
              refund_status = 'PENDING_MANUAL_REFUND', refund_transaction_id = ${refundRef},
              updated_at = NOW()
          WHERE id = ${lockedTx.id}
        `;
        return {
          success: false, reason: 'SENDER_BANK_UNVERIFIABLE', needsRefund: false,
          refundReference: refundRef,
          transaction: { ...lockedTx, status: 'PENDING', failure_reason: 'SENDER_BANK_UNVERIFIABLE', refund_status: 'PENDING_MANUAL_REFUND' },
          bankAccount: lockedAccount,
        };
      }

      if (params.senderBankBin && lockedAccount.bank_bin) {
        if (!bankBinsMatch(params.senderBankBin, lockedAccount.bank_bin)) {
          this.logger.warn(
            `[AtomicWebhookVerification] BIN ngan hang gui khong khop tai khoan can xac minh (ref: ${params.referenceCode})`,
          );
          const refundRef = await recordReceiptAndObligation('SENDER_BANK_MISMATCH', 'PENDING_MANUAL_REFUND');
          await tx.$executeRaw`
            UPDATE bank_account_verification_transactions
            SET status = 'FAILED',
                failure_reason = 'SENDER_BANK_MISMATCH',
                received_amount = ${params.receivedAmount},
                provider_transaction_id = COALESCE(bank_account_verification_transactions.provider_transaction_id, ${params.orderCode ? String(params.orderCode) : null}, ${params.providerTransactionId}),
                refund_status = 'PENDING_MANUAL_REFUND',
                refund_transaction_id = ${refundRef},
                updated_at = NOW()
            WHERE id = ${lockedTx.id}
          `;
          return {
            success: false,
            reason: 'SENDER_BANK_MISMATCH',
            needsRefund: false,
            refundReference: refundRef,
            transaction: {
              ...lockedTx,
              status: 'FAILED',
              failure_reason: 'SENDER_BANK_MISMATCH',
              refund_status: 'PENDING_MANUAL_REFUND',
              provider_transaction_id: lockedTx.provider_transaction_id || (params.orderCode ? String(params.orderCode) : params.providerTransactionId),
            },
            bankAccount: lockedAccount,
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

      // 9. Lưu biên lai thực nhận (store_bank_inbound_receipts) và tạo nghĩa vụ hoàn tiền (store_bank_refund_obligations)
      const refundReference = await recordReceiptAndObligation('MATCHED');

      await tx.$executeRaw`
        UPDATE bank_account_verification_transactions
        SET status = 'VERIFIED',
            received_amount = ${params.receivedAmount},
            provider_transaction_id = COALESCE(bank_account_verification_transactions.provider_transaction_id, ${params.orderCode ? String(params.orderCode) : null}, ${params.providerTransactionId}),
            refund_status = 'PENDING_REFUND',
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
        needsRefund: true,
        refundReference,
        transaction: {
          ...lockedTx,
          status: 'VERIFIED',
          received_amount: params.receivedAmount,
          provider_transaction_id: lockedTx.provider_transaction_id || (params.orderCode ? String(params.orderCode) : params.providerTransactionId),
        },
        bankAccount: lockedAccount,
      };
    });
  }

  async findPendingStoreRefundObligations(limit = 10): Promise<any[]> {
    return this.prisma.$queryRaw<any[]>`
      SELECT id, receipt_id, refund_amount, refund_status, refund_reference,
             target_bank_bin, target_account_encrypted, target_account_hash,
             attempt_count, provider_payout_id
      FROM store_bank_refund_obligations
      WHERE refund_status IN ('PENDING_REFUND', 'PROCESSING')
        AND (lease_token IS NULL OR lease_expires_at IS NULL OR lease_expires_at < NOW())
      ORDER BY id ASC
      LIMIT ${limit}
    `;
  }

  async claimRefundObligationForDispatch(
    obligationId: bigint,
    leaseToken: string,
    leaseDurationMs = 60000,
  ): Promise<boolean> {
    const expiresAt = new Date(Date.now() + leaseDurationMs);
    const count = await this.prisma.$executeRaw`
      UPDATE store_bank_refund_obligations
      SET lease_token = ${leaseToken},
          lease_expires_at = ${expiresAt},
          attempt_count = attempt_count + 1,
          refund_status = 'PROCESSING',
          updated_at = NOW()
      WHERE id = ${obligationId}
        AND refund_status IN ('PENDING_REFUND', 'PROCESSING')
        AND (lease_token IS NULL OR lease_expires_at IS NULL OR lease_expires_at < NOW())
    `;
    return count === 1;
  }

  async finalizeObligationSuccessTx(
    obligationId: bigint,
    leaseToken: string,
    providerPayoutId: string,
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const count = await tx.$executeRaw`
        UPDATE store_bank_refund_obligations
        SET refund_status = 'REFUNDED',
            provider_payout_id = ${providerPayoutId},
            refunded_at = NOW(),
            lease_token = NULL,
            lease_expires_at = NULL,
            updated_at = NOW()
        WHERE id = ${obligationId}
          AND lease_token = ${leaseToken}
          AND refund_status = 'PROCESSING'
      `;
      if (count !== 1) return false;

      // Đồng bộ cập nhật giao dịch xác minh gốc sang REFUNDED
      await tx.$executeRaw`
        UPDATE bank_account_verification_transactions
        SET status = 'REFUNDED',
            refund_status = 'SUCCESS',
            refund_transaction_id = ${providerPayoutId},
            refunded_at = NOW(),
            updated_at = NOW()
        WHERE id = (
          SELECT r.verification_tx_id 
          FROM store_bank_inbound_receipts r
          JOIN store_bank_refund_obligations o ON o.receipt_id = r.id
          WHERE o.id = ${obligationId}
        )
      `;
      return true;
    });
  }

  async recordObligationReconciliationPending(
    obligationId: bigint,
    leaseToken: string,
    providerPayoutId: string | null,
    reason: string,
    backoffMs = 60000,
  ): Promise<boolean> {
    const nextReconcileAt = new Date(Date.now() + backoffMs);
    const count = await this.prisma.$executeRaw`
      UPDATE store_bank_refund_obligations
      SET refund_status = 'PENDING_RECONCILIATION',
          provider_payout_id = COALESCE(${providerPayoutId}, provider_payout_id),
          failure_reason = ${reason.slice(0, 255)},
          next_reconcile_at = ${nextReconcileAt},
          lease_token = NULL,
          lease_expires_at = NULL,
          updated_at = NOW()
      WHERE id = ${obligationId}
        AND lease_token = ${leaseToken}
        AND refund_status = 'PROCESSING'
    `;
    return count === 1;
  }

  async recordObligationTerminalFailure(
    obligationId: bigint,
    leaseToken: string,
    providerPayoutId: string | null,
    reason: string,
  ): Promise<boolean> {
    const count = await this.prisma.$executeRaw`
      UPDATE store_bank_refund_obligations
      SET refund_status = 'FAILED',
          provider_payout_id = COALESCE(${providerPayoutId}, provider_payout_id),
          failure_reason = ${reason.slice(0, 255)},
          lease_token = NULL,
          lease_expires_at = NULL,
          updated_at = NOW()
      WHERE id = ${obligationId}
        AND lease_token = ${leaseToken}
        AND refund_status = 'PROCESSING'
    `;
    return count === 1;
  }

  async findPendingStoreReconciliations(limit = 10): Promise<any[]> {
    return this.prisma.$queryRaw<any[]>`
      SELECT id, receipt_id, refund_amount, refund_status, refund_reference,
             provider_payout_id, target_bank_bin, target_account_encrypted, target_account_hash,
             attempt_count
      FROM store_bank_refund_obligations
      WHERE (refund_status = 'PENDING_RECONCILIATION' AND (next_reconcile_at IS NULL OR next_reconcile_at <= NOW()))
         OR (refund_status = 'PROCESSING' AND lease_expires_at < NOW())
      ORDER BY next_reconcile_at ASC NULLS FIRST, id ASC
      LIMIT ${limit}
    `;
  }

  async markObligationDispatchedByReference(
    refundReference: string,
    providerPayoutId?: string,
  ): Promise<boolean> {
    const count = await this.prisma.$executeRaw`
      UPDATE store_bank_refund_obligations
      SET refund_status = 'PENDING_RECONCILIATION',
          provider_payout_id = COALESCE(${providerPayoutId || null}, provider_payout_id),
          updated_at = NOW()
      WHERE refund_reference = ${refundReference}
        AND refund_status IN ('PENDING_REFUND', 'PROCESSING')
    `;
    return count > 0;
  }
}
