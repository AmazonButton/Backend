import { Module } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';
import { OrdersRepository } from './orders.repository';
import { StoreWalletModule } from '../store-wallet/store-wallet.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [StoreWalletModule, NotificationsModule],
  controllers: [OrdersController],
  providers: [OrdersService, OrdersRepository],
  exports: [OrdersService, OrdersRepository],
})
export class OrdersModule {}
