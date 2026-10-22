import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  Logger,
  Inject,
} from '@nestjs/common';
import {
  BANK_VERIFICATION_PROVIDER_TOKEN,
  BankVerificationProvider,
} from '../providers/bank-verification.provider.interface';

@Injectable()
export class BankVerificationWebhookGuard implements CanActivate {
  private readonly logger = new Logger(BankVerificationWebhookGuard.name);

  constructor(
    @Inject(BANK_VERIFICATION_PROVIDER_TOKEN)
    private readonly provider: BankVerificationProvider,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();

    const signature =
      (req.headers['x-signature-v2'] as string) ||
      (req.headers['x-signature'] as string) ||
      (req.headers['x-payos-signature'] as string) ||
      req.body?.signature ||
      '';

    if (!signature) {
      this.logger.warn('[BankVerificationWebhookGuard] Missing signature header or field');
      throw new UnauthorizedException('Thiếu chữ ký xác thực webhook ngân hàng');
    }

    const rawBody: Buffer = req.rawBodyBuffer || req.rawBody;

    if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) {
      this.logger.warn('[BankVerificationWebhookGuard] Missing raw body buffer');
      throw new UnauthorizedException('Thiếu raw body hợp lệ, không thể xác thực HMAC');
    }

    const isValid = await this.provider.verifyWebhook(rawBody, signature, req.headers);

    if (!isValid) {
      this.logger.warn('[BankVerificationWebhookGuard] Invalid webhook signature');
      throw new UnauthorizedException('Chữ ký webhook xác minh ngân hàng không hợp lệ');
    }

    req.rawBodyBuffer = rawBody;
    return true;
  }
}
