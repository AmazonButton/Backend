import { Module, forwardRef } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { WebSocketModule } from '../websocket/websocket.module';
import { PaymentsController } from './payments.controller';
import { PayoutWebhookController } from './payout-webhook.controller';
import { PaymentsService } from './payments.service';
import { PaymentsRepository } from './payments.repository';
import { PayOSPayoutService } from './payos-payout.service';
import { PaymentRefundsRepository } from './payment-refunds.repository';
import { PaymentRefundsService } from './payment-refunds.service';
import { PaymentRefundWorkerService } from './payment-refund-worker.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { StoreWalletModule } from '../store-wallet/store-wallet.module';
import { BillingChargesModule } from '../billing-charges/billing-charges.module';
import { CustomersModule } from '../customers/customers.module';
import { BankVerificationModule } from '../bank-verification/bank-verification.module';

@Module({
  imports: [
    PrismaModule,
    WebSocketModule,
    NotificationsModule,
    forwardRef(() => StoreWalletModule),
    forwardRef(() => BillingChargesModule),
    forwardRef(() => CustomersModule),
    forwardRef(() => BankVerificationModule),
  ],
  controllers: [PaymentsController, PayoutWebhookController],
  providers: [
    PaymentsService,
    PaymentsRepository,
    PayOSPayoutService,
    PaymentRefundsRepository,
    PaymentRefundsService,
    PaymentRefundWorkerService,
  ],
  exports: [
    PaymentsService,
    PaymentsRepository,
    PayOSPayoutService,
    PaymentRefundsRepository,
    PaymentRefundsService,
    PaymentRefundWorkerService,
  ],
})
export class PaymentsModule {}
