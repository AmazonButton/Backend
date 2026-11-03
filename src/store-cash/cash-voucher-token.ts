import { createHash, randomBytes } from 'node:crypto';
import { cashVoucherTokenSchema } from './dto/store-cash.dto';

export function hashCashVoucherToken(token: string): string {
  // Do not include rejected input in an error message (QR tokens are secrets).
  if (!cashVoucherTokenSchema.safeParse(token).success) {
    throw new Error('Invalid cash voucher token format');
  }
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Token is returned once to its customer; persist ONLY tokenHash. */
export function createCashVoucherToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('hex');
  return { token, tokenHash: hashCashVoucherToken(token) };
}
