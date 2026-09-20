import {
  Injectable,
  BadRequestException,
  NotFoundException,
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

  async handleButtonEvent(
    device: any,
    eventPayload: { eventType: string; requestId: string; battery?: number; rssi?: number },
  ) {
    const { eventType, requestId, battery = 100, rssi = -50 } = eventPayload;

    const config = await this.prisma.deviceConfiguration.findUnique({
      where: { deviceId: device.id },
      include: {
        product: true,
        device: {
          include: {
            customer: { include: { user: true } },
            store: true,
          },
        },
      },
    });

    if (!config || !config.product) {
      throw new BadRequestException('Thiết bị chưa được cấu hình sản phẩm đặt hàng');
    }

    if (!config.device.customer || !config.device.storeId) {
      throw new BadRequestException('Thiết bị chưa được gán cho khách hàng hoặc cửa hàng');
    }

    // 1. Kiểm tra trạng thái hoạt động (Còn xài hay không)
    if (config.device.status === 'DISABLED' || config.device.status === 'INACTIVE') {
      throw new BadRequestException('Nút bấm đã bị tạm dừng hoặc ngưng sử dụng (Disabled)');
    }

    // 2. Kiểm tra thời hạn sử dụng / bảo hành
    if (config.device.expiresAt && new Date() > new Date(config.device.expiresAt)) {
      await this.prisma.device.update({
        where: { id: config.device.id },
        data: { status: 'EXPIRED' },
      });
      throw new BadRequestException(
        `Nút bấm đã hết hạn sử dụng vào ngày ${new Date(config.device.expiresAt).toLocaleDateString('vi-VN')}. Vui lòng liên hệ cửa hàng để gia hạn!`,
      );
    }

    // 3. Kiểm tra mức pin
    if (config.device.batteryLevel !== undefined && config.device.batteryLevel <= 0) {
      throw new BadRequestException('Nút bấm đã cạn pin hoàn toàn (0%), vui lòng thay hoặc sạc pin để tiếp tục sử dụng');
    }

    const customer = config.device.customer;
    const store = config.device.store;
    const product = config.product;
    const quantity = config.defaultQuantity || 1;

    // Anti-Spam / Idempotency check
    const existingIdempotency = await this.prisma.idempotencyRecord.findUnique({
      where: { key: requestId },
    });

    if (existingIdempotency && existingIdempotency.orderId) {
      const existingOrder = await this.prisma.order.findUnique({
        where: { id: existingIdempotency.orderId },
        include: { items: true },
      });
      if (existingOrder) {
        return {
          order: existingOrder,
          isDuplicate: true,
          cancelWindowSeconds: config.cancelWindowSeconds,
        };
      }
    }

    // Debounce check: If an order from this device occurred in the last 30s
    const recentOrder = await this.prisma.order.findFirst({
      where: {
        deviceId: device.id,
        status: { in: ['PENDING', 'CONFIRMED', 'PREPARING'] },
        createdAt: { gte: new Date(Date.now() - 30000) },
      },
      include: { items: true },
    });

    if (recentOrder) {
      return {
        order: recentOrder,
        isDuplicate: true,
        cancelWindowSeconds: config.cancelWindowSeconds,
      };
    }

    // ─── Stock Check & Partial Fill ────────────────────────────────────────────
    // Nếu hàng sẵn có = 0 → Hết hàng hoàn toàn, throw lỗi.
    // Nếu hàng sẵn có < defaultQuantity → Partial Fill: tạo đơn với số lượng
    // thực tế còn lại thay vì từ chối, sau đó emit thêm event cảnh báo.
    const availableStock = product.stock - product.reservedStock;

    if (availableStock <= 0) {
      throw new BadRequestException(
        `Sản phẩm "${product.name}" đã hết hàng hoàn toàn`,
      );
    }

    // Clamp số lượng xuống stock thực tế nếu không đủ
    const actualQuantity = Math.min(quantity, availableStock);
    const isPartialFill = actualQuantity < quantity;
    // ────────────────────────────────────────────────────────────────────────────

    const cancelExpiresAt = new Date(Date.now() + config.cancelWindowSeconds * 1000);
    const orderNumber = this.crypto.generateOrderNumber();
    const totalAmount = product.price * actualQuantity;

    const result = await this.prisma.$transaction(async (tx) => {
      // 1. Reserve stock (chỉ reserve actualQuantity, không phải quantity gốc)
      await tx.product.update({
        where: { id: product.id },
        data: { reservedStock: { increment: actualQuantity } },
      });

      // 2. Create Order
      const newOrder = await tx.order.create({
        data: {
          orderNumber,
          storeId: store.id,
          customerId: customer.id,
          deviceId: device.id,
          status: 'PENDING',
          totalAmount,
          deliveryAddress: customer.deliveryAddress,
          customerPhone: customer.phone,
          customerName: customer.user.fullName,
          cancelExpiresAt,
          items: {
            create: [
              {
                productId: product.id,
                productName: product.name,
                quantity: actualQuantity,
                unitPrice: product.price,
                totalPrice: totalAmount,
              },
            ],
          },
        },
        include: { items: true },
      });

      // 3. Save Idempotency
      await tx.idempotencyRecord.create({
        data: {
          key: requestId,
          deviceId: device.id,
          orderId: newOrder.id,
          expiresAt: new Date(Date.now() + 3600000),
        },
      });

      // 4. Update Device event & telemetry
      await tx.deviceEvent.create({
        data: {
          deviceId: device.id,
          eventType,
          requestId,
          batteryLevel: battery,
          wifiRSSI: rssi,
          processed: true,
        },
      });

      await tx.device.update({
        where: { id: device.id },
        data: {
          batteryLevel: battery,
          wifiRSSI: rssi,
          lastSeenAt: new Date(),
        },
      });

      return newOrder;
    });

    const orderPayload = {
      order: result,
      deviceName: config.customName,
      customerName: customer.user.fullName,
      productName: product.name,
      quantity: actualQuantity,
      requestedQuantity: quantity,
      isPartialFill,
      cancelWindowSeconds: config.cancelWindowSeconds,
      storeId: store.id,
      customerId: customer.id,
    };

    this.eventsGateway.emitToStore(store.id, 'ORDER_CREATED', orderPayload);
    this.eventsGateway.emitToCustomer(customer.id, 'ORDER_CREATED', orderPayload);
    if (customer.userId && customer.userId !== customer.id) {
      this.eventsGateway.emitToCustomer(customer.userId, 'ORDER_CREATED', orderPayload);
    }
    this.eventsGateway.emitGlobal('ORDER_CREATED', orderPayload);

    // ─── Emit cảnh báo Partial Fill nếu số lượng bị giảm ───────────────────────
    if (isPartialFill) {
      const partialPayload = {
        orderId: result.id,
        orderNumber: result.orderNumber,
        productName: product.name,
        requestedQuantity: quantity,
        fulfilledQuantity: actualQuantity,
        remainingStock: availableStock - actualQuantity,
        message: `Chỉ đặt được ${actualQuantity}/${quantity} vì hàng sắp hết. Đơn hàng vẫn được tạo thành công!`,
        storeId: store.id,
        customerId: customer.id,
      };
      this.eventsGateway.emitToStore(store.id, 'ORDER_PARTIAL_FILL', partialPayload);
      this.eventsGateway.emitToCustomer(customer.id, 'ORDER_PARTIAL_FILL', partialPayload);
      if (customer.userId) {
        this.eventsGateway.emitToCustomer(customer.userId, 'ORDER_PARTIAL_FILL', partialPayload);
      }
      this.eventsGateway.emitGlobal('ORDER_PARTIAL_FILL', partialPayload);
    }
    // ────────────────────────────────────────────────────────────────────────────

    return {
      order: result,
      isDuplicate: false,
      isPartialFill,
      requestedQuantity: quantity,
      fulfilledQuantity: actualQuantity,
      cancelWindowSeconds: config.cancelWindowSeconds,
    };
  }

  async cancelOrder(orderId: string, reason: string = 'Khách hàng hủy đơn') {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { items: true },
    });

    if (!order) {
      throw new NotFoundException('Đơn hàng không tồn tại');
    }

    if (order.status !== 'PENDING') {
      throw new BadRequestException('Đơn hàng đã được cửa hàng tiếp nhận, không thể hủy');
    }

    if (order.cancelExpiresAt && new Date() > order.cancelExpiresAt) {
      throw new BadRequestException('Đã quá thời gian cho phép hủy đơn');
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      for (const item of order.items) {
        await tx.product.update({
          where: { id: item.productId },
          data: { reservedStock: { decrement: item.quantity } },
        });
      }

      return tx.order.update({
        where: { id: orderId },
        data: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
          cancellationReason: reason,
        },
        include: { items: true },
      });
    });

    const cancelPayload = { order: updated, reason, storeId: order.storeId, customerId: order.customerId };
    this.eventsGateway.emitToStore(order.storeId, 'ORDER_CANCELLED', cancelPayload);
    this.eventsGateway.emitToCustomer(order.customerId, 'ORDER_CANCELLED', cancelPayload);
    this.eventsGateway.emitGlobal('ORDER_CANCELLED', cancelPayload);

    return updated;
  }

  async updateOrderStatus(orderId: string, newStatus: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { items: true },
    });

    if (!order) {
      throw new NotFoundException('Đơn hàng không tồn tại');
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      if (newStatus === 'COMPLETED' && order.status !== 'COMPLETED') {
        for (const item of order.items) {
          await tx.product.update({
            where: { id: item.productId },
            data: {
              stock: { decrement: item.quantity },
              reservedStock: { decrement: item.quantity },
            },
          });
        }
      }

      return tx.order.update({
        where: { id: orderId },
        data: { status: newStatus },
        include: { items: true },
      });
    });

    const statusPayload = { order: updated, storeId: order.storeId, customerId: order.customerId };
    this.eventsGateway.emitToStore(order.storeId, 'ORDER_STATUS_CHANGED', statusPayload);
    this.eventsGateway.emitToCustomer(order.customerId, 'ORDER_STATUS_CHANGED', statusPayload);
    this.eventsGateway.emitGlobal('ORDER_STATUS_CHANGED', statusPayload);

    return updated;
  }


  async list(user: any, status?: string) {
    let whereClause: any = {};
    if (user.role === 'CUSTOMER') {
      whereClause.customerId = user.customerProfileId;
    } else if (['STORE_OWNER', 'STORE_MANAGER', 'STORE_STAFF'].includes(user.role)) {
      whereClause.storeId = user.storeId;
    }

    if (status) {
      whereClause.status = status;
    }

    return this.prisma.order.findMany({
      where: whereClause,
      include: {
        items: { include: { product: true } },
        device: { include: { configuration: true } },
        customer: { include: { user: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getById(id: string) {
    return this.prisma.order.findUnique({
      where: { id },
      include: {
        items: { include: { product: true } },
        device: { include: { configuration: true } },
        customer: { include: { user: true } },
      },
    });
  }

  /**
   * Mô phỏng gửi tín hiệu bấm nút lên server (dành cho Store & Khách hàng test)
   * Server nhận diện nút qua bộ định danh (deviceId, serialNumber, macAddress, hoặc id),
   * tự động map sản phẩm & số lượng đã config, kiểm tra trạng thái và tạo đơn hàng.
   */
  async simulateButtonPress(body: { deviceId?: string; id?: string; code?: string; eventType?: string }, user?: any) {
    const identifier = (body.deviceId || body.id || body.code || '').trim();
    if (!identifier) {
      throw new BadRequestException('Vui lòng cung cấp bộ định danh nút bấm (Device ID, Serial hoặc ID)');
    }

    // Tra cứu thiết bị qua bất kỳ định danh nào
    const device = await this.prisma.device.findFirst({
      where: {
        OR: [
          { id: identifier },
          { deviceId: identifier },
          { serialNumber: identifier },
          { macAddress: identifier },
          { pairingCode: identifier },
          { qrPayload: identifier },
        ],
      },
      include: {
        configuration: { include: { product: true } },
        product: true,
        customer: { include: { user: true } },
        store: true,
      },
    });

    if (!device) {
      throw new NotFoundException(`Không tìm thấy nút bấm với định danh "${identifier}"`);
    }

    if (!device.customerId) {
      const storeCustomer = await this.prisma.customerProfile.findFirst({
        where: { storeId: device.storeId || undefined },
        include: { user: true },
      });
      if (storeCustomer) {
        await this.prisma.device.update({
          where: { id: device.id },
          data: { customerId: storeCustomer.id },
        });
        device.customerId = storeCustomer.id;
        device.customer = storeCustomer;
      } else {
        throw new BadRequestException('Nút bấm chưa được gán cho khách hàng nào để tạo đơn');
      }
    }

    if (!device.configuration && device.productId) {
      const newConfig = await this.prisma.deviceConfiguration.create({
        data: {
          deviceId: device.id,
          customName: device.customName || 'Smart Order Button',
          productId: device.productId,
          defaultQuantity: 1,
          cancelWindowSeconds: 60,
        },
        include: { product: true },
      });
      device.configuration = newConfig;
    }

    const eventType = body.eventType || 'DOUBLE_PRESS';
    const requestId = `sim_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

    const orderResult = await this.handleButtonEvent(device, {
      eventType,
      requestId,
      battery: device.batteryLevel,
      rssi: device.wifiRSSI,
    });

    return {
      success: true,
      code: 'SIMULATED_BUTTON_PRESS_SUCCESS',
      message: `Mô phỏng bấm nút thành công! Server đã nhận diện nút [${device.deviceId}], map sản phẩm [${device.configuration?.product?.name || device.product?.name}] và tạo đơn hàng.`,
      data: {
        device: {
          deviceId: device.deviceId,
          customName: device.customName,
          batteryLevel: device.batteryLevel,
          expiresAt: device.expiresAt,
          status: device.status,
        },
        product: device.configuration?.product || device.product,
        quantity: device.configuration?.defaultQuantity || 1,
        order: orderResult,
      },
    };
  }
}

