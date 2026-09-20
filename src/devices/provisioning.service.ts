import {
  Injectable,
  NotFoundException,
  BadRequestException,
  UnauthorizedException,
  ConflictException,
  Inject,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../security/crypto.service';
import { EventsGateway } from '../websocket/events.gateway';
import * as crypto from 'crypto';

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

  /**
   * Helper to parse QR payload
   * Supports:
   * 1. SOBPAIR://setup?device=SOB-000001&token=XXXXXX&v=1
   * 2. SOBPAIR://device/SOB-000001/token/XXXXXX
   * 3. Raw deviceId + token
   */
  /**
   * Helper to parse QR payload or 6-digit Code / Device ID
   */
  private async resolveDeviceFromInput(inputStr: string): Promise<{ device: any; token: string }> {
    if (!inputStr) throw new BadRequestException('Mã thiết bị hoặc mã QR rỗng');

    const trimmed = inputStr.trim();

    // Standard format 1: SOBPAIR://setup?device=SOB-000001&token=XXXXXX&v=1
    if (trimmed.startsWith('SOBPAIR://setup?')) {
      const queryStr = trimmed.replace('SOBPAIR://setup?', '');
      const params = new URLSearchParams(queryStr);
      const devId = (params.get('device') || params.get('deviceId') || '').toUpperCase();
      const tok = params.get('token') || '';
      if (devId) {
        const d = await this.prisma.device.findUnique({
          where: { deviceId: devId },
          include: { store: true, product: true, configuration: { include: { product: true } } },
        });
        if (d) return { device: d, token: tok || d.pairingToken || 'default_tok' };
      }
    }

    // Standard format 2: SOBPAIR://device/SOB-000001/token/XXXXXX
    const match = trimmed.match(/^SOBPAIR:\/\/device\/([^/]+)\/token\/([^/?&]+)/i);
    if (match) {
      const devId = match[1].toUpperCase();
      const tok = match[2];
      const d = await this.prisma.device.findUnique({
        where: { deviceId: devId },
        include: { store: true, product: true, configuration: { include: { product: true } } },
      });
      if (d) return { device: d, token: tok };
    }

    // Format 3: Direct 6-digit pairing code, Device ID, or Claim code
    const d = await this.prisma.device.findFirst({
      where: {
        OR: [
          { pairingCode: trimmed },
          { deviceId: trimmed.toUpperCase() },
          { claimCode: trimmed.toUpperCase() },
          { qrPayload: trimmed },
        ],
      },
      include: { store: true, product: true, configuration: { include: { product: true } } },
    });

    if (d) {
      return { device: d, token: d.pairingToken || 'direct_pin' };
    }

    throw new BadRequestException(`Không tìm thấy thiết bị với mã "${trimmed}". Vui lòng kiểm tra lại mã trên thiết bị.`);
  }

  /**
   * 1. Start Provisioning Session from QR Code or 6-digit PIN
   */
  async createSession(body: { qrPayload?: string; deviceId?: string; token?: string; code?: string }) {
    const rawInput = body.code || body.qrPayload || body.deviceId;
    if (!rawInput) {
      throw new BadRequestException('Vui lòng cung cấp mã số thiết bị hoặc mã QR');
    }

    const { device, token } = await this.resolveDeviceFromInput(rawInput);
    const deviceId = device.deviceId;

    if (!device) {
      this.recordSecurityEvent('INVALID_DEVICE_PAIRING', deviceId, 'Device ID không tồn tại');
      throw new NotFoundException(`Không tìm thấy thiết bị: ${deviceId}`);
    }

    if (device.status === 'REVOKED' || device.status === 'DISABLED') {
      this.recordSecurityEvent('REVOKED_DEVICE_ACCESS', deviceId, `Device trạng thái ${device.status}`);
      throw new BadRequestException(`Thiết bị này đã bị vô hiệu hóa hoặc thu hồi`);
    }

    // Verify token matches current device pairing token
    if (device.pairingToken && device.pairingToken !== token) {
      this.recordSecurityEvent('INVALID_PAIRING_TOKEN', deviceId, 'Pairing token không khớp');
      throw new UnauthorizedException('Mã Pairing Token không hợp lệ hoặc đã hết hạn');
    }

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    // Invalidate any old active sessions for this device
    await this.prisma.devicePairingSession.updateMany({
      where: { deviceId: device.id, status: 'ACTIVE' },
      data: { status: 'EXPIRED' },
    });

    // Create 10-minute temporary claim session
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    const session = await this.prisma.devicePairingSession.create({
      data: {
        deviceId: device.id,
        tokenHash,
        expiresAt,
        status: 'ACTIVE',
      },
    });

    await this.prisma.device.update({
      where: { id: device.id },
      data: { provisioningStatus: 'PROVISIONING' },
    });

    const assignedProduct = device.product || device.configuration?.product;

    return {
      success: true,
      data: {
        sessionId: session.id,
        deviceId: device.deviceId,
        serialNumber: device.serialNumber,
        macAddress: device.macAddress,
        customName: device.customName || 'Smart Order Button',
        storeName: device.store?.name || 'Đại Lý Cung Ứng',
        product: assignedProduct
          ? {
              id: assignedProduct.id,
              name: assignedProduct.name,
              sku: assignedProduct.sku,
              price: assignedProduct.price,
              unit: assignedProduct.unit,
            }
          : null,
        expiresAt: session.expiresAt,
      },
    };
  }

  /**
   * 2. Verify an ongoing provisioning session
   */
  async verifySession(sessionId: string) {
    const session = await this.prisma.devicePairingSession.findUnique({
      where: { id: sessionId },
      include: {
        device: {
          include: {
            product: true,
            configuration: { include: { product: true } },
          },
        },
      },
    });

    if (!session || session.status !== 'ACTIVE') {
      throw new UnauthorizedException('Phiên ghép nối không tồn tại hoặc đã kết thúc');
    }

    if (new Date() > session.expiresAt) {
      await this.prisma.devicePairingSession.update({
        where: { id: session.id },
        data: { status: 'EXPIRED' },
      });
      throw new UnauthorizedException('Phiên ghép nối đã hết hạn sau 10 phút. Vui lòng quét lại mã QR.');
    }

    const assignedProduct = session.device.product || session.device.configuration?.product;

    return {
      success: true,
      valid: true,
      data: {
        sessionId: session.id,
        deviceId: session.device.deviceId,
        status: session.device.status,
        provisioningStatus: session.device.provisioningStatus,
        product: assignedProduct,
      },
    };
  }

  /**
   * 3. ESP32 Cloud Bootstrap via HMAC-SHA256 (When device first connects to home Wi-Fi)
   */
  async bootstrap(headers: any, body: any) {
    const deviceId = headers['x-device-id']?.toString()?.trim()?.toUpperCase();
    const timestamp = parseInt(headers['x-timestamp']?.toString(), 10);
    const nonce = headers['x-nonce']?.toString()?.trim();
    const signature = headers['x-signature']?.toString()?.trim();

    if (!deviceId || !timestamp || !nonce || !signature) {
      throw new BadRequestException('Thiếu các header xác thực: x-device-id, x-timestamp, x-nonce, x-signature');
    }

    // Clock drift guard (+-300s, relaxed in development environment)
    const isDev = process.env.NODE_ENV === 'development' || !process.env.NODE_ENV;
    const nowSec = Math.floor(Date.now() / 1000);
    if (!isDev && Math.abs(nowSec - timestamp) > 300) {
      this.recordSecurityEvent('CLOCK_DRIFT_EXCEEDED', deviceId, `Drift: ${nowSec - timestamp}s`);
      throw new UnauthorizedException('Độ lệch thời gian thiết bị vượt quá 300 giây');
    }

    const device = await this.prisma.device.findUnique({ where: { deviceId } });
    if (!device) {
      this.recordSecurityEvent('UNKNOWN_DEVICE_BOOTSTRAP', deviceId, 'Device không tồn tại');
      throw new NotFoundException(`Thiết bị ID: ${deviceId} không tồn tại`);
    }

    // Verify HMAC-SHA256
    const rawPayload = typeof body === 'string' ? body : JSON.stringify(body || {});
    const signaturePayload = `${deviceId}:${timestamp}:${nonce}:${rawPayload}`;
    const expectedSignature = crypto
      .createHmac('sha256', device.deviceSecret)
      .update(signaturePayload)
      .digest('hex');

    if (signature.toLowerCase() !== expectedSignature.toLowerCase()) {
      this.recordSecurityEvent('HMAC_AUTH_FAILED', deviceId, 'Chữ ký HMAC-SHA256 không hợp lệ');
      throw new UnauthorizedException('Xác thực thiết bị thất bại: Sai chữ ký HMAC-SHA256');
    }

    // Check Replay attack on Nonce
    const nonceKey = `nonce_${deviceId}_${nonce}`;
    const existingNonce = await this.prisma.idempotencyRecord.findUnique({
      where: { key: nonceKey },
    });
    if (existingNonce) {
      this.recordSecurityEvent('REPLAY_ATTACK_BLOCKED', deviceId, `Nonce tái sử dụng: ${nonce}`);
      throw new ConflictException('Phát hiện tấn công Replay: Nonce đã được sử dụng');
    }

    await this.prisma.idempotencyRecord.create({
      data: {
        key: nonceKey,
        deviceId: device.id,
        expiresAt: new Date(Date.now() + 600 * 1000), // 10 mins cache
      },
    });

    // Update Device Cloud Connected
    const updated = await this.prisma.device.update({
      where: { id: device.id },
      data: {
        provisioningStatus: 'CLOUD_CONNECTED',
        lastSeenAt: new Date(),
        wifiRSSI: body.wifiRssi !== undefined ? body.wifiRssi : device.wifiRSSI,
        batteryLevel: body.batteryLevel !== undefined ? body.batteryLevel : device.batteryLevel,
        firmwareVersion: body.firmwareVersion || device.firmwareVersion,
        ipAddress: body.ipAddress || null,
        uptime: body.uptime || 0,
      },
    });

    await this.prisma.deviceAuditLog.create({
      data: {
        deviceId: device.id,
        action: 'BOOTSTRAP_SUCCESS',
        metadata: JSON.stringify({
          wifiRssi: body.wifiRssi,
          firmwareVersion: body.firmwareVersion,
          ipAddress: body.ipAddress,
        }),
      },
    });

    // Realtime notification to store and global room
    if (device.storeId) {
      this.eventsGateway.emitToStore(device.storeId, 'device:online', {
        deviceId: device.deviceId,
        status: updated.status,
        provisioningStatus: 'CLOUD_CONNECTED',
      });
      this.eventsGateway.emitToStore(device.storeId, 'device:heartbeat', {
        deviceId: device.deviceId,
        batteryLevel: updated.batteryLevel,
        wifiRSSI: updated.wifiRSSI,
        lastSeenAt: updated.lastSeenAt,
      });
    }

    return {
      success: true,
      message: 'Bootstrap kết nối Smart Order Cloud thành công!',
      data: {
        deviceId: device.deviceId,
        status: updated.status,
        cloudTimestamp: Date.now(),
      },
    };
  }

  /**
   * 4. Customer Claims Device Ownership
   */
  async claim(deviceId: string, body: any, user: any) {
    if (!user || user.role !== 'CUSTOMER' || !user.customerProfileId) {
      throw new UnauthorizedException('Chỉ tài khoản khách hàng mới có quyền nhận nút bấm');
    }

    const device = await this.prisma.device.findFirst({
      where: { OR: [{ id: deviceId }, { deviceId }] },
      include: { product: true, configuration: { include: { product: true } } },
    });

    if (!device) throw new NotFoundException('Không tìm thấy thiết bị');

    if (device.customerId && device.customerId !== user.customerProfileId) {
      throw new BadRequestException('Nút bấm này đã được sở hữu bởi một khách hàng khác');
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const dev = await tx.device.update({
        where: { id: device.id },
        data: {
          customerId: user.customerProfileId,
          claimStatus: 'CLAIMED',
          status: 'ACTIVE',
        },
      });

      // Mark any active session as USED
      await tx.devicePairingSession.updateMany({
        where: { deviceId: device.id, status: 'ACTIVE' },
        data: { status: 'USED', usedAt: new Date(), customerId: user.customerProfileId },
      });

      await tx.deviceAuditLog.create({
        data: {
          deviceId: device.id,
          actorId: user.id,
          action: 'DEVICE_CLAIMED',
          metadata: JSON.stringify({
            customerId: user.customerProfileId,
            claimedAt: new Date(),
          }),
        },
      });

      return dev;
    });

    // Notify customer room and store
    this.eventsGateway.emitToCustomer(user.customerProfileId, 'device:claim', {
      deviceId: updated.deviceId,
      status: 'ACTIVE',
    });

    if (device.storeId) {
      this.eventsGateway.emitToStore(device.storeId, 'device:claim', {
        deviceId: updated.deviceId,
        customerId: user.customerProfileId,
      });
    }

    const assignedProduct = device.product || device.configuration?.product;

    return {
      success: true,
      message: 'Kích hoạt sở hữu nút bấm thành công! Bạn có thể bấm nút để đặt hàng ngay.',
      data: {
        deviceId: updated.deviceId,
        product: assignedProduct,
        status: updated.status,
      },
    };
  }

  /**
   * 5. Customer Unclaims Device
   */
  async unclaim(deviceId: string, user: any) {
    const device = await this.prisma.device.findFirst({
      where: { OR: [{ id: deviceId }, { deviceId }] },
    });
    if (!device) throw new NotFoundException('Không tìm thấy thiết bị');

    if (user.role === 'CUSTOMER' && device.customerId !== user.customerProfileId) {
      throw new UnauthorizedException('Bạn không sở hữu nút bấm này');
    }

    const updated = await this.prisma.device.update({
      where: { id: device.id },
      data: {
        customerId: null,
        claimStatus: 'UNCLAIMED',
        status: 'READY_FOR_CUSTOMER',
      },
    });

    await this.prisma.deviceAuditLog.create({
      data: {
        deviceId: device.id,
        actorId: user.id,
        action: 'DEVICE_UNCLAIMED',
        metadata: JSON.stringify({ unclaimTime: new Date() }),
      },
    });

    if (device.storeId) {
      this.eventsGateway.emitToStore(device.storeId, 'device:unclaim', {
        deviceId: device.deviceId,
      });
    }

    return { success: true, message: 'Đã hủy gán nút bấm khỏi tài khoản' };
  }

  /**
   * 6. Transfer Device (Generates new one-time pairing token for recipient)
   */
  async transfer(deviceId: string, user: any) {
    const device = await this.prisma.device.findFirst({
      where: { OR: [{ id: deviceId }, { deviceId }] },
    });
    if (!device) throw new NotFoundException('Không tìm thấy thiết bị');

    if (user.role === 'CUSTOMER' && device.customerId !== user.customerProfileId) {
      throw new UnauthorizedException('Không có quyền chuyển nhượng nút bấm này');
    }

    const newPairingToken = `p_${crypto.randomBytes(12).toString('hex')}`;
    const newQrPayload = `SOBPAIR://setup?device=${device.deviceId}&token=${newPairingToken}&v=1`;

    const updated = await this.prisma.device.update({
      where: { id: device.id },
      data: {
        customerId: null,
        claimStatus: 'TRANSFERRED',
        status: 'TRANSFER_PENDING',
        pairingToken: newPairingToken,
        qrPayload: newQrPayload,
      },
    });

    await this.prisma.deviceAuditLog.create({
      data: {
        deviceId: device.id,
        actorId: user.id,
        action: 'DEVICE_TRANSFERRED',
        metadata: JSON.stringify({ fromCustomerId: user.customerProfileId }),
      },
    });

    return {
      success: true,
      message: 'Thiết bị đã chuyển sang trạng thái chờ nhận chuyển nhượng',
      data: {
        deviceId: updated.deviceId,
        qrPayload: newQrPayload,
        token: newPairingToken,
      },
    };
  }

  /**
   * 7. Factory Reset Device (Clears Wi-Fi & Customer, keeps Device ID & HMAC Key)
   */
  async factoryReset(deviceId: string, user: any) {
    const device = await this.prisma.device.findFirst({
      where: { OR: [{ id: deviceId }, { deviceId }] },
    });
    if (!device) throw new NotFoundException('Không tìm thấy thiết bị');

    const newPairingToken = `p_${crypto.randomBytes(12).toString('hex')}`;
    const newQrPayload = `SOBPAIR://setup?device=${device.deviceId}&token=${newPairingToken}&v=1`;

    const updated = await this.prisma.device.update({
      where: { id: device.id },
      data: {
        customerId: null,
        claimStatus: 'UNCLAIMED',
        provisioningStatus: 'UNPROVISIONED',
        status: 'READY_FOR_CUSTOMER',
        pairingToken: newPairingToken,
        qrPayload: newQrPayload,
      },
    });

    await this.prisma.deviceAuditLog.create({
      data: {
        deviceId: device.id,
        actorId: user?.id || null,
        action: 'FACTORY_RESET',
        metadata: JSON.stringify({ timestamp: new Date() }),
      },
    });

    if (device.storeId) {
      this.eventsGateway.emitToStore(device.storeId, 'device:factory_reset', {
        deviceId: device.deviceId,
      });
    }

    return {
      success: true,
      message: 'Thiết bị đã được đưa về trạng thái xuất xưởng thành công',
      data: { deviceId: updated.deviceId, status: updated.status },
    };
  }

  /**
   * 8. Customer / Admin endpoint: Reconfigure Wi-Fi (preserves customer ownership & product mapping)
   */
  async changeWifi(deviceId: string, user: any, body?: { ssid?: string; password?: string }) {
    const device = await this.prisma.device.findFirst({
      where: { OR: [{ id: deviceId }, { deviceId }] },
      include: { product: true, configuration: { include: { product: true } } },
    });
    if (!device) throw new NotFoundException('Không tìm thấy thiết bị');

    if (user.role === 'CUSTOMER') {
      let customerProfileId = user.customerProfileId || user.customerProfile?.id;
      if (!customerProfileId) {
        const cp = await this.prisma.customerProfile.findFirst({ where: { userId: user.id } });
        if (cp) {
          customerProfileId = cp.id;
        } else {
          const store = await this.prisma.store.findFirst();
          if (store) {
            const newCp = await this.prisma.customerProfile.create({
              data: {
                userId: user.id,
                storeId: store.id,
                deliveryAddress: 'Căn hộ chung cư',
                phone: user.phone || '0901234567',
              },
            });
            customerProfileId = newCp.id;
          }
        }
      }

      // If device has no customer assigned or is ready for customer, claim it immediately
      if (!device.customerId || device.status === 'READY_FOR_CUSTOMER' || device.claimStatus !== 'CLAIMED') {
        await this.prisma.device.update({
          where: { id: device.id },
          data: {
            customerId: customerProfileId,
            claimStatus: 'CLAIMED',
            status: 'ACTIVE',
          },
        });
        device.customerId = customerProfileId;
      } else if (device.customerId !== customerProfileId && user.role !== 'SUPER_ADMIN') {
        throw new UnauthorizedException('Bạn không sở hữu nút bấm này');
      }
    }

    const newSsid = body?.ssid?.trim();
    const updated = await this.prisma.device.update({
      where: { id: device.id },
      data: {
        provisioningStatus: newSsid ? 'READY' : 'PROVISIONING',
      },
    });

    await this.prisma.deviceAuditLog.create({
      data: {
        deviceId: device.id,
        actorId: user.id,
        action: 'WIFI_RECONFIG_REQUESTED',
        metadata: JSON.stringify({
          customerId: device.customerId,
          newSsid: newSsid || null,
          requestedAt: new Date(),
        }),
      },
    });

    if (device.storeId) {
      this.eventsGateway.emitToStore(device.storeId, 'device:wifi_changed', {
        deviceId: device.deviceId,
        status: newSsid ? 'READY' : 'PROVISIONING',
        ssid: newSsid || null,
      });
    }
    if (device.customerId) {
      this.eventsGateway.emitToCustomer(device.customerId, 'device:wifi_changed', {
        deviceId: device.deviceId,
        status: newSsid ? 'READY' : 'PROVISIONING',
        ssid: newSsid || null,
      });
      this.eventsGateway.emitToCustomer(device.customerId, 'device:claimed', {
        device: updated,
      });
    }

    return {
      success: true,
      message: newSsid
        ? `Đã cập nhật cấu hình Wi-Fi "${newSsid}" cho nút ${device.deviceId}! Quyền sở hữu và sản phẩm được bảo toàn.`
        : 'Thiết bị sẵn sàng nhận cấu hình Wi-Fi mới qua BLE / SoftAP',
      data: {
        deviceId: updated.deviceId,
        provisioningStatus: updated.provisioningStatus,
        status: updated.status,
        ssid: newSsid || null,
      },
    };
  }

  /**
   * Security Incident Monitoring for Admin
   */
  private recordSecurityEvent(type: string, deviceId: string, reason: string) {
    this.failedAttempts.unshift({
      type,
      deviceId,
      reason,
      timestamp: new Date(),
    });
    if (this.failedAttempts.length > 100) this.failedAttempts.pop();
  }

  getSecurityIncidents() {
    return this.failedAttempts;
  }
}
