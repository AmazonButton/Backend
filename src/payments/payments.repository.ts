import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
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
      // 1. Pessimistic lock payment transaction
      const lockedPayments = await tx.$queryRawUnsafe<any[]>(
        `SELECT * FROM payment_transaction WHERE payment_transaction_id = $1 FOR UPDATE`,
        paymentTransactionId,
      );
      if (!lockedPayments || lockedPayments.length === 0) {
        throw new NotFoundException('Không tìm thấy giao dịch thanh toán');
      }
      const payment = lockedPayments[0];

      // Idempotent: If already PAID, return immediately without touching order or history
      if (payment.status === 'PAID') {
        return this.findTransactionByIdTx(tx, paymentTransactionId);
      }

      // Only transition from PENDING to PAID
      if (payment.status !== 'PENDING') {
        throw new BadRequestException(`Không thể xác nhận giao dịch đang ở trạng thái ${payment.status}`);
      }

      // 2. Pessimistic lock order
      const lockedOrders = await tx.$queryRawUnsafe<any[]>(
        `SELECT * FROM orders WHERE order_id = $1 FOR UPDATE`,
        payment.order_id,
      );
      if (!lockedOrders || lockedOrders.length === 0) {
        throw new NotFoundException('Không tìm thấy đơn hàng tương ứng');
      }
      const order = lockedOrders[0];

      // Update payment transaction to PAID
      await tx.paymentTransaction.update({
        where: { paymentTransactionId },
        data: {
          status: 'PAID',
          paidAt: new Date(),
        },
      });

      // Only update order to CONFIRMED if order is in PENDING status!
      // If order was already CANCELLED, REJECTED, or COMPLETED, do NOT overwrite orderStatus!
      const canConfirmOrder = order.order_status === 'PENDING';
      if (canConfirmOrder) {
        await tx.order.update({
          where: { orderId: payment.order_id },
          data: {
            paymentStatus: 'PAID',
            orderStatus: 'CONFIRMED',
          },
        });

        await tx.orderStatusHistory.create({
          data: {
            orderId: payment.order_id,
            oldStatus: order.order_status,
            newStatus: 'CONFIRMED',
            reason: 'PayOS webhook xác nhận thanh toán thành công (Ký quỹ escrow)',
          },
        });
      } else {
        // If order was already processed/cancelled, only update paymentStatus to PAID
        await tx.order.update({
          where: { orderId: payment.order_id },
          data: {
            paymentStatus: 'PAID',
          },
        });
      }

      return this.findTransactionByIdTx(tx, paymentTransactionId);
    });
  }

  private async findTransactionByIdTx(tx: any, paymentTransactionId: bigint) {
    return tx.paymentTransaction.findUnique({
      where: { paymentTransactionId },
      include: { order: true },
    });
  }
}
