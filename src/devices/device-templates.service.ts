import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Inject,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EventsGateway } from '../websocket/events.gateway';

@Injectable()
export class DeviceTemplatesService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(EventsGateway) private readonly eventsGateway: EventsGateway,
  ) {}

  async create(dto: any, user: any) {
    const storeId = user.role === 'SUPER_ADMIN' ? (dto.storeId || null) : user.storeId;

    if (dto.defaultProductId && storeId) {
      const prod = await this.prisma.product.findFirst({
        where: { id: dto.defaultProductId, storeId },
      });
      if (!prod) throw new BadRequestException('Sản phẩm mặc định không tồn tại trong cửa hàng');
    }

    const template = await this.prisma.deviceTemplate.create({
      data: {
        name: dto.name.trim(),
        description: dto.description?.trim() || null,
        category: dto.category?.trim() || 'Nhu yếu phẩm',
        storeId,
        defaultProductId: dto.defaultProductId || null,
        singlePressAction: dto.singlePressAction || 'CREATE_ORDER',
        doublePressAction: dto.doublePressAction || 'CANCEL_ORDER',
        longPressAction: dto.longPressAction || 'WIFI_CONFIGURATION',
        defaultQuantity: dto.defaultQuantity || 1,
        cancelWindowSeconds: dto.cancelWindowSeconds || 60,
      },
      include: { defaultProduct: true },
    });

    return template;
  }

  async list(user: any) {
    let whereClause: any = {};
    if (['STORE_OWNER', 'STORE_MANAGER', 'STORE_STAFF'].includes(user.role)) {
      whereClause = { OR: [{ storeId: user.storeId }, { storeId: null }] };
    }

    return this.prisma.deviceTemplate.findMany({
      where: whereClause,
      include: { defaultProduct: true, _count: { select: { devices: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getById(id: string, user: any) {
    const template = await this.prisma.deviceTemplate.findUnique({
      where: { id },
      include: { defaultProduct: true, devices: true },
    });
    if (!template) throw new NotFoundException('Không tìm thấy template mẫu');
    return template;
  }

  async update(id: string, dto: any, user: any) {
    const template = await this.prisma.deviceTemplate.findUnique({ where: { id } });
    if (!template) throw new NotFoundException('Không tìm thấy template');

    if (user.role !== 'SUPER_ADMIN' && template.storeId && template.storeId !== user.storeId) {
      throw new ForbiddenException('Không có quyền chỉnh sửa template này');
    }

    return this.prisma.deviceTemplate.update({
      where: { id },
      data: {
        name: dto.name !== undefined ? dto.name.trim() : template.name,
        description: dto.description !== undefined ? dto.description : template.description,
        category: dto.category !== undefined ? dto.category : template.category,
        defaultProductId: dto.defaultProductId !== undefined ? dto.defaultProductId : template.defaultProductId,
        singlePressAction: dto.singlePressAction || template.singlePressAction,
        doublePressAction: dto.doublePressAction || template.doublePressAction,
        defaultQuantity: dto.defaultQuantity || template.defaultQuantity,
        cancelWindowSeconds: dto.cancelWindowSeconds || template.cancelWindowSeconds,
      },
      include: { defaultProduct: true },
    });
  }

  async delete(id: string, user: any) {
    const template = await this.prisma.deviceTemplate.findUnique({ where: { id } });
    if (!template) throw new NotFoundException('Không tìm thấy template');

    if (user.role !== 'SUPER_ADMIN' && template.storeId && template.storeId !== user.storeId) {
      throw new ForbiddenException('Không có quyền xóa template này');
    }

    await this.prisma.deviceTemplate.delete({ where: { id } });
    return { success: true, message: 'Đã xóa template' };
  }

  /**
   * Deploy Template to specific deviceIds or range (e.g. WATER-001 -> WATER-100)
   */
  async deploy(id: string, body: any, user: any) {
    const template = await this.prisma.deviceTemplate.findUnique({
      where: { id },
      include: { defaultProduct: true },
    });
    if (!template) throw new NotFoundException('Không tìm thấy template');

    const storeId = user.storeId || template.storeId;
    let targetDeviceIds: string[] = [];

    if (body.deviceIds && Array.isArray(body.deviceIds)) {
      targetDeviceIds = body.deviceIds;
    } else if (body.prefix && body.startRange !== undefined && body.endRange !== undefined) {
      const start = parseInt(body.startRange, 10);
      const end = parseInt(body.endRange, 10);
      const padLength = body.padLength || 3;

      for (let i = start; i <= end; i++) {
        targetDeviceIds.push(`${body.prefix}${i.toString().padStart(padLength, '0')}`);
      }
    } else {
      throw new BadRequestException('Vui lòng chỉ định danh sách deviceIds hoặc dải số prefix (startRange/endRange)');
    }

    // Find devices belonging to store matching IDs or aliases
    const devices = await this.prisma.device.findMany({
      where: {
        OR: [
          { deviceId: { in: targetDeviceIds } },
          { customName: { in: targetDeviceIds } },
        ],
        ...(storeId ? { storeId } : {}),
      },
    });

    if (devices.length === 0) {
      throw new NotFoundException('Không tìm thấy thiết bị nào phù hợp trong cửa hàng để triển khai template');
    }

    const deployedIds: string[] = [];

    await this.prisma.$transaction(async (tx) => {
      for (const dev of devices) {
        await tx.device.update({
          where: { id: dev.id },
          data: {
            templateId: template.id,
            productId: template.defaultProductId || dev.productId,
          },
        });

        if (template.defaultProductId) {
          await tx.deviceConfiguration.upsert({
            where: { deviceId: dev.id },
            create: {
              deviceId: dev.id,
              customName: dev.customName || `Nút ${template.name}`,
              productId: template.defaultProductId,
              defaultQuantity: template.defaultQuantity,
              cancelWindowSeconds: template.cancelWindowSeconds,
              updatedByUserId: user.id,
            },
            update: {
              productId: template.defaultProductId,
              defaultQuantity: template.defaultQuantity,
              cancelWindowSeconds: template.cancelWindowSeconds,
              updatedByUserId: user.id,
            },
          });
        }

        deployedIds.push(dev.deviceId);
      }

      await tx.auditLog.create({
        data: {
          userId: user.id,
          action: 'TEMPLATE_DEPLOYED',
          entity: 'DeviceTemplate',
          entityId: template.id,
          newValues: JSON.stringify({
            templateName: template.name,
            targetCount: deployedIds.length,
            deployedIds,
          }),
        },
      });
    });

    if (storeId) {
      this.eventsGateway.emitToStore(storeId, 'device:configured', {
        templateId: template.id,
        count: deployedIds.length,
      });
    }

    return {
      success: true,
      message: `Đã triển khai template "${template.name}" tới ${deployedIds.length} nút bấm thành công!`,
      deployedCount: deployedIds.length,
      deviceIds: deployedIds,
    };
  }
}
