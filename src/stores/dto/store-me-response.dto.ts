export class StoreMeResponseDto {
  storeId: string;
  name: string;
  code: string;
  email: string | null;
  phone: string;
  address: string;
  logoUrl: string | null;
  latitude: number | null;
  longitude: number | null;
  status: string;
  commissionRate: number;
  productCount: number;
  owner: {
    userId: string;
    fullName: string;
    email: string;
    phone: string | null;
    avatarUrl: string | null;
  };
  subscription: {
    planName: string;
    status: string;
    startDate: Date;
    endDate: Date;
  } | null;
  bankVerification: {
    status: string;
    isVerified: boolean;
  };
  wallet: {
    balance: number;
    lockedBalance: number;
  } | null;
  createdAt: Date;
  updatedAt: Date;

  static fromEntity(store: any, userRole?: string): StoreMeResponseDto {
    const activeSub = store.subscriptions?.[0] || null;
    const isVerifiedStatus = (s?: string) => s === 'OWNERSHIP_VERIFIED' || s === 'VERIFIED';
    const verifiedBank =
      store.bankAccounts?.find((b: any) => isVerifiedStatus(b.verificationStatus) && b.isDefault) ||
      store.bankAccounts?.find((b: any) => isVerifiedStatus(b.verificationStatus)) ||
      store.bankAccounts?.[0] ||
      null;
    const canViewFinancials = !userRole || ['STORE_OWNER', 'STORE_MANAGER', 'SUPER_ADMIN', 'SYSTEM_ADMIN'].includes(userRole);

    return {
      storeId: store.storeId.toString(),
      name: store.name,
      code: store.code,
      email: store.email || null,
      phone: store.phone,
      address: store.address,
      logoUrl: store.logoUrl || null,
      latitude: store.latitude != null ? Number(store.latitude) : null,
      longitude: store.longitude != null ? Number(store.longitude) : null,
      status: store.status,
      commissionRate: store.commissionRate ? Number(store.commissionRate) : 8.0,
      productCount: store._count?.products ?? (store.products?.length || 0),
      owner: {
        userId: store.owner?.userId?.toString() || store.ownerUserId.toString(),
        fullName: store.owner?.fullName || '',
        email: store.owner?.email || '',
        phone: store.owner?.phone || null,
        avatarUrl: store.owner?.avatarUrl || null,
      },
      subscription: activeSub
        ? {
            planName: activeSub.plan?.name || 'Standard Plan',
            status: activeSub.status,
            startDate: activeSub.startDate,
            endDate: activeSub.endDate,
          }
        : null,
      bankVerification: {
        status: verifiedBank?.verificationStatus || 'UNVERIFIED',
        isVerified: isVerifiedStatus(verifiedBank?.verificationStatus),
      },
      wallet: canViewFinancials && store.wallet
        ? {
            balance: Number(store.wallet.balance || 0),
            lockedBalance: Number(store.wallet.frozenBalance ?? 0),
          }
        : null,
      createdAt: store.createdAt,
      updatedAt: store.updatedAt,
    };
  }
}
