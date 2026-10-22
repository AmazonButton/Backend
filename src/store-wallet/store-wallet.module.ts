import { Module } from '@nestjs/common';
import { StoreWalletService } from './store-wallet.service';
import { StoreWalletController } from './store-wallet.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { PaymentsModule } from '../payments/payments.module';

@Module({
  imports: [PrismaModule, PaymentsModule],
  controllers: [StoreWalletController],
  providers: [StoreWalletService],
  exports: [StoreWalletService],
})
export class StoreWalletModule {}
