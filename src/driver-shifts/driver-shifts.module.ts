import { Module } from '@nestjs/common';
import { DriverShiftsController } from './driver-shifts.controller';
import { DriverShiftsService } from './driver-shifts.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [DriverShiftsController],
  providers: [DriverShiftsService],
  exports: [DriverShiftsService],
})
export class DriverShiftsModule {}
