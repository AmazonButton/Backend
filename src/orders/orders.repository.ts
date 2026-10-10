import { Injectable, Inject, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class OrdersRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async findButtonByIdentifier(identifier: string) {
    const isNum = !isNaN(Number(identifier));
    return this.prisma.ioTButton.findFirst({
      where: {
        OR: [
          { deviceId: identifier },
          { buttonCode: identifier },
          ...(isNum ? [{ buttonId: BigInt(identifier) }] : []),
        ],
      },
      include: {
        store: true,
        customer: { include: { user: true } },
        buttonProducts: { include: { product: true } },
      },
    });
  }

  async findButtonByDeviceId(deviceId: string) {
    return this.prisma.ioTButton.findUnique({
      where: { deviceId },
      include: {
        customer: true,
        store: true,
        buttonProducts: { include: { product: true } },
      },
    });
  }

  async executeSpCreateOrder(
    buttonId: bigint,
    paymentMethod: string,
    shippingFee: number,
    orderNote: string = 'Đơn hàng tự động từ nút bấm IoT',
  ): Promise<any> {
    const result: any[] = await this.prisma.$queryRaw`
      SELECT sp_create_order_from_button(
        ${buttonId}::bigint,
        ${paymentMethod}::varchar,
        ${shippingFee}::decimal,
        ${orderNote}::text
      ) AS order_id
    `;
    return result[0]?.order_id;
  }

  async createOrderFallbackTx(button: any, paymentMethod: string, shippingFee: number): Promise<bigint> {
    return this.prisma.$transaction(async (tx) => {
      let subtotal = 0;
      const orderCode = `ORD-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.floor(1000 + Math.random() * 9000)}`;

      const address = await tx.customerAddress.findFirst({
        where: { addressId: button.addressId },
      });
      const shippingAddress = address
        ? `${address.addressDetail}${address.ward ? ', ' + address.ward : ''}${address.district ? ', ' + address.district : ''}${address.province ? ', ' + address.province : ''}`
        : 'Địa chỉ mặc định của khách hàng';
      const recipientName = address?.recipientName || button.customer.user.fullName;
      const phone = address?.phone || button.customer.user.phone || '';

      const createdOrder = await tx.order.create({
        data: {
          orderCode,
          storeId: button.storeId,
          customerId: button.customerId,
          buttonId: button.buttonId,
          orderStatus: 'PENDING',
          paymentStatus: 'UNPAID',
          paymentMethod,
          shippingFee,
          subtotalAmount: 0,
          discountAmount: 0,
          totalAmount: shippingFee,
          shippingRecipientName: recipientName,
          shippingPhone: phone,
          shippingAddress,
          orderNote: 'Đơn hàng tự động từ nút bấm IoT',
        },
      });

      for (const bp of button.buttonProducts) {
        const lineSubtotal = Number(bp.product.basePrice) * bp.quantity;
        subtotal += lineSubtotal;

        await tx.orderItem.create({
          data: {
            orderId: createdOrder.orderId,
            productId: bp.productId,
            productNameSnapshot: bp.product.productName,
            unitPriceSnapshot: bp.product.basePrice,
            discountPercentSnapshot: 0,
            discountAmountSnapshot: 0,
            finalUnitPrice: bp.product.basePrice,
            quantity: bp.quantity,
            itemSubtotal: lineSubtotal,
          },
        });

        // Giữ chỗ tồn kho (Two-Phase Commit)
        await tx.inventory.updateMany({
          where: { productId: bp.productId },
          data: {
            reservedQuantity: { increment: bp.quantity },
          },
        });
      }

      const total = subtotal + shippingFee;
      const store = await tx.store.findUnique({
        where: { storeId: button.storeId },
        select: { commissionRate: true },
      });
      const commissionRate = store?.commissionRate ? Number(store.commissionRate) : 8.0;
      const commissionAmount = Math.round((total * commissionRate / 100) * 100) / 100;
      const netAmount = Math.max(0, total - commissionAmount);

      await tx.order.update({
        where: { orderId: createdOrder.orderId },
        data: {
          subtotalAmount: subtotal,
          totalAmount: total,
          commissionRate,
          commissionAmount,
          netAmount,
        },
      });

      return createdOrder.orderId;
    });
  }

  async findOrderById(orderId: bigint) {
    return this.prisma.order.findUnique({
      where: { orderId },
      include: {
        items: { include: { product: true } },
        button: true,
        customer: { include: { user: true } },
        store: true,
        statusHistories: true,
        paymentTransactions: true,
      },
    });
  }

  async findOrders(whereClause: any) {
    return this.prisma.order.findMany({
      where: whereClause,
      include: {
        items: { include: { product: true } },
        button: true,
        customer: { include: { user: true } },
        store: true,
      },
      orderBy: { orderDate: 'desc' },
    });
  }

  async updateOrderStatus(orderId: bigint, orderStatus: string) {
    return this.prisma.order.update({
      where: { orderId },
      data: { orderStatus },
      include: { items: true },
    });
  }

  async releaseReservedInventory(items: { productId: bigint; quantity: number }[]) {
    for (const item of items) {
      await this.prisma.inventory.updateMany({
        where: { productId: item.productId },
        data: {
          reservedQuantity: { decrement: item.quantity },
        },
      });
    }
  }

  async deductInventoryOnCompleted(items: { productId: bigint; quantity: number }[]) {
    for (const item of items) {
      await this.prisma.inventory.updateMany({
        where: { productId: item.productId },
        data: {
          quantityOnHand: { decrement: item.quantity },
          reservedQuantity: { decrement: item.quantity },
        },
      });
    }
  }

  async completeOrderAtomicTx(orderId: bigint): Promise<any> {
    return this.prisma.$transaction(async (tx) => {
      // 1. Lock order row
      const lockedOrders = await tx.$queryRawUnsafe<any[]>(
        `SELECT * FROM orders WHERE order_id = $1 FOR UPDATE`,
        orderId,
      );
      if (!lockedOrders || lockedOrders.length === 0) {
        throw new NotFoundException('Đơn hàng không tồn tại');
      }
      const order = lockedOrders[0];

      if (order.order_status === 'COMPLETED') {
        return this.findOrderByIdTx(tx, orderId);
      }

      if (!['DELIVERED', 'SHIPPING', 'OUT_FOR_DELIVERY', 'READY_FOR_DELIVERY', 'PROCESSING', 'PREPARING', 'CONFIRMED'].includes(order.order_status)) {
        throw new BadRequestException(`Không thể hoàn tất đơn hàng từ trạng thái ${order.order_status}`);
      }

      // 2. Lock & Deduct inventory with reserved_quantity check
      const items = await tx.orderItem.findMany({ where: { orderId } });
      for (const item of items) {
        await tx.$executeRawUnsafe(
          `SELECT * FROM inventory WHERE product_id = $1 FOR UPDATE`,
          item.productId,
        );
        await tx.$executeRawUnsafe(
          `UPDATE inventory
           SET quantity_on_hand = GREATEST(0, quantity_on_hand - $1),
               reserved_quantity = GREATEST(0, reserved_quantity - $1),
               updated_at = NOW()
           WHERE product_id = $2`,
          item.quantity,
          item.productId,
        );
      }

      // 3. Credit store wallet strictly if paid via PayOS online gateway
      const isPayosMethod = order.payment_method === 'PAYOS';
      const isPaidStatus = ['PAID', 'SUCCESS'].includes(order.payment_status);
      
      let shouldCreditWallet = false;
      if (isPayosMethod && isPaidStatus) {
        const payosTx = await tx.paymentTransaction.findFirst({
          where: {
            orderId: BigInt(orderId),
            provider: 'PAYOS',
            status: 'PAID',
          },
        });
        if (payosTx) {
          shouldCreditWallet = true;
        }
      }

      if (shouldCreditWallet) {
        const storeId = order.store_id;
        if (storeId) {
          const wallets = await tx.$queryRawUnsafe<any[]>(
            `SELECT * FROM store_wallets WHERE store_id = $1 FOR UPDATE`,
            storeId,
          );
          let wallet = wallets[0];
          if (!wallet) {
            wallet = await tx.storeWallet.create({
              data: {
                storeId,
                balance: 0,
                frozenBalance: 0,
              },
            });
          }

          const orderRef = `ORDER:${orderId}`;
          const existingTx = await tx.walletTransaction.findFirst({
            where: {
              walletId: wallet.walletId || wallet.wallet_id,
              referenceId: orderRef,
              type: 'ORDER_REVENUE',
            },
          });

          if (!existingTx) {
            const currentBal = Number(wallet.balance);
            const payoutAmount = order.net_amount ? Number(order.net_amount) : Math.round(Number(order.total_amount) * 0.92);
            const newBal = currentBal + payoutAmount;

            await tx.storeWallet.update({
              where: { walletId: wallet.walletId || wallet.wallet_id },
              data: { balance: newBal },
            });

            await tx.walletTransaction.create({
              data: {
                walletId: wallet.walletId || wallet.wallet_id,
                amount: payoutAmount,
                type: 'ORDER_REVENUE',
                balanceBefore: currentBal,
                balanceAfter: newBal,
                referenceId: orderRef,
                description: `Doanh thu thực nhận đơn hàng #${order.order_code || orderId} (sau hoa hồng)`,
              },
            });
          }
        }
      }

      // 4. Update order status
      await tx.order.update({
        where: { orderId },
        data: {
          orderStatus: 'COMPLETED',
          completedAt: new Date(),
        },
      });

      // 5. Record status history
      await tx.orderStatusHistory.create({
        data: {
          orderId,
          oldStatus: order.order_status,
          newStatus: 'COMPLETED',
          reason: 'Đơn hàng hoàn tất và kết chuyển doanh thu vào ví cửa hàng',
        },
      });

      return this.findOrderByIdTx(tx, orderId);
    });
  }

  async cancelOrderAtomicTx(
    orderId: bigint,
    reason: string = 'Khách hàng hủy đơn',
    userId?: any,
    targetStatus: 'CANCELLED' | 'REJECTED' = 'CANCELLED',
  ): Promise<any> {
    return this.prisma.$transaction(async (tx) => {
      const lockedOrders = await tx.$queryRawUnsafe<any[]>(
        `SELECT * FROM orders WHERE order_id = $1 FOR UPDATE`,
        orderId,
      );
      if (!lockedOrders || lockedOrders.length === 0) {
        throw new NotFoundException('Đơn hàng không tồn tại');
      }
      const order = lockedOrders[0];

      if (order.order_status === 'CANCELLED') {
        return this.findOrderByIdTx(tx, orderId);
      }

      if (['COMPLETED', 'DELIVERED', 'SHIPPING'].includes(order.order_status)) {
        throw new BadRequestException('Đơn hàng đã được xử lý giao hàng hoặc hoàn tất, không thể hủy');
      }

      const items = await tx.orderItem.findMany({ where: { orderId } });
      for (const item of items) {
        await tx.$executeRawUnsafe(
          `SELECT * FROM inventory WHERE product_id = $1 FOR UPDATE`,
          item.productId,
        );
        await tx.$executeRawUnsafe(
          `UPDATE inventory
           SET reserved_quantity = GREATEST(0, reserved_quantity - $1),
               updated_at = NOW()
           WHERE product_id = $2`,
          item.quantity,
          item.productId,
        );
      }

      await tx.order.update({
        where: { orderId },
        data: { orderStatus: 'CANCELLED' },
      });

      await tx.orderStatusHistory.create({
        data: {
          orderId,
          oldStatus: order.order_status,
          newStatus: targetStatus,
          reason,
          changedByUserId: userId ? BigInt(userId) : null,
        },
      });

      return this.findOrderByIdTx(tx, orderId);
    });
  }

  async findOrderByIdTx(tx: any, orderId: bigint) {
    return tx.order.findUnique({
      where: { orderId },
      include: {
        items: { include: { product: true } },
        button: true,
        customer: { include: { user: true } },
        store: true,
        statusHistories: true,
        paymentTransactions: true,
      },
    });
  }

}
