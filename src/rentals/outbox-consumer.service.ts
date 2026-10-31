import { Injectable, Logger, Inject, Optional, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RentalsRepository } from './rentals.repository';
import { NotificationsService } from '../notifications/notifications.service';
import { PayOSPayoutService } from '../payments/payos-payout.service';
import { CryptoVaultUtil } from '../common/utils/crypto-vault.util';
import { verifyDepositRefundPayoutEvidence } from './deposit-payout-verifier';
import * as crypto from 'crypto';

@Injectable()
export class OutboxConsumerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxConsumerService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RentalsRepository) private readonly rentalsRepo: RentalsRepository,
    @Inject(NotificationsService) private readonly notificationsService: NotificationsService,
    @Optional() @Inject(PayOSPayoutService) private readonly payosPayoutService?: PayOSPayoutService,
  ) {}

  onModuleInit() {
    // R06: Tự động chạy worker định kỳ kiểm tra và xử lý sự kiện
    this.timer = setInterval(async () => {
      try {
        await this.processPendingEvents(10);
      } catch (err: any) {
        this.logger.error(`[OutboxConsumer] Định kỳ xử lý sự kiện gặp lỗi: ${err.message}`);
      }
    }, 5000);
    if (this.timer.unref) {
      this.timer.unref();
    }
  }

  onModuleDestroy() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Claim and process pending outbox events with row locking (SKIP LOCKED), exponential backoff, and DLQ
   * R06: Hỗ trợ lease recovery (locked_until) và claim_token để phục hồi lease hết hạn
   */
  async processPendingEvents(batchSize: number = 10) {
    const results = {
      processed: 0,
      failed: 0,
      dlqMoved: 0,
    };

    const claimToken = crypto.randomUUID();

    // 1. Claim pending events hoặc lease đã hết hạn bằng SELECT FOR UPDATE SKIP LOCKED
    const events = await this.prisma.$transaction(async (tx) => {
      const pending = await tx.$queryRawUnsafe<any[]>(
        `SELECT id, event_type, payload, attempts, status 
         FROM outbox_events 
         WHERE (status = 'PENDING' OR (status = 'PROCESSING' AND locked_until < NOW()))
           AND next_attempt_at <= NOW() 
         ORDER BY id ASC 
         LIMIT $1 
         FOR UPDATE SKIP LOCKED`,
        batchSize,
      );

      if (pending && pending.length > 0) {
        const ids = pending.map((e) => e.id);
        await tx.$executeRawUnsafe(
          `UPDATE outbox_events 
           SET status = 'PROCESSING', 
               claim_token = $1, 
               locked_until = NOW() + INTERVAL '5 minutes', 
               attempts = attempts + 1, 
               updated_at = NOW() 
           WHERE id = ANY($2::bigint[])`,
          claimToken,
          ids,
        );
        return pending.map((e) => ({ ...e, claimToken }));
      }

      return [];
    });

    if (!events || events.length === 0) {
      return results;
    }

    for (const event of events) {
      try {
        await this.handleSingleEvent(event);
        // Mark COMPLETED với điều kiện claimToken hợp lệ
        const updateRes = await this.prisma.outboxEvent.updateMany({
          where: { id: event.id, claimToken: event.claimToken },
          data: {
            status: 'COMPLETED',
            processedAt: new Date(),
            lockedUntil: null,
          },
        });
        if (updateRes.count === 0) {
          this.logger.warn(`[OutboxConsumer] Lost claim token for event #${event.id}, aborting completion.`);
          continue;
        }
        results.processed++;
      } catch (err: any) {
        this.logger.error(`[OutboxConsumer] Event #${event.id} (${event.event_type}) failed: ${err.message}`);
        results.failed++;

        const currentAttempts = Number(event.attempts) + 1;
        if (currentAttempts >= 3) {
          // Move to DeadLetterJob (DLQ)
          await this.prisma.$transaction(async (tx) => {
            const updateRes = await tx.outboxEvent.updateMany({
              where: { id: event.id, claimToken: event.claimToken },
              data: {
                status: 'FAILED',
                error: err.message,
                lockedUntil: null,
              },
            });
            if (updateRes.count === 0) {
              this.logger.warn(`[OutboxConsumer] Lost claim token for event #${event.id} during DLQ transition, aborting.`);
              return;
            }

            await tx.deadLetterJob.create({
              data: {
                queueName: 'outbox_events',
                jobName: event.event_type,
                payload: {
                  originalEventId: event.id.toString(),
                  data: typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload,
                } as any,
                attemptsMade: currentAttempts,
                maxAttempts: 3,
                failedReason: err.message,
                stacktrace: [err.stack || ''],
                status: 'DEAD',
              },
            });
          });
          results.dlqMoved++;
        } else {
          // Exponential backoff retry: 5s * 2^attempts
          const backoffSeconds = 5 * Math.pow(2, currentAttempts);
          const nextAttemptAt = new Date(Date.now() + backoffSeconds * 1000);
          const updateRes = await this.prisma.outboxEvent.updateMany({
            where: { id: event.id, claimToken: event.claimToken },
            data: {
              status: 'PENDING',
              attempts: currentAttempts,
              error: err.message,
              nextAttemptAt,
              lockedUntil: null,
            },
          });
          if (updateRes.count === 0) {
            this.logger.warn(`[OutboxConsumer] Lost claim token on retry for event #${event.id}`);
          }
        }
      }
    }

    return results;
  }

  private async handleSingleEvent(event: any) {
    const payload = typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload;

    switch (event.event_type) {
      case 'DEPOSIT_REFUND_APPROVED': {
        const refundId = BigInt(payload.refundId);
        // 1. Kiểm tra yêu cầu hoàn cọc và snapshot bất biến đã được chốt khi Admin duyệt
        const refund = await this.prisma.depositRefund.findUnique({
          where: { refundId },
          include: {
            bankAccount: true,
            customer: true,
          },
        });

        if (!refund) {
          throw new Error(`Refund #${refundId} not found`);
        }

        // P0 Invariant: Chỉ payout khi ĐỦ TOÀN BỘ 5 trường snapshot bất biến được admin chốt lúc duyệt
        // TUYỆT ĐỐI không fallback sang CustomerBankAccount tại thời điểm payout
        const toBin = (refund as any).recipientBin;
        const encAccount = (refund as any).recipientAccountNumberEncrypted;
        const accountHash = (refund as any).recipientAccountNumberHash;
        const accountHolderName = (refund as any).recipientAccountHolderName;
        const accountMasked = (refund as any).recipientAccountNumberMasked;

        if (!toBin || !encAccount || !accountHash || !accountHolderName || !accountMasked) {
          this.logger.error(
            `[OutboxConsumer] Yêu cầu hoàn cọc #${refundId} thiếu snapshot tài khoản nhận bất biến (BIN/enc/hash/holder/masked). ` +
            `Tuyệt đối không fallback sang CustomerBankAccount tại thời điểm payout. Giữ PENDING_PAYOUT và giữ cọc dự phòng để đối soát thủ công.`,
          );
          throw new Error(`Yêu cầu hoàn cọc #${refundId} thiếu snapshot tài khoản nhận bất biến hợp lệ. Giữ PENDING_PAYOUT.`);
        }

        // 2. Giải mã số tài khoản ngân hàng từ snapshot: TUYỆT ĐỐI không dùng fallback số masked hoặc số mặc định!
        let toAccountNumber = '';
        try {
          toAccountNumber = CryptoVaultUtil.decryptAccountNumber(encAccount);
        } catch (err: any) {
          this.logger.error(`[OutboxConsumer] Không thể giải mã số tài khoản snapshot của refund #${refundId}: ${err.message}. Giữ PENDING_PAYOUT.`);
          throw new Error(`Không thể giải mã số tài khoản ngân hàng yêu cầu #${refundId}: ${err.message}. Chuyển sang đối soát thủ công.`);
        }

        if (!toAccountNumber || toAccountNumber.includes('*') || toAccountNumber.length < 5) {
          throw new Error(`Số tài khoản ngân hàng yêu cầu #${refundId} sau khi giải mã không hợp lệ`);
        }

        // Kiểm tra đối sánh SHA-256 hash của số tài khoản giải mã với snapshot recipientAccountNumberHash
        const verifyDecryptedHash = crypto.createHash('sha256').update(toAccountNumber.trim()).digest('hex');
        if (verifyDecryptedHash !== accountHash) {
          this.logger.error(`[OutboxConsumer] Hash của số tài khoản giải mã không khớp với snapshot recipientAccountNumberHash trên refund #${refundId}!`);
          throw new Error(`Snapshot tài khoản ngân hàng của yêu cầu #${refundId} bị sai lệch hash. Giữ PENDING_PAYOUT.`);
        }

        const payoutPayload = {
          referenceId: refund.refundCode,
          amount: Math.round(Number(refund.amount)),
          description: ('Hoan coc ' + refund.refundCode).slice(0, 25),
          toBin: toBin.trim(),
          toAccountNumber,
        };

        if (!this.payosPayoutService) {
          throw new Error('Dịch vụ chi hộ PayOSPayoutService chưa sẵn sàng');
        }

        const payoutResult = await this.payosPayoutService.createPayout(payoutPayload);
        const payoutId = payoutResult?.data?.id;

        // P0 Invariant: Bắt buộc PayOS phải trả về payout ID thật (data.id).
        // Nếu không có mã payout thật: Ném ngoại lệ để Outbox event retry với idempotency key referenceId=refundCode hoặc chuyển DLQ.
        // Tuyệt đối không return thành công làm outbox event bị đánh dấu COMPLETED khi payout chưa hoàn tất!
        if (!payoutId) {
          this.logger.warn(`[OutboxConsumer] PayOS không trả về mã payout ID thật (data.id) cho refund #${refundId}. Ném ngoại lệ để retry hoặc đưa vào DLQ đối soát.`);
          throw new Error(`PayOS không trả về mã payout ID thật (data.id) cho yêu cầu hoàn cọc #${refundId}. Cần retry hoặc xử lý đối soát qua DLQ.`);
        }

        await this.prisma.depositRefund.update({
          where: { refundId },
          data: {
            providerReferenceId: String(payoutId),
            updatedAt: new Date(),
          },
        });

        // R02 FIX: Dùng shared verifier chặt chẽ, TUYỆT ĐỐI không fallback số tiền hay bỏ qua đối soát
        const verification = verifyDepositRefundPayoutEvidence(payoutResult?.data, {
          ...refund,
          providerReferenceId: String(payoutId),
        });
        if (verification.isVerified) {
          await this.rentalsRepo.confirmDepositRefundPayoutTx(refundId, verification.providerRef);
        } else {
          this.logger.log(`[OutboxConsumer] Payout #${refundId} chưa đủ bằng chứng chi tiết (${verification.reason}). Giữ PENDING_PAYOUT.`);
        }
        break;
      }

      case 'DEPOSIT_REFUND_COMPLETED': {
        const refundId = BigInt(payload.refundId);
        const refund = await this.prisma.depositRefund.findUnique({
          where: { refundId },
          include: { customer: true },
        });
        if (refund?.customer?.userId) {
          await this.notificationsService.dispatchRentalEventNotification({
            eventType: 'DEPOSIT_REFUND_COMPLETED',
            userId: refund.customer.userId,
            amount: Number(refund.amount),
            eventId: event.id,
            channel: 'IN_APP',
          });
        }
        break;
      }

      case 'BILLING_CHARGE_SETTLED': {
        if (payload.purpose === 'RENTAL_INITIAL' || payload.purpose === 'RENTAL_EXTENSION') {
          const rental = await this.prisma.buttonRental.findUnique({
            where: { rentalId: BigInt(payload.targetId) },
            include: { customer: true },
          });
          if (rental?.customer?.userId) {
            await this.notificationsService.dispatchRentalEventNotification({
              eventType: 'PAYMENT_RECEIVED',
              userId: rental.customer.userId,
              rentalCode: rental.rentalCode,
              amount: payload.totalAmount,
              eventId: event.id,
              channel: 'IN_APP',
            });
          }
        }
        break;
      }

      case 'RENTAL_EXPIRED': {
        const rentalId = BigInt(payload.rentalId);
        const rental = await this.prisma.buttonRental.findUnique({
          where: { rentalId },
          include: { customer: true },
        });
        if (rental?.customer?.userId) {
          await this.notificationsService.dispatchRentalEventNotification({
            eventType: 'RENTAL_EXPIRED',
            userId: rental.customer.userId,
            rentalCode: rental.rentalCode,
            eventId: event.id,
            channel: 'IN_APP',
          });
        }
        break;
      }

      case 'RENTAL_RETURN_REQUESTED': {
        const rentalId = BigInt(payload.rentalId);
        const storeIdStr = payload.storeId;
        const rental = await this.prisma.buttonRental.findUnique({
          where: { rentalId },
          include: { customer: true, fulfillmentStore: true },
        });

        // 1. Gửi thông báo tới cửa hàng nhận trả (Store Owner)
        const targetStoreId = storeIdStr ? BigInt(storeIdStr) : rental?.fulfillmentStoreId;
        if (targetStoreId) {
          const store = await this.prisma.store.findUnique({
            where: { storeId: targetStoreId },
          });
          if (store?.ownerUserId) {
            await this.notificationsService.createAndDispatchNotification({
              userId: store.ownerUserId,
              title: 'Yêu cầu trả nút bấm IoT mới',
              body: `Hợp đồng #${rental?.rentalCode || payload.rentalId} có yêu cầu hoàn trả thiết bị gửi tới cửa hàng ${store.name}.`,
              type: 'RENTAL_RETURN_REQUESTED',
              data: {
                referenceType: 'RETURN',
                referenceId: (payload.returnId || payload.rentalId).toString(),
                channel: 'IN_APP',
              },
              idempotencyKey: `notif:${event.id}:${store.ownerUserId}:IN_APP`,
            });
          }
        }

        // 2. Gửi thông báo xác nhận cho khách hàng
        if (rental?.customer?.userId) {
          await this.notificationsService.dispatchRentalEventNotification({
            eventType: 'RENTAL_RETURN_REQUESTED',
            userId: rental.customer.userId,
            rentalCode: rental.rentalCode,
            eventId: event.id,
            channel: 'IN_APP',
          });
        }
        break;
      }

      case 'STORE_SUBSCRIPTION_EXPIRED': {
        const storeIdStr = payload.storeId;
        if (storeIdStr) {
          const store = await this.prisma.store.findUnique({
            where: { storeId: BigInt(storeIdStr) },
          });
          if (store?.ownerUserId) {
            await this.notificationsService.createAndDispatchNotification({
              userId: store.ownerUserId,
              title: 'Gói duy trì gian hàng đã hết hạn',
              body: `Gói dịch vụ gian hàng của cửa hàng ${store.name} đã hết hạn. Vui lòng thanh toán phí duy trì để tiếp tục mở bán sản phẩm.`,
              type: 'STORE_SUBSCRIPTION_EXPIRED',
              data: {
                referenceType: 'STORE',
                referenceId: store.storeId.toString(),
                channel: 'IN_APP',
              },
              idempotencyKey: `notif:${event.id}:${store.ownerUserId}:IN_APP`,
            });
          }
        }
        break;
      }

      default:
        // R06: Không âm thầm bỏ qua sự kiện nghiệp vụ chưa có handler
        this.logger.warn(`[OutboxConsumer] Unhandled event type: ${event.event_type}. Event is rejected from silent completion.`);
        throw new Error(`Unhandled event type: ${event.event_type}`);
    }
  }
}

