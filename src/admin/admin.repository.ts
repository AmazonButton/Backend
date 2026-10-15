import { Injectable, Inject } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

const SAFE_USER_SELECT = {
  userId: true,
  username: true,
  email: true,
  fullName: true,
  phone: true,
  status: true,
};

@Injectable()
export class AdminRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async findPendingStores() {
    return this.prisma.store.findMany({
      where: { status: 'INACTIVE' },
      include: {
        owner: { select: SAFE_USER_SELECT },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findAllStores() {
    return this.prisma.store.findMany({
      orderBy: { name: 'asc' },
      include: {
        owner: { select: SAFE_USER_SELECT },
        _count: { select: { iotButtons: true, products: true, orders: true } },
      },
    });
  }

  async findStoreById(storeId: bigint) {
    return this.prisma.store.findUnique({
      where: { storeId },
      include: {
        owner: { select: SAFE_USER_SELECT },
      },
    });
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
        include: {
          changedByUser: { select: SAFE_USER_SELECT },
          order: true,
        },
      }),
      this.prisma.productPriceHistory.findMany({
        take: 50,
        orderBy: { changedAt: 'desc' },
        include: {
          changedByUser: { select: SAFE_USER_SELECT },
          product: true,
        },
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
    return this.prisma.user.findUnique({
      where: { userId },
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
    });
  }

  async updateUserStatus(userId: bigint, status: string) {
    return this.prisma.user.update({
      where: { userId },
      data: { status },
      select: SAFE_USER_SELECT,
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
        approvedByUser: { select: SAFE_USER_SELECT },
      },
      orderBy: { requestedAt: 'desc' },
    });
  }

  async findWithdrawalById(withdrawalId: bigint) {
    return this.prisma.storeWithdrawal.findUnique({
      where: { withdrawalId },
      include: {
        wallet: true,
        approvedByUser: { select: SAFE_USER_SELECT },
      },
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

  async claimPendingWithdrawal(withdrawalId: bigint): Promise<boolean> {
    const count = await this.prisma.$executeRaw`
      UPDATE store_withdrawals 
      SET status = 'PROCESSING', updated_at = NOW() 
      WHERE withdrawal_id = ${withdrawalId} AND status = 'PENDING'
    `;
    return count > 0;
  }

  async refundFailedWithdrawalTransaction(withdrawalId: bigint, reason: string): Promise<any> {
    return this.prisma.$transaction(async (tx) => {
      // 1. Lock withdrawal row exclusively
      const [lockedWithdrawal] = await tx.$queryRaw<Array<{
        withdrawal_id: bigint;
        status: string;
        amount: any;
        wallet_id: bigint;
        withdrawal_code: string;
      }>>`
        SELECT withdrawal_id, status, amount, wallet_id, withdrawal_code
        FROM store_withdrawals
        WHERE withdrawal_id = ${withdrawalId}
        FOR UPDATE
      `;

      if (!lockedWithdrawal) return null;

      // 2. Strict status check: only refund if status is PENDING or PROCESSING (prevent redundant refund on FAILED/SUCCEEDED/REJECTED)
      if (!['PENDING', 'PROCESSING'].includes(lockedWithdrawal.status)) {
        return tx.storeWithdrawal.findUnique({ where: { withdrawalId } });
      }

      // 3. Anti-double refund: check if WITHDRAWAL_REFUND ledger tx already recorded
      const existingRefundTx = await tx.walletTransaction.findFirst({
        where: {
          walletId: lockedWithdrawal.wallet_id,
          type: 'WITHDRAWAL_REFUND',
          referenceId: lockedWithdrawal.withdrawal_code,
        },
      });

      if (existingRefundTx) {
        return tx.storeWithdrawal.findUnique({ where: { withdrawalId } });
      }

      // Lock wallet row
      const [wallet] = await tx.$queryRaw<Array<{ wallet_id: bigint; balance: any }>>`
        SELECT wallet_id, balance FROM store_wallets WHERE wallet_id = ${lockedWithdrawal.wallet_id} FOR UPDATE
      `;

      if (!wallet) return null;

      const refundAmount = Number(lockedWithdrawal.amount);
      const balanceBefore = Number(wallet.balance);
      const balanceAfter = balanceBefore + refundAmount;

      await tx.storeWallet.update({
        where: { walletId: wallet.wallet_id },
        data: { balance: balanceAfter },
      });

      await tx.walletTransaction.create({
        data: {
          walletId: wallet.wallet_id,
          amount: refundAmount,
          type: 'WITHDRAWAL_REFUND',
          balanceBefore,
          balanceAfter,
          referenceId: lockedWithdrawal.withdrawal_code,
          description: `Hoàn tiền PayOS Payout thất bại #${lockedWithdrawal.withdrawal_code}: ${reason}`,
        },
      });

      return tx.storeWithdrawal.update({
        where: { withdrawalId },
        data: {
          status: 'FAILED',
          failureReason: reason,
          processedAt: new Date(),
        },
      });
    });
  }

}
