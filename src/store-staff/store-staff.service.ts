import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { StoreStaffRepository } from './store-staff.repository';
import { CreateStoreStaffDto } from './dto/create-store-staff.dto';
import { UpdateStoreStaffDto } from './dto/update-store-staff.dto';
import { StoreStaffResponseDto } from './dto/store-staff-response.dto';

export const ALLOWED_STORE_STAFF_ROLES = [
  'STORE_MANAGER',
  'STAFF_ORDER',
  'STAFF_INVENTORY',
  'STAFF_DELIVERY',
  'STAFF_BUTTON',
] as const;

export const ROLE_METADATA: Record<
  string,
  { name: string; description: string }
> = {
  STORE_MANAGER: {
    name: 'Quản lý cửa hàng',
    description: 'Toàn quyền quản lý đơn hàng, kho và vận hành cửa hàng',
  },
  STAFF_ORDER: {
    name: 'Nhân viên xử lý đơn',
    description: 'Tiếp nhận, xử lý và chuẩn bị đơn hàng cho khách',
  },
  STAFF_INVENTORY: {
    name: 'Nhân viên kho',
    description: 'Quản lý nhập xuất tồn và kiểm kê sản phẩm',
  },
  STAFF_DELIVERY: {
    name: 'Nhân viên giao nhận',
    description: 'Vận chuyển và cập nhật trạng thái giao hàng',
  },
  STAFF_BUTTON: {
    name: 'Kỹ thuật viên nút bấm IoT',
    description: 'Cấu hình và kiểm tra thiết bị nút bấm thông minh',
  },
};

@Injectable()
export class StoreStaffService {
  constructor(private readonly repo: StoreStaffRepository) {}

  private validateRoleWhitelist(roleCode: string) {
    if (!ALLOWED_STORE_STAFF_ROLES.includes(roleCode as any)) {
      throw new ForbiddenException(
        `ROLE_ESCALATION_PROHIBITED: Không được phép gán vai trò '${roleCode}' cho nhân viên cửa hàng`,
      );
    }
  }

  async verifyStoreOwnership(storeId: bigint, user: any) {
    const role = user?.role || user?.roleCode;
    if (role === 'ADMIN' || role === 'SUPER_ADMIN') {
      return;
    }

    const store = await this.repo.findStore(storeId);
    if (!store) {
      throw new NotFoundException('Cửa hàng không tồn tại');
    }

    const currentUserId = (user?.userId || user?.id || user?.sub)?.toString();
    if (store.ownerUserId.toString() !== currentUserId) {
      throw new ForbiddenException('Bạn không có quyền quản lý nhân viên của cửa hàng này');
    }
  }

  async listAssignableRoles() {
    return ALLOWED_STORE_STAFF_ROLES.map((code) => ({
      roleCode: code,
      roleName: ROLE_METADATA[code]?.name || code,
      description: ROLE_METADATA[code]?.description || null,
    }));
  }

  async listStaff(
    storeIdStr: string,
    query: { page?: number; pageSize?: number; status?: string; roleCode?: string },
    user: any,
  ) {
    const storeId = BigInt(storeIdStr);
    await this.verifyStoreOwnership(storeId, user);

    const page = Math.max(1, Number(query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 20));
    const skip = (page - 1) * pageSize;

    const { total, items } = await this.repo.findStaffByStore(storeId, {
      skip,
      take: pageSize,
      status: query.status,
      roleCode: query.roleCode,
    });

    return {
      items: items.map(StoreStaffResponseDto.fromEntity),
      total,
      page,
      pageSize,
    };
  }

