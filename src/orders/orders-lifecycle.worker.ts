import { Injectable, Logger, OnModuleInit, OnModuleDestroy, Inject, forwardRef, Optional } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { OrdersRepository } from './orders.repository';
import { OrdersService } from './orders.service';
import { EventsGateway } from '../websocket/events.gateway';
import { NotificationsService } from '../notifications/notifications.service';
import { toOrderResponseDto } from './dto/order-response.dto';

@Injectable()
export class OrdersLifecycleWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OrdersLifecycleWorker.name);
  private isProcessing = false;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(OrdersRepository) private readonly ordersRepo: OrdersRepository,
    @Inject(forwardRef(() => OrdersService)) private readonly ordersService: OrdersService,
    @Optional() @Inject(EventsGateway) private readonly eventsGateway?: EventsGateway,
    @Optional() @Inject(NotificationsService) private readonly notificationsService?: NotificationsService,
  ) {}

  onModuleInit() {
    this.logger.log('OrdersLifecycleWorker initialized. Monitoring PENDING order cancellation windows.');
  }

  onModuleDestroy() {
    this.logger.log('OrdersLifecycleWorker stopped.');
  }

  /**
   * Periodic interval worker: Runs every 5 seconds to sweep expired PENDING orders
   * and automatically advance them to CONFIRMED.
   */
  @Interval(5000)
  async handleLifecycleInterval() {
    await this.processPendingOrdersLifecycle();
  }

  /**
   * Alias for test suite and programmatic execution
   */
  async autoConfirmPendingOrders(): Promise<{ processedCount: number; confirmedOrderIds: string[] }> {
    return this.processPendingOrdersLifecycle();
  }

  /**
   * Core order lifecycle processing method with multi-instance safety & dynamic time budget.
   * Can be invoked by Cron/Interval or programmatically in tests.
   */
  async processPendingOrdersLifecycle(
    maxDurationOrBatches: number = 4000,
    batchSize: number = 50,
  ): Promise<{ processedCount: number; confirmedOrderIds: string[] }> {
    if (this.isProcessing) {
      return { processedCount: 0, confirmedOrderIds: [] };
    }

    this.isProcessing = true;
    const confirmedOrderIds: string[] = [];
    const startTime = Date.now();

    // If param <= 50, treat as legacy maxBatches; otherwise treat as maxDurationMs (default 4000ms)
    const isDurationMode = maxDurationOrBatches > 100;
    const maxBatches = isDurationMode ? Number.MAX_SAFE_INTEGER : maxDurationOrBatches;
    const maxDurationMs = isDurationMode ? maxDurationOrBatches : 10000;

    try {
      let batch = 0;
      while (batch < maxBatches && Date.now() - startTime < maxDurationMs) {
        batch++;
        // Find orders in PENDING status whose cancellation window has elapsed
        // Button cancel_window_seconds defaults to 60 if null
        const expiredPendingOrders = await this.prisma.$queryRawUnsafe<any[]>(
          `SELECT o.order_id, o.order_code, o.button_id, o.store_id, o.customer_id, o.created_at,
                  COALESCE(b.cancel_window_seconds, 60) AS cancel_window_seconds
           FROM orders o
           LEFT JOIN iot_button b ON o.button_id = b.button_id
           WHERE o.order_status = 'PENDING'
             AND o.created_at <= (NOW() - (COALESCE(b.cancel_window_seconds, 60) * INTERVAL '1 second'))
           ORDER BY o.created_at ASC
           LIMIT $1`,
          batchSize,
        );

        if (!expiredPendingOrders || expiredPendingOrders.length === 0) {
          break;
        }

        for (const rawOrder of expiredPendingOrders) {
          if (Date.now() - startTime >= maxDurationMs) {
            this.logger.warn(
              `[OrdersLifecycleWorker] Execution reached time budget (${maxDurationMs}ms). Remaining expired orders will be processed in the next cycle.`,
            );
            break;
          }

          const orderId = BigInt(rawOrder.order_id);
          try {
            // Transition order to CONFIRMED atomically
            const updated = await this.ordersRepo.transitionOrderStatusAtomicTx(
              orderId,
              'CONFIRMED',
              null,
              'Hệ thống tự động xác nhận đơn hàng sau khi hết 60s cửa sổ hủy',
            );

            // Multi-instance concurrency check: If another worker instance already confirmed this order, skip duplicate events & push
            if ((updated as any)?._statusChanged === false) {
              this.logger.debug(
                `[OrdersLifecycleWorker] Order #${rawOrder.order_code} (ID: ${rawOrder.order_id}) was already transitioned by another instance. Skipping duplicate notification.`,
              );
              continue;
            }

            confirmedOrderIds.push(orderId.toString());

            const formattedOrder = toOrderResponseDto(updated);
            const payload = {
              order: formattedOrder,
              storeId: rawOrder.store_id.toString(),
              customerId: rawOrder.customer_id.toString(),
              reason: 'Tự động xác nhận sau khi hết 60s cửa sổ hủy',
            };

            if (this.eventsGateway) {
              this.eventsGateway.emitToStore(rawOrder.store_id.toString(), 'ORDER_STATUS_CHANGED', payload);
              this.eventsGateway.emitToStore(rawOrder.store_id.toString(), 'ORDER_CONFIRMED', payload);
              this.eventsGateway.emitToCustomer(rawOrder.customer_id.toString(), 'ORDER_STATUS_CHANGED', payload);
              this.eventsGateway.emitToCustomer(rawOrder.customer_id.toString(), 'ORDER_CONFIRMED', payload);
            }

            if (this.notificationsService) {
              const customerUserId = updated.customer?.userId || (updated.customer as any)?.user?.userId;
              if (customerUserId) {
                this.notificationsService
                  .sendOrderStatusChanged(formattedOrder, customerUserId, 'CONFIRMED')
                  .catch((err) => {
                    this.logger.warn(`Failed to send auto-confirmed push notification: ${err.message}`);
                  });
              }
            }

            this.logger.log(
              `[OrdersLifecycleWorker] Order #${rawOrder.order_code} (ID: ${rawOrder.order_id}) transitioned PENDING -> CONFIRMED.`,
            );
          } catch (err: any) {
            this.logger.error(
              `[OrdersLifecycleWorker] Failed to auto-confirm order #${rawOrder.order_code} (ID: ${rawOrder.order_id}): ${err.message}`,
            );
          }
        }

        if (expiredPendingOrders.length < batchSize) {
          break;
        }
      }
    } catch (err: any) {
      this.logger.error(`[OrdersLifecycleWorker] Error querying expired pending orders: ${err.message}`);
    } finally {
      this.isProcessing = false;
    }

    return {
      processedCount: confirmedOrderIds.length,
      confirmedOrderIds,
    };
  }
}
