import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Headers,
  UseGuards,
  Request,
  Inject,
} from '@nestjs/common';
import { ProvisioningService } from './provisioning.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

@Controller()
export class ProvisioningController {
  constructor(
    @Inject(ProvisioningService)
    private readonly provisioningService: ProvisioningService,
  ) {}

  /**
   * 1. Public endpoint: Start provisioning session by scanning QR
   */
  @Post('provisioning/session')
  async createSession(@Body() body: any) {
    return this.provisioningService.createSession(body);
  }

  /**
   * 2. Public endpoint: Verify provisioning session status
   */
  @Post('provisioning/verify')
  async verifySession(@Body('sessionId') sessionId: string) {
    return this.provisioningService.verifySession(sessionId);
  }

  /**
   * 3. Hardware endpoint: ESP32 Cloud Bootstrap via HMAC-SHA256
   */
  @Post('devices/bootstrap')
  async bootstrap(@Headers() headers: any, @Body() body: any) {
    return this.provisioningService.bootstrap(headers, body);
  }

  /**
   * 4. Customer endpoint: Claim device ownership
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('CUSTOMER')
  @Post('devices/:id/claim')
  async claim(@Param('id') id: string, @Body() body: any, @Request() req: any) {
    return this.provisioningService.claim(id, body, req.user);
  }

  /**
   * 5. Customer endpoint: Unclaim device
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('CUSTOMER', 'SUPER_ADMIN')
  @Post('devices/:id/unclaim')
  async unclaim(@Param('id') id: string, @Request() req: any) {
    return this.provisioningService.unclaim(id, req.user);
  }

  /**
   * 6. Customer endpoint: Transfer device
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('CUSTOMER')
  @Post('devices/:id/transfer')
  async transfer(@Param('id') id: string, @Request() req: any) {
    return this.provisioningService.transfer(id, req.user);
  }

  /**
   * 7. Hardware / Admin endpoint: Factory reset
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('STORE_OWNER', 'STORE_MANAGER', 'SUPER_ADMIN')
  @Post('devices/:id/factory-reset')
  async factoryReset(@Param('id') id: string, @Request() req: any) {
    return this.provisioningService.factoryReset(id, req.user);
  }

  /**
   * 8. Customer endpoint: Change Wi-Fi credentials (preserves ownership & product)
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('CUSTOMER', 'STORE_OWNER', 'STORE_MANAGER', 'SUPER_ADMIN')
  @Post(['devices/:id/change-wifi', 'provisioning/devices/:id/change-wifi'])
  async changeWifi(
    @Param('id') id: string,
    @Body() body: { ssid?: string; password?: string },
    @Request() req: any
  ) {
    return this.provisioningService.changeWifi(id, req.user, body);
  }

  /**
   * 9. Super Admin Security Hub: Device incidents
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('SUPER_ADMIN')
  @Get('admin/security/devices')
  async getSecurityIncidents() {
    const data = this.provisioningService.getSecurityIncidents();
    return { success: true, data };
  }
}
