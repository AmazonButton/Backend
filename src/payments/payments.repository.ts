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

  async findTransactionsByOrderId(orderId: bigint) {
    return this.prisma.paymentTransaction.findMany({
      where: { orderId },
      orderBy: { paymentTransactionId: 'desc' },
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
        // If order was already CANCELLED or REJECTED, mark paymentStatus as REFUND_PENDING for financial reconciliation
        const isCancelledOrRejected = order.order_status === 'CANCELLED' || order.order_status === 'REJECTED';
        const finalPaymentStatus = isCancelledOrRejected ? 'REFUND_PENDING' : 'PAID';

        await tx.order.update({
          where: { orderId: payment.order_id },
          data: {
            paymentStatus: finalPaymentStatus,
          },
        });

        if (isCancelledOrRejected) {
          await tx.orderStatusHistory.create({
            data: {
              orderId: payment.order_id,
              oldStatus: order.order_status,
              newStatus: order.order_status,
              reason: `PayOS webhook nhận tiền sau khi đơn hàng đã ${order.order_status}. Đánh dấu paymentStatus: REFUND_PENDING để đối soát hoàn tiền.`,
            },
          });
        }
      }

      // 3. Atomically create customer notification with unique idempotency key
      const custRows: any[] = await tx.$queryRawUnsafe(
        `SELECT user_id FROM customer_profile WHERE customer_id = $1`,
        order.customer_id,
      );
      if (custRows && custRows.length > 0 && custRows[0].user_id) {
        const customerUserId = custRows[0].user_id;
        const idempotencyKey = `payment:${paymentTransactionId.toString()}:paid`;
        const notifData = JSON.stringify({
          orderId: order.order_id.toString(),
          orderCode: order.order_code,
          amount: Number(payment.amount),
          paymentTransactionId: paymentTransactionId.toString(),
        });
        await tx.$executeRawUnsafe(
          `INSERT INTO notifications (user_id, type, title, body, data, idempotency_key, created_at)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6, NOW())
           ON CONFLICT (idempotency_key) DO NOTHING;`,
          customerUserId,
          'PAYMENT_SUCCESS',
          'Thanh toán đơn hàng thành công',
          `Đơn hàng #${order.order_code} đã thanh toán thành công qua PayOS với số tiền ${Number(payment.amount).toLocaleString('vi-VN')} VND.`,
          notifData,
          idempotencyKey,
        );
      }

      return this.findTransactionByIdTx(tx, paymentTransactionId);
    });
  }

  async changePaymentMethodTx(orderId: bigint, newPaymentMethod: string) {
    return this.prisma.$transaction(async (tx) => {
      // 1. Pessimistic lock order
      const lockedOrders = await tx.$queryRawUnsafe<any[]>(
        `SELECT order_id, order_status, payment_status, customer_id, store_id FROM orders WHERE order_id = $1 FOR UPDATE`,
        orderId,
      );
      if (!lockedOrders || lockedOrders.length === 0) {
        throw new NotFoundException('Không tìm thấy đơn hàng');
      }
      const order = lockedOrders[0];

      if (order.payment_status === 'PAID') {
        throw new BadRequestException('Không thể đổi phương thức thanh toán cho đơn hàng đã thanh toán');
      }

      const terminalStatuses = ['CONFIRMED', 'COMPLETED', 'CANCELLED', 'REJECTED'];
      if (terminalStatuses.includes(order.order_status) || order.order_status !== 'PENDING') {
        throw new BadRequestException(`Không thể đổi phương thức thanh toán khi đơn hàng đang ở trạng thái ${order.order_status}`);
      }

      // 2. Cancel any pending payment transactions
      await tx.paymentTransaction.updateMany({
        where: {
          orderId,
          status: 'PENDING',
        },
        data: {
          status: 'CANCELLED',
        },
      });

      // 3. Update order payment method
      return tx.order.update({
        where: { orderId },
        data: {
          paymentMethod: newPaymentMethod,
          updatedAt: new Date(),
        },
        include: {
          customer: true,
          store: true,
        },
      });
    });
  }


  private async findTransactionByIdTx(tx: any, paymentTransactionId: bigint) {
    return tx.paymentTransaction.findUnique({
      where: { paymentTransactionId },
      include: { order: true },
    });
  }

  async updatePaymentLinkDetails(
    paymentTransactionId: bigint,
    paymentLinkId: string,
    checkoutUrl?: string,
    qrCode?: string,
  ) {
    return this.prisma.paymentTransaction.update({
      where: { paymentTransactionId },
      data: {
        paymentLinkId,
        ...(checkoutUrl ? { checkoutUrl } : {}),
        ...(qrCode ? { qrCode } : {}),
      },
    });
  }

}
