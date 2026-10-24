import { PrismaClient } from '@prisma/client';
import { CryptoVaultUtil } from '../src/common/utils/crypto-vault.util';

const prisma = new PrismaClient();

export async function backfillAndVerifyWithdrawalSnapshots() {
  console.log('🔄 [Stage 1] Starting Safe Backfill for StoreWithdrawal Encrypted Snapshots...');

  const withdrawals = await prisma.storeWithdrawal.findMany();
  console.log(`📋 Found ${withdrawals.length} existing store_withdrawals records to inspect.`);

  let updatedCount = 0;
  for (const w of withdrawals) {
    if (!w.bankAccountEncrypted && (w as any).bankAccountNumber) {
      const plain = (w as any).bankAccountNumber;
      const encrypted = CryptoVaultUtil.encryptAccountNumber(plain);
      const hash = CryptoVaultUtil.hashAccountNumber(plain);
      const masked = CryptoVaultUtil.maskAccountNumber(plain);

      // Verify decryption immediately before writing
      const decrypted = CryptoVaultUtil.decryptAccountNumber(encrypted);
      if (decrypted !== plain) {
        throw new Error(`[CRITICAL] Decryption verification failed for withdrawal ${w.withdrawalId}! Plaintext mismatch.`);
      }

      await prisma.storeWithdrawal.update({
        where: { withdrawalId: w.withdrawalId },
        data: {
          bankAccountEncrypted: encrypted,
          bankAccountHash: hash,
          bankAccountMasked: masked,
          bankAccountNameSnapshot: w.bankAccountHolder || 'N/A',
          bankNameSnapshot: w.bankName || 'Ngân hàng',
          bankBinSnapshot: w.bankCode || '970422',
        },
      });
      updatedCount++;
    }
  }

  console.log(`✅ Backfilled ${updatedCount} withdrawal records with AES-256-GCM encrypted snapshots.`);

  // 100% Comprehensive Decryption Verification Pass
  const verifyList = await prisma.storeWithdrawal.findMany({
    where: { bankAccountEncrypted: { not: null } },
  });

  for (const v of verifyList) {
    if (v.bankAccountEncrypted) {
      const recovered = CryptoVaultUtil.decryptAccountNumber(v.bankAccountEncrypted);
      if ((v as any).bankAccountNumber && recovered !== (v as any).bankAccountNumber) {
        throw new Error(`[CRITICAL] Decryption post-check failed for withdrawal ID ${v.withdrawalId}!`);
      }
    }
  }

  console.log(`🎉 [Stage 1 SUCCESS] Verified decryption on all ${verifyList.length} encrypted withdrawal records.`);
  return { success: true, updatedCount, verifiedCount: verifyList.length };
}

if (require.main === module) {
  backfillAndVerifyWithdrawalSnapshots()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('❌ Backfill failed:', err);
      process.exit(1);
    });
}
