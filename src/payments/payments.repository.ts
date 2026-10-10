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

      if (payment.order && payment.order.storeId) {
        const storeId = payment.order.storeId;
        let wallet = await tx.storeWallet.findUnique({
          where: { storeId },
        });

        if (!wallet) {
          wallet = await tx.storeWallet.create({
            data: {
              storeId,
              balance: 0,
              frozenBalance: 0,
            },
          });
        }

        const orderRef = `ORDER:${payment.orderId}`;
        const existingTx = await tx.walletTransaction.findFirst({
          where: {
            walletId: wallet.walletId,
            referenceId: { in: [orderRef, payment.orderId.toString(), payment.transactionCode || ''] },
            type: { in: ['PAYMENT_CREDIT', 'ORDER_REVENUE'] },
          },
        });

        if (!existingTx) {
          const balanceBefore = Number(wallet.balance);
          const creditAmount = Number(payment.amount);
          const balanceAfter = balanceBefore + creditAmount;

          await tx.storeWallet.update({
            where: { walletId: wallet.walletId },
            data: { balance: balanceAfter },
          });

          await tx.walletTransaction.create({
            data: {
              walletId: wallet.walletId,
              amount: creditAmount,
              type: 'PAYMENT_CREDIT',
              balanceBefore,
              balanceAfter,
              referenceId: orderRef,
              description: `Doanh thu đơn hàng #${payment.order.orderCode || payment.orderId} qua PayOS`,
            },
          });
        }
      }

      return { alreadyPaid: false, payment: updatedPayment };
    });
  }
}
