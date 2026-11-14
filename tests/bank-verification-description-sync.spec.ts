import 'reflect-metadata';
import assert from 'node:assert/strict';
import { BankVerificationService } from '../src/bank-verification/bank-verification.service';
import { CryptoVaultUtil } from '../src/common/utils/crypto-vault.util';

async function run() {
  process.env.NODE_ENV = 'test';
  process.env.PLATFORM_BANK_BIN = '970422';
  process.env.PLATFORM_BANK_NAME = 'MBBank';
  process.env.PLATFORM_BANK_ACCOUNT_NUMBER = '0339898989';
  process.env.PLATFORM_BANK_ACCOUNT_HOLDER = 'CONG TY CP SMART ORDER';
  process.env.BANK_ACCOUNT_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  process.env.BANK_ACCOUNT_HASH_SALT = 'test_salt_bank_account_hash_sec_32chars';

  const mockRepo: any = {
    findReferenceCodeByOrderCode: async (orderCode: any) => {
      if (String(orderCode) === '1794646205936') return 'VERIFY_TRYXW9';
      return null;
    },
    findReferenceCodeByCompactSuffix: async (suffix: string) => {
      if (suffix.toUpperCase() === 'TRYXW9') return 'VERIFY_TRYXW9';
      return null;
    },
    findVerificationTransactionById: async (id: bigint) => null,
  };

  const service = new BankVerificationService({} as any, mockRepo, {} as any, {} as any);

  // 1. Check getTransferDescription
  const desc1 = service.getTransferDescription('VERIFY_TRYXW9', true);
  assert.equal(desc1, 'STRYXW9', 'Should strip VERIFY_ and prepend S to produce clean compact description');
  assert(desc1.length <= 9, 'Must be at most 9 characters for PayOS');
  assert(/^[A-Z0-9]+$/i.test(desc1), 'Must be purely alphanumeric with no underscore or special characters');

  // 2. formatVerificationTransaction formatting with PayOS linked session
  const mockTxWithPayos = {
    id: 112n,
    bankAccountId: 180n,
    referenceCode: 'VERIFY_TRYXW9',
    expectedAmount: 2000n,
    receivedAmount: null,
    providerTransactionId: '1794646205936',
    status: 'PENDING',
    refundStatus: null,
    failureReason: null,
    bankAccount: {
      storeId: 383n,
      bankBin: '970418',
      bankName: 'BIDV',
      accountName: 'TRAN TAN PHAT',
      accountNumberEncrypted: CryptoVaultUtil.encryptAccountNumber('1680567701'),
    },
  };

  const formatted = service.formatVerificationTransaction(mockTxWithPayos);
  assert.equal(formatted.referenceCode, 'VERIFY_TRYXW9');
  assert.equal(formatted.transferDescription, 'STRYXW9');
  assert(
    formatted.instructions.includes('STRYXW9'),
    `Instructions must include the compact transferDescription "STRYXW9", got: ${formatted.instructions}`,
  );
  assert(
    !formatted.instructions.includes('VERIFY_TRYXW9'),
    'Instructions must NOT display confusing long VERIFY_TRYXW9 code when PayOS is linked',
  );
  assert(
    formatted.qrCodeUrl.includes('addInfo=STRYXW9'),
    `QR code URL must embed compact description STRYXW9, got: ${formatted.qrCodeUrl}`,
  );

  // 3. Webhook resolution via compact S... description fallback
  const webhookDtoWithCompactDesc: any = {
    code: '00',
    desc: 'success',
    data: {
      orderCode: null, // orderCode not matching or null
      amount: 2000,
      description: 'CASSO6508 4 M7PgqqltRIJu0xjHqnHjXmrw STRYXW9- Ma GD ACSP lw513880',
      accountNumber: '0339898989',
      reference: 'FT26318402781441',
      transactionDateTime: '2026-11-14 16:50:00',
      counterAccountNumber: '1680567701',
      counterAccountName: 'TRAN TAN PHAT',
      counterAccountBankId: '01202001',
    },
    signature: 'mock_sig',
  };

  let capturedParams: any = null;
  mockRepo.executeAtomicWebhookVerificationTx = async (params: any) => {
    capturedParams = params;
    return { success: true, transaction: {}, bankAccount: {} };
  };

  const webhookResult = await service.handleVerificationWebhook(webhookDtoWithCompactDesc);
  assert(webhookResult.success, 'Webhook must successfully handle compact description');
  assert.equal(
    capturedParams.referenceCode,
    'VERIFY_TRYXW9',
    'Repository must receive resolved referenceCode VERIFY_TRYXW9 via findReferenceCodeByCompactSuffix',
  );

  console.log('PASS: Bank verification description synchronization & compact resolution test suite.');
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
