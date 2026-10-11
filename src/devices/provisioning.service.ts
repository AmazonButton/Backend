import { DevicesService } from './devices.service';
import {
  Injectable,
  NotFoundException,
  BadRequestException,
  UnauthorizedException,
  ConflictException,
  ForbiddenException,
  Inject,
} from '@nestjs/common';
import { ProvisioningRepository } from './provisioning.repository';
import { CryptoService } from '../security/crypto.service';
import { EventsGateway } from '../websocket/events.gateway';
import * as crypto from 'crypto';

// activeSessions migrated to PostgreSQL provisioning_sessions

@Injectable()
export class ProvisioningService {
  // usedNonces migrated to PostgreSQL device_nonces
  private failedAttempts: Array<{
    type: string;
    deviceId: string;
    ip?: string;
    reason: string;
    timestamp: Date;
  }> = [];

  constructor(
    @Inject(ProvisioningRepository) private readonly provRepo: ProvisioningRepository,
    @Inject(CryptoService) private readonly cryptoService: CryptoService,
    @Inject(EventsGateway) private readonly eventsGateway: EventsGateway,
  ) {}

  private async resolveDeviceFromInput(inputStr: string): Promise<{ button: any; token: string }> {
    if (!inputStr) throw new BadRequestException('Mã thiết bị hoặc mã QR rỗng');

    let targetId = inputStr.trim();
    if (targetId.includes('/device/')) {
      const match = targetId.match(/\/device\/([^\/\s]+)/i);
      if (match && match[1]) {
        targetId = match[1];
      }
    } else if (targetId.toUpperCase().startsWith('SOBPAIR://')) {
      targetId = targetId.substring(10).split('/')[0];
    }

    const trimmed = targetId.trim().toUpperCase();
    const button = await this.provRepo.findButtonByIdentifier(trimmed);

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

    let token = body.token;
    if (body.qrPayload) {
      const match = body.qrPayload.match(/\/token\/([^\/\s\?]+)/i) || body.qrPayload.match(/[?&]token=([^&\s]+)/i);
      if (match && match[1]) {
        token = match[1];
      }
    }

    // Require valid pairing token or QR payload with token
    if (!token) {
      throw new UnauthorizedException('Yêu cầu mã ghép nối (Pairing Token) hoặc mã QR hợp lệ để khởi tạo phiên');
    }

    const { button } = await this.resolveDeviceFromInput(rawInput);
    if (!button) {
      throw new NotFoundException('Không tìm thấy thiết bị');
    }

    const tokenHash = DevicesService.hashToken(token);

    // ATOMIC TOKEN CONSUMPTION: PostgreSQL is the single source of truth across all instances
    const consumedToken = await this.provRepo.consumeActivePairingToken(button.deviceId, tokenHash);

    if (!consumedToken) {
      this.failedAttempts.push({
        type: 'INVALID_PAIRING_TOKEN',
        deviceId: button.deviceId,
        reason: 'Mã token ghép nối không hợp lệ, đã hết hạn hoặc đã qua sử dụng',
        timestamp: new Date(),
      });
      throw new UnauthorizedException('Mã token ghép nối không hợp lệ, đã hết hạn hoặc đã qua sử dụng');
    }

    DevicesService.markPairingTokenUsed(button.deviceId, token);

    const sessionId = `sess_${crypto.randomBytes(12).toString('hex')}`;

    const sessionData = {
      sessionId,
      deviceId: button.deviceId,
      buttonId: button.buttonId.toString(),
      storeId: button.storeId ? button.storeId.toString() : null,
      storeName: button.store?.name,
      status: 'ACTIVE',
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      createdAt: new Date(),
    };

    // Store tokenHash internally in memory for confirmPairing validation without exposing in API response
    const sessionHash = crypto.createHash('sha256').update(sessionId).digest('hex');
    await this.provRepo.createProvisioningSession(
      sessionId,
      sessionHash,
      button.buttonId,
      sessionData,
      tokenHash || null,
      sessionData.expiresAt,
    );

    return {
      success: true,
      data: sessionData, // Neither raw token nor tokenHash is exposed to client!
    };
  }

