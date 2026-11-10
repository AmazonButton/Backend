import { CreatePayosBatchPayoutDto, EstimatePayoutCreditDto, ListPayosPayoutsQueryDto } from './dto/payos-payout.dto';
import { UpdateAdminStoreDto } from './dto/update-admin-store.dto';
import { Injectable, NotFoundException, BadRequestException, Optional, Inject, Logger } from '@nestjs/common';
import { PayOSPayoutService } from '../payments/payos-payout.service';
import { AdminRepository } from './admin.repository';
import { CryptoVaultUtil } from '../common/utils/crypto-vault.util';
import {
  verifyPayosPayoutEvidence,
  verifyPayosPayoutRejectionEvidence,
  PayosPayoutExpectedCriteria,
} from '../payments/payos-payout-verifier';
import { WalletMapper } from '../store-wallet/mappers/wallet.mapper';
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
        this.cacheService.invalidatePrefix('stores:'),
        this.cacheService.invalidateKey('stores:active_page1_20'),
        this.cacheService.invalidateKey('rentals:available_packages'),
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

  async listPendingStores(query?: any) {
    const res = await this.adminRepo.findPendingStores(query);
    return res;
  }

  async listAllStores(query?: any) {
    const res = await this.adminRepo.findAllStores(query);
    return res;
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

  async listUsers(query?: any) {
    const res = await this.adminRepo.findUsers(query);
    const items = res.items.map((u: any) => ({
      ...u,
      id: u.userId.toString(),
      userId: u.userId.toString(),
      role: u.customerProfile ? 'CUSTOMER' : (u.ownedStores && u.ownedStores.length > 0 ? 'STORE_OWNER' : 'USER'),
    }));
    return {
      items,
      total: res.total,
      page: res.page,
      pageSize: res.pageSize,
    };
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

    const created = await this.adminRepo.createRentalPackage({
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
    await this.invalidateAdminAndStoreCaches();
    return created;
  }

  async listRentalPackages() {
    return this.adminRepo.findAllRentalPackages();
  }

  async updateRentalPackage(id: string | number | bigint, body: any, _adminUser?: any) {
    const packageId = BigInt(id);
    const existing = await this.adminRepo.findRentalPackageById(packageId);
    if (!existing) throw new NotFoundException('Không tìm thấy gói thuê');
    const updated = await this.adminRepo.updateRentalPackage(packageId, body);
    await this.invalidateAdminAndStoreCaches();
    return updated;
  }

  async listAllWithdrawals(query?: any) {
    const res = await this.adminRepo.findWithdrawals(query);
    return {
      items: WalletMapper.toWithdrawalDtoList(res.items),
      total: res.total,
      page: res.page,
      pageSize: res.pageSize,
    };
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

    if (!withdrawal.bankAccountEncrypted || !withdrawal.bankAccountHash || !withdrawal.bankBinSnapshot) {
      throw new BadRequestException('Thiếu snapshot tài khoản ngân hàng đã mã hóa hoặc mã BIN (Fail-Closed)');
    }

    let toAccountNumber = '';
    try {
      toAccountNumber = CryptoVaultUtil.decryptAccountNumber(withdrawal.bankAccountEncrypted).trim();
    } catch (err: any) {
      this.logger.error(`Lỗi giải mã tài khoản cho withdrawal #${rawWithdrawalId}: ${err?.message}`);
      throw new BadRequestException('Lỗi giải mã tài khoản nhận tiền (Fail-Closed)');
    }

    if (!toAccountNumber) {
      throw new BadRequestException('Số tài khoản nhận tiền sau giải mã rỗng (Fail-Closed)');
    }

    // Xác minh hash trước khi gửi tiền
    const computedHash = CryptoVaultUtil.hashAccountNumber(toAccountNumber);
    if (computedHash !== withdrawal.bankAccountHash) {
      throw new BadRequestException('Tính toàn vẹn của tài khoản nhận tiền bị vi phạm (Hash Mismatch)');
    }

    // Số tiền PayOS thực chuyển bắt buộc là netAmount (amount - fee)
    const payoutAmount = withdrawal.netAmount ? Number(withdrawal.netAmount) : Number(withdrawal.amount) - Number(withdrawal.fee || 0);
    if (!Number.isInteger(payoutAmount) || payoutAmount <= 0) {
      throw new BadRequestException('Số tiền chi hộ thực chuyển (netAmount) không hợp lệ');
    }

    const payoutPayload = {
      referenceId: providerReferenceId,
      amount: payoutAmount,
      description: ('Chi ho SOB ' + withdrawal.withdrawalCode).slice(0, 25),
      toBin: withdrawal.bankBinSnapshot.trim(),
      toAccountNumber,
    };

    try {
      const payoutResult = await this.payosPayoutService.createPayout(payoutPayload);
      const providerPayoutId = payoutResult?.data?.id ? String(payoutResult.data.id).trim() : null;

      await this.adminRepo.supplementPayoutIdIfAllowed(
        rawWithdrawalId,
        providerReferenceId,
        providerPayoutId,
        adminUser?.userId ? BigInt(adminUser.userId) : null,
      );
      const updated = await this.adminRepo.findWithdrawalById(rawWithdrawalId);
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

    const formatResponse = (
      withdrawalRecord: any,
      outcome: 'PENDING' | 'SUCCESS' | 'FAILED',
      reasonCode: string,
      payoutId: string | null,
      message: string,
    ) => ({
      withdrawal: WalletMapper.toWithdrawalDto(withdrawalRecord),
      reconciliation: {
        outcome,
        reasonCode,
        payoutId: payoutId || null,
      },
      message,
    });

    let statusData: any = null;
    let targetPayout: any = null;
    let expectedPayoutId: string | null = withdrawal.providerPayoutId ? String(withdrawal.providerPayoutId).trim() : null;

    if (withdrawal.providerPayoutId) {
      try {
        statusData = await this.payosPayoutService.getPayout(withdrawal.providerPayoutId);
        targetPayout = statusData?.data;
      } catch (err: any) {
        return formatResponse(
          withdrawal,
          'PENDING',
          'PROVIDER_LOOKUP_ERROR',
          expectedPayoutId,
          'Lỗi khi lấy chi tiết payout từ provider. Giữ trạng thái chờ đối soát.',
        );
      }
    } else if (withdrawal.providerReferenceId) {
      try {
        statusData = await this.payosPayoutService.getPayouts({ referenceId: withdrawal.providerReferenceId });
      } catch (err: any) {
        return formatResponse(
          withdrawal,
          'PENDING',
          'PROVIDER_LIST_ERROR',
          null,
          'Lỗi khi tra cứu danh sách payouts từ provider. Giữ trạng thái chờ đối soát.',
        );
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
          return formatResponse(
            withdrawal,
            'PENDING',
            'PAYOUT_ID_MISSING',
            null,
            'Bản ghi payout không có ID chi tiết từ provider, không thể xác thực an toàn. Giữ trạng thái chờ đối soát.',
          );
        }
        expectedPayoutId = String(found.id).trim();
        try {
          const detailRes = await this.payosPayoutService.getPayout(found.id);
          targetPayout = detailRes?.data;
          if (!targetPayout) {
            return formatResponse(
              withdrawal,
              'PENDING',
              'PAYOUT_DETAIL_EMPTY',
              expectedPayoutId,
              'Phản hồi chi tiết payout từ provider rỗng, không dùng bản tóm tắt thay thế. Giữ trạng thái chờ đối soát.',
            );
          }
        } catch (err: any) {
          return formatResponse(
            withdrawal,
            'PENDING',
            'PAYOUT_DETAIL_ERROR',
            expectedPayoutId,
            'Lỗi khi lấy chi tiết payout từ provider. Không dùng bản tóm tắt thay thế, giữ trạng thái chờ đối soát.',
          );
        }
      } else {
        const isNone = matched.length === 0;
        return formatResponse(
          withdrawal,
          'PENDING',
          isNone ? 'NO_MATCHED_PAYOUT' : 'MULTIPLE_MATCHED_PAYOUTS',
          null,
          isNone
            ? 'Không tìm thấy giao dịch payout phù hợp với referenceId trên PayOS, giữ trạng thái chờ đối soát'
            : 'Có nhiều hơn một payout trùng referenceId trên PayOS, giữ trạng thái chờ đối soát thủ công',
        );
      }
    } else {
      return formatResponse(
        withdrawal,
        'PENDING',
        'NO_PAYOUT_REFERENCE',
        null,
        'Chưa có thông tin provider reference id hoặc payout id',
      );
    }

    if (!targetPayout) {
      return formatResponse(
        withdrawal,
        'PENDING',
        'PAYOUT_DETAIL_EMPTY',
        expectedPayoutId,
        'Không thể trích xuất dữ liệu chi tiết payout từ provider. Giữ trạng thái chờ đối soát.',
      );
    }

    const verifiedPayoutId = String(targetPayout.id || '').trim();
    if (!verifiedPayoutId) {
      return formatResponse(
        withdrawal,
        'PENDING',
        'PAYOUT_ID_MISSING',
        null,
        'Thiếu thông tin payout ID từ cổng thanh toán. Giữ trạng thái chờ đối soát.',
      );
    }

    const netAmount = withdrawal.netAmount !== null && withdrawal.netAmount !== undefined
      ? Math.round(Number(withdrawal.netAmount))
      : Math.round(Number(withdrawal.amount) - Number(withdrawal.fee || 0));

    const criteria: PayosPayoutExpectedCriteria = {
      amount: netAmount,
      payoutReference: withdrawal.providerReferenceId || withdrawal.withdrawalCode,
      targetBankBin: withdrawal.bankBinSnapshot || withdrawal.bankCode,
      targetAccountHash: withdrawal.bankAccountHash,
      expectedPayoutId: expectedPayoutId || undefined,
    };

    const successVerif = verifyPayosPayoutEvidence(targetPayout, criteria);
    if (successVerif.isVerified) {
      await this.adminRepo.finalizeSucceededWithdrawalTransaction(
        rawWithdrawalId,
        successVerif.providerPayoutId,
      );
      await this.invalidateAdminAndStoreCaches(withdrawal.storeId);
      const fresh = await this.adminRepo.findWithdrawalById(rawWithdrawalId);
      return formatResponse(
        fresh || withdrawal,
        'SUCCESS',
        'PAYOUT_VERIFIED_SUCCESS',
        successVerif.providerPayoutId,
        'Xác thực payout thành công, đã khấu trừ số dư đóng băng và hoàn tất giao dịch rút tiền.',
      );
    }

    const rejectionVerif = verifyPayosPayoutRejectionEvidence(targetPayout, criteria);
    if (rejectionVerif.isVerified) {
      await this.adminRepo.refundFailedWithdrawalTransaction(
        rawWithdrawalId,
        `PayOS xác nhận chi hộ thất bại: ${rejectionVerif.reason || 'REJECTED'}`,
      );
      await this.invalidateAdminAndStoreCaches(withdrawal.storeId);
      const fresh = await this.adminRepo.findWithdrawalById(rawWithdrawalId);
      return formatResponse(
        fresh || withdrawal,
        'FAILED',
        'PAYOUT_TERMINAL_FAILURE',
        rejectionVerif.providerPayoutId,
        'PayOS xác nhận chi hộ thất bại, đã hoàn tiền về ví cửa hàng thành công.',
      );
    }

    return formatResponse(
      withdrawal,
      'PENDING',
      'PENDING_TERMINAL_CONFIRMATION',
      verifiedPayoutId,
      successVerif.reason || rejectionVerif.reason || 'Giao dịch payout đang ở trạng thái trung gian, tiếp tục chờ đối soát.',
    );
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
