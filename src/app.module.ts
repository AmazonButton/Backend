import { ProductDiscountsModule } from './product-discounts/product-discounts.module';
import { CategoriesModule } from './categories/categories.module';
import { CustomerAddressesModule } from './customer-addresses/customer-addresses.module';
import { IdentityVerificationsModule } from './identity-verifications/identity-verifications.module';
import { DriversModule } from './drivers/drivers.module';
import { DriverShiftsModule } from './driver-shifts/driver-shifts.module';
import { StoresModule } from './stores/stores.module';
import { StoreSubscriptionsModule } from './store-subscriptions/store-subscriptions.module';
import { StoreWalletModule } from './store-wallet/store-wallet.module';
import { StoreStaffModule } from './store-staff/store-staff.module';
import { StoreCustomersModule } from './store-customers/store-customers.module';
import { RentalsModule } from './rentals/rentals.module';
import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
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
import { NotificationsModule } from './notifications/notifications.module';
import { BankVerificationModule } from './bank-verification/bank-verification.module';
import { AppController } from './app.controller';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    ProductDiscountsModule,
    CategoriesModule,
    CustomerAddressesModule,
    StoreStaffModule,
    StoreCustomersModule,
    StoreSubscriptionsModule,
    StoreWalletModule,
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
    NotificationsModule,
    StoresModule,
    DriversModule,
    DriverShiftsModule,
    IdentityVerificationsModule,
    BankVerificationModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
