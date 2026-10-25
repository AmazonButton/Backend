import { Module } from '@nestjs/common';
import { RentalsService } from './rentals.service';
import { RentalsRepository } from './rentals.repository';
import { RentalsController } from './rentals.controller';
import { AdminRentalsController } from './admin-rentals.controller';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [RentalsController, AdminRentalsController],
  providers: [RentalsService, RentalsRepository],
  exports: [RentalsService, RentalsRepository],
})
export class RentalsModule {}
