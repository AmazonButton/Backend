import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  ConflictException,
  NotFoundException,
  ForbiddenException,
  Inject,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CryptoService } from '../../security/crypto.service';

const nonceCache = new Map<string, number>();

setInterval(() => {
  const now = Date.now();
  for (const [nonce, expiresAt] of nonceCache.entries()) {
    if (expiresAt < now) {
      nonceCache.delete(nonce);
    }
  }
}, 60000);

@Injectable()
export class HmacAuthGuard implements CanActivate {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CryptoService) private readonly crypto: CryptoService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();

    const deviceId = req.headers['x-device-id'] as string;
    const timestampStr = req.headers['x-timestamp'] as string;
    const nonce = req.headers['x-nonce'] as string;
    const signature = req.headers['x-signature'] as string;

    if (!deviceId || !timestampStr || !nonce || !signature) {
      throw new UnauthorizedException(
        'Thiếu các headers bảo mật thiết bị (x-device-id, x-timestamp, x-nonce, x-signature)',
      );
    }

    let timestamp = parseInt(timestampStr, 10);
    // Normalize epoch seconds to epoch milliseconds if necessary
    if (timestamp < 100000000000) {
      timestamp = timestamp * 1000;
    }
    const now = Date.now();
    const driftSeconds = Math.abs(now - timestamp) / 1000;
    const isDev = process.env.NODE_ENV === 'development' || !process.env.NODE_ENV;
    if (isNaN(timestamp) || (!isDev && driftSeconds > 900)) {
      throw new UnauthorizedException(
        `Thời gian thiết bị không đồng bộ hoặc đã hết hạn (${Math.round(driftSeconds)}s lệch)`,
      );
    }

    const nonceKey = `${deviceId}:${nonce}`;
    if (nonceCache.has(nonceKey)) {
      throw new ConflictException({
        statusCode: 409,
        code: 'REPLAY_DETECTED',
        message: 'Nonce đã được sử dụng. Phát hiện dấu hiệu Replay Attack!',
      });
    }
    nonceCache.set(nonceKey, now + 120000);

    const button = await this.prisma.ioTButton.findUnique({
      where: { deviceId },
      include: {
        store: true,
        customer: { include: { user: true } },
        buttonProducts: { include: { product: true } },
      },
    });

    if (!button) {
      throw new NotFoundException(`Thiết bị nút bấm không tồn tại: ${deviceId}`);
    }

    if (button.status !== 'ACTIVE') {
      throw new ForbiddenException(`Thiết bị đang ở trạng thái không hoạt động (${button.status})`);
    }

    const deviceSecret = (button as any).deviceSecret || 'sec_smart_button_8829_wtr_key_99';
    const bodyString = JSON.stringify(req.body || {});
    const expectedSignature = this.crypto.calculateDeviceSignature(
      deviceSecret,
      deviceId,
      timestampStr,
      nonce,
      bodyString,
    );

    if (!this.crypto.safeCompare(signature, expectedSignature)) {
      console.warn(`[HMAC ERROR] Received sig: "${signature}"`);
      console.warn(`[HMAC ERROR] Expected sig: "${expectedSignature}"`);
      console.warn(`[HMAC ERROR] Payload: "${deviceId}:${timestampStr}:${nonce}:${bodyString}"`);
      throw new UnauthorizedException({
        statusCode: 401,
        code: 'INVALID_SIGNATURE',
        message: 'Chữ ký mã hóa của thiết bị không hợp lệ',
      });
    }

    req.device = button;
    return true;
  }
}
