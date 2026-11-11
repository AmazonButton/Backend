export interface RentalReturnSummaryDto {
  returnId: string;
  returnCode: string;
  buttonId: string;
  status: string;
  requestedAt: Date;
  receivedAt: Date | null;
  inspectedAt: Date | null;
  inspectionNote: string | null;
}

export interface DepositRefundSummaryDto {
  refundId: string;
  refundCode: string;
  returnId: string | null;
  amount: number;
  status: string;
  recipientBankBin: string | null;
  recipientBankCode: string | null;
  recipientBankName: string | null;
  recipientAccountNumberMasked: string | null;
  recipientAccountHolderName: string | null;
  refundedAt: Date | null;
  failureReason: string | null;
  createdAt: Date;
}

export interface DepositLedgerBalancesDto {
  collectedAmount: number;
  heldAmount: number;
  reservedAmount: number;
  refundedAmount: number;
}

export interface RefundProgressDto {
  pendingApprovalAmount: number;
  pendingPayoutAmount: number;
  refundedAmount: number;
  totalPendingAmount: number;
}

export interface DepositBreakdownDto {
  depositAmount: number;
  holdingAmount: number;
  pendingRefundAmount: number;
  refundedAmount: number;
  ledgerBalances: DepositLedgerBalancesDto;
  refundProgress: RefundProgressDto;
}

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
    inventoryState: string;
    canOrder: boolean;
  }>;
  returns: RentalReturnSummaryDto[];
  refunds: DepositRefundSummaryDto[];
  depositBreakdown: DepositBreakdownDto;
  fulfillmentStoreId?: string | null;
  effectiveExpiresAt?: Date | null;
  paidThrough?: Date | null;
  monthlyRentPerButtonSnapshot?: number | null;
  pricingReviewRequired?: boolean;
  billingPolicyReviewRequired?: boolean;
  billingPolicy: string;
  remainingSeconds: number;
  canOrder: boolean;
  serverNow: string;
  createdAt: Date;
  updatedAt: Date;

  static fromEntity(r: any): RentalResponseDto {
    const now = new Date();
    const handedOver = !['PENDING_PAYMENT', 'PENDING_HANDOVER', 'CANCELLED'].includes(r.status);
    const effectiveExpiry = handedOver ? r.effectiveExpiresAt : null;
    let remainingSeconds = 0;
    let canOrder = false;
    if (effectiveExpiry) {
      const expiryTime = new Date(effectiveExpiry).getTime();
      remainingSeconds = Math.max(0, Math.floor((expiryTime - now.getTime()) / 1000));
      canOrder = remainingSeconds > 0 && r.status === 'ACTIVE';
    }

    const returns: RentalReturnSummaryDto[] = (r.returns || []).map((ret: any) => ({
      returnId: ret.returnId.toString(),
      returnCode: ret.returnCode,
      buttonId: ret.buttonId.toString(),
      status: ret.status,
      requestedAt: ret.createdAt,
      receivedAt: ret.receivedAt || null,
      inspectedAt: ret.inspectedAt || null,
      inspectionNote: ret.inspectionNote || null,
    }));

    const refunds: DepositRefundSummaryDto[] = (r.refunds || []).map((ref: any) => ({
      refundId: ref.refundId.toString(),
      refundCode: ref.refundCode,
      returnId: ref.returnId ? ref.returnId.toString() : null,
      amount: Number(ref.amount || 0),
      status: ref.status,
      recipientBankBin: ref.recipientBin || ref.bankAccount?.bankBin || null,
      recipientBankCode: ref.bankAccount?.bankCode || null,
      recipientBankName: ref.bankAccount?.bankName || null,
      recipientAccountNumberMasked: ref.recipientAccountNumberMasked || ref.bankAccount?.accountNumberMasked || null,
      recipientAccountHolderName: ref.recipientAccountHolderName || ref.bankAccount?.accountName || null,
      refundedAt: ref.refundedAt || null,
      failureReason: ref.rejectionReason || ref.payoutError || null,
      createdAt: ref.createdAt,
    }));

    // 1. Tiến độ yêu cầu (Request Progress): tách bạch chờ duyệt, chờ chi, đã hoàn
    const pendingApprovalAmount = refunds
      .filter((ref) => ref.status === 'PENDING_APPROVAL')
      .reduce((sum, ref) => sum + ref.amount, 0);
    const pendingPayoutAmount = refunds
      .filter((ref) => ['PENDING_PAYOUT', 'APPROVED', 'PROCESSING'].includes(ref.status))
      .reduce((sum, ref) => sum + ref.amount, 0);
    const refundedProgressAmount = refunds
      .filter((ref) => ['REFUNDED', 'COMPLETED', 'PAID'].includes(ref.status))
      .reduce((sum, ref) => sum + ref.amount, 0);
    const totalPendingAmount = pendingApprovalAmount + pendingPayoutAmount;

    // 2. Số dư kế toán sổ cái (Accounting Ledger Balances): held / reserved / refunded
    const ledgerCollected = Number(r.deposit?.collectedAmount ?? r.depositAmount ?? 0);
    const ledgerHeld = Number(r.deposit?.heldAmount ?? (r.status === 'ACTIVE' ? Math.max(0, ledgerCollected - totalPendingAmount - refundedProgressAmount) : 0));
    const ledgerReserved = Number(r.deposit?.refundReservedAmount ?? pendingPayoutAmount);
    const ledgerRefunded = Number(r.deposit?.refundedAmount ?? refundedProgressAmount);

    const depositBreakdown: DepositBreakdownDto = {
      depositAmount: ledgerCollected,
      holdingAmount: ledgerHeld,
      pendingRefundAmount: totalPendingAmount, // Hiển thị đầy đủ cho client (chờ duyệt + chờ chi)
      refundedAmount: ledgerRefunded,
      ledgerBalances: {
        collectedAmount: ledgerCollected,
        heldAmount: ledgerHeld,
        reservedAmount: ledgerReserved, // Không cộng pending approval vào reserved, giữ nguyên ý nghĩa sổ cái
        refundedAmount: ledgerRefunded,
      },
      refundProgress: {
        pendingApprovalAmount,
        pendingPayoutAmount,
        refundedAmount: refundedProgressAmount,
        totalPendingAmount,
      },
    };

    return {
      rentalId: r.rentalId ? r.rentalId.toString() : '',
      rentalCode: r.rentalCode || '',
      customerId: r.customerId ? r.customerId.toString() : '',
      customer: r.customer
        ? {
            customerId: r.customer.customerId?.toString() || (r.customerId ? r.customerId.toString() : ''),
            fullName: r.customer.user?.fullName || '',
            phone: r.customer.phone || r.customer.user?.phone || null,
            email: r.customer.user?.email || null,
          }
        : null,
      packageId: r.packageId ? r.packageId.toString() : '',
      package: r.package
        ? {
            packageId: r.package.packageId ? r.package.packageId.toString() : '',
            packageName: r.package.packageName || '',
            monthlyPrice: Number(r.package.monthlyPrice || 0),
            depositFee: Number(r.package.depositFee || 0),
            buttonQuantity: Number(r.package.buttonQuantity || 0),
          }
        : null,
      monthsRented: r.monthsRented,
      totalRentAmount: Number(r.totalRentAmount || 0),
      depositAmount: Number(r.depositAmount || 0),
      startDate: r.startDate,
      endDate: r.endDate,
      effectiveExpiresAt: effectiveExpiry || null,
      paidThrough: handedOver ? (r.paidThrough || null) : null,
      monthlyRentPerButtonSnapshot: r.monthlyRentPerButtonSnapshot == null ? null : Number(r.monthlyRentPerButtonSnapshot),
      pricingReviewRequired: r.pricingReviewRequired ?? r.monthlyRentPerButtonSnapshot == null,
      billingPolicyReviewRequired: Boolean(r.billingPolicyReviewRequired),
      billingPolicy: r.billingPolicy || 'STORE_RENT_CUSTOMER_DEPOSIT',
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
        name: b.buttonName || b.name || 'Smart Order Button',
        status: b.status,
        inventoryState: b.inventoryState || 'IN_PLATFORM_WAREHOUSE',
        canOrder: Boolean(b.canOrder ?? (b.status === 'ACTIVE' && b.inventoryState !== 'RETURN_IN_TRANSIT')),
      })),
      returns,
      refunds,
      depositBreakdown,
      fulfillmentStoreId: r.fulfillmentStoreId ? r.fulfillmentStoreId.toString() : null,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }
}