  async verifySession(sessionId: string) {
    const session = await this.provRepo.findProvisioningSession(sessionId);
    if (!session) {
      throw new NotFoundException('Phiên ghép nối không tồn tại hoặc đã hết hạn');
    }
    const safeData = session.session_data || {};
    return { success: true, valid: true, data: safeData };
  }

  async getSession(sessionId: string) {
    return this.verifySession(sessionId);
  }

    async confirmPairing(sessionId: string, dto: any, user: any) {
    const customerId = user?.customerProfileId
      ? BigInt(user.customerProfileId)
      : user?.customerId
      ? BigInt(user.customerId)
      : null;

    if (!customerId) {
      throw new UnauthorizedException('Chỉ khách hàng cá nhân có hồ sơ mới có thể kích hoạt ghép nối thiết bị');
    }

    return this.provRepo.prisma.$transaction(async (tx: any) => {
      // 1. Lock session row
      const sessionRows: any[] = await tx.$queryRawUnsafe(
        `SELECT * FROM provisioning_sessions
         WHERE session_id = $1
         FOR UPDATE;`,
        sessionId,
      );

      if (!sessionRows || sessionRows.length === 0) {
        throw new NotFoundException('Phiên ghép nối không tồn tại');
      }

      const session = sessionRows[0];

      if (session.status !== 'ACTIVE') {
        throw new BadRequestException('Phiên ghép nối đã được sử dụng hoặc bị vô hiệu hóa');
      }

      if (new Date(session.expires_at) < new Date()) {
        throw new BadRequestException('Phiên ghép nối đã hết hạn');
      }

      if (session.claimed_by && session.claimed_by.toString() !== customerId.toString()) {
        throw new ForbiddenException('Phiên ghép nối thuộc về khách hàng khác');
      }

      // 2. Lock button row
      const buttonRows: any[] = await tx.$queryRawUnsafe(
        `SELECT * FROM iot_button
         WHERE button_id = $1
         FOR UPDATE;`,
        BigInt(session.device_id),
      );

      if (!buttonRows || buttonRows.length === 0) {
        throw new NotFoundException('Thiết bị nút bấm không tồn tại');
      }

      const button = buttonRows[0];

      if (button.customer_id && button.customer_id.toString() !== customerId.toString() && button.status === 'ACTIVE') {
        throw new ConflictException('Thiết bị này đã có chủ sở hữu khác');
      }

      // 3. Product validation if specified
      if (dto.productId) {
        const prod = await tx.product.findUnique({
          where: { productId: BigInt(dto.productId) },
        });

        if (!prod || (button.store_id && prod.storeId !== button.store_id)) {
          throw new BadRequestException('Sản phẩm không thuộc cửa hàng quản lý thiết bị này');
        }

        await tx.buttonProduct.upsert({
          where: {
            uq_button_product: {
              buttonId: button.button_id,
              productId: prod.productId,
            },
          },
          update: { quantity: Number(dto.quantity) || 1 },
          create: {
            buttonId: button.button_id,
            productId: prod.productId,
            quantity: Number(dto.quantity) || 1,
          },
        });
      }

      // 4. Upsert store_customer
      if (button.store_id) {
        await tx.storeCustomer.upsert({
          where: {
            uq_store_customer: {
              storeId: button.store_id,
              customerId,
            },
          },
          update: { status: 'ACTIVE' },
          create: {
            storeId: button.store_id,
            customerId,
            status: 'ACTIVE',
          },
        });
      }

      // 5. Update button ownership and active status
      const updatedButton = await tx.ioTButton.update({
        where: { buttonId: button.button_id },
        data: {
          customerId,
          buttonName: dto.buttonName || dto.customName || button.button_name,
          status: 'ACTIVE',
          installedAt: button.installed_at || new Date(),
        },
      });

      // 6. Mark pairing token USED if bound
      if (session.token_hash) {
        await tx.pairingToken.updateMany({
          where: { tokenHash: session.token_hash, status: 'ACTIVE' },
          data: { status: 'USED' },
        });
      }

      // 7. Mark session CLAIMED atomically
      await tx.$executeRawUnsafe(
        `UPDATE provisioning_sessions
         SET status = 'CLAIMED', claimed_by = $2, updated_at = NOW()
         WHERE session_id = $1;`,
        sessionId,
        customerId,
      );

      return {
        success: true,
        message: 'Kích hoạt và ghép nối nút bấm thành công!',
        data: {
          buttonId: updatedButton.buttonId.toString(),
          deviceId: updatedButton.deviceId,
          buttonCode: updatedButton.buttonCode,
          status: updatedButton.status,
        },
      };
    });
  }

