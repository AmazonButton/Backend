import {
  Controller,
  Post,
  Body,
  UseGuards,
  UsePipes,
  ValidationPipe,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { BankVerificationService } from './bank-verification.service';
import { BankVerificationWebhookGuard } from './guards/bank-verification-webhook.guard';
import { BankVerificationWebhookDto } from './dto/bank-verification-webhook.dto';

@Controller('webhooks')
export class BankVerificationWebhookController {
  constructor(private readonly service: BankVerificationService) {}

  @Post('bank-verification')
  @HttpCode(HttpStatus.OK)
  @UseGuards(BankVerificationWebhookGuard)
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: false }))
  async handleWebhook(@Body() body: BankVerificationWebhookDto) {
    const result = await this.service.handleVerificationWebhook(body);
    return result;
  }
}
