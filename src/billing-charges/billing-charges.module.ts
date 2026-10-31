import { Module } from '@nestjs/common';
import { BillingChargesController } from './billing-charges.controller';
import { BillingChargesService } from './billing-charges.service';
import { BillingChargesRepository } from './billing-charges.repository';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [BillingChargesController],
  providers: [BillingChargesService, BillingChargesRepository],
  exports: [BillingChargesService, BillingChargesRepository],
})
export class BillingChargesModule {}
