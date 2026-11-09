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

    const userPlatformRoles = await this.repo.findUserActivePlatformRoles(targetUser.userId);
    const superAdminEmails = (process.env.SUPER_ADMIN_EMAILS || 'admin@smartorder.local')
      .split(',')
      .map((e) => e.trim().toLowerCase());

    const isPlatformAdmin =
      userPlatformRoles.some((r) => ['SUPER_ADMIN', 'SYSTEM_ADMIN', 'ADMIN'].includes(r)) ||
      superAdminEmails.includes((targetUser.email || '').toLowerCase()) ||
      targetUser.username === 'admin';

    if (isPlatformAdmin) {
      throw new ForbiddenException('Không thể thêm tài khoản quản trị hệ thống làm nhân viên cửa hàng');
    }

    const ownedStoreCount = await this.repo.countOwnedStores(targetUser.userId);
    if (ownedStoreCount > 0) {
      throw new ConflictException('Không thể thêm người dùng đang là chủ cửa hàng khác làm nhân viên');
    }

    // Check existing staff
    const existing = await this.repo.findStaffByStoreAndUser(storeId, targetUser.userId);
    if (existing) {
      if (existing.status === 'ACTIVE') {
        throw new ConflictException('Người dùng đã là nhân viên đang hoạt động của cửa hàng');
      }
      if (existing.status === 'PENDING') {
        throw new ConflictException('Người dùng đã có lời mời tham gia đang chờ phản hồi');
      }
      // Re-invite staff if previously inactive
      let role = await this.repo.findRoleByCode(dto.roleCode);
      if (!role) {
        throw new NotFoundException(`Vai trò ${dto.roleCode} không tồn tại trong hệ thống`);
      }
      const updated = await this.repo.updateStaff(existing.storeStaffId, {
        roleId: role.roleId,
        status: 'PENDING',
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
      status: 'PENDING',
    });

    return StoreStaffResponseDto.fromEntity(created);
  }

  async acceptInvitation(staffIdStr: string, user: any): Promise<StoreStaffResponseDto> {
    const staffId = BigInt(staffIdStr);
    const staff = await this.repo.findStaffById(staffId);
    if (!staff) {
      throw new NotFoundException('Lời mời làm nhân viên không tồn tại');
    }

    const currentUserId = (user?.userId || user?.id || user?.sub)?.toString();
    if (staff.userId.toString() !== currentUserId) {
      throw new ForbiddenException('BOLA_VIOLATION: Bạn chỉ có thể chấp nhận lời mời gửi cho chính mình');
    }

    if (staff.status !== 'PENDING') {
      throw new ConflictException(
        staff.status === 'ACTIVE'
          ? 'Lời mời này đã được chấp nhận và đang hoạt động'
          : 'Không thể chấp nhận lời mời đã bị từ chối hoặc nhân viên đã bị chấm dứt (TERMINATED/INACTIVE)',
      );
    }

    const updated = await this.repo.acceptInvitationAtomic(staffId, staff.userId);
    if (!updated) {
      throw new ConflictException('Không thể chấp nhận lời mời do trạng thái đã bị thay đổi');
    }

    return StoreStaffResponseDto.fromEntity(updated);
  }

  async rejectInvitation(staffIdStr: string, user: any): Promise<{ success: boolean; message: string }> {
    const staffId = BigInt(staffIdStr);
    const staff = await this.repo.findStaffById(staffId);
    if (!staff) {
      throw new NotFoundException('Lời mời làm nhân viên không tồn tại');
    }

    const currentUserId = (user?.userId || user?.id || user?.sub)?.toString();
    if (staff.userId.toString() !== currentUserId) {
      throw new ForbiddenException('BOLA_VIOLATION: Bạn chỉ có thể từ chối lời mời gửi cho chính mình');
    }

    if (staff.status !== 'PENDING') {
      throw new ConflictException('Chỉ có thể từ chối lời mời đang ở trạng thái chờ phản hồi (PENDING)');
    }

    await this.repo.updateStaff(staffId, {
      status: 'INACTIVE',
      leftAt: new Date(),
    });

    return {
      success: true,
      message: 'Đã từ chối lời mời làm nhân viên cửa hàng',
    };
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

      // Lỗ hổng 1: Chủ cửa hàng không thể tự ý kích hoạt lời mời thay cho nhân viên.
      // Người được mời phải tự gọi acceptInvitation.
      if (staff.status === 'PENDING' && canonicalStatus === 'ACTIVE') {
        throw new ForbiddenException(
          'INVITATION_ACCEPTANCE_REQUIRED: Chủ cửa hàng không thể tự ý kích hoạt lời mời. Người dùng được mời phải tự chấp nhận qua API accept.',
        );
      }

      // Lỗ hổng 2 liên đới: Không thể PATCH trực tiếp nhân viên đã TERMINATED/INACTIVE sang ACTIVE. Phải gửi lời mời mới.
      if ((staff.status === 'TERMINATED' || staff.status === 'INACTIVE') && canonicalStatus === 'ACTIVE') {
        throw new ForbiddenException(
          'REINVITATION_REQUIRED: Không thể kích hoạt trực tiếp nhân viên đã bị chấm dứt (TERMINATED/INACTIVE). Vui lòng gửi lời mời mới.',
        );
      }

      // Allowlist chuyển trạng thái do chủ cửa hàng thực hiện (chặn bypass hai bước PENDING -> ON_LEAVE -> ACTIVE).
      // PENDING chỉ có thể bị hủy; ON_LEAVE chỉ đạt được từ ACTIVE nên không thể dùng để bỏ qua bước accept.
      const allowedTransitions: Record<string, string[]> = {
        PENDING: ['TERMINATED'],
        ACTIVE: ['ACTIVE', 'ON_LEAVE', 'TERMINATED'],
        ON_LEAVE: ['ON_LEAVE', 'ACTIVE', 'TERMINATED'],
        TERMINATED: ['TERMINATED'],
        INACTIVE: ['TERMINATED'],
      };
      if (!allowedTransitions[staff.status]?.includes(canonicalStatus)) {
        throw new ForbiddenException(
          `INVALID_STAFF_STATUS_TRANSITION: Không thể chuyển trạng thái nhân viên từ ${staff.status} sang ${canonicalStatus}`,
        );
      }

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
