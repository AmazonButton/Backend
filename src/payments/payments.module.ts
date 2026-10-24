import { Module, forwardRef } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { WebSocketModule } from '../websocket/websocket.module';
import { PaymentsController } from './payments.controller';
import { PayoutWebhookController } from './payout-webhook.controller';
import { PaymentsService } from './payments.service';
import { PaymentsRepository } from './payments.repository';
import { PayOSPayoutService } from './payos-payout.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { StoreWalletModule } from '../store-wallet/store-wallet.module';

@Module({
  imports: [
    PrismaModule,
    WebSocketModule,
    NotificationsModule,
    forwardRef(() => StoreWalletModule),
  ],
  controllers: [PaymentsController, PayoutWebhookController],
  providers: [PaymentsService, PaymentsRepository, PayOSPayoutService],
  exports: [PaymentsService, PaymentsRepository, PayOSPayoutService],
})
export class PaymentsModule {}
