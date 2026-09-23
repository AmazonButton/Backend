import { Controller, Get, Post, Body, Inject, HttpCode, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import * as https from 'https';
import { PrismaService } from './prisma/prisma.service';
import { OrdersService } from './orders/orders.service';
import { EventsGateway } from './websocket/events.gateway';
import { HmacAuthGuard } from './common/guards/hmac-auth.guard';

@Controller()
export class AppController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(OrdersService) private readonly ordersService: OrdersService,
    @Inject(EventsGateway) private readonly eventsGateway: EventsGateway,
  ) {}

  @Get('health')
  @Get('healthz')
  @Get('readyz')
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
      service: 'NestJS Smart Order Backend (BRD V2.1 Cloud Core)',
      database: {
        status: dbStatus,
        userCount,
        error: dbError,
        dbType: process.env.DATABASE_URL?.startsWith('postgres') ? 'PostgreSQL' : 'PostgreSQL/Prisma',
        dbUrlConfigured: !!process.env.DATABASE_URL,
      },
    };
  }

  @UseGuards(HmacAuthGuard)
  @HttpCode(200)
  @Post('event')
  async handleSimpleEvent(@Body() body: any) {
    const rawEvent = body.event || body.eventType || 'success';
    const event = rawEvent === 'WAKEUP' ? 'SINGLE_PRESS' : rawEvent;

    // Flexible button lookup
    const targetId = (body.deviceId || body.id || body.code || '').toString().trim().toUpperCase();
    let button = null;
    if (targetId) {
      button = await this.prisma.ioTButton.findFirst({
        where: {
          OR: [
            { deviceId: targetId },
            { buttonCode: targetId },
          ],
        },
        include: {
          store: true,
          customer: { include: { user: true } },
          buttonProducts: { include: { product: true } },
        },
      });
    }

    if (!button) {
      button = await this.prisma.ioTButton.findFirst({
        where: { status: 'ACTIVE' },
        include: {
          store: true,
          customer: { include: { user: true } },
          buttonProducts: { include: { product: true } },
        },
      });
    }

    if (!button) {
      return { success: false, message: 'Không tìm thấy thiết bị nút bấm hợp lệ trong hệ thống' };
    }

    if (event === 'start' || event === 'hold') {
      const pressingPayload = {
        deviceId: button.deviceId,
        customName: button.buttonName || 'Smart Order Button',
        message: 'Nút đang được nhấn giữ...',
      };
      if (button.customerId) {
        this.eventsGateway.emitToCustomer(button.customerId.toString(), 'BUTTON_PRESSING', pressingPayload);
      }
      if (button.storeId) {
        this.eventsGateway.emitToStore(button.storeId.toString(), 'BUTTON_PRESSING', pressingPayload);
      }
      this.eventsGateway.emitGlobal('BUTTON_PRESSING', pressingPayload);
      return { success: true, message: 'Đã nhận tín hiệu bắt đầu nhấn giữ nút' };
    }

    if (event === 'fail') {
      const releasePayload = {
        deviceId: button.deviceId,
        message: 'Đã thả nút sớm',
      };
      if (button.customerId) {
        this.eventsGateway.emitToCustomer(button.customerId.toString(), 'BUTTON_RELEASED', releasePayload);
      }
      if (button.storeId) {
        this.eventsGateway.emitToStore(button.storeId.toString(), 'BUTTON_RELEASED', releasePayload);
      }
      this.eventsGateway.emitGlobal('BUTTON_RELEASED', releasePayload);
      return { success: true, message: 'Người dùng đã thả nút sớm' };
    }

    if (event === 'cancel' || event === 'DOUBLE_PRESS') {
      try {
        const pendingOrder = await this.prisma.order.findFirst({
          where: { buttonId: button.buttonId, orderStatus: 'PENDING' },
          orderBy: { orderDate: 'desc' },
        });

        if (pendingOrder) {
          const cancelled = await this.ordersService.cancelOrder(
            pendingOrder.orderId,
            'Khách bấm nút hủy đơn trên ESP32',
          );
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
      const requestId = `btn_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
      const result = await this.ordersService.handleButtonEvent(button, {
        eventType: 'SINGLE_PRESS',
        requestId,
        battery: body.battery || 96,
        rssi: body.rssi || -55,
      });

      return {
        success: true,
        isDuplicate: result.isDuplicate,
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

  @UseGuards(HmacAuthGuard)
  @HttpCode(200)
  @Post('heartbeat')
  async handleSimpleHeartbeat(@Body() body: any) {
    const targetId = (body.deviceId || body.id || '').toString().trim().toUpperCase();
    let button = null;
    if (targetId) {
      button = await this.prisma.ioTButton.findFirst({
        where: {
          OR: [
            { deviceId: targetId },
            { buttonCode: targetId },
          ],
        },
      });
    }
    if (!button) {
      button = await this.prisma.ioTButton.findFirst({ where: { status: 'ACTIVE' } });
    }

    if (button) {
      const battery = body.battery !== undefined ? body.battery : 98;
      const rssi = body.rssi !== undefined ? body.rssi : -55;

      const heartbeatPayload = {
        deviceId: button.deviceId,
        isOnline: true,
        batteryLevel: battery,
        wifiRSSI: rssi,
        lastSeenAt: new Date().toISOString(),
      };

      if (button.storeId) {
        this.eventsGateway.emitToStore(button.storeId.toString(), 'DEVICE_HEARTBEAT', heartbeatPayload);
      }
      if (button.customerId) {
        this.eventsGateway.emitToCustomer(button.customerId.toString(), 'DEVICE_HEARTBEAT', heartbeatPayload);
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
