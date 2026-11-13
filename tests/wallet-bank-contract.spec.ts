import 'reflect-metadata';
import assert from 'node:assert/strict';
import { ValidationPipe } from '@nestjs/common';
import { UpdateBankAccountDto } from '../src/store-wallet/dto/wallet.dto';
import { StoreWalletRepository } from '../src/store-wallet/store-wallet.repository';
import { WalletMapper } from '../src/store-wallet/mappers/wallet.mapper';
import { CryptoVaultUtil } from '../src/common/utils/crypto-vault.util';

async function run() {
  process.env.NODE_ENV = 'test';
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
  const meta = { type: 'body' as const, metatype: UpdateBankAccountDto };
  const body = { bankName: 'TPBank', bankBin: '970423', bankAccountNumber: '123456789', bankAccountHolder: 'DUMMY OWNER' };
  assert.equal((await pipe.transform(body, meta)).bankBin, '970423');
  for (const invalid of [
    { ...body, bankBin: 'bad' }, { ...body, bankAccountNumber: '******1234' },
    { ...body, accountNumber: body.bankAccountNumber }, { ...body, bankBin: undefined },
  ]) await assert.rejects(pipe.transform(invalid, meta));

  async function save(oldBin: string | null) {
    let upsert: any;
    const tx = {
      $queryRaw: async () => [{ store_id: 1n }],
      storeBankAccount: {
        updateMany: async () => ({ count: 1 }),
        findUnique: async () => oldBin ? { bankBin: oldBin, verificationStatus: 'OWNERSHIP_VERIFIED' } : null,
        upsert: async (args: any) => {
          upsert = args;
          return { id: 1n, ...args.create, verificationStatus: oldBin && oldBin === body.bankBin ? 'OWNERSHIP_VERIFIED' : 'PENDING' };
        },
      },
      storeWallet: { update: async ({ data }: any) => ({ ...data, walletId: 1n, storeId: 1n }) },
    };
    const repo = new StoreWalletRepository({ $transaction: async (fn: any) => fn(tx) } as any);
    const wallet = await repo.updateBankAccountAtomicTx({ storeId: 1n, bankBin: body.bankBin, bankName: body.bankName,
      bankAccountHolder: body.bankAccountHolder, accountNumberHash: 'dummy-hash',
      accountNumberEncrypted: CryptoVaultUtil.encryptAccountNumber(body.bankAccountNumber), cleanAcc: body.bankAccountNumber });
    return { upsert, dto: WalletMapper.toWalletDto(wallet) };
  }
  const fresh = await save(null);
  assert.equal(fresh.upsert.create.bankBin, '970423');
  assert.equal(fresh.dto.bankAccount?.bankBin, '970423');
  assert(!JSON.stringify(fresh.dto).includes('123456789'));
  const changed = await save('970422');
  assert.equal(changed.upsert.update.bankBin, '970423');
  assert.equal(changed.upsert.update.verificationStatus, 'PENDING');
  assert.equal(changed.upsert.update.verifiedAt, null);
  const unchanged = await save('970423');
  assert.equal(unchanged.upsert.update.verificationStatus, undefined);
  console.log('PASS: canonical wallet DTO, selected BIN persistence, re-verification and masked response (mocked IO).');
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