  async cancelSession(sessionId: string) {
    await this.provRepo.deleteProvisioningSession(sessionId);
    return { success: true, message: 'Đã hủy phiên ghép nối' };
  }

  async bootstrap(headers: any, body: any) {
    const deviceId = headers['x-device-id'] || headers['x-deviceid'];
    const signature = headers['x-signature'];
    const timestamp = headers['x-timestamp'];
    const nonce = headers['x-nonce'];

    // Enforce HMAC authentication for physical ESP32 bootstrap
    if (!deviceId || !signature || !timestamp || !nonce) {
      throw new UnauthorizedException('Yêu cầu bắt buộc phải có chữ ký HMAC-SHA256 (x-device-id, x-signature, x-timestamp, x-nonce)');
    }

    // Must find device in DB first via Repository - NEVER bootstrap unregistered devices!
    const button = await this.provRepo.findButtonByIdentifier(deviceId);
    if (!button) {
      throw new NotFoundException(`Thiết bị không tồn tại trong hệ thống: ${deviceId}`);
    }

    // 1. Verify timestamp freshness first (strictly within 300s)
    const nowSec = Math.floor(Date.now() / 1000);
    const reqTime = parseInt(timestamp, 10);
    if (isNaN(reqTime) || Math.abs(nowSec - reqTime) > 300) {
      throw new UnauthorizedException('Chữ ký HMAC đã hết hạn (lệch > 300s)');
    }

    // 2. Strictly enforce device-specific secret from DB - ZERO FALLBACK!
    const secret = (button as any).hmacSecret;
    if (!secret) {
      throw new UnauthorizedException('Thiết bị chưa được cấu hình khóa bảo mật HMAC');
    }

    // 3. Verify HMAC Signature FIRST (prevents Nonce Poisoning DoS)
    const bodyJson = typeof body === 'string' ? body : JSON.stringify(body || {});
    const expectedSig = crypto
      .createHmac('sha256', secret)
      .update(`${deviceId}:${timestamp}:${nonce}:${bodyJson}`)
      .digest('hex');

    const sigBuf = Buffer.from(signature, 'hex');
    const expBuf = Buffer.from(expectedSig, 'hex');
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      throw new UnauthorizedException('Chữ ký HMAC không hợp lệ');
    }

    // 4. Consume Nonce ONLY AFTER signature is verified (Atomic PostgreSQL insert with 5-minute TTL)
    const nonceConsumed = await this.provRepo.consumeDeviceNonce(deviceId, nonce);
    if (!nonceConsumed) {
      this.failedAttempts.push({
        type: 'REPLAY_ATTACK',
        deviceId,
        reason: 'Phát hiện Replay Attack: Nonce đã được sử dụng',
        timestamp: new Date(),
      });
      throw new ConflictException('Phát hiện tấn công phát lại (Replay Attack): Nonce đã được sử dụng');
    }

