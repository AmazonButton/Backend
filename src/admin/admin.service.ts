import { Injectable, NotFoundException, BadRequestException, Inject, Optional } from '@nestjs/common';
import { PayOSPayoutService } from '../payments/payos-payout.service';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AdminService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Optional() @Inject(PayOSPayoutService) private readonly payosPayoutService?: PayOSPayoutService,
  ) {}

  async listPendingStores() {
    return this.prisma.store.findMany({
      where: { status: 'INACTIVE' },
      include: { owner: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async listAllStores() {
    return this.prisma.store.findMany({
      orderBy: { name: 'asc' },
      include: {
        owner: true,
        _count: { select: { iotButtons: true, products: true, orders: true } },
      },
    });
  }

  async approveStore(storeId: string | number | bigint, adminUser: any) {
    const targetStoreId = BigInt(storeId);
    const store = await this.prisma.store.findUnique({ where: { storeId: targetStoreId } });
    if (!store) throw new NotFoundException('Không tìm thấy cửa hàng');

    return this.prisma.$transaction(async (tx) => {
      const s = await tx.store.update({
        where: { storeId: targetStoreId },
        data: {
          status: 'ACTIVE',
        },
      });

      await tx.user.update({
        where: { userId: store.ownerUserId },
        data: { status: 'ACTIVE' },
      });

      return s;
    });
  }

  async rejectStore(storeId: string | number | bigint, reason: string, adminUser: any) {
    if (!reason) throw new BadRequestException('Bắt buộc phải nhập lý do từ chối');
    const targetStoreId = BigInt(storeId);

    return this.prisma.store.update({
      where: { storeId: targetStoreId },
      data: {
        status: 'SUSPENDED',
      },
    });
  }

  async getSystemStats() {
    const [totalStores, totalUsers, totalButtons, totalOrders, stores, orders] =
      await Promise.all([
        this.prisma.store.count(),
        this.prisma.user.count(),
        this.prisma.ioTButton.count(),
        this.prisma.order.count(),
        this.prisma.store.findMany({ select: { status: true } }),
        this.prisma.order.findMany({ select: { totalAmount: true, orderStatus: true } }),
      ]);

    const totalRevenue = orders
      .filter((o) => o.orderStatus !== 'CANCELLED' && o.orderStatus !== 'REJECTED')
      .reduce((sum, o) => sum + Number(o.totalAmount), 0);

    const activeButtons = await this.prisma.ioTButton.count({ where: { status: 'ACTIVE' } });
    const activeStores = stores.filter((s) => s.status === 'ACTIVE').length;

    return {
      totalStores,
      activeStores,
      totalUsers,
      totalButtons,
      activeButtons,
      totalOrders,
      totalRevenue,
    };
  }

  async listAuditLogs() {
    const [statusLogs, priceLogs] = await Promise.all([
      this.prisma.orderStatusHistory.findMany({
        take: 50,
        orderBy: { changedAt: 'desc' },
        include: { changedByUser: true, order: true },
      }),
      this.prisma.productPriceHistory.findMany({
        take: 50,
        orderBy: { changedAt: 'desc' },
        include: { changedByUser: true, product: true },
      }),
    ]);

    const formattedLogs = [
      ...statusLogs.map((sl) => ({
        id: sl.historyId.toString(),
        type: 'ORDER_STATUS_CHANGE',
        description: `Đơn ${sl.order.orderCode}: ${sl.oldStatus || 'NONE'} -> ${sl.newStatus}`,
        timestamp: sl.changedAt,
        user: sl.changedByUser?.fullName || 'Hệ thống',
      })),
      ...priceLogs.map((pl) => ({
        id: pl.historyId.toString(),
        type: 'PRICE_CHANGE',
        description: `Sản phẩm ${pl.product.productName}: ${pl.oldPrice} -> ${pl.newPrice}`,
        timestamp: pl.changedAt,
        user: pl.changedByUser?.fullName || 'Quản lý',
      })),
    ].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    return formattedLogs;
  }

  async listUsers() {
    return this.prisma.user.findMany({
      select: {
        userId: true,
        email: true,
        username: true,
        fullName: true,
        phone: true,
        status: true,
        createdAt: true,
        customerProfile: true,
        ownedStores: { select: { name: true, code: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async toggleUserStatus(userId: string | number | bigint) {
    const targetUserId = BigInt(userId);
    const user = await this.prisma.user.findUnique({ where: { userId: targetUserId } });
    if (!user) throw new NotFoundException('Không tìm thấy tài khoản');

    const newStatus = user.status === 'ACTIVE' ? 'BLOCKED' : 'ACTIVE';
    return this.prisma.user.update({
      where: { userId: targetUserId },
      data: { status: newStatus },
    });
  }

  async updateUserRole(userId: string | number | bigint, roleCode: string) {
    const targetUserId = BigInt(userId);
    const user = await this.prisma.user.findUnique({ where: { userId: targetUserId } });
    if (!user) throw new NotFoundException('Không tìm thấy tài khoản');

    let role = await this.prisma.role.findUnique({ where: { roleCode } });
    if (!role) {
      role = await this.prisma.role.create({
        data: {
          roleCode,
          roleName: roleCode,
          description: `Vai trò ${roleCode}`,
        },
      });
    }

    const staff = await this.prisma.storeStaff.findFirst({ where: { userId: targetUserId } });
    if (staff) {
      await this.prisma.storeStaff.update({
        where: { storeStaffId: staff.storeStaffId },
        data: { roleId: role.roleId },
      });
    }

    return {
      success: true,
      message: `Đã cập nhật vai trò cho người dùng ${user.username} thành ${roleCode}`,
    };
  }

  // ==========================================
  // SUBSCRIPTION PLANS (MARKETPLACE SAAS)
  // ==========================================
  async createSubscriptionPlan(dto: {
    planCode: string;
    planName: string;
    description?: string;
    price: number | string;
    durationDays: number;
    maxProducts?: number;
  }) {
    const existing = await this.prisma.subscriptionPlan.findUnique({
      where: { planCode: dto.planCode },
    });
    if (existing) {
      throw new BadRequestException(`Gói cước có mã ${dto.planCode} đã tồn tại`);
    }

    return this.prisma.subscriptionPlan.create({
      data: {
        planCode: dto.planCode,
        planName: dto.planName,
        description: dto.description,
        price: dto.price,
        durationDays: dto.durationDays,
        maxProducts: dto.maxProducts || 50,
      },
    });
  }

  async listSubscriptionPlans() {
    return this.prisma.subscriptionPlan.findMany({
      orderBy: { price: 'asc' },
    });
  }

  async updateSubscriptionPlan(id: string | number | bigint, dto: any) {
    const planId = BigInt(id);
    const existing = await this.prisma.subscriptionPlan.findUnique({ where: { planId } });
    if (!existing) throw new NotFoundException('Không tìm thấy gói cước');

    return this.prisma.subscriptionPlan.update({
      where: { planId },
      data: {
        ...(dto.planName && { planName: dto.planName }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.price !== undefined && { price: dto.price }),
        ...(dto.durationDays !== undefined && { durationDays: dto.durationDays }),
        ...(dto.maxProducts !== undefined && { maxProducts: dto.maxProducts }),
        ...(dto.isActive !== undefined && { isActive: dto.isActive }),
      },
    });
  }

  // ==========================================
  // RENTAL PACKAGES (CUSTOMER IOT BUTTONS)
  // ==========================================
  async createRentalPackage(dto: {
    packageCode: string;
    packageName: string;
    description?: string;
    buttonQuantity: number;
    monthlyPrice: number | string;
    depositFee?: number | string;
  }) {
    const existing = await this.prisma.rentalPackage.findUnique({
      where: { packageCode: dto.packageCode },
    });
    if (existing) {
      throw new BadRequestException(`Gói thuê nút có mã ${dto.packageCode} đã tồn tại`);
    }

    return this.prisma.rentalPackage.create({
      data: {
        packageCode: dto.packageCode,
        packageName: dto.packageName,
        description: dto.description,
        buttonQuantity: dto.buttonQuantity,
        monthlyPrice: dto.monthlyPrice,
        depositFee: dto.depositFee || 0,
      },
    });
  }

  async listRentalPackages() {
    return this.prisma.rentalPackage.findMany({
      orderBy: { monthlyPrice: 'asc' },
    });
  }

  async updateRentalPackage(id: string | number | bigint, dto: any) {
    const packageId = BigInt(id);
    const existing = await this.prisma.rentalPackage.findUnique({ where: { packageId } });
    if (!existing) throw new NotFoundException('Không tìm thấy gói thuê nút');

    return this.prisma.rentalPackage.update({
      where: { packageId },
      data: {
        ...(dto.packageName && { packageName: dto.packageName }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.buttonQuantity !== undefined && { buttonQuantity: dto.buttonQuantity }),
        ...(dto.monthlyPrice !== undefined && { monthlyPrice: dto.monthlyPrice }),
        ...(dto.depositFee !== undefined && { depositFee: dto.depositFee }),
        ...(dto.isActive !== undefined && { isActive: dto.isActive }),
      },
    });
  }

  // ==========================================
  // STORE WITHDRAWAL AUDIT & APPROVAL
  // ==========================================
  async listAllWithdrawals(status?: string) {
    return this.prisma.storeWithdrawal.findMany({
      where: status ? { status } : undefined,
      include: {
        wallet: {
          include: {
            store: { select: { storeId: true, name: true, code: true, phone: true } },
          },
        },
        approvedByUser: { select: { fullName: true, email: true } },
      },
      orderBy: { requestedAt: 'desc' },
    });
  }

  async confirmWithdrawalTransfer(
    withdrawalId: string | number | bigint,
    transferEvidenceUrl?: string,
    adminUser?: any
  ) {
    const rawWithdrawalId = BigInt(withdrawalId);
    const withdrawal = await this.prisma.storeWithdrawal.findUnique({
      where: { withdrawalId: rawWithdrawalId },
    });
    if (!withdrawal) throw new NotFoundException('Yêu cầu rút tiền không tồn tại');
    if (withdrawal.status !== 'PENDING') {
      throw new BadRequestException(`Yêu cầu đang ở trạng thái ${withdrawal.status}, không thể duyệt`);
    }

    return this.prisma.storeWithdrawal.update({
      where: { withdrawalId: rawWithdrawalId },
      data: {
        status: 'TRANSFERRED',
        transferEvidenceUrl: transferEvidenceUrl || null,
        approvedByUserId: adminUser?.userId ? BigInt(adminUser.userId) : null,
        processedAt: new Date(),
      },
    });
  }

  async rejectWithdrawal(
    withdrawalId: string | number | bigint,
    reason: string,
    adminUser?: any
  ) {
    const rawWithdrawalId = BigInt(withdrawalId);
    if (!reason?.trim()) {
      throw new BadRequestException('Vui lòng nhập lý do từ chối yêu cầu rút tiền');
    }

    const withdrawal = await this.prisma.storeWithdrawal.findUnique({
      where: { withdrawalId: rawWithdrawalId },
    });
    if (!withdrawal) throw new NotFoundException('Yêu cầu rút tiền không tồn tại');
    if (withdrawal.status !== 'PENDING') {
      throw new BadRequestException(`Yêu cầu đang ở trạng thái ${withdrawal.status}, không thể từ chối`);
    }

    return this.prisma.$transaction(async (tx) => {
      const wallet = await tx.storeWallet.findUnique({
        where: { walletId: withdrawal.walletId },
      });
      if (!wallet) throw new NotFoundException('Ví không tồn tại');

      const refundAmount = Number(withdrawal.amount);
      const balanceBefore = Number(wallet.balance);
      const balanceAfter = balanceBefore + refundAmount;

      await tx.storeWallet.update({
        where: { walletId: wallet.walletId },
        data: { balance: balanceAfter },
      });

      await tx.walletTransaction.create({
        data: {
          walletId: wallet.walletId,
          amount: refundAmount,
          type: 'REFUND',
          balanceBefore,
          balanceAfter,
          referenceId: withdrawal.withdrawalCode,
          description: `Hoàn tiền yêu cầu rút #${withdrawal.withdrawalCode} bị từ chối: ${reason}`,
        },
      });

      return tx.storeWithdrawal.update({
        where: { withdrawalId: rawWithdrawalId },
        data: {
          status: 'REJECTED',
          rejectionReason: reason,
          approvedByUserId: adminUser?.userId ? BigInt(adminUser.userId) : null,
          processedAt: new Date(),
        },
      });
    });
  }
  // ==========================================
  // PAYOS PAYOUT AUTOMATION & RECONCILIATION
  // ==========================================
  async getPayosPayoutBalance() {
    if (!this.payosPayoutService) {
      throw new BadRequestException('PayOS Payout service chua du?c k�ch ho?t');
    }
    return this.payosPayoutService.getPayoutBalance();
  }

  async payoutViaPayOS(withdrawalId: string | number | bigint, adminUser?: any) {
    const rawWithdrawalId = BigInt(withdrawalId);
    const withdrawal = await this.prisma.storeWithdrawal.findUnique({
      where: { withdrawalId: rawWithdrawalId },
    });
    if (!withdrawal) throw new NotFoundException('Y�u c?u r�t ti?n kh�ng t?n t?i');
    if (withdrawal.status !== 'PENDING') {
      throw new BadRequestException(`Y�u c?u dang ? tr?ng th�i ${withdrawal.status}, kh�ng th? th?c hi?n Payout`);
    }

    if (!this.payosPayoutService) {
      throw new BadRequestException('PayOS Payout service chua du?c k�ch ho?t');
    }

    const payout = await this.payosPayoutService.createPayout({
      referenceId: withdrawal.withdrawalCode,
      amount: Number(withdrawal.netAmount || withdrawal.amount),
      description: `Rut tien ${withdrawal.withdrawalCode}`.slice(0, 25),
      toBin: withdrawal.bankCode || '970422',
      toAccountNumber: withdrawal.bankAccountNumber,
      category: ['withdrawal'],
    });

    return this.prisma.storeWithdrawal.update({
      where: { withdrawalId: rawWithdrawalId },
      data: {
        status: 'PROCESSING',
        providerPayoutId: payout.data?.id,
        approvedByUserId: adminUser?.userId ? BigInt(adminUser.userId) : null,
      },
    });
  }

  async syncPayoutStatus(withdrawalId: string | number | bigint) {
    const rawWithdrawalId = BigInt(withdrawalId);
    const withdrawal = await this.prisma.storeWithdrawal.findUnique({
      where: { withdrawalId: rawWithdrawalId },
    });
    if (!withdrawal) throw new NotFoundException('Y�u c?u r�t ti?n kh�ng t?n t?i');
    if (withdrawal.status !== 'PROCESSING') {
      return withdrawal;
    }

    if (!this.payosPayoutService) {
      return withdrawal;
    }

    const payoutInfo = await this.payosPayoutService.getPayout(
      withdrawal.providerPayoutId || withdrawal.withdrawalCode,
    );
    const approvalState = payoutInfo?.data?.approvalState;
    const txState = payoutInfo?.data?.transactions?.[0]?.state;

    if (approvalState === 'SUCCEEDED' || txState === 'SUCCEEDED' || approvalState === 'COMPLETED') {
      return this.prisma.storeWithdrawal.update({
        where: { withdrawalId: rawWithdrawalId },
        data: {
          status: 'SUCCEEDED',
          processedAt: new Date(),
        },
      });
    }

    if (approvalState === 'FAILED' || txState === 'FAILED' || approvalState === 'REJECTED') {
      return this.rejectWithdrawal(rawWithdrawalId, 'PayOS Payout x�c nh?n th?t b?i');
    }

    return withdrawal;
  }
}
