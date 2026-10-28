import { Injectable, Inject } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@prisma/client';

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
    const [
      totalStores,
      activeStores,
      totalUsers,
      totalButtons,
      activeButtons,
      totalOrders,
      completedOrders,
      gmvAggregate,
    ] =
      await Promise.all([
        this.prisma.store.count(),
        this.prisma.store.count({ where: { status: 'ACTIVE' } }),
        this.prisma.user.count(),
        this.prisma.ioTButton.count(),
        this.prisma.ioTButton.count({ where: { status: 'ACTIVE' } }),
        this.prisma.order.count(),
        this.prisma.order.count({
          where: { orderStatus: { in: ['DELIVERED', 'COMPLETED'] } },
        }),
        this.prisma.order.aggregate({
          where: { orderStatus: { notIn: ['CANCELLED', 'REJECTED'] } },
          _sum: { totalAmount: true },
        }),
      ]);

    return {
      totalStores,
      activeStores,
      totalUsers,
      totalButtons,
      activeButtons,
      totalOrders,
      completedOrders,
      totalGmv: Number(gmvAggregate._sum.totalAmount || 0),
    };
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
      const [wallet] = await tx.$queryRaw<Array<{
        wallet_id: bigint;
        balance: any;
        frozen_balance: any;
      }>>`
        SELECT wallet_id, balance, frozen_balance
        FROM store_wallets
        WHERE wallet_id = ${withdrawal.walletId}
        FOR UPDATE
      `;
      if (!wallet) throw new Error('Ví không tồn tại');

      const refundAmount = Number(withdrawal.amount);
      const balanceBefore = Number(wallet.balance);
      const balanceAfter = balanceBefore + refundAmount;
      const currentFrozen = Number(wallet.frozen_balance || 0);
      const frozenAfter = Math.max(0, currentFrozen - refundAmount);

      await tx.storeWallet.update({
        where: { walletId: wallet.wallet_id },
        data: {
          balance: balanceAfter,
          frozenBalance: frozenAfter,
        },
      });

      await tx.walletTransaction.create({
        data: {
          walletId: wallet.wallet_id,
          amount: refundAmount,
          type: 'WITHDRAWAL_REFUND',
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
      const [wallet] = await tx.$queryRaw<Array<{
        wallet_id: bigint;
        balance: any;
        frozen_balance: any;
      }>>`
        SELECT wallet_id, balance, frozen_balance
        FROM store_wallets
        WHERE wallet_id = ${lockedWithdrawal.wallet_id}
        FOR UPDATE
      `;

      if (!wallet) return null;

      const refundAmount = Number(lockedWithdrawal.amount);
      const balanceBefore = Number(wallet.balance);
      const balanceAfter = balanceBefore + refundAmount;
      const currentFrozen = Number(wallet.frozen_balance || 0);
      const frozenAfter = Math.max(0, currentFrozen - refundAmount);

      await tx.storeWallet.update({
        where: { walletId: wallet.wallet_id },
        data: {
          balance: balanceAfter,
          frozenBalance: frozenAfter,
        },
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

  async getAdminDashboardData(
    dateRange: { fromDate?: Date; toDateExclusive?: Date } = {},
    compareWith?: 'previous-period',
  ) {
    const orderConditions: Prisma.Sql[] = [];
    if (dateRange.fromDate) orderConditions.push(Prisma.sql`o.order_date >= ${dateRange.fromDate}`);
    if (dateRange.toDateExclusive) orderConditions.push(Prisma.sql`o.order_date < ${dateRange.toDateExclusive}`);
    const orderWhere = orderConditions.length ? Prisma.sql`WHERE ${Prisma.join(orderConditions, ' AND ')}` : Prisma.empty;

    const paymentConditions: Prisma.Sql[] = [];
    if (dateRange.fromDate) paymentConditions.push(Prisma.sql`pt.created_at >= ${dateRange.fromDate}`);
    if (dateRange.toDateExclusive) paymentConditions.push(Prisma.sql`pt.created_at < ${dateRange.toDateExclusive}`);
    const paymentWhere = paymentConditions.length ? Prisma.sql`WHERE ${Prisma.join(paymentConditions, ' AND ')}` : Prisma.empty;

    const [
      storeRows,
      userRows,
      orderRows,
      financialRows,
      paymentRows,
      deviceRows,
      rentalRows,
      withdrawalRows,
      verificationRows,
      dlqRows,
    ] = await Promise.all([
      this.prisma.$queryRaw<Array<{ total: number; active: number; pending: number; suspended: number }>>(Prisma.sql`
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE s.status = 'ACTIVE')::int AS active,
          COUNT(*) FILTER (WHERE s.status = 'PENDING')::int AS pending,
          COUNT(*) FILTER (WHERE s.status = 'SUSPENDED')::int AS suspended
        FROM store s
      `),
      this.prisma.$queryRaw<Array<{
        total: number;
        customers: number;
        store_owners: number;
        staff: number;
        admins: number;
        active_users: number;
        suspended_users: number;
      }>>(Prisma.sql`
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM customer_profile cp WHERE cp.user_id = u.user_id))::int AS customers,
          COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM store s WHERE s.owner_user_id = u.user_id))::int AS store_owners,
          COUNT(*) FILTER (WHERE EXISTS (
            SELECT 1 FROM store_staff ss
            INNER JOIN roles r ON r.role_id = ss.role_id
            WHERE ss.user_id = u.user_id AND ss.status = 'ACTIVE'
              AND r.role_code IN ('STAFF_ORDER', 'STAFF_INVENTORY', 'STAFF_BUTTON', 'STAFF_DELIVERY', 'STORE_STAFF')
          ))::int AS staff,
          COUNT(*) FILTER (WHERE EXISTS (
            SELECT 1 FROM store_staff ss
            INNER JOIN roles r ON r.role_id = ss.role_id
            WHERE ss.user_id = u.user_id AND ss.status = 'ACTIVE'
              AND r.role_code IN ('SUPER_ADMIN', 'SYSTEM_ADMIN', 'ADMIN')
          ) OR u.username = 'admin' OR u.email = 'admin@smartorder.local')::int AS admins,
          COUNT(*) FILTER (WHERE u.status = 'ACTIVE')::int AS active_users,
          COUNT(*) FILTER (WHERE u.status IN ('SUSPENDED', 'INACTIVE'))::int AS suspended_users
        FROM users u
      `),
      this.prisma.$queryRaw<Array<{
        total: number;
        pending: number;
        preparing: number;
        delivering: number;
        completed: number;
        cancelled: number;
        rejected: number;
      }>>(Prisma.sql`
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE o.order_status = 'PENDING')::int AS pending,
          COUNT(*) FILTER (WHERE o.order_status = 'PREPARING')::int AS preparing,
          COUNT(*) FILTER (WHERE o.order_status IN ('READY_FOR_DELIVERY', 'SHIPPING'))::int AS delivering,
          COUNT(*) FILTER (WHERE o.order_status IN ('DELIVERED', 'COMPLETED'))::int AS completed,
          COUNT(*) FILTER (WHERE o.order_status = 'CANCELLED')::int AS cancelled,
          COUNT(*) FILTER (WHERE o.order_status = 'REJECTED')::int AS rejected
        FROM orders o
        ${orderWhere}
      `),
      this.prisma.$queryRaw<Array<{
        gmv: Prisma.Decimal | string | number | null;
        realized_revenue: Prisma.Decimal | string | number | null;
        platform_commission: Prisma.Decimal | string | number | null;
        paid_revenue: Prisma.Decimal | string | number | null;
      }>>(Prisma.sql`
        SELECT
          COALESCE(SUM(o.total_amount) FILTER (WHERE o.order_status NOT IN ('CANCELLED', 'REJECTED')), 0)::numeric AS gmv,
          COALESCE(SUM(o.total_amount) FILTER (WHERE o.order_status IN ('DELIVERED', 'COMPLETED')), 0)::numeric AS realized_revenue,
          COALESCE(SUM(o.commission_amount) FILTER (WHERE o.order_status IN ('DELIVERED', 'COMPLETED')), 0)::numeric AS platform_commission,
          COALESCE((
            SELECT SUM(pt.amount)
            FROM payment_transaction pt
            WHERE pt.status = 'PAID'
            ${dateRange.fromDate ? Prisma.sql`AND pt.created_at >= ${dateRange.fromDate}` : Prisma.empty}
            ${dateRange.toDateExclusive ? Prisma.sql`AND pt.created_at < ${dateRange.toDateExclusive}` : Prisma.empty}
          ), 0)::numeric AS paid_revenue
        FROM orders o
        ${orderWhere}
      `),
      this.prisma.$queryRaw<Array<{ pending: number; succeeded: number; failed: number }>>(Prisma.sql`
        SELECT
          COUNT(*) FILTER (WHERE pt.status = 'PENDING')::int AS pending,
          COUNT(*) FILTER (WHERE pt.status = 'PAID')::int AS succeeded,
          COUNT(*) FILTER (WHERE pt.status = 'FAILED')::int AS failed
        FROM payment_transaction pt
        ${paymentWhere}
      `),
      this.prisma.$queryRaw<Array<{
        total: number;
        active: number;
        inactive: number;
        low_battery: number;
        unassigned: number;
      }>>(Prisma.sql`
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE b.status = 'ACTIVE')::int AS active,
          COUNT(*) FILTER (WHERE b.status <> 'ACTIVE')::int AS inactive,
          COUNT(*) FILTER (WHERE b.battery_level <= 20)::int AS low_battery,
          COUNT(*) FILTER (WHERE b.customer_id IS NULL OR NOT EXISTS (SELECT 1 FROM button_product bp WHERE bp.button_id = b.button_id))::int AS unassigned
        FROM iot_button b
      `),
      this.prisma.$queryRaw<Array<{
        total: number;
        pending_payment: number;
        active: number;
        expiring_soon: number;
        expired: number;
      }>>(Prisma.sql`
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE br.status = 'PENDING_PAYMENT')::int AS pending_payment,
          COUNT(*) FILTER (WHERE br.status = 'ACTIVE')::int AS active,
          COUNT(*) FILTER (WHERE br.status = 'ACTIVE' AND br.end_date <= NOW() + INTERVAL '7 days')::int AS expiring_soon,
          COUNT(*) FILTER (WHERE br.status = 'EXPIRED' OR (br.status = 'ACTIVE' AND br.end_date < NOW()))::int AS expired
        FROM button_rentals br
      `),
      this.prisma.$queryRaw<Array<{
        pending: number;
        processing: number;
        completed: number;
        rejected: number;
        failed: number;
      }>>(Prisma.sql`
        SELECT
          COUNT(*) FILTER (WHERE sw.status = 'PENDING')::int AS pending,
          COUNT(*) FILTER (WHERE sw.status = 'PROCESSING')::int AS processing,
          COUNT(*) FILTER (WHERE sw.status = 'COMPLETED')::int AS completed,
          COUNT(*) FILTER (WHERE sw.status = 'REJECTED')::int AS rejected,
          COUNT(*) FILTER (WHERE sw.status = 'FAILED')::int AS failed
        FROM store_withdrawals sw
      `),
      this.prisma.$queryRaw<Array<{ pending_bank_verification: number; pending_kyc: number }>>(Prisma.sql`
        SELECT
          (SELECT COUNT(*)::int FROM store_bank_accounts sba WHERE sba.verification_status = 'PENDING') AS pending_bank_verification,
          (SELECT COUNT(*)::int FROM identity_verification_sessions iv WHERE iv.status = 'PENDING') AS pending_kyc
      `),
      this.prisma.$queryRaw<Array<{ unresolved_count: number }>>(Prisma.sql`
        SELECT COUNT(*)::int AS unresolved_count
        FROM dead_letter_jobs dlj
        WHERE dlj.status = 'DEAD'
      `),
    ]);

    const s = storeRows[0] || { total: 0, active: 0, pending: 0, suspended: 0 };
    const u = userRows[0] || { total: 0, customers: 0, store_owners: 0, staff: 0, admins: 0, active_users: 0, suspended_users: 0 };
    const o = orderRows[0] || { total: 0, pending: 0, preparing: 0, delivering: 0, completed: 0, cancelled: 0, rejected: 0 };
    const fin = financialRows[0] || { gmv: 0, realized_revenue: 0, platform_commission: 0, paid_revenue: 0 };
    const pay = paymentRows[0] || { pending: 0, succeeded: 0, failed: 0 };
    const dev = deviceRows[0] || { total: 0, active: 0, inactive: 0, low_battery: 0, unassigned: 0 };
    const rent = rentalRows[0] || { total: 0, pending_payment: 0, active: 0, expiring_soon: 0, expired: 0 };
    const w = withdrawalRows[0] || { pending: 0, processing: 0, completed: 0, rejected: 0, failed: 0 };
    const v = verificationRows[0] || { pending_bank_verification: 0, pending_kyc: 0 };
    const dlq = dlqRows[0]?.unresolved_count || 0;

    const toNumber = (val: unknown) => Number(val || 0);

    const alerts: Array<{ code: string; message: string; severity: 'INFO' | 'WARNING' | 'CRITICAL'; count: number }> = [];
    if (s.pending > 0) {
      alerts.push({ code: 'PENDING_STORE_APPROVAL', message: `Có ${s.pending} cửa hàng mới đang chờ phê duyệt`, severity: 'WARNING', count: s.pending });
    }
    if (w.pending > 0) {
      alerts.push({ code: 'PENDING_WITHDRAWAL', message: `Có ${w.pending} yêu cầu rút tiền đang chờ xử lý`, severity: 'WARNING', count: w.pending });
    }
    if (w.failed > 0) {
      alerts.push({ code: 'FAILED_WITHDRAWAL', message: `Có ${w.failed} yêu cầu rút tiền bị thất bại`, severity: 'CRITICAL', count: w.failed });
    }
    if (dlq > 0) {
      alerts.push({ code: 'DLQ_UNRESOLVED', message: `Có ${dlq} tác vụ hàng đợi (DLQ) bị lỗi chưa xử lý`, severity: 'CRITICAL', count: dlq });
    }
    if (v.pending_kyc > 0) {
      alerts.push({ code: 'PENDING_KYC', message: `Có ${v.pending_kyc} hồ sơ xác thực eKYC chờ duyệt`, severity: 'INFO', count: v.pending_kyc });
    }

    let comparison = null;
    if (compareWith === 'previous-period' && dateRange.fromDate && dateRange.toDateExclusive) {
      const durationMs = dateRange.toDateExclusive.getTime() - dateRange.fromDate.getTime();
      const prevTo = new Date(dateRange.fromDate.getTime());
      const prevFrom = new Date(prevTo.getTime() - durationMs);
      const prevRows = await this.prisma.$queryRaw<Array<{
        total_orders: number;
        gmv: any;
        realized_revenue: any;
        commission: any;
      }>>(Prisma.sql`
        SELECT
          COUNT(*)::int AS total_orders,
          COALESCE(SUM(o.total_amount) FILTER (WHERE o.order_status NOT IN ('CANCELLED', 'REJECTED')), 0)::numeric AS gmv,
          COALESCE(SUM(o.total_amount) FILTER (WHERE o.order_status IN ('DELIVERED', 'COMPLETED')), 0)::numeric AS realized_revenue,
          COALESCE(SUM(o.commission_amount) FILTER (WHERE o.order_status IN ('DELIVERED', 'COMPLETED')), 0)::numeric AS commission
        FROM orders o
        WHERE o.order_date >= ${prevFrom} AND o.order_date < ${prevTo}
      `);
      const prev = prevRows[0];
      const prevGmv = toNumber(prev?.gmv);
      const prevOrders = toNumber(prev?.total_orders);
      const prevRealized = toNumber(prev?.realized_revenue);

      const curGmv = toNumber(fin.gmv);
      const curOrders = toNumber(o.total);
      const curRealized = toNumber(fin.realized_revenue);

      comparison = {
        previousPeriod: { fromDate: prevFrom.toISOString(), toDate: prevTo.toISOString() },
        ordersGrowth: prevOrders > 0 ? Number((((curOrders - prevOrders) / prevOrders) * 100).toFixed(2)) : 0,
        gmvGrowth: prevGmv > 0 ? Number((((curGmv - prevGmv) / prevGmv) * 100).toFixed(2)) : 0,
        realizedGrowth: prevRealized > 0 ? Number((((curRealized - prevRealized) / prevRealized) * 100).toFixed(2)) : 0,
      };
    }

    return {
      stores: {
        total: toNumber(s.total),
        active: toNumber(s.active),
        pending: toNumber(s.pending),
        suspended: toNumber(s.suspended),
      },
      users: {
        total: toNumber(u.total),
        customers: toNumber(u.customers),
        storeOwners: toNumber(u.store_owners),
        staff: toNumber(u.staff),
        admins: toNumber(u.admins),
        activeUsers: toNumber(u.active_users),
        suspendedUsers: toNumber(u.suspended_users),
      },
      orders: {
        total: toNumber(o.total),
        pending: toNumber(o.pending),
        preparing: toNumber(o.preparing),
        delivering: toNumber(o.delivering),
        completed: toNumber(o.completed),
        cancelled: toNumber(o.cancelled),
        rejected: toNumber(o.rejected),
      },
      financials: {
        gmv: toNumber(fin.gmv),
        realizedRevenue: toNumber(fin.realized_revenue),
        platformCommission: toNumber(fin.platform_commission),
        paidRevenue: toNumber(fin.paid_revenue),
      },
      payments: {
        pending: toNumber(pay.pending),
        succeeded: toNumber(pay.succeeded),
        failed: toNumber(pay.failed),
      },
      devices: {
        total: toNumber(dev.total),
        active: toNumber(dev.active),
        inactive: toNumber(dev.inactive),
        lowBattery: toNumber(dev.low_battery),
        unassigned: toNumber(dev.unassigned),
      },
      rentals: {
        total: toNumber(rent.total),
        pendingPayment: toNumber(rent.pending_payment),
        active: toNumber(rent.active),
        expiringSoon: toNumber(rent.expiring_soon),
        expired: toNumber(rent.expired),
      },
      withdrawals: {
        pending: toNumber(w.pending),
        processing: toNumber(w.processing),
        completed: toNumber(w.completed),
        rejected: toNumber(w.rejected),
        failed: toNumber(w.failed),
      },
      verifications: {
        pendingBankVerification: toNumber(v.pending_bank_verification),
        pendingKyc: toNumber(v.pending_kyc),
      },
      dlq: {
        unresolvedCount: dlq,
      },
      alerts,
      comparison,
    };
  }

  async getAdminRevenueAnalytics(
    dateRange: { fromDate?: Date; toDateExclusive?: Date } = {},
    groupBy: 'day' | 'week' | 'month' = 'day',
  ) {
    const orderConditions: Prisma.Sql[] = [];
    if (dateRange.fromDate) orderConditions.push(Prisma.sql`o.order_date >= ${dateRange.fromDate}`);
    if (dateRange.toDateExclusive) orderConditions.push(Prisma.sql`o.order_date < ${dateRange.toDateExclusive}`);
    const orderWhere = orderConditions.length ? Prisma.sql`WHERE ${Prisma.join(orderConditions, ' AND ')}` : Prisma.empty;

    const periodExpression: Record<'day' | 'week' | 'month', Prisma.Sql> = {
      day: Prisma.sql`to_char(date_trunc('day', o.order_date AT TIME ZONE 'Asia/Ho_Chi_Minh'), 'YYYY-MM-DD')`,
      week: Prisma.sql`to_char(date_trunc('week', o.order_date AT TIME ZONE 'Asia/Ho_Chi_Minh'), 'IYYY-"W"IW')`,
      month: Prisma.sql`to_char(date_trunc('month', o.order_date AT TIME ZONE 'Asia/Ho_Chi_Minh'), 'YYYY-MM')`,
    };

    const toNumber = (val: unknown) => Number(val || 0);

    const [timeline, rentalRevenueRows] = await Promise.all([
      this.prisma.$queryRaw<Array<{
        period: string;
        gmv: any;
        realized_revenue: any;
        platform_commission: any;
        total_orders: number;
      }>>(Prisma.sql`
        SELECT
          ${periodExpression[groupBy]} AS period,
          COUNT(*)::int AS total_orders,
          COALESCE(SUM(o.total_amount) FILTER (WHERE o.order_status NOT IN ('CANCELLED', 'REJECTED')), 0)::numeric AS gmv,
          COALESCE(SUM(o.total_amount) FILTER (WHERE o.order_status IN ('DELIVERED', 'COMPLETED')), 0)::numeric AS realized_revenue,
          COALESCE(SUM(o.commission_amount) FILTER (WHERE o.order_status IN ('DELIVERED', 'COMPLETED')), 0)::numeric AS platform_commission
        FROM orders o
        ${orderWhere}
        GROUP BY 1
        ORDER BY 1 ASC
      `),
      this.prisma.$queryRaw<Array<{ total_rent_amount: any; total_deposit: any }>>(Prisma.sql`
        SELECT
          COALESCE(SUM(br.total_rent_amount), 0)::numeric AS total_rent_amount,
          COALESCE(SUM(br.deposit_amount), 0)::numeric AS total_deposit
        FROM button_rentals br
        WHERE br.status = 'ACTIVE'
      `),
    ]);

    const rent = rentalRevenueRows[0] || { total_rent_amount: 0, total_deposit: 0 };

    return {
      timeline: timeline.map((t) => ({
        period: t.period,
        gmv: toNumber(t.gmv),
        realizedRevenue: toNumber(t.realized_revenue),
        platformCommission: toNumber(t.platform_commission),
        totalOrders: toNumber(t.total_orders),
      })),
      rentalRevenue: {
        activeRentAmount: toNumber(rent.total_rent_amount),
        activeDepositAmount: toNumber(rent.total_deposit),
      },
    };
  }

  async getAdminGrowthAnalytics(
    dateRange: { fromDate?: Date; toDateExclusive?: Date } = {},
    groupBy: 'day' | 'week' | 'month' = 'day',
  ) {
    const periodExpression: Record<'day' | 'week' | 'month', Prisma.Sql> = {
      day: Prisma.sql`to_char(date_trunc('day', created_at AT TIME ZONE 'Asia/Ho_Chi_Minh'), 'YYYY-MM-DD')`,
      week: Prisma.sql`to_char(date_trunc('week', created_at AT TIME ZONE 'Asia/Ho_Chi_Minh'), 'IYYY-"W"IW')`,
      month: Prisma.sql`to_char(date_trunc('month', created_at AT TIME ZONE 'Asia/Ho_Chi_Minh'), 'YYYY-MM')`,
    };

    const toNumber = (val: unknown) => Number(val || 0);

    const [storeSignups, userSignups] = await Promise.all([
      this.prisma.$queryRaw<Array<{ period: string; count: number }>>(Prisma.sql`
        SELECT
          ${periodExpression[groupBy]} AS period,
          COUNT(*)::int AS count
        FROM store
        WHERE 1=1
          ${dateRange.fromDate ? Prisma.sql`AND created_at >= ${dateRange.fromDate}` : Prisma.empty}
          ${dateRange.toDateExclusive ? Prisma.sql`AND created_at < ${dateRange.toDateExclusive}` : Prisma.empty}
        GROUP BY 1
        ORDER BY 1 ASC
      `),
      this.prisma.$queryRaw<Array<{ period: string; count: number }>>(Prisma.sql`
        SELECT
          ${periodExpression[groupBy]} AS period,
          COUNT(*)::int AS count
        FROM users
        WHERE 1=1
          ${dateRange.fromDate ? Prisma.sql`AND created_at >= ${dateRange.fromDate}` : Prisma.empty}
          ${dateRange.toDateExclusive ? Prisma.sql`AND created_at < ${dateRange.toDateExclusive}` : Prisma.empty}
        GROUP BY 1
        ORDER BY 1 ASC
      `),
    ]);

    return {
      newStoresTimeline: storeSignups.map((s) => ({ period: s.period, newStores: toNumber(s.count) })),
      newUsersTimeline: userSignups.map((u) => ({ period: u.period, newUsers: toNumber(u.count) })),
    };
  }

  async getAdminOperationsAnalytics() {
    const toNumber = (val: unknown) => Number(val || 0);

    const [pendingStores, failedWithdrawals, dlqJobs] = await Promise.all([
      this.prisma.store.findMany({
        where: { status: 'PENDING' },
        take: 10,
        select: {
          storeId: true,
          name: true,
          code: true,
          phone: true,
          email: true,
          createdAt: true,
        },
      }),
      this.prisma.$queryRaw<Array<{
        id: bigint;
        store_id: bigint;
        amount: any;
        failure_reason: string;
        created_at: Date;
      }>>(Prisma.sql`
        SELECT sw.withdrawal_id AS id, sw.store_id, sw.amount, sw.failure_reason, sw.created_at
        FROM store_withdrawals sw
        WHERE sw.status = 'FAILED'
        ORDER BY sw.created_at DESC
        LIMIT 10
      `),
      this.prisma.$queryRaw<Array<{
        id: string;
        queue_name: string;
        job_name: string;
        attempts_made: number;
        failed_reason: string;
        failed_at: Date;
      }>>(Prisma.sql`
        SELECT dlj.id, dlj.queue_name, dlj.job_name, dlj.attempts_made, dlj.failed_reason, dlj.failed_at
        FROM dead_letter_jobs dlj
        WHERE dlj.status = 'DEAD'
        ORDER BY dlj.failed_at DESC
        LIMIT 10
      `),
    ]);

    return {
      pendingStoreApprovals: pendingStores.map((s) => ({
        storeId: s.storeId.toString(),
        name: s.name,
        code: s.code,
        phone: s.phone,
        email: s.email,
        createdAt: s.createdAt,
      })),
      failedWithdrawals: failedWithdrawals.map((w) => ({
        id: w.id.toString(),
        storeId: w.store_id?.toString() || null,
        amount: toNumber(w.amount),
        failureReason: w.failure_reason,
        createdAt: w.created_at,
      })),
      deadLetterJobs: dlqJobs.map((j) => ({
        id: j.id,
        queueName: j.queue_name,
        jobName: j.job_name,
        attemptsMade: toNumber(j.attempts_made),
        failedReason: j.failed_reason,
        failedAt: j.failed_at,
      })),
    };
  }

  async getAdminStoresLeaderboard(options: { page?: number; pageSize?: number; sortBy?: string; sortOrder?: string } = {}) {
    const page = Math.max(options.page || 1, 1);
    const pageSize = Math.min(options.pageSize || 20, 100);
    const offset = (page - 1) * pageSize;
    const sortField = options.sortBy === 'orders' ? 'completed_orders' : options.sortBy === 'commission' ? 'commission_generated' : 'gmv';
    const sortDir = options.sortOrder?.toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    const toNumber = (val: unknown) => Number(val || 0);

    const [rows, countRows] = await Promise.all([
      this.prisma.$queryRaw<Array<{
        store_id: bigint;
        store_name: string;
        store_code: string;
        status: string;
        gmv: any;
        realized_revenue: any;
        commission_generated: any;
        completed_orders: number;
        active_buttons: number;
      }>>(Prisma.sql`
        SELECT
          s.store_id,
          s.name AS store_name,
          s.code AS store_code,
          s.status,
          COALESCE(SUM(o.total_amount) FILTER (WHERE o.order_status NOT IN ('CANCELLED', 'REJECTED')), 0)::numeric AS gmv,
          COALESCE(SUM(o.total_amount) FILTER (WHERE o.order_status IN ('DELIVERED', 'COMPLETED')), 0)::numeric AS realized_revenue,
          COALESCE(SUM(o.commission_amount) FILTER (WHERE o.order_status IN ('DELIVERED', 'COMPLETED')), 0)::numeric AS commission_generated,
          COUNT(o.order_id) FILTER (WHERE o.order_status IN ('DELIVERED', 'COMPLETED'))::int AS completed_orders,
          (SELECT COUNT(*)::int FROM iot_button b WHERE b.store_id = s.store_id AND b.status = 'ACTIVE') AS active_buttons
        FROM store s
        LEFT JOIN orders o ON o.store_id = s.store_id
        GROUP BY s.store_id, s.name, s.code, s.status
        ORDER BY ${Prisma.raw(sortField)} ${Prisma.raw(sortDir)}
        LIMIT ${pageSize} OFFSET ${offset}
      `),
      this.prisma.store.count(),
    ]);

    return {
      stores: rows.map((r) => ({
        storeId: r.store_id.toString(),
        storeName: r.store_name,
        storeCode: r.store_code,
        status: r.status,
        gmv: toNumber(r.gmv),
        realizedRevenue: toNumber(r.realized_revenue),
        commissionGenerated: toNumber(r.commission_generated),
        completedOrders: toNumber(r.completed_orders),
        activeButtons: toNumber(r.active_buttons),
      })),
      pagination: {
        page,
        pageSize,
        totalItems: countRows,
        totalPages: Math.ceil(countRows / pageSize),
      },
    };
  }
}
