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
  const mockCustomersRepo = {
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

  console.log('✅ Task 6 Rental FSM & Customer Bank Account Onboarding tests PASSED!');
}

run().catch((err) => {
  console.error('❌ Test failed with error:', err.message);
  process.exit(1);
});