  async addStaff(storeIdStr: string, dto: CreateStoreStaffDto, user: any): Promise<StoreStaffResponseDto> {
    const storeId = BigInt(storeIdStr);
    await this.verifyStoreOwnership(storeId, user);

    this.validateRoleWhitelist(dto.roleCode);

    // Resolve user to add
    const identifier = dto.userId || dto.userIdentifier;
    if (!identifier) {
      throw new BadRequestException('Vui lòng cung cấp userId hoặc userIdentifier');
    }

    const targetUser = await this.repo.findUserByIdentifier(identifier);
    if (!targetUser) {
      throw new NotFoundException(`Không tìm thấy người dùng với thông tin: ${identifier}`);
    }

    // Check existing staff
    const existing = await this.repo.findStaffByStoreAndUser(storeId, targetUser.userId);
    if (existing) {
      if (existing.status === 'ACTIVE') {
        throw new ConflictException('Người dùng đã là nhân viên đang hoạt động của cửa hàng');
      }
      // Reactivate staff if previously inactive
      let role = await this.repo.findRoleByCode(dto.roleCode);
      if (!role) {
        throw new NotFoundException(`Vai trò ${dto.roleCode} không tồn tại trong hệ thống`);
      }
      const updated = await this.repo.updateStaff(existing.storeStaffId, {
        roleId: role.roleId,
        status: 'ACTIVE',
        leftAt: null,
      });
      return StoreStaffResponseDto.fromEntity(updated);
    }

    let role = await this.repo.findRoleByCode(dto.roleCode);
    if (!role) {
      throw new NotFoundException(`Vai trò ${dto.roleCode} không tồn tại trong hệ thống`);
    }

    const created = await this.repo.createStaff({
      storeId,
      userId: targetUser.userId,
      roleId: role.roleId,
    });

    return StoreStaffResponseDto.fromEntity(created);
  }

  async getStaff(staffIdStr: string, user: any): Promise<StoreStaffResponseDto> {
    const staffId = BigInt(staffIdStr);
    const staff = await this.repo.findStaffById(staffId);
    if (!staff) {
      throw new NotFoundException('Nhân viên không tồn tại');
    }

    const currentUserId = (user?.userId || user?.id || user?.sub)?.toString();
    const role = user?.role || user?.roleCode;

    if (
      role !== 'ADMIN' &&
      role !== 'SUPER_ADMIN' &&
      staff.store.ownerUserId.toString() !== currentUserId &&
      staff.userId.toString() !== currentUserId
    ) {
      throw new ForbiddenException('Bạn không có quyền xem thông tin nhân viên này');
    }

    return StoreStaffResponseDto.fromEntity(staff);
  }

  async updateStaff(
    staffIdStr: string,
    dto: UpdateStoreStaffDto,
    user: any,
  ): Promise<StoreStaffResponseDto> {
    const staffId = BigInt(staffIdStr);
    const staff = await this.repo.findStaffById(staffId);
    if (!staff) {
      throw new NotFoundException('Nhân viên không tồn tại');
    }

    await this.verifyStoreOwnership(staff.storeId, user);

    const updateData: any = {};

    if (dto.roleCode) {
      this.validateRoleWhitelist(dto.roleCode);
      const role = await this.repo.findRoleByCode(dto.roleCode);
      if (!role) {
        throw new NotFoundException(`Vai trò ${dto.roleCode} không tồn tại trong hệ thống`);
      }
      updateData.roleId = role.roleId;
    }

    if (dto.status) {
      const canonicalStatus = dto.status === 'INACTIVE' ? 'TERMINATED' : dto.status;
      updateData.status = canonicalStatus;
      if (canonicalStatus === 'TERMINATED') {
        updateData.leftAt = new Date();
      } else if (canonicalStatus === 'ACTIVE') {
        updateData.leftAt = null;
      }
    }

    const updated = await this.repo.updateStaff(staffId, updateData);
    return StoreStaffResponseDto.fromEntity(updated);
  }

  async deleteStaff(staffIdStr: string, user: any) {
    const staffId = BigInt(staffIdStr);
    const staff = await this.repo.findStaffById(staffId);
    if (!staff) {
      throw new NotFoundException('Nhân viên không tồn tại');
    }

    await this.verifyStoreOwnership(staff.storeId, user);

    await this.repo.deleteStaff(staffId);
    return { success: true, message: 'Xóa nhân viên khỏi cửa hàng thành công' };
  }
}
