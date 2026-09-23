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
    const storeId = user.role === 'SUPER_ADMIN' ? (dto.storeId || null) : user.storeId;
    const newTemplate = {
      id: `tmpl_${Date.now()}`,
      name: dto.name?.trim() || 'Template Mẫu Nút Bấm',
      description: dto.description?.trim() || null,
      category: dto.category?.trim() || 'Nhu yếu phẩm',
      storeId,
      defaultProductId: dto.defaultProductId || null,
      singlePressAction: dto.singlePressAction || 'CREATE_ORDER',
      doublePressAction: dto.doublePressAction || 'CANCEL_ORDER',
      defaultQuantity: dto.defaultQuantity || 1,
      cancelWindowSeconds: dto.cancelWindowSeconds || 60,
      createdAt: new Date(),
    };
    inMemoryTemplates.push(newTemplate);
    return newTemplate;
  }

  async list(user: any) {
    return inMemoryTemplates;
  }

  async getById(id: string, user: any) {
    const t = inMemoryTemplates.find((x) => x.id === id);
    if (!t) throw new NotFoundException('Không tìm thấy template mẫu');
    return t;
  }

  async update(id: string, dto: any, user: any) {
    const index = inMemoryTemplates.findIndex((x) => x.id === id);
    if (index === -1) throw new NotFoundException('Không tìm thấy template');
    inMemoryTemplates[index] = { ...inMemoryTemplates[index], ...dto };
    return inMemoryTemplates[index];
  }

  async delete(id: string, user: any) {
    const index = inMemoryTemplates.findIndex((x) => x.id === id);
    if (index !== -1) inMemoryTemplates.splice(index, 1);
    return { success: true, message: 'Đã xóa template mẫu thành công' };
  }

  async deploy(id: string, body: any, user: any) {
    const template = await this.getById(id, user);
    return {
      success: true,
      message: `Đã triển khai template "${template.name}" cho thiết bị`,
      data: { templateId: id, deployedAt: new Date() },
    };
  }
}
