import { Module, forwardRef } from '@nestjs/common';
import { RentalsService } from './rentals.service';
import { RentalsRepository } from './rentals.repository';
import { RentalsController } from './rentals.controller';
import { AdminRentalsController } from './admin-rentals.controller';
import { OutboxConsumerService } from './outbox-consumer.service';
import { PrismaModule } from '../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PaymentsModule } from '../payments/payments.module';
import { BillingChargesModule } from '../billing-charges/billing-charges.module';

import { RentalExpiryCronService } from './rental-expiry-cron.service';

@Module({
  imports: [PrismaModule, NotificationsModule, PaymentsModule, forwardRef(() => BillingChargesModule)],
  controllers: [RentalsController, AdminRentalsController],
  providers: [RentalsService, RentalsRepository, OutboxConsumerService, RentalExpiryCronService],
  exports: [RentalsService, RentalsRepository, OutboxConsumerService, RentalExpiryCronService],
})
export class RentalsModule {}
