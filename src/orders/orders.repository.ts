import { Injectable, Inject } from '@nestjs/common';
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
      await tx.order.update({
        where: { orderId: createdOrder.orderId },
        data: {
          subtotalAmount: subtotal,
          totalAmount: total,
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
}
