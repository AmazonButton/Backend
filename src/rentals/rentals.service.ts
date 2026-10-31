import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Inject,
  Optional,
  Logger,
  forwardRef,
} from '@nestjs/common';
import { RentalsRepository } from './rentals.repository';
import { PrismaService } from '../prisma/prisma.service';
import { CreateRentalOrderDto } from './dto/rentals.dto';
import { RentalResponseDto } from './dto/rental-response.dto';
import { RentalExtensionDto } from './dto/rental-extension.dto';
import { DashboardCacheService } from '../common/cache/dashboard-cache.service';
import { PayOSPayoutService } from '../payments/payos-payout.service';
import { BillingChargesService } from '../billing-charges/billing-charges.service';
import { verifyDepositRefundPayoutEvidence } from './deposit-payout-verifier';

@Injectable()
export class RentalsService {
  private readonly logger = new Logger(RentalsService.name);
  private readonly rentalsRepo: RentalsRepository;

  constructor(
    @Inject(RentalsRepository) repoOrPrisma: RentalsRepository | PrismaService,
    @Optional() private readonly cacheService?: DashboardCacheService,
    @Optional() @Inject(PayOSPayoutService) private readonly payosPayoutService?: PayOSPayoutService,
    @Optional() @Inject(forwardRef(() => BillingChargesService)) private readonly billingChargesService?: any,
  ) {
    if (repoOrPrisma && ('listAvailablePackages' in repoOrPrisma || 'findRentalById' in repoOrPrisma || 'findDepositRefundById' in repoOrPrisma)) {
      this.rentalsRepo = repoOrPrisma as RentalsRepository;
    } else {
      this.rentalsRepo = new RentalsRepository(repoOrPrisma as PrismaService);
    }
  }

