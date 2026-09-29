import {
  Injectable,
  BadRequestException,
  NotFoundException,
  InternalServerErrorException,
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

    const orderAmount = dto.amount || Number(order.totalAmount);
    if (!orderAmount || orderAmount < 1000) {
      throw new BadRequestException('Số tiền thanh toán phải từ 1,000 VND trở lên');
    }

    // Sinh orderCode ngẫu nhiên duy nhất dạng số nguyên dương cho PayOS (PayOS yêu cầu orderCode là int <= 9007199254740991)
    const orderCode = Math.floor(Date.now() / 1000) * 1000 + Math.floor(Math.random() * 1000);
    const description = (dto.description || `DH${order.orderCode || order.orderId}`).slice(0, 25);
    const returnUrl = dto.returnUrl || process.env.PAYOS_RETURN_URL || 'http://localhost:3000/payment/success';
    const cancelUrl = dto.cancelUrl || process.env.PAYOS_CANCEL_URL || 'http://localhost:3000/payment/cancel';

    // Tạo bản ghi PaymentTransaction ở trạng thái PENDING trước
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
          message: result.desc || 'Không thể tạo link thanh toán PayOS',
        });
      }

      return {
        success: true,
        message: 'Tạo link thanh toán PayOS thành công',
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
      throw new InternalServerErrorException('Lỗi kết nối tới cổng thanh toán PayOS');
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

    // Nếu đã hoàn thành hoặc thất bại trước đó, trả về idempotency OK
    if (transaction.status === 'PAID') {
      return { success: true, message: 'Already processed' };
    }

    if (code === '00' && data?.code === '00') {
      await this.paymentsRepo.updateTransactionStatus(
        transaction.paymentTransactionId,
        'PAID',
        new Date(),
      );
      await this.paymentsRepo.updateOrderStatus(transaction.orderId, 'CONFIRMED', 'PAID');
      this.logger.log(`[PayOS Webhook] Payment confirmed for Order #${transaction.orderId} (Transaction #${transaction.paymentTransactionId})`);
      return { success: true, message: 'Payment confirmed successfully' };
    } else {
      await this.paymentsRepo.updateTransactionStatus(transaction.paymentTransactionId, 'FAILED');
      this.logger.log(`[PayOS Webhook] Payment failed for Order #${transaction.orderId}`);
      return { success: true, message: 'Payment failed recorded' };
    }
  }

  async getTransaction(id: string) {
    const transaction = await this.paymentsRepo.findTransactionById(BigInt(id));
    if (!transaction) {
      throw new NotFoundException('Không tìm thấy thông tin giao dịch');
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
