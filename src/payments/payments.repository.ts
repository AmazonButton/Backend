import { Injectable, Optional, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Decimal } from '@prisma/client/runtime/library';
import { runWithTransactionRetry } from '../common/utils/transaction-retry.util';
import { PaymentRefundsRepository } from './payment-refunds.repository';
import { InboundPaymentSourceMeta } from './payment-source-evidence.util';

@Injectable()
export class PaymentsRepository {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly paymentRefundsRepo?: PaymentRefundsRepository,
  ) {}

  private getRefundsRepo(): PaymentRefundsRepository {
    return this.paymentRefundsRepo || new PaymentRefundsRepository(this.prisma);
  }

  async createTransaction(data: {
    orderId: bigint;
    provider: string;
    transactionCode: string;
    amount: number | Decimal;
    paymentMethod: string;
    status: string;
  }) {
    return this.prisma.paymentTransaction.create({
      data: {
        orderId: data.orderId,
        provider: data.provider,
        transactionCode: data.transactionCode,
        amount: new Decimal(data.amount),
        paymentMethod: data.paymentMethod,
        status: data.status,
      },
    });
  }

  async findTransactionsByOrderId(orderId: bigint) {
    return this.prisma.paymentTransaction.findMany({
      where: { orderId },
      orderBy: { paymentTransactionId: 'desc' },
    });
  }

  async findTransactionById(transactionId: bigint) {
    return this.prisma.paymentTransaction.findUnique({
      where: { paymentTransactionId: transactionId },
      include: { order: true },
    });
  }

  async findTransactionByCode(transactionCode: string) {
    return this.prisma.paymentTransaction.findFirst({
      where: { transactionCode },
      include: { order: true },
    });
  }

  async updateTransactionStatus(
    transactionId: bigint,
    status: string,
    paidAt?: Date,
  ) {
    if (status === 'FAILED') {
      return this.markTransactionFailedIfPendingAtomicTx(transactionId);
    }

    return this.prisma.paymentTransaction.update({
      where: { paymentTransactionId: transactionId },
      data: {
        status,
        ...(paidAt ? { paidAt } : {}),
      },
    });
  }

  /**
   * Monotonic CAS + canonical row-lock (orders -> payment_transaction) for transitioning
   * a transaction to FAILED strictly from PENDING. Terminal or reconciled states
   * (PAID, REFUND_PENDING, REFUNDED, CANCELLED) can never be overwritten.
   */
  async markTransactionFailedIfPendingAtomicTx(paymentTransactionId: bigint) {
    return runWithTransactionRetry(
      () =>
        this.prisma.$transaction(async (tx) => {
          const refs = await tx.$queryRawUnsafe<any[]>(
            `SELECT payment_transaction_id, order_id FROM payment_transaction WHERE payment_transaction_id = $1`,
            paymentTransactionId,
          );
          if (!refs || refs.length === 0) {
            return null;
          }
          const resolvedOrderId = refs[0].order_id;
          if (resolvedOrderId != null) {
            await tx.$queryRawUnsafe<any[]>(
              `SELECT order_id FROM orders WHERE order_id = $1 FOR UPDATE`,
              resolvedOrderId,
            );
          }
          const lockedPayments = await tx.$queryRawUnsafe<any[]>(
            `SELECT * FROM payment_transaction WHERE payment_transaction_id = $1 FOR UPDATE`,
            paymentTransactionId,
          );
          const locked = lockedPayments?.[0];
          if (!locked) {
            return null;
          }
          if (locked.status !== 'PENDING') {
            return this.findTransactionByIdTx(tx, paymentTransactionId);
          }

          await tx.paymentTransaction.updateMany({
            where: {
              paymentTransactionId,
              status: 'PENDING',
            },
            data: { status: 'FAILED' },
          });

          return this.findTransactionByIdTx(tx, paymentTransactionId);
        }),
      { operationName: 'markTransactionFailedIfPendingAtomicTx' },
    );
  }

  async updatePaymentLinkId(paymentTransactionId: bigint, paymentLinkId: string) {
    return this.prisma.paymentTransaction.update({
      where: { paymentTransactionId },
      data: { paymentLinkId },
    });
  }

  async updateOrderStatus(orderId: bigint, orderStatus: string, paymentStatus?: string) {
    return this.prisma.order.update({
      where: { orderId },
      data: {
        orderStatus,
        ...(paymentStatus ? { paymentStatus } : {}),
      },
    });
  }

  async findOrderById(orderId: bigint) {
    return this.prisma.order.findUnique({
      where: { orderId },
      include: { store: true, customer: true },
    });
  }

  async findUnreconciledLegacyBackfill(paymentTransactionId: bigint) {
    return this.prisma.paymentOrderReceipt.findFirst({
      where: {
        paymentTransactionId,
        channel: 'LEGACY_BACKFILL',
      },
      select: {
        receiptId: true,
        amount: true,
        paymentLinkId: true,
        providerTransactionRef: true,
      },
      orderBy: { receiptId: 'asc' },
    });
  }

  async confirmPaymentAtomicTx(
    paymentTransactionId: bigint,
    inbound?: InboundPaymentSourceMeta | null,
    options?: {
      legacyProviderVerdict?: 'PROVEN_REPLAY' | 'PROVEN_INDEPENDENT_EXCESS' | 'UNVERIFIED';
    },
  ) {
    return runWithTransactionRetry(
      () =>
        this.prisma.$transaction(async (tx) => {
          // 0. Non-locking lookup to resolve parent order_id so locks follow canonical orders -> payment_transaction order
          const txRefs = await tx.$queryRawUnsafe<any[]>(
            `SELECT payment_transaction_id, order_id FROM payment_transaction WHERE payment_transaction_id = $1`,
            paymentTransactionId,
          );
          if (!txRefs || txRefs.length === 0) {
            throw new NotFoundException('Không tìm thấy giao dịch thanh toán');
          }
          const resolvedOrderId = txRefs[0].order_id;
          if (resolvedOrderId == null) {
            throw new NotFoundException('Không tìm thấy đơn hàng tương ứng');
          }

          // 1. Canonical lock order FIRST: Pessimistic lock parent orders row
          const lockedOrders = await tx.$queryRawUnsafe<any[]>(
            `SELECT * FROM orders WHERE order_id = $1 FOR UPDATE`,
            resolvedOrderId,
          );
          if (!lockedOrders || lockedOrders.length === 0) {
            throw new NotFoundException('Không tìm thấy đơn hàng tương ứng');
          }

          // 2. Canonical lock order SECOND: Pessimistic lock payment_transaction row
          const lockedPayments = await tx.$queryRawUnsafe<any[]>(
            `SELECT * FROM payment_transaction WHERE payment_transaction_id = $1 FOR UPDATE`,
            paymentTransactionId,
          );
          if (!lockedPayments || lockedPayments.length === 0) {
            throw new NotFoundException('Không tìm thấy giao dịch thanh toán');
          }

          // 3. Re-read authoritative state strictly AFTER both locks are held
          const order = lockedOrders[0];
          const payment = lockedPayments[0];
          if (String(payment.order_id) !== String(order.order_id)) {
            throw new BadRequestException('Giao dịch thanh toán không khớp với đơn hàng đã khóa');
          }

          const withOutcome = (
            entity: any,
            outcome: { wasAlreadySettled?: boolean; amountMismatch?: boolean },
          ) => {
            if (entity && typeof entity === 'object') {
              Object.defineProperty(entity, '__webhookOutcome', {
                value: outcome,
                enumerable: false,
                configurable: true,
              });
            }
            return entity;
          };

          const canRecordReceipts =
            typeof (tx as any)?.paymentOrderReceipt?.findUnique === 'function';

          const inboundAmount =
            inbound?.amount !== undefined && inbound?.amount !== null
              ? Number(inbound.amount)
              : Number(payment.amount);

          // Already settled or marked excess: only merge LEGACY_BACKFILL when provider proof explicitly confirms
          // single historical replay; otherwise preserve legacy placeholder & classify excess or awaiting reconciliation safely.
          if (['PAID', 'REFUND_PENDING', 'REFUNDED'].includes(payment.status)) {
            if (canRecordReceipts && inbound?.providerTransactionRef?.trim()) {
              const ref = inbound.providerTransactionRef.trim();
              const legacyVerdict = options?.legacyProviderVerdict ?? 'UNVERIFIED';

              const existingReceipt = await tx.paymentOrderReceipt.findUnique({
                where: {
                  provider_channel_providerTransactionRef: {
                    provider: 'PAYOS',
                    channel: 'ORDER_PAYMENT_LINK',
                    providerTransactionRef: ref,
                  },
                },
                include: { refundObligation: true },
              });

              const legacyPlaceholder = await tx.paymentOrderReceipt.findFirst({
                where: {
                  paymentTransactionId: payment.payment_transaction_id,
                  channel: 'LEGACY_BACKFILL',
                },
                include: { refundObligation: true },
                orderBy: { receiptId: 'asc' },
              });

              if (existingReceipt) {
                const replayCheck = await this.getRefundsRepo().recordReceiptAndMaybeObligationInTx(tx, {
                  order,
                  payment,
                  classification: existingReceipt.classification as any,
                  inbound,
                  ...(existingReceipt.classification === 'LEGACY_UNCLASSIFIED' &&
                  !existingReceipt.refundObligation
                    ? { skipObligationCreation: true }
                    : {}),
                });

                if (
                  !replayCheck.conflict &&
                  legacyPlaceholder &&
                  existingReceipt.classification === 'LEGACY_UNCLASSIFIED' &&
                  !existingReceipt.refundObligation
                ) {
                  if (
                    legacyVerdict === 'PROVEN_REPLAY' &&
                    Math.round(inboundAmount) === Math.round(Number(legacyPlaceholder.amount))
                  ) {
                    await tx.paymentOrderReceipt.delete({
                      where: { receiptId: existingReceipt.receiptId },
                    });
                    await this.getRefundsRepo().reconcileLegacyBackfillReceiptInTx(tx, {
                      receipt: legacyPlaceholder,
                      order,
                      payment,
                      inbound,
                    });
                    await tx.orderStatusHistory.create({
                      data: {
                        orderId: BigInt(payment.order_id),
                        oldStatus: order.order_status,
                        newStatus: order.order_status,
                        reason: `Đối soát từ PayOS xác nhận ${ref} (${inboundAmount.toLocaleString('vi-VN')} VND) là giao dịch duy nhất của bản ghi backfill #${legacyPlaceholder.receiptId}; đã hợp nhất nguyên tử.`,
                      },
                    });
                  } else if (legacyVerdict === 'PROVEN_INDEPENDENT_EXCESS') {
                    const promoted = await tx.paymentOrderReceipt.update({
                      where: { receiptId: existingReceipt.receiptId },
                      data: { classification: 'EXCESS_DUPLICATE' },
                    });
                    await this.getRefundsRepo().createObligationForReceiptInTx(tx, {
                      order: {
                        orderId: BigInt(order.order_id),
                        customerId: order.customer_id != null ? BigInt(order.customer_id) : null,
                      },
                      receipt: promoted,
                      sourcePaymentTransactionId: paymentTransactionId,
                      obligationType: 'EXCESS_DUPLICATE',
                    });
                    await tx.orderStatusHistory.create({
                      data: {
                        orderId: BigInt(payment.order_id),
                        oldStatus: order.order_status,
                        newStatus: order.order_status,
                        reason: `Đối soát từ PayOS xác nhận ${ref} (${inboundAmount.toLocaleString('vi-VN')} VND) là giao dịch chuyển thừa độc lập ngoài bản ghi backfill #${legacyPlaceholder.receiptId}; đã chuyển EXCESS_DUPLICATE.`,
                      },
                    });
                  }
                }
              } else if (legacyPlaceholder) {
                if (
                  legacyVerdict === 'PROVEN_REPLAY' &&
                  Math.round(inboundAmount) === Math.round(Number(legacyPlaceholder.amount))
                ) {
                  await this.getRefundsRepo().reconcileLegacyBackfillReceiptInTx(tx, {
                    receipt: legacyPlaceholder,
                    order,
                    payment,
                    inbound,
                  });

                  await tx.orderStatusHistory.create({
                    data: {
                      orderId: BigInt(payment.order_id),
                      oldStatus: order.order_status,
                      newStatus: order.order_status,
                      reason: `Đối soát PayOS xác nhận hợp nhất chứng từ backfill #${legacyPlaceholder.receiptId} với giao dịch ${ref} (${inboundAmount.toLocaleString('vi-VN')} VND); không tạo khoản thu dư giả.`,
                    },
                  });
                } else if (legacyVerdict === 'PROVEN_INDEPENDENT_EXCESS') {
                  await this.getRefundsRepo().recordReceiptAndMaybeObligationInTx(tx, {
                    order,
                    payment,
                    classification: 'EXCESS_DUPLICATE',
                    inbound,
                  });

                  await tx.orderStatusHistory.create({
                    data: {
                      orderId: BigInt(payment.order_id),
                      oldStatus: order.order_status,
                      newStatus: order.order_status,
                      reason: `Đối soát PayOS xác nhận khoản chuyển thừa độc lập (${ref}, ${inboundAmount.toLocaleString('vi-VN')} VND) tách biệt khỏi bản ghi backfill #${legacyPlaceholder.receiptId}; đã tạo nghĩa vụ hoàn dư EXCESS_DUPLICATE.`,
                    },
                  });
                } else {
                  await this.getRefundsRepo().recordReceiptAndMaybeObligationInTx(tx, {
                    order,
                    payment,
                    classification: 'LEGACY_UNCLASSIFIED',
                    inbound,
                    skipObligationCreation: true,
                  });

                  await tx.orderStatusHistory.create({
                    data: {
                      orderId: BigInt(payment.order_id),
                      oldStatus: order.order_status,
                      newStatus: order.order_status,
                      reason: `Chứng từ PayOS (${ref}, ${inboundAmount.toLocaleString('vi-VN')} VND) chưa đủ bằng chứng đối soát từ PayOS để phân biệt replay hay chuyển thừa ngoài bản ghi LEGACY_BACKFILL #${legacyPlaceholder.receiptId}; giữ chứng từ LEGACY_UNCLASSIFIED chờ đối soát, chưa nâng nguồn hay chi hoàn tự động.`,
                    },
                  });
                }
              } else {
                await this.getRefundsRepo().recordReceiptAndMaybeObligationInTx(tx, {
                  order,
                  payment,
                  classification: 'EXCESS_DUPLICATE',
                  inbound,
                });

                await tx.orderStatusHistory.create({
                  data: {
                    orderId: BigInt(payment.order_id),
                    oldStatus: order.order_status,
                    newStatus: order.order_status,
                    reason: `Nhận khoản chuyển khoản dư độc lập (${ref}, ${inboundAmount.toLocaleString('vi-VN')} VND) trên liên kết PayOS đã thanh toán (#${paymentTransactionId}); đã tạo chứng từ thu và nghĩa vụ hoàn tiền dư riêng biệt.`,
                  },
                });
              }
            }
            return withOutcome(await this.findTransactionByIdTx(tx, paymentTransactionId), {
              wasAlreadySettled: true,
            });
          }

          // NV-11: If payment was CANCELLED or FAILED, but PayOS webhook arrives with verified payment,
          // allow recording funds received and reconcile against active siblings/order status safely.
          if (!['PENDING', 'FAILED', 'CANCELLED'].includes(payment.status)) {
            throw new BadRequestException(`Không thể xác nhận giao dịch đang ở trạng thái ${payment.status}`);
          }

          // Item E + F2 Fix: Check if an active sibling payment transaction already occupies uq_payment_active_per_order
          const activeSibling = await tx.paymentTransaction.findFirst({
            where: {
              orderId: payment.order_id,
              status: { in: ['PENDING', 'PAID'] },
              paymentTransactionId: { not: paymentTransactionId },
            },
          });

          if (activeSibling) {
            // Preserve uq_payment_active_per_order by putting ONLY this duplicate/obsolete payment into REFUND_PENDING.
            await tx.paymentTransaction.update({
              where: { paymentTransactionId },
              data: {
                status: 'REFUND_PENDING',
                paidAt: new Date(),
              },
            });

            // Only flag the whole order REFUND_PENDING if no PAID payment currently backs the order.
            const orderBackedByPaid =
              order.payment_status === 'PAID' || activeSibling.status === 'PAID';
            if (!orderBackedByPaid) {
              await tx.order.update({
                where: { orderId: payment.order_id },
                data: {
                  paymentStatus: 'REFUND_PENDING',
                },
              });
            }

            if (canRecordReceipts) {
              await this.getRefundsRepo().recordReceiptAndMaybeObligationInTx(tx, {
                order,
                payment,
                classification: orderBackedByPaid ? 'EXCESS_DUPLICATE' : 'LATE_CANCELLED_OR_COD',
                inbound,
              });
            }

            await tx.orderStatusHistory.create({
              data: {
                orderId: payment.order_id,
                oldStatus: order.order_status,
                newStatus: order.order_status,
                reason: orderBackedByPaid
                  ? `Nhận khoản thanh toán dư từ liên kết cũ đã hủy (#${paymentTransactionId}) khi đơn đã có thanh toán PAID hợp lệ; giữ nguyên paymentStatus PAID của đơn và đánh dấu riêng giao dịch dư REFUND_PENDING để hoàn tiền`
                  : 'Nhận khoản thanh toán từ liên kết cũ đã hủy khi đã có liên kết thanh toán mới; chuyển trạng thái thanh toán sang REFUND_PENDING để hoàn tiền cho khách',
              },
            });

            return withOutcome(await this.findTransactionByIdTx(tx, paymentTransactionId), {
              wasAlreadySettled: false,
            });
          }

          // State-dependent amount check strictly UNDER LOCK: if an unpaid primary transaction receives a
          // mismatched amount, reject primary PAID settlement while still preserving inbound receipt evidence.
          if (
            inbound?.amount !== undefined &&
            inbound?.amount !== null &&
            Math.round(inboundAmount) !== Math.round(Number(payment.amount))
          ) {
            if (
              canRecordReceipts &&
              Number.isFinite(inboundAmount) &&
              inboundAmount > 0 &&
              Number.isInteger(inboundAmount) &&
              inbound?.providerTransactionRef?.trim()
            ) {
              await this.getRefundsRepo().recordReceiptAndMaybeObligationInTx(tx, {
                order,
                payment,
                classification: 'EXCESS_DUPLICATE',
                inbound,
              });
            }
            return withOutcome(await this.findTransactionByIdTx(tx, paymentTransactionId), {
              wasAlreadySettled: false,
              amountMismatch: true,
            });
          }

          // Capture pre-update payment status so we distinguish an ACTIVE pre-delivery/doorstep QR link
          // from an obsolete CANCELLED link paid late after switching to COD.
          const wasActivePendingTx = payment.status === 'PENDING';

          // Update payment transaction to PAID
          await tx.paymentTransaction.update({
            where: { paymentTransactionId },
            data: {
              status: 'PAID',
              paidAt: new Date(),
            },
          });

          // F1 Matrix + Flexible Timing (Ý 1):
          // Active PayOS orders OR unpaid COD orders in PENDING..SHIPPING whose ACTIVE (PENDING)
          // PayOS QR link receives verified payment settle to PAYOS + PAID atomically.
          // Cancelled old links on COD/terminal orders still enter REFUND_PENDING reconciliation.
          const PAYABLE_PAYOS_ORDER_STATUSES = new Set([
            'PENDING',
            'CONFIRMED',
            'PREPARING',
            'READY_FOR_DELIVERY',
            'SHIPPING',
            'DELIVERED',
            'COMPLETED',
          ]);
          const PRE_DELIVERY_QR_ALLOWED_STATUSES = new Set([
            'PENDING',
            'CONFIRMED',
            'PREPARING',
            'READY_FOR_DELIVERY',
            'SHIPPING',
          ]);
          const isPreDeliveryQrConversion =
            wasActivePendingTx &&
            order.payment_method !== 'PAYOS' &&
            order.payment_status !== 'PAID' &&
            PRE_DELIVERY_QR_ALLOWED_STATUSES.has(order.order_status);
          const isPayablePayosOrder =
            PAYABLE_PAYOS_ORDER_STATUSES.has(order.order_status) &&
            (order.payment_method === 'PAYOS' || isPreDeliveryQrConversion);

          if (isPayablePayosOrder) {
            if (order.order_status === 'PENDING') {
              await tx.order.update({
                where: { orderId: payment.order_id },
                data: {
                  paymentStatus: 'PAID',
                  orderStatus: 'CONFIRMED',
                  ...(isPreDeliveryQrConversion ? { paymentMethod: 'PAYOS' } : {}),
                },
              });

              await tx.orderStatusHistory.create({
                data: {
                  orderId: payment.order_id,
                  oldStatus: order.order_status,
                  newStatus: 'CONFIRMED',
                  reason: isPreDeliveryQrConversion
                    ? 'PayOS webhook xác nhận thanh toán QR (chuyển COD -> PAYOS, PAID)'
                    : 'PayOS webhook xác nhận thanh toán thành công (Ký quỹ escrow)',
                },
              });
            } else {
              await tx.order.update({
                where: { orderId: payment.order_id },
                data: {
                  paymentStatus: 'PAID',
                  ...(isPreDeliveryQrConversion ? { paymentMethod: 'PAYOS' } : {}),
                },
              });

              await tx.orderStatusHistory.create({
                data: {
                  orderId: payment.order_id,
                  oldStatus: order.order_status,
                  newStatus: order.order_status,
                  reason: isPreDeliveryQrConversion
                    ? `PayOS webhook xác nhận thanh toán QR ở trạng thái ${order.order_status} (chuyển COD -> PAYOS, PAID)`
                    : `PayOS webhook xác nhận thanh toán thành công (PAID) cho đơn đang ở trạng thái ${order.order_status}`,
                },
              });
            }
          } else {
            // Cancelled / rejected / delivery-failed orders or orders switched to COD require refund reconciliation
            await tx.order.update({
              where: { orderId: payment.order_id },
              data: {
                paymentStatus: 'REFUND_PENDING',
              },
            });

            await tx.orderStatusHistory.create({
              data: {
                orderId: payment.order_id,
                oldStatus: order.order_status,
                newStatus: order.order_status,
                reason: `PayOS webhook nhận tiền sau khi đơn hàng đã ${order.order_status} (hoặc đổi phương thức thanh toán sang ${order.payment_method}). Đánh dấu paymentStatus: REFUND_PENDING để đối soát hoàn tiền.`,
              },
            });
          }

          if (canRecordReceipts) {
            await this.getRefundsRepo().recordReceiptAndMaybeObligationInTx(tx, {
              order,
              payment,
              classification: isPayablePayosOrder ? 'ORDER_PAYMENT' : 'LATE_CANCELLED_OR_COD',
              inbound,
            });
          }

          // 3. Atomically create customer notification with unique idempotency key
          const custRows: any[] = await tx.$queryRawUnsafe(
            `SELECT user_id FROM customer_profile WHERE customer_id = $1`,
            order.customer_id,
          );
          if (custRows && custRows.length > 0 && custRows[0].user_id) {
            const customerUserId = custRows[0].user_id;
            const idempotencyKey = `payment:${paymentTransactionId.toString()}:paid`;
            const notifData = JSON.stringify({
              orderId: order.order_id.toString(),
              orderCode: order.order_code,
              amount: Number(payment.amount),
              paymentTransactionId: paymentTransactionId.toString(),
            });
            await tx.$executeRawUnsafe(
              `INSERT INTO notifications (user_id, type, title, body, data, idempotency_key, created_at)
               VALUES ($1, $2, $3, $4, $5::jsonb, $6, NOW())
               ON CONFLICT (idempotency_key) DO NOTHING;`,
              customerUserId,
              'PAYMENT_SUCCESS',
              'Thanh toán đơn hàng thành công',
              `Đơn hàng #${order.order_code} đã thanh toán thành công qua PayOS với số tiền ${Number(payment.amount).toLocaleString('vi-VN')} VND.`,
              notifData,
              idempotencyKey,
            );
          }

          return this.findTransactionByIdTx(tx, paymentTransactionId);
        }),
      { operationName: 'confirmPaymentAtomicTx' },
    );
  }

  async createPendingTransactionCheckedTx(params: {
    orderId: bigint;
    userId?: bigint;
    userRole?: string;
    userStoreId?: string;
    transactionCode: string;
    paymentMethod: string;
  }) {
    return this.prisma.$transaction(async (tx) => {
      const lockedOrders = await tx.$queryRawUnsafe<any[]>(
        `SELECT * FROM orders WHERE order_id = $1 FOR UPDATE`,
        params.orderId,
      );
      if (!lockedOrders || lockedOrders.length === 0) {
        throw new NotFoundException({
          success: false,
          code: 'ORDER_NOT_FOUND',
          message: `Không tìm thấy đơn hàng với mã #${params.orderId}`,
        });
      }
      const order = lockedOrders[0];

      // Ownership check inside locked transaction
      if (params.userId) {
        let isCustomerOwner = false;
        if (order.customer_id) {
          const cust = await tx.customerProfile.findUnique({
            where: { customerId: BigInt(order.customer_id) },
            select: { userId: true },
          });
          isCustomerOwner = !!cust && cust.userId === params.userId;
        }
        const store = order.store_id
          ? await tx.store.findUnique({
              where: { storeId: BigInt(order.store_id) },
              select: { ownerUserId: true },
            })
          : null;
        const isStoreOwner = !!store && store.ownerUserId === params.userId;
        const isStoreStaff = Boolean(
          params.userStoreId && order.store_id && order.store_id.toString() === params.userStoreId.toString(),
        );
        const isAssignedDriver =
          params.userRole === 'STAFF_DELIVERY' &&
          isStoreStaff &&
          order.assigned_driver_id != null &&
          order.assigned_driver_id.toString() === params.userId.toString();
        const isAdmin = params.userRole === 'SUPER_ADMIN' || params.userRole === 'SYSTEM_ADMIN';

        if (params.userRole === 'STAFF_DELIVERY') {
          if (!isAssignedDriver) {
            throw new ForbiddenException({
              success: false,
              code: 'ORDER_ACCESS_DENIED',
              message: 'Tài xế chỉ có thể tạo liên kết thanh toán cho đơn hàng được chỉ định thuộc cửa hàng của mình',
            });
          }
          if (order.order_status !== 'SHIPPING') {
            throw new BadRequestException({
              success: false,
              code: 'ORDER_NOT_SHIPPING',
              message: 'Tài xế chỉ có thể tạo liên kết thanh toán khi đơn hàng đang trong quá trình giao (SHIPPING)',
            });
          }
        } else if (!isCustomerOwner && !isStoreOwner && !isStoreStaff && !isAdmin) {
          throw new ForbiddenException({
            success: false,
            code: 'ORDER_ACCESS_DENIED',
            message: 'Bạn không có quyền tạo liên kết thanh toán cho đơn hàng này',
          });
        }
      }

      if (['CANCELLED', 'REJECTED', 'COMPLETED', 'DELIVERED', 'DELIVERY_FAILED'].includes(order.order_status)) {
        throw new BadRequestException({
          success: false,
          code: 'ORDER_NOT_PAYABLE',
          message: `Đơn hàng ở trạng thái ${order.order_status} không thể tạo liên kết thanh toán`,
        });
      }

      if (order.payment_status === 'PAID') {
        throw new BadRequestException({
          success: false,
          code: 'ORDER_ALREADY_PAID',
          message: 'Đơn hàng này đã được thanh toán thành công',
        });
      }

      const existingActive = await tx.paymentTransaction.findFirst({
        where: {
          orderId: params.orderId,
          status: 'PENDING',
        },
        orderBy: { paymentTransactionId: 'desc' },
      });

      if (existingActive && existingActive.paymentLinkId) {
        return {
          reusedActiveLink: true,
          transaction: existingActive,
          orderAmount: Number(order.total_amount),
          orderCode: order.order_code,
        };
      }

      const orderAmount = Number(order.total_amount);
      if (!orderAmount || orderAmount < 1000) {
        throw new BadRequestException('Số tiền thanh toán phải từ 1,000 VND trở lên');
      }

      const createdTx = await tx.paymentTransaction.create({
        data: {
          orderId: params.orderId,
          provider: 'PAYOS',
          transactionCode: params.transactionCode,
          amount: new Decimal(orderAmount),
          paymentMethod: params.paymentMethod,
          status: 'PENDING',
        },
      });

      return {
        reusedActiveLink: false,
        transaction: createdTx,
        orderAmount,
        orderCode: order.order_code,
      };
    });
  }

  async changePaymentMethodTx(
    orderId: bigint,
    newPaymentMethod: string,
    actor?: { userId?: string | bigint; role?: string },
  ) {
    return this.prisma.$transaction(async (tx) => {
      // 1. Pessimistic lock order
      const lockedOrders = await tx.$queryRawUnsafe<any[]>(
        `SELECT order_id, order_code, order_status, payment_status, payment_method, customer_id, store_id
         FROM orders WHERE order_id = $1 FOR UPDATE`,
        orderId,
      );
      if (!lockedOrders || lockedOrders.length === 0) {
        throw new NotFoundException('Không tìm thấy đơn hàng');
      }
      const order = lockedOrders[0];

      if (actor && actor.role) {
        const isSuperAdmin = ['SUPER_ADMIN', 'SYSTEM_ADMIN', 'ADMIN'].includes(actor.role);
        if (!isSuperAdmin) {
          const cust = order.customer_id
            ? await tx.customerProfile.findUnique({
                where: { customerId: BigInt(order.customer_id) },
                select: { userId: true },
              })
            : null;
          const customerUserId = cust?.userId?.toString();
          const requestUserId = actor.userId?.toString();
          if (!customerUserId || !requestUserId || customerUserId !== requestUserId) {
            throw new ForbiddenException('Bạn không có quyền thay đổi phương thức thanh toán của đơn hàng này');
          }
        }
      }

      if (order.payment_status === 'PAID') {
        throw new BadRequestException('Không thể đổi phương thức thanh toán cho đơn hàng đã thanh toán');
      }

      const ALLOWED_PAYMENT_SWITCH_STATUSES = [
        'PENDING',
        'CONFIRMED',
        'PREPARING',
        'READY_FOR_DELIVERY',
        'SHIPPING',
      ];
      if (!ALLOWED_PAYMENT_SWITCH_STATUSES.includes(order.order_status)) {
        throw new BadRequestException(`Không thể đổi phương thức thanh toán khi đơn hàng đang ở trạng thái ${order.order_status}`);
      }

      // 2. Collect PENDING payment transactions so caller can cancel external PayOS links AFTER commit
      const pendingPayments = await tx.paymentTransaction.findMany({
        where: {
          orderId,
          status: 'PENDING',
        },
        select: { paymentTransactionId: true, paymentLinkId: true },
      });

      // 3. Cancel pending payment transactions atomically in DB
      await tx.paymentTransaction.updateMany({
        where: {
          orderId,
          status: 'PENDING',
        },
        data: {
          status: 'CANCELLED',
        },
      });

      // 4. Update order payment method atomically
      const updated = await tx.order.update({
        where: { orderId },
        data: {
          paymentMethod: newPaymentMethod,
          updatedAt: new Date(),
        },
        include: {
          customer: true,
          store: true,
        },
      });

      return {
        updated,
        cancelledLinkIds: pendingPayments
          .map((p) => p.paymentLinkId)
          .filter((id): id is string => Boolean(id)),
      };
    });
  }


  private async findTransactionByIdTx(tx: any, paymentTransactionId: bigint) {
    return tx.paymentTransaction.findUnique({
      where: { paymentTransactionId },
      include: { order: true },
    });
  }

  async updatePaymentLinkDetails(
    paymentTransactionId: bigint,
    paymentLinkId: string,
    checkoutUrl?: string,
    qrCode?: string,
  ) {
    return this.prisma.paymentTransaction.update({
      where: { paymentTransactionId },
      data: {
        paymentLinkId,
        ...(checkoutUrl ? { checkoutUrl } : {}),
        ...(qrCode ? { qrCode } : {}),
      },
    });
  }

  /**
   * Atomically persist PayOS link details ONLY if both the payment transaction and
   * its parent order are still active/payable under row locks (`orders` -> `payment_transaction`).
   * If `changeOrderPaymentMethod` or cancellation invalidated the transaction while waiting on PayOS,
   * record the link metadata for reconciliation without exposing/activating a PENDING link.
   */
  async savePaymentLinkIfStillActiveTx(params: {
    orderId: bigint;
    paymentTransactionId: bigint;
    paymentLinkId: string;
    checkoutUrl?: string;
    qrCode?: string;
  }): Promise<{
    saved: boolean;
    reason?: string;
    transactionStatus: string;
    orderStatus?: string;
    paymentStatus?: string;
    paymentMethod?: string;
  }> {
    return runWithTransactionRetry(
      () =>
        this.prisma.$transaction(async (tx) => {
          // Lock parent order first to match createPendingTransactionCheckedTx, changePaymentMethodTx & confirmPaymentAtomicTx ordering
          const lockedOrders = await tx.$queryRawUnsafe<any[]>(
            `SELECT order_id, order_status, payment_status, payment_method
             FROM orders WHERE order_id = $1 FOR UPDATE`,
            params.orderId,
          );

          const lockedTxs = await tx.$queryRawUnsafe<any[]>(
            `SELECT payment_transaction_id, order_id, status
             FROM payment_transaction WHERE payment_transaction_id = $1 FOR UPDATE`,
            params.paymentTransactionId,
          );

          // Read authoritative states strictly after both locks are held
          const order = lockedOrders?.[0];
          const paymentTx = lockedTxs?.[0];

          if (!paymentTx) {
            return {
              saved: false,
              reason: 'TRANSACTION_NOT_FOUND',
              transactionStatus: 'MISSING',
              orderStatus: order?.order_status,
              paymentStatus: order?.payment_status,
              paymentMethod: order?.payment_method,
            };
          }

          const linkData = {
            paymentLinkId: params.paymentLinkId,
            ...(params.checkoutUrl ? { checkoutUrl: params.checkoutUrl } : {}),
            ...(params.qrCode ? { qrCode: params.qrCode } : {}),
          };

          const orderInvalidated =
            !order ||
            ['CANCELLED', 'REJECTED', 'COMPLETED'].includes(order.order_status) ||
            order.payment_status === 'PAID';

          if (paymentTx.status !== 'PENDING' || orderInvalidated) {
            if (paymentTx.status !== 'PAID') {
              await tx.paymentTransaction.update({
                where: { paymentTransactionId: params.paymentTransactionId },
                data: {
                  ...linkData,
                  ...(paymentTx.status === 'PENDING' && orderInvalidated ? { status: 'CANCELLED' } : {}),
                },
              });
            }
            return {
              saved: false,
              reason:
                paymentTx.status !== 'PENDING'
                  ? `TRANSACTION_ALREADY_${paymentTx.status}`
                  : `ORDER_${order?.order_status || order?.payment_status || 'INVALID'}`,
              transactionStatus:
                paymentTx.status === 'PENDING' && orderInvalidated ? 'CANCELLED' : paymentTx.status,
              orderStatus: order?.order_status,
              paymentStatus: order?.payment_status,
              paymentMethod: order?.payment_method,
            };
          }

          await tx.paymentTransaction.update({
            where: { paymentTransactionId: params.paymentTransactionId },
            data: linkData,
          });

          return {
            saved: true,
            transactionStatus: 'PENDING',
            orderStatus: order.order_status,
            paymentStatus: order.payment_status,
            paymentMethod: order.payment_method,
          };
        }),
      { operationName: 'savePaymentLinkIfStillActiveTx' },
    );
  }

  async findTransactionByPaymentLinkIdOrOrder(orderCodeOrId: string) {
    const numId = !isNaN(Number(orderCodeOrId)) ? Number(orderCodeOrId) : undefined;
    return this.prisma.paymentTransaction.findFirst({
      where: {
        OR: [
          { paymentLinkId: orderCodeOrId },
          { transactionCode: orderCodeOrId },
          ...(numId ? [{ order: { orderCode: orderCodeOrId } }] : []),
        ],
      },
      include: {
        order: {
          include: { customer: true },
        },
      },
    });
  }

  /**
   * @deprecated Direct blind settlement is disabled (F2 P1 remediation).
   * Excess duplicate refunds must be dispatched & verified via PaymentRefundsService + PayOSPayoutService.
   */
  async refundExcessTransactionAtomicTx(
    _paymentTransactionId: bigint,
    _note: string,
    _changedByUserId?: bigint | null,
  ): Promise<never> {
    throw new BadRequestException(
      'MANUAL_EXCESS_REFUND_DEPRECATED: Không thể đóng khoản dư thủ công khi chưa có chứng từ chi hộ PayOS xác thực. Vui lòng xử lý qua PaymentRefundsService.',
    );
  }

  async isStoreVerificationTransaction(orderCodeOrRef: string): Promise<boolean> {
    if (!orderCodeOrRef) return false;
    try {
      const tx = await (this.prisma as any).bankAccountVerificationTransaction.findFirst({
        where: {
          OR: [
            { providerTransactionId: orderCodeOrRef },
            { referenceCode: orderCodeOrRef },
          ],
        },
        select: { id: true },
      });
      return !!tx;
    } catch {
      return false;
    }
  }

}
