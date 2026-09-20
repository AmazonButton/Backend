import { Controller, Get, Post, Body, Inject, HttpCode, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import * as https from 'https';
import { PrismaService } from './prisma/prisma.service';
import { OrdersService } from './orders/orders.service';
import { EventsGateway } from './websocket/events.gateway';

@Controller()
export class AppController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(OrdersService) private readonly ordersService: OrdersService,
    @Inject(EventsGateway) private readonly eventsGateway: EventsGateway,
  ) {}

  @Get('health')
  async getHealth() {
    let dbStatus = 'UNKNOWN';
    let dbError = null;
    let userCount = -1;
    try {
      userCount = await this.prisma.user.count();
      dbStatus = 'CONNECTED';
    } catch (err: any) {
      dbStatus = 'ERROR';
      dbError = err.message;
    }

    return {
      status: 'OK',
      timestamp: new Date().toISOString(),
      service: 'NestJS Smart Order Backend',
      database: {
        status: dbStatus,
        userCount,
        error: dbError,
        dbType: process.env.DATABASE_URL?.startsWith('postgres') ? 'PostgreSQL' : 'SQLite/Other',
        dbUrlConfigured: !!process.env.DATABASE_URL,
      },
    };
  }

  @HttpCode(200)
  @Post('event')
  async handleSimpleEvent(@Body() body: any) {
    const rawEvent = body.event || body.eventType || 'success';
    const event = (rawEvent === 'WAKEUP') ? 'SINGLE_PRESS' : rawEvent;
    console.log(`🔘 [ESP32 Simple Event] Nhận sự kiện từ nút bấm: ${rawEvent} (mapped: ${event})`);

    // Flexible device lookup
    const targetId = (body.deviceId || body.id || body.code || '').toString().trim();
    let device = null;
    if (targetId) {
      device = await this.prisma.device.findFirst({
        where: {
          OR: [
            { deviceId: targetId },
            { id: targetId },
            { serialNumber: targetId },
            { pairingCode: targetId },
          ],
        },
        include: { configuration: true, customer: { include: { user: true } }, store: true },
      });
    }

    if (!device) {
      // Fallback: Lấy thiết bị active đầu tiên trong hệ thống
      device = await this.prisma.device.findFirst({
        where: { status: 'ACTIVE' },
        include: { configuration: true, customer: { include: { user: true } }, store: true },
      });
    }

    if (!device) {
      return { success: false, message: 'Không tìm thấy thiết bị nút bấm hợp lệ trong hệ thống' };
    }

    if (event === 'start' || event === 'hold') {
      const pressingPayload = {
        deviceId: device.deviceId,
        customName: device.configuration?.customName || 'Nút Nước Lavie Bếp',
        message: 'Nút đang được nhấn giữ...',
      };
      if (device.customerId) {
        this.eventsGateway.emitToCustomer(device.customerId, 'BUTTON_PRESSING', pressingPayload);
      }
      if (device.storeId) {
        this.eventsGateway.emitToStore(device.storeId, 'BUTTON_PRESSING', pressingPayload);
      }
      this.eventsGateway.emitGlobal('BUTTON_PRESSING', pressingPayload);
      return { success: true, message: 'Đã nhận tín hiệu bắt đầu nhấn giữ nút' };
    }

    if (event === 'fail') {
      const releasePayload = {
        deviceId: device.deviceId,
        message: 'Đã thả nút sớm',
      };
      if (device.customerId) {
        this.eventsGateway.emitToCustomer(device.customerId, 'BUTTON_RELEASED', releasePayload);
      }
      if (device.storeId) {
        this.eventsGateway.emitToStore(device.storeId, 'BUTTON_RELEASED', releasePayload);
      }
      this.eventsGateway.emitGlobal('BUTTON_RELEASED', releasePayload);
      return { success: true, message: 'Người dùng đã thả nút sớm' };
    }

    if (event === 'cancel' || event === 'DOUBLE_PRESS') {
      try {
        const pendingOrder = await this.prisma.order.findFirst({
          where: { deviceId: device.id, status: 'PENDING' },
          orderBy: { createdAt: 'desc' },
        });

        if (pendingOrder) {
          const cancelled = await this.ordersService.cancelOrder(
            pendingOrder.id,
            'Khách bấm nút hủy đơn trên ESP32',
          );
          console.log(`❌ [ESP32 Simple Event] Đã hủy đơn hàng: ${cancelled.orderNumber}`);
          return {
            success: true,
            code: 'ORDER_CANCELLED',
            message: 'Đã hủy đơn hàng thành công qua nút bấm',
            orderNumber: cancelled.orderNumber,
            blink: true,
          };
        }
        return {
          success: false,
          code: 'NO_PENDING_ORDER',
          message: 'Không có đơn hàng nào đang chờ để hủy trong 60 giây',
          blink: false,
        };
      } catch (err: any) {
        return {
          success: false,
          code: 'CANCEL_FAILED',
          message: err.message || 'Hủy đơn không thành công',
          blink: false,
        };
      }
    }

    // Create order on 'success' or 'SINGLE_PRESS'
    try {
      // Emit live button tactile indicator to web UI so button card lights up immediately
      const pressingPayload = {
        deviceId: device.deviceId,
        customName: device.configuration?.customName || device.customName || 'Smart Order Button',
        message: 'Nút vật lý đang được bấm...',
      };
      if (device.customerId) {
        this.eventsGateway.emitToCustomer(device.customerId, 'BUTTON_PRESSING', pressingPayload);
      }
      if (device.storeId) {
        this.eventsGateway.emitToStore(device.storeId, 'BUTTON_PRESSING', pressingPayload);
      }
      this.eventsGateway.emitGlobal('BUTTON_PRESSING', pressingPayload);

      const requestId = `btn_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
      const result = await this.ordersService.handleButtonEvent(device, {
        eventType: 'SINGLE_PRESS',
        requestId,
        battery: body.battery || 96,
        rssi: body.rssi || -55,
      });

      if (result.isDuplicate) {
        console.log(`⚠️ [ESP32 Simple Event] Đơn hàng đang xử lý (chống spam 30s): ${result.order.orderNumber}`);
        if (device.customerId) {
          this.eventsGateway.emitToCustomer(device.customerId, 'ORDER_DUPLICATE_THROTTLED', {
            order: result.order,
            message: 'Đơn hàng gần đây đang được xử lý, tránh bấm lặp lại trong 30 giây.',
          });
        }
        return {
          success: true,
          isDuplicate: true,
          message: 'Đơn hàng gần đây đang được xử lý (tránh đặt trùng trong 30s)',
          orderNumber: result.order.orderNumber,
          blink: true,
        };
      }

      console.log(`✅ [ESP32 Simple Event] ĐÃ TẠO ĐƠN HÀNG THÀNH CÔNG: ${result.order.orderNumber}`);

      return {
        success: true,
        isDuplicate: false,
        message: 'Đã tạo đơn hàng thành công qua nút bấm ESP32!',
        orderNumber: result.order.orderNumber,
        totalAmount: result.order.totalAmount,
        blink: true,
      };
    } catch (err: any) {
      console.error('❌ [ESP32 Simple Event Error]', err);
      return {
        success: false,
        message: err.message || 'Lỗi khi tạo đơn hàng qua nút bấm',
        blink: false,
      };
    }
  }

  @HttpCode(200)
  @Post('heartbeat')
  async handleSimpleHeartbeat(@Body() body: any) {
    const targetId = (body.deviceId || body.id || '').toString().trim();
    let device = null;
    if (targetId) {
      device = await this.prisma.device.findFirst({
        where: {
          OR: [
            { deviceId: targetId },
            { id: targetId },
            { serialNumber: targetId },
            { pairingCode: targetId },
          ],
        },
      });
    }
    if (!device) {
      device = await this.prisma.device.findFirst({ where: { status: 'ACTIVE' } });
    }

    if (device) {
      const now = new Date();
      const battery = body.battery !== undefined ? body.battery : device.batteryLevel;
      const rssi = body.rssi !== undefined ? body.rssi : device.wifiRSSI;

      await this.prisma.device.update({
        where: { id: device.id },
        data: {
          lastSeenAt: now,
          wifiRSSI: rssi,
          batteryLevel: battery,
        },
      });

      const heartbeatPayload = {
        deviceId: device.deviceId,
        isOnline: true,
        batteryLevel: battery,
        wifiRSSI: rssi,
        lastSeenAt: now.toISOString(),
      };

      if (device.storeId) {
        this.eventsGateway.emitToStore(device.storeId, 'DEVICE_HEARTBEAT', heartbeatPayload);
      }
      if (device.customerId) {
        this.eventsGateway.emitToCustomer(device.customerId, 'DEVICE_HEARTBEAT', heartbeatPayload);
      }
    }

    return {
      status: 'OK',
      timestamp: Date.now(),
      message: 'Heartbeat acknowledged',
      blink: false,
    };
  }

  @Get('tts')
  async streamTTS(@Query('text') text: string, @Res() res: Response) {
    if (!text || !text.trim()) {
      return res.status(400).send('Missing text query parameter');
    }
    const safeText = text.trim().substring(0, 200);
    const googleTtsUrl = `https://translate.google.com/translate_tts?ie=UTF-8&tl=vi&client=tw-ob&q=${encodeURIComponent(safeText)}`;

    const req = https.get(googleTtsUrl, (googleRes) => {
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      googleRes.pipe(res);
    });

    req.on('error', (err) => {
      res.status(500).send('TTS error: ' + err.message);
    });
  }
}


