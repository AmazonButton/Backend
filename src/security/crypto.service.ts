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
    if (!sig1 || !sig2 || sig1.length !== sig2.length) {
      return false;
    }
    return crypto.timingSafeEqual(Buffer.from(sig1, 'hex'), Buffer.from(sig2, 'hex'));
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
