import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
  Inject,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../security/crypto.service';
import { EventsGateway } from '../websocket/events.gateway';

@Injectable()
export class OrdersService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CryptoService) private readonly crypto: CryptoService,
    @Inject(EventsGateway) private readonly eventsGateway: EventsGateway,
  ) {}

  /**
   * Xử lý tín hiệu bấm nút IoT — Gọi Stored Procedure sp_create_order_from_button
   * trong PostgreSQL chống Race-Condition & 2-Phase Commit (BRD-INV-06),
   * có cơ chế Fallback Transaction an toàn nếu Stored Procedure chưa được migrate.
   */
  async handleButtonEvent(
    device: any,
    eventPayload: { eventType: string; requestId: string; paymentMethod?: string; shippingFee?: number; battery?: number; rssi?: number; [key: string]: any },
  ) {
    const { eventType, requestId, paymentMethod = 'COD', shippingFee = 0 } = eventPayload;

    const button = await this.prisma.ioTButton.findFirst({
      where: {
        OR: [
          { deviceId: device.deviceId || device.id },
          { buttonCode: device.buttonCode || device.id },
        ],
      },
      include: {
        store: true,
        customer: { include: { user: true } },
        buttonProducts: { include: { product: true } },
      },
    });

    if (!button) {
      throw new BadRequestException('Nút bấm chưa được đăng ký trong hệ thống');
    }

    if (button.status !== 'ACTIVE') {
      throw new BadRequestException('Nút bấm hiện đang bị tạm dừng hoặc khóa (INACTIVE/LOCKED)');
    }

    if (!button.buttonProducts || button.buttonProducts.length === 0) {
      throw new BadRequestException('Nút bấm chưa được cấu hình sản phẩm đặt hàng');
    }

    let newOrderId: any = null;

    // 1. Cố gắng thực thi qua Stored Procedure PostgreSQL
    try {
      const result: any[] = await this.prisma.$queryRaw`
        SELECT sp_create_order_from_button(
          ${button.buttonId}::bigint,
          ${paymentMethod}::varchar,
          ${shippingFee}::decimal,
          ${'Đơn hàng tự động từ nút bấm IoT'}::text
        ) AS order_id
      `;
      newOrderId = result[0]?.order_id;
    } catch (procErr: any) {
      // 2. Fallback: Nếu môi trường chưa nạp Stored Procedure, thực thi giao dịch Prisma tương đương
      newOrderId = await this.prisma.$transaction(async (tx) => {
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

    if (!newOrderId) {
      throw new BadRequestException('Không thể khởi tạo đơn hàng từ hệ thống');
    }

    // Fetch the created order with full details
    const newOrder = await this.prisma.order.findUnique({
      where: { orderId: BigInt(newOrderId) },
      include: {
        items: { include: { product: true } },
        customer: { include: { user: true } },
        store: true,
      },
    });

    const formattedOrder = {
      ...newOrder,
      id: newOrder?.orderId.toString(),
      orderId: newOrder?.orderId.toString(),
      orderNumber: newOrder?.orderCode,
      orderCode: newOrder?.orderCode,
    };

    const orderPayload = {
      order: formattedOrder,
      buttonCode: button.buttonCode,
      customerName: button.customer.user.fullName,
      storeId: button.storeId.toString(),
      customerId: button.customerId.toString(),
    };

    // Emit Realtime WebSockets
    this.eventsGateway.emitToStore(button.storeId.toString(), 'ORDER_CREATED', orderPayload);
    this.eventsGateway.emitToCustomer(button.customerId.toString(), 'ORDER_CREATED', orderPayload);
    this.eventsGateway.emitGlobal('ORDER_CREATED', orderPayload);

    return {
      order: formattedOrder,
      isDuplicate: false,
      message: 'Tạo đơn hàng thành công qua hệ thống xử lý IoT Button!',
    };
  }

  /**
   * Mô phỏng tín hiệu bấm nút từ UI để kiểm thử (Sandbox Simulation)
   */
  async simulateButtonPress(body: any, user: any) {
    const targetIdentifier = body.deviceId || body.buttonCode || body.buttonId;
    if (!targetIdentifier) {
      throw new BadRequestException('Thiếu thông tin nhận diện nút (deviceId, buttonCode hoặc buttonId)');
    }

    const button = await this.prisma.ioTButton.findFirst({
      where: {
        OR: [
          { deviceId: targetIdentifier.toString() },
          { buttonCode: targetIdentifier.toString() },
          ...(!isNaN(Number(targetIdentifier)) ? [{ buttonId: BigInt(targetIdentifier) }] : []),
        ],
      },
      include: {
        store: true,
        customer: { include: { user: true } },
        buttonProducts: { include: { product: true } },
      },
    });

    if (!button) {
      throw new NotFoundException('Không tìm thấy nút bấm được chỉ định');
    }

    // BOLA Check
    if (user && user.role === 'CUSTOMER' && user.customerProfileId) {
      if (button.customerId.toString() !== user.customerProfileId.toString()) {
        throw new ForbiddenException('Bạn không sở hữu nút bấm này');
      }
    } else if (user && ['STORE_OWNER', 'STORE_STAFF'].includes(user.role) && user.storeId) {
      if (button.storeId.toString() !== user.storeId.toString()) {
        throw new ForbiddenException('Nút bấm không thuộc quyền quản lý của cửa hàng bạn');
      }
    }

    const result = await this.handleButtonEvent(button, {
      eventType: body.eventType || 'SINGLE_PRESS',
      requestId: body.requestId || `sim_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      paymentMethod: body.paymentMethod || 'COD',
      shippingFee: body.shippingFee || 0,
    });

    return {
      success: true,
      message: 'Mô phỏng bấm nút thành công!',
      data: result,
    };
  }

  /**
   * Đặt hàng nhanh từ App dựa trên Nút bấm
   */
  async quickReorder(user: any, deviceId: string) {
    const button = await this.prisma.ioTButton.findUnique({
      where: { deviceId },
      include: {
        customer: true,
      },
    });

    if (!button || (user.customerProfileId && button.customerId.toString() !== user.customerProfileId.toString())) {
      throw new NotFoundException('Thiết bị không tồn tại hoặc không thuộc sở hữu của bạn');
    }

    const data = await this.handleButtonEvent(button, {
      eventType: 'APP_QUICK_REORDER',
      requestId: `app_req_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
    });

    return data;
  }

  async list(user: any, status?: string) {
    const whereClause: any = {};
    if (user.role === 'CUSTOMER' && user.customerProfileId) {
      whereClause.customerId = BigInt(user.customerProfileId);
    } else if (['STORE_OWNER', 'STORE_MANAGER', 'STORE_STAFF'].includes(user.role) && user.storeId) {
      whereClause.storeId = BigInt(user.storeId);
    }

    if (status) {
      whereClause.orderStatus = status;
    }

    const orders = await this.prisma.order.findMany({
      where: whereClause,
      include: {
        items: { include: { product: true } },
        button: true,
        customer: { include: { user: true } },
        store: true,
      },
      orderBy: { orderDate: 'desc' },
    });

    return orders.map((o) => ({
      ...o,
      id: o.orderId.toString(),
      orderId: o.orderId.toString(),
      orderNumber: o.orderCode,
      orderCode: o.orderCode,
    }));
  }

  async getById(id: string | number | bigint, user?: any) {
    const targetOrderId = BigInt(id);
    const order = await this.prisma.order.findUnique({
      where: { orderId: targetOrderId },
      include: {
        items: { include: { product: true } },
        button: true,
        customer: { include: { user: true } },
        store: true,
        statusHistories: true,
        paymentTransactions: true,
      },
    });

    if (!order) return null;

    // BOLA / IDOR Protection: verify ownership
    if (user && user.role !== 'SUPER_ADMIN') {
      const isCustomerOwner = user.customerProfileId && order.customerId === BigInt(user.customerProfileId);
      const isStoreOwner = user.storeId && order.storeId === BigInt(user.storeId);
      if (!isCustomerOwner && !isStoreOwner) {
        throw new ForbiddenException({
          success: false,
          code: 'ACCESS_DENIED',
          message: 'Bạn không có quyền xem đơn hàng này.',
        });
      }
    }

    return {
      ...order,
      id: order.orderId.toString(),
      orderId: order.orderId.toString(),
      orderNumber: order.orderCode,
      orderCode: order.orderCode,
    };
  }

  async cancelOrder(orderId: string | number | bigint, reason: string = 'Khách hàng hủy đơn', user?: any) {
    const targetOrderId = BigInt(orderId);
    const order = await this.prisma.order.findUnique({
      where: { orderId: targetOrderId },
      include: { items: true },
    });

    if (!order) {
      throw new NotFoundException('Đơn hàng không tồn tại');
    }

    if (order.orderStatus !== 'PENDING') {
      throw new BadRequestException('Đơn hàng đã được xử lý hoặc hủy trước đó, không thể hủy');
    }

    // BOLA / IDOR Protection
    if (user && user.role !== 'SUPER_ADMIN') {
      const isCustomerOwner = user.customerProfileId && order.customerId === BigInt(user.customerProfileId);
      const isStoreOwner = user.storeId && order.storeId === BigInt(user.storeId);
      if (!isCustomerOwner && !isStoreOwner) {
        throw new ForbiddenException({
          success: false,
          code: 'ACCESS_DENIED',
          message: 'Bạn không có quyền hủy đơn hàng này.',
        });
      }
    }

    // Release reserved inventory
    for (const item of order.items) {
      await this.prisma.inventory.updateMany({
        where: { productId: item.productId },
        data: {
          reservedQuantity: { decrement: item.quantity },
        },
      });
    }

    const updated = await this.prisma.order.update({
      where: { orderId: targetOrderId },
      data: {
        orderStatus: 'CANCELLED',
      },
      include: { items: true },
    });

    const cancelPayload = { order: updated, reason, storeId: order.storeId.toString(), customerId: order.customerId.toString() };
    this.eventsGateway.emitToStore(order.storeId.toString(), 'ORDER_CANCELLED', cancelPayload);
    this.eventsGateway.emitToCustomer(order.customerId.toString(), 'ORDER_CANCELLED', cancelPayload);
    this.eventsGateway.emitGlobal('ORDER_CANCELLED', cancelPayload);

    return {
      ...updated,
      id: updated.orderId.toString(),
      orderId: updated.orderId.toString(),
      orderNumber: updated.orderCode,
      orderCode: updated.orderCode,
    };
  }

  async updateOrderStatus(orderId: string | number | bigint, newStatus: string) {
    const targetOrderId = BigInt(orderId);
    const order = await this.prisma.order.findUnique({
      where: { orderId: targetOrderId },
      include: { items: true },
    });

    if (!order) {
      throw new NotFoundException('Đơn hàng không tồn tại');
    }

    if (newStatus === 'COMPLETED' && order.orderStatus !== 'COMPLETED') {
      // Khấu trừ tồn thực tế
      for (const item of order.items) {
        await this.prisma.inventory.updateMany({
          where: { productId: item.productId },
          data: {
            quantityOnHand: { decrement: item.quantity },
            reservedQuantity: { decrement: item.quantity },
          },
        });
      }
    } else if (['CANCELLED', 'REJECTED'].includes(newStatus) && !['CANCELLED', 'REJECTED', 'COMPLETED'].includes(order.orderStatus)) {
      // Hoàn trả tồn giữ chỗ
      for (const item of order.items) {
        await this.prisma.inventory.updateMany({
          where: { productId: item.productId },
          data: {
            reservedQuantity: { decrement: item.quantity },
          },
        });
      }
    }

    const updated = await this.prisma.order.update({
      where: { orderId: targetOrderId },
      data: { orderStatus: newStatus },
      include: { items: true },
    });

    const statusPayload = { order: updated, storeId: order.storeId.toString(), customerId: order.customerId.toString() };
    this.eventsGateway.emitToStore(order.storeId.toString(), 'ORDER_STATUS_CHANGED', statusPayload);
    this.eventsGateway.emitToCustomer(order.customerId.toString(), 'ORDER_STATUS_CHANGED', statusPayload);
    this.eventsGateway.emitGlobal('ORDER_STATUS_CHANGED', statusPayload);

    return {
      ...updated,
      id: updated.orderId.toString(),
      orderId: updated.orderId.toString(),
      orderNumber: updated.orderCode,
      orderCode: updated.orderCode,
    };
  }
}
