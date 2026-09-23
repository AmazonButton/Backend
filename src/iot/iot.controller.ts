import { Controller, Post, Get, Body, UseGuards, Request, Inject, HttpCode } from '@nestjs/common';
import { IotService } from './iot.service';
import { HmacAuthGuard } from '../common/guards/hmac-auth.guard';

@UseGuards(HmacAuthGuard)
@Controller('iot')
export class IotController {
  constructor(@Inject(IotService) private readonly iotService: IotService) {}

  @HttpCode(200)
  @Post('events')
  handleEvent(@Request() req: any, @Body() body: any) {
    return this.iotService.handleEvent(req.device, body);
  }

  @Post('telemetry')
  handleTelemetry(@Request() req: any, @Body() body: any) {
    return this.iotService.handleTelemetry(req.device, body);
  }

  @Get('config')
  getConfig(@Request() req: any) {
    return this.iotService.getConfig(req.device);
  }
}
