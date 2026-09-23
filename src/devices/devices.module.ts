import { Module } from '@nestjs/common';
import { DevicesService } from './devices.service';
import { DevicesController } from './devices.controller';
import { DeviceTemplatesService } from './device-templates.service';
import { DeviceTemplatesController } from './device-templates.controller';
import { ProvisioningService } from './provisioning.service';
import { ProvisioningController } from './provisioning.controller';
import { OrdersModule } from '../orders/orders.module';

@Module({
  imports: [OrdersModule],
  controllers: [
    DevicesController,
    DeviceTemplatesController,
    ProvisioningController,
  ],
  providers: [
    DevicesService,
    DeviceTemplatesService,
    ProvisioningService,
  ],
  exports: [
    DevicesService,
    DeviceTemplatesService,
    ProvisioningService,
  ],
})
export class DevicesModule {}
