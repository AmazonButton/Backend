import { Injectable, BadRequestException, Inject } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { OrdersService } from '../orders/orders.service';

@Injectable()
export class IotService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(OrdersService) private readonly ordersService: OrdersService,
  ) {}

  private calculateDeviceHealth(batteryLevel: number, wifiRSSI: number, errorCount: number = 0) {
    const batteryScore = Math.min(40, Math.max(0, batteryLevel * 0.4));
    let signalScore = 15;
    if (wifiRSSI >= -60) signalScore = 40;
    else if (wifiRSSI >= -70) signalScore = 32;
    else if (wifiRSSI >= -80) signalScore = 22;
    else if (wifiRSSI >= -90) signalScore = 14;
    else signalScore = 8;

    const reliabilityScore = Math.max(0, 20 - errorCount * 2);
    const score = Math.min(100, Math.max(0, Math.round(batteryScore + signalScore + reliabilityScore)));
    const status = score >= 85 ? 'OPTIMAL' : score >= 65 ? 'GOOD' : score >= 45 ? 'ATTENTION' : 'CRITICAL';
    return { score, status };
  }

  async handleEvent(device: any, body: any) {
    const rawEvent = body.eventType || body.action || 'SINGLE_PRESS';
    const eventType = rawEvent.toUpperCase();
    const { requestId, battery = 100, rssi = -50 } = body;

    if (!requestId) {
      throw new BadRequestException('Thiếu trường requestId');
    }

    // Update device battery, RSSI, press count, and health score
    const health = this.calculateDeviceHealth(battery, rssi, device.errorCount || 0);
    const now = new Date();

    const updatedDevice = await this.prisma.device.update({
      where: { id: device.id },
      data: {
        lastSeenAt: now,
        batteryLevel: battery,
        wifiRSSI: rssi,
        healthScore: health.score,
        healthStatus: health.status,
        pressCount: { increment: 1 },
      },
      include: {
        configuration: { include: { product: true } },
        household: true,
      },
    });

    const config = updatedDevice.configuration;
    const householdId = updatedDevice.householdId;

    // Handle pure heartbeat (periodic keepalive)
    if (eventType === 'HEARTBEAT') {
      this.ordersService['eventsGateway'].emitGlobal('DEVICE_HEARTBEAT', {
        deviceId: updatedDevice.deviceId,
        batteryLevel: battery,
        wifiRSSI: rssi,
        healthScore: health.score,
        healthStatus: health.status,
        lastSeenAt: now,
      });
      return {
        success: true,
        code: 'DEVICE_HEARTBEAT_ACK',
        message: 'Ghi nhận tín hiệu nhịp tim thiết bị thành công!',
        data: { deviceId: updatedDevice.deviceId, healthScore: health.score },
      };
    }

    // Emit live button tactile indicator to web UI so button card lights up
    const pressingPayload = {
      deviceId: updatedDevice.deviceId,
      customName: config?.customName || updatedDevice.customName || 'Smart Order Button',
      message: 'Nút vật lý đang được bấm...',
    };
    if (updatedDevice.customerId) {
      this.ordersService['eventsGateway'].emitToCustomer(updatedDevice.customerId, 'BUTTON_PRESSING', pressingPayload);
    }
    if (updatedDevice.storeId) {
      this.ordersService['eventsGateway'].emitToStore(updatedDevice.storeId, 'BUTTON_PRESSING', pressingPayload);
    }
    this.ordersService['eventsGateway'].emitGlobal('BUTTON_PRESSING', pressingPayload);

    // If DOUBLE_PRESS or CANCEL: Check and cancel active pending order within 60s cancellation window
    if (eventType === 'DOUBLE_PRESS' || eventType === 'CANCEL') {
      const pendingOrder = await this.prisma.order.findFirst({
        where: { deviceId: updatedDevice.id, status: 'PENDING' },
        orderBy: { createdAt: 'desc' },
      });

      if (pendingOrder && (!pendingOrder.cancelExpiresAt || new Date() <= pendingOrder.cancelExpiresAt)) {
        const cancelled = await this.ordersService.cancelOrder(
          pendingOrder.id,
          'Khách bấm nhấp đúp nút vật lý ESP32 để hủy đơn trong cửa sổ 60s',
        );
        return {
          success: true,
          action: 'CANCEL_ACTIVE_REQUEST',
          code: 'ORDER_CANCELLED_BY_BUTTON',
          message: 'Đã hủy đơn hàng thành công qua thao tác nút bấm!',
          data: { order: cancelled },
        };
      }
    }

    // Determine target action based on Behavior Designer configuration
    // Treat WAKEUP from RTC button interrupt as SINGLE_PRESS
    const effectiveEvent = (eventType === 'WAKEUP') ? 'SINGLE_PRESS' : eventType;
    let targetAction = 'ORDER_PRODUCT';
    if (effectiveEvent === 'SINGLE_PRESS') {
      targetAction = config?.singlePressAction || 'ORDER_PRODUCT';
    } else if (effectiveEvent === 'DOUBLE_PRESS') {
      targetAction = config?.doublePressAction || 'ORDER_PRODUCT';
    } else if (effectiveEvent === 'HOLD_3S' || effectiveEvent === 'LONG_PRESS') {
      targetAction = config?.hold3sAction || 'REQUEST_SERVICE';
    } else if (effectiveEvent === 'HOLD_5S' || effectiveEvent === 'VERY_LONG_PRESS') {
      targetAction = config?.hold5sAction || 'TRIGGER_EMERGENCY';
    }

    console.log(`🔘 [IoT Event] Device ${updatedDevice.deviceId} -> Event: ${eventType} (Effective: ${effectiveEvent}) -> Action: ${targetAction}`);

    // ACTION 1: ORDER_PRODUCT
    if (targetAction === 'ORDER_PRODUCT') {

      const orderResult = await this.ordersService.handleButtonEvent(updatedDevice, {
        eventType: effectiveEvent,
        requestId,
        battery,
        rssi,
      });

      // Record consumption for statistical replenishment predictions
      if (householdId && config?.productId) {
        await this.prisma.consumptionRecord.create({
          data: {
            householdId,
            productId: config.productId,
            deviceId: updatedDevice.id,
            quantity: config.defaultQuantity || 1,
            orderId: orderResult?.order?.id || (orderResult as any)?.id,
          },
        }).catch((e) => console.log('Notice recording consumption:', e.message));
      }

      return {
        success: true,
        action: 'ORDER_PRODUCT',
        code: orderResult.isDuplicate ? 'ORDER_ACKNOWLEDGED_DUPLICATE' : 'ORDER_CREATED',
        message: orderResult.isDuplicate
          ? 'Đã ghi nhận đơn hàng trước đó (Anti-Spam Idempotent)'
          : `Đơn hàng mới (${config?.product?.name || 'Sản phẩm'}) đã được tạo thành công!`,
        data: orderResult,
      };
    }

    // ACTION 2: ADD_TO_SHOPPING_LIST
    if (targetAction === 'ADD_TO_SHOPPING_LIST') {
      if (!householdId) {
        throw new BadRequestException('Thiết bị chưa được gán vào căn hộ/gia đình');
      }

      let list = await this.prisma.shoppingList.findUnique({
        where: { householdId },
      });
      if (!list) {
        list = await this.prisma.shoppingList.create({
          data: { householdId },
        });
      }

      const productId = config?.productId;
      if (!productId) {
        throw new BadRequestException('Nút bấm chưa được cấu hình sản phẩm');
      }

      const existingItem = await this.prisma.shoppingListItem.findFirst({
        where: { shoppingListId: list.id, productId, isChecked: false },
      });

      let listItem;
      if (existingItem) {
        listItem = await this.prisma.shoppingListItem.update({
          where: { id: existingItem.id },
          data: {
            quantity: existingItem.quantity + (config.defaultQuantity || 1),
            addedFromDeviceId: updatedDevice.id,
          },
          include: { product: true },
        });
      } else {
        listItem = await this.prisma.shoppingListItem.create({
          data: {
            shoppingListId: list.id,
            productId,
            quantity: config.defaultQuantity || 1,
            addedFromDeviceId: updatedDevice.id,
          },
          include: { product: true },
        });
      }

      this.ordersService['eventsGateway'].emitGlobal('SHOPPING_LIST_UPDATED', {
        householdId,
        item: listItem,
        source: 'IOT_BUTTON',
        deviceName: config?.customName || updatedDevice.deviceId,
      });

      return {
        success: true,
        action: 'ADD_TO_SHOPPING_LIST',
        code: 'ITEM_ADDED_TO_SHOPPING_LIST',
        message: `Đã thêm ${listItem.product.name} vào danh sách mua sắm gia đình!`,
        data: listItem,
      };
    }

    // ACTION 3: REQUEST_SERVICE
    if (targetAction === 'REQUEST_SERVICE') {
      if (!householdId) {
        throw new BadRequestException('Thiết bị chưa được gán vào căn hộ/gia đình');
      }

      const serviceRequest = await this.prisma.serviceRequest.create({
        data: {
          householdId,
          deviceId: updatedDevice.id,
          storeId: updatedDevice.storeId,
          type: 'MAINTENANCE',
          category: config?.product ? `Hỗ trợ kỹ thuật: ${config.product.name}` : 'Kiểm tra thiết bị định kỳ',
          description: `Yêu cầu kích hoạt tự động từ nút bấm ${config?.customName || updatedDevice.deviceId} (Nhấn giữ 3s)`,
          priority: 'NORMAL',
          status: 'PENDING',
        },
        include: { household: true },
      });

      this.ordersService['eventsGateway'].emitGlobal('SERVICE_REQUEST_CREATED', {
        requestId: serviceRequest.id,
        householdName: serviceRequest.household?.name,
        category: serviceRequest.category,
        priority: serviceRequest.priority,
        status: serviceRequest.status,
      });

      return {
        success: true,
        action: 'REQUEST_SERVICE',
        code: 'SERVICE_REQUEST_CREATED',
        message: 'Đã gửi yêu cầu kỹ thuật/dịch vụ tới cửa hàng phụ trách!',
        data: serviceRequest,
      };
    }

    // ACTION 4: TRIGGER_EMERGENCY
    if (targetAction === 'TRIGGER_EMERGENCY') {
      if (!householdId) {
        throw new BadRequestException('Thiết bị chưa được gán vào căn hộ/gia đình');
      }

      const isGasDevice = config?.product?.category?.toLowerCase().includes('gas') || updatedDevice.deviceId.includes('GAS');
      const alertType = isGasDevice ? 'GAS_ISSUE' : 'SECURITY_ISSUE';
      const alertMsg = isGasDevice
        ? `CẢNH BÁO KHẨN CẤP: Phát hiện nguy cơ van gas tại bếp! Kích hoạt từ nút ${config?.customName || updatedDevice.deviceId}`
        : `CẢNH BÁO KHẨN CẤP: Kích hoạt khẩn cấp từ nút ${config?.customName || updatedDevice.deviceId}`;

      const alert = await this.prisma.urgentAlert.create({
        data: {
          householdId,
          deviceId: updatedDevice.id,
          alertType,
          message: alertMsg,
          status: 'ACTIVE',
        },
        include: { household: true },
      });

      this.ordersService['eventsGateway'].emitGlobal('URGENT_ALERT_TRIGGERED', {
        alertId: alert.id,
        householdId,
        householdName: alert.household?.name,
        alertType,
        message: alertMsg,
        urgency: 'CRITICAL',
      });

      return {
        success: true,
        action: 'TRIGGER_EMERGENCY',
        code: 'EMERGENCY_ALERT_TRIGGERED',
        message: 'Đã phát cảnh báo khẩn cấp tới tất cả thành viên gia đình và cửa hàng!',
        data: alert,
      };
    }

    // ACTION 5: CANCEL_ACTIVE_REQUEST
    if (targetAction === 'CANCEL_ACTIVE_REQUEST') {
      const pendingOrder = await this.prisma.order.findFirst({
        where: { deviceId: updatedDevice.id, status: 'PENDING' },
        orderBy: { createdAt: 'desc' },
      });
      if (pendingOrder) {
        const cancelled = await this.ordersService.cancelOrder(
          pendingOrder.id,
          'Khách bấm nút vật lý để hủy đơn',
        );
        return {
          success: true,
          action: 'CANCEL_ACTIVE_REQUEST',
          code: 'ORDER_CANCELLED',
          message: 'Đã hủy đơn hàng đang chờ thành công!',
          data: cancelled,
        };
      }

      return {
        success: true,
        action: 'CANCEL_ACTIVE_REQUEST',
        code: 'NO_ACTIVE_REQUEST',
        message: 'Không có đơn hàng nào đang chờ xử lý cần hủy.',
      };
    }

    // Fallback: Default
    return {
      success: true,
      action: targetAction,
      code: 'ACTION_EXECUTED',
      message: `Đã thực hiện tác vụ ${targetAction} thành công!`,
    };
  }

  async handleTelemetry(device: any, body: any) {
    const {
      battery = 100,
      voltageMv = 3700,
      rssi = -50,
      bootReason = 'GPIO_WAKEUP',
      wakeDurationMs = 2800,
      firmwareVersion = '2.1.0',
    } = body;

    const health = this.calculateDeviceHealth(battery, rssi, device.errorCount || 0);

    const telemetry = await this.prisma.deviceTelemetry.create({
      data: {
        deviceId: device.id,
        batteryLevel: battery,
        voltageMv,
        wifiRSSI: rssi,
        bootReason,
        wakeDurationMs,
        firmwareVersion,
      },
    });

    await this.prisma.device.update({
      where: { id: device.id },
      data: {
        batteryLevel: battery,
        wifiRSSI: rssi,
        healthScore: health.score,
        healthStatus: health.status,
        lastSeenAt: new Date(),
      },
    });

    return {
      success: true,
      message: 'Ghi nhận thông số telemetry thành công',
      data: {
        ...telemetry,
        healthScore: health.score,
        healthStatus: health.status,
      },
    };
  }

  async getConfig(device: any) {
    const config = await this.prisma.deviceConfiguration.findUnique({
      where: { deviceId: device.id },
      include: { product: true },
    });

    return {
      success: true,
      data: {
        deviceId: device.deviceId,
        customName: config?.customName || 'SmartSupply IoT Button',
        productName: config?.product?.name || 'Sản phẩm',
        cancelWindowSeconds: config?.cancelWindowSeconds || 60,
        soundEnabled: config?.soundEnabled ?? true,
        ledEnabled: config?.ledEnabled ?? true,
        singlePressAction: config?.singlePressAction || 'ORDER_PRODUCT',
        doublePressAction: config?.doublePressAction || 'ADD_TO_SHOPPING_LIST',
        hold3sAction: config?.hold3sAction || 'REQUEST_SERVICE',
        hold5sAction: config?.hold5sAction || 'TRIGGER_EMERGENCY',
        healthScore: device.healthScore,
        healthStatus: device.healthStatus,
        version: config?.version || 2,
      },
    };
  }
}
