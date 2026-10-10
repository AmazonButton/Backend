import { Injectable, BadRequestException, Inject } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { OrdersService } from '../orders/orders.service';

const processedRequests = new Map<string, any>();

// Clean up processedRequests older than 5 minutes
const cleanupTimer = setInterval(() => {
  if (processedRequests.size > 1000) {
    processedRequests.clear();
  }
}, 300000);
if (cleanupTimer && typeof cleanupTimer.unref === 'function') {
  cleanupTimer.unref();
}

@Injectable()
export class IotService {
  public readonly deviceCooldowns = new Map<string, number>();
  public readonly debounceCooldownMs = 2500;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(OrdersService) private readonly ordersService: OrdersService,
  ) {}

  async handleEvent(device: any, body: any) {
    const rawEvent = body.eventType || body.action || 'SINGLE_PRESS';
    const eventType = rawEvent.toUpperCase();
    const { requestId, battery = 100, rssi = -50 } = body;

    if (!requestId) {
      throw new BadRequestException('Thiếu trường requestId');
    }

    // Multi-instance persistent idempotency check in PostgreSQL
    const existingOrder = await this.prisma.order.findFirst({
      where: {
        orderNote: { contains: `REQ:${requestId}` },
      },
    });

    if (existingOrder || processedRequests.has(requestId)) {
      const cached = processedRequests.get(requestId) || {
        orderId: existingOrder?.orderId.toString(),
        orderCode: existingOrder?.orderCode,
      };
      return {
        success: true,
        isDuplicate: true,
        message: 'Yêu cầu trùng lặp đã được ngăn chặn (Idempotency Key)',
        data: {
          ...cached,
          isDuplicate: true,
        },
      };
    }

    // Handle Heartbeat
    if (eventType === 'HEARTBEAT') {
      const hbPayload = {
        deviceId: device.deviceId,
        batteryLevel: battery,
        wifiRSSI: rssi,
        lastSeenAt: new Date(),
      };
      if (device.storeId) {
        this.ordersService['eventsGateway'].emitToStore(device.storeId.toString(), 'DEVICE_HEARTBEAT', hbPayload);
      }
      if (device.customerId) {
        this.ordersService['eventsGateway'].emitToCustomer(device.customerId.toString(), 'DEVICE_HEARTBEAT', hbPayload);
      }
      return {
        success: true,
        code: 'DEVICE_HEARTBEAT_ACK',
        message: 'Ghi nhận nhịp tim thiết bị thành công!',
        data: { deviceId: device.deviceId },
      };
    }

    // Hardware switch debounce / anti-jamming check (per deviceId)
    const now = Date.now();
    const lastPressTime = this.deviceCooldowns.get(device.deviceId) || 0;
    if (now - lastPressTime < this.debounceCooldownMs) {
      return {
        success: false,
        code: 'BUTTON_DEBOUNCE_ACTIVE',
        message: 'Nút bấm đang trong thời gian giãn cách chống kẹt phím (Debounce cooldown). Vui lòng thử lại sau giây lát.',
        data: {
          deviceId: device.deviceId,
          retryAfterMs: this.debounceCooldownMs - (now - lastPressTime),
        },
      };
    }
    this.deviceCooldowns.set(device.deviceId, now);

    // Reserve requestId in idempotency map immediately to block concurrent duplicate bursts
    processedRequests.set(requestId, { status: 'PROCESSING' });

    // Emit real-time tactile pressing animation to web UI
    const pressingPayload = {
      deviceId: device.deviceId,
      buttonName: device.buttonName || 'Smart Order Button',
      message: 'Nút vật lý đang được bấm...',
    };
    if (device.customerId) {
      this.ordersService['eventsGateway'].emitToCustomer(device.customerId.toString(), 'BUTTON_PRESSING', pressingPayload);
    }
    if (device.storeId) {
      this.ordersService['eventsGateway'].emitToStore(device.storeId.toString(), 'BUTTON_PRESSING', pressingPayload);
    }

    // If CANCEL action requested via double press
    if (eventType === 'CANCEL') {
      const pendingOrder = await this.prisma.order.findFirst({
        where: { buttonId: device.buttonId, orderStatus: 'PENDING' },
        orderBy: { orderDate: 'desc' },
      });

      if (pendingOrder) {
        const cancelled = await this.ordersService.cancelOrder(
          pendingOrder.orderId,
          'Khách bấm nút vật lý để hủy đơn',
        );
        return {
          success: true,
          action: 'CANCEL_ORDER',
          code: 'ORDER_CANCELLED',
          message: 'Đã hủy đơn hàng đang chờ thành công!',
          data: cancelled,
        };
      }

      return {
        success: true,
        action: 'CANCEL_ORDER',
        code: 'NO_ACTIVE_ORDER',
        message: 'Không có đơn hàng nào đang chờ xử lý cần hủy.',
      };
    }

    // Single / Double press or other triggers: Delegate to OrdersService to create order via Stored Procedure
    const orderResult = await this.ordersService.handleButtonEvent(device, {
      eventType,
      requestId,
      paymentMethod: body.paymentMethod || 'COD',
      shippingFee: body.shippingFee || 0,
    });

    // Save into idempotency map
    processedRequests.set(requestId, orderResult);

    return {
      success: true,
      message: 'Đã xử lý tín hiệu đặt hàng từ nút bấm IoT thành công!',
      data: orderResult,
    };
  }

  async handleTelemetry(device: any, body: any) {
    const { battery = 100, rssi = -50 } = body;
    return {
      success: true,
      message: 'Ghi nhận thông số telemetry thành công',
      data: {
        deviceId: device.deviceId,
        battery,
        rssi,
        timestamp: new Date(),
      },
    };
  }

  async getConfig(device: any) {
    const button = await this.prisma.ioTButton.findUnique({
      where: { buttonId: device.buttonId },
      include: {
        store: true,
        customer: { include: { user: true } },
        buttonProducts: { include: { product: true } },
      },
    });

    return {
      success: true,
      data: {
        buttonId: button?.buttonId.toString(),
        deviceId: button?.deviceId,
        buttonCode: button?.buttonCode,
        buttonName: button?.buttonName,
        status: button?.status,
        storeName: button?.store.name,
        products: button?.buttonProducts.map((bp) => ({
          productId: bp.productId.toString(),
          productName: bp.product.productName,
          quantity: bp.quantity,
          basePrice: bp.product.basePrice,
        })),
      },
    };
  }
}
