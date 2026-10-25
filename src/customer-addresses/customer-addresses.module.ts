import { Module } from '@nestjs/common';
import { CustomerAddressesController } from './customer-addresses.controller';
import { CustomerAddressesService } from './customer-addresses.service';
import { CustomerAddressesRepository } from './customer-addresses.repository';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [CustomerAddressesController],
  providers: [CustomerAddressesService, CustomerAddressesRepository],
  exports: [CustomerAddressesService, CustomerAddressesRepository],
})
export class CustomerAddressesModule {}
