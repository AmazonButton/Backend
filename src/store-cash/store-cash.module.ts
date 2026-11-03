import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { DashboardCacheModule } from '../common/cache/dashboard-cache.module';
import {
  CustomerRentalsCashVoucherController,
  StoreCashReceiptsController,
  AdminBillingOverpaymentsController,
} from './store-cash.controller';
import { StoreCashService } from './store-cash.service';
import { StoreCashRepository } from './store-cash.repository';

@Module({
  imports: [PrismaModule, DashboardCacheModule],
  controllers: [
    CustomerRentalsCashVoucherController,
    StoreCashReceiptsController,
    AdminBillingOverpaymentsController,
  ],
  providers: [StoreCashService, StoreCashRepository],
  exports: [StoreCashService, StoreCashRepository],
})
export class StoreCashModule {}

