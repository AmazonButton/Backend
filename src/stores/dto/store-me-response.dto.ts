export class StoreMeResponseDto {
  storeId: string;
  name: string;
  code: string;
  email: string | null;
  phone: string;
  address: string;
  status: string;
  commissionRate: number;
  productCount: number;
  owner: {
    userId: string;
    fullName: string;
    email: string;
    phone: string | null;
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

  static fromEntity(store: any): StoreMeResponseDto {
    const activeSub = store.subscriptions?.[0] || null;
    const verifiedBank = store.bankAccounts?.find((b: any) => b.verificationStatus === 'VERIFIED') || store.bankAccounts?.[0] || null;

    return {
      storeId: store.storeId.toString(),
      name: store.name,
      code: store.code,
      email: store.email || null,
      phone: store.phone,
      address: store.address,
      status: store.status,
      commissionRate: store.commissionRate ? Number(store.commissionRate) : 8.0,
      productCount: store._count?.products ?? (store.products?.length || 0),
      owner: {
        userId: store.owner?.userId?.toString() || store.ownerUserId.toString(),
        fullName: store.owner?.fullName || '',
        email: store.owner?.email || '',
        phone: store.owner?.phone || null,
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
        isVerified: verifiedBank?.verificationStatus === 'VERIFIED',
      },
      wallet: store.wallet
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
