import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { StoreCustomersController } from './store-customers.controller';
import { CustomerStoresController } from './customer-stores.controller';
import { StoreCustomersService } from './store-customers.service';
import { StoreCustomersRepository } from './store-customers.repository';

@Module({
  imports: [PrismaModule],
  controllers: [StoreCustomersController, CustomerStoresController],
  providers: [StoreCustomersService, StoreCustomersRepository],
  exports: [StoreCustomersService, StoreCustomersRepository],
})
export class StoreCustomersModule {}
