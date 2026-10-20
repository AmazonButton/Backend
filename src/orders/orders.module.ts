import { Module } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';
import { StorefrontController } from './storefront.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { WebSocketModule } from '../websocket/websocket.module';
import { OptionalJwtAuthGuard } from '../common/guards/optional-jwt-auth.guard';

@Module({
  imports: [PrismaModule, WebSocketModule],
  controllers: [OrdersController, StorefrontController],
  providers: [OrdersService, OptionalJwtAuthGuard],
  exports: [OrdersService],
})
export class OrdersModule {}
