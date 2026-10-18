import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { FirebaseService } from './firebase.service';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';

@Module({
  imports: [PrismaModule],
  providers: [FirebaseService, NotificationsService],
  controllers: [NotificationsController],
  exports: [FirebaseService, NotificationsService],
})
export class NotificationsModule {}
