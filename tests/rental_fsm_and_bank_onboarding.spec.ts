import assert from 'node:assert';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { CustomersService } from '../src/customers/customers.service';
import { CryptoVaultUtil } from '../src/common/utils/crypto-vault.util';

async function run() {
  console.log('🧪 Testing Task 6: Rental FSM & Customer Bank Account Onboarding...');

  // Test 1: CryptoVaultUtil encrypts and hashes bank account cleanly
  const rawAcc = '19034567891234';
  const encrypted = CryptoVaultUtil.encryptAccountNumber(rawAcc);
  const deterministicHash = CryptoVaultUtil.computeDeterministicAccountHash(rawAcc);
  const masked = CryptoVaultUtil.maskAccountNumber(rawAcc);

  assert.notStrictEqual(encrypted, rawAcc, 'Account number must be encrypted');
  assert.strictEqual(masked.startsWith('******'), true, 'Masked number must start with ******');
  assert.strictEqual(masked.includes('234'), true, 'Masked number must show last digits');
  assert.strictEqual(masked.includes('190345'), false, 'Masked number must not leak leading digits');

  const decrypted = CryptoVaultUtil.decryptAccountNumber(encrypted);
  assert.strictEqual(decrypted, rawAcc, 'Decrypted account number must match original');

  // Test 2: Customer bank account onboarding service
  let persistedRecord: any = null;
  const mockCustomersRepo: any = {
    getCustomerProfileByUserId: async (userId: bigint) => ({
      customerId: BigInt(55),
      userId,
    }),
    createCustomerBankAccount: async (data: any) => {
      persistedRecord = { id: BigInt(1), ...data, verificationStatus: data.verificationStatus || 'PENDING', createdAt: new Date() };
      return persistedRecord;
    },
    findCustomerBankAccounts: async () => [
      {
        id: BigInt(1),
        customerId: BigInt(55),
        bankBin: '970422',
        bankCode: 'MB',
        bankName: 'MB Bank',
        accountNumberMasked: masked,
        accountName: 'NGUYEN VAN A',
        verificationStatus: 'PENDING',
        isDefault: true,
        createdAt: new Date(),
      },
    ],
  };

  const customersService = new CustomersService(mockCustomersRepo as any);

  const customerUser = { userId: BigInt(10), role: 'CUSTOMER' };
  const result = await customersService.addBankAccount(customerUser, {
    bankBin: '970422',
    bankCode: 'MB',
    bankName: 'MB Bank',
    accountNumber: rawAcc,
    accountName: 'NGUYEN VAN A',
    isDefault: true,
  });

  // Verify response envelope contains masked account and NO plaintext or encrypted secrets
  assert.strictEqual(result.accountNumberMasked, masked);
  assert.strictEqual((result as any).accountNumber, undefined, 'Plaintext account number must not be returned');
  assert.strictEqual((result as any).accountNumberEncrypted, undefined, 'Encrypted account number must not be in response');

  // Verify database persisted record has encrypted and hashed columns
  assert.notStrictEqual(persistedRecord.accountNumberEncrypted, rawAcc);
  assert.strictEqual(persistedRecord.accountNumberHash, deterministicHash);
  assert.strictEqual(persistedRecord.verificationStatus, 'PENDING');

  // Test 3: Input validation rejection for invalid BIN and invalid account number
  await assert.rejects(
    async () => {
      await customersService.addBankAccount(customerUser, {
        bankBin: '123',
        bankCode: 'MB',
        bankName: 'MB Bank',
        accountNumber: rawAcc,
        accountName: 'NGUYEN VAN A',
      });
    },
    (err: any) => {
      assert.strictEqual(err.message.includes('Mã BIN'), true);
      return true;
    },
  );

  await assert.rejects(
    async () => {
      await customersService.addBankAccount(customerUser, {
        bankBin: '970422',
        bankCode: 'MB',
        bankName: 'MB Bank',
        accountNumber: '1234',
        accountName: 'NGUYEN VAN A',
      });
    },
    (err: any) => {
      assert.strictEqual(err.message.includes('Số tài khoản'), true);
      return true;
    },
  );

  // Test 4: List customer bank accounts
  const list = await customersService.getBankAccounts(customerUser);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].accountNumberMasked, masked);

  // Test 5: Customer Bank Account Verification Workflow & Polling
  let currentAccountStatus = 'PENDING';
  const mockProofsTable: Record<string, any> = {};

  mockCustomersRepo.findCustomerBankAccountById = async (_cId: bigint, _aId: bigint) => ({
    id: BigInt(1),
    customerId: BigInt(55),
    bankBin: '970422',
    bankCode: 'MB',
    bankName: 'MB Bank',
    accountNumberMasked: masked,
    accountNumberHash: deterministicHash,
    accountName: 'NGUYEN VAN A',
    verificationStatus: currentAccountStatus,
    isDefault: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  mockCustomersRepo.createBankVerificationProof = async (data: any) => {
    const record = { id: BigInt(101), ...data, usedAt: null };
    mockProofsTable[data.proofReference] = record;
    return record;
  };

  mockCustomersRepo.findBankVerificationProof = async (ref: string) => {
    return mockProofsTable[ref] || null;
  };

  mockCustomersRepo.consumeBankVerificationProofTx = async (params: {
    proofReference: string;
    customerId: bigint;
    accountId: bigint;
  }) => {
    if (currentAccountStatus === 'VERIFIED') {
      return { alreadyVerified: true };
    }
    const proof = mockProofsTable[params.proofReference];
    if (!proof) {
      throw new BadRequestException('Bằng chứng xác minh không tồn tại hoặc không hợp lệ');
    }
    if (proof.customerId.toString() !== params.customerId.toString()) {
      throw new BadRequestException('Bằng chứng xác minh không thuộc về khách hàng này');
    }
    if (proof.accountId.toString() !== params.accountId.toString()) {
      throw new BadRequestException('Bằng chứng xác minh không khớp với tài khoản ngân hàng này');
    }
    if (proof.status !== 'SUCCESS') {
      throw new BadRequestException(
        `Bằng chứng xác minh đang ở trạng thái ${proof.status} (chưa được đối tác/ngân hàng xác nhận). Không thể hoàn tất xác minh.`,
      );
    }
    if (new Date(proof.expiresAt).getTime() <= Date.now()) {
      throw new BadRequestException('Bằng chứng xác minh đã hết hạn');
    }
    if (proof.usedAt !== null) {
      throw new ConflictException('Bằng chứng xác minh đã được sử dụng trước đó (Anti-replay)');
    }
    proof.usedAt = new Date();
    currentAccountStatus = 'VERIFIED';
    return { alreadyVerified: false };
  };

  mockCustomersRepo.confirmBankVerificationProof = async (params: any) => {
    const proof = mockProofsTable[params.proofReference];
    if (!proof) throw new NotFoundException('Không tìm thấy phiên xác minh ngân hàng');
    if (proof.usedAt !== null) {
      throw new ConflictException('Bằng chứng xác minh đã được sử dụng trước đó (đã tiêu thụ). Không thể thay đổi trạng thái.');
    }
    if (params.expectedBinding) {
      if (
        (params.expectedBinding.customerId && proof.customerId.toString() !== params.expectedBinding.customerId.toString()) ||
        (params.expectedBinding.accountId && proof.accountId.toString() !== params.expectedBinding.accountId.toString())
      ) {
        throw new BadRequestException('Thông tin xác minh từ provider không khớp với phiên đã khởi tạo');
      }
    }
    if (new Date(proof.expiresAt).getTime() <= Date.now()) {
      throw new BadRequestException('Phiên xác minh đã hết hạn');
    }
    if (proof.status === params.status) {
      return proof;
    }
    if (proof.status !== 'PENDING') {
      throw new ConflictException(
        `Phiên xác minh đã ở trạng thái kết thúc (${proof.status}). Không thể thay đổi sang ${params.status}`,
      );
    }
    proof.status = params.status;
    return proof;
  };

  // 5.1. Poll initial status -> must be PENDING
  const initialPoll = await customersService.getBankAccountVerificationStatus(customerUser, '1');
  assert.strictEqual(
    initialPoll.verificationStatus,
    'PENDING',
    'Initial bank account status must be PENDING for new customer onboard',
  );

  // 5.2. Arbitrary fake proof -> must reject
  await assert.rejects(
    async () => {
      await customersService.verifyBankAccount(customerUser, '1', { proofReference: 'not-a-real-proof' });
    },
    (err: any) => {
      assert.strictEqual(
        err.message.includes('không tồn tại hoặc không hợp lệ') || err.status === 400,
        true,
        `Expected rejection for arbitrary proof, got: ${err.message}`,
      );
      return true;
    },
    'Expected verifyBankAccount to reject arbitrary proof string',
  );
  assert.strictEqual(currentAccountStatus, 'PENDING');

  // 5.3. Legitimate initiate -> MUST CREATE PROOF WITH PENDING STATUS!
  const initiated = await customersService.initiateBankAccountVerification(customerUser, '1');
  assert.strictEqual(typeof initiated.proofReference, 'string');
  assert.strictEqual(
    initiated.status,
    'PENDING',
    'CRITICAL SECURITY REQUIREMENT: Bank verification initiation must always be PENDING until confirmed by provider',
  );

  // 5.4. Calling verify on a PENDING proof before independent confirmation -> MUST BE REJECTED!
  await assert.rejects(
    async () => {
      await customersService.verifyBankAccount(customerUser, '1', {
        proofReference: initiated.proofReference,
      });
    },
    (err: any) => {
      assert.strictEqual(
        err.message.includes('PENDING') || err.message.includes('chưa được đối tác/ngân hàng xác nhận') || err.status === 400,
        true,
        `Expected rejection when verifying PENDING proof, got: ${err.message}`,
      );
      return true;
    },
    'Expected verifyBankAccount to reject PENDING proof before provider confirmation',
  );
  assert.strictEqual(currentAccountStatus, 'PENDING');

  // 5.5. Provider callback with wrong customer or account binding -> MUST BE REJECTED!
  await assert.rejects(
    async () => {
      await customersService.confirmProviderBankVerification({
        proofReference: initiated.proofReference,
        expectedBinding: {
          customerId: BigInt(999), // Attacker customer!
          accountId: BigInt(1),
        },
        providerStatus: 'SUCCESS',
      });
    },
    (err: any) => {
      assert.strictEqual(err.status === 400 || err.message.includes('không khớp'), true);
      return true;
    },
    'Expected provider confirmation to reject mismatched customer',
  );

  // 5.6. Legitimate provider confirmation -> transitions proof status to SUCCESS
  const confirmedProof = await customersService.confirmProviderBankVerification({
    proofReference: initiated.proofReference,
    providerStatus: 'SUCCESS',
  });
  assert.strictEqual(confirmedProof.status, 'SUCCESS');

  // 5.6a. Duplicate callback with SAME terminal status -> MUST BE IDEMPOTENT (no error)
  const duplicateCallback = await customersService.confirmProviderBankVerification({
    proofReference: initiated.proofReference,
    providerStatus: 'SUCCESS',
  });
  assert.strictEqual(duplicateCallback.status, 'SUCCESS', 'Duplicate callback must be idempotent');

  // 5.6b. Out-of-order contradictory callback (sending FAILED to SUCCESS proof) -> MUST BE REJECTED with ConflictException
  await assert.rejects(
    async () => {
      await customersService.confirmProviderBankVerification({
        proofReference: initiated.proofReference,
        providerStatus: 'FAILED',
      });
    },
    (err: any) => {
      assert.strictEqual(
        err instanceof ConflictException || err.status === 409 || err.message.includes('trạng thái kết thúc'),
        true,
        `Expected ConflictException for contradictory callback, got: ${err.message}`,
      );
      return true;
    },
    'Expected out-of-order contradictory callback to be rejected',
  );

  // 5.7. Verification with verified proof -> transitions account to VERIFIED
  const verifiedResult = await customersService.verifyBankAccount(customerUser, '1', {
    proofReference: initiated.proofReference,
  });
  assert.strictEqual(verifiedResult.verificationStatus, 'VERIFIED');
  assert.strictEqual(currentAccountStatus, 'VERIFIED');

  // 5.8. Polling after verification -> must return VERIFIED
  const verifiedPoll = await customersService.getBankAccountVerificationStatus(customerUser, '1');
  assert.strictEqual(verifiedPoll.verificationStatus, 'VERIFIED');

  // 5.9. Concurrent / Replay consumption test:
  // If account is reset to PENDING and someone attempts to reuse the already-consumed proof -> MUST THROW 409 ConflictException!
  currentAccountStatus = 'PENDING';
  await assert.rejects(
    async () => {
      await customersService.verifyBankAccount(customerUser, '1', {
        proofReference: initiated.proofReference,
      });
    },
    (err: any) => {
      assert.strictEqual(
        err.message.includes('đã được sử dụng') || err.status === 409 || err.status === 400,
        true,
        `Expected ConflictException for reused proof, got: ${err.message}`,
      );
      return true;
    },
    'Expected verifyBankAccount to reject already-consumed proof (anti-replay single-use)',
  );
  // 5.9b. Callback after proof consumption -> MUST THROW ConflictException
  await assert.rejects(
    async () => {
      await customersService.confirmProviderBankVerification({
        proofReference: initiated.proofReference,
        providerStatus: 'SUCCESS',
      });
    },
    (err: any) => {
      assert.strictEqual(
        err instanceof ConflictException || err.status === 409 || err.message.includes('đã được sử dụng'),
        true,
        `Expected ConflictException when callback arrives after consumption, got: ${err.message}`,
      );
      return true;
    },
    'Expected callback after consumption to be rejected',
  );

  currentAccountStatus = 'VERIFIED';

  // Test 6: Concurrency & Lock Order (Customer Profile Row Lock)
  // Verify that createCustomerBankAccount locks customer_profile row even when 0 bank accounts exist
  let lockedCustomerProfile = false;
  const mockPrismaWithProfileLock = {
    $transaction: async (cb: any) => {
      const tx = {
        $queryRaw: async (query: any) => {
          const qStr = query.strings ? query.strings.join('') : String(query);
          if (qStr.includes('customer_profile') && qStr.includes('FOR UPDATE')) {
            lockedCustomerProfile = true;
          }
          return [];
        },
        customerBankAccount: {
          updateMany: async () => {},
          create: async (args: any) => ({
            id: BigInt(99),
            ...args.data,
          }),
        },
      };
      return cb(tx);
    },
  };

  const customersRepoWithLock = new (await import('../src/customers/customers.repository')).CustomersRepository(
    mockPrismaWithProfileLock as any,
  );

  await customersRepoWithLock.createCustomerBankAccount({
    customerId: BigInt(55),
    bankBin: '970422',
    bankName: 'MB Bank',
    accountNumberEncrypted: 'enc',
    accountNumberHash: 'hash',
    accountNumberMasked: '******1234',
    accountName: 'NGUYEN VAN A',
    isDefault: true,
  });

  assert.strictEqual(
    lockedCustomerProfile,
    true,
    'CRITICAL CONCURRENCY FLAW: customer_profile row must be locked with FOR UPDATE to prevent multiple default accounts',
  );

  console.log('✅ Task 6 Rental FSM & Customer Bank Account Onboarding tests PASSED!');
}

run().catch((err) => {
  console.error('❌ Test failed with error:', err.message);
  process.exit(1);
});
