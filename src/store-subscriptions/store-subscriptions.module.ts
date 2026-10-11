import { Module } from '@nestjs/common';
import { StoreSubscriptionsService } from './store-subscriptions.service';
import { StoreSubscriptionsRepository } from './store-subscriptions.repository';
import { StoreSubscriptionsController } from './store-subscriptions.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { StoreWalletModule } from '../store-wallet/store-wallet.module';

@Module({
  imports: [PrismaModule, StoreWalletModule],
  controllers: [StoreSubscriptionsController],
  providers: [StoreSubscriptionsService, StoreSubscriptionsRepository],
  exports: [StoreSubscriptionsService, StoreSubscriptionsRepository],
})
export class StoreSubscriptionsModule {}
