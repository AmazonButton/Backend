import { Injectable, NotFoundException, BadRequestException, Optional, Inject } from '@nestjs/common';
import { PayOSPayoutService } from '../payments/payos-payout.service';
import { AdminRepository } from './admin.repository';

@Injectable()
export class AdminService {
  constructor(
    @Inject(AdminRepository)
    private readonly adminRepo: AdminRepository,
    @Optional()
    private readonly payosPayoutService?: PayOSPayoutService,
  ) {}

  async listPendingStores() {
    return this.adminRepo.findPendingStores();
  }

  async listAllStores() {
    return this.adminRepo.findAllStores();
  }

  async approveStore(storeId: string | number | bigint, _adminUser?: any) {
    const targetStoreId = BigInt(storeId);
    const store = await this.adminRepo.findStoreById(targetStoreId);
    if (!store) throw new NotFoundException('Không tìm thấy cửa hàng');
    return this.adminRepo.approveStore(targetStoreId, store.ownerUserId);
  }

  async rejectStore(storeId: string | number | bigint, reason: string, _adminUser?: any) {
    if (!reason) throw new BadRequestException('Bắt buộc phải nhập lý do từ chối');
    const targetStoreId = BigInt(storeId);
    const store = await this.adminRepo.findStoreById(targetStoreId);
    if (!store) throw new NotFoundException('Không tìm thấy cửa hàng');
    return this.adminRepo.rejectStore(targetStoreId);
  }

  async getSystemStats() {
    const { totalStores, totalUsers, totalButtons, totalOrders, stores, orders, activeButtons } =
      await this.adminRepo.getCounts();

    const activeStores = stores.filter((s: any) => s.status === 'ACTIVE').length;
    const completedOrders = orders.filter((o: any) => o.orderStatus === 'CONFIRMED' || o.orderStatus === 'DELIVERED').length;
    const totalGmv = orders
      .filter((o: any) => o.orderStatus === 'CONFIRMED' || o.orderStatus === 'DELIVERED')
      .reduce((sum: number, o: any) => sum + Number(o.totalAmount || 0), 0);

    return {
      totalStores,
      activeStores,
      totalUsers,
      totalButtons,
      activeButtons,
      totalOrders,
      completedOrders,
      totalGmv,
    };
  }

  async getAuditLogs() {
    const [orderLogs, priceLogs] = await this.adminRepo.findAuditLogs();
    return {
      orderLogs: orderLogs.map((l: any) => ({
        id: l.historyId.toString(),
        orderId: l.orderId.toString(),
        orderNumber: l.order?.orderNumber,
        fromStatus: l.fromStatus,
        toStatus: l.toStatus,
        note: l.note,
        changedBy: l.changedByUser?.fullName || 'Hệ thống',
        changedAt: l.changedAt,
      })),
      priceLogs: priceLogs.map((p: any) => ({
        id: p.historyId.toString(),
        productId: p.productId.toString(),
        productName: p.product?.productName,
        oldPrice: p.oldPrice,
        newPrice: p.newPrice,
        reason: p.reason,
        changedAt: p.changedAt,
      })),
    };
  }

  async listAuditLogs() {
    return this.getAuditLogs();
  }

  async listUsers() {
    const users = await this.adminRepo.findUsers();
    return users.map((u: any) => ({
      ...u,
      id: u.userId.toString(),
      userId: u.userId.toString(),
      role: u.customerProfile ? 'CUSTOMER' : (u.ownedStores && u.ownedStores.length > 0 ? 'STORE_OWNER' : 'USER'),
    }));
  }

