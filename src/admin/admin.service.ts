import { CreatePayosBatchPayoutDto, EstimatePayoutCreditDto, ListPayosPayoutsQueryDto } from './dto/payos-payout.dto';
import { UpdateAdminStoreDto } from './dto/update-admin-store.dto';
import { Injectable, NotFoundException, BadRequestException, Optional, Inject, Logger } from '@nestjs/common';
import { PayOSPayoutService } from '../payments/payos-payout.service';
import { AdminRepository } from './admin.repository';
import { CryptoVaultUtil } from '../common/utils/crypto-vault.util';
import { DashboardCacheService } from '../common/cache/dashboard-cache.service';
import { buildAnalyticsDateRange } from '../analytics/utils/analytics-date-range.util';
import {
  AdminDashboardQueryDto,
  AdminTimeseriesAnalyticsQueryDto,
  AdminStoresLeaderboardQueryDto,
} from './dto/admin-analytics-query.dto';

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    @Inject(AdminRepository)
    private readonly adminRepo: AdminRepository,
    @Optional()
    private readonly payosPayoutService?: PayOSPayoutService,
    @Optional() private readonly cacheService?: DashboardCacheService,
  ) {}

  private async invalidateAdminAndStoreCaches(storeId?: string | number | bigint) {
    if (!this.cacheService || typeof this.cacheService.invalidatePrefix !== 'function') return;
    try {
      const promises: Promise<void>[] = [
        this.cacheService.invalidatePrefix('admin:dashboard:'),
        this.cacheService.invalidatePrefix('admin:operations'),
        this.cacheService.invalidatePrefix('admin:revenue:'),
        this.cacheService.invalidatePrefix('admin:growth:'),
        this.cacheService.invalidatePrefix('admin:stores-leaderboard:'),
      ];
      if (storeId) {
        promises.push(this.cacheService.invalidatePrefix(`dash:store:${storeId.toString()}:`));
        promises.push(this.cacheService.invalidatePrefix(`staff:dashboard:store:${storeId.toString()}:`));
      }
      await Promise.all(promises);
    } catch (error) {
      this.logger.warn(
        `Dashboard cache invalidation failed: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    }
  }

  async listPendingStores() {
    return this.adminRepo.findPendingStores();
  }

  async listAllStores() {
    return this.adminRepo.findAllStores();
  }

  async updateStoreById(storeId: string | number | bigint, dto: UpdateAdminStoreDto, _adminUser?: any) {
    const targetStoreId = BigInt(storeId);
    const store = await this.adminRepo.findStoreById(targetStoreId);
    if (!store) {
      throw new NotFoundException('Không tìm thấy cửa hàng');
    }
    const updated = await this.adminRepo.updateStoreById(targetStoreId, dto);
    await this.invalidateAdminAndStoreCaches(targetStoreId);
    return updated;
  }

  async approveStore(storeId: string | number | bigint, _adminUser?: any) {
    const targetStoreId = BigInt(storeId);
    const store = await this.adminRepo.findStoreById(targetStoreId);
    if (!store) throw new NotFoundException('Không tìm thấy cửa hàng');
    const res = await this.adminRepo.approveStore(targetStoreId, store.ownerUserId);
    await this.invalidateAdminAndStoreCaches(targetStoreId);
    return res;
  }

  async rejectStore(storeId: string | number | bigint, reason: string, _adminUser?: any) {
    if (!reason) throw new BadRequestException('Bắt buộc phải nhập lý do từ chối');
    const targetStoreId = BigInt(storeId);
    const store = await this.adminRepo.findStoreById(targetStoreId);
    if (!store) throw new NotFoundException('Không tìm thấy cửa hàng');
    const res = await this.adminRepo.rejectStore(targetStoreId);
    await this.invalidateAdminAndStoreCaches(targetStoreId);
    return res;
  }

  async getSystemStats() {
    return this.adminRepo.getCounts();
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
    const result = await this.adminRepo.updateUserStatus(targetUserId, nextStatus);
    await this.invalidateAdminAndStoreCaches();
    return result;
  }

  async updateUserRole(userId: string | number | bigint, roleCode: string, _adminUser?: any) {
    const targetUserId = BigInt(userId);
    const user = await this.adminRepo.findUserById(targetUserId);
    if (!user) throw new NotFoundException('Không tìm thấy người dùng');

    const role = await this.adminRepo.findOrCreateRole(roleCode);
    await this.adminRepo.updateStaffRole(targetUserId, role.roleId);
    await this.invalidateAdminAndStoreCaches();

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

  async getWithdrawalById(withdrawalId: string | number | bigint) {
    const rawWithdrawalId = BigInt(withdrawalId);
    const withdrawal = await this.adminRepo.findWithdrawalById(rawWithdrawalId);
    if (!withdrawal) {
      throw new NotFoundException('Yêu cầu rút tiền không tồn tại');
    }
    return withdrawal;
  }

  async confirmWithdrawalTransfer(_withdrawalId: string | number | bigint, _transferEvidenceUrl?: string, _adminUser?: any) {
    throw new BadRequestException({
      success: false,
      errorCode: 'MANUAL_TRANSFER_DEPRECATED',
      message:
        'Phương thức chuyển khoản thủ công đã bị vô hiệu hóa. Trạng thái rút tiền chỉ được xử lý qua PayOS Payout (POST /api/v1/admin/withdrawals/:id/payout).',
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

    const res = await this.adminRepo.rejectWithdrawalTransaction(
      withdrawal,
      reason,
      adminUser?.userId ? BigInt(adminUser.userId) : undefined,
    );
    await this.invalidateAdminAndStoreCaches(withdrawal.storeId);
    return res;
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

    // Atomic race-condition prevention via Pure Repository
    const claimed = await this.adminRepo.claimPendingWithdrawal(rawWithdrawalId);
    if (!claimed) {
      const current = await this.adminRepo.findWithdrawalById(rawWithdrawalId);
      if (!current) throw new NotFoundException('Yêu cầu rút tiền không tồn tại');
      throw new BadRequestException(
        `Yêu cầu rút tiền đang ở trạng thái ${current.status}, không thể xuất lệnh chi hộ hoặc đang được xử lý đồng thời`
      );
    }

    const withdrawal = await this.adminRepo.findWithdrawalById(rawWithdrawalId);
    if (!withdrawal) throw new NotFoundException('Yêu cầu rút tiền không tồn tại');

    if (!this.payosPayoutService) {
      await this.adminRepo.refundFailedWithdrawalTransaction(rawWithdrawalId, 'PayOSPayoutService chưa sẵn sàng');
      throw new BadRequestException('PayOSPayoutService chưa sẵn sàng');
    }

    // Provider reference must be stable and idempotent (NO Date.now() suffix!)
    const providerReferenceId = withdrawal.providerReferenceId || withdrawal.withdrawalCode;

    let toAccountNumber = '';
    if (withdrawal.bankAccountEncrypted) {
      toAccountNumber = CryptoVaultUtil.decryptAccountNumber(withdrawal.bankAccountEncrypted);
    } else if (withdrawal.bankAccountNumber) {
      toAccountNumber = withdrawal.bankAccountNumber;
    }

    const payoutPayload = {
      referenceId: providerReferenceId,
      amount: Number(withdrawal.amount),
      description: ('Chi ho SOB ' + withdrawal.withdrawalCode).slice(0, 25),
      toBin: withdrawal.bankBinSnapshot || (withdrawal.wallet as any)?.bankBin || withdrawal.bankCode || '970422',
      toAccountNumber,
    };

    try {
      const payoutResult = await this.payosPayoutService.createPayout(payoutPayload);
      const providerPayoutId = payoutResult?.data?.id || `payout_${providerReferenceId}`;

      const updated = await this.adminRepo.updateWithdrawal(rawWithdrawalId, {
        status: 'PROCESSING',
        providerReferenceId,
        providerPayoutId,
        approvedByUserId: adminUser?.userId ? BigInt(adminUser.userId) : null,
        processedAt: new Date(),
      });
      await this.invalidateAdminAndStoreCaches(withdrawal.storeId);
      return updated;
    } catch (err: any) {
      // Invariant PAY-01: Never auto-refund wallet on timeout or uncertain provider error!
      // Auto-refunding while the remote provider might have accepted or queued the payout
      // exposes the business to double payout vulnerability.
      // Funds must remain frozen under status PENDING_RECONCILIATION until explicitly reconciled.
      await this.adminRepo.markWithdrawalPendingReconciliation(
        rawWithdrawalId,
        err.message || 'Lỗi kết nối hoặc xử lý từ PayOS'
      );
      await this.invalidateAdminAndStoreCaches(withdrawal.storeId);
      throw new BadRequestException(
        `Xuất lệnh chi hộ PayOS chưa rõ kết quả: ${err.message || 'Lỗi cổng PayOS'}. Yêu cầu được giữ ở trạng thái PENDING_RECONCILIATION để đối soát, số dư ví không tự ý hoàn lại để chống chi kép.`
      );
    }
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

    let statusData: any = null;
    let targetPayout: any = null;

    if (withdrawal.providerPayoutId) {
      try {
        statusData = await this.payosPayoutService.getPayout(withdrawal.providerPayoutId);
        targetPayout = statusData?.data;
      } catch (err: any) {
        return {
          withdrawal,
          message: `Lỗi khi lấy chi tiết payout từ provider (${err?.message || 'Unknown error'}). Giữ trạng thái chờ đối soát.`,
          statusData: null,
        };
      }
    } else if (withdrawal.providerReferenceId) {
      try {
        statusData = await this.payosPayoutService.getPayouts({ referenceId: withdrawal.providerReferenceId });
      } catch (err: any) {
        return {
          withdrawal,
          message: `Lỗi khi tra cứu danh sách payouts từ provider (${err?.message || 'Unknown error'}). Giữ trạng thái chờ đối soát.`,
          statusData: null,
        };
      }

      const rawList = statusData?.data?.payouts || statusData?.data || [];
      const payoutsList = Array.isArray(rawList) ? rawList : [];

      const matched = payoutsList.filter(
        (p: any) =>
          p.referenceId === withdrawal.providerReferenceId ||
          p.referenceId === withdrawal.withdrawalCode ||
          p.id === withdrawal.providerReferenceId,
      );

      if (matched.length === 1) {
        const found = matched[0];
        if (!found.id) {
          return {
            withdrawal,
            message: 'Bản ghi payout không có ID chi tiết từ provider, không thể xác thực an toàn. Giữ trạng thái chờ đối soát.',
            statusData,
          };
        }
        try {
          const detailRes = await this.payosPayoutService.getPayout(found.id);
          targetPayout = detailRes?.data;
          if (!targetPayout) {
            return {
              withdrawal,
              message: 'Phản hồi chi tiết payout từ provider rỗng, không dùng bản tóm tắt thay thế. Giữ trạng thái chờ đối soát.',
              statusData: detailRes,
            };
          }
        } catch (err: any) {
          return {
            withdrawal,
            message: `Lỗi khi lấy chi tiết payout (${err?.message || 'Detail lookup failed'}). Không dùng bản tóm tắt thay thế, giữ trạng thái chờ đối soát.`,
            statusData,
          };
        }
      } else {
        return {
          withdrawal,
          message:
            matched.length === 0
              ? 'Không tìm thấy giao dịch payout phù hợp với referenceId trên PayOS, giữ trạng thái chờ đối soát'
              : 'Có nhiều hơn một payout trùng referenceId trên PayOS, giữ trạng thái chờ đối soát thủ công',
          statusData,
        };
      }
    } else {
      return { withdrawal, message: 'Chưa có thông tin provider reference id hoặc payout id' };
    }

    if (!targetPayout) {
      return { withdrawal, message: 'Không thể trích xuất dữ liệu chi tiết payout từ provider. Giữ trạng thái chờ đối soát.', statusData };
    }

    // 1. Match specific transaction inside payout if transactions array is present
    let matchedTx: any = null;
    if (Array.isArray(targetPayout.transactions) && targetPayout.transactions.length > 0) {
      const candidates = targetPayout.transactions.filter((tx: any) => {
        const refMatches =
          (withdrawal.providerReferenceId && tx.referenceId === withdrawal.providerReferenceId) ||
          (withdrawal.withdrawalCode && tx.referenceId === withdrawal.withdrawalCode);
        const idMatches =
          withdrawal.providerPayoutId &&
          (tx.id === withdrawal.providerPayoutId || String(tx.payoutId) === withdrawal.providerPayoutId);
        return refMatches || idMatches;
      });

      if (candidates.length === 1) {
        matchedTx = candidates[0];
      } else if (candidates.length > 1) {
        return {
          withdrawal,
          message: 'Có nhiều hơn một transaction khớp reference trong chi tiết payout. Giữ trạng thái chờ đối soát.',
          statusData,
        };
      } else if (
        targetPayout.transactions.length === 1 &&
        (targetPayout.referenceId === withdrawal.providerReferenceId ||
          targetPayout.id === withdrawal.providerPayoutId)
      ) {
        matchedTx = targetPayout.transactions[0];
      } else {
        return {
          withdrawal,
          message: 'Không tìm thấy transaction tương ứng với yêu cầu rút tiền trong chi tiết payout. Giữ trạng thái chờ đối soát.',
          statusData,
        };
      }
    }

    // 2. Strict amount validation: finite, strictly positive, integer VND, and exact match
    const rawAmount = matchedTx ? matchedTx.amount : targetPayout.amount;
    const reportedAmount = Number(rawAmount);
    const expectedAmount = Number(withdrawal.amount);

    if (
      rawAmount === undefined ||
      rawAmount === null ||
      !Number.isFinite(reportedAmount) ||
      !Number.isInteger(reportedAmount) ||
      reportedAmount <= 0
    ) {
      return {
        withdrawal,
        message: `Số tiền trên cổng thanh toán không hợp lệ (nhận được: ${rawAmount}). Giữ trạng thái chờ đối soát.`,
        statusData,
      };
    }

    if (reportedAmount !== expectedAmount) {
      return {
        withdrawal,
        message: `Số tiền trên cổng thanh toán (${reportedAmount}) không khớp chính xác với yêu cầu rút tiền (${expectedAmount}). Giữ trạng thái chờ đối soát.`,
        statusData,
      };
    }

    // 3. Strict recipient snapshot validation (BIN & account name)
    const reportedBin = String(
      matchedTx?.toBin || matchedTx?.bin || targetPayout.toBin || targetPayout.bin || '',
    ).trim();
    const reportedAccountName = String(
      matchedTx?.toAccountName || targetPayout.toAccountName || matchedTx?.accountName || targetPayout.accountName || '',
    ).trim();

    const expectedBin = String(
      withdrawal.bankBinSnapshot || withdrawal.bankCode || '',
    ).trim();
    const expectedAccountName = String(
      withdrawal.bankAccountNameSnapshot || withdrawal.bankAccountHolder || '',
    ).trim();

    if (reportedBin && expectedBin && reportedBin !== expectedBin) {
      return {
        withdrawal,
        message: `Mã ngân hàng người nhận (${reportedBin}) không khớp với snapshot yêu cầu rút tiền (${expectedBin}). Giữ trạng thái chờ đối soát.`,
        statusData,
      };
    }

    const normalizeText = (s: string) =>
      (s || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/đ/g, 'd')
        .replace(/Đ/g, 'D')
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '')
        .trim();

    if (reportedAccountName && expectedAccountName) {
      if (normalizeText(reportedAccountName) !== normalizeText(expectedAccountName)) {
        return {
          withdrawal,
          message: `Tên người thụ hưởng (${reportedAccountName}) không khớp với snapshot yêu cầu rút tiền (${expectedAccountName}). Giữ trạng thái chờ đối soát.`,
          statusData,
        };
      }
    }

    // 4. Ensure valid provider payout ID exists
    const finalPayoutId = String(
      (matchedTx ? matchedTx.id : null) || targetPayout.id || withdrawal.providerPayoutId || '',
    ).trim();
    if (!finalPayoutId) {
      return {
        withdrawal,
        message: 'Thiếu thông tin payout ID từ cổng thanh toán. Giữ trạng thái chờ đối soát.',
        statusData,
      };
    }

    // 5. Check approval state and finalize only if confirmed
    const state = String(
      (matchedTx ? matchedTx.state : null) ||
      targetPayout.approvalState ||
      targetPayout.state ||
      targetPayout.status ||
      '',
    ).toUpperCase();

    if (['COMPLETED', 'PAID', 'SUCCEEDED'].includes(state)) {
      await this.adminRepo.finalizeSucceededWithdrawalTransaction(
        rawWithdrawalId,
        finalPayoutId,
      );
    } else if (['REJECTED', 'FAILED', 'CANCELLED'].includes(state)) {
      // Explicitly confirmed as failed by provider: safe to refund wallet now
      await this.adminRepo.refundFailedWithdrawalTransaction(
        rawWithdrawalId,
        statusData?.desc || `PayOS xác nhận chi hộ thất bại (${state})`
      );
    }

    await this.invalidateAdminAndStoreCaches(withdrawal.storeId);
    const fresh = await this.adminRepo.findWithdrawalById(rawWithdrawalId);
    return { withdrawal: fresh || withdrawal, statusData };
  }

  async createBatchPayout(params: CreatePayosBatchPayoutDto) {
    if (!this.payosPayoutService) {
      throw new BadRequestException('PayOSPayoutService chưa sẵn sàng');
    }
    return this.payosPayoutService.createBatchPayout(params);
  }

  async estimatePayoutCredit(params: EstimatePayoutCreditDto) {
    if (!this.payosPayoutService) {
      throw new BadRequestException('PayOSPayoutService chưa sẵn sàng');
    }
    return this.payosPayoutService.estimateCredit(params);
  }

  async listPayosPayouts(query?: ListPayosPayoutsQueryDto) {
    if (!this.payosPayoutService) {
      throw new BadRequestException('PayOSPayoutService chưa sẵn sàng');
    }
    return this.payosPayoutService.getPayouts(query);
  }

  async getDashboard(query: AdminDashboardQueryDto) {
    const cacheKey = `admin:dashboard:${query.fromDate || 'all'}:${query.toDate || 'all'}:${query.compareWith || 'none'}`;
    const fetcher = async () => {
      const dateRange = (query.fromDate || query.toDate)
        ? buildAnalyticsDateRange(query.fromDate, query.toDate, 'day')
        : {};
      return this.adminRepo.getAdminDashboardData(dateRange, query.compareWith);
    };

    if (this.cacheService && typeof this.cacheService.getOrSet === 'function') {
      return this.cacheService.getOrSet(cacheKey, 30, fetcher);
    }
    return fetcher();
  }

  async getRevenueAnalytics(query: AdminTimeseriesAnalyticsQueryDto) {
    const groupBy = query.groupBy || 'day';
    const cacheKey = `admin:revenue:${query.fromDate || 'all'}:${query.toDate || 'all'}:${groupBy}`;
    const fetcher = async () => {
      const dateRange = (query.fromDate || query.toDate)
        ? buildAnalyticsDateRange(query.fromDate, query.toDate, groupBy)
        : {};
      return this.adminRepo.getAdminRevenueAnalytics(dateRange, groupBy);
    };

    if (this.cacheService && typeof this.cacheService.getOrSet === 'function') {
      return this.cacheService.getOrSet(cacheKey, 30, fetcher);
    }
    return fetcher();
  }

  async getGrowthAnalytics(query: AdminTimeseriesAnalyticsQueryDto) {
    const groupBy = query.groupBy || 'day';
    const cacheKey = `admin:growth:${query.fromDate || 'all'}:${query.toDate || 'all'}:${groupBy}`;
    const fetcher = async () => {
      const dateRange = (query.fromDate || query.toDate)
        ? buildAnalyticsDateRange(query.fromDate, query.toDate, groupBy)
        : {};
      return this.adminRepo.getAdminGrowthAnalytics(dateRange, groupBy);
    };

    if (this.cacheService && typeof this.cacheService.getOrSet === 'function') {
      return this.cacheService.getOrSet(cacheKey, 30, fetcher);
    }
    return fetcher();
  }

  async getOperationsAnalytics() {
    const cacheKey = 'admin:operations';
    const fetcher = async () => this.adminRepo.getAdminOperationsAnalytics();

    if (this.cacheService && typeof this.cacheService.getOrSet === 'function') {
      return this.cacheService.getOrSet(cacheKey, 30, fetcher);
    }
    return fetcher();
  }

  async getStoresLeaderboard(query: AdminStoresLeaderboardQueryDto) {
    const page = Math.max(query.page || 1, 1);
    const pageSize = Math.min(query.pageSize || 20, 100);
    const sortBy = query.sortBy || 'gmv';
    const sortOrder = query.sortOrder || 'desc';

    const cacheKey = `admin:stores-leaderboard:${page}:${pageSize}:${sortBy}:${sortOrder}`;
    const fetcher = async () => this.adminRepo.getAdminStoresLeaderboard({ page, pageSize, sortBy, sortOrder });

    if (this.cacheService && typeof this.cacheService.getOrSet === 'function') {
      return this.cacheService.getOrSet(cacheKey, 30, fetcher);
    }
    return fetcher();
  }
}
