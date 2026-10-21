import {
  Controller,
  Post,
  Req,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { DiditWebhookGuard } from './guards/didit-webhook.guard';
import { IdentityVerificationsService } from './identity-verifications.service';

@Controller('webhooks')
export class DiditWebhookController {
  constructor(private readonly service: IdentityVerificationsService) {}

  /**
   * POST /api/v1/webhooks/didit
   * Public webhook endpoint verified with HMAC-SHA256 timing-safe guard
   */
  @Post('didit')
  @UseGuards(DiditWebhookGuard)
  @HttpCode(HttpStatus.OK)
  async handleWebhook(@Req() req: any) {
    const rawBody: Buffer = req.rawBodyBuffer || req.rawBody;

    const result = await this.service.handleWebhook(rawBody, req.body);

    return {
      success: true,
      message: result.message,
    };
  }
}
