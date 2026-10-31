import assert from 'node:assert';
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

  mockCustomersRepo.consumeBankVerificationProof = async (proofId: bigint, _cId: bigint, _aId: bigint) => {
    for (const key of Object.keys(mockProofsTable)) {
      if (mockProofsTable[key].id === proofId) {
        mockProofsTable[key].usedAt = new Date();
      }
    }
    currentAccountStatus = 'VERIFIED';
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

  // 5.3. Proof belonging to another customer -> must reject
  mockProofsTable['PROOF_OTHER_CUST'] = {
    id: BigInt(102),
    proofReference: 'PROOF_OTHER_CUST',
    customerId: BigInt(999), // Different customer!
    accountId: BigInt(1),
    bankBin: '970422',
    accountNumberHash: deterministicHash,
    status: 'SUCCESS',
    expiresAt: new Date(Date.now() + 60000),
    usedAt: null,
  };
  await assert.rejects(
    async () => {
      await customersService.verifyBankAccount(customerUser, '1', { proofReference: 'PROOF_OTHER_CUST' });
    },
    (err: any) => {
      assert.strictEqual(
        err.message.includes('không thuộc về khách hàng này') || err.status === 400,
        true,
        `Expected rejection for other customer's proof, got: ${err.message}`,
      );
      return true;
    },
    'Expected verifyBankAccount to reject proof bound to another customer',
  );
  assert.strictEqual(currentAccountStatus, 'PENDING');

  // 5.4. Expired proof -> must reject
  mockProofsTable['PROOF_EXPIRED'] = {
    id: BigInt(103),
    proofReference: 'PROOF_EXPIRED',
    customerId: BigInt(55),
    accountId: BigInt(1),
    bankBin: '970422',
    accountNumberHash: deterministicHash,
    status: 'SUCCESS',
    expiresAt: new Date(Date.now() - 60000), // Expired!
    usedAt: null,
  };
  await assert.rejects(
    async () => {
      await customersService.verifyBankAccount(customerUser, '1', { proofReference: 'PROOF_EXPIRED' });
    },
    (err: any) => {
      assert.strictEqual(
        err.message.includes('hết hạn') || err.status === 400,
        true,
        `Expected rejection for expired proof, got: ${err.message}`,
      );
      return true;
    },
    'Expected verifyBankAccount to reject expired proof',
  );
  assert.strictEqual(currentAccountStatus, 'PENDING');

  // 5.5. Legitimate initiate + verify workflow
  const initiated = await customersService.initiateBankAccountVerification(customerUser, '1');
  assert.strictEqual(typeof initiated.proofReference, 'string');
  assert.strictEqual(initiated.status, 'SUCCESS');

  const verifiedResult = await customersService.verifyBankAccount(customerUser, '1', {
    proofReference: initiated.proofReference,
  });
  assert.strictEqual(verifiedResult.verificationStatus, 'VERIFIED');
  assert.strictEqual(currentAccountStatus, 'VERIFIED');

  // 5.6. Polling after verification -> must return VERIFIED
  const verifiedPoll = await customersService.getBankAccountVerificationStatus(customerUser, '1');
  assert.strictEqual(verifiedPoll.verificationStatus, 'VERIFIED');

  // 5.7. Replay attack: reusing the same proof must reject
  await assert.rejects(
    async () => {
      // Temporarily simulate account being PENDING again to test replay
      currentAccountStatus = 'PENDING';
      await customersService.verifyBankAccount(customerUser, '1', {
        proofReference: initiated.proofReference,
      });
    },
    (err: any) => {
      assert.strictEqual(
        err.message.includes('đã được sử dụng') || err.status === 400,
        true,
        `Expected rejection for reused proof, got: ${err.message}`,
      );
      return true;
    },
    'Expected verifyBankAccount to reject already-consumed proof (anti-replay)',
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
