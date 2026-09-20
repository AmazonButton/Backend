import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ConsumptionService } from './consumption.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

@Controller('consumption')
@UseGuards(JwtAuthGuard)
export class ConsumptionController {
  constructor(private readonly consumptionService: ConsumptionService) {}

  @Get('household/:householdId')
  async getHouseholdConsumption(
    @Param('householdId') householdId: string,
    @Query('productId') productId?: string,
  ) {
    return this.consumptionService.getHouseholdConsumption(householdId, productId);
  }

  @Get('household/:householdId/stats')
  async getHouseholdStats(@Param('householdId') householdId: string) {
    return this.consumptionService.getHouseholdConsumptionStats(householdId);
  }
}
