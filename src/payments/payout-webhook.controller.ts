import {
  Controller,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  BadRequestException,
  Logger,
  Inject,
  forwardRef,
  Req,
  Optional,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { StoreWalletService } from '../store-wallet/store-wallet.service';
import { verifyPayoutSignature } from './payos.helper';

export interface PayosPayoutWebhookDto {
  code: string;
  desc: string;
  data: {
    id: string;
    referenceId: string;
    amount: number;
    description?: string;
    toBin?: string;
    toAccountNumber?: string;
    toAccountName?: string;
    state?: string;
    approvalState?: string;
    transactions?: Array<{
      id: string;
      referenceId: string;
      amount: number;
      state: string;
    }>;
  };
  signature: string;
}

@Controller('webhooks')
export class PayoutWebhookController {
  private readonly logger = new Logger(PayoutWebhookController.name);
  private readonly walletService: StoreWalletService;

  constructor(
    @Inject(forwardRef(() => StoreWalletService))
    walletServiceOrPrisma: any,
    @Optional() maybeWalletService?: StoreWalletService,
  ) {
    this.walletService = maybeWalletService || walletServiceOrPrisma;
  }

  @Post('payos/payout')
  @HttpCode(HttpStatus.OK)
  async handlePayoutWebhook(@Body() body: PayosPayoutWebhookDto, @Req() req?: any) {
    if (!body?.data || !body?.signature) {
      throw new BadRequestException('Webhook payload hoặc chữ ký không hợp lệ');
    }

    const checksumKey =
      process.env.PAYOS_PAYOUT_CHECKSUM_KEY?.trim() ||
      process.env.PAYOS_CHECKSUM_KEY?.trim();

    if (!checksumKey) {
      this.logger.error('PAYOS_PAYOUT_CHECKSUM_KEY chưa được cấu hình');
      throw new BadRequestException('Thiếu cấu hình khóa xác thực chi hộ');
    }

    // 1. Primary: Timing-safe HMAC-SHA256 verification on canonical sorted data (Official PayOS specification)
    let isValid = verifyPayoutSignature(body.data, body.signature, checksumKey);

    // 2. Secondary fallback: Raw body HMAC verification if rawBody buffer is present
    if (!isValid && req?.rawBody) {
      try {
        const rawHmac = crypto.createHmac('sha256', checksumKey).update(req.rawBody).digest('hex');
        isValid = crypto.timingSafeEqual(Buffer.from(rawHmac, 'hex'), Buffer.from(body.signature, 'hex'));
      } catch {
        isValid = false;
      }
    }

    if (!isValid) {
      this.logger.warn(`Chữ ký webhook PayOS Payout không khớp cho ref: ${body.data?.referenceId}`);
      throw new BadRequestException('Chữ ký webhook không hợp lệ');
    }

    // Delegate business processing and database transactions strictly to the Service & Repository layers
    return this.walletService.processPayoutWebhook(body.data, body.desc);
  }
}
