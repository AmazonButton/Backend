import { Module } from '@nestjs/common';
import { IotController } from './iot.controller';
import { IotService } from './iot.service';
import { OrdersModule } from '../orders/orders.module';
import { HmacAuthGuard } from '../common/guards/hmac-auth.guard';

@Module({
  imports: [OrdersModule],
  controllers: [IotController],
  providers: [IotService, HmacAuthGuard],
  exports: [IotService],
})
export class IotModule {}
