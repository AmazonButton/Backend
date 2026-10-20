import { Controller, Get, Post, Body, Param, Query, Inject, Request, UseGuards } from '@nestjs/common';
import { PaymentsService, CreatePayosLinkDto } from './payments.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

@Controller('payments')
export class PaymentsController {
  constructor(
    @Inject(PaymentsService) private readonly paymentsService: PaymentsService,
  ) {}

  @Post('payos/create-link')
  async createPayosLink(@Body() body: CreatePayosLinkDto) {
    return this.paymentsService.createPayosLink(body);
  }

  @Get('payos/payment-requests/:id')
  async getPaymentLinkInfo(@Param('id') id: string) {
    return this.paymentsService.getPaymentLinkInfo(id);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('CUSTOMER')
  @Post('orders/:id/payment-method')
  async selectPaymentMethod(
    @Request() req: any,
    @Param('id') id: string,
    @Body('paymentMethod') paymentMethod: string,
  ) {
    return this.paymentsService.selectPaymentMethod(id, req.user.customerProfileId, paymentMethod);
  }

  @Post('payos/webhook')
  async payosWebhook(@Body() body: any) {
    return this.paymentsService.handlePayosWebhook(body);
  }

  @Post('payos/payment-requests/:id/cancel')
  async cancelPaymentLink(
    @Param('id') id: string,
    @Body('cancellationReason') reason?: string,
  ) {
    return this.paymentsService.cancelPaymentLink(id, reason);
  }

  @Get(':transactionId')
  async getTransaction(@Param('transactionId') id: string) {
    return this.paymentsService.getTransaction(id);
  }
}
