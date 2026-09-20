import { Module } from '@nestjs/common';
import { PredictionService } from './prediction.service';
import { PredictionController } from './prediction.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { ConsumptionModule } from '../consumption/consumption.module';

@Module({
  imports: [PrismaModule, ConsumptionModule],
  controllers: [PredictionController],
  providers: [PredictionService],
  exports: [PredictionService],
})
export class PredictionModule {}
