import { Injectable } from '@nestjs/common';
import * as crypto from 'crypto';

@Injectable()
export class CryptoService {
  calculateDeviceSignature(
    deviceSecret: string,
    deviceId: string,
    timestamp: string | number,
    nonce: string,
    bodyString: string,
  ): string {
    const payload = `${deviceId}:${timestamp}:${nonce}:${bodyString}`;
    return crypto.createHmac('sha256', deviceSecret).update(payload).digest('hex');
  }

  safeCompare(sig1: string, sig2: string): boolean {
    if (
      typeof sig1 !== 'string' ||
      typeof sig2 !== 'string' ||
      !sig1 ||
      !sig2 ||
      sig1.length !== sig2.length ||
      sig1.length % 2 !== 0 ||
      !/^[0-9a-fA-F]+$/.test(sig1) ||
      !/^[0-9a-fA-F]+$/.test(sig2)
    ) {
      return false;
    }
    const buf1 = Buffer.from(sig1, 'hex');
    const buf2 = Buffer.from(sig2, 'hex');
    if (buf1.length === 0 || buf1.length !== buf2.length) {
      return false;
    }
    return crypto.timingSafeEqual(buf1, buf2);
  }

  generateNonce(): string {
    return crypto.randomBytes(16).toString('hex');
  }

  generateOrderNumber(): string {
    const today = new Date();
    const datePart = today.toISOString().slice(0, 10).replace(/-/g, '');
    const randomSuffix = Math.floor(1000 + Math.random() * 9000);
    return `ORD-${datePart}-${randomSuffix}`;
  }
}
