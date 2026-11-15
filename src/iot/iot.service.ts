import * as crypto from 'crypto';
import { Injectable, BadRequestException, InternalServerErrorException, Inject, Logger } from '@nestjs/common';
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
  private readonly logger = new Logger(IotService.name);
  public readonly deviceCooldowns = new Map<string, number>();
  public readonly inFlightRequests = new Set<string>();
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

    const rawDeviceId = device?.buttonId || device?.deviceId || device?.id;
    if (!rawDeviceId) {
      throw new BadRequestException('Thiết bị không xác định hợp lệ (Thiếu buttonId/deviceId)');
    }
    const deviceId = BigInt(rawDeviceId);
    const reqKey = `${rawDeviceId}:${requestId}`;

    // 0. Early Idempotency Check (Network Re-transmission & In-Flight Concurrency)
    if (processedRequests.has(reqKey) || processedRequests.has(requestId)) {
      const cached = processedRequests.get(reqKey) || processedRequests.get(requestId);
      return {
        success: true,
        isDuplicate: true,
        message: 'Yêu cầu trùng lặp đã được ngăn chặn (Idempotency Key)',
        data: {
          orderId: cached?.orderId ? cached.orderId.toString() : undefined,
          isDuplicate: true,
        },
      };
    }

    if (this.inFlightRequests.has(reqKey)) {
      return {
        success: true,
        isDuplicate: true,
        message: 'Yêu cầu đang được xử lý bởi một tiến trình khác (In-Flight Concurrency)',
        data: {
          isDuplicate: true,
        },
      };
    }

    // 1. Hardware switch debounce / anti-jamming check (for NEW distinct presses)
    const now = Date.now();
    const lastPressTime = this.deviceCooldowns.get(device.deviceId || rawDeviceId.toString()) || 0;
    if (now - lastPressTime < this.debounceCooldownMs) {
      return {
        success: false,
        code: 'BUTTON_DEBOUNCE_ACTIVE',
        message: 'Nút bấm đang trong thời gian giãn cách chống kẹt phím (Debounce cooldown). Vui lòng thử lại sau giây lát.',
        data: {
          deviceId: device.deviceId || rawDeviceId.toString(),
          retryAfterMs: this.debounceCooldownMs - (now - lastPressTime),
        },
      };
    }
    this.deviceCooldowns.set(device.deviceId || rawDeviceId.toString(), now);
    this.inFlightRequests.add(reqKey);

    // 2. Handle Heartbeat (No order creation, no idempotency lock needed)
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

    // 3. Handle CANCEL action requested via double press
    if (eventType === 'CANCEL') {
      const pendingOrder = await this.prisma.order.findFirst({
        where: { buttonId: device.buttonId, orderStatus: 'PENDING' },
        orderBy: { orderDate: 'desc' },
      });

      if (pendingOrder) {
        const cancelWindowSeconds = Number(device.cancelWindowSeconds || 60);
        const elapsedSeconds = (Date.now() - new Date(pendingOrder.createdAt).getTime()) / 1000;
        if (elapsedSeconds > cancelWindowSeconds) {
          return {
            success: false,
            action: 'CANCEL_ORDER',
            code: 'CANCEL_WINDOW_EXPIRED',
            message: `Đã hết thời gian cho phép hủy đơn hàng (${cancelWindowSeconds} giây kể từ khi đặt đơn).`,
          };
        }

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

    // 4. Multi-instance atomic idempotency lease acquisition with Fencing Token in PostgreSQL (Fail-Closed)
    const leaseToken = crypto.randomUUID();
    try {
      const insertRes = await this.prisma.$queryRawUnsafe<any[]>(
        `INSERT INTO iot_idempotency_keys (device_id, request_id, status, lease_token, locked_until)
         VALUES ($1, $2, 'PROCESSING', $3, NOW() + INTERVAL '30 seconds')
         ON CONFLICT (device_id, request_id) DO UPDATE
           SET status = 'PROCESSING',
               lease_token = $3,
               locked_until = NOW() + INTERVAL '30 seconds',
               updated_at = NOW()
           WHERE iot_idempotency_keys.status = 'FAILED'
              OR (iot_idempotency_keys.status = 'PROCESSING' AND iot_idempotency_keys.locked_until < NOW())
         RETURNING id, status, lease_token, order_id`,
        deviceId,
        requestId,
        leaseToken,
      );

      if (!insertRes || insertRes.length === 0) {
        // Row exists and is not eligible for acquisition (COMPLETED or active PROCESSING)
        const existingRow = await this.prisma.$queryRawUnsafe<any[]>(
          `SELECT status, order_id, locked_until FROM iot_idempotency_keys WHERE device_id = $1 AND request_id = $2`,
          deviceId,
          requestId,
        );
        const existing = existingRow?.[0];
        const existingOrderId = existing?.order_id;

        return {
          success: true,
          isDuplicate: true,
          message: existing?.status === 'COMPLETED'
            ? 'Yêu cầu trùng lặp đã được ngăn chặn (Idempotency Key)'
            : 'Yêu cầu đang được xử lý bởi một tiến trình khác (In-Flight Concurrency)',
          data: {
            orderId: existingOrderId ? existingOrderId.toString() : undefined,
            isDuplicate: true,
          },
        };
      }
    } catch (dbErr: any) {
      this.logger.error(`Idempotency verification error: ${dbErr.message}`);
      throw new InternalServerErrorException('Lỗi hệ thống khi xác thực tính duy nhất của yêu cầu (Fail-Closed)');
    }

    // Check low battery / hardware faults and dispatch alerts
    await this.checkAndDispatchDeviceAlerts(device, {
      battery,
      eventType,
      faultCode: body.faultCode,
      rssi,
      pressCount: body.pressCount,
    });

    // 5. Emit real-time tactile pressing animation to web UI
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

    // 6. Create Order with atomic completion & failure recovery in PostgreSQL
    try {
      const orderResult = await this.ordersService.handleButtonEvent(device, {
        eventType,
        requestId,
        paymentMethod: body.paymentMethod || 'COD',
        shippingFee: body.shippingFee || 0,
        battery,
        rssi,
      });

      const targetCreatedOrderId = (orderResult as any)?.order?.orderId || (orderResult as any)?.orderId;

      // Mark idempotency key as COMPLETED with associated order_id and lease fencing validation
      const updatedCount = await this.prisma.$executeRawUnsafe(
        `UPDATE iot_idempotency_keys
         SET status = 'COMPLETED', order_id = $1, updated_at = NOW()
         WHERE device_id = $2 AND request_id = $3 AND lease_token = $4 AND status = 'PROCESSING'`,
        targetCreatedOrderId ? BigInt(targetCreatedOrderId) : null,
        deviceId,
        requestId,
        leaseToken,
      );

      if (updatedCount === 0) {
        this.logger.warn(`[IoT Idempotency] Worker lease expired or fenced out before COMPLETED (requestId: ${requestId}, leaseToken: ${leaseToken})`);
      }

      processedRequests.set(requestId, orderResult);
      processedRequests.set(reqKey, orderResult);

      return {
        success: true,
        message: 'Đã xử lý tín hiệu đặt hàng từ nút bấm IoT thành công!',
        data: orderResult,
      };
    } catch (orderErr: any) {
      // Order creation failed: mark key as FAILED to unlock retry (checked against lease_token)
      this.logger.warn(`Order creation failed for requestId ${requestId}: ${orderErr.message}. Marking key as FAILED for retry.`);
      try {
        await this.prisma.$executeRawUnsafe(
          `UPDATE iot_idempotency_keys
           SET status = 'FAILED', updated_at = NOW()
           WHERE device_id = $1 AND request_id = $2 AND lease_token = $3 AND status = 'PROCESSING'`,
          deviceId,
          requestId,
          leaseToken,
        );
      } catch (updateErr: any) {
        this.logger.error(`Failed to update key status to FAILED: ${updateErr.message}`);
      }
      throw orderErr;
    } finally {
      this.inFlightRequests.delete(reqKey);
    }
  }

  async handleTelemetry(device: any, body: any) {
    const { battery = 100, rssi = -50 } = body;
    await this.checkAndDispatchDeviceAlerts(device, {
      battery,
      eventType: 'TELEMETRY',
      rssi,
    });

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

  /**
   * Helper phát hiện cảnh báo lỗi phần cứng & pin yếu (< 20%)
   * Tự động phát WebSocket DEVICE_FAULT_ALERT tới Admin/Store/Customer
   * và ghi record vào Notification database.
   */
  async checkAndDispatchDeviceAlerts(
    device: any,
    info: { battery?: number; eventType?: string; faultCode?: string; rssi?: number; pressCount?: number },
  ) {
    try {
      const numBattery = info.battery !== undefined ? Number(info.battery) : 100;

      // 1. Cập nhật batteryLevel trên iot_button
      if (device?.buttonId && info.battery !== undefined) {
        await this.prisma.ioTButton.update({
          where: { buttonId: BigInt(device.buttonId) },
          data: { batteryLevel: numBattery },
        }).catch(() => {});
      }

      const isLowBattery = numBattery > 0 && numBattery < 20;
      const isFaultEvent =
        ['BUTTON_STUCK', 'HARDWARE_FAULT', 'CHILD_SPAM_DETECTED'].includes(info.eventType || '') ||
        Boolean(info.faultCode);

      if (!isLowBattery && !isFaultEvent) {
        return;
      }

      const faultType = isLowBattery ? 'LOW_BATTERY' : (info.faultCode || info.eventType || 'UNKNOWN_FAULT');
      const alertData = {
        deviceId: device?.deviceId || String(device?.buttonId || ''),
        batteryLevel: numBattery,
        rssi: Number(info.rssi || -50),
        pressCount: Number(info.pressCount || 1),
        faultType,
        occurredAt: new Date(),
      };

      // Realtime WebSocket broadcast
      const gateway = this.ordersService['eventsGateway'];
      if (gateway) {
        if (typeof gateway.emitToAdmin === 'function') {
          gateway.emitToAdmin('DEVICE_FAULT_ALERT', alertData);
        }
        if (device?.storeId && typeof gateway.emitToStore === 'function') {
          gateway.emitToStore(device.storeId.toString(), 'DEVICE_FAULT_ALERT', alertData);
        }
        if (device?.customerId && typeof gateway.emitToCustomer === 'function') {
          gateway.emitToCustomer(device.customerId.toString(), 'DEVICE_FAULT_ALERT', alertData);
        }
      }

      // Persist Notification to DB for store owner
      if (device?.storeId) {
        const store = await this.prisma.store.findUnique({
          where: { storeId: BigInt(device.storeId) },
          select: { ownerUserId: true, name: true },
        });

        if (store?.ownerUserId) {
          const notifTitle = isLowBattery
            ? `[Cảnh báo] Nút bấm ${device.buttonCode || device.deviceId} pin yếu (${numBattery}%)`
            : `[Cảnh báo sự cố] Nút bấm ${device.buttonCode || device.deviceId}: ${faultType}`;
          const notifBody = isLowBattery
            ? `Nút bấm tại cửa hàng ${store.name || ''} sắp hết pin (${numBattery}% < 20%). Vui lòng kiểm tra sạc hoặc gửi bảo hành.`
            : `Phát hiện sự cố trên nút bấm: ${faultType}. Vui lòng kiểm tra tình trạng thiết bị.`;

          await this.prisma.notification.create({
            data: {
              userId: store.ownerUserId,
              type: faultType,
              title: notifTitle,
              body: notifBody,
              data: alertData,
              idempotencyKey: `alert:${device.deviceId || device.buttonId}:${faultType}:${Math.floor(Date.now() / 300000)}`,
            },
          }).catch(() => {});
        }
      }
    } catch (err: any) {
      this.logger.warn(`Lỗi khi xử lý cảnh báo thiết bị IoT: ${err.message}`);
    }
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
