import { Injectable, Inject, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class DevicesRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async count(whereClause?: any): Promise<number> {
    return this.prisma.ioTButton.count({ where: whereClause });
  }

  async findMany(whereClause: any) {
    return this.prisma.ioTButton.findMany({
      where: whereClause,
      include: {
        store: true,
        customer: { include: { user: true } },
        address: true,
        buttonProducts: { include: { product: true } },
        deployedTemplate: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findById(buttonId: bigint) {
    return this.prisma.ioTButton.findUnique({
      where: { buttonId },
      include: {
        store: true,
        customer: { include: { user: true } },
        address: true,
        buttonProducts: { include: { product: true } },
        deployedTemplate: true,
      },
    });
  }

  async findByDeviceId(deviceId: string) {
    return this.prisma.ioTButton.findUnique({
      where: { deviceId },
      include: {
        store: true,
        customer: { include: { user: true } },
        address: true,
        buttonProducts: { include: { product: true } },
        deployedTemplate: true,
      },
    });
  }

  async findByIdentifier(identifier: string) {
    const isNum = !isNaN(Number(identifier));
    return this.prisma.ioTButton.findFirst({
      where: {
        OR: [
          { deviceId: identifier },
          { buttonCode: identifier },
          ...(isNum ? [{ buttonId: BigInt(identifier) }] : []),
        ],
      },
      include: {
        store: true,
        customer: { include: { user: true } },
        address: true,
        buttonProducts: { include: { product: true } },
        deployedTemplate: true,
      },
    });
  }

  async create(data: any) {
    return this.prisma.ioTButton.create({
      data,
      include: {
        store: true,
        customer: { include: { user: true } },
        address: true,
        buttonProducts: { include: { product: true } },
        deployedTemplate: true,
      },
    });
  }

  async update(buttonId: bigint, data: any) {
    return this.prisma.ioTButton.update({
      where: { buttonId },
      data,
      include: {
        store: true,
        customer: { include: { user: true } },
        address: true,
        buttonProducts: { include: { product: true } },
        deployedTemplate: true,
      },
    });
  }

  async delete(buttonId: bigint) {
    return this.prisma.$transaction(async (tx) => {
      await tx.buttonProduct.deleteMany({ where: { buttonId } });
      return tx.ioTButton.delete({ where: { buttonId } });
    });
  }

  async setButtonProducts(buttonId: bigint, products: { productId: bigint; quantity: number }[]) {
    return this.prisma.$transaction(async (tx) => {
      await tx.buttonProduct.deleteMany({ where: { buttonId } });
      if (products.length > 0) {
        await tx.buttonProduct.createMany({
          data: products.map((p) => ({
            buttonId,
            productId: p.productId,
            quantity: p.quantity,
          })),
        });
      }
      return tx.ioTButton.findUnique({
        where: { buttonId },
        include: {
          store: true,
          customer: { include: { user: true } },
          buttonProducts: { include: { product: true } },
        deployedTemplate: true,
        },
      });
    });
  }

  async findFirstActiveStore() {
    return this.prisma.store.findFirst({ where: { status: 'ACTIVE' } });
  }

  async findFirstCustomer() {
    return this.prisma.customerProfile.findFirst();
  }

  async findFirstCustomerAddress(customerId: bigint) {
    return this.prisma.customerAddress.findFirst({ where: { customerId } });
  }

  async createDefaultCustomerAddress(data: {
    customerId: bigint;
    recipientName: string;
    phone: string;
    addressDetail: string;
    isDefault: boolean;
  }) {
    return this.prisma.customerAddress.create({ data });
  }

  async linkStoreCustomer(storeId: bigint, customerId: bigint) {
    return this.prisma.storeCustomer.upsert({
      where: {
        uq_store_customer: {
          storeId,
          customerId,
        },
      },
      update: {},
      create: {
        storeId,
        customerId,
      },
    });
  }

  // --- Device Templates Repository Methods ---
  async createTemplate(data: any) {
    return this.prisma.deviceTemplate.create({ data });
  }

  async findTemplates(whereClause: any) {
    return this.prisma.deviceTemplate.findMany({
      where: whereClause,
      orderBy: { createdAt: 'desc' },
    });
  }

  async findTemplateById(templateId: bigint) {
    return this.prisma.deviceTemplate.findUnique({
      where: { templateId },
    });
  }

  async findTemplateByCode(code: string) {
    return this.prisma.deviceTemplate.findUnique({
      where: { code },
    });
  }

  async findTemplateByIdOrCode(idOrCode: string) {
    const isNum = !isNaN(Number(idOrCode));
    return this.prisma.deviceTemplate.findFirst({
      where: {
        OR: [
          { code: idOrCode },
          ...(isNum ? [{ templateId: BigInt(idOrCode) }] : []),
        ],
      },
    });
  }

  async updateTemplate(templateId: bigint, data: any) {
    return this.prisma.deviceTemplate.update({
      where: { templateId },
      data,
    });
  }

  async deleteTemplate(templateId: bigint) {
    return this.prisma.deviceTemplate.delete({
      where: { templateId },
    });
  }

  async remapStore(buttonId: bigint, newStoreId: bigint, customerId?: bigint) {
    return this.prisma.$transaction(async (tx) => {
      // 1. Clear old button products
      await tx.buttonProduct.deleteMany({ where: { buttonId } });

      // 2. Update button store
      const updated = await tx.ioTButton.update({
        where: { buttonId },
        data: { storeId: newStoreId },
        include: {
          store: true,
          customer: { include: { user: true } },
          address: true,
          buttonProducts: { include: { product: true } },
        deployedTemplate: true,
        },
      });

      // 3. Link customer to new store if not already linked
      if (customerId) {
        const link = await tx.storeCustomer.findFirst({
          where: { storeId: newStoreId, customerId },
        });
        if (!link) {
          await tx.storeCustomer.create({
            data: { storeId: newStoreId, customerId },
          });
        }
      }

      return updated;
    });
  }

  async findActiveStoreById(storeId: bigint) {
    return this.prisma.store.findFirst({
      where: { storeId, status: 'ACTIVE' },
    });
  }

  async findActiveProductInStore(productId: bigint, storeId: bigint) {
    return this.prisma.product.findFirst({
      where: { productId, storeId, status: 'ACTIVE' },
    });
  }

  async consumeDeviceNonce(deviceId: string, nonce: string): Promise<boolean> {
    const rows: any[] = await this.prisma.$queryRawUnsafe(
      `INSERT INTO device_nonces (device_id, nonce, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '5 minutes')
       ON CONFLICT (device_id, nonce)
       DO UPDATE SET
         expires_at = EXCLUDED.expires_at,
         created_at = NOW()
       WHERE device_nonces.expires_at <= NOW()
       RETURNING nonce;`,
      deviceId,
      nonce,
    );
    return rows && rows.length > 0;
  }

  async cleanupExpiredNonces(): Promise<number> {
    const res = await this.prisma.$executeRawUnsafe(
      `DELETE FROM device_nonces WHERE expires_at < NOW();`
    );
    return res;
  }


  async deployTemplateAtomicTx(buttonId: bigint, template: {
    singlePressAction?: string | null;
    doublePressAction?: string | null;
    longPressAction?: string | null;
    defaultQuantity?: number | null;
    cancelWindowSeconds?: number | null;
    doubleClickWindowMs?: number | null;
    templateId?: bigint | null;
    deployedTemplateId?: bigint | null;
    defaultProductId?: bigint | null;
  }) {
    return this.prisma.$transaction(async (tx) => {
      // 1. Lock button row for update
      const lockedButton = await tx.$queryRawUnsafe<any[]>(
        'SELECT button_id, device_id, store_id FROM iot_button WHERE button_id = $1 FOR UPDATE',
        buttonId
      );
      if (!lockedButton || lockedButton.length === 0) {
        throw new Error('Thiết bị không tồn tại');
      }

      // 2. Hardware click behavior logic
      // Business cancellation window (cancelWindowSeconds) is strictly separated from
      // hardware debounce double-click window (doubleClickWindowMs, standard 300ms)
      const clickBehavior = template.doublePressAction ? 'DOUBLE' : 'SINGLE';
      const doubleClickWindowMs = template.doubleClickWindowMs !== undefined
        ? template.doubleClickWindowMs
        : (template.doublePressAction ? 300 : undefined);

      const targetTemplateId = template.deployedTemplateId ?? template.templateId;

      const updateData: any = {
        clickBehavior,
        singlePressAction: template.singlePressAction !== undefined ? template.singlePressAction : undefined,
        doublePressAction: template.doublePressAction !== undefined ? template.doublePressAction : undefined,
        longPressAction: template.longPressAction !== undefined ? template.longPressAction : undefined,
        cancelWindowSeconds: template.cancelWindowSeconds !== undefined ? template.cancelWindowSeconds : undefined,
      };
      if (targetTemplateId !== undefined) {
        updateData.deployedTemplateId = targetTemplateId;
      }
      if (doubleClickWindowMs !== undefined) {
        updateData.doubleClickWindowMs = doubleClickWindowMs;
      }

      const updatedButton = await tx.ioTButton.update({
        where: { buttonId },
        data: updateData,
        include: {
          store: true,
          customer: { include: { user: true } },
          address: true,
          buttonProducts: { include: { product: true } },
          deployedTemplate: true,
        },
      });

      // 3. Atomically map default product and default quantity if specified
      if (template.defaultProductId) {
        await tx.buttonProduct.deleteMany({ where: { buttonId } });
        await tx.buttonProduct.create({
          data: {
            buttonId,
            productId: template.defaultProductId,
            quantity: template.defaultQuantity && template.defaultQuantity > 0 ? template.defaultQuantity : 1,
          },
        });
      } else if (template.defaultQuantity && template.defaultQuantity > 0) {
        await tx.buttonProduct.updateMany({
          where: { buttonId },
          data: { quantity: template.defaultQuantity },
        });
      }

      return updatedButton;
    });
  }

  async allocateDevicesToStoreTx(targetStoreId: bigint, deviceIds: string[]) {
    return this.prisma.$transaction(async (tx) => {
      const store = await tx.store.findUnique({
        where: { storeId: targetStoreId },
        include: { owner: true },
      });
      if (!store) {
        throw new NotFoundException('Cửa hàng đích không tồn tại');
      }
      if (store.status !== 'ACTIVE') {
        throw new BadRequestException('Cửa hàng đích không hoạt động');
      }

      // Khóa các thiết bị bằng SELECT ... FOR UPDATE
      const lockedButtons = await tx.$queryRawUnsafe<any[]>(
        'SELECT button_id, device_id, store_id, status FROM iot_button WHERE device_id = ANY($1::text[]) FOR UPDATE',
        deviceIds,
      );

      const foundMap = new Map<string, any>();
      lockedButtons.forEach((b) => foundMap.set(b.device_id, b));

      const missingIds = deviceIds.filter((id) => !foundMap.has(id));
      if (missingIds.length > 0) {
        throw new NotFoundException(`Các thiết bị không tồn tại: ${missingIds.join(', ')}`);
      }

      for (const b of lockedButtons) {
        if (b.store_id && BigInt(b.store_id) !== targetStoreId) {
          throw new BadRequestException(`Thiết bị ${b.device_id} đã được phân bổ cho cửa hàng khác`);
        }
      }

      await tx.ioTButton.updateMany({
        where: { deviceId: { in: deviceIds } },
        data: {
          storeId: targetStoreId,
          status: 'ACTIVE',
        },
      });

      return {
        store,
        targetStoreId,
        ownerUserId: store.ownerUserId ? store.ownerUserId.toString() : (store.owner?.userId ? store.owner.userId.toString() : null),
        deviceIds,
      };
    });
  }

}
