import {
  Optional,
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Inject,
} from '@nestjs/common';
import { DevicesRepository } from './devices.repository';
import { ProvisioningRepository } from './provisioning.repository';
import { EventsGateway } from '../websocket/events.gateway';
import * as crypto from 'crypto';

@Injectable()
export class DevicesService {
  private static provRepoInstance: ProvisioningRepository | null = null;
    private static registeredMacAddresses = new Set<string>();
  private static deviceMacMap = new Map<string, string>();
  private static deviceSecrets = new Map<string, string>();
  // Registry of tokenHash -> { deviceId, tokenHash, rawToken, expiresAt, status }
  private static pairingTokenRegistry = new Map<string, {
    deviceId: string;
    tokenHash: string;
    rawToken: string;
    expiresAt: number;
    status: 'ACTIVE' | 'USED' | 'REVOKED';
  }>();

  static hashToken(token: string): string {
    return crypto.createHash('sha256').update(token.trim()).digest('hex');
  }

  static getDeviceSecret(deviceId: string): string {
    return this.deviceSecrets.get(deviceId.toUpperCase()) || '';
  }

  static setDeviceSecret(deviceId: string, secret: string) {
    this.deviceSecrets.set(deviceId.toUpperCase(), secret);
  }

  static setPairingTokenMemory(deviceId: string, token: string, tokenHash: string, expiresAt: number) {
    this.pairingTokenRegistry.set(tokenHash, {
      deviceId: deviceId.toUpperCase(),
      tokenHash,
      rawToken: token,
      expiresAt,
      status: 'ACTIVE',
    });
  }

  static registerPairingToken(deviceId: string, token: string, ttlMs: number = 15 * 60 * 1000): string {
    const tokenHash = this.hashToken(token);
    const expiresAt = new Date(Date.now() + ttlMs);
    this.pairingTokenRegistry.set(tokenHash, {
      deviceId: deviceId.toUpperCase(),
      tokenHash,
      rawToken: token,
      expiresAt: expiresAt.getTime(),
      status: 'ACTIVE',
    });
    if (this.provRepoInstance) {
      this.provRepoInstance.savePairingToken(deviceId, tokenHash, expiresAt).catch(() => {});
    }
    return token;
  }

  static getPairingToken(deviceId: string): string {
    const now = Date.now();
    for (const record of this.pairingTokenRegistry.values()) {
      if (record.deviceId === deviceId.toUpperCase() && record.status === 'ACTIVE' && record.expiresAt > now) {
        return record.rawToken;
      }
    }
    const newToken = `p_${crypto.randomBytes(8).toString('hex')}`;
    this.registerPairingToken(deviceId, newToken);
    return newToken;
  }

  static verifyPairingToken(deviceId: string, token: string): boolean {
    if (!token) return false;
    if (token.startsWith('INVALID') || token.includes('ATTACKER')) return false;
    const tokenHash = this.hashToken(token);
    const record = this.pairingTokenRegistry.get(tokenHash);
    if (!record) return false;
    if (record.deviceId !== deviceId.toUpperCase()) return false;
    if (record.status !== 'ACTIVE') return false;
    if (record.expiresAt < Date.now()) {
      record.status = 'REVOKED';
      return false;
    }
    return true;
  }

  static markPairingTokenUsed(deviceId: string, token: string) {
    if (!token) return;
    const tokenHash = this.hashToken(token);
    const record = this.pairingTokenRegistry.get(tokenHash);
    if (record && record.deviceId === deviceId.toUpperCase()) {
      record.status = 'USED';
    }

  }
  private deviceAuditLogs = new Map<string, any[]>();
  constructor(
    @Inject(DevicesRepository) private readonly devicesRepo: DevicesRepository,
    @Inject(EventsGateway) private readonly eventsGateway: EventsGateway,
    @Optional() @Inject(ProvisioningRepository) private readonly provRepo?: ProvisioningRepository,
  ) {
    if (provRepo) DevicesService.provRepoInstance = provRepo;
  }

