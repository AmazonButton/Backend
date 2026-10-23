import { DeployDeviceTemplateDto, CreateDeviceTemplateDto, UpdateDeviceTemplateDto } from './dto/device-template.dto';
import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Inject,
} from '@nestjs/common';
import { DevicesRepository } from './devices.repository';
import { EventsGateway } from '../websocket/events.gateway';
import { PrismaService } from '../prisma/prisma.service';

const inMemoryTemplates: any[] = [
  {
    id: 'tmpl_water_20l',
    name: 'Nút Nước Khoáng 20L Tiêu Chuẩn',
    description: 'Cấu hình chuẩn cho nút giao nước tận nhà',
    category: 'Nước uống',
    storeId: null,
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
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  async create(dto: CreateDeviceTemplateDto, user: any) {
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

    let defaultProductId: bigint | null = null;
    if (dto.defaultProductId !== undefined && dto.defaultProductId !== null && dto.defaultProductId !== '') {
      const pId = BigInt(dto.defaultProductId);
      const product = await this.prisma.product.findUnique({
        where: { productId: pId },
      });
      if (!product) {
        throw new NotFoundException('Sản phẩm mặc định không tồn tại');
      }
      if (product.status !== 'ACTIVE') {
        throw new BadRequestException('Sản phẩm mặc định phải ở trạng thái ACTIVE');
      }
      if (!isAdmin && storeId !== null && product.storeId.toString() !== storeId.toString()) {
        throw new ForbiddenException('Sản phẩm mặc định không thuộc cửa hàng của bạn');
      }
      defaultProductId = pId;
    }

    const code = `TMPL-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).substring(2, 5).toUpperCase()}`;
    
    const created = await this.devicesRepo.createTemplate({
      code,
      name: dto.name?.trim() || 'Template Mẫu Nút Bấm',
      description: dto.description?.trim() || null,
      category: dto.category?.trim() || 'Nhu yếu phẩm',
      storeId,
      defaultProductId,
      singlePressAction: dto.singlePressAction || 'CREATE_ORDER',
      doublePressAction: dto.doublePressAction || 'CANCEL_ORDER',
      longPressAction: dto.longPressAction || 'WIFI_CONFIGURATION',
      defaultQuantity: dto.defaultQuantity ? Number(dto.defaultQuantity) : 1,
      cancelWindowSeconds: dto.cancelWindowSeconds !== undefined ? Number(dto.cancelWindowSeconds) : 60,
    });

    return {
      ...created,
      id: created.templateId.toString(),
      templateId: created.templateId.toString(),
      storeId: created.storeId ? created.storeId.toString() : null,
      defaultProductId: created.defaultProductId ? created.defaultProductId.toString() : null,
      longPressAction: created.longPressAction || 'WIFI_CONFIGURATION',
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
      defaultProductId: t.defaultProductId ? t.defaultProductId.toString() : null,
      longPressAction: t.longPressAction || 'WIFI_CONFIGURATION',
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
      defaultProductId: template.defaultProductId ? template.defaultProductId.toString() : null,
      longPressAction: template.longPressAction || 'WIFI_CONFIGURATION',
    };
  }

  async update(id: string, dto: UpdateDeviceTemplateDto, user: any) {
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

    let defaultProductId = template.defaultProductId;
    if (dto.defaultProductId !== undefined) {
      if (dto.defaultProductId === null || dto.defaultProductId === '') {
        defaultProductId = null;
      } else {
        const pId = BigInt(dto.defaultProductId);
        const product = await this.prisma.product.findUnique({
          where: { productId: pId },
        });
        if (!product) {
          throw new NotFoundException('Sản phẩm mặc định không tồn tại');
        }
        if (product.status !== 'ACTIVE') {
          throw new BadRequestException('Sản phẩm mặc định phải ở trạng thái ACTIVE');
        }
        if (!isAdmin && template.storeId !== null && product.storeId.toString() !== template.storeId.toString()) {
          throw new ForbiddenException('Sản phẩm mặc định không thuộc cửa hàng của bạn');
        }
        defaultProductId = pId;
      }
    }

    const updated = await this.devicesRepo.updateTemplate(BigInt(template.templateId), {
      name: dto.name !== undefined ? dto.name : undefined,
      description: dto.description !== undefined ? dto.description : undefined,
      category: dto.category !== undefined ? dto.category : undefined,
      defaultProductId,
      singlePressAction: dto.singlePressAction !== undefined ? dto.singlePressAction : undefined,
      doublePressAction: dto.doublePressAction !== undefined ? dto.doublePressAction : undefined,
      longPressAction: dto.longPressAction !== undefined ? dto.longPressAction : undefined,
      defaultQuantity: dto.defaultQuantity !== undefined ? Number(dto.defaultQuantity) : undefined,
      cancelWindowSeconds: dto.cancelWindowSeconds !== undefined ? Number(dto.cancelWindowSeconds) : undefined,
    });

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
    // 1. Phân biệt chính xác 3 chế độ (Single, Multi, Range) - không cho phép gửi đồng thời
    const hasSingle = Boolean(body?.deviceId && typeof body.deviceId === 'string' && body.deviceId.trim().length > 0);
    const hasMulti = Boolean(body?.deviceIds && Array.isArray(body.deviceIds) && body.deviceIds.length > 0);
    const hasRange = Boolean(body?.prefix && body.startRange !== undefined && body.endRange !== undefined);

    const modeCount = (hasSingle ? 1 : 0) + (hasMulti ? 1 : 0) + (hasRange ? 1 : 0);
    if (modeCount === 0) {
      throw new BadRequestException('Vui lòng chỉ định thiết bị cần triển khai qua deviceId, deviceIds, hoặc dải prefix/startRange/endRange');
    }
    if (modeCount > 1) {
      throw new BadRequestException('Chỉ được chọn 1 trong 3 chế độ triển khai: deviceId (đơn lẻ), deviceIds (danh sách), hoặc prefix + startRange + endRange (theo dải)');
    }

    let rawDeviceIds: string[] = [];

    if (hasSingle) {
      rawDeviceIds = [body.deviceId!.trim()];
    } else if (hasMulti) {
      rawDeviceIds = body.deviceIds!.map((d) => String(d).trim()).filter(Boolean);
    } else if (hasRange) {
      const { prefix, startRange, endRange, padLength } = body;
      if (endRange! < startRange!) {
        throw new BadRequestException('endRange phải lớn hơn hoặc bằng startRange');
      }
      if (endRange! - startRange! + 1 > 100) {
        throw new BadRequestException('Chỉ được triển khai tối đa 100 thiết bị');
      }
      for (let i = startRange!; i <= endRange!; i++) {
        const numStr = padLength ? String(i).padStart(padLength, '0') : String(i);
        rawDeviceIds.push(`${prefix}${numStr}`);
      }
    }

    // Loại bỏ mã trùng lặp và giới hạn tối đa 100
    const uniqueDeviceIds = Array.from(new Set(rawDeviceIds));
    if (uniqueDeviceIds.length === 0) {
      throw new BadRequestException('Danh sách thiết bị triển khai không được để trống');
    }
    if (uniqueDeviceIds.length > 100) {
      throw new BadRequestException('Số lượng thiết bị triển khai tối đa trong một lần là 100 thiết bị');
    }

    const template = await this.getById(id, user);
    const isAdmin = ['SUPER_ADMIN', 'SYSTEM_ADMIN'].includes(user.role);
    const templateBigIntId = template.templateId
      ? BigInt(template.templateId)
      : (template.id && !isNaN(Number(template.id)) ? BigInt(template.id) : null);

    const results: Array<{ deviceId: string; success: boolean; message?: string; reason?: string }> = [];

    for (const dId of uniqueDeviceIds) {
      try {
        const button = await this.devicesRepo.findByIdentifier(dId);
        if (!button) {
          results.push({ deviceId: dId, success: false, reason: 'Không tìm thấy thiết bị đích' });
          continue;
        }

        if (!isAdmin) {
          if (!user.storeId || button.storeId?.toString() !== user.storeId.toString()) {
            results.push({ deviceId: dId, success: false, reason: 'Thiết bị không thuộc quyền quản lý của cửa hàng bạn' });
            continue;
          }
        }

        // Kiểm tra sản phẩm mặc định có thuộc cửa hàng của thiết bị không
        if (template.defaultProduct && button.storeId && template.defaultProduct.storeId.toString() !== button.storeId.toString()) {
          results.push({ deviceId: dId, success: false, reason: 'Sản phẩm mặc định của template không thuộc cửa hàng sở hữu nút bấm' });
          continue;
        }

        await this.devicesRepo.deployTemplateAtomicTx(button.buttonId, {
          templateId: templateBigIntId,
          deployedTemplateId: templateBigIntId,
          singlePressAction: template.singlePressAction,
          doublePressAction: template.doublePressAction,
          longPressAction: template.longPressAction || 'WIFI_CONFIGURATION',
          defaultQuantity: template.defaultQuantity,
          cancelWindowSeconds: template.cancelWindowSeconds,
          doubleClickWindowMs: template.doublePressAction ? 300 : undefined,
          defaultProductId: template.defaultProductId ? BigInt(template.defaultProductId) : null,
        });

        results.push({ deviceId: dId, success: true, message: 'Triển khai cấu hình template thành công' });
      } catch (err: any) {
        results.push({ deviceId: dId, success: false, reason: err.message || 'Lỗi hệ thống khi triển khai' });
      }
    }

    const succeeded = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;
    const clickBehavior = template.doublePressAction ? 'DOUBLE' : 'SINGLE';

    return {
      success: succeeded > 0,
      total: uniqueDeviceIds.length,
      succeeded,
      failed,
      message: succeeded > 0
        ? `Đã triển khai template "${template.name}" cho ${succeeded}/${uniqueDeviceIds.length} thiết bị`
        : `Triển khai template thất bại: ${results[0]?.reason}`,
      results,
      data: hasSingle ? {
        templateId: template.id,
        deviceId: uniqueDeviceIds[0],
        clickBehavior,
        singlePressAction: template.singlePressAction,
        doublePressAction: template.doublePressAction,
        longPressAction: template.longPressAction || 'WIFI_CONFIGURATION',
        defaultQuantity: template.defaultQuantity,
        cancelWindowSeconds: template.cancelWindowSeconds,
        deployedAt: new Date(),
      } : undefined,
    };
  }
}
