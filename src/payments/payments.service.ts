import {
  Injectable,
  BadRequestException,
  NotFoundException,
  InternalServerErrorException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { PaymentsRepository } from './payments.repository';
import { CreatePaymentLinkDto, PayosWebhookDto } from './dto/payment.dto';
import { signPaymentRequest, verifyWebhookSignature } from './payos.helper';

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(private readonly paymentsRepo: PaymentsRepository) {}

  async createPayosPaymentLink(dto: CreatePaymentLinkDto, userId?: bigint) {
    const rawOrderId = BigInt(dto.orderId);
    const order = await this.paymentsRepo.findOrderById(rawOrderId);

    if (!order) {
      throw new NotFoundException({
        success: false,
        code: 'ORDER_NOT_FOUND',
        message: `Không tìm thấy đơn hàng với mã #${dto.orderId}`,
      });
    }

    // Ownership verification (Anti-BOLA/IDOR)
    if (userId) {
      const isCustomerOwner = (order as any).customer && (order as any).customer.userId === userId;
      const isStoreOwner = (order as any).store && (order as any).store.ownerUserId === userId;
      if (!isCustomerOwner && !isStoreOwner) {
        throw new ForbiddenException({
          success: false,
          code: 'ORDER_ACCESS_DENIED',
          message: 'Bạn không có quyền tạo liên kết thanh toán cho đơn hàng này',
        });
      }
    }

    const clientId = process.env.PAYOS_CLIENT_ID?.trim();
    const apiKey = process.env.PAYOS_API_KEY?.trim();
    const checksumKey = process.env.PAYOS_CHECKSUM_KEY?.trim();

    if (!clientId || !apiKey || !checksumKey) {
      throw new InternalServerErrorException({
        success: false,
        code: 'PAYOS_CONFIG_MISSING',
        message: 'Chưa cấu hình đầy đủ PAYOS_CLIENT_ID, PAYOS_API_KEY, PAYOS_CHECKSUM_KEY trong server .env',
      });
    }

    // Strict security: Enforce official order totalAmount from DB (ignore client dto.amount to prevent tampering)
    const orderAmount = Number(order.totalAmount);
    if (!orderAmount || orderAmount < 1000) {
      throw new BadRequestException('S? ti?n thanh to�n ph?i t? 1,000 VND tr? l�n');
    }

    // Sinh orderCode ng?u nhi�n duy nh?t d?ng s? nguy�n duong cho PayOS (PayOS y�u c?u orderCode l� int <= 9007199254740991)
    const orderCode = Math.floor(Date.now() / 1000) * 1000 + Math.floor(Math.random() * 1000);
    const description = (dto.description || `DH${order.orderCode || order.orderId}`).slice(0, 25);
    const returnUrl = dto.returnUrl || process.env.PAYOS_RETURN_URL || 'http://localhost:3000/payment/success';
    const cancelUrl = dto.cancelUrl || process.env.PAYOS_CANCEL_URL || 'http://localhost:3000/payment/cancel';

    // T?o b?n ghi PaymentTransaction ? tr?ng th�i PENDING tru?c
    const transaction = await this.paymentsRepo.createTransaction({
      orderId: rawOrderId,
      provider: 'PAYOS',
      transactionCode: orderCode.toString(),
      amount: orderAmount,
      paymentMethod: 'QR',
      status: 'PENDING',
    });

    const signature = signPaymentRequest(
      {
        amount: orderAmount,
        cancelUrl,
        description,
        orderCode,
        returnUrl,
      },
      checksumKey,
    );

    // Support local test mock
    if (process.env.PAYOS_MOCK_PAYMENT === 'true' || clientId === 'mock_client_id') {
      return {
        success: true,
        message: 'T?o link thanh to�n PayOS th�nh c�ng (mock)',
        data: {
          paymentTransactionId: transaction.paymentTransactionId.toString(),
          orderCode,
          amount: orderAmount,
          description,
          checkoutUrl: `https://pay.payos.vn/web/mock-${orderCode}`,
          qrCode: `00020101021238540010A000000727012600069704220112${orderCode}`,
          status: 'PENDING',
        },
      };
    }

    try {
      const response = await fetch('https://api-merchant.payos.vn/v2/payment-requests', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-client-id': clientId,
          'x-api-key': apiKey,
        },
        body: JSON.stringify({
          orderCode,
          amount: orderAmount,
          description,
          cancelUrl,
          returnUrl,
          signature,
        }),
      });

      const result = await response.json();

      if (result.code !== '00') {
        this.logger.error(`PayOS API error: ${result.desc || JSON.stringify(result)}`);
        await this.paymentsRepo.updateTransactionStatus(transaction.paymentTransactionId, 'FAILED');
        throw new BadRequestException({
          success: false,
          code: 'PAYOS_CREATION_FAILED',
          message: result.desc || 'Kh�ng th? t?o link thanh to�n PayOS',
        });
      }

      return {
        success: true,
        message: 'T?o link thanh to�n PayOS th�nh c�ng',
        data: {
          paymentTransactionId: transaction.paymentTransactionId.toString(),
          orderCode,
          amount: orderAmount,
          description,
          checkoutUrl: result.data.checkoutUrl,
          qrCode: result.data.qrCode,
          status: 'PENDING',
        },
      };
    } catch (err: any) {
      if (err instanceof BadRequestException) throw err;
      this.logger.error(`PayOS request failed: ${err.message}`);
      await this.paymentsRepo.updateTransactionStatus(transaction.paymentTransactionId, 'FAILED');
      throw new InternalServerErrorException('L?i k?t n?i t?i c?ng thanh to�n PayOS');
    }
  }

  async handlePayosWebhook(body: PayosWebhookDto) {
    const { code, data, signature } = body || {};
    const checksumKey = process.env.PAYOS_CHECKSUM_KEY?.trim() || '';

    if (!verifyWebhookSignature(data, signature, checksumKey)) {
      this.logger.warn(`[PayOS Webhook] Invalid signature for orderCode: ${data?.orderCode}`);
      return { success: false, message: 'Invalid signature' };
    }

    const orderCodeStr = data?.orderCode?.toString();
    const transaction = await this.paymentsRepo.findTransactionByCode(orderCodeStr);

    if (!transaction) {
      this.logger.warn(`[PayOS Webhook] Transaction not found for orderCode: ${orderCodeStr}`);
      return { success: false, message: 'Transaction not found' };
    }

    // N?u d� ho�n th�nh tru?c d�, tr? v? idempotency OK (Section 13)
    if (transaction.status === 'PAID') {
      return { success: true, message: 'Already processed' };
    }

    if (code === '00' && data?.code === '00') {
      // Validate currency: Must be VND
      if (data?.currency && data.currency.toUpperCase() !== 'VND') {
        this.logger.warn(`[PayOS Webhook] Invalid currency: ${data.currency} for orderCode: ${orderCodeStr}`);
        return { success: false, message: 'Invalid currency' };
      }

      // Validate amount: Webhook amount must strictly equal transaction amount
      if (data?.amount !== undefined && Number(data.amount) !== Number(transaction.amount)) {
        this.logger.warn(`[PayOS Webhook] Amount mismatch: webhook amount=${data?.amount}, tx amount=${transaction.amount} for orderCode: ${orderCodeStr}`);
        return { success: false, message: 'Amount mismatch' };
      }

      // Validate paymentLinkId if transaction has linkId recorded
      if ((transaction as any).paymentLinkId && data?.paymentLinkId && (transaction as any).paymentLinkId !== data.paymentLinkId) {
        this.logger.warn(`[PayOS Webhook] Payment link ID mismatch for orderCode: ${orderCodeStr}`);
        return { success: false, message: 'Payment link ID mismatch' };
      }

      // Atomic update transaction to PAID and order to CONFIRMED (Escrow hold - no wallet credit yet)
      await this.paymentsRepo.confirmPaymentAtomicTx(
        transaction.paymentTransactionId,
      );
      this.logger.log(`[PayOS Webhook] Payment confirmed and marked as PAID (Escrow hold) for Order #${transaction.orderId} (Transaction #${transaction.paymentTransactionId})`);
      return { success: true, message: 'Payment confirmed successfully' };
    } else {
      await this.paymentsRepo.updateTransactionStatus(transaction.paymentTransactionId, 'FAILED');
      this.logger.log(`[PayOS Webhook] Payment failed for Order #${transaction.orderId}`);
      return { success: true, message: 'Payment failed recorded' };
    }
  }

  async getTransaction(id: string, user?: any) {
    if (!id || !/^\d+$/.test(id)) {
      throw new NotFoundException('Không tìm thấy thông tin giao dịch');
    }
    const transaction = await this.paymentsRepo.findTransactionById(BigInt(id));
    if (!transaction) {
      throw new NotFoundException('Không tìm thấy thông tin giao dịch');
    }

    // BOLA / IDOR Protection
    if (user) {
      const isSuperAdmin = user.role === 'SUPER_ADMIN' || user.role === 'SYSTEM_ADMIN';
      const isStoreStaff = user.storeId && transaction.order?.storeId && user.storeId.toString() === transaction.order.storeId.toString();
      const isCustomerOwner = user.customerProfileId && transaction.order?.customerId && user.customerProfileId.toString() === transaction.order.customerId.toString();

      if (!isSuperAdmin && !isStoreStaff && !isCustomerOwner) {
        throw new ForbiddenException('Bạn không có quyền truy cập thông tin giao dịch thanh toán này');
      }
    }

    return {
      success: true,
      data: {
        paymentTransactionId: transaction.paymentTransactionId.toString(),
        orderId: transaction.orderId.toString(),
        provider: transaction.provider,
        transactionCode: transaction.transactionCode,
        amount: Number(transaction.amount),
        paymentMethod: transaction.paymentMethod,
        status: transaction.status,
        paidAt: transaction.paidAt,
        createdAt: transaction.createdAt,
      },
    };
  }
}
