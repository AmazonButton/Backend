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
import { CreatePaymentLinkDto, PayosWebhookDto, CancelPaymentLinkDto } from './dto/payment.dto';
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

    @UseGuards(JwtAuthGuard)
  @Get('payos/payment-requests/:id')
  async getPaymentLinkInfo(@Param('id') id: string) {
    const res = await this.paymentsService.getPaymentLinkInformation(id);
    return { success: true, data: res?.data || res };
  }

  @UseGuards(JwtAuthGuard)
  @Post('payos/payment-requests/:id/cancel')
  async cancelPaymentLink(@Param('id') id: string, @Body() body?: CancelPaymentLinkDto) {
    const res = await this.paymentsService.cancelPaymentLink(id, body?.cancellationReason);
    return { success: true, message: 'Đã hủy link thanh toán thành công', data: res?.data || res };
  }

  @UseGuards(JwtAuthGuard)
  @Get(':id')
  getTransaction(@Param('id') id: string, @Request() req: any) {
    return this.paymentsService.getTransaction(id, req.user);
  }
}
