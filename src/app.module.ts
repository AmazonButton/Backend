import { RentalsModule } from './rentals/rentals.module';
import { Module } from '@nestjs/common';
import { PrismaModule } from './prisma/prisma.module';
import { WebSocketModule } from './websocket/websocket.module';
import { SecurityModule } from './security/security.module';
import { AuthModule } from './auth/auth.module';
import { OrdersModule } from './orders/orders.module';
import { IotModule } from './iot/iot.module';
import { DevicesModule } from './devices/devices.module';
import { ProductsModule } from './products/products.module';
import { AdminModule } from './admin/admin.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { MediaModule } from './media/media.module';
import { MailModule } from './mail/mail.module';
import { PaymentsModule } from './payments/payments.module';
import { AppController } from './app.controller';

@Module({
  imports: [
    RentalsModule,
    PrismaModule,
    WebSocketModule,
    SecurityModule,
    MailModule,
    AuthModule,
    OrdersModule,
    IotModule,
    DevicesModule,
    ProductsModule,
    AdminModule,
    AnalyticsModule,
    MediaModule,
    PaymentsModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
