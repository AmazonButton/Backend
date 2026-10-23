import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { FirebaseService } from './firebase.service';
import { NotificationsService } from './notifications.service';
import { NotificationsRepository } from './notifications.repository';
import { NotificationsController } from './notifications.controller';

@Module({
  imports: [PrismaModule],
  providers: [FirebaseService, NotificationsService, NotificationsRepository],
  controllers: [NotificationsController],
  exports: [FirebaseService, NotificationsService, NotificationsRepository],
})
export class NotificationsModule {}