    return {
      success: true,
      message: 'Bootstrap thiết bị thành công',
      data: { serverTime: Date.now() },
    };
  }

  async claim(id: string, body: any, user: any) {
    const button = await this.provRepo.findButtonByIdentifier(id);
    if (!button) throw new NotFoundException('Không tìm thấy thiết bị');

    const targetCustomerId = user?.customerProfileId ? BigInt(user.customerProfileId) : null;
    if (!targetCustomerId) {
      throw new UnauthorizedException('Chỉ khách hàng có hồ sơ cá nhân mới có thể liên kết thiết bị');
    }

    if (button.customerId && button.customerId.toString() !== targetCustomerId.toString() && button.status === 'ACTIVE') {
      throw new ConflictException('Thiết bị này đã có chủ sở hữu khác đang sử dụng. Vui lòng yêu cầu chủ sở hữu cũ hủy liên kết hoặc chuyển quyền.');
    }

    await this.provRepo.updateButton(button.buttonId, {
      customerId: targetCustomerId,
      status: 'ACTIVE',
    });

    return {
      success: true,
      message: 'Kích hoạt sở hữu nút bấm thành công!',
      data: { deviceId: button.deviceId },
    };
  }

  async unclaim(id: string, user: any) {
    const button = await this.provRepo.findButtonByIdentifier(id);
    if (!button) throw new NotFoundException('Không tìm thấy thiết bị');

    if (user && user.role === 'CUSTOMER' && user.customerProfileId) {
      if (button.customerId && button.customerId.toString() !== user.customerProfileId.toString()) {
        throw new ForbiddenException('Bạn không có quyền hủy sở hữu thiết bị của người khác');
      }
    }

    await this.provRepo.updateButton(button.buttonId, {
      status: 'INACTIVE',
      installedAt: null,
    });

    return { success: true, message: 'Đã hủy sở hữu thiết bị', data: { deviceId: button.deviceId, status: 'INACTIVE' } };
  }

  async transfer(id: string, user: any) {
    const button = await this.provRepo.findButtonByIdentifier(id);
    if (!button) throw new NotFoundException('Không tìm thấy thiết bị');

    if (user && user.role === 'CUSTOMER' && user.customerProfileId) {
      if (button.customerId && button.customerId.toString() !== user.customerProfileId.toString()) {
        throw new ForbiddenException('Bạn không có quyền chuyển giao thiết bị của người khác');
      }
    }

    const token = `tok_${crypto.randomBytes(8).toString('hex')}`;
    const tokenHash = DevicesService.hashToken(token);
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
    await this.provRepo.savePairingToken(button.deviceId, tokenHash, expiresAt);
    DevicesService.setPairingTokenMemory(button.deviceId, token, tokenHash, expiresAt.getTime());

    return {
      success: true,
      message: 'Tạo mã chuyển giao thiết bị thành công',
      data: {
        deviceId: button.deviceId,
        token,
        qrPayload: `SOBPAIR://device/${button.deviceId}/token/${token}`,
      },
    };
  }

  async factoryReset(id: string, user: any) {
    const button = await this.provRepo.findButtonByIdentifier(id);

    if (button) {
      await this.provRepo.updateButton(button.buttonId, {
        status: 'INACTIVE',
      });
      return {
        success: true,
        message: 'Đã khôi phục cài đặt gốc thiết bị thành công',
        data: {
          deviceId: button.deviceId,
          status: 'READY_FOR_CUSTOMER',
        },
      };
    }

    return {
      success: true,
      message: 'Đã khôi phục cài đặt gốc thiết bị',
      data: {
        deviceId: id,
        status: 'READY_FOR_CUSTOMER',
      },
    };
  }

  async changeWifi(id: string, user: any, body?: any) {
    const button = await this.provRepo.findButtonByIdentifier(id);
    if (!button) throw new NotFoundException('Không tìm thấy thiết bị');

    if (user && user.role === 'CUSTOMER' && user.customerProfileId) {
      if (button.customerId && button.customerId.toString() !== user.customerProfileId.toString()) {
        throw new ForbiddenException('Bạn không có quyền cập nhật Wi-Fi của thiết bị người khác');
      }
    }

    const ssid = body?.ssid || 'Smart-Order-WiFi';
    return {
      success: true,
      message: 'Đã cập nhật thông tin mạng Wi-Fi cho thiết bị',
      data: {
        deviceId: button.deviceId,
        ssid,
        provisioningStatus: 'PROVISIONING',
      },
    };
  }

  getSecurityIncidents() {
    return this.failedAttempts;
  }
}
