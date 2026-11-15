import { Module } from '@nestjs/common';
import { WarrantyController } from './warranty.controller';
import { WarrantyService } from './warranty.service';
import { WarrantyRepository } from './warranty.repository';
import { PrismaModule } from '../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [PrismaModule, NotificationsModule],
  controllers: [WarrantyController],
  providers: [WarrantyService, WarrantyRepository],
  exports: [WarrantyService, WarrantyRepository],
})
export class WarrantyModule {}
