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
    defaultProductId: null,
    singlePressAction: 'CREATE_ORDER',
    doublePressAction: 'CANCEL_ORDER',
    longPressAction: 'WIFI_CONFIGURATION',
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
    defaultProductId: null,
    singlePressAction: 'CREATE_ORDER',
    doublePressAction: 'CANCEL_ORDER',
    longPressAction: 'WIFI_CONFIGURATION',
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
      longPressAction: dto.longPressAction || 'WIFI_CONFIGURATION',
      defaultProductId: dto.defaultProductId ? BigInt(dto.defaultProductId) : null,
      defaultQuantity: dto.defaultQuantity ? Number(dto.defaultQuantity) : 1,
      cancelWindowSeconds: dto.cancelWindowSeconds ? Number(dto.cancelWindowSeconds) : 60,
    });

    return {
      ...created,
      id: created.templateId.toString(),
      templateId: created.templateId.toString(),
      storeId: created.storeId ? created.storeId.toString() : null,
      defaultProductId: created.defaultProductId ? created.defaultProductId.toString() : null,
      longPressAction: created.longPressAction || 'WIFI_CONFIGURATION',
      _count: { devices: 0 },
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

    return list.map((t: any) => ({
      ...t,
      id: t.templateId.toString(),
      templateId: t.templateId.toString(),
      storeId: t.storeId ? t.storeId.toString() : null,
      defaultProductId: t.defaultProductId ? t.defaultProductId.toString() : null,
      longPressAction: t.longPressAction || 'WIFI_CONFIGURATION',
      _count: { devices: t._count?.deployedButtons || 0 },
    }));
  }

  async getById(id: string, user: any) {
    if (!user) throw new ForbiddenException('Thiếu thông tin người dùng');
    const template: any = await this.devicesRepo.findTemplateByIdOrCode(id);

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
      defaultProductId: template.defaultProductId ? template.defaultProductId.toString() : null,
      longPressAction: template.longPressAction || 'WIFI_CONFIGURATION',
      _count: { devices: template._count?.deployedButtons || 0 },
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

    const updateData: any = {
      name: dto.name,
      description: dto.description,
      category: dto.category,
      singlePressAction: dto.singlePressAction,
      doublePressAction: dto.doublePressAction,
      longPressAction: dto.longPressAction,
      defaultQuantity: dto.defaultQuantity ? Number(dto.defaultQuantity) : undefined,
      cancelWindowSeconds: dto.cancelWindowSeconds ? Number(dto.cancelWindowSeconds) : undefined,
    };
    if (dto.defaultProductId !== undefined) {
      updateData.defaultProductId = dto.defaultProductId ? BigInt(dto.defaultProductId) : null;
    }

    const updated = await this.devicesRepo.updateTemplate(BigInt(template.templateId), updateData);

    return {
      ...updated,
      id: updated.templateId.toString(),
      templateId: updated.templateId.toString(),
      storeId: updated.storeId ? updated.storeId.toString() : null,
      defaultProductId: updated.defaultProductId ? updated.defaultProductId.toString() : null,
      longPressAction: updated.longPressAction || 'WIFI_CONFIGURATION',
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
    const template = await this.getById(id, user);

    // Resolve target device identifiers
    let targetDeviceIds: string[] = [];
    if (body.deviceId) {
      targetDeviceIds.push(body.deviceId.trim());
    } else if (body.deviceIds && Array.isArray(body.deviceIds)) {
      targetDeviceIds = body.deviceIds.map((d) => d.trim()).filter(Boolean);
    } else if (body.prefix && body.startRange !== undefined && body.endRange !== undefined) {
      const padLen = body.padLength || 3;
      const start = Math.min(body.startRange, body.endRange);
      const end = Math.max(body.startRange, body.endRange);
      for (let i = start; i <= end; i++) {
        targetDeviceIds.push(`${body.prefix}${String(i).padStart(padLen, '0')}`);
      }
    }

    if (targetDeviceIds.length === 0) {
      throw new BadRequestException('Vui lòng chỉ định mã thiết bị hoặc dải thiết bị cần triển khai template');
    }

    const isAdmin = ['SUPER_ADMIN', 'SYSTEM_ADMIN'].includes(user.role);
    const clickBehavior = template.doublePressAction ? 'DOUBLE' : 'SINGLE';
    const templateBigIntId = template.templateId ? BigInt(template.templateId) : (template.id && !isNaN(Number(template.id)) ? BigInt(template.id) : null);
    const templateProductId = template.defaultProductId ? BigInt(template.defaultProductId) : null;

    let successCount = 0;
    const errors: string[] = [];

    for (const devId of targetDeviceIds) {
      const button = await this.devicesRepo.findByIdentifier(devId);
      if (!button) {
        errors.push(`Không tìm thấy thiết bị: ${devId}`);
        continue;
      }

      if (!isAdmin) {
        if (!user.storeId || button.storeId?.toString() !== user.storeId.toString()) {
          errors.push(`Thiết bị ${devId} không thuộc quyền quản lý của cửa hàng bạn`);
          continue;
        }
      }

      await this.devicesRepo.deployTemplateAtomicTx(button.buttonId, {
        templateId: templateBigIntId,
        deployedTemplateId: templateBigIntId,
        singlePressAction: template.singlePressAction,
        doublePressAction: template.doublePressAction,
        defaultQuantity: template.defaultQuantity,
        cancelWindowSeconds: template.cancelWindowSeconds,
        doubleClickWindowMs: template.doublePressAction ? 300 : undefined,
        productId: templateProductId,
      });

      successCount++;
    }

    if (successCount === 0 && errors.length > 0) {
      throw new BadRequestException(errors.join(', '));
    }

    const message = targetDeviceIds.length === 1
      ? `Đã triển khai template "${template.name}" cho thiết bị ${targetDeviceIds[0]}`
      : `Đã triển khai template "${template.name}" cho ${successCount}/${targetDeviceIds.length} thiết bị thành công`;

    return {
      success: true,
      message,
      data: {
        templateId: template.id,
        successCount,
        totalRequested: targetDeviceIds.length,
        errors: errors.length > 0 ? errors : undefined,
        deployedAt: new Date(),
      },
    };
  }
}

