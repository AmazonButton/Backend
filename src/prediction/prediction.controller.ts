import { Controller, Get, Param, UseGuards, Inject } from '@nestjs/common';
import { PredictionService } from './prediction.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

@Controller('prediction')
@UseGuards(JwtAuthGuard)
export class PredictionController {
  constructor(
    @Inject(PredictionService) private readonly predictionService: PredictionService,
  ) {}

  @Get('household/:householdId')
  async getPredictions(@Param('householdId') householdId: string) {
    return this.predictionService.calculateHouseholdPredictions(householdId);
  }
}
