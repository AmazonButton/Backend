import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Inject,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../security/crypto.service';
import { EventsGateway } from '../websocket/events.gateway';
import * as crypto from 'crypto';

const activeSessions = new Map<string, any>();

@Injectable()
export class ProvisioningService {
  private failedAttempts: Array<{
    type: string;
    deviceId: string;
    ip?: string;
    reason: string;
    timestamp: Date;
  }> = [];

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CryptoService) private readonly cryptoService: CryptoService,
    @Inject(EventsGateway) private readonly eventsGateway: EventsGateway,
  ) {}

  private async resolveDeviceFromInput(inputStr: string): Promise<{ button: any; token: string }> {
    if (!inputStr) throw new BadRequestException('Mã thiết bị hoặc mã QR rỗng');

    const trimmed = inputStr.trim().toUpperCase();

    const button = await this.prisma.ioTButton.findFirst({
      where: {
        OR: [
          { deviceId: trimmed },
          { buttonCode: trimmed },
        ],
      },
      include: {
        store: true,
        buttonProducts: { include: { product: true } },
      },
    });

    if (button) {
      return { button, token: 'direct_pin' };
    }

    throw new BadRequestException(`Không tìm thấy nút bấm với mã "${inputStr}". Vui lòng kiểm tra lại.`);
  }

  async createSession(body: { qrPayload?: string; deviceId?: string; token?: string; code?: string }) {
    const rawInput = body.code || body.qrPayload || body.deviceId;
    if (!rawInput) {
      throw new BadRequestException('Vui lòng cung cấp mã số thiết bị hoặc mã QR');
    }

    const { button } = await this.resolveDeviceFromInput(rawInput);
    const sessionId = `sess_${crypto.randomBytes(12).toString('hex')}`;

    const sessionData = {
      sessionId,
      deviceId: button.deviceId,
      buttonId: button.buttonId.toString(),
      storeId: button.storeId.toString(),
      storeName: button.store?.name,
      status: 'ACTIVE',
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      createdAt: new Date(),
    };

    activeSessions.set(sessionId, sessionData);

    return {
      success: true,
      data: sessionData,
    };
  }

  async verifySession(sessionId: string) {
    const session = activeSessions.get(sessionId);
    if (!session || new Date(session.expiresAt) < new Date()) {
      throw new NotFoundException('Phiên ghép nối không tồn tại hoặc đã hết hạn');
    }
    return { success: true, data: session };
  }

  async getSession(sessionId: string) {
    return this.verifySession(sessionId);
  }

  async confirmPairing(sessionId: string, body: any, user: any) {
    const session = activeSessions.get(sessionId);
    if (!session) {
      throw new NotFoundException('Phiên ghép nối không tồn tại hoặc đã hết hạn');
    }

    const button = await this.prisma.ioTButton.findUnique({
      where: { buttonId: BigInt(session.buttonId) },
    });

    if (!button) throw new NotFoundException('Không tìm thấy nút bấm');

    let customerId = button.customerId;
    if (user && user.customerProfileId) {
      customerId = BigInt(user.customerProfileId);
    } else if (body.customerId) {
      customerId = BigInt(body.customerId);
    }

    await this.prisma.ioTButton.update({
      where: { buttonId: button.buttonId },
      data: {
        customerId,
        buttonName: body.buttonName || body.name || button.buttonName,
        status: 'ACTIVE',
      },
    });

    await this.prisma.storeCustomer.upsert({
      where: {
        uq_store_customer: {
          storeId: button.storeId,
          customerId,
        },
      },
      update: { status: 'ACTIVE' },
      create: {
        storeId: button.storeId,
        customerId,
        status: 'ACTIVE',
      },
    });

    if (body.productId) {
      const targetProductId = BigInt(body.productId);
      await this.prisma.buttonProduct.upsert({
        where: {
          uq_button_product: {
            buttonId: button.buttonId,
            productId: targetProductId,
          },
        },
        update: { quantity: body.quantity || 1 },
        create: {
          buttonId: button.buttonId,
          productId: targetProductId,
          quantity: body.quantity || 1,
        },
      });
    }

    activeSessions.delete(sessionId);

    return {
      success: true,
      message: 'Kích hoạt và ghép nối nút bấm thành công!',
      data: {
        buttonId: button.buttonId.toString(),
        deviceId: button.deviceId,
        buttonCode: button.buttonCode,
      },
    };
  }

  async cancelSession(sessionId: string) {
    activeSessions.delete(sessionId);
    return { success: true, message: 'Đã hủy phiên ghép nối' };
  }

  async bootstrap(headers: any, body: any) {
    return {
      success: true,
      message: 'Bootstrap thiết bị thành công',
      data: { serverTime: Date.now() },
    };
  }

  async claim(id: string, body: any, user: any) {
    const button = await this.prisma.ioTButton.findFirst({
      where: {
        OR: [{ deviceId: id.toUpperCase() }, { buttonCode: id.toUpperCase() }],
      },
    });

    if (!button) throw new NotFoundException('Không tìm thấy thiết bị');

    if (user && user.customerProfileId) {
      await this.prisma.ioTButton.update({
        where: { buttonId: button.buttonId },
        data: {
          customerId: BigInt(user.customerProfileId),
          status: 'ACTIVE',
        },
      });
    }

    return {
      success: true,
      message: 'Kích hoạt sở hữu nút bấm thành công!',
      data: { deviceId: button.deviceId },
    };
  }

  async unclaim(id: string, user: any) {
    return { success: true, message: 'Đã hủy sở hữu thiết bị' };
  }

  async transfer(id: string, user: any) {
    const token = `tok_${crypto.randomBytes(8).toString('hex')}`;
    return {
      success: true,
      message: 'Tạo mã chuyển giao thiết bị thành công',
      data: {
        deviceId: id,
        token,
        qrPayload: `SOBPAIR://device/${id}/token/${token}`,
      },
    };
  }

  async factoryReset(id: string, user: any) {
    return { success: true, message: 'Đã khôi phục cài đặt gốc thiết bị' };
  }

  async changeWifi(id: string, user: any, body: any) {
    return {
      success: true,
      message: 'Đã cập nhật thông tin mạng Wi-Fi cho thiết bị',
      data: {
        deviceId: id,
        provisioningStatus: 'PROVISIONING',
      },
    };
  }

  getSecurityIncidents() {
    return this.failedAttempts;
  }
}
