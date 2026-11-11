import {
  Controller,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  Req,
  Logger,
  Inject,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { CustomerBankPennyVerificationService } from './customer-bank-penny-verification.service';
import { PayosWebhookPayloadDto } from './dto/payos-webhook-payload.dto';

@ApiTags('Webhooks')
@Controller('webhooks/payos')
export class CustomerBankWebhookController {
  private readonly logger = new Logger(CustomerBankWebhookController.name);

  constructor(
    @Inject(CustomerBankPennyVerificationService)
    private readonly pennyVerificationService: CustomerBankPennyVerificationService,
  ) {}

  @Post('customer-bank-verification')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Webhook nhận thông báo giao dịch chuyển khoản 2.000đ xác minh tài khoản khách hàng' })
  async handleCustomerBankVerificationWebhook(
    @Body() body: PayosWebhookPayloadDto,
    @Req() req?: any,
  ) {
    // 1. PayOS Webhook URL confirmation handshake (sent when updating webhook URL on PayOS dashboard)
    if ((body?.webhookUrl || (body as any)?.webhook_url) && !body?.data && !body?.signature) {
      const confirmedUrl = body.webhookUrl || (body as any).webhook_url;
      this.logger.log(`[PayOS Customer Bank Webhook] Acknowledged confirmation ping for webhookUrl: ${confirmedUrl}`);
      return {
        code: '00',
        desc: 'success',
        data: {
          webhookUrl: confirmedUrl,
        },
      };
    }

    this.logger.log(`Nhận webhook PayOS xác minh tài khoản: orderCode=${body?.data?.orderCode}`);
    return this.pennyVerificationService.processPayosVerificationWebhook(body, req?.rawBody);
  }
}
