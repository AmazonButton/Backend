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

export const ALLOWED_STORE_STAFF_ROLES = [] as const;

export const STORE_STAFF_DEPRECATED_ERROR = {
  success: false,
  code: 'STORE_STAFF_ROLE_DEPRECATED',
  message:
    'Mô hình nhân viên cửa hàng và shipper riêng của store đã ngừng áp dụng. Chủ cửa hàng tự quản lý bán hàng/giao hàng/POD và nền tảng sử dụng SYSTEM_STAFF cho thiết bị/bảo hành.',
};

export const ROLE_METADATA: Record<
  string,
  { name: string; description: string }
> = {};

@Injectable()
export class StoreStaffService {
  constructor(private readonly repo: StoreStaffRepository) { }

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
    return [];
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

  async addStaff(_storeIdStr: string, _dto: CreateStoreStaffDto, _user: any): Promise<StoreStaffResponseDto> {
    throw new ForbiddenException(STORE_STAFF_DEPRECATED_ERROR);
  }

  async acceptInvitation(_staffIdStr: string, _user: any): Promise<StoreStaffResponseDto> {
    throw new ForbiddenException(STORE_STAFF_DEPRECATED_ERROR);
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
      throw new ForbiddenException(STORE_STAFF_DEPRECATED_ERROR);
    }

    if (dto.status) {
      const canonicalStatus = dto.status === 'INACTIVE' ? 'TERMINATED' : dto.status;

      if (canonicalStatus === 'ACTIVE') {
        throw new ForbiddenException(STORE_STAFF_DEPRECATED_ERROR);
      }

      // Allowlist chuyển trạng thái còn lại: chỉ hỗ trợ chấm dứt/tạm ngừng thành viên store_staff cũ.
      const allowedTransitions: Record<string, string[]> = {
        PENDING: ['TERMINATED'],
        ACTIVE: ['ON_LEAVE', 'TERMINATED'],
        ON_LEAVE: ['ON_LEAVE', 'TERMINATED'],
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

    const rawActorId = user?.userId ?? user?.id;
    const actorUserId = rawActorId != null ? BigInt(rawActorId) : null;
    const terminated = await this.repo.deleteStaff(staffId, actorUserId);
    return {
      success: true,
      message: 'Đã chấm dứt nhân viên cửa hàng và bảo toàn lịch sử',
      data: terminated ? StoreStaffResponseDto.fromEntity(terminated) : null,
    };
  }
}
