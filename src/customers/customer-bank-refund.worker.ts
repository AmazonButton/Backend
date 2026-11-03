import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { CustomerBankPennyVerificationService } from './customer-bank-penny-verification.service';

@Injectable()
export class CustomerBankRefundWorker {
  private readonly logger = new Logger(CustomerBankRefundWorker.name);
  private isProcessing = false;

  constructor(private readonly pennyVerificationService: CustomerBankPennyVerificationService) {}

  @Cron('*/2 * * * *') // Runs every 2 minutes
  async handleRefundOutboxCron() {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      // 1. Process pending refund obligations (Outbox)
      const batchResult = await this.pennyVerificationService.processRefundWorkerBatch(10);
      if (batchResult.processed > 0) {
        this.logger.log(
          `[CustomerBankRefundWorker] Processed ${batchResult.processed} refund obligations ` +
            `(${batchResult.succeeded} succeeded, ${batchResult.failed} failed/reconciling)`,
        );
      }

      // 2. Reconcile pending payout attempts
      const reconResult = await this.pennyVerificationService.reconcilePendingRefundPayouts(10);
      if (reconResult.reconciled > 0) {
        this.logger.log(`[CustomerBankRefundWorker] Reconciled ${reconResult.reconciled} pending payout attempts`);
      }
    } catch (err: any) {
      this.logger.error(`[CustomerBankRefundWorker] Error running background refund job: ${err.message}`);
    } finally {
      this.isProcessing = false;
    }
  }
}
