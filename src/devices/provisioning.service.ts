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
    const sessionHash = crypto.createHash('sha256').update(sessionId).digest('hex');

    // ATOMIC TRANSACTION: Consume token and create session in a single database transaction
    try {
      await this.provRepo.createSessionAtomicTx(
        button.deviceId,
        tokenHash,
        sessionId,
        sessionHash,
        button.buttonId,
        sessionData,
        sessionData.expiresAt,
      );
    } catch (err: any) {
      this.failedAttempts.push({
        type: 'INVALID_PAIRING_TOKEN',
        deviceId: button.deviceId,
        reason: 'Mã token ghép nối không hợp lệ, đã hết hạn hoặc đã qua sử dụng',
        timestamp: new Date(),
      });
      throw new UnauthorizedException('Mã token ghép nối không hợp lệ, đã hết hạn hoặc đã qua sử dụng');
    }

    DevicesService.markPairingTokenUsed(button.deviceId, token);

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

    try {
      const result = await this.provRepo.confirmPairingAtomicTx(sessionId, customerId, {
        deviceId: dto.deviceId,
        buttonName: dto.buttonName,
        productId: dto.productId,
      });

      this.eventsGateway.emitToStore(result.storeId, 'DEVICE_PROVISIONED', {
        deviceId: result.deviceId,
        buttonName: result.buttonName,
        customerId: result.customerId,
      });

      return {
        success: true,
        message: 'Kích hoạt sở hữu và ghép nối thiết bị thành công!',
        data: result,
      };
    } catch (err: any) {
      const msg = err.message || '';
      if (msg.startsWith('NOT_FOUND:')) throw new NotFoundException(msg.replace('NOT_FOUND: ', ''));
      if (msg.startsWith('CONFLICT:')) throw new ConflictException(msg.replace('CONFLICT: ', ''));
      throw new BadRequestException(msg.replace('BAD_REQUEST: ', ''));
    }
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

  private async assertDeviceAccess(id: string, user: any) {
    if (!user) {
      throw new ForbiddenException('Thiếu thông tin người thực hiện');
    }
    const button = await this.provRepo.findButtonByIdentifier(id);
    if (!button) throw new NotFoundException('Không tìm thấy thiết bị');

    if (['SUPER_ADMIN', 'SYSTEM_ADMIN', 'ADMIN'].includes(user.role)) {
      return button;
    }
    if (user.role === 'CUSTOMER') {
      const userCustId = user.customerProfileId ? user.customerProfileId.toString() : null;
      if (!userCustId || !button.customerId || button.customerId.toString() !== userCustId) {
        throw new ForbiddenException('Bạn không có quyền truy cập nút bấm này');
      }
      return button;
    }
    if (['STORE_OWNER', 'STORE_MANAGER', 'STORE_STAFF', 'STAFF_BUTTON'].includes(user.role)) {
      const userStoreId = user.storeId ? user.storeId.toString() : null;
      if (!userStoreId || !button.storeId || button.storeId.toString() !== userStoreId) {
        throw new ForbiddenException('Thiết bị không thuộc phạm vi cửa hàng của bạn');
      }
      return button;
    }
    throw new ForbiddenException('Bạn không có quyền thực hiện thao tác trên thiết bị này');
  }

  async claim(id: string, body: any, user: any) {
    throw new BadRequestException(
      'Quy trình kích hoạt sở hữu thiết bị cũ không còn được hỗ trợ. Bắt buộc kích hoạt qua phiên ghép nối bảo mật (POST /api/v1/provisioning/sessions/:id/confirmation)',
    );
  }

  async unclaim(id: string, user: any) {
    const button = await this.assertDeviceAccess(id, user);

    await this.provRepo.updateButton(button.buttonId, {
      customerId: null,
      status: 'UNASSIGNED',
      installedAt: null,
      addressId: null,
    });

    await this.provRepo.prisma.buttonProduct.deleteMany({
      where: { buttonId: button.buttonId },
    });

    return {
      success: true,
      message: 'Đã hủy sở hữu và tách liên kết thiết bị thành công',
      data: { deviceId: button.deviceId, status: 'UNASSIGNED' },
    };
  }

  async transfer(id: string, user: any) {
    const button = await this.assertDeviceAccess(id, user);

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
    const button = await this.assertDeviceAccess(id, user);

    await this.provRepo.updateButton(button.buttonId, {
      customerId: null,
      status: 'INACTIVE',
      installedAt: null,
      addressId: null,
    });

    await this.provRepo.prisma.buttonProduct.deleteMany({
      where: { buttonId: button.buttonId },
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

  async changeWifi(id: string, user: any, body?: any) {
    const button = await this.assertDeviceAccess(id, user);

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
