import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { StoreStaffController } from './store-staff.controller';
import { StoreStaffService } from './store-staff.service';
import { StoreStaffRepository } from './store-staff.repository';

@Module({
  imports: [PrismaModule],
  controllers: [StoreStaffController],
  providers: [StoreStaffService, StoreStaffRepository],
  exports: [StoreStaffService, StoreStaffRepository],
})
export class StoreStaffModule {}
