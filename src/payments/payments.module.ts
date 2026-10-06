import { Module } from '@nestjs/common';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { PaymentsRepository } from './payments.repository';
import { PayOSPayoutService } from './payos-payout.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [PaymentsController],
  providers: [PaymentsService, PaymentsRepository, PayOSPayoutService],
  exports: [PaymentsService, PaymentsRepository, PayOSPayoutService],
})
export class PaymentsModule {}
