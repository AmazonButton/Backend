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
  createdAt: Date;
  updatedAt: Date;

  static fromEntity(r: any): RentalResponseDto {
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
