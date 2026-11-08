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

  static maskEmail(email: string | null): string | null {
    if (!email) return null;
    const parts = email.split('@');
    if (parts.length !== 2) return email;
    const [name, domain] = parts;
    const maskedName = name.length <= 2 ? `${name[0]}*` : `${name.slice(0, 2)}***${name.slice(-1)}`;
    return `${maskedName}@${domain}`;
  }

  static maskPhone(phone: string | null): string | null {
    if (!phone) return null;
    const clean = phone.trim();
    if (clean.length < 6) return '***';
    return `${clean.slice(0, 3)}****${clean.slice(-3)}`;
  }

  static fromEntity(staff: any): StoreStaffResponseDto {
    return {
      storeStaffId: staff.storeStaffId.toString(),
      storeId: staff.storeId.toString(),
      userId: staff.userId.toString(),
      fullName: staff.user?.fullName || '',
      username: staff.user?.username || '',
      email: StoreStaffResponseDto.maskEmail(staff.user?.email || null),
      phone: StoreStaffResponseDto.maskPhone(staff.user?.phone || null),
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
