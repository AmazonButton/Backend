import * as crypto from 'crypto';

export class CryptoVaultUtil {
  private static getKeyBuffer(): Buffer {
    const rawKey = process.env.BANK_ACCOUNT_ENCRYPTION_KEY || 'default_super_secure_32_byte_key_0123456789abcdef';
    if (/^[0-9a-fA-F]{64}$/.test(rawKey)) {
      return Buffer.from(rawKey, 'hex');
    }
    return crypto.createHash('sha256').update(rawKey).digest();
  }

  private static getSalt(): string {
    return process.env.BANK_ACCOUNT_HASH_SALT || 'salt_for_bank_account_hashing_sec';
  }

  /**
   * AES-256-GCM symmetric encryption with randomized 12-byte IV and Authentication Tag
   */
  static encryptAccountNumber(accountNumber: string): string {
    const cleanNumber = accountNumber.trim();
    const key = this.getKeyBuffer();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

    let encrypted = cipher.update(cleanNumber, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');

    return `${iv.toString('hex')}:${authTag}:${encrypted}`;
  }

  /**
   * AES-256-GCM decryption verifying the Auth Tag
   */
  static decryptAccountNumber(encryptedData: string): string {
    const parts = encryptedData.split(':');
    if (parts.length !== 3) {
      throw new Error('Định dạng dữ liệu số tài khoản mã hóa không hợp lệ');
    }

    const [ivHex, authTagHex, cipherHex] = parts;
    const key = this.getKeyBuffer();
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(cipherHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  }

  /**
   * Blind-index HMAC-SHA256 hash for search and unique constraints without plaintext
   */
  static hashAccountNumber(accountNumber: string): string {
    const cleanNumber = accountNumber.trim();
    const salt = this.getSalt();
    return crypto.createHmac('sha256', salt).update(cleanNumber).digest('hex');
  }

  /**
   * Mask account number for safe API response (e.g., '******789')
   */
  static maskAccountNumber(accountNumber: string): string {
    const clean = accountNumber.trim();
    if (!clean) return '******';
    const visibleLength = Math.min(3, Math.max(2, Math.floor(clean.length / 3)));
    const visiblePart = clean.slice(-visibleLength);
    return `******${visiblePart}`;
  }

  /**
   * Generate random alphanumeric verification reference code (e.g. 'VERIFY_8F3K2A')
   */
  static generateReferenceCode(prefix = 'VERIFY_'): string {
    const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // base32 human readable, no 0/O, 1/I
    let code = '';
    const bytes = crypto.randomBytes(6);
    for (let i = 0; i < 6; i++) {
      code += chars[bytes[i] % chars.length];
    }
    return `${prefix}${code}`;
  }
}
