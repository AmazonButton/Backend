export class StoreStaffResponseDto {
  storeStaffId: string;
  storeId: string;
  userId: string;
  fullName: string;
  username: string;
  email: string | null;
  phone: string | null;
  avatarUrl: string | null;
  role: {
    roleId: string;
    roleCode: string;
    roleName: string;
    description: string | null;
  };
  status: string;
  joinedAt: Date;
  leftAt: Date | null;
  createdAt: Date;
  updatedAt: Date;

  static fromEntity(staff: any): StoreStaffResponseDto {
    return {
      storeStaffId: staff.storeStaffId.toString(),
      storeId: staff.storeId.toString(),
      userId: staff.userId.toString(),
      fullName: staff.user?.fullName || '',
      username: staff.user?.username || '',
      email: staff.user?.email || null,
      phone: staff.user?.phone || null,
      avatarUrl: staff.user?.avatarUrl || null,
      role: {
        roleId: staff.role?.roleId?.toString() || staff.roleId.toString(),
        roleCode: staff.role?.roleCode || '',
        roleName: staff.role?.roleName || staff.role?.roleCode || '',
        description: staff.role?.description || null,
      },
      status: staff.status,
      joinedAt: staff.joinedAt,
      leftAt: staff.leftAt || null,
      createdAt: staff.createdAt,
      updatedAt: staff.updatedAt,
    };
  }
}
