import { Module } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';
import { StorefrontController } from './storefront.controller';
import { OrdersRepository } from './orders.repository';
import { OrdersLifecycleWorker } from './orders-lifecycle.worker';
import { StoreWalletModule } from '../store-wallet/store-wallet.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { WebSocketModule } from '../websocket/websocket.module';

@Module({
  imports: [StoreWalletModule, NotificationsModule, WebSocketModule],
  controllers: [OrdersController, StorefrontController],
  providers: [OrdersService, OrdersRepository, OrdersLifecycleWorker],
  exports: [OrdersService, OrdersRepository, OrdersLifecycleWorker],
})
export class OrdersModule {}
