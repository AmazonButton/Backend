import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import * as crypto from 'crypto';

@Injectable()
export class DiditWebhookGuard implements CanActivate {
  private readonly logger = new Logger(DiditWebhookGuard.name);

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const secret = process.env.DIDIT_WEBHOOK_SECRET;

    if (!secret) {
      this.logger.error('DIDIT_WEBHOOK_SECRET is not configured on server');
      throw new UnauthorizedException('Chữ ký webhook không thể xác thực do thiếu cấu hình');
    }

    const signatureHeader =
      (req.headers['x-signature-v2'] as string) ||
      (req.headers['x-signature'] as string) ||
      '';

    if (!signatureHeader) {
      this.logger.warn('[Didit Webhook] Missing signature header');
      throw new UnauthorizedException('Thiếu chữ ký xác thực webhook (x-signature-v2)');
    }

    const rawBody: Buffer = req.rawBodyBuffer || req.rawBody;

    if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) {
      this.logger.warn('[Didit Webhook] Missing or invalid raw webhook body byte buffer');
      throw new UnauthorizedException('Thiếu raw body webhook hợp lệ, không thể xác thực HMAC');
    }

    // Clean signature prefix if present (e.g., v2=..., sha256=...)
    let cleanSignature = signatureHeader.trim();
    if (cleanSignature.startsWith('v2=')) {
      cleanSignature = cleanSignature.substring(3);
    } else if (cleanSignature.startsWith('sha256=')) {
      cleanSignature = cleanSignature.substring(7);
    }

    // Compute expected HMAC-SHA256 signature
    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest('hex');

    const sigBuffer = Buffer.from(cleanSignature, 'hex');
    const expectedBuffer = Buffer.from(expectedSignature, 'hex');

    if (
      sigBuffer.length !== expectedBuffer.length ||
      !crypto.timingSafeEqual(sigBuffer, expectedBuffer)
    ) {
      this.logger.warn(
        `[Didit Webhook] Invalid signature: received=${cleanSignature.substring(0, 8)}...`,
      );
      throw new UnauthorizedException('Chữ ký webhook Didit không hợp lệ');
    }

    // Attach rawBody buffer and calculated hash for downstream idempotency checks
    req.rawBodyBuffer = rawBody;
    req.payloadHash = crypto.createHash('sha256').update(rawBody).digest('hex');

    return true;
  }
}
