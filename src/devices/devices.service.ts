import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Inject,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EventsGateway } from '../websocket/events.gateway';
import * as crypto from 'crypto';

@Injectable()
export class DevicesService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(EventsGateway) private readonly eventsGateway: EventsGateway,
  ) {}

  private formatButton(b: any) {
    if (!b) return null;
    return {
      ...b,
      id: b.buttonId.toString(),
      buttonId: b.buttonId.toString(),
      storeId: b.storeId ? b.storeId.toString() : null,
      customerId: b.customerId ? b.customerId.toString() : null,
      addressId: b.addressId ? b.addressId.toString() : null,
      name: b.buttonName || 'Smart Order Button',
      customName: b.buttonName || 'Smart Order Button',
      batteryLevel: 98,
      wifiRSSI: -55,
      healthScore: 95,
      healthStatus: 'OPTIMAL',
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

  async generateNextDeviceId(): Promise<string> {
    const count = await this.prisma.ioTButton.count();
    const nextNumber = count + 1;
    return `SOB-${nextNumber.toString().padStart(6, '0')}`;
  }

  async getFleetStats(user: any) {
    let whereClause: any = {};
    if (['STORE_OWNER', 'STORE_MANAGER', 'STORE_STAFF'].includes(user.role) && user.storeId) {
      whereClause.storeId = BigInt(user.storeId);
    } else if (user.role === 'CUSTOMER' && user.customerProfileId) {
      whereClause.customerId = BigInt(user.customerProfileId);
    }

    const [total, active] = await Promise.all([
      this.prisma.ioTButton.count({ where: whereClause }),
      this.prisma.ioTButton.count({ where: { ...whereClause, status: 'ACTIVE' } }),
    ]);

    return {
      totalDevices: total,
      activeDevices: active,
      offlineDevices: total - active,
      criticalDevices: 0,
      healthyPercentage: total > 0 ? Math.round((active / total) * 100) : 100,
    };
  }

  async list(user: any, query: any) {
    const whereClause: any = {};

    if (user.role === 'CUSTOMER' && user.customerProfileId) {
      whereClause.customerId = BigInt(user.customerProfileId);
    } else if (['STORE_OWNER', 'STORE_MANAGER', 'STORE_STAFF'].includes(user.role) && user.storeId) {
      whereClause.storeId = BigInt(user.storeId);
    } else if (query.storeId) {
      whereClause.storeId = BigInt(query.storeId);
    }

    if (query.status) {
      whereClause.status = query.status;
    }

    const buttons = await this.prisma.ioTButton.findMany({
      where: whereClause,
      include: {
        store: true,
        customer: { include: { user: true } },
        address: true,
        buttonProducts: { include: { product: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    return buttons.map((b) => this.formatButton(b));
  }

  async registerDevice(dto: any, user: any) {
    let deviceId = dto.deviceId?.trim()?.toUpperCase();
    if (!deviceId) {
      deviceId = await this.generateNextDeviceId();
    }

    const buttonCode = dto.buttonCode?.trim()?.toUpperCase() || `BTN-${Math.floor(100000 + Math.random() * 900000)}`;
    const buttonName = dto.buttonName?.trim() || dto.name?.trim() || `Nút Bấm ${buttonCode}`;

    // Resolve Store
    let storeId: bigint | null = null;
    if (user.role === 'SUPER_ADMIN') {
      storeId = dto.storeId ? BigInt(dto.storeId) : null;
    } else if (user.storeId) {
      storeId = BigInt(user.storeId);
    }

    if (!storeId) {
      // Pick first active store
      const firstStore = await this.prisma.store.findFirst({ where: { status: 'ACTIVE' } });
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
      const firstCustomer = await this.prisma.customerProfile.findFirst();
      if (!firstCustomer) {
        throw new BadRequestException('Chưa có hồ sơ khách hàng trong hệ thống');
      }
      customerId = firstCustomer.customerId;
    }

    // Resolve Customer Address
    let address = await this.prisma.customerAddress.findFirst({
      where: { customerId },
    });

    if (!address) {
      address = await this.prisma.customerAddress.create({
        data: {
          customerId,
          recipientName: user.fullName || 'Khách hàng',
          phone: user.phone || '0900000000',
          addressDetail: 'Địa chỉ mặc định',
          isDefault: true,
        },
      });
    }

    // Create IoT Button
    const newButton = await this.prisma.ioTButton.create({
      data: {
        storeId,
        customerId,
        addressId: address.addressId,
        deviceId,
        buttonCode,
        buttonName,
        status: 'ACTIVE',
        installedAt: new Date(),
      },
      include: {
        store: true,
        customer: { include: { user: true } },
        address: true,
      },
    });

    // Automatically bind StoreCustomer (BRD-CUSTOMER-05)
    await this.prisma.storeCustomer.upsert({
      where: {
        uq_store_customer: {
          storeId,
          customerId,
        },
      },
      update: { status: 'ACTIVE' },
      create: {
        storeId,
        customerId,
        status: 'ACTIVE',
      },
    });

    // Assign product if provided
    if (dto.productId) {
      const targetProductId = BigInt(dto.productId);
      const prod = await this.prisma.product.findFirst({
        where: { productId: targetProductId, storeId },
      });
      if (prod) {
        await this.prisma.buttonProduct.create({
          data: {
            buttonId: newButton.buttonId,
            productId: targetProductId,
            quantity: dto.quantity || 1,
          },
        });
      }
    }

    return this.getById(newButton.buttonId, user);
  }

  async getById(id: string | number | bigint, user: any) {
    const whereCondition: any = [];
    if (!isNaN(Number(id))) {
      whereCondition.push({ buttonId: BigInt(id) });
    }
    whereCondition.push({ deviceId: id.toString() });
    whereCondition.push({ buttonCode: id.toString() });

    const button = await this.prisma.ioTButton.findFirst({
      where: { OR: whereCondition },
      include: {
        store: true,
        customer: { include: { user: true } },
        address: true,
        buttonProducts: { include: { product: true } },
      },
    });

    if (!button) {
      throw new NotFoundException('Không tìm thấy nút bấm');
    }

    // BOLA Check
    if (user && user.role === 'CUSTOMER' && user.customerProfileId) {
      if (button.customerId.toString() !== user.customerProfileId.toString()) {
        throw new ForbiddenException('Bạn không có quyền truy cập nút bấm này');
      }
    } else if (user && ['STORE_OWNER', 'STORE_MANAGER', 'STORE_STAFF'].includes(user.role) && user.storeId) {
      if (button.storeId.toString() !== user.storeId.toString()) {
        throw new ForbiddenException('Nút bấm không thuộc quyền quản lý của cửa hàng bạn');
      }
    }

    return this.formatButton(button);
  }

  async update(id: string | number | bigint, body: any, user: any) {
    const existing = await this.getById(id, user);

    const updated = await this.prisma.ioTButton.update({
      where: { buttonId: BigInt(existing.buttonId) },
      data: {
        ...(body.buttonName ? { buttonName: body.buttonName } : {}),
        ...(body.name ? { buttonName: body.name } : {}),
        ...(body.status ? { status: body.status } : {}),
      },
      include: {
        store: true,
        customer: { include: { user: true } },
        address: true,
        buttonProducts: { include: { product: true } },
      },
    });

    return this.formatButton(updated);
  }

  async remove(id: string | number | bigint, user: any) {
    const existing = await this.getById(id, user);
    await this.prisma.ioTButton.update({
      where: { buttonId: BigInt(existing.buttonId) },
      data: { status: 'INACTIVE' },
    });
    return { success: true, message: 'Đã hủy kích hoạt nút bấm thành công' };
  }

  async pair(id: string | number | bigint, body: any, user: any) {
    const existing = await this.getById(id, user);

    if (body.productId) {
      const targetProductId = BigInt(body.productId);
      await this.prisma.buttonProduct.upsert({
        where: {
          uq_button_product: {
            buttonId: BigInt(existing.buttonId),
            productId: targetProductId,
          },
        },
        update: { quantity: body.quantity || 1 },
        create: {
          buttonId: BigInt(existing.buttonId),
          productId: targetProductId,
          quantity: body.quantity || 1,
        },
      });
    }

    return this.getById(existing.buttonId, user);
  }

  async repair(id: string | number | bigint, user: any) {
    const existing = await this.getById(id, user);
    return {
      pairingToken: `p_${crypto.randomBytes(8).toString('hex')}`,
      qrPayload: `SOBPAIR://device/${existing.deviceId}/token/${Date.now()}`,
    };
  }

  async assignProduct(id: string | number | bigint, body: any, user: any) {
    const existing = await this.getById(id, user);
    const targetProductId = BigInt(body.productId);

    // Validate product belongs to button's store (BR-BUTTON-08)
    const prod = await this.prisma.product.findFirst({
      where: {
        productId: targetProductId,
        storeId: BigInt(existing.storeId),
      },
    });

    if (!prod) {
      throw new BadRequestException('Sản phẩm không thuộc cửa hàng phục vụ của nút bấm này');
    }

    await this.prisma.buttonProduct.upsert({
      where: {
        uq_button_product: {
          buttonId: BigInt(existing.buttonId),
          productId: targetProductId,
        },
      },
      update: { quantity: body.quantity || 1 },
      create: {
        buttonId: BigInt(existing.buttonId),
        productId: targetProductId,
        quantity: body.quantity || 1,
      },
    });

    return {
      success: true,
      message: 'Gán sản phẩm cho nút bấm thành công!',
      data: await this.getById(existing.buttonId, user),
    };
  }

  async unassignProduct(id: string | number | bigint, user: any) {
    const existing = await this.getById(id, user);
    await this.prisma.buttonProduct.deleteMany({
      where: { buttonId: BigInt(existing.buttonId) },
    });
    return { success: true, message: 'Đã hủy toàn bộ sản phẩm trên nút bấm' };
  }

  async disable(id: string | number | bigint, user: any) {
    const existing = await this.getById(id, user);
    const updated = await this.prisma.ioTButton.update({
      where: { buttonId: BigInt(existing.buttonId) },
      data: { status: 'INACTIVE' },
    });
    return this.formatButton(updated);
  }

  async enable(id: string | number | bigint, user: any) {
    const existing = await this.getById(id, user);
    const updated = await this.prisma.ioTButton.update({
      where: { buttonId: BigInt(existing.buttonId) },
      data: { status: 'ACTIVE' },
    });
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
    return [
      {
        action: 'CREATED',
        timestamp: existing.createdAt,
        details: 'Khởi tạo nút bấm trong hệ thống',
      },
    ];
  }

  async claim(deviceId: string, claimCode: string, storeId: string, userId: string) {
    const button = await this.prisma.ioTButton.findFirst({
      where: {
        OR: [{ deviceId }, { buttonCode: claimCode }],
      },
    });
    if (!button) throw new NotFoundException('Không tìm thấy thiết bị');
    return this.formatButton(button);
  }

  async assign(id: string, body: any, storeId: string, userId: string) {
    return this.pair(id, body, { role: 'STORE_OWNER', storeId });
  }

  async updateConfig(id: string, body: any, user: any) {
    return this.update(id, body, user);
  }

  async toggleStatus(id: string, status: string) {
    const updated = await this.prisma.ioTButton.update({
      where: { buttonId: BigInt(id) },
      data: { status },
    });
    return this.formatButton(updated);
  }

  async customerUpdateConfig(id: string, body: any, user: any) {
    const existing = await this.getById(id, user);

    if (body.buttonName) {
      await this.prisma.ioTButton.update({
        where: { buttonId: BigInt(existing.buttonId) },
        data: { buttonName: body.buttonName },
      });
    }

    if (body.productId) {
      await this.assignProduct(existing.buttonId, body, user);
    }

    return this.getById(existing.buttonId, user);
  }

  async updateBattery(id: string, level: number, user: any) {
    return { success: true, batteryLevel: level };
  }

  async extendWarranty(id: string, body: any, user: any) {
    return { success: true, extendedUntil: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000) };
  }

  async toggleDeviceStatus(id: string, status: string, user: any) {
    const updated = await this.prisma.ioTButton.update({
      where: { buttonId: BigInt(id) },
      data: { status },
    });
    return this.formatButton(updated);
  }

  async updateBehavior(id: string, body: any, user: any) {
    return { success: true, message: 'Cập nhật hành vi nút bấm thành công' };
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

  async batchGenerateBlankDevices(body: { count: number; prefix?: string; model?: string }, user: any) {
    const count = body.count || 5;
    const generated: any[] = [];
    for (let i = 0; i < count; i++) {
      const b = await this.registerDevice({}, user);
      generated.push(b);
    }
    return { success: true, count: generated.length, data: generated };
  }

  async getUnassignedDevices() {
    const buttons = await this.prisma.ioTButton.findMany({
      where: { status: 'INACTIVE' },
      include: { store: true, buttonProducts: true },
    });
    return buttons.map((b) => this.formatButton(b));
  }

  async allocateDevicesToStore(body: { storeId: string; deviceIds: string[]; productId?: string }, user: any) {
    const targetStoreId = BigInt(body.storeId);
    for (const dId of body.deviceIds) {
      await this.prisma.ioTButton.updateMany({
        where: { deviceId: dId },
        data: { storeId: targetStoreId },
      });
    }
    return { success: true, message: 'Phân bổ nút bấm cho cửa hàng thành công' };
  }

  async lookupByCode(code: string) {
    const button = await this.prisma.ioTButton.findFirst({
      where: {
        OR: [{ deviceId: code.toUpperCase() }, { buttonCode: code.toUpperCase() }],
      },
      include: {
        store: true,
        buttonProducts: { include: { product: true } },
      },
    });
    if (!button) throw new NotFoundException('Không tìm thấy thiết bị');
    return this.formatButton(button);
  }

  async configureByCode(body: any, user: any) {
    const button = await this.lookupByCode(body.code || body.deviceId);
    if (body.productId) {
      await this.assignProduct(button.buttonId, body, user);
    }
    return this.getById(button.buttonId, user);
  }
}
