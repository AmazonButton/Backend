import { Module } from '@nestjs/common';
import { IotController } from './iot.controller';
import { IotService } from './iot.service';
import { OrdersModule } from '../orders/orders.module';
import { DevicesModule } from '../devices/devices.module';
import { HmacAuthGuard } from '../common/guards/hmac-auth.guard';

@Module({
  imports: [OrdersModule, DevicesModule],
  controllers: [IotController],
  providers: [IotService, HmacAuthGuard],
  exports: [IotService],
})
export class IotModule {}