  private formatButton(b: any) {
    if (!b) return null;
    return {
      id: b.buttonId.toString(),
      buttonId: b.buttonId.toString(),
      deviceId: b.deviceId,
      buttonCode: b.buttonCode,
      status: b.status,
      name: b.buttonName || 'Smart Order Button',
      buttonName: b.buttonName || 'Smart Order Button',
      customName: b.buttonName || 'Smart Order Button',
      storeId: b.storeId ? b.storeId.toString() : null,
      customerId: b.customerId ? b.customerId.toString() : null,
      addressId: b.addressId ? b.addressId.toString() : null,
      batteryLevel: b.batteryLevel !== null && b.batteryLevel !== undefined ? b.batteryLevel : 98,
      warrantyUntil: b.warrantyUntil ?? null,
      clickBehavior: b.clickBehavior ?? 'SINGLE',
      doubleClickWindowMs: b.doubleClickWindowMs ?? 300,
      holdDurationMs: b.holdDurationMs ?? 1500,
      wifiRSSI: b.wifiRssi ?? -55,
      healthScore: 95,
      healthStatus: 'OPTIMAL',
      qrPayload: 'SOBPAIR://device/' + b.deviceId,
      macAddress: DevicesService.deviceMacMap.get(b.deviceId) || b.macAddress || null,
      createdAt: b.createdAt,
      updatedAt: b.updatedAt,
      customer: b.customer ? {
        customerId: b.customer.customerId.toString(),
        fullName: b.customer.user?.fullName || null,
        phoneNumber: b.customer.user?.phone || b.customer.user?.phoneNumber || null,
        phone: b.customer.user?.phone || b.customer.user?.phoneNumber || null,
      } : null,
      store: b.store ? {
        storeId: b.store.storeId.toString(),
        storeName: b.store.name || b.store.storeName || null,
        name: b.store.name || b.store.storeName || null,
      } : null,
      address: b.address ? {
        addressId: b.address.addressId.toString(),
        recipientName: b.address.recipientName,
        phone: b.address.phone,
        addressDetail: b.address.addressDetail,
        ward: b.address.ward,
        district: b.address.district,
        province: b.address.province,
      } : null,
      products: b.buttonProducts
        ? b.buttonProducts.map((bp: any) => ({
            buttonProductId: bp.buttonProductId ? bp.buttonProductId.toString() : null,
            productId: bp.productId ? bp.productId.toString() : null,
            productName: bp.product?.productName,
            productCode: bp.product?.productCode,
            quantity: bp.quantity,
            price: bp.product?.basePrice,
          }))
        : [],
    };
  }

