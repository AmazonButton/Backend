const { PrismaClient } = require('@prisma/client');
const crypto = require('crypto');

const prisma = new PrismaClient();

function getKeyBuffer() {
  const rawKey = process.env.BANK_ACCOUNT_ENCRYPTION_KEY || 'default_super_secure_32_byte_key_0123456789abcdef';
  if (/^[0-9a-fA-F]{64}$/.test(rawKey)) {
    return Buffer.from(rawKey, 'hex');
  }
  return crypto.createHash('sha256').update(rawKey).digest();
}

function getSalt() {
  return process.env.BANK_ACCOUNT_HASH_SALT || 'salt_for_bank_account_hashing_sec';
}

function encryptAccountNumber(accountNumber) {
  const cleanNumber = accountNumber.trim();
  const key = getKeyBuffer();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  let encrypted = cipher.update(cleanNumber, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');

  return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

function decryptAccountNumber(encryptedData) {
  const parts = encryptedData.split(':');
  if (parts.length !== 3) {
    throw new Error('Định dạng dữ liệu số tài khoản mã hóa không hợp lệ');
  }

  const [ivHex, authTagHex, cipherHex] = parts;
  const key = getKeyBuffer();
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(cipherHex, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

function hashAccountNumber(accountNumber) {
  const cleanNumber = accountNumber.trim();
  const salt = getSalt();
  return crypto.createHmac('sha256', salt).update(cleanNumber).digest('hex');
}

function maskAccountNumber(accountNumber) {
  const clean = accountNumber.trim();
  if (!clean) return '******';
  const visibleLength = Math.min(3, Math.max(2, Math.floor(clean.length / 3)));
  const visiblePart = clean.slice(-visibleLength);
  return `******${visiblePart}`;
}

async function backfillAndVerifyWithdrawalSnapshots() {
  console.log('🔄 [Stage 1] Starting Safe Backfill for StoreWithdrawal Encrypted Snapshots...');

  const withdrawals = await prisma.storeWithdrawal.findMany();
  console.log(`📋 Found ${withdrawals.length} existing store_withdrawals records to inspect.`);

  let updatedCount = 0;
  for (const w of withdrawals) {
    if (!w.bankAccountEncrypted && w.bankAccountNumber) {
      const plain = w.bankAccountNumber;
      const encrypted = encryptAccountNumber(plain);
      const hash = hashAccountNumber(plain);
      const masked = maskAccountNumber(plain);

      const decrypted = decryptAccountNumber(encrypted);
      if (decrypted !== plain) {
        throw new Error(`[CRITICAL] Decryption verification failed for withdrawal ${w.withdrawalId}!`);
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

  const verifyList = await prisma.storeWithdrawal.findMany({
    where: { bankAccountEncrypted: { not: null } },
  });

  for (const v of verifyList) {
    if (v.bankAccountEncrypted) {
      const recovered = decryptAccountNumber(v.bankAccountEncrypted);
      if (v.bankAccountNumber && recovered !== v.bankAccountNumber) {
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
      console.error('❌ Backfill failed:', err.message);
      process.exit(1);
    });
}

module.exports = { backfillAndVerifyWithdrawalSnapshots };
