import { Injectable, Inject } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AdminRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async findPendingStores() {
    return this.prisma.store.findMany({
      where: { status: 'INACTIVE' },
      include: { owner: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findAllStores() {
    return this.prisma.store.findMany({
      orderBy: { name: 'asc' },
      include: {
        owner: true,
        _count: { select: { iotButtons: true, products: true, orders: true } },
      },
    });
  }

  async findStoreById(storeId: bigint) {
    return this.prisma.store.findUnique({ where: { storeId } });
  }

  async approveStore(storeId: bigint, ownerUserId: bigint) {
    return this.prisma.$transaction(async (tx) => {
      const s = await tx.store.update({
        where: { storeId },
        data: { status: 'ACTIVE' },
      });
      await tx.user.update({
        where: { userId: ownerUserId },
        data: { status: 'ACTIVE' },
      });
      return s;
    });
  }

  async rejectStore(storeId: bigint) {
    return this.prisma.store.update({
      where: { storeId },
      data: { status: 'SUSPENDED' },
    });
  }

  async getCounts() {
    const [totalStores, totalUsers, totalButtons, totalOrders, stores, orders, activeButtons] =
      await Promise.all([
        this.prisma.store.count(),
        this.prisma.user.count(),
        this.prisma.ioTButton.count(),
        this.prisma.order.count(),
        this.prisma.store.findMany({ select: { status: true } }),
        this.prisma.order.findMany({ select: { totalAmount: true, orderStatus: true } }),
        this.prisma.ioTButton.count({ where: { status: 'ACTIVE' } }),
      ]);

    return { totalStores, totalUsers, totalButtons, totalOrders, stores, orders, activeButtons };
  }

  async findAuditLogs() {
    return Promise.all([
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
  }

  async findUsers() {
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

  async findUserById(userId: bigint) {
    return this.prisma.user.findUnique({ where: { userId } });
  }

  async updateUserStatus(userId: bigint, status: string) {
    return this.prisma.user.update({
      where: { userId },
      data: { status },
    });
  }

  async findOrCreateRole(roleCode: string) {
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
    return role;
  }

  async updateStaffRole(userId: bigint, roleId: bigint) {
    const staff = await this.prisma.storeStaff.findFirst({ where: { userId } });
    if (staff) {
      await this.prisma.storeStaff.update({
        where: { storeStaffId: staff.storeStaffId },
        data: { roleId },
      });
    }
  }

  async findSubscriptionPlanByCode(planCode: string) {
    return this.prisma.subscriptionPlan.findUnique({ where: { planCode } });
  }

  async createSubscriptionPlan(data: any) {
    return this.prisma.subscriptionPlan.create({ data });
  }

  async findAllSubscriptionPlans() {
    return this.prisma.subscriptionPlan.findMany({ orderBy: { price: 'asc' } });
  }

  async findSubscriptionPlanById(planId: bigint) {
    return this.prisma.subscriptionPlan.findUnique({ where: { planId } });
  }

  async updateSubscriptionPlan(planId: bigint, data: any) {
    return this.prisma.subscriptionPlan.update({ where: { planId }, data });
  }

  async findRentalPackageByCode(packageCode: string) {
    return this.prisma.rentalPackage.findUnique({ where: { packageCode } });
  }

  async createRentalPackage(data: any) {
    const depositFee = data.depositFee ?? data.depositAmount ?? 0;
    const isActive = data.isActive ?? (data.status === 'ACTIVE' || data.status === undefined);
    return this.prisma.rentalPackage.create({
      data: {
        packageCode: data.packageCode,
        packageName: data.packageName,
        description: data.description,
        buttonQuantity: data.buttonQuantity ?? 1,
        monthlyPrice: data.monthlyPrice,
        depositFee,
        isActive,
      },
    });
  }

  async findAllRentalPackages() {
    return this.prisma.rentalPackage.findMany({ orderBy: { monthlyPrice: 'asc' } });
  }

  async findRentalPackageById(packageId: bigint) {
    return this.prisma.rentalPackage.findUnique({ where: { packageId } });
  }

  async updateRentalPackage(packageId: bigint, data: any) {
    return this.prisma.rentalPackage.update({ where: { packageId }, data });
  }

  async findWithdrawals() {
    return this.prisma.storeWithdrawal.findMany({
      include: {
        wallet: { include: { store: true } },
        approvedByUser: true,
      },
      orderBy: { requestedAt: 'desc' },
    });
  }

  async findWithdrawalById(withdrawalId: bigint) {
    return this.prisma.storeWithdrawal.findUnique({
      where: { withdrawalId },
      include: { wallet: true },
    });
  }

  async updateWithdrawal(withdrawalId: bigint, data: any) {
    return this.prisma.storeWithdrawal.update({ where: { withdrawalId }, data });
  }

  async rejectWithdrawalTransaction(withdrawal: any, reason: string, adminUserId?: bigint) {
    return this.prisma.$transaction(async (tx) => {
      const wallet = await tx.storeWallet.findUnique({
        where: { walletId: withdrawal.walletId },
      });
      if (!wallet) throw new Error('Ví không tồn tại');

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
        where: { withdrawalId: withdrawal.withdrawalId },
        data: {
          status: 'REJECTED',
          rejectionReason: reason,
          approvedByUserId: adminUserId || null,
          processedAt: new Date(),
        },
      });
    });
  }
}
