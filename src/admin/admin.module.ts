import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AdminRepository } from './admin.repository';
import { PrismaModule } from '../prisma/prisma.module';
import { PaymentsModule } from '../payments/payments.module';
import { DashboardCacheModule } from '../common/cache/dashboard-cache.module';
import { StoreWithdrawalPayoutWorkerService } from './store-withdrawal-payout.worker';

@Module({
  imports: [PrismaModule, PaymentsModule, DashboardCacheModule],
  controllers: [AdminController],
  providers: [AdminService, AdminRepository, StoreWithdrawalPayoutWorkerService],
  exports: [AdminService, AdminRepository, StoreWithdrawalPayoutWorkerService],
})
export class AdminModule {}
