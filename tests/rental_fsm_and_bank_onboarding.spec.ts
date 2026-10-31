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
  // Wire in repository lookup & verify mock implementations
  let currentAccountStatus = 'PENDING';
  mockCustomersRepo.findCustomerBankAccountById = async (_cId: bigint, _aId: bigint) => ({
    id: BigInt(1),
    customerId: BigInt(55),
    bankBin: '970422',
    bankCode: 'MB',
    bankName: 'MB Bank',
    accountNumberMasked: masked,
    accountName: 'NGUYEN VAN A',
    verificationStatus: currentAccountStatus,
    isDefault: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  mockCustomersRepo.verifyCustomerBankAccount = async (_cId: bigint, _aId: bigint, status: string) => {
    currentAccountStatus = status;
  };

  // 5.1. Poll initial status -> must be PENDING
  const initialPoll = await customersService.getBankAccountVerificationStatus(customerUser, '1');
  assert.strictEqual(
    initialPoll.verificationStatus,
    'PENDING',
    'Initial bank account status must be PENDING for new customer onboard',
  );

  // 5.2. Non-matching name verification -> must reject and mark REJECTED
  const nonMatchingUser = { userId: BigInt(10), role: 'CUSTOMER', fullName: 'TRAN THI B' };
  await assert.rejects(
    async () => {
      await customersService.verifyBankAccount(nonMatchingUser, '1');
    },
    (err: any) => {
      assert.strictEqual(
        err.message.includes('không trùng khớp') || err.status === 400,
        true,
        `Expected rejection for non-matching name, got: ${err.message}`,
      );
      return true;
    },
    'Expected verifyBankAccount to reject when accountName does not match customer fullName',
  );
  assert.strictEqual(currentAccountStatus, 'REJECTED');

  // 5.3. Matching legal name verification -> must transition to VERIFIED
  const matchingUser = { userId: BigInt(10), role: 'CUSTOMER', fullName: 'Nguyen Van A' };
  const verifiedResult = await customersService.verifyBankAccount(matchingUser, '1');
  assert.strictEqual(verifiedResult.verificationStatus, 'VERIFIED');

  // 5.4. Polling after verification -> must return VERIFIED
  const verifiedPoll = await customersService.getBankAccountVerificationStatus(customerUser, '1');
  assert.strictEqual(verifiedPoll.verificationStatus, 'VERIFIED');

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
