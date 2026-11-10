import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { BankVerificationService } from './bank-verification.service';

@Injectable()
export class StoreBankRefundWorker {
  private readonly logger = new Logger(StoreBankRefundWorker.name);
  private isProcessing = false;

  constructor(private readonly bankVerificationService: BankVerificationService) {}

  @Cron('*/2 * * * *') // Runs every 2 minutes
  async handleRefundOutboxCron() {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      // 1. Process pending store refund obligations
      const batchResult = await this.bankVerificationService.processStoreRefundWorkerBatch(10);
      if (batchResult.processed > 0) {
        this.logger.log(
          `[StoreBankRefundWorker] Processed ${batchResult.processed} refund obligations ` +
            `(${batchResult.succeeded} succeeded, ${batchResult.failed} failed/reconciling)`,
        );
      }

      // 2. Reconcile pending store payout attempts
      const reconResult = await this.bankVerificationService.reconcilePendingStoreRefunds(10);
      if (reconResult.reconciled > 0) {
        this.logger.log(`[StoreBankRefundWorker] Reconciled ${reconResult.reconciled} pending store refund attempts`);
      }
    } catch (err: any) {
      this.logger.error(`[StoreBankRefundWorker] Error running background store refund job: ${err.message}`);
    } finally {
      this.isProcessing = false;
    }
  }
}

