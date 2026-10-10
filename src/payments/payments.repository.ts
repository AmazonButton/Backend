import { Injectable, NotFoundException } from '@nestjs/common';
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

  async updatePaymentLinkId(paymentTransactionId: bigint, paymentLinkId: string) {
    return this.prisma.paymentTransaction.update({
      where: { paymentTransactionId },
      data: { paymentLinkId },
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

  async confirmPaymentAtomicTx(paymentTransactionId: bigint) {
    return await this.prisma.$transaction(async (tx) => {
      const payment = await tx.paymentTransaction.findUnique({
        where: { paymentTransactionId },
        include: { order: true },
      });

      if (!payment) {
        throw new NotFoundException('Không tìm thấy giao dịch thanh toán');
      }

      if (payment.status === 'PAID') {
        return payment;
      }

      const updatedPayment = await tx.paymentTransaction.update({
        where: { paymentTransactionId },
        data: {
          status: 'PAID',
          paidAt: new Date(),
        },
      });

      await tx.order.update({
        where: { orderId: payment.orderId },
        data: {
          paymentStatus: 'PAID',
          orderStatus: 'CONFIRMED',
        },
      });

      await tx.orderStatusHistory.create({
        data: {
          orderId: payment.orderId,
          oldStatus: payment.order.orderStatus,
          newStatus: 'CONFIRMED',
          reason: 'PayOS webhook xác nhận thanh toán thành công (Ký quỹ escrow)',
        },
      });

      return updatedPayment;
    });
  }
}