  async toggleUserStatus(userId: string | number | bigint, status?: string, _adminUser?: any) {
    const targetUserId = BigInt(userId);
    const user = await this.adminRepo.findUserById(targetUserId);
    if (!user) throw new NotFoundException('Không tìm thấy người dùng');
    const nextStatus = status || (user.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE');
    return this.adminRepo.updateUserStatus(targetUserId, nextStatus);
  }

  async updateUserRole(userId: string | number | bigint, roleCode: string, _adminUser?: any) {
    const targetUserId = BigInt(userId);
    const user = await this.adminRepo.findUserById(targetUserId);
    if (!user) throw new NotFoundException('Không tìm thấy người dùng');

    const role = await this.adminRepo.findOrCreateRole(roleCode);
    await this.adminRepo.updateStaffRole(targetUserId, role.roleId);

    return { success: true, message: 'Đã cập nhật vai trò người dùng thành ' + roleCode };
  }

  async createSubscriptionPlan(body: any, _adminUser?: any) {
    const { planCode, planName, price, durationDays, maxProducts, description } = body;
    if (!planCode || !planName || price === undefined) {
      throw new BadRequestException('Vui lòng điền đầy đủ mã gói, tên gói và giá cước');
    }

    const existing = await this.adminRepo.findSubscriptionPlanByCode(planCode);
    if (existing) {
      throw new BadRequestException('Mã gói cước đã tồn tại');
    }

    return this.adminRepo.createSubscriptionPlan({
      planCode,
      planName,
      description: description || null,
      price,
      durationDays: durationDays ? Number(durationDays) : 30,
      maxProducts: maxProducts ? Number(maxProducts) : 50,
      isActive: true,
    });
  }

  async createPlan(body: any, _adminUser?: any) {
    return this.createSubscriptionPlan(body, _adminUser);
  }

  async listSubscriptionPlans() {
    return this.adminRepo.findAllSubscriptionPlans();
  }

  async listPlans() {
    return this.listSubscriptionPlans();
  }

  async updateSubscriptionPlan(id: string | number | bigint, body: any, _adminUser?: any) {
    const planId = BigInt(id);
    const existing = await this.adminRepo.findSubscriptionPlanById(planId);
    if (!existing) throw new NotFoundException('Không tìm thấy gói cước');
    return this.adminRepo.updateSubscriptionPlan(planId, body);
  }

  async updatePlan(id: string | number | bigint, body: any, _adminUser?: any) {
    return this.updateSubscriptionPlan(id, body, _adminUser);
  }

  async createRentalPackage(body: any, _adminUser?: any) {
    const {
      packageCode,
      packageName,
      monthlyPrice,
      depositAmount,
      depositFee,
      description,
      buttonQuantity,
      features,
      minRentalMonths,
    } = body;
    if (!packageCode || !packageName || monthlyPrice === undefined) {
      throw new BadRequestException('Vui lòng điền đầy đủ mã gói, tên gói và giá thuê hàng tháng');
    }

    const existing = await this.adminRepo.findRentalPackageByCode(packageCode);
    if (existing) {
      throw new BadRequestException('Mã gói thuê thiết bị đã tồn tại');
    }

    return this.adminRepo.createRentalPackage({
      packageCode,
      packageName,
      description,
      buttonQuantity: buttonQuantity ?? 1,
      monthlyPrice,
      depositFee: depositFee ?? depositAmount ?? 0,
      minRentalMonths: minRentalMonths || 1,
      features: features || [],
      status: 'ACTIVE',
    });
  }

  async listRentalPackages() {
    return this.adminRepo.findAllRentalPackages();
  }

  async updateRentalPackage(id: string | number | bigint, body: any, _adminUser?: any) {
    const packageId = BigInt(id);
    const existing = await this.adminRepo.findRentalPackageById(packageId);
    if (!existing) throw new NotFoundException('Không tìm thấy gói thuê');
    return this.adminRepo.updateRentalPackage(packageId, body);
  }

  async listAllWithdrawals() {
    return this.adminRepo.findWithdrawals();
  }

  async listWithdrawals() {
    return this.listAllWithdrawals();
  }

  async confirmWithdrawalTransfer(withdrawalId: string | number | bigint, transferEvidenceUrl?: string, adminUser?: any) {
    const rawWithdrawalId = BigInt(withdrawalId);
    const withdrawal = await this.adminRepo.findWithdrawalById(rawWithdrawalId);
    if (!withdrawal) throw new NotFoundException('Yêu cầu rút tiền không tồn tại');
    if (withdrawal.status !== 'PENDING') {
      throw new BadRequestException('Yêu cầu đang ở trạng thái ' + withdrawal.status + ', không thể duyệt');
    }

    return this.adminRepo.updateWithdrawal(rawWithdrawalId, {
      status: 'TRANSFERRED',
      transferEvidenceUrl: typeof transferEvidenceUrl === 'string' ? transferEvidenceUrl : null,
      approvedByUserId: adminUser?.userId ? BigInt(adminUser.userId) : null,
      processedAt: new Date(),
    });
  }

  async approveWithdrawalTransfer(withdrawalId: string | number | bigint, adminUser?: any) {
    return this.confirmWithdrawalTransfer(withdrawalId, undefined, adminUser);
  }

  async rejectWithdrawal(withdrawalId: string | number | bigint, reason: string, adminUser?: any) {
    const rawWithdrawalId = BigInt(withdrawalId);
    if (!reason?.trim()) {
      throw new BadRequestException('Vui lòng nhập lý do từ chối yêu cầu rút tiền');
    }

    const withdrawal = await this.adminRepo.findWithdrawalById(rawWithdrawalId);
    if (!withdrawal) throw new NotFoundException('Yêu cầu rút tiền không tồn tại');
    if (withdrawal.status !== 'PENDING') {
      throw new BadRequestException('Yêu cầu đang ở trạng thái ' + withdrawal.status + ', không thể từ chối');
    }

    return this.adminRepo.rejectWithdrawalTransaction(
      withdrawal,
      reason,
      adminUser?.userId ? BigInt(adminUser.userId) : undefined,
    );
  }

  async getPayosPayoutBalance() {
    if (!this.payosPayoutService) {
      throw new BadRequestException({
        success: false,
        code: 'PAYOS_PAYOUT_NOT_CONFIGURED',
        message: 'Kênh chi hộ PayOS Payout chưa được tích hợp hoặc cấu hình',
      });
    }
    return this.payosPayoutService.getPayoutBalance();
  }

  async getPayOSPayoutBalance() {
    return this.getPayosPayoutBalance();
  }

  async executePayOSPayout(withdrawalId: string | number | bigint, adminUser?: any) {
    const rawWithdrawalId = BigInt(withdrawalId);
    const withdrawal = await this.adminRepo.findWithdrawalById(rawWithdrawalId);
    if (!withdrawal) throw new NotFoundException('Yêu cầu rút tiền không tồn tại');
    if (withdrawal.status !== 'PENDING') {
      throw new BadRequestException('Yêu cầu đang ở trạng thái ' + withdrawal.status + ', không thể xuất lệnh chi hộ');
    }

    if (!this.payosPayoutService) {
      throw new BadRequestException('PayOSPayoutService chưa sẵn sàng');
    }

    const payoutPayload = {
      referenceId: 'WITHDRAW_' + (withdrawal.withdrawalCode || withdrawal.withdrawalId) + '_' + Date.now(),
      amount: Number(withdrawal.amount),
      description: 'Chi ho SOB ' + withdrawal.withdrawalCode,
      toBin: (withdrawal.wallet as any)?.bankBin || '970422',
      toAccountNumber: (withdrawal.wallet as any)?.bankAccount || '000000000',
    };

    const payoutResult = await this.payosPayoutService.createPayout(payoutPayload);

    return this.adminRepo.updateWithdrawal(rawWithdrawalId, {
      status: 'PROCESSING',
      providerReferenceId: payoutPayload.referenceId,
      approvedByUserId: adminUser?.userId ? BigInt(adminUser.userId) : null,
      processedAt: new Date(),
    });
  }

  async payoutViaPayOS(withdrawalId: string | number | bigint, adminUser?: any) {
    return this.executePayOSPayout(withdrawalId, adminUser);
  }

  async syncPayoutStatus(withdrawalId: string | number | bigint, _adminUser?: any) {
    const rawWithdrawalId = BigInt(withdrawalId);
    const withdrawal = await this.adminRepo.findWithdrawalById(rawWithdrawalId);
    if (!withdrawal) throw new NotFoundException('Yêu cầu rút tiền không tồn tại');

    if (!this.payosPayoutService) {
      throw new BadRequestException('PayOSPayoutService chưa sẵn sàng');
    }

    if (withdrawal.providerPayoutId) {
      const statusData = await this.payosPayoutService.getPayout(withdrawal.providerPayoutId);
      return { withdrawal, statusData };
    } else if (withdrawal.providerReferenceId) {
      const listData = await this.payosPayoutService.getPayouts({ referenceId: withdrawal.providerReferenceId });
      return { withdrawal, listData };
    }

    return { withdrawal, message: 'Chưa có thông tin provider reference id' };
  }
}
