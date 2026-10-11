import { DeployDeviceTemplateDto } from './dto/device-template.dto';
import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Inject,
} from '@nestjs/common';
import { DevicesRepository } from './devices.repository';
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
    @Inject(DevicesRepository) private readonly devicesRepo: DevicesRepository,
    @Inject(EventsGateway) private readonly eventsGateway: EventsGateway,
  ) {}

  async create(dto: any, user: any) {
    if (!user) throw new ForbiddenException('Thiếu thông tin người dùng');
    const isAdmin = ['SUPER_ADMIN', 'SYSTEM_ADMIN'].includes(user.role);
    
    let storeId: bigint | null = null;
    if (isAdmin) {
      storeId = dto.storeId ? BigInt(dto.storeId) : null;
    } else {
      if (!user.storeId) {
        throw new ForbiddenException('Tài khoản cửa hàng thiếu thông tin storeId');
      }
      storeId = BigInt(user.storeId);
    }

    const code = `TMPL-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).substring(2, 5).toUpperCase()}`;
    
    const created = await this.devicesRepo.createTemplate({
      code,
      name: dto.name?.trim() || 'Template Mẫu Nút Bấm',
      description: dto.description?.trim() || null,
      category: dto.category?.trim() || 'Nhu yếu phẩm',
      storeId,
      singlePressAction: dto.singlePressAction || 'CREATE_ORDER',
      doublePressAction: dto.doublePressAction || 'CANCEL_ORDER',
      defaultQuantity: dto.defaultQuantity ? Number(dto.defaultQuantity) : 1,
      cancelWindowSeconds: dto.cancelWindowSeconds ? Number(dto.cancelWindowSeconds) : 60,
    });

    return {
      ...created,
      id: created.templateId.toString(),
      templateId: created.templateId.toString(),
      storeId: created.storeId ? created.storeId.toString() : null,
    };
  }

  async list(user: any) {
    if (!user) throw new ForbiddenException('Thiếu thông tin người dùng');
    const isAdmin = ['SUPER_ADMIN', 'SYSTEM_ADMIN'].includes(user.role);

    let where: any = {};
    if (!isAdmin) {
      if (user.role === 'CUSTOMER') {
        where = { storeId: null };
      } else if (['STORE_OWNER', 'STORE_MANAGER', 'STORE_STAFF', 'STAFF_BUTTON'].includes(user.role)) {
        if (!user.storeId) {
          throw new ForbiddenException('Tài khoản cửa hàng thiếu thông tin storeId');
        }
        where = {
          OR: [{ storeId: BigInt(user.storeId) }, { storeId: null }],
        };
      } else {
        throw new ForbiddenException('Không có quyền xem template thiết bị');
      }
    }

    const list = await this.devicesRepo.findTemplates(where);

    return list.map((t) => ({
      ...t,
      id: t.templateId.toString(),
      templateId: t.templateId.toString(),
      storeId: t.storeId ? t.storeId.toString() : null,
    }));
  }

  async getById(id: string, user: any) {
    if (!user) throw new ForbiddenException('Thiếu thông tin người dùng');
    const template = await this.devicesRepo.findTemplateByIdOrCode(id);

    if (!template) {
      const fallback = inMemoryTemplates.find((x) => x.id === id);
      if (fallback) return fallback;
      throw new NotFoundException('Không tìm thấy template mẫu');
    }

    const isAdmin = ['SUPER_ADMIN', 'SYSTEM_ADMIN'].includes(user.role);
    if (!isAdmin && template.storeId !== null) {
      if (!user.storeId || user.storeId.toString() !== template.storeId.toString()) {
        throw new ForbiddenException('Bạn không có quyền truy cập template của cửa hàng khác');
      }
    }

    return {
      ...template,
      id: template.templateId.toString(),
      templateId: template.templateId.toString(),
      storeId: template.storeId ? template.storeId.toString() : null,
    };
  }

  async update(id: string, dto: any, user: any) {
    if (!user) throw new ForbiddenException('Thiếu thông tin người dùng');
    const template = await this.devicesRepo.findTemplateByIdOrCode(id);
    if (!template) throw new NotFoundException('Không tìm thấy template mẫu');

    const isAdmin = ['SUPER_ADMIN', 'SYSTEM_ADMIN'].includes(user.role);
    if (template.storeId === null) {
      if (!isAdmin) {
        throw new ForbiddenException('Chỉ quản trị viên hệ thống (SUPER_ADMIN) mới có quyền chỉnh sửa template toàn cục');
      }
    } else {
      if (!isAdmin) {
        if (!user.storeId || user.storeId.toString() !== template.storeId.toString()) {
          throw new ForbiddenException('Bạn không có quyền chỉnh sửa template của cửa hàng khác');
        }
      }
    }

    const updated = await this.devicesRepo.updateTemplate(BigInt(template.templateId), {
      name: dto.name,
      description: dto.description,
      category: dto.category,
      singlePressAction: dto.singlePressAction,
      doublePressAction: dto.doublePressAction,
      defaultQuantity: dto.defaultQuantity ? Number(dto.defaultQuantity) : undefined,
      cancelWindowSeconds: dto.cancelWindowSeconds ? Number(dto.cancelWindowSeconds) : undefined,
    });

    return {
      ...updated,
      id: updated.templateId.toString(),
      templateId: updated.templateId.toString(),
      storeId: updated.storeId ? updated.storeId.toString() : null,
    };
  }

  async delete(id: string, user: any) {
    if (!user) throw new ForbiddenException('Thiếu thông tin người dùng');
    const template = await this.devicesRepo.findTemplateByIdOrCode(id);
    if (!template) throw new NotFoundException('Không tìm thấy template mẫu');

    const isAdmin = ['SUPER_ADMIN', 'SYSTEM_ADMIN'].includes(user.role);
    if (template.storeId === null) {
      if (!isAdmin) {
        throw new ForbiddenException('Chỉ quản trị viên hệ thống (SUPER_ADMIN) mới có quyền xóa template toàn cục');
      }
    } else {
      if (!isAdmin) {
        if (!user.storeId || user.storeId.toString() !== template.storeId.toString()) {
          throw new ForbiddenException('Bạn không có quyền xóa template của cửa hàng khác');
        }
      }
    }

    await this.devicesRepo.deleteTemplate(BigInt(template.templateId));
    return { success: true, message: 'Đã xóa template mẫu thành công' };
  }

  async deploy(id: string, body: DeployDeviceTemplateDto, user: any) {
    if (!body?.deviceId) {
      throw new BadRequestException('Mã thiết bị (deviceId) là bắt buộc khi triển khai template');
    }
    const template = await this.getById(id, user);

    const button = await this.devicesRepo.findByIdentifier(body.deviceId.toString().trim());
    if (!button) throw new NotFoundException('Không tìm thấy thiết bị đích');

    const isAdmin = ['SUPER_ADMIN', 'SYSTEM_ADMIN'].includes(user.role);
    if (!isAdmin) {
      if (!user.storeId || button.storeId?.toString() !== user.storeId.toString()) {
        throw new ForbiddenException('Thiết bị không thuộc quyền quản lý của cửa hàng bạn');
      }
    }

    const clickBehavior = template.doublePressAction ? 'DOUBLE' : 'SINGLE';
    await this.devicesRepo.update(button.buttonId, {
      clickBehavior,
    });

    return {
      success: true,
      message: `Đã triển khai template "${template.name}" cho thiết bị ${button.deviceId}`,
      data: {
        templateId: template.id,
        deviceId: button.deviceId,
        clickBehavior,
        deployedAt: new Date(),
      },
    };
  }
}
