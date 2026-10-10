import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Decimal } from '@prisma/client/runtime/library';

@Injectable()
export class PaymentsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async createTransaction(data: {
    orderId: bigint;
    provider: string;
    transactionCode: string;
    amount: number | Decimal;
    paymentMethod: string;
    status: string;
  }) {
    return this.prisma.paymentTransaction.create({
      data: {
        orderId: data.orderId,
        provider: data.provider,
        transactionCode: data.transactionCode,
        amount: new Decimal(data.amount),
        paymentMethod: data.paymentMethod,
        status: data.status,
      },
    });
  }

  async findTransactionById(transactionId: bigint) {
    return this.prisma.paymentTransaction.findUnique({
      where: { paymentTransactionId: transactionId },
      include: { order: true },
    });
  }

  async findTransactionByCode(transactionCode: string) {
    return this.prisma.paymentTransaction.findFirst({
      where: { transactionCode },
      include: { order: true },
    });
  }

  async updateTransactionStatus(
    transactionId: bigint,
    status: string,
    paidAt?: Date,
  ) {
    return this.prisma.paymentTransaction.update({
      where: { paymentTransactionId: transactionId },
      data: {
        status,
        ...(paidAt ? { paidAt } : {}),
      },
    });
  }

  async updateOrderStatus(orderId: bigint, orderStatus: string, paymentStatus?: string) {
    return this.prisma.order.update({
      where: { orderId },
      data: {
        orderStatus,
        ...(paymentStatus ? { paymentStatus } : {}),
      },
    });
  }

  async findOrderById(orderId: bigint) {
    return this.prisma.order.findUnique({
      where: { orderId },
      include: { store: true, customer: true },
    });
  }

  async processPaymentCreditToWallet(paymentTransactionId: bigint) {
    return this.prisma.$transaction(async (tx) => {
      const payment = await tx.paymentTransaction.findUnique({
        where: { paymentTransactionId },
        include: { order: true },
      });

      if (!payment) {
        throw new Error('Payment transaction not found');
      }

      if (payment.status === 'PAID') {
        return { alreadyPaid: true, payment };
      }

      const updatedPayment = await tx.paymentTransaction.update({
        where: { paymentTransactionId },
        data: {
          status: 'PAID',
          paidAt: new Date(),
        },
      });

      const orderUpdateData: any = { paymentStatus: 'PAID' };
      if (payment.order && payment.order.orderStatus === 'PENDING') {
        orderUpdateData.orderStatus = 'CONFIRMED';
      }
      await tx.order.update({
        where: { orderId: payment.orderId },
        data: orderUpdateData,
      });

      // Ghi nhận lịch sử thanh toán
      if (payment.orderId) {
        await tx.orderStatusHistory.create({
          data: {
            orderId: payment.orderId,
            oldStatus: payment.order?.orderStatus || 'PENDING',
            newStatus: orderUpdateData.orderStatus || payment.order?.orderStatus || 'CONFIRMED',
            reason: `Thanh toán PayOS thành công (Mã GD: ${payment.transactionCode || paymentTransactionId})`,
          },
        });
      }

      // Theo BRD V2.1: Webhook chỉ xác nhận giao dịch PAID và chuyển đơn CONFIRMED.
      // Tuyệt đối KHÔNG cộng ví Store tại đây. Doanh thu net_amount chỉ kết chuyển khi đơn hàng hoàn tất (COMPLETED).
      return { alreadyPaid: false, payment: updatedPayment };
    });
  }
}
