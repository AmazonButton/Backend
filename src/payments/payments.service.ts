import { Injectable, Inject, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EventsGateway } from '../websocket/events.gateway';
import { PayOS } from '@payos/node';

export interface CreatePayosLinkDto {
  orderId?: string | number;
  amount?: number;
  description?: string;
  returnUrl?: string;
  cancelUrl?: string;
  buyerName?: string;
  buyerEmail?: string;
  buyerPhone?: string;
}

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  private payOS: PayOS | null = null;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(EventsGateway) private readonly eventsGateway: EventsGateway,
  ) {
    this.initPayOS();
  }

  private initPayOS() {
    const clientId = process.env.PAYOS_CLIENT_ID;
    const apiKey = process.env.PAYOS_API_KEY;
    const checksumKey = process.env.PAYOS_CHECKSUM_KEY;

    if (clientId && apiKey && checksumKey) {
      try {
        this.payOS = new PayOS({ clientId, apiKey, checksumKey });
        this.logger.log('Đã kết nối PayOS SDK với thông tin xác thực từ môi trường');
      } catch (err: any) {
        this.logger.error('Lỗi khởi tạo PayOS SDK:', err?.message);
      }
    }
  }

  async createPayosLink(data: CreatePayosLinkDto) {
    let order: any = null;
    if (data.orderId) {
      order = await this.prisma.order.findFirst({
        where: {
          OR: [
            { id: String(data.orderId) },
            { orderNumber: String(data.orderId) },
          ],
        },
        include: { items: true, customer: { include: { user: true } } },
      });
    }

    if (!order && !data.amount) {
      throw new BadRequestException('Không tìm thấy thông tin đơn hàng để thanh toán');
    }

    const orderNumber = order?.orderNumber || String(data.orderId || Date.now());
    const amount = Math.round(Number(order?.totalAmount ?? data.amount));
    if (!Number.isFinite(amount) || amount <= 0 || (order && Math.round(Number(data.amount || order.totalAmount)) !== amount)) {
      throw new BadRequestException('Số tiền thanh toán không khớp với đơn hàng');
    }
    let orderCode = order?.payosOrderCode || Number(orderNumber.replace(/\D/g, '').slice(-8)) || Math.floor(100000 + Math.random() * 900000);
    if (order && !order.payosOrderCode) {
      while (await this.prisma.order.findUnique({ where: { payosOrderCode: orderCode } })) {
        orderCode = Math.floor(100000 + Math.random() * 900000);
      }
    }
    const description = `SOB ${orderNumber}`.substring(0, 25);

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    const returnUrl = data.returnUrl || `${frontendUrl}/customer/home?payos_status=success&orderId=${order?.id || orderNumber}`;
    const cancelUrl = data.cancelUrl || `${frontendUrl}/customer/home?payos_status=cancelled&orderId=${order?.id || orderNumber}`;

    const items = order?.items?.map((it: any) => ({
      name: it.productName || 'Sản phẩm',
      quantity: it.quantity || 1,
      price: Math.round(it.unitPrice || it.price || (amount / (it.quantity || 1))),
    })) || [
      { name: `Đơn hàng ${orderNumber}`, quantity: 1, price: amount }
    ];

    if (!this.payOS) {
      this.initPayOS();
    }

    if (!this.payOS) {
      throw new BadRequestException(
        'Chưa cấu hình API PayOS thực tế. Vui lòng cấu hình PAYOS_CLIENT_ID, PAYOS_API_KEY, PAYOS_CHECKSUM_KEY trong file .env để tạo liên kết thanh toán PayOS.'
      );
    }

    try {
      let paymentResponse: any = null;
      if (order?.payosOrderCode) {
        try {
          const existingPayment = await this.payOS.paymentRequests.get(orderCode);
          if (existingPayment.status !== 'CANCELLED') paymentResponse = existingPayment;
          else orderCode = await this.newPayosOrderCode();
        } catch (error: any) {
          if (Number(error?.status) !== 404) throw error;
          orderCode = await this.newPayosOrderCode();
        }
      }
      if (!paymentResponse) {
        paymentResponse = await this.payOS.paymentRequests.create({
          orderCode,
          amount,
          description,
          items,
          returnUrl,
          cancelUrl,
          buyerName: data.buyerName || order?.customerName || order?.customer?.user?.fullName,
          buyerPhone: data.buyerPhone || order?.customerPhone,
        });
      }

      if (order) {
        await this.prisma.order.update({
          where: { id: order.id },
          data: {
            paymentMethod: 'PAYOS',
            paymentStatus: order.paymentStatus === 'PAID' ? 'PAID' : 'PENDING',
            payosOrderCode: orderCode,
          },
        });
      }

      return {
        success: true,
        data: {
          ...paymentResponse,
          orderId: order?.id,
          orderNumber,
        },
      };
    } catch (err: any) {
      this.logger.error('Gọi API PayOS thất bại:', err?.message || err);
      throw new BadRequestException(err?.message || 'Lỗi khi gọi API PayOS thực tế');
    }
  }

  async getPaymentLinkInfo(paymentRequestId: string | number) {
    if (!this.payOS) {
      this.initPayOS();
    }

    if (this.payOS) {
      try {
        const orderCode = Number(String(paymentRequestId).replace(/\D/g, '')) || Number(paymentRequestId);
        const info = await this.payOS.paymentRequests.get(orderCode);
        if ((info as any).status === 'PAID') {
          await this.markPayosOrderPaid(Number((info as any).orderCode || orderCode), Number((info as any).amount));
        }
        return { success: true, data: info };
      } catch (err: any) {
        this.logger.warn('Tra cứu PayOS theo mã đơn thất bại:', err?.message);
      }
    }

    // Tra cứu đơn hàng thực tế trong database Prisma
    const order = await this.prisma.order.findFirst({
      where: {
        OR: [{ id: String(paymentRequestId) }, { orderNumber: String(paymentRequestId) }],
      },
      include: { items: true },
    });

    if (order) {
      return {
        success: true,
        data: {
          orderId: order.id,
          orderNumber: order.orderNumber,
          amount: order.totalAmount,
          status: order.paymentStatus,
          paymentMethod: order.paymentMethod,
          items: order.items,
        },
      };
    }

    throw new NotFoundException(`Không tìm thấy đơn hàng "${paymentRequestId}"`);
  }

  async selectPaymentMethod(orderId: string, customerProfileId: string, paymentMethod: string) {
    if (!['PAYOS', 'CASH_ON_DELIVERY'].includes(paymentMethod)) {
      throw new BadRequestException('Phương thức thanh toán không hợp lệ');
    }
    const order = await this.prisma.order.findFirst({ where: { id: orderId, customerId: customerProfileId } });
    if (!order) throw new NotFoundException('Không tìm thấy đơn hàng');
    if (order.status !== 'PENDING') throw new BadRequestException('Chỉ có thể chọn thanh toán cho đơn đang chờ cửa hàng');
    if (order.paymentStatus === 'PAID') throw new BadRequestException('Đơn hàng đã được thanh toán');
    if (paymentMethod === 'CASH_ON_DELIVERY' && order.payosOrderCode) {
      if (!this.payOS) this.initPayOS();
      if (!this.payOS) throw new BadRequestException('Không thể đổi sang tiền mặt khi chưa xác minh được trạng thái link PayOS');
      try {
        const payosPayment = await this.payOS.paymentRequests.get(order.payosOrderCode);
        if (payosPayment.status === 'PAID') {
          await this.markPayosOrderPaid(order.payosOrderCode, Number(payosPayment.amount));
          throw new BadRequestException('Giao dịch PayOS đã thanh toán; không thể đổi sang COD');
        }
        if (payosPayment.status !== 'CANCELLED') {
          await this.payOS.paymentRequests.cancel(order.payosOrderCode, 'Khách hàng chọn thanh toán khi nhận hàng');
        }
      } catch (error: any) {
        if (error instanceof BadRequestException) throw error;
        throw new BadRequestException('Không hủy được link PayOS; hãy kiểm tra trạng thái thanh toán rồi thử lại');
      }
    }
    const updated = await this.prisma.order.update({
      where: { id: orderId },
      data: {
        paymentMethod,
        paymentStatus: paymentMethod === 'CASH_ON_DELIVERY' ? 'COD_DUE' : 'PENDING',
      },
      include: { items: true },
    });
    const payload = { order: updated, storeId: order.storeId, customerId: order.customerId };
    this.eventsGateway.emitToStore(order.storeId, 'ORDER_PAYMENT_CHANGED', payload);
    if (order.customerId) this.eventsGateway.emitToCustomer(order.customerId, 'ORDER_PAYMENT_CHANGED', payload);
    return { success: true, data: updated };
  }

  async handlePayosWebhook(body: any) {
    if (!this.payOS) this.initPayOS();
    if (!this.payOS) throw new BadRequestException('PayOS chưa được cấu hình');
    const webhookData = await this.payOS.webhooks.verify(body);
    if (webhookData.code === '00') {
      await this.markPayosOrderPaid(Number(webhookData.orderCode), Number(webhookData.amount));
    }
    return { success: true };
  }

  private async markPayosOrderPaid(orderCode: number, amount: number) {
    const order = await this.prisma.order.findUnique({ where: { payosOrderCode: orderCode } });
    if (!order) throw new NotFoundException(`Không tìm thấy đơn PayOS ${orderCode}`);
    if (Math.round(order.totalAmount) !== amount) throw new BadRequestException('Số tiền thanh toán không khớp đơn hàng');
    if (order.paymentStatus === 'PAID' || order.paymentStatus === 'REFUND_PENDING') return order;
    const updated = await this.prisma.$transaction(async (tx) => {
      const requiresRefund = ['CANCELLED', 'REJECTED'].includes(order.status);
      const paidOrder = await tx.order.update({
        where: { id: order.id },
        data: { paymentMethod: 'PAYOS', paymentStatus: requiresRefund ? 'REFUND_PENDING' : 'PAID', paidAt: order.paidAt || new Date() },
        include: { items: true },
      });
      if (requiresRefund) return paidOrder;
      const referenceId = `payos-order:${order.id}`;
      const existingCredit = await tx.storeWalletTransaction.findUnique({ where: { referenceId } });
      if (!existingCredit) {
        const creditAmount = Math.round(order.totalAmount);
        const wallet = await tx.storeWallet.upsert({ where: { storeId: order.storeId }, create: { storeId: order.storeId, balance: creditAmount }, update: { balance: { increment: creditAmount } } });
        await tx.storeWalletTransaction.create({
          data: { walletId: wallet.id, amount: creditAmount, type: 'ORDER_REVENUE', status: 'SUCCESS', description: `Doanh thu PayOS đơn #${order.orderNumber}`, referenceId },
        });
      }
      return paidOrder;
    });
    const payload = { order: updated, storeId: order.storeId, customerId: order.customerId };
    this.eventsGateway.emitToStore(order.storeId, 'ORDER_PAYMENT_CHANGED', payload);
    this.eventsGateway.emitToCustomer(order.customerId, 'ORDER_PAYMENT_CHANGED', payload);
    this.eventsGateway.emitGlobal('ORDER_PAYMENT_CHANGED', payload);
    return updated;
  }

  private async newPayosOrderCode() {
    let orderCode = Math.floor(100000 + Math.random() * 900000);
    while (await this.prisma.order.findUnique({ where: { payosOrderCode: orderCode } })) {
      orderCode = Math.floor(100000 + Math.random() * 900000);
    }
    return orderCode;
  }

  async cancelPaymentLink(paymentRequestId: string | number, reason?: string) {
    if (!this.payOS) {
      this.initPayOS();
    }

    if (this.payOS) {
      try {
        const orderCode = Number(String(paymentRequestId).replace(/\D/g, '')) || Number(paymentRequestId);
        await this.payOS.paymentRequests.cancel(orderCode, reason || 'Người dùng hủy thanh toán');
      } catch (e: any) {
        this.logger.warn('Hủy link trên PayOS cảnh báo:', e?.message);
      }
    }

    return { success: true, message: reason || 'Đã hủy link thanh toán' };
  }

  async getTransaction(transactionId: string | number) {
    return this.getPaymentLinkInfo(transactionId);
  }
}
