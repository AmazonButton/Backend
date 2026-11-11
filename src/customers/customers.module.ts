import { Module, forwardRef } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { DashboardCacheModule } from '../common/cache/dashboard-cache.module';
import { PaymentsModule } from '../payments/payments.module';
import { CustomersController } from './customers.controller';
import { CustomerBankWebhookController } from './customer-bank-webhook.controller';
import { CustomersService } from './customers.service';
import { CustomersRepository } from './customers.repository';
import { CustomerBankPennyVerificationService } from './customer-bank-penny-verification.service';
import { CustomerBankRefundWorker } from './customer-bank-refund.worker';

@Module({
  imports: [PrismaModule, DashboardCacheModule, forwardRef(() => PaymentsModule)],
  controllers: [CustomersController, CustomerBankWebhookController],
  providers: [
    CustomersService,
    CustomersRepository,
    CustomerBankPennyVerificationService,
    CustomerBankRefundWorker,
  ],
  exports: [
    CustomersService,
    CustomersRepository,
    CustomerBankPennyVerificationService,
    CustomerBankRefundWorker,
  ],
})
export class CustomersModule {}
