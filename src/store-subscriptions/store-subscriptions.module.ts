import { Module } from '@nestjs/common';
import { StoreSubscriptionsService } from './store-subscriptions.service';
import { StoreSubscriptionsController } from './store-subscriptions.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { StoreWalletModule } from '../store-wallet/store-wallet.module';

@Module({
  imports: [PrismaModule, StoreWalletModule],
  controllers: [StoreSubscriptionsController],
  providers: [StoreSubscriptionsService],
  exports: [StoreSubscriptionsService],
})
export class StoreSubscriptionsModule {}
