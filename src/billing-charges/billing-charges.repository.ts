import { Injectable, Inject, NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface CreateChargeInput {
  rentalId?: bigint;
  storeId?: bigint;
  customerId?: bigint;
  purpose: 'RENTAL_INITIAL' | 'RENTAL_EXTENSION' | 'STORE_SUBSCRIPTION';
  targetType: 'RENTAL' | 'STORE';
  targetId: bigint;
  totalAmount: number;
  lines: Array<{
    lineType: 'RENT' | 'DEPOSIT' | 'STORE_SUBSCRIPTION';
    amount: number;
    description?: string;
    durationUnit?: string;
    durationCount?: number;
    quantity?: number;
    unitPrice?: number;
  }>;
  paymentMethod?: string;
  qrCode?: string;
  paymentLinkId?: string;
  checkoutUrl?: string;
}

export interface VerifiedPaymentReceipt {
  provider: string;
  providerTransactionCode: string;
  amount: number;
  currency: string;
  paidAt?: Date;
  verified: true;
  metadata?: Record<string, any>;
}

@Injectable()
export class BillingChargesRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async createChargeWithLines(data: CreateChargeInput) {
    const chargeCode = `CHG-${data.purpose}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

    return this.prisma.billingCharge.create({
      data: {
        chargeCode,
        purpose: data.purpose,
        targetType: data.targetType,
        targetId: data.targetId,
        currency: 'VND',
        totalAmount: data.totalAmount,
        status: 'PENDING',
        paymentMethod: data.paymentMethod,
        qrCode: data.qrCode,
        paymentLinkId: data.paymentLinkId,
        checkoutUrl: data.checkoutUrl,
        lines: {
          create: data.lines.map((l) => ({
            lineType: l.lineType,
            amount: l.amount,
            description: l.description,
            durationUnit: l.durationUnit || (l.durationCount ? 'MONTH' : null),
            durationCount: l.durationCount || null,
            quantity: l.quantity || 1,
            unitPrice: l.unitPrice || l.amount,
          })),
        },
      },
      include: {
        lines: true,
      },
    });
  }

  async findChargeById(chargeId: bigint) {
    return this.prisma.billingCharge.findUnique({
      where: { chargeId },
      include: { lines: true },
    });
  }

  async findRentalWithCustomer(rentalId: bigint) {
    return this.prisma.buttonRental.findUnique({
      where: { rentalId },
      include: { customer: true },
    });
  }

  async findChargeByCode(chargeCode: string) {
    return this.prisma.billingCharge.findUnique({
      where: { chargeCode },
      include: { lines: true },
    });
  }

  async settleChargeAtomicTx(
    chargeId: bigint,
    receipt: VerifiedPaymentReceipt,
    actor?: { userId?: bigint; role?: string; ipAddress?: string },
  ) {
    if (!receipt || typeof receipt !== 'object' || (receipt as any).verified !== true) {
      throw new BadRequestException('Chỉ chấp nhận biên lai thanh toán đã được xác minh từ cổng thanh toán (verified: true)');
    }

    if (!receipt.providerTransactionCode || receipt.providerTransactionCode.trim().length === 0) {
      throw new BadRequestException('Mã giao dịch đối soát của cổng thanh toán (providerTransactionCode) là bắt buộc để xác nhận thu tiền');
    }

    if (typeof receipt.amount !== 'number' || isNaN(receipt.amount) || receipt.amount <= 0) {
      throw new BadRequestException('Số tiền thanh toán trong biên lai (amount) là bắt buộc và phải là số dương');
    }

    if (!receipt.currency || receipt.currency.trim().length === 0) {
      throw new BadRequestException('Tiền tệ thanh toán trong biên lai (currency) là bắt buộc');
    }

    return this.prisma.$transaction(async (tx) => {
      // 1. Khóa bi-quan bản ghi BillingCharge
      const lockedCharges = await tx.$queryRawUnsafe<any[]>(
        'SELECT * FROM billing_charges WHERE charge_id = $1 FOR UPDATE',
        chargeId,
      );
      if (!lockedCharges || lockedCharges.length === 0) {
        throw new NotFoundException(`Billing charge #${chargeId} not found`);
      }
      const rawCharge = lockedCharges[0];

      if (rawCharge.status === 'PAID') {
        const fullCharge = await tx.billingCharge.findUnique({
          where: { chargeId },
          include: { lines: true },
        });
        return {
          alreadySettled: true,
          charge: fullCharge,
          storeWalletCredited: false,
        };
      }

      // Đối chiếu số tiền bắt buộc
      if (Math.abs(Number(receipt.amount) - Number(rawCharge.total_amount)) > 0.01) {
        throw new BadRequestException(`Số tiền thanh toán thực tế (${receipt.amount}) không khớp với khoản thu (${rawCharge.total_amount})`);
      }

      // Đối chiếu tiền tệ bắt buộc
      if (receipt.currency.trim().toUpperCase() !== rawCharge.currency.trim().toUpperCase()) {
        throw new BadRequestException(`Tiền tệ thanh toán (${receipt.currency}) không khớp với khoản thu (${rawCharge.currency})`);
      }

      // Kiểm tra tính duy nhất của biên lai giao dịch: một mã giao dịch không được thanh toán cho 2 charge khác nhau
      const existingTx = await tx.$queryRawUnsafe<any[]>(
        'SELECT charge_id, charge_code FROM billing_charges WHERE provider_transaction_code = $1 AND charge_id <> $2 AND status = \'PAID\'',
        receipt.providerTransactionCode,
        chargeId,
      );
      if (existingTx && existingTx.length > 0) {
        throw new BadRequestException(`Mã giao dịch ${receipt.providerTransactionCode} đã được sử dụng để thanh toán cho khoản thu #${existingTx[0].charge_code}`);
      }

      const lines = await tx.billingChargeLine.findMany({
        where: { chargeId },
      });

      // 2. Mark charge as PAID với providerTransactionCode duy nhất
      const updatedCharge = await tx.billingCharge.update({
        where: { chargeId },
        data: {
          status: 'PAID',
          paidAt: receipt.paidAt || new Date(),
          providerTransactionCode: receipt.providerTransactionCode,
        },
        include: { lines: true },
      });

      let settledDeposit: any = null;
      let subscriptionUpdated: any = null;
      let rentalUpdated: any = null;

      // Handle RENTAL_INITIAL settlement
      if (rawCharge.purpose === 'RENTAL_INITIAL') {
        const rentalId = BigInt(rawCharge.target_id);
        const depositLine = lines.find((l) => l.lineType === 'DEPOSIT');
        const depositAmount = depositLine ? Number(depositLine.amount) : 0;

        // 1. Record deposit in dedicated rental_deposits ledger
        settledDeposit = await tx.rentalDeposit.upsert({
          where: { rentalId },
          create: {
            rentalId,
            collectedAmount: depositAmount,
            heldAmount: depositAmount,
            refundReservedAmount: 0,
            refundedAmount: 0,
          },
          update: {
            collectedAmount: depositAmount,
            heldAmount: depositAmount,
          },
        });

        // 2. Cập nhật rental: trạng thái PENDING_HANDOVER, KHÔNG đếm lùi ngày trước khi bàn giao!
        // effectiveExpiresAt và paidThrough giữ nguyên null để bắt đầu đếm lùi khi bàn giao
        rentalUpdated = await tx.buttonRental.update({
          where: { rentalId },
          data: {
            status: 'PENDING_HANDOVER',
            paidThrough: null,
            effectiveExpiresAt: null,
          },
        });
      } else if (rawCharge.purpose === 'RENTAL_EXTENSION') {
        const rentalId = BigInt(rawCharge.target_id);
        // Khóa bi-quan hợp đồng thuê để cộng dồn an toàn
        const lockedRentals = await tx.$queryRawUnsafe<any[]>(
          'SELECT * FROM button_rentals WHERE rental_id = $1 FOR UPDATE',
          rentalId,
        );
        if (!lockedRentals || lockedRentals.length === 0) {
          throw new NotFoundException(`Hợp đồng thuê #${rentalId} không tồn tại`);
        }
        const rental = lockedRentals[0];

        // Lấy số tháng gia hạn từ dữ liệu cấu trúc (dòng charge hoặc metadata)
        const rentLine = lines.find((l) => l.lineType === 'RENT');
        let durationMonths = rentLine?.durationCount || 1;
        if (!rentLine?.durationCount && rentLine?.description) {
          const match = rentLine.description.match(/months:\s*(\d+)/i) || rentLine.description.match(/(\d+)\s*tháng/i);
          if (match) {
            durationMonths = parseInt(match[1], 10);
          }
        }
        const additionalMs = durationMonths * 30 * 24 * 60 * 60 * 1000;

        const newMonthsRented = Number(rental.months_rented || 0) + durationMonths;

        if (rental.status === 'PENDING_HANDOVER') {
          // R03/R04: Nếu hợp đồng chưa bàn giao (PENDING_HANDOVER), thanh toán gia hạn giữ nguyên PENDING_HANDOVER!
          // KHÔNG kích hoạt ACTIVE và KHÔNG đếm lùi ngày trước khi bàn giao thực tế.
          rentalUpdated = await tx.buttonRental.update({
            where: { rentalId },
            data: {
              status: 'PENDING_HANDOVER',
              monthsRented: newMonthsRented,
            },
          });
        } else {
          // Đang hoạt động: Cộng nối tiếp từ effectiveExpiresAt hiện tại nếu còn hạn, nếu hết hạn thì tính từ now
          const now = new Date();
          const currentExpiry = rental.effective_expires_at && new Date(rental.effective_expires_at) > now
            ? new Date(rental.effective_expires_at)
            : now;
          const newExpiry = new Date(currentExpiry.getTime() + additionalMs);

          rentalUpdated = await tx.buttonRental.update({
            where: { rentalId },
            data: {
              paidThrough: newExpiry,
              effectiveExpiresAt: newExpiry,
              monthsRented: newMonthsRented,
              status: 'ACTIVE',
            },
          });
        }
      } else if (rawCharge.purpose === 'STORE_SUBSCRIPTION') {
        const storeId = BigInt(rawCharge.target_id);
        // Khóa bi quan gian hàng
        await tx.$queryRawUnsafe('SELECT * FROM store WHERE store_id = $1 FOR UPDATE', storeId);

        const plan = await tx.subscriptionPlan.findFirst({
          where: { price: 60000, isActive: true },
        });

        if (!plan) {
          throw new NotFoundException('Không tìm thấy gói duy trì kệ 60.000đ/tháng đang hoạt động');
        }

        const now = new Date();
        // Kiểm tra subscription hiện tại của store xem còn hạn không
        const currentSub = await tx.storeSubscription.findFirst({
          where: {
            storeId,
            status: 'ACTIVE',
            endDate: { gt: now },
          },
          orderBy: { endDate: 'desc' },
        });

        const startDate = currentSub ? currentSub.endDate : now;
        const endDate = new Date(startDate.getTime() + 30 * 24 * 60 * 60 * 1000);

        subscriptionUpdated = await tx.storeSubscription.create({
          data: {
            storeId,
            planId: plan.planId,
            startDate,
            endDate,
            status: 'ACTIVE',
            paymentMethod: rawCharge.payment_method || 'PAYOS',
          },
        });
      }

      // Outbox event recording
      await tx.outboxEvent.create({
        data: {
          eventType: `BILLING_CHARGE_SETTLED`,
          payload: {
            chargeId: rawCharge.charge_id.toString(),
            chargeCode: rawCharge.charge_code,
            purpose: rawCharge.purpose,
            targetId: rawCharge.target_id.toString(),
            totalAmount: Number(rawCharge.total_amount),
            providerTransactionCode: receipt.providerTransactionCode,
          },
          status: 'PENDING',
        },
      });

      // R08: Audit Log recording
      if ((tx as any).rentalAuditLog) {
        await (tx as any).rentalAuditLog.create({
          data: {
            actorType: actor?.role ? (['SUPER_ADMIN', 'SYSTEM_ADMIN', 'ADMIN'].includes(actor.role) ? 'ADMIN' : 'USER') : 'SYSTEM',
            actorUserId: actor?.userId ? BigInt(actor.userId) : null,
            action: 'SETTLE_CHARGE',
            targetType: rawCharge.target_type,
            targetId: BigInt(rawCharge.target_id),
            beforeState: rawCharge.status,
            afterState: 'PAID',
            amount: rawCharge.total_amount,
            correlationId: rawCharge.charge_code,
            idempotencyKey: receipt.providerTransactionCode,
            metadata: {
              chargeId: rawCharge.charge_id.toString(),
              chargeCode: rawCharge.charge_code,
              provider: receipt.provider,
              providerTransactionCode: receipt.providerTransactionCode,
              currency: receipt.currency,
              paidAt: receipt.paidAt || new Date(),
            },
          },
        });
      }

      return {
        alreadySettled: false,
        charge: updatedCharge,
        status: 'PAID',
        settledDeposit,
        subscriptionUpdated,
        rentalUpdated,
        storeWalletCredited: false, // Critical invariant: StoreWallet is NEVER credited!
      };
    });
  }

  async findChargeByOrderCode(orderCode: string, paymentLinkId?: string) {
    if (!orderCode && !paymentLinkId) return null;
    return this.prisma.billingCharge.findFirst({
      where: {
        OR: [
          ...(orderCode
            ? [
                { providerTransactionCode: orderCode },
                { paymentLinkId: orderCode },
                { chargeCode: orderCode },
              ]
            : []),
          ...(paymentLinkId ? [{ paymentLinkId: paymentLinkId }] : []),
        ],
      },
      include: {
        lines: true,
      },
    });
  }

  async updatePaymentLinkDetails(
    chargeId: bigint,
    details: {
      paymentLinkId: string;
      checkoutUrl: string;
      qrCode?: string;
      providerTransactionCode: string;
    },
  ) {
    return this.prisma.billingCharge.update({
      where: { chargeId },
      data: {
        paymentLinkId: details.paymentLinkId,
        checkoutUrl: details.checkoutUrl,
        qrCode: details.qrCode,
        providerTransactionCode: details.providerTransactionCode,
      },
    });
  }
}


