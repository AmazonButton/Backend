import { Injectable, Inject, NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  recordRentalPayosReceiptInTx,
  recordSubscriptionPayosReceiptInTx,
} from '../store-cash/store-cash-settlement.transaction';
import { runWithTransactionRetry } from '../common/utils/transaction-retry.util';

export interface CreateChargeInput {
  rentalId?: bigint;
  storeId?: bigint;
  customerId?: bigint;
  payerStoreId?: bigint;
  planId?: bigint;
  planSnapshot?: Record<string, any>;
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
  paymentLinkId?: string;
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
        payerStoreId: data.payerStoreId,
        planId: data.planId,
        planSnapshot: data.planSnapshot,
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

  async findActiveStoreById(storeId: bigint) {
    return this.prisma.store.findFirst({
      where: {
        storeId,
        status: 'ACTIVE',
      },
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

    return runWithTransactionRetry(() => this.prisma.$transaction(async (tx) => {
      // 1. Khóa bi-quan bản ghi BillingCharge
      const lockedCharges = await tx.$queryRawUnsafe<any[]>(
        'SELECT * FROM billing_charges WHERE charge_id = $1 FOR UPDATE',
        chargeId,
      );
      if (!lockedCharges || lockedCharges.length === 0) {
        throw new NotFoundException(`Billing charge #${chargeId} not found`);
      }
      const rawCharge = lockedCharges[0];

      if (['RENTAL_INITIAL', 'RENTAL_EXTENSION'].includes(rawCharge.purpose)) {
        const result = await recordRentalPayosReceiptInTx(tx, rawCharge, receipt, actor);
        const charge = await tx.billingCharge.findUnique({ where: { chargeId }, include: { lines: true } });
        const rentalUpdated = (rawCharge.target_type === 'RENTAL' && rawCharge.target_id)
          ? await tx.buttonRental.findUnique({ where: { rentalId: BigInt(rawCharge.target_id) } })
          : null;
        return {
          ...result,
          charge,
          status: result.overpayment ? 'PENDING_RECONCILIATION' : charge!.status,
          rentalUpdated,
          updatedStatus: rentalUpdated?.status,
          updatedPaidThrough: rentalUpdated?.paidThrough ?? undefined,
        };
      }

      if (rawCharge.purpose === 'STORE_SUBSCRIPTION') {
        const result = await recordSubscriptionPayosReceiptInTx(
          tx,
          rawCharge,
          receipt,
          async () => {
            const changed = await tx.billingCharge.updateMany({
              where: { chargeId, status: 'PENDING' },
              data: {
                status: 'PAID',
                paidAt: receipt.paidAt || new Date(),
                providerTransactionCode: receipt.providerTransactionCode.trim(),
              },
            });
            if (changed.count !== 1) {
              throw new ConflictException('Khoản thu đã được xử lý đồng thời bởi một yêu cầu khác');
            }

            const storeId = BigInt(rawCharge.target_id);
            await tx.$queryRawUnsafe('SELECT * FROM store WHERE store_id = $1 FOR UPDATE', storeId);

            let targetPlanId: bigint | null = null;
            let durationDays = 30;
            let snapshot = rawCharge.plan_snapshot;
            if (typeof snapshot === 'string') {
              try {
                snapshot = JSON.parse(snapshot);
              } catch {
                snapshot = null;
              }
            }

            if (snapshot && snapshot.planId) {
              targetPlanId = BigInt(snapshot.planId);
              if (typeof snapshot.durationDays === 'number' && snapshot.durationDays > 0) {
                durationDays = snapshot.durationDays;
              }
            } else if (rawCharge.plan_id) {
              targetPlanId = BigInt(rawCharge.plan_id);
              const p = await tx.subscriptionPlan.findUnique({ where: { planId: targetPlanId } });
              if (p && p.durationDays) {
                durationDays = p.durationDays;
              }
            } else {
              const fallbackPlan = (await tx.subscriptionPlan.findFirst({
                where: { price: 60000, isActive: true },
              })) || (await tx.subscriptionPlan.findFirst({
                where: { isActive: true },
                orderBy: { planId: 'asc' },
              }));
              if (!fallbackPlan) {
                throw new NotFoundException('Không tìm thấy gói duy trì kệ phù hợp để cấp quyền');
              }
              targetPlanId = fallbackPlan.planId;
              durationDays = fallbackPlan.durationDays || 30;
            }

            const now = new Date();
            const currentSubRows = await tx.$queryRawUnsafe<Array<{ subscription_id: bigint; start_date: Date; end_date: Date }>>(
              `SELECT subscription_id, start_date, end_date
               FROM store_subscriptions
               WHERE store_id = $1 AND status = 'ACTIVE' AND end_date > CURRENT_TIMESTAMP
               ORDER BY end_date DESC
               LIMIT 1
               FOR UPDATE`,
              storeId,
            );
            const currentSub = currentSubRows && currentSubRows.length > 0 ? currentSubRows[0] : null;
            const startDate = currentSub && new Date(currentSub.end_date) > now ? new Date(currentSub.end_date) : now;
            const endDate = new Date(startDate.getTime() + durationDays * 24 * 60 * 60 * 1000);

            const createdSub = await tx.storeSubscription.create({
              data: {
                storeId,
                planId: targetPlanId,
                startDate,
                endDate,
                status: 'ACTIVE',
                paymentMethod: rawCharge.payment_method || 'PAYOS',
              },
            });

            await tx.outboxEvent.create({
              data: {
                eventType: 'BILLING_CHARGE_SETTLED',
                payload: {
                  chargeId: rawCharge.charge_id.toString(),
                  chargeCode: rawCharge.charge_code,
                  purpose: rawCharge.purpose,
                  targetId: rawCharge.target_id.toString(),
                  totalAmount: Number(rawCharge.total_amount),
                  providerTransactionCode: receipt.providerTransactionCode.trim(),
                },
                status: 'PENDING',
              },
            });

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
                  idempotencyKey: receipt.providerTransactionCode.trim(),
                  metadata: {
                    chargeId: rawCharge.charge_id.toString(),
                    chargeCode: rawCharge.charge_code,
                    provider: receipt.provider,
                    providerTransactionCode: receipt.providerTransactionCode.trim(),
                    currency: receipt.currency,
                    paidAt: receipt.paidAt || new Date(),
                  },
                },
              });
            }

            return createdSub;
          },
          actor,
        );

        const charge = await tx.billingCharge.findUnique({ where: { chargeId }, include: { lines: true } });
        return {
          alreadySettled: result.alreadySettled,
          overpayment: result.overpayment,
          overpaymentRecorded: result.overpaymentRecorded,
          status: result.overpayment ? 'PENDING_RECONCILIATION' : charge!.status,
          charge,
          receipt: result.receipt,
          overpaymentObligation: result.overpaymentObligation ?? null,
          settledDeposit: null,
          subscriptionUpdated: result.subscriptionUpdated ?? null,
          rentalUpdated: null,
          storeWalletCredited: false,
        };
      }

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

      // Rental and Store Subscription charges are handled above by shared receipt ledger helpers.

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
    }), { operationName: 'BillingChargeSettlement' });
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
          ...(paymentLinkId
            ? [
                { paymentLinkId: paymentLinkId },
                { providerTransactionCode: paymentLinkId },
              ]
            : []),
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

  async assignStableOrderCode(chargeId: bigint, proposedOrderCode: string) {
    try {
      await this.prisma.$executeRaw`
        UPDATE billing_charges
        SET provider_transaction_code = ${proposedOrderCode},
            updated_at = NOW()
        WHERE charge_id = ${chargeId}
          AND provider_transaction_code IS NULL
      `;
    } catch (e) {
      // In case of race condition or duplicate, authoritative code remains
    }
    return this.prisma.billingCharge.findUnique({
      where: { chargeId },
      select: {
        providerTransactionCode: true,
        paymentLinkId: true,
        checkoutUrl: true,
        qrCode: true,
        totalAmount: true,
        chargeCode: true,
      },
    });
  }
}


