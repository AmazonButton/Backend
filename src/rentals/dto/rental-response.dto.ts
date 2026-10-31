export class RentalResponseDto {
  rentalId: string;
  rentalCode: string;
  customerId: string;
  customer: {
    customerId: string;
    fullName: string;
    phone: string | null;
    email: string | null;
  } | null;
  packageId: string;
  package: {
    packageId: string;
    packageName: string;
    monthlyPrice: number;
    depositFee: number;
    buttonQuantity: number;
  } | null;
  monthsRented: number;
  totalRentAmount: number;
  depositAmount: number;
  startDate: Date;
  endDate: Date;
  status: string;
  payments: Array<{
    paymentTransactionId: string;
    amount: number;
    status: string;
    checkoutUrl: string | null;
    qrCode: string | null;
    paidAt: Date | null;
    createdAt: Date;
  }>;
  buttons: Array<{
    buttonId: string;
    buttonCode: string;
    name: string;
    status: string;
  }>;
  effectiveExpiresAt?: Date | null;
  paidThrough?: Date | null;
  remainingSeconds: number;
  canOrder: boolean;
  serverNow: string;
  createdAt: Date;
  updatedAt: Date;

  static fromEntity(r: any): RentalResponseDto {
    const now = new Date();
    const effectiveExpiry = r.effectiveExpiresAt || r.paidThrough || r.endDate;
    let remainingSeconds = 0;
    let canOrder = true;
    if (effectiveExpiry) {
      const expiryTime = new Date(effectiveExpiry).getTime();
      remainingSeconds = Math.max(0, Math.floor((expiryTime - now.getTime()) / 1000));
      canOrder = remainingSeconds > 0 && r.status !== 'EXPIRED' && r.status !== 'RETURNED';
    }

    return {
      rentalId: r.rentalId.toString(),
      rentalCode: r.rentalCode,
      customerId: r.customerId.toString(),
      customer: r.customer
        ? {
            customerId: r.customer.customerId?.toString() || r.customerId.toString(),
            fullName: r.customer.user?.fullName || '',
            phone: r.customer.phone || r.customer.user?.phone || null,
            email: r.customer.user?.email || null,
          }
        : null,
      packageId: r.packageId.toString(),
      package: r.package
        ? {
            packageId: r.package.packageId.toString(),
            packageName: r.package.packageName,
            monthlyPrice: Number(r.package.monthlyPrice || 0),
            depositFee: Number(r.package.depositFee || 0),
            buttonQuantity: r.package.buttonQuantity,
          }
        : null,
      monthsRented: r.monthsRented,
      totalRentAmount: Number(r.totalRentAmount || 0),
      depositAmount: Number(r.depositAmount || 0),
      startDate: r.startDate,
      endDate: r.endDate,
      effectiveExpiresAt: r.effectiveExpiresAt || r.endDate || null,
      paidThrough: r.paidThrough || r.endDate || null,
      remainingSeconds,
      canOrder,
      serverNow: now.toISOString(),
      status: r.status,
      payments: (r.payments || []).map((p: any) => ({
        paymentTransactionId: p.paymentTransactionId.toString(),
        amount: Number(p.amount || 0),
        status: p.status,
        checkoutUrl: p.checkoutUrl || null,
        qrCode: p.qrCode || null,
        paidAt: p.paidAt || null,
        createdAt: p.createdAt,
      })),
      buttons: (r.buttons || []).map((b: any) => ({
        buttonId: b.buttonId.toString(),
        buttonCode: b.buttonCode,
        name: b.name,
        status: b.status,
      })),
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }
}
