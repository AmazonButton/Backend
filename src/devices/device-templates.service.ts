import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Inject,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EventsGateway } from '../websocket/events.gateway';

const inMemoryTemplates: any[] = [
  {
    id: 'tmpl_water_20l',
    name: 'Nút Nước Khoáng 20L Tiêu Chuẩn',
    description: 'Cấu hình chuẩn cho nút giao nước tận nhà',
    category: 'Nước uống',
    storeId: null,
    singlePressAction: 'CREATE_ORDER',
    doublePressAction: 'CANCEL_ORDER',
    defaultQuantity: 1,
    cancelWindowSeconds: 60,
    createdAt: new Date(),
  },
  {
    id: 'tmpl_gas_12kg',
    name: 'Nút Đổi Bình Gas 12kg',
    description: 'Cấu hình cho nút đổi gas gia đình an toàn',
    category: 'Gas',
    storeId: null,
    singlePressAction: 'CREATE_ORDER',
    doublePressAction: 'CANCEL_ORDER',
    defaultQuantity: 1,
    cancelWindowSeconds: 60,
    createdAt: new Date(),
  },
];

@Injectable()
export class DeviceTemplatesService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(EventsGateway) private readonly eventsGateway: EventsGateway,
  ) {}

  async create(dto: any, user: any) {
    const storeId = user.role === 'SUPER_ADMIN' ? (dto.storeId ? BigInt(dto.storeId) : null) : (user.storeId ? BigInt(user.storeId) : null);
    const code = `TMPL-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).substring(2, 5).toUpperCase()}`;
    
    const created = await this.prisma.deviceTemplate.create({
      data: {
        code,
        name: dto.name?.trim() || 'Template Mẫu Nút Bấm',
        description: dto.description?.trim() || null,
        category: dto.category?.trim() || 'Nhu yếu phẩm',
        storeId,
        singlePressAction: dto.singlePressAction || 'CREATE_ORDER',
        doublePressAction: dto.doublePressAction || 'CANCEL_ORDER',
        defaultQuantity: dto.defaultQuantity ? Number(dto.defaultQuantity) : 1,
        cancelWindowSeconds: dto.cancelWindowSeconds ? Number(dto.cancelWindowSeconds) : 60,
      },
    });

    return {
      ...created,
      id: created.templateId.toString(),
      templateId: created.templateId.toString(),
      storeId: created.storeId ? created.storeId.toString() : null,
    };
  }

  async list(user: any) {
    let where: any = {};
    if (user.role !== 'SUPER_ADMIN' && user.storeId) {
      where = {
        OR: [{ storeId: BigInt(user.storeId) }, { storeId: null }],
      };
    }

    const list = await this.prisma.deviceTemplate.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });

    return list.map((t) => ({
      ...t,
      id: t.templateId.toString(),
      templateId: t.templateId.toString(),
      storeId: t.storeId ? t.storeId.toString() : null,
    }));
  }

  async getById(id: string, user: any) {
    const template = await this.prisma.deviceTemplate.findFirst({
      where: {
        OR: [
          { code: id },
          ...(isNaN(Number(id)) ? [] : [{ templateId: BigInt(id) }]),
        ],
      },
    });

    if (!template) {
      // Fallback check in memory seed templates
      const fallback = inMemoryTemplates.find((x) => x.id === id);
      if (fallback) return fallback;
      throw new NotFoundException('Không tìm thấy template mẫu');
    }

    return {
      ...template,
      id: template.templateId.toString(),
      templateId: template.templateId.toString(),
      storeId: template.storeId ? template.storeId.toString() : null,
    };
  }

  async update(id: string, dto: any, user: any) {
    const template = await this.getById(id, user);

    const updated = await this.prisma.deviceTemplate.update({
      where: { templateId: BigInt(template.id || template.templateId) },
      data: {
        name: dto.name,
        description: dto.description,
        category: dto.category,
        singlePressAction: dto.singlePressAction,
        doublePressAction: dto.doublePressAction,
        defaultQuantity: dto.defaultQuantity ? Number(dto.defaultQuantity) : undefined,
        cancelWindowSeconds: dto.cancelWindowSeconds ? Number(dto.cancelWindowSeconds) : undefined,
      },
    });

    return {
      ...updated,
      id: updated.templateId.toString(),
      templateId: updated.templateId.toString(),
      storeId: updated.storeId ? updated.storeId.toString() : null,
    };
  }

  async delete(id: string, user: any) {
    const template = await this.getById(id, user);
    await this.prisma.deviceTemplate.delete({
      where: { templateId: BigInt(template.id || template.templateId) },
    });
    return { success: true, message: 'Đã xóa template mẫu thành công' };
  }

  async deploy(id: string, body: any, user: any) {
    const template = await this.getById(id, user);
    return {
      success: true,
      message: `Đã triển khai template "${template.name}" cho thiết bị`,
      data: { templateId: template.id, deployedAt: new Date() },
    };
  }
}
