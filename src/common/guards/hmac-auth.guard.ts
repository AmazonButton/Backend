import * as nodeCrypto from 'crypto';
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
import { DevicesRepository } from '../../devices/devices.repository';
import { CryptoService } from '../../security/crypto.service';

@Injectable()
export class HmacAuthGuard implements CanActivate {
  constructor(
    @Inject(DevicesRepository) private readonly devicesRepo: DevicesRepository,
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
    if (timestamp < 100000000000) {
      timestamp = timestamp * 1000;
    }
    const now = Date.now();
    const driftSeconds = Math.abs(now - timestamp) / 1000;
    if (isNaN(timestamp) || driftSeconds > 300) {
      throw new UnauthorizedException(
        `Thời gian thiết bị không đồng bộ hoặc đã hết hạn (${Math.round(driftSeconds)}s lệch, tối đa 300s)`,
      );
    }

    const button = await this.devicesRepo.findByDeviceId(deviceId);

    if (!button) {
      throw new NotFoundException(`Thiết bị nút bấm không tồn tại: ${deviceId}`);
    }

    if (button.status !== 'ACTIVE') {
      throw new ForbiddenException(`Thiết bị đang ở trạng thái không hoạt động (${button.status})`);
    }

    const deviceSecret = (button as any).hmacSecret;
    if (!deviceSecret) {
      throw new UnauthorizedException({
        statusCode: 401,
        code: 'DEVICE_SECRET_NOT_CONFIGURED',
        message: 'Thiết bị chưa được cấu hình khóa bảo mật HMAC',
      });
    }

    // 1. Verify HMAC Signature FIRST (prevents Nonce Poisoning DoS)
    const bodyString = JSON.stringify(req.body || {});
    const expectedSignature = this.crypto.calculateDeviceSignature(
      deviceSecret,
      deviceId,
      timestampStr,
      nonce,
      bodyString,
    );

    if (!this.crypto.safeCompare(signature, expectedSignature)) {
      throw new UnauthorizedException({
        statusCode: 401,
        code: 'INVALID_SIGNATURE',
        message: 'Chữ ký mã hóa của thiết bị không hợp lệ',
      });
    }

    // 2. Consume Nonce ONLY AFTER signature is verified (Atomic Repository insert with TTL check)
    const consumed = await this.devicesRepo.consumeDeviceNonce(deviceId, nonce);

    if (!consumed) {
      throw new ConflictException({
        statusCode: 409,
        code: 'REPLAY_DETECTED',
        message: 'Nonce đã được sử dụng. Phát hiện dấu hiệu Replay Attack!',
      });
    }

    req.device = button;
    return true;
  }
}