  private async invalidateRentalCaches(
    customerUserId?: string | number | bigint,
    storeId?: string | number | bigint,
  ) {
    if (!this.cacheService) return;
    try {
      const promises: Promise<void>[] = [
        this.cacheService.invalidatePrefix('admin:dashboard:'),
        this.cacheService.invalidatePrefix('admin:operations'),
      ];
      if (customerUserId != null) {
        const id = customerUserId.toString();
        promises.push(
          this.cacheService.invalidateKey(`customer:dashboard:${id}`),
          this.cacheService.invalidateKey(`customer:rentals:${id}`),
        );
      }
      if (storeId != null) {
        promises.push(this.cacheService.invalidatePrefix(`dash:store:${storeId.toString()}:`));
      }
      await Promise.all(promises);
    } catch (error) {
      this.logger.warn(
        `Failed to invalidate rental caches: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }

  async listAvailablePackages() {
    return this.rentalsRepo.listAvailablePackages();
  }

  async createRentalContract(customerId: string | number | bigint, dto: CreateRentalOrderDto) {
    const rawCustomerId = BigInt(customerId);
    const rawPackageId = BigInt(dto.packageId);

    const pkg = await this.rentalsRepo.findPackageById(rawPackageId);
    if (!pkg || !pkg.isActive) {
      throw new NotFoundException('Gói thuê nút không tồn tại hoặc đã tạm dừng cung cấp');
    }

    const months = Number(dto.monthsRented) || 1;
    const monthlyPrice = Number(pkg.monthlyPrice);
    const depositFee = Number(pkg.depositFee || 0);
    const totalRentAmount = monthlyPrice * months + depositFee;
    const buttonQuantity = (pkg as any).buttonQuantity || 1;
    const depositPerButton = Math.floor(depositFee / buttonQuantity);
    const rentPerButton = Math.floor((monthlyPrice * months) / buttonQuantity);

    const startDate = new Date();
    const endDate = new Date(startDate.getTime() + months * 30 * 24 * 60 * 60 * 1000);
    const rentalCode = `RNT-${Date.now()}-${Math.floor(100 + Math.random() * 900)}`;

    const created = await this.rentalsRepo.createRental({
      rentalCode,
      customerId: rawCustomerId,
      packageId: rawPackageId,
      monthsRented: months,
      totalRentAmount,
      depositAmount: depositFee,
      buttonQuantity,
      depositPerButton,
      rentPerButton,
      startDate,
      endDate,
      status: 'PENDING_PAYMENT',
    });

    await this.invalidateRentalCaches(created.customer?.userId);
    return RentalResponseDto.fromEntity(created);
  }

  async listCustomerRentals(customerId: string | number | bigint) {
    const rawCustomerId = BigInt(customerId);
    const items = await this.rentalsRepo.listCustomerRentals(rawCustomerId);
    return items.map(RentalResponseDto.fromEntity);
  }

  private async verifyRentalOwnership(rentalId: bigint, user: any) {
    const rental = await this.rentalsRepo.findRentalById(rentalId);
    if (!rental) {
      throw new NotFoundException('Hợp đồng thuê không tồn tại');
    }

    const role = user?.role || user?.roleCode;
    const isAdmin = role === 'ADMIN' || role === 'SUPER_ADMIN' || role === 'SYSTEM_ADMIN';
    if (isAdmin) {
      return rental;
    }

    const currentCustomerProfileId = user?.customerProfileId?.toString();
    const currentUserId = (user?.userId || user?.id || user?.sub)?.toString();

    const isCustomerMatch =
      (rental.customerId != null && rental.customerId.toString() === currentCustomerProfileId) ||
      rental.customer?.userId?.toString() === currentUserId;

    if (!isCustomerMatch) {
      throw new ForbiddenException('Bạn không có quyền truy cập vào hợp đồng thuê này');
    }

    return rental;
  }

  async getRentalDetail(rentalIdStr: string | bigint, user: any): Promise<RentalResponseDto> {
    const rentalId = BigInt(rentalIdStr);
    const rental = await this.verifyRentalOwnership(rentalId, user);
    return RentalResponseDto.fromEntity(rental);
  }

  async createRentalPaymentRequest(rentalIdStr: string | bigint, user: any, returnUrl?: string, cancelUrl?: string) {
    const rentalId = BigInt(rentalIdStr);
    const rental = await this.verifyRentalOwnership(rentalId, user);

    if (this.billingChargesService) {
      const initialCharge = await this.rentalsRepo.findInitialChargeByRentalId(rentalId);
      if (initialCharge) {
        return this.billingChargesService.createPayosPaymentRequestForCharge(
          initialCharge.chargeId,
          user,
          returnUrl,
          cancelUrl,
        );
      }
    }

    const amount = Number(rental.totalRentAmount);
    const txCode = `PAY-RNT-${rental.rentalCode}-${Date.now().toString().slice(-4)}`;
    const paymentLinkId = `pl_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    const checkoutUrl = `https://pay.payos.vn/web/${paymentLinkId}`;
    const qrCode = `vietqr://pay?bin=970422&acc=1029384756&amount=${amount}&desc=${txCode}`;

    const tx = await this.rentalsRepo.createRentalPaymentTransaction({
      rentalId,
      amount,
      provider: 'PAYOS',
      paymentMethod: 'QR',
      transactionCode: txCode,
      status: 'PENDING',
      paymentLinkId,
      checkoutUrl,
      qrCode,
    });

    return {
      paymentTransactionId: tx.paymentTransactionId.toString(),
      rentalId: rentalId.toString(),
      rentalCode: rental.rentalCode,
      amount,
      transactionCode: txCode,
      paymentLinkId,
      checkoutUrl,
      qrCode,
      status: 'PENDING',
    };
  }

  async extendRentalContract(
    rentalIdStr: string | bigint,
    dto: RentalExtensionDto,
    user: any,
  ): Promise<any> {
    const rentalId = BigInt(rentalIdStr);
    const rental = await this.verifyRentalOwnership(rentalId, user);

    if (['TERMINATED', 'CANCELLED'].includes(rental.status)) {
      throw new BadRequestException('Không thể gia hạn hợp đồng thuê đã kết thúc hoặc hủy');
    }

    const months = dto.additionalMonths || 1;
    const monthlyPrice = Number(rental.package?.monthlyPrice || 30000);
    const additionalAmount = monthlyPrice * months;

    const buttonQuantity = (rental as any).buttonQuantity || rental.package?.buttonQuantity || 1;
    const charge = await this.rentalsRepo.createRentalExtensionCharge(
      rentalId,
      months,
      additionalAmount,
      monthlyPrice,
      buttonQuantity,
    );

    return {
      rentalId: rentalId.toString(),
      rentalCode: rental.rentalCode,
      status: rental.status,
      chargeId: charge.chargeId.toString(),
      chargeCode: charge.chargeCode,
      totalAmount: additionalAmount,
      months,
      paymentMethod: charge.paymentMethod,
      message: 'Tạo yêu cầu gia hạn thành công. Vui lòng thanh toán để cộng thời hạn thuê.',
    };
  }

  async adjustRentalDurationAdmin(
    rentalIdStr: string | bigint,
    additionalDays: number,
    reason: string,
    adminUser: any,
  ) {
    const rentalId = BigInt(rentalIdStr);
    const rental = await this.rentalsRepo.findRentalById(rentalId);
    if (!rental) throw new NotFoundException('Không tìm thấy hợp đồng thuê');

    if (!reason || reason.trim().length === 0) {
      throw new BadRequestException('Lý do điều chỉnh thời hạn thuê là bắt buộc');
    }

    return this.rentalsRepo.adjustRentalDurationAdminTx(
      rentalId,
      additionalDays,
      reason,
      adminUser,
    );
  }

  async requestRentalReturn(rentalIdStr: string | bigint, user: any): Promise<RentalResponseDto> {
    const rentalId = BigInt(rentalIdStr);
    const rentalForReturn = await this.verifyRentalOwnership(rentalId, user);

    const updated = await this.rentalsRepo.updateRentalStatus(rentalId, 'RETURN_REQUESTED');
    await this.invalidateRentalCaches(rentalForReturn.customer?.userId);
    return RentalResponseDto.fromEntity(updated);
  }

  async assignFulfillmentAndDevicesAdmin(
    rentalIdStr: string | bigint,
    dto: { fulfillmentStoreId: string | number | bigint; buttonIds: Array<string | number | bigint>; notes?: string },
    adminUser: any,
  ) {
    const rentalId = BigInt(rentalIdStr);
    const fulfillmentStoreId = BigInt(dto.fulfillmentStoreId);
    const buttonIds = (dto.buttonIds || []).map((id) => BigInt(id));

    if (buttonIds.length === 0) {
      throw new BadRequestException('Danh sách mã nút bấm (buttonIds) không được rỗng');
    }

    const updated = await this.rentalsRepo.assignFulfillmentAndDevicesAdminTx(
      rentalId,
      fulfillmentStoreId,
      buttonIds,
      adminUser,
    );

    await this.invalidateRentalCaches(updated?.customer?.userId, fulfillmentStoreId);
    return updated;
  }

  async activateRental(rentalId: string | number | bigint, actor?: any) {
    const rawRentalId = BigInt(rentalId);
    const rental = await this.rentalsRepo.findRentalById(rawRentalId);
    if (!rental) throw new NotFoundException('Không tìm thấy hợp đồng thuê');

    if (rental.status !== 'PENDING_HANDOVER' && rental.status !== 'ACTIVE') {
      throw new BadRequestException('Hợp đồng phải ở trạng thái PENDING_HANDOVER và được gán thiết bị trước khi kích hoạt');
    }

    if (rental.status === 'ACTIVE') {
      return RentalResponseDto.fromEntity(rental);
    }

    return this.handoverRental(rawRentalId, actor || { role: 'SYSTEM' });
  }

  async listAllRentalsAdmin(query: { page?: number; pageSize?: number; status?: string }) {
    const page = Math.max(1, Number(query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 20));
    const skip = (page - 1) * pageSize;

    const { total, items } = await this.rentalsRepo.listAllRentalsAdmin({
      skip,
      take: pageSize,
      status: query.status,
    });

    return {
      items: items.map(RentalResponseDto.fromEntity),
      total,
      page,
      pageSize,
    };
  }

  async updateRentalStatusAdmin(rentalIdStr: string | bigint, status: string): Promise<RentalResponseDto> {
    const rentalId = BigInt(rentalIdStr);
    const rental = await this.rentalsRepo.findRentalById(rentalId);
    if (!rental) {
      throw new NotFoundException('Không tìm thấy hợp đồng thuê');
    }

    const ALLOWED_ADMIN_STATUS_TRANSITIONS: Record<string, string[]> = {
      PENDING_PAYMENT: ['CANCELLED'],
      ACTIVE: ['TERMINATED'],
      EXPIRED: ['TERMINATED'],
    };
    const allowed = ALLOWED_ADMIN_STATUS_TRANSITIONS[rental.status] || [];
    if (!allowed.includes(status)) {
      throw new BadRequestException(
        `Chuyển đổi trạng thái từ ${rental.status} sang ${status} không được phép. Trạng thái PENDING_HANDOVER yêu cầu đối soát thanh toán; trạng thái ACTIVE yêu cầu quy trình bàn giao thiết bị.`
      );
    }

    const updated = await this.rentalsRepo.updateRentalStatus(rentalId, status);
    await this.invalidateRentalCaches(rental.customer?.userId);
    return RentalResponseDto.fromEntity(updated);
  }

  async createReturnRequest(
    rentalIdStr: string | bigint,
    buttonIdStr: string | bigint,
    user: any,
  ) {
    const rentalId = BigInt(rentalIdStr);
    const buttonId = BigInt(buttonIdStr);

    const rental = await this.verifyRentalOwnership(rentalId, user);
    const buttonBelongs = rental.buttons?.some((b: any) => b.buttonId.toString() === buttonId.toString());
    if (!buttonBelongs && rental.buttons && rental.buttons.length > 0) {
      throw new BadRequestException('Nút bấm không thuộc hợp đồng thuê này');
    }

    const createdReturn = await this.rentalsRepo.createReturnRequestTx(rentalId, buttonId);
    await this.invalidateRentalCaches(rental.customer?.userId);
    return createdReturn;
  }

  async confirmReturnReceipt(
    returnIdStr: string | bigint,
    user: any,
    inspectionNote?: string,
  ) {
    const returnId = BigInt(returnIdStr);
    return this.rentalsRepo.confirmReturnReceiptTx(returnId, user, inspectionNote);
  }

  async approveDepositRefund(
    refundIdStr: string | bigint,
    adminUser: any,
  ) {
    const refundId = BigInt(refundIdStr);
    return this.rentalsRepo.approveDepositRefundTx(refundId, adminUser);
  }

  async reconcileDepositRefundPayout(
    refundIdStr: string | bigint,
    actor?: any,
    manualProviderReferenceId?: string,
  ) {
    const refundId = BigInt(refundIdStr);
    const refund = await this.rentalsRepo.findDepositRefundById(refundId);
    if (!refund) throw new NotFoundException('Yêu cầu hoàn cọc không tồn tại');

    if (refund.status === 'REFUNDED') {
      return { alreadyConfirmed: true, refund };
    }

    if (refund.status !== 'PENDING_PAYOUT') {
      throw new BadRequestException(`Yêu cầu hoàn cọc không ở trạng thái PENDING_PAYOUT (hiện tại: ${refund.status})`);
    }

    // P0 Invariant: Khi admin cung cấp mã manualProviderReferenceId, ƯU TIÊN DÙNG MÃ ĐÓ để đối soát.
    // Nếu admin không truyền mã mới, dùng mã đã lưu trong DB (refund.providerReferenceId).
    const providerRef = (manualProviderReferenceId?.trim() || refund.providerReferenceId)?.trim();
    if (!providerRef) {
      throw new BadRequestException('Yêu cầu hoàn cọc chưa có mã tham chiếu giao dịch chi trả (providerReferenceId). Vui lòng cung cấp mã payout ID thật từ PayOS để đối soát.');
    }

    if (!this.payosPayoutService) {
      throw new BadRequestException('Dịch vụ chi hộ PayOSPayoutService chưa sẵn sàng để đối soát');
    }

    const payoutInfo = await this.payosPayoutService.getPayout(providerRef);
    if (!payoutInfo || payoutInfo.code !== '00') {
      throw new BadRequestException(`Không tìm thấy hoặc không thể tra cứu giao dịch chi trả trên cổng thanh toán: ${payoutInfo?.desc || 'Lỗi không xác định'}`);
    }

    const verification = verifyDepositRefundPayoutEvidence(payoutInfo.data, {
      ...refund,
      providerReferenceId: providerRef,
    });
    if (!verification.isVerified) {
      if (verification.reason?.includes('chưa hoàn tất')) {
        return {
          success: false,
          status: refund.status,
          message: `${verification.reason}. Tiền cọc tiếp tục được giữ an toàn ở quỹ dự phòng (refund_reserved_amount).`,
          data: refund,
        };
      }
      throw new BadRequestException(verification.reason);
    }

    return this.rentalsRepo.confirmDepositRefundPayoutTx(refundId, verification.providerRef, actor);
  }

  async confirmDepositRefundPayout(
    refundIdStr: string | bigint,
    actor?: any,
    manualProviderReferenceId?: string,
  ) {
    return this.reconcileDepositRefundPayout(refundIdStr, actor, manualProviderReferenceId);
  }

  async handoverRental(
    rentalIdStr: string | bigint,
    user: any,
    handoverDate?: Date,
  ) {
    const rentalId = BigInt(rentalIdStr);
    const result = await this.rentalsRepo.handoverRentalButtonsTx(rentalId, user, handoverDate);
    const rental = await this.rentalsRepo.findRentalById(rentalId);
    await this.invalidateRentalCaches(rental?.customer?.userId);
    return result;
  }
}
