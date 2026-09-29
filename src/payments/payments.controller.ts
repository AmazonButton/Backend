import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  UseGuards,
  Request,
  HttpCode,
} from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { CreatePaymentLinkDto, PayosWebhookDto } from './dto/payment.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

@Controller('payments')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @UseGuards(JwtAuthGuard)
  @Post('payos/create-link')
  createLink(@Body() body: CreatePaymentLinkDto, @Request() req: any) {
    const userId = req.user?.userId ? BigInt(req.user.userId) : undefined;
    return this.paymentsService.createPayosPaymentLink(body, userId);
  }

  @HttpCode(200)
  @Post('payos/webhook')
  handleWebhook(@Body() body: PayosWebhookDto) {
    return this.paymentsService.handlePayosWebhook(body);
  }

  @Get(':id')
  getTransaction(@Param('id') id: string) {
    return this.paymentsService.getTransaction(id);
  }
}
