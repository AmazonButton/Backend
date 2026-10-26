import { Global, Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { IdempotencyRepository } from './idempotency.repository';
import { IdempotencyService } from './idempotency.service';
import { IdempotencyInterceptor } from './idempotency.interceptor';

@Global()
@Module({
  imports: [PrismaModule],
  providers: [IdempotencyRepository, IdempotencyService, IdempotencyInterceptor],
  exports: [IdempotencyRepository, IdempotencyService, IdempotencyInterceptor],
})
export class IdempotencyModule {}
