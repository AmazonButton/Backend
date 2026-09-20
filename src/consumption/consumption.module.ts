import { Module } from '@nestjs/common';
import { ConsumptionService } from './consumption.service';
import { ConsumptionController } from './consumption.controller';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [ConsumptionController],
  providers: [ConsumptionService],
  exports: [ConsumptionService],
})
export class ConsumptionModule {}