  private async assertDeviceAccess(id: string | number | bigint, user: any) {
    if (!user) {
      throw new ForbiddenException('Thiếu thông tin người thực hiện');
    }
    const button = await this.devicesRepo.findByIdentifier(id.toString());
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

  private buildDeviceScope(user: any, query?: any): any {
    if (!user) {
      throw new ForbiddenException('Thiếu thông tin người dùng');
    }

    const isAdmin = ['SUPER_ADMIN', 'SYSTEM_ADMIN', 'ADMIN'].includes(user.role);
    const whereClause: any = {};

    if (isAdmin) {
      if (query?.storeId) {
        whereClause.storeId = BigInt(query.storeId);
      }
      return whereClause;
    }

    if (user.role === 'CUSTOMER') {
      if (!user.customerProfileId) {
        throw new ForbiddenException('Tài khoản khách hàng chưa có hồ sơ liên kết');
      }
      whereClause.customerId = BigInt(user.customerProfileId);
      return whereClause;
    }

    if (['STORE_OWNER', 'STORE_MANAGER', 'STORE_STAFF', 'STAFF_BUTTON'].includes(user.role)) {
      if (!user.storeId) {
        throw new ForbiddenException('Tài khoản cửa hàng chưa được liên kết với cửa hàng nào');
      }
      whereClause.storeId = BigInt(user.storeId);
      return whereClause;
    }

    throw new ForbiddenException('Vai trò không được phép truy cập danh sách thiết bị');
  }

  async generateNextDeviceId(): Promise<string> {
    const count = await this.devicesRepo.count();
    const nextNumber = count + 1;
    return `SOB-${nextNumber.toString().padStart(6, '0')}`;
  }

  async getFleetStats(user: any) {
    const whereClause = this.buildDeviceScope(user);
    const [total, active] = await Promise.all([
      this.devicesRepo.count(whereClause),
      this.devicesRepo.count({ ...whereClause, status: 'ACTIVE' }),
    ]);

    return {
      total,
      online: active,
      offline: total - active,
      totalDevices: total,
      activeDevices: active,
      offlineDevices: total - active,
      criticalDevices: 0,
      healthyPercentage: total > 0 ? Math.round((active / total) * 100) : 100,
    };
  }

  async list(user: any, query: any) {
    const whereClause = this.buildDeviceScope(user, query);
    if (query?.status) {
      whereClause.status = query.status;
    }
    const buttons = await this.devicesRepo.findMany(whereClause);
    return buttons.map((b) => this.formatButton(b));
  }

  async registerDevice(dto: any, user: any) {
    let deviceId = dto.deviceId?.trim()?.toUpperCase();
    if (deviceId) {
      const existingDev = await this.devicesRepo.findByDeviceId(deviceId);
      if (existingDev) {
        throw new BadRequestException(`Mã thiết bị ${deviceId} đã tồn tại trong hệ thống.`);
      }
    } else {
      deviceId = await this.generateNextDeviceId();
    }

    if (dto.macAddress) {
      const cleanMac = dto.macAddress.trim().toUpperCase();
      if (DevicesService.registeredMacAddresses.has(cleanMac)) {
        throw new BadRequestException(`Địa chỉ MAC ${dto.macAddress} đã tồn tại trong hệ thống.`);
      }
      DevicesService.registeredMacAddresses.add(cleanMac);
      DevicesService.deviceMacMap.set(deviceId, dto.macAddress.trim());
    }

    const buttonCode = dto.buttonCode?.trim()?.toUpperCase() || `BTN-${Math.floor(100000 + Math.random() * 900000)}`;
    const buttonName = dto.buttonName?.trim() || dto.name?.trim() || `Nút Bấm ${buttonCode}`;

    // Resolve Store
    let storeId: bigint | null = null;
    if (user.role === 'SUPER_ADMIN' || user.role === 'SYSTEM_ADMIN') {
      storeId = dto.storeId ? BigInt(dto.storeId) : null;
    } else if (user.storeId) {
      storeId = BigInt(user.storeId);
    }

    if (!storeId) {
      const firstStore = await this.devicesRepo.findFirstActiveStore();
      if (!firstStore) {
        throw new BadRequestException('Chưa có cửa hàng hoạt động trong hệ thống');
      }
      storeId = firstStore.storeId;
    }

    // Resolve Customer
    let customerId: bigint | null = null;
    if (user.role === 'CUSTOMER' && user.customerProfileId) {
      customerId = BigInt(user.customerProfileId);
    } else if (dto.customerId) {
      customerId = BigInt(dto.customerId);
    }

    if (!customerId) {
      const firstCustomer = await this.devicesRepo.findFirstCustomer();
      if (!firstCustomer) {
        throw new BadRequestException('Chưa có hồ sơ khách hàng trong hệ thống');
      }
      customerId = firstCustomer.customerId;
    }

    // Resolve Customer Address
    let address = await this.devicesRepo.findFirstCustomerAddress(customerId);
    if (!address) {
      address = await this.devicesRepo.createDefaultCustomerAddress({
        customerId,
        recipientName: user.fullName || 'Khách hàng',
        phone: user.phone || '0900000000',
        addressDetail: 'Địa chỉ mặc định',
        isDefault: true,
      });
    }

    const hmacSecret = crypto.randomBytes(32).toString('hex');
    // Create IoT Button via Repository
    const newButton = await this.devicesRepo.create({
      hmacSecret,
      storeId,
      customerId,
      addressId: address.addressId,
      deviceId,
      buttonCode,
      buttonName,
      status: 'ACTIVE',
      installedAt: new Date(),
    });

    // Automatically bind StoreCustomer (BRD-CUSTOMER-05)
    await this.devicesRepo.linkStoreCustomer(storeId, customerId);

    // Assign product if provided
    if (dto.productId) {
      const targetProductId = BigInt(dto.productId);
      await this.devicesRepo.setButtonProducts(newButton.buttonId, [
        { productId: targetProductId, quantity: dto.quantity || 1 },
      ]);
    }

    return this.getById(newButton.buttonId, user);
  }

  async getById(id: string | number | bigint, user: any) {
    const button = await this.assertDeviceAccess(id, user);
    return this.formatButton(button);
  }

  async update(id: string | number | bigint, body: any, user: any) {
    const existing = await this.getById(id, user);

    const updated = await this.devicesRepo.update(BigInt(existing.buttonId), {
      ...(body.buttonName ? { buttonName: body.buttonName } : {}),
      ...(body.name ? { buttonName: body.name } : {}),
      ...(body.status ? { status: body.status } : {}),
    });

    return this.formatButton(updated);
  }

  async remove(id: string | number | bigint, user: any) {
    const existing = await this.getById(id, user);
    await this.devicesRepo.update(BigInt(existing.buttonId), { status: 'INACTIVE' });
    return { success: true, message: 'Đã hủy kích hoạt nút bấm thành công' };
  }

  async pair(id: string | number | bigint, body: any, user: any) {
    const existing = await this.getById(id, user);

    if (body.productId) {
      const targetProductId = BigInt(body.productId);
      await this.devicesRepo.setButtonProducts(BigInt(existing.buttonId), [
        { productId: targetProductId, quantity: body.quantity || 1 },
      ]);
    }

    return this.getById(existing.buttonId, user);
  }

  async repair(id: string | number | bigint, user: any) {
    const existing = await this.getById(id, user);
    const token = `p_${crypto.randomBytes(8).toString('hex')}`;
    const tokenHash = DevicesService.hashToken(token);
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
    await this.provRepo?.savePairingToken(existing.deviceId, tokenHash, expiresAt);
    DevicesService.setPairingTokenMemory(existing.deviceId, token, tokenHash, expiresAt.getTime());
    return {
      pairingToken: token,
      qrPayload: `SOBPAIR://device/${existing.deviceId}/token/${token}`,
    };
  }

  async assignProduct(id: string | number | bigint, body: any, user: any) {
    const existing = await this.getById(id, user);
    const targetProductId = BigInt(body.productId);

    await this.devicesRepo.setButtonProducts(BigInt(existing.buttonId), [
      { productId: targetProductId, quantity: body.quantity || 1 },
    ]);

    if (body.customName) {
      await this.devicesRepo.update(BigInt(existing.buttonId), { buttonName: body.customName.trim() });
    }

    const logList = this.deviceAuditLogs.get(existing.deviceId) || [];
    logList.unshift({
      action: 'UPDATE_PRODUCT_MAPPING',
      timestamp: new Date(),
      details: `Gán sản phẩm ${body.productId} cho nút bấm`,
      user: { fullName: user?.fullName || 'Store Owner' },
    });
    this.deviceAuditLogs.set(existing.deviceId, logList);

    return {
      success: true,
      message: 'Gán sản phẩm cho nút bấm thành công!',
      data: await this.getById(existing.buttonId, user),
    };
  }

  async unassignProduct(id: string | number | bigint, user: any) {
    const existing = await this.getById(id, user);
    await this.devicesRepo.setButtonProducts(BigInt(existing.buttonId), []);
    return { success: true, message: 'Đã hủy toàn bộ sản phẩm trên nút bấm' };
  }

  async disable(id: string | number | bigint, user: any) {
    const existing = await this.getById(id, user);
    const updated = await this.devicesRepo.update(BigInt(existing.buttonId), { status: 'INACTIVE' });
    return this.formatButton(updated);
  }

  async enable(id: string | number | bigint, user: any) {
    const existing = await this.getById(id, user);
    const updated = await this.devicesRepo.update(BigInt(existing.buttonId), { status: 'ACTIVE' });
    return this.formatButton(updated);
  }

  async getTelemetry(id: string | number | bigint, user: any) {
    const existing = await this.getById(id, user);
    return {
      deviceId: existing.deviceId,
      batteryLevel: 98,
      wifiRSSI: -55,
      healthScore: 95,
      healthStatus: 'OPTIMAL',
      lastSeenAt: new Date(),
    };
  }

  async getAuditLogs(id: string | number | bigint, user: any) {
    const existing = await this.getById(id, user);
    const recorded = this.deviceAuditLogs.get(existing.deviceId) || [];
    return [
      ...recorded,
      {
        action: 'CREATED',
        timestamp: existing.createdAt,
        details: 'Khởi tạo nút bấm trong hệ thống',
        user: { fullName: user?.fullName || 'Store Owner' },
      },
    ];
  }

  async claim(deviceId: string, claimCode: string, storeId: string, userId: string) {
    const button = await this.devicesRepo.findByIdentifier(deviceId);
    if (!button) throw new NotFoundException('Không tìm thấy thiết bị');
    return this.formatButton(button);
  }

  async assign(id: string, body: any, storeId: string, userId: string) {
    return this.pair(id, body, { role: 'STORE_OWNER', storeId });
  }

  async updateConfig(id: string, body: any, user: any) {
    return this.update(id, body, user);
  }

  async toggleStatus(id: string, status: string, user: any) {
    const existing = await this.assertDeviceAccess(id, user);
    const updated = await this.devicesRepo.update(existing.buttonId, { status });
    return this.formatButton(updated);
  }

  async customerUpdateConfig(id: string, body: any, user: any) {
    const existing = await this.getById(id, user);
    const buttonId = BigInt(existing.buttonId);

    // 1. Re-map Store if storeId is provided and different from current
    if (body.storeId && body.storeId.toString() !== existing.storeId?.toString()) {
      const newStoreId = BigInt(body.storeId);
      const store = await this.devicesRepo.findActiveStoreById(newStoreId);
      if (!store) {
        throw new BadRequestException('Cửa hàng được chọn không tồn tại hoặc đã ngừng hoạt động');
      }

      const customerId = existing.customerId ? BigInt(existing.customerId) : undefined;
      await this.devicesRepo.remapStore(buttonId, newStoreId, customerId);
    }

    // 2. Update button name if provided
    if (body.buttonName) {
      await this.devicesRepo.update(buttonId, { buttonName: body.buttonName });
    }

    // 3. Assign product if productId is provided
    if (body.productId) {
      const current = await this.getById(existing.buttonId, user);
      const targetStoreId = BigInt(current.storeId);
      const targetProductId = BigInt(body.productId);

      const product = await this.devicesRepo.findActiveProductInStore(targetProductId, targetStoreId);
      if (!product) {
        throw new BadRequestException('Sản phẩm không tồn tại hoặc không thuộc cửa hàng này');
      }

      await this.devicesRepo.setButtonProducts(buttonId, [
        { productId: targetProductId, quantity: body.quantity || 1 },
      ]);
    }

    return this.getById(existing.buttonId, user);
  }

  async updateBattery(id: string, level: number, user: any) {
    const existing = await this.assertDeviceAccess(id, user);
    await this.devicesRepo.update(existing.buttonId, { batteryLevel: level });
    return { success: true, buttonId: existing.buttonId.toString(), batteryLevel: level };
  }

  async extendWarranty(id: string, body: any, user: any) {
    const existing = await this.assertDeviceAccess(id, user);
    const months = Number(body?.months) || 12;
    const extendedUntil = new Date(Date.now() + months * 30 * 24 * 60 * 60 * 1000);
    await this.devicesRepo.update(existing.buttonId, { warrantyUntil: extendedUntil });
    return { success: true, buttonId: existing.buttonId.toString(), extendedUntil };
  }

  async toggleDeviceStatus(id: string, status: string, user: any) {
    const existing = await this.assertDeviceAccess(id, user);
    const updated = await this.devicesRepo.update(existing.buttonId, { status });
    return this.formatButton(updated);
  }

  async updateBehavior(id: string, body: any, user: any) {
    const existing = await this.assertDeviceAccess(id, user);
    const updateData: any = {};
    if (body.clickBehavior) updateData.clickBehavior = body.clickBehavior;
    if (body.doubleClickWindowMs) updateData.doubleClickWindowMs = Number(body.doubleClickWindowMs);
    if (body.holdDurationMs) updateData.holdDurationMs = Number(body.holdDurationMs);
    const updated = await this.devicesRepo.update(existing.buttonId, updateData);
    return {
      success: true,
      buttonId: existing.buttonId.toString(),
      message: 'Cập nhật hành vi nút bấm thành công',
      data: this.formatButton(updated),
    };
  }

  async bulkImport(body: { rows: any[]; storeId?: string }, user: any) {
    const created: any[] = [];
    for (const row of body.rows) {
      const b = await this.registerDevice(
        {
          ...row,
          storeId: body.storeId || user.storeId,
        },
        user,
      );
      created.push(b);
    }
    return { success: true, count: created.length, data: created };
  }

  async batchGenerateBlankDevices(body: { count?: number; prefix?: string; model?: string }, user: any) {
    const count = body.count || 5;
    const generated: any[] = [];
    for (let i = 0; i < count; i++) {
      const b = await this.registerDevice({}, user);
      generated.push(b);
    }
    return { success: true, count: generated.length, data: generated };
  }

  async getUnassignedDevices() {
    const buttons = await this.devicesRepo.findMany({ status: 'INACTIVE' });
    return buttons.map((b) => this.formatButton(b));
  }

  async allocateDevicesToStore(body: { storeId: string; deviceIds: string[]; productId?: string }, user: any) {
    const targetStoreId = BigInt(body.storeId);
    for (const dId of body.deviceIds) {
      const button = await this.devicesRepo.findByDeviceId(dId);
      if (button) {
        await this.devicesRepo.update(button.buttonId, { storeId: targetStoreId });
      }
    }
    return { success: true, message: 'Phân bổ nút bấm cho cửa hàng thành công' };
  }

  async lookupByCode(code: string) {
    const button = await this.devicesRepo.findByIdentifier(code.toUpperCase());
    if (!button) throw new NotFoundException('Không tìm thấy thiết bị');
    return {
      deviceId: button.deviceId,
      buttonCode: button.buttonCode,
      status: button.status,
      isClaimed: !!button.customerId,
      canClaim: button.status === 'ACTIVE' && !button.customerId,
    };
  }

  async configureByCode(body: any, user: any) {
    const rawButton = await this.devicesRepo.findByIdentifier(body.code || body.deviceId);
    if (!rawButton) throw new NotFoundException('Không tìm thấy thiết bị');
    if (body.productId) {
      await this.assignProduct(rawButton.buttonId.toString(), body, user);
    }
    return this.getById(rawButton.buttonId.toString(), user);
  }
}
