import { Module, forwardRef } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';
import { StorefrontController } from './storefront.controller';
import { OrdersRepository } from './orders.repository';
import { OrdersLifecycleWorker } from './orders-lifecycle.worker';
import { DeliveryEligibilityService } from './delivery-eligibility.service';
import { StoreWalletModule } from '../store-wallet/store-wallet.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { WebSocketModule } from '../websocket/websocket.module';
import { MediaModule } from '../media/media.module';
import { PaymentsModule } from '../payments/payments.module';

@Module({
  imports: [
    StoreWalletModule,
    NotificationsModule,
    WebSocketModule,
    MediaModule,
    forwardRef(() => PaymentsModule),
  ],
  controllers: [OrdersController, StorefrontController],
  providers: [OrdersService, OrdersRepository, OrdersLifecycleWorker, DeliveryEligibilityService],
  exports: [OrdersService, OrdersRepository, OrdersLifecycleWorker, DeliveryEligibilityService],
})
export class OrdersModule {}
