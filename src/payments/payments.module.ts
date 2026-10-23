import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { WebSocketModule } from '../websocket/websocket.module';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { PaymentsRepository } from './payments.repository';
import { PayOSPayoutService } from './payos-payout.service';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [PrismaModule, WebSocketModule, NotificationsModule],
  controllers: [PaymentsController],
  providers: [PaymentsService, PaymentsRepository, PayOSPayoutService],
  exports: [PaymentsService, PaymentsRepository, PayOSPayoutService],
})
export class PaymentsModule {}
