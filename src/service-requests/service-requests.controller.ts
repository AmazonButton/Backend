import { Controller, Get, Post, Put, Param, Body, UseGuards, Request } from '@nestjs/common';
import { ServiceRequestsService } from './service-requests.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

@Controller('service-requests')
@UseGuards(JwtAuthGuard)
export class ServiceRequestsController {
  constructor(private readonly serviceRequestsService: ServiceRequestsService) {}

  @Post('household/:householdId')
  async createRequest(
    @Param('householdId') householdId: string,
    @Body()
    body: {
      deviceId?: string;
      storeId?: string;
      type?: string;
      category: string;
      description?: string;
      priority?: string;
    },
  ) {
    return this.serviceRequestsService.createServiceRequest({
      householdId,
      ...body,
    });
  }

  @Post('household/:householdId/emergency')
  async triggerEmergency(
    @Param('householdId') householdId: string,
    @Body() body: { deviceId?: string; alertType: string; message: string },
  ) {
    return this.serviceRequestsService.triggerEmergencyAlert({
      householdId,
      ...body,
    });
  }

  @Get('household/:householdId')
  async getHouseholdRequests(@Param('householdId') householdId: string) {
    return this.serviceRequestsService.getHouseholdRequests(householdId);
  }

  @Get('household/:householdId/alerts')
  async getHouseholdAlerts(@Param('householdId') householdId: string) {
    return this.serviceRequestsService.getUrgentAlerts(householdId);
  }

  @Get('store/:storeId')
  async getStoreRequests(@Param('storeId') storeId: string) {
    return this.serviceRequestsService.getStoreRequests(storeId);
  }

  @Put(':id/status')
  async updateStatus(@Param('id') id: string, @Body('status') status: string) {
    return this.serviceRequestsService.updateRequestStatus(id, status);
  }

  @Put('alerts/:alertId/acknowledge')
  async acknowledgeAlert(@Param('alertId') alertId: string, @Request() req: any) {
    return this.serviceRequestsService.acknowledgeAlert(alertId, req.user.userId);
  }
}
