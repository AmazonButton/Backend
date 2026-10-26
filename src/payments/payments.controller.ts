import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  UseGuards,
  Request,
  HttpCode,
  UsePipes,
  ValidationPipe,
  UseInterceptors,
} from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { CreatePaymentLinkDto, PayosWebhookDto, CancelPaymentLinkDto } from './dto/payment.dto';
import { ChangePaymentMethodDto } from './dto/change-payment-method.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { IdempotencyInterceptor } from '../common/idempotency/idempotency.interceptor';
import { Idempotent } from '../common/idempotency/idempotency.decorator';

@Controller('payments')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @UseGuards(JwtAuthGuard)
  @HttpCode(200)
  @Post('orders/:orderId/payment-method')
  async changePaymentMethod(
    @Param('orderId') orderId: string,
    @Body() body: ChangePaymentMethodDto,
    @Request() req?: any,
  ) {
    return this.paymentsService.changeOrderPaymentMethod(orderId, body, req.user);
  }

  @UseGuards(JwtAuthGuard)
  @UseInterceptors(IdempotencyInterceptor)
  @Post('payos/create-link')
  @Idempotent({ required: false, ttlSeconds: 86400 })
  createLink(@Body() body: CreatePaymentLinkDto, @Request() req: any) {
    const userId = req.user?.userId ? BigInt(req.user.userId) : undefined;
    return this.paymentsService.createPayosPaymentLink(body, userId);
  }

  @HttpCode(200)
  @Post('payos/webhook')
  @UsePipes(new ValidationPipe({ whitelist: false, forbidNonWhitelisted: false }))
  handleWebhook(@Body() body: PayosWebhookDto) {
    return this.paymentsService.handlePayosWebhook(body);
  }

    @UseGuards(JwtAuthGuard)
  @Get('payos/payment-requests/:id')
  async getPaymentLinkInfo(@Param('id') id: string, @Request() req: any = {}) {
    const res = await this.paymentsService.getPaymentLinkInformation(id, req?.user);
    return { success: true, data: res?.data || res };
  }

  @UseGuards(JwtAuthGuard)
  @Post('payos/payment-requests/:id/cancel')
  async cancelPaymentLink(@Param('id') id: string, @Body() body?: CancelPaymentLinkDto, @Request() req: any = {}) {
    const res = await this.paymentsService.cancelPaymentLink(id, body?.cancellationReason, req.user);
    return { success: true, message: 'Đã hủy link thanh toán thành công', data: res?.data || res };
  }

  @UseGuards(JwtAuthGuard)
  @Get(':id')
  getTransaction(@Param('id') id: string, @Request() req: any) {
    return this.paymentsService.getTransaction(id, req.user);
  }
}
