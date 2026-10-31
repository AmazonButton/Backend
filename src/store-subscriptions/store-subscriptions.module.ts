import { Module, forwardRef } from '@nestjs/common';
import { StoreSubscriptionsService } from './store-subscriptions.service';
import { StoreSubscriptionsRepository } from './store-subscriptions.repository';
import { StoreSubscriptionsController } from './store-subscriptions.controller';
import { SubscriptionPlansController } from './subscription-plans.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { StoreWalletModule } from '../store-wallet/store-wallet.module';
import { BillingChargesModule } from '../billing-charges/billing-charges.module';

@Module({
  imports: [PrismaModule, StoreWalletModule, forwardRef(() => BillingChargesModule)],
  controllers: [StoreSubscriptionsController, SubscriptionPlansController],
  providers: [StoreSubscriptionsService, StoreSubscriptionsRepository],
  exports: [StoreSubscriptionsService, StoreSubscriptionsRepository],
})
export class StoreSubscriptionsModule {}
