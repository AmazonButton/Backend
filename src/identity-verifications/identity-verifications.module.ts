import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { IdentityVerificationsController } from './identity-verifications.controller';
import { DiditWebhookController } from './didit-webhook.controller';
import { IdentityVerificationsService } from './identity-verifications.service';
import { IdentityVerificationsRepository } from './identity-verifications.repository';
import { DiditClientService } from './didit-client.service';
import { DiditWebhookGuard } from './guards/didit-webhook.guard';

@Module({
  imports: [PrismaModule],
  controllers: [IdentityVerificationsController, DiditWebhookController],
  providers: [
    IdentityVerificationsService,
    IdentityVerificationsRepository,
    DiditClientService,
    DiditWebhookGuard,
  ],
  exports: [IdentityVerificationsService, IdentityVerificationsRepository],
})
export class IdentityVerificationsModule {}
